/**
 * MCP Tool: check_health
 *
 * Connection health diagnostics for email accounts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import { PKG_VERSION } from '../server.js';
import type { IMailService } from '../services/mail-service.types.js';
import { buildInfo } from '../utils/build-info.js';

export default function registerHealthTools(
  server: McpServer,
  connections: ConnectionManager,
  imapService: IMailService,
): void {
  server.tool(
    'check_health',
    'Check connection health, quota, and capabilities for email accounts. Also reports which ' +
      'build of the server is actually running (version, source, build date) — check this first ' +
      'when a documented tool seems to be missing: a stdio MCP server keeps serving the code it ' +
      'was started with, so an old compiled build looks exactly like a feature that does not exist.',
    {
      account: z.string().optional().describe('Account name (checks all accounts if omitted)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account }) => {
      const names = account ? [account] : connections.getAccountNames();

      const results = await Promise.all(
        names.map(async (name) => {
          const cfg = connections.getAccount(name);
          const result: Record<string, unknown> = {
            name,
            auth_type: cfg.oauth2 ? 'oauth2' : 'password',
          };

          // A Graph-backed account does not use IMAP or SMTP at all: probing
          // them reported 535 auth failures for a mailbox that was working
          // perfectly over Graph. Check the path the account actually uses.
          if (cfg.backend === 'graph') {
            result.backend = 'graph';
            try {
              const start = Date.now();
              const mailboxes = await imapService.listMailboxes(name);
              result.graph = {
                connected: true,
                latency_ms: Date.now() - start,
                folders: mailboxes.length,
              };
            } catch (err) {
              result.graph = {
                connected: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
            result.imap = { skipped: 'account is served by Microsoft Graph' };
            result.smtp = { skipped: 'account sends through Microsoft Graph' };
            return result;
          }

          result.backend = 'imap';

          // IMAP health
          try {
            const start = Date.now();
            await connections.getImapClient(name);
            const latency = Date.now() - start;

            const capabilities = await imapService.getCapabilities(name);
            const quota = await imapService.getQuota(name);

            result.imap = {
              connected: true,
              latency_ms: latency,
              host: cfg.imap.host,
              capabilities: capabilities.slice(0, 20),
              tls: cfg.imap.tls,
            };

            if (quota) {
              result.quota = {
                used_mb: quota.usedMb,
                total_mb: quota.totalMb,
                percentage: quota.percentage,
              };
            }
          } catch (err) {
            result.imap = {
              connected: false,
              error: err instanceof Error ? err.message : String(err),
              host: cfg.imap.host,
            };
          }

          // SMTP health
          try {
            const start = Date.now();
            await connections.verifySmtpTransport(name);
            const latency = Date.now() - start;

            result.smtp = {
              connected: true,
              latency_ms: latency,
              host: cfg.smtp.host,
              tls: cfg.smtp.tls,
            };
          } catch (err) {
            result.smtp = {
              connected: false,
              error: err instanceof Error ? err.message : String(err),
              host: cfg.smtp.host,
            };
          }

          return result;
        }),
      );

      // L'identité du build vient en tête : c'est la première chose à vérifier
      // quand un outil documenté paraît absent.
      const build = await buildInfo(PKG_VERSION);
      const serverBuild = {
        ...build,
        note:
          build.runningFrom === 'dist'
            ? 'Running compiled code. A change under src/ needs `pnpm build` AND a restart of the MCP client before it is visible.'
            : 'Running from source. A change needs only a restart of the MCP client.',
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ server_build: serverBuild, accounts: results }, null, 2),
          },
        ],
      };
    },
  );
}
