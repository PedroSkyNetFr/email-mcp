/**
 * MCP Server factory.
 *
 * Creates and configures the McpServer instance (SDK MCP v2) with capabilities.
 */

import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/server';

const esmRequire = createRequire(import.meta.url);
const pkg = esmRequire('../package.json') as { version: string };

export const PKG_NAME = 'email-mcp';
export const PKG_VERSION = pkg.version;

export default function createServer(): McpServer {
  return new McpServer(
    {
      name: PKG_NAME,
      version: PKG_VERSION,
    },
    {
      instructions:
        'Email is split across mailbox folders per account. INBOX holds recent/unhandled mail; long-term mail lives in the Archive folder (e.g. INBOX.Archive on IMAP servers, or [Gmail]/All Mail). If a search of INBOX comes up empty, you should usually retry against the Archive — archives commonly hold tens of thousands of messages. Because archives are large, ALWAYS pass a date filter (since/before/on, or relative tokens like "30d" / "yesterday") and a reasonable pageSize when querying them — unfiltered archive scans are slow, and filters evaluated client-side (attachments, *_contains) examine at most 5000 messages per call. Use list_mailboxes to discover the archive folder name for each account before searching.',
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        // Pas de capacité `logging` : dépréciée en 2026-07-28 (SEP-2577), le
        // serveur journalise sur stderr (voir logging.ts).
      },
    },
  );
}
