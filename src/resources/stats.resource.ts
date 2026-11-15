/**
 * MCP Resource: email://{account}/stats
 *
 * Dynamic resource providing lightweight daily inbox statistics.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import type ConnectionManager from '../connections/manager.js';
import type { IMailService } from '../services/mail-service.types.js';

export default function registerStatsResource(
  server: McpServer,
  connections: ConnectionManager,
  imapService: IMailService,
): void {
  const names = connections.getAccountNames();
  const accounts = names.map((name) => connections.getAccount(name));

  server.resource(
    'stats',
    new ResourceTemplate('email://{account}/stats', {
      list: async () => ({
        resources: accounts.map((a) => ({
          uri: `email://${a.name}/stats`,
          name: `${a.name} — Inbox Stats`,
          description: `Email statistics snapshot for ${a.email}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      description: 'Daily inbox statistics snapshot with unread count and quota',
    },
    async (uri, { account }) => {
      const accountName = account as string;

      // Compteurs bon marché (STATUS sur IMAP, propriétés du dossier sur
      // Graph) : `inbox_total` est désormais le vrai total du dossier, et non
      // plus une copie du nombre de messages du jour.
      const mailbox = await imapService.getMailboxSnapshot(accountName, 'INBOX');

      // Le quota n'existe que sur IMAP (extension QUOTA) : un compte Graph, ou
      // un serveur qui refuse GETQUOTAROOT, rend simplement la ressource sans
      // quota au lieu de la faire échouer entière.
      const quota = await imapService.getQuota(accountName).catch(() => null);

      const snapshot = {
        account: accountName,
        date: new Date().toISOString().split('T')[0],
        inbox_total: mailbox.total,
        inbox_unread: mailbox.unread,
        inbox_today: mailbox.receivedToday,
        quota: quota ?? undefined,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    },
  );
}
