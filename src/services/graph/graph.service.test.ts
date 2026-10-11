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

// ---------------------------------------------------------------------------
// Filtres côté client (*_contains) : appliqués AVANT la pagination, sur toutes
// les pages Graph. Avant, ils ne filtraient que la page déjà lue : « No emails
// found » alors que la boîte en contenait, et le total de la boîte entière.
// ---------------------------------------------------------------------------

/** Message n° `i` : plus `i` est grand, plus il est ancien (une heure d'écart). */
function message(i: number, from = `s${i}@x.test`, extra: Record<string, unknown> = {}) {
  const received = new Date(Date.UTC(2026, 9, 1) - i * 3_600_000).toISOString();
  return {
    id: `m${i}`,
    subject: `Sujet ${i}`,
    from: { emailAddress: { address: from } },
    toRecipients: [],
    receivedDateTime: received,
    sentDateTime: received,
    isRead: true,
    hasAttachments: false,
    ...extra,
  };
}

/**
 * Faux client paginé : `pages[k]` est servie pour la k-ième requête, avec un
 * `@odata.nextLink` vers la suivante. `onRequest` simule un coût.
 */
function paged(
  pages: ReturnType<typeof message>[][],
  count?: number,
  onRequest?: () => void,
): ReturnType<typeof build> {
  const built = build();
  built.client.request.mockImplementation(async (_method: string, url: string) => {
    onRequest?.();
    const index = url.startsWith('NEXT') ? Number(url.slice(4)) : 0;
    return {
      value: pages[index] ?? [],
      ...(index + 1 < pages.length ? { '@odata.nextLink': `NEXT${index + 1}` } : {}),
      ...(index === 0 && count !== undefined ? { '@odata.count': count } : {}),
    };
  });
  return built;
}

/** `count` messages numérotés à partir de `start`, aucun ne venant d'edf. */
const range = (start: number, count: number) =>
  Array.from({ length: count }, (_, k) => message(start + k));

describe('GraphService — client-side filters across Graph pages', () => {
  it('from_contains finds matches on later pages; page and total cover the filtered set', async () => {
    const pages = [
      range(0, 500),
      [...range(500, 300), message(800, 'facture@edf.fr'), ...range(801, 199)],
      [...range(1000, 100), message(1100, 'x@contact-EDF.fr'), ...range(1101, 99)],
    ];
    const { client, service } = paged(pages, 1200);

    const result = await service.searchEmails('graph', '', { fromContains: 'edf', pageSize: 1 });

    expect(client.request).toHaveBeenCalledTimes(3);
    expect(result.items.map((m) => m.id)).toEqual(['m800']);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.coverage).toBeUndefined();
    expect(result.totalApprox).toBeUndefined();
    const first = client.request.mock.calls[0][1] as string;
    expect(first).toContain('$top=500');
    expect(first).toContain('$orderby=receivedDateTime desc');
    expect(first).not.toContain('$skip=');
  });

  it('listEmails applies from_contains too (it ignored it entirely)', async () => {
    const { service } = paged([[message(0), message(1, 'facture@edf.fr')]], 2);

    const result = await service.listEmails('graph', { fromContains: 'edf' });

    expect(result.items.map((m) => m.id)).toEqual(['m1']);
    expect(result.total).toBe(1);
  });

  it('subject_contains / to_contains are matched the same way', async () => {
    const { service } = paged(
      [
        [
          message(0, 'a@x.test', { subject: 'Votre FACTURE' }),
          message(1, 'b@x.test', { toRecipients: [{ emailAddress: { address: 'moi@edf.fr' } }] }),
          message(2),
        ],
      ],
      3,
    );

    const bySubject = await service.searchEmails('graph', '', { subjectContains: 'facture' });
    const byTo = await service.searchEmails('graph', '', { toContains: 'edf.fr' });

    expect(bySubject.items.map((m) => m.id)).toEqual(['m0']);
    expect(byTo.items.map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps receivedDateTime first in $filter while scanning', async () => {
    const { client, service } = paged([[message(0)]], 1);

    await service.searchEmails('graph', '', {
      fromContains: 'edf',
      since: '2026-01-01',
      hasAttachment: true,
    });

    expect(filterOf(client)).toBe(
      'receivedDateTime ge 2026-01-01T00:00:00.000Z and hasAttachments eq true',
    );
  });

  it('without a client-side filter, nothing changes: one request, the page only', async () => {
    const { client, service } = build();

    await service.listEmails('graph', { page: 3, pageSize: 10, seen: false });

    expect(client.request).toHaveBeenCalledTimes(1);
    const url = client.request.mock.calls[0][1] as string;
    expect(url).toContain('$top=10');
    expect(url).toContain('$skip=20');
  });

  it('stops at the 45 s budget and says how to continue with before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
      const pages = [range(0, 500), range(500, 500), range(1000, 500), range(1500, 500)];
      const { client, service } = paged(pages, 2000, () => {
        vi.setSystemTime(Date.now() + 20_000);
      });

      const result = await service.searchEmails('graph', '', { fromContains: 'edf' });

      // Pages 1 à 3 lues (60 s > 45 s) ; la 4e ne l'est pas.
      expect(client.request).toHaveBeenCalledTimes(3);
      const oldest = message(1499).receivedDateTime;
      expect(result.coverage).toMatchObject({
        stoppedBy: 'time_budget',
        examined: 1500,
        candidates: 2000,
        oldestExamined: new Date(oldest).toISOString(),
        // receivedDateTime lt … compare l'instant : oldest + 1 s.
        continueBefore: new Date(Date.parse(oldest) + 1000).toISOString(),
      });
      expect(result.totalApprox).toBe(true);
      expect(result.warning).toMatch(/examined the 1500 most recent of 2000 candidate messages/);
      expect(result.warning).toMatch(/re-run the same call with before:/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continuing with before narrows the $filter, receivedDateTime first', async () => {
    const { client, service } = paged([[message(1, 'facture@edf.fr')]], 1);

    const result = await service.searchEmails('graph', '', {
      fromContains: 'edf',
      before: '2026-09-10T06:00:01.000Z',
    });

    expect(filterOf(client)).toBe('receivedDateTime lt 2026-09-10T06:00:01.000Z');
    expect(result.items.map((m) => m.id)).toEqual(['m1']);
  });

  it('stops at the 5000-message cap, like IMAP', async () => {
    const pages = Array.from({ length: 12 }, (_, k) => range(k * 500, 500));
    const { client, service } = paged(pages, 6000);

    const result = await service.searchEmails('graph', '', { subjectContains: 'zzz' });

    expect(client.request).toHaveBeenCalledTimes(10);
    expect(result.coverage).toMatchObject({
      stoppedBy: 'message_cap',
      examined: 5000,
      candidates: 6000,
    });
  });

  it('flags the filters Graph cannot apply instead of ignoring them silently', async () => {
    const { service } = build();

    const result = await service.listEmails('graph', {
      attachmentFilename: 'bail',
      cc: 'x',
    } as Parameters<GraphService['listEmails']>[1]);

    expect(result.warning).toMatch(/IGNORED: cc, attachment_filename/);
  });
});

describe('GraphService — $search path keeps every criterion', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** `$search` décodé de la première requête. */
  function searchOf(client: ReturnType<typeof build>['client']): string {
    const url = client.request.mock.calls[0][1] as string;
    const raw = url.split('&').find((part) => part.startsWith('$search='));
    return raw ? decodeURIComponent(raw.slice('$search='.length)) : '';
  }

  it('pushes a relative since into KQL and enforces it on each result', async () => {
    const recent = message(0, 'a@edf.fr', { receivedDateTime: '2026-10-01T10:00:00Z' });
    const old = message(1, 'b@edf.fr', { receivedDateTime: '2018-03-11T18:46:17Z' });
    const { client, service } = paged([[recent, old]]);

    const result = await service.searchEmails('graph', 'edf', { since: '30d' });

    // 30d = 2026-09-11 ; KQL élargi d'un jour.
    expect(searchOf(client)).toBe('"edf AND received>=2026-09-10"');
    expect(result.items.map((m) => m.id)).toEqual(['m0']);
  });

  it('applies seen / flagged / has_attachment and *_contains to $search results', async () => {
    const { service } = paged([
      [
        message(0, 'a@edf.fr', { isRead: false, hasAttachments: true }),
        message(1, 'b@edf.fr', { isRead: true, hasAttachments: true }),
        message(2, 'c@other.fr', { isRead: false, hasAttachments: true }),
      ],
    ]);

    const result = await service.searchEmails('graph', 'facture', {
      seen: false,
      hasAttachment: true,
      fromContains: 'edf',
    });

    expect(result.items.map((m) => m.id)).toEqual(['m0']);
  });

  it('follows @odata.nextLink beyond the first 250 results', async () => {
    const { client, service } = paged([range(0, 250), range(250, 30)]);

    const result = await service.searchEmails('graph', 'facture', { pageSize: 100, page: 3 });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(280);
    expect(result.items).toHaveLength(80);
  });

  it('reports the 1000-result $search ceiling as partial coverage', async () => {
    const pages = Array.from({ length: 4 }, (_, k) => range(k * 250, 250));
    const { service } = paged(pages);

    const result = await service.searchEmails('graph', 'facture', {});

    expect(result.coverage).toMatchObject({
      stoppedBy: 'server_cap',
      examined: 1000,
      candidatesApprox: true,
    });
    expect(result.warning).toMatch(/at least 1000 candidate messages/);
  });
});

describe('GraphService — export', () => {
  it('filters across pages before cutting to maxRows', async () => {
    const pages = [
      [message(0), message(1, 'x@edf.fr')],
      [message(2, 'y@edf.fr'), message(3, 'z@edf.fr')],
    ];
    const { client, service } = paged(pages, 4);

    const exported = await service.searchForExport(null, 'graph', '', {
      fromContains: 'edf',
      maxRows: 2,
    });

    expect(exported.items.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(exported.items[0].account).toBe('graph');
    expect(exported.truncated).toBe(true);
    // Un seul parcours : deux requêtes, pas une relecture par page de sortie.
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('accepts relative dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
      const { client, service } = paged([[]], 0);

      await service.searchForExport(null, 'graph', '', { since: '60d', maxRows: 10 });

      expect(filterOf(client)).toBe('receivedDateTime ge 2026-08-12T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
