import type { AccountConfig } from '../../types/index.js';
import type GraphClient from './graph.client.js';
import GraphService from './graph.service.js';

// ---------------------------------------------------------------------------
// Outils de test : un faux client Graph qui enregistre les URL demandées.
// ---------------------------------------------------------------------------

const account: AccountConfig = {
  name: 'graph',
  email: 'g@example.com',
  username: 'g@example.com',
  backend: 'graph',
  imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
};

function build() {
  const client = {
    request: vi.fn().mockResolvedValue({ value: [], '@odata.count': 0 }),
    collect: vi.fn().mockResolvedValue([]),
  };
  const service = new GraphService(
    new Map([['graph', client as unknown as GraphClient]]),
    () => account,
  );
  return { client, service };
}

/** `$filter` décodé de la n-ième requête GET (chaîne vide si absent). */
function filterOf(client: ReturnType<typeof build>['client'], call = 0): string {
  const url = client.request.mock.calls[call][1] as string;
  const raw = url
    .slice(url.indexOf('?') + 1)
    .split('&')
    .find((part) => part.startsWith('$filter='));
  return raw ? decodeURIComponent(raw.slice('$filter='.length)) : '';
}

describe('GraphService — date filters', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a relative since ("60d") like the IMAP backend', async () => {
    const { client, service } = build();

    await service.searchEmails('graph', '', { since: '60d', hasAttachment: true });

    expect(filterOf(client)).toContain('receivedDateTime ge 2026-08-12T00:00:00.000Z');
  });

  it('accepts named tokens for before ("yesterday")', async () => {
    const { client, service } = build();

    await service.listEmails('graph', { before: 'yesterday' });

    expect(filterOf(client)).toContain('receivedDateTime lt 2026-10-10T00:00:00.000Z');
  });

  it('translates on into the whole UTC day', async () => {
    const { client, service } = build();

    await service.searchEmails('graph', '', { on: '2026-08-01' });

    const filter = filterOf(client);
    expect(filter).toContain('receivedDateTime ge 2026-08-01T00:00:00.000Z');
    expect(filter).toContain('receivedDateTime lt 2026-08-02T00:00:00.000Z');
  });

  it('maps sent_since / sent_before onto sentDateTime', async () => {
    const { client, service } = build();

    await service.searchEmails('graph', '', { sentSince: '2w', sentBefore: '2026-10-01' });

    const filter = filterOf(client);
    expect(filter).toContain('sentDateTime ge 2026-09-27T00:00:00.000Z');
    expect(filter).toContain('sentDateTime lt 2026-10-01T00:00:00.000Z');
  });

  it('rejects an unparseable date before calling Graph', async () => {
    const { client, service } = build();

    await expect(service.searchEmails('graph', '', { since: 'soon' })).rejects.toThrow(
      'Invalid date: soon',
    );
    expect(client.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// $filter + $orderby : Graph exige que receivedDateTime (propriété de tri)
// apparaisse EN PREMIER dans $filter, sinon 400 InefficientFilter.
// ---------------------------------------------------------------------------

describe('GraphService — $filter ordering with $orderby=receivedDateTime', () => {
  /** Vérifie la règle Graph sur un $filter : receivedDateTime d'abord, d'un bloc. */
  function expectReceivedFirst(filter: string): void {
    const isReceived = filter.split(' and ').map((c) => c.startsWith('receivedDateTime '));
    expect(isReceived[0]).toBe(true);
    const firstOther = isReceived.indexOf(false);
    if (firstOther !== -1) expect(isReceived.lastIndexOf(true)).toBeLessThan(firstOther);
  }

  it('puts receivedDateTime before hasAttachments (the InefficientFilter case)', async () => {
    const { client, service } = build();

    await service.searchEmails('graph', '', { hasAttachment: true, since: '2026-08-01' });

    expect(filterOf(client)).toBe(
      'receivedDateTime ge 2026-08-01T00:00:00.000Z and hasAttachments eq true',
    );
  });

  it('adds a neutral receivedDateTime lower bound when no date is given', async () => {
    const { client, service } = build();

    await service.searchEmails('graph', '', { hasAttachment: true });

    expect(filterOf(client)).toBe(
      'receivedDateTime ge 1900-01-01T00:00:00Z and hasAttachments eq true',
    );
  });

  it('sends no $filter at all when there is nothing to filter', async () => {
    const { client, service } = build();

    await service.listEmails('graph', {});

    expect(client.request.mock.calls[0][1]).not.toContain('$filter=');
  });

  it.each([
    { seen: false },
    { seen: true, hasAttachment: false },
    { hasAttachment: true, before: '2026-09-01', since: '2026-08-01' },
    { hasAttachment: true, on: '2026-08-01', seen: false },
    { sentSince: '2026-08-01', hasAttachment: true },
    { sentBefore: '2026-08-01', since: '30d', seen: true, hasAttachment: true },
  ])('keeps receivedDateTime first for %o', async (options) => {
    const { client, service } = build();

    await service.searchEmails('graph', '', options);

    expectReceivedFirst(filterOf(client));
  });

  // `from` n'atteint $filter que par listEmails (searchEmails l'envoie à $search).
  it.each([
    { from: 'a@b.test' },
    { from: 'a@b.test', since: '7d', hasAttachment: true },
  ])('listEmails keeps receivedDateTime first for %o', async (options) => {
    const { client, service } = build();

    await service.listEmails('graph', options);

    expectReceivedFirst(filterOf(client));
  });
});
