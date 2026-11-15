/**
 * Recherche `deep: false` (wgs4 0c2c2b4, partie R2 seulement) : la requête
 * libre ne porte que sur sujet / expéditeur / destinataires, jamais sur le
 * corps — sur IMAP (OR SUBJECT/FROM/TO) comme sur Graph (KQL restreint).
 * Défaut inchangé : sujet / expéditeur / corps.
 */

import type { IConnectionManager } from '../connections/types.js';
import { hasSearchCriterion } from '../tools/emails.tool.js';
import type { AccountConfig } from '../types/index.js';
import type GraphClient from './graph/graph.client.js';
import GraphService, { headerOnlyKql } from './graph/graph.service.js';
import ImapService from './imap.service.js';
import { buildSearchCriteria } from './search-criteria.js';

describe('buildSearchCriteria — deep', () => {
  it('keeps the deep default (subject / from / body) and flags a body scan', () => {
    const built = buildSearchCriteria({ query: 'devis' }, { isGmail: false });
    expect(built.criteria).toEqual({
      or: [{ subject: 'devis' }, { from: 'devis' }, { body: 'devis' }],
    });
    expect(built.bodyScan).toBe(true);
    // `deep: true` explicite = défaut.
    expect(
      buildSearchCriteria({ query: 'devis', deep: true }, { isGmail: false }).criteria,
    ).toEqual(built.criteria);
  });

  it('deep=false: header-only OR SUBJECT/FROM/TO, no body term, no body scan', () => {
    const built = buildSearchCriteria({ query: 'devis', deep: false }, { isGmail: false });
    expect(built.criteria).toEqual({
      or: [{ subject: 'devis' }, { from: 'devis' }, { to: 'devis' }],
    });
    expect(JSON.stringify(built.criteria)).not.toMatch(/body|text/);
    expect(built.bodyScan).toBe(false);
  });

  it('deep=false leaves explicit body/text filters alone (their own opt-in)', () => {
    const built = buildSearchCriteria(
      { query: 'devis', deep: false, body: 'toiture' },
      { isGmail: false },
    );
    expect(built.criteria).toMatchObject({ body: 'toiture' });
    expect(built.bodyScan).toBe(true);
  });
});

describe('ImapService.searchEmails — deep=false reaches the SEARCH', () => {
  it('sends OR SUBJECT/FROM/TO on the shared connection', async () => {
    const client = {
      usable: true,
      mailbox: { exists: 80_000 },
      capabilities: new Map<string, boolean>(),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      fetch: vi.fn().mockReturnValue((async function* empty() {})()),
    };
    const connections = {
      getAccount: vi.fn().mockReturnValue({
        name: 'test',
        email: 't@example.com',
        username: 't@example.com',
        imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      }),
      getAccountNames: vi.fn().mockReturnValue(['test']),
      getImapClient: vi.fn().mockResolvedValue(client),
      createEphemeralImapClient: vi.fn(),
      getSmtpTransport: vi.fn(),
      closeAll: vi.fn(),
    } satisfies IConnectionManager;

    await new ImapService(connections).searchEmails('test', 'devis', { deep: false });

    expect(client.search).toHaveBeenCalledWith(
      { or: [{ subject: 'devis' }, { from: 'devis' }, { to: 'devis' }] },
      { uid: true },
    );
    // Pas de corps lu : un dossier de 80 000 messages ne bascule pas sur la
    // connexion éphémère bornée réservée aux balayages de corps.
    expect(connections.createEphemeralImapClient).not.toHaveBeenCalled();
  });
});

describe('headerOnlyKql (Graph)', () => {
  it('restricts one word to subject / from / to', () => {
    expect(headerOnlyKql('devis')).toBe('(subject:devis OR from:devis OR to:devis)');
  });

  it('requires every word in the same field, and strips quotes / backslashes', () => {
    expect(headerOnlyKql('devis "toit\\ure"')).toBe(
      '((subject:devis AND subject:toit AND subject:ure) OR ' +
        '(from:devis AND from:toit AND from:ure) OR (to:devis AND to:toit AND to:ure))',
    );
    expect(headerOnlyKql(' " ')).toBe('');
  });
});

describe('GraphService.searchEmails — deep', () => {
  const account: AccountConfig = {
    name: 'graph',
    email: 'g@example.com',
    username: 'g@example.com',
    backend: 'graph',
    imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
  };

  async function searchOf(deep: boolean | undefined): Promise<string> {
    const client = {
      request: vi.fn().mockResolvedValue({ value: [] }),
      collect: vi.fn().mockResolvedValue([]),
    };
    const service = new GraphService(
      new Map([['graph', client as unknown as GraphClient]]),
      () => account,
    );
    await service.searchEmails('graph', 'devis', { deep });
    const url = client.request.mock.calls[0][1] as string;
    const raw = url.split('&').find((part) => part.startsWith('$search=')) ?? '';
    return decodeURIComponent(raw.slice('$search='.length));
  }

  it('keeps the free $search (from / subject / body) by default', async () => {
    await expect(searchOf(undefined)).resolves.toBe('"devis"');
  });

  it('deep=false sends a KQL restricted to subject / from / to', async () => {
    await expect(searchOf(false)).resolves.toBe('"(subject:devis OR from:devis OR to:devis)"');
  });
});

describe('search_emails — deep alone is not a criterion', () => {
  it('refuses a call carrying only deep', () => {
    expect(hasSearchCriterion({ account: 'a', deep: false, query: '' })).toBe(false);
    expect(hasSearchCriterion({ account: 'a', deep: false, query: 'devis' })).toBe(true);
  });
});
