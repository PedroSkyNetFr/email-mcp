/**
 * MCP tool: list_mailboxes
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { IMailService } from '../services/mail-service.types.js';

export default function registerMailboxesTools(server: McpServer, imapService: IMailService): void {
  server.registerTool(
    'list_mailboxes',
    {
      description:
        'List all mailbox folders for an account with unread counts and special-use flags. Use list_accounts first to get the account name.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account }) => {
      try {
        const mailboxes = await imapService.listMailboxes(account);

        const lines = mailboxes.map((mb) => {
          const badge = mb.unseenMessages > 0 ? ` (${mb.unseenMessages} unread)` : '';
          const special = mb.specialUse ? ` [${mb.specialUse}]` : '';
          return `• ${mb.path}${special} — ${mb.totalMessages} messages${badge}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: lines.join('\n') || 'No mailboxes found.',
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list mailboxes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
