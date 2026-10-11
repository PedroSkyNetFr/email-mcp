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
