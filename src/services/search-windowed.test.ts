/**
 * Repli fenêtré (wgs4 0c2c2b4, partie R6 seulement) : une recherche IMAP SANS
 * date qui n'aboutit pas (`search_failed` ou `timeout`) est relancée une fois
 * sur les 90 derniers jours, sur une connexion éphémère bornée.
 * - relance fructueuse : résultats PARTIELS, marqués (`searchStatus.windowed`,
 *   `totalApprox`, avertissement qui dit la plage couverte et comment élargir) ;
 * - relance vide ou en échec : l'échec D'ORIGINE est rendu, marqué fenêtré ;
 * - jamais de relance si l'appelant a daté, nommé des UID, ou si la connexion
 *   est en cause.
 */

import type { IConnectionManager } from '../connections/types.js';
import { formatSearchFailure, formatSearchResult } from '../tools/emails.tool.js';
import ImapService from './imap.service.js';
import { hasDateNarrowing, RECENCY_WINDOW_DAYS, withRecencyWindow } from './search-criteria.js';

function hit(uid: number, subject: string) {
  return {
    uid,
    envelope: { subject, from: [{ address: 'a@x' }], to: [], date: '2026-10-01T00:00:00Z' },
    flags: new Set<string>(),
    bodyStructure: { type: 'text', subtype: 'plain' },
    source: Buffer.from(''),
  };
}

function mockClient() {
  return {
    usable: true,
    mailbox: { exists: 5 },
    capabilities: new Map<string, boolean>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    list: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockReturnValue((async function* empty() {})()),
    close: vi.fn(),
  };
}

function setup() {
  const shared = mockClient();
  const ephemeral = mockClient();
  const connections = {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 't@example.com',
      username: 't@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(shared),
    createEphemeralImapClient: vi.fn().mockResolvedValue(ephemeral),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
  return { shared, ephemeral, connections, service: new ImapService(connections) };
}

describe('search-criteria — window helpers', () => {
  it('detects any caller-supplied date filter', () => {
    expect(hasDateNarrowing({ query: 'x' })).toBe(false);
    expect(hasDateNarrowing({ since: '30d' })).toBe(true);
    expect(hasDateNarrowing({ before: '2026-01-01' })).toBe(true);
    expect(hasDateNarrowing({ on: 'yesterday' })).toBe(true);
    expect(hasDateNarrowing({ sentSince: '2026-01-01' })).toBe(true);
  });

  it('ANDs SINCE onto the original expression instead of replacing it', () => {
    const original = { or: [{ subject: 'x' }, { body: 'x' }] };
    const windowed = withRecencyWindow(original, RECENCY_WINDOW_DAYS);
    expect(windowed.or).toEqual(original.or);
    expect(windowed.since).toBeInstanceOf(Date);
    const days = (Date.now() - (windowed.since as Date).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(92);
    // L'objet d'origine n'est pas modifié.
    expect(original).not.toHaveProperty('since');
  });
});

describe('ImapService.searchEmails — 90-day windowed fallback', () => {
  it('serves partial, clearly flagged results when the windowed retry finds mail', async () => {
    const { shared, ephemeral, service } = setup();
    shared.search.mockResolvedValueOnce(false); // échec d'origine (search_failed)
    ephemeral.search.mockResolvedValueOnce([7]);
    shared.fetch.mockReturnValueOnce(
      // eslint-disable-next-line @stylistic/wrap-iife -- même motif que les autres mocks de fetch
      (async function* gen() {
        yield hit(7, 'Recent hit');
      })(),
    );

    const result = await service.searchEmails('test', 'devis', {});

    // Avant : échec nu, aucun résultat. Après : les 90 derniers jours.
    expect(result.searchFailed).toBeUndefined();
    expect(result.items.map((i) => i.subject)).toEqual(['Recent hit']);
    expect(result.totalApprox).toBe(true);
    expect(result.searchStatus?.kind).toBe('search_failed');
    expect(result.searchStatus?.windowed).toMatchObject({ applied: true, sinceDays: 90 });
    expect(result.searchStatus?.windowed?.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.warning).toMatch(/PARTIAL RESULTS/);
    expect(result.warning).toContain(`before: "${result.searchStatus?.windowed?.since}"`);

    // La relance part sur la connexion ÉPHÉMÈRE, même requête + SINCE.
    const [criteria] = ephemeral.search.mock.calls[0] as [Record<string, unknown>];
    expect(criteria.or).toEqual([{ subject: 'devis' }, { from: 'devis' }, { body: 'devis' }]);
    expect(criteria.since).toBeInstanceOf(Date);
    expect(ephemeral.close).toHaveBeenCalled();

    // Le rendu outil montre l'avertissement, pas un échec.
    const text = formatSearchResult(result, 'Results', 'No emails found');
    expect(text).toMatch(/PARTIAL RESULTS/);
    expect(text).not.toMatch(/SEARCH FAILED/);
  });

  it('reports the ORIGINAL failure when the window is empty — never a silent zero', async () => {
    const { shared, ephemeral, service } = setup();
    shared.search.mockResolvedValueOnce(false);
    ephemeral.search.mockResolvedValueOnce([]);

    const result = await service.searchEmails('test', 'devis', {});

    expect(result.searchFailed).toBe(true);
    expect(result.searchStatus?.kind).toBe('search_failed');
    expect(result.searchStatus?.windowed?.applied).toBe(true);
    expect(result.warning).toMatch(/found no match in that window/);
    const text = formatSearchFailure(result) ?? '';
    expect(text).toMatch(/SEARCH FAILED/);
    expect(text).toMatch(/90-day windowed retry \(since \d{4}-\d{2}-\d{2}\) was also tried/);
  });

  it('reports the original failure (not the retry error) when the retry fails too', async () => {
    const { shared, ephemeral, service } = setup();
    shared.search.mockResolvedValueOnce(false);
    ephemeral.search.mockRejectedValueOnce(new Error('socket reset'));

    const result = await service.searchEmails('test', 'devis', {});

    expect(result.searchFailed).toBe(true);
    expect(result.searchStatus?.kind).toBe('search_failed');
    expect(result.warning).toMatch(/did not complete either \(connection_error\)/);
  });

  it('also falls back after a bounded-wait timeout on a large folder', async () => {
    vi.useFakeTimers();
    try {
      const { shared, connections, service } = setup();
      shared.mailbox = { exists: 80_000 };
      const stuck = mockClient();
      stuck.search.mockReturnValue(new Promise(() => {}));
      const retry = mockClient();
      retry.search.mockResolvedValue([]);
      connections.createEphemeralImapClient
        .mockResolvedValueOnce(stuck)
        .mockResolvedValueOnce(retry);

      const p = service.searchEmails('test', 'devis', {});
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await p;

      expect(result.searchStatus?.kind).toBe('timeout');
      expect(result.searchStatus?.windowed?.applied).toBe(true);
      expect(retry.search).toHaveBeenCalled();
      expect(shared.search).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a caller date filter', { since: '2020-01-01' }],
    ['an explicit before (continuation / widened range)', { before: '2026-08-01' }],
    ['a UID-addressed search', { uids: [1, 2, 3] }],
  ])('does not re-window %s', async (_label, options) => {
    const { shared, connections, service } = setup();
    shared.search.mockResolvedValueOnce(false);

    const result = await service.searchEmails('test', 'devis', options);

    expect(result.searchFailed).toBe(true);
    expect(result.searchStatus?.windowed).toBeUndefined();
    expect(connections.createEphemeralImapClient).not.toHaveBeenCalled();
  });

  it('does not retry a connection error (the socket is the problem, not the volume)', async () => {
    const { shared, connections, service } = setup();
    shared.search.mockRejectedValueOnce(new Error('socket hang up'));

    const result = await service.searchEmails('test', 'devis', {});

    expect(result.searchStatus?.kind).toBe('connection_error');
    expect(result.searchStatus?.windowed).toBeUndefined();
    expect(connections.createEphemeralImapClient).not.toHaveBeenCalled();
  });
});
