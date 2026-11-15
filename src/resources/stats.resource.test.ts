/**
 * Ressource `email://{compte}/stats` : vrais compteurs, et fonctionnement sur
 * Graph quand elle reçoit le routeur (et non le service IMAP brut).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type ConnectionManager from '../connections/manager.js';
import type GraphClient from '../services/graph/graph.client.js';
import GraphService from '../services/graph/graph.service.js';
import type ImapService from '../services/imap.service.js';
import { createMailRouter } from '../services/mail-router.js';
import type { AccountConfig } from '../types/index.js';
import registerStatsResource from './stats.resource.js';

const graphAccount: AccountConfig = {
  name: 'exchange',
  email: 'e@example.com',
  username: 'e@example.com',
  backend: 'graph',
  imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
};
const imapAccount: AccountConfig = { ...graphAccount, name: 'ovh', backend: undefined };
const accounts: Record<string, AccountConfig> = { exchange: graphAccount, ovh: imapAccount };

type ReadCallback = (
  uri: URL,
  vars: { account: string },
) => Promise<{ contents: { text: string }[] }>;

/** Enregistre la ressource sur un faux serveur et rend sa fonction de lecture. */
function register(mailService: unknown): ReadCallback {
  let read: ReadCallback | undefined;
  const server = {
    resource: (_name: string, _template: unknown, _meta: unknown, cb: ReadCallback) => {
      read = cb;
    },
  } as unknown as McpServer;
  const connections = {
    getAccountNames: () => Object.keys(accounts),
    getAccount: (name: string) => accounts[name],
  } as unknown as ConnectionManager;
  registerStatsResource(server, connections, mailService as never);
  if (!read) throw new Error('resource not registered');
  return read;
}

async function readStats(read: ReadCallback, account: string) {
  const result = await read(new URL(`email://${account}/stats`), { account });
  return JSON.parse(result.contents[0].text) as Record<string, unknown>;
}

describe('stats resource', () => {
  it('IMAP: inbox_total is the real total, not the count of the day', async () => {
    const imap = {
      getMailboxSnapshot: vi.fn().mockResolvedValue({ total: 1200, unread: 8, receivedToday: 3 }),
      getQuota: vi.fn().mockResolvedValue(null),
    };
    const router = createMailRouter(
      imap as unknown as ImapService,
      {} as GraphService,
      (name) => accounts[name],
    );

    const stats = await readStats(register(router), 'ovh');

    expect(stats).toMatchObject({ inbox_total: 1200, inbox_unread: 8, inbox_today: 3 });
  });

  it('Graph: answered from the folder counters, without a quota', async () => {
    const client = {
      request: vi.fn(async (_method: string, url: string) => {
        if (url.startsWith('/me/mailFolders/inbox?')) {
          return { totalItemCount: 512, unreadItemCount: 4 };
        }
        return { value: [{ id: 'x' }], '@odata.count': 2 };
      }),
      collect: vi.fn().mockResolvedValue([]),
    };
    const graph = new GraphService(
      new Map([['exchange', client as unknown as GraphClient]]),
      () => graphAccount,
    );
    const imap = {
      getMailboxSnapshot: vi.fn(),
      getQuota: vi.fn(),
    };
    const router = createMailRouter(
      imap as unknown as ImapService,
      graph,
      (name) => accounts[name],
    );

    const stats = await readStats(register(router), 'exchange');

    expect(stats).toMatchObject({ inbox_total: 512, inbox_unread: 4, inbox_today: 2 });
    // getQuota n'existe pas sur Graph : la ressource répond quand même.
    expect(stats.quota).toBeUndefined();
    expect(imap.getMailboxSnapshot).not.toHaveBeenCalled();
    const todayUrl = client.request.mock.calls[1][1];
    expect(decodeURIComponent(todayUrl)).toContain('receivedDateTime ge ');
    expect(todayUrl).toContain('$count=true');
  });
});
