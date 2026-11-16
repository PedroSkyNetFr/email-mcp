import { describe, expect, it, vi } from 'vitest';

import type { AccountConfig } from '../types/index.js';
import type GraphService from './graph/graph.service.js';
import type ImapService from './imap.service.js';
import { createMailRouter } from './mail-router.js';

const accounts: Record<string, AccountConfig> = {
  ovh: {
    name: 'ovh',
    email: 'a@example.com',
    username: 'a@example.com',
    imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
  },
  exchange: {
    name: 'exchange',
    email: 'b@example.com',
    username: 'b@example.com',
    backend: 'graph',
    imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
  },
};

function build(graphOverrides: Record<string, unknown> = {}) {
  const imap = {
    listMailboxes: vi.fn().mockResolvedValue('imap'),
    searchAcrossAccounts: vi.fn().mockResolvedValue('imap'),
    searchForExport: vi.fn().mockResolvedValue('imap'),
    saveAllAttachmentsFromSearch: vi.fn().mockResolvedValue('imap'),
    getQuota: vi.fn().mockResolvedValue('imap'),
  };
  const graph = {
    listMailboxes: vi.fn().mockResolvedValue('graph'),
    searchForExport: vi.fn().mockResolvedValue('graph'),
    saveAllAttachmentsFromSearch: vi.fn().mockResolvedValue('graph'),
    ...graphOverrides,
  };
  const router = createMailRouter(
    imap as unknown as ImapService,
    graph as unknown as GraphService,
    (name) => accounts[name],
  );
  return { imap, graph, router };
}

describe('createMailRouter', () => {
  it('sends an IMAP account to the IMAP service', async () => {
    const { imap, router } = build();
    await expect(router.listMailboxes('ovh')).resolves.toBe('imap');
    expect(imap.listMailboxes).toHaveBeenCalledWith('ovh');
  });

  it('sends a Graph account to the Graph service', async () => {
    const { graph, router } = build();
    await expect(router.listMailboxes('exchange')).resolves.toBe('graph');
    expect(graph.listMailboxes).toHaveBeenCalledWith('exchange');
  });

  it('fails loudly when the Graph service lacks the operation', async () => {
    const { router } = build();
    // getQuota exists on IMAP only — a Graph account must not be answered from
    // a transport its credentials cannot even authenticate against.
    await expect(router.getQuota('exchange')).rejects.toThrow(/not supported yet/);
  });

  // Regression: these three do NOT take the account name first, so the naive
  // "first argument is the account" rule sent them to IMAP whatever the backend.
  // L'orchestration multi-comptes d'IMAP tourne avec le routeur pour `this` :
  // chaque appel mono-compte qu'elle émet part vers le backend de SON compte.
  // Avant, `search_all_accounts` était refusé dès qu'un compte Graph figurait
  // dans la liste — c'est-à-dire toujours, sans liste explicite.
  it('serves searchAcrossAccounts over both backends, account by account', async () => {
    const graphSearch = vi.fn().mockResolvedValue('graph');
    const { imap, router } = build({ searchEmails: graphSearch });
    Object.assign(imap, {
      searchEmails: vi.fn().mockResolvedValue('imap'),
      async searchAcrossAccounts(
        this: { searchEmails: (n: string) => Promise<string> },
        names: string[],
      ) {
        return Promise.all(names.map(async (name) => this.searchEmails(name)));
      },
    });

    await expect(router.searchAcrossAccounts(['ovh', 'exchange'], '', {})).resolves.toEqual([
      'imap',
      'graph',
    ]);
    expect(graphSearch).toHaveBeenCalledWith('exchange');
  });

  it('serves a multi-account searchForExport account by account', async () => {
    const { imap, graph, router } = build();
    Object.assign(imap, {
      async searchForExport(
        this: { searchForExport: (...a: unknown[]) => Promise<string> },
        names: string[] | null,
        name: string | null,
      ) {
        if (names === null) return `imap:${name}`;
        return Promise.all(names.map(async (n) => this.searchForExport(null, n, '', {})));
      },
    });

    await expect(
      router.searchForExport(['ovh', 'exchange'], null, '', { maxRows: 10 }),
    ).resolves.toEqual(['imap:ovh', 'graph']);
    expect(graph.searchForExport).toHaveBeenCalledWith(null, 'exchange', '', {});
  });

  it('reads the second argument of searchForExport', async () => {
    const { graph, router } = build();
    await expect(router.searchForExport(null, 'exchange', '', { maxRows: 10 })).resolves.toBe(
      'graph',
    );
    expect(graph.searchForExport).toHaveBeenCalled();
  });

  it('reads the account inside the saveAllAttachmentsFromSearch input object', async () => {
    const { graph, router } = build();
    await expect(
      router.saveAllAttachmentsFromSearch({
        accountNames: null,
        accountName: 'exchange',
        query: '',
        searchOptions: {},
        maxEmails: 1,
        destinationFolder: '/tmp',
        organizeBy: 'flat',
      }),
    ).resolves.toBe('graph');
    expect(graph.saveAllAttachmentsFromSearch).toHaveBeenCalled();
  });

  it('refuses a single call spanning both backends', async () => {
    const { router } = build();
    await expect(
      router.saveAllAttachmentsFromSearch({
        accountNames: ['ovh', 'exchange'],
        accountName: null,
        query: '',
        searchOptions: {},
        maxEmails: 1,
        destinationFolder: '/tmp',
        organizeBy: 'flat',
      }),
    ).rejects.toThrow(/cannot span both backends/);
  });

  it('still routes a pure IMAP account list to IMAP', async () => {
    const { imap, router } = build();
    await expect(router.searchAcrossAccounts(['ovh'], '', {})).resolves.toBe('imap');
    expect(imap.searchAcrossAccounts).toHaveBeenCalled();
  });
});
