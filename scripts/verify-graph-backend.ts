#!/usr/bin/env tsx
/**
 * Graph backend smoke test.
 *
 * Exercises the real GraphClient and GraphService — the same objects the server
 * builds for an account declared with `backend = "graph"` — so the backend can
 * be validated before any account is switched over.
 *
 *   pnpm verify:graph --server outlook-mail --refresh-token <graph token> \
 *     --mailbox "NISSAN/Reçu nissan"
 *
 * The client id and secret are read from the MCP client config; the refresh
 * token is passed explicitly because the one stored there is the IMAP/SMTP
 * token, which Microsoft will not redeem for Graph. Nothing is written to the
 * mailbox and nothing is written to the config.
 *
 * Options:
 *   --server <name>          Server entry inside "mcpServers" (default: outlook-mail)
 *   --refresh-token <token>  Graph-consented refresh token (required)
 *   --mailbox <path>         Folder to list messages from (default: INBOX)
 *   --config <path>          Config file (default: %APPDATA%\Claude\claude_desktop_config.json)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import GraphClient from '../src/services/graph/graph.client.js';
import GraphService from '../src/services/graph/graph.service.js';
import OAuthService from '../src/services/oauth.service.js';
import type { AccountConfig } from '../src/types/index.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      out[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const serverName = args.server ?? 'outlook-mail';
  const configPath =
    args.config ?? path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');

  const refreshToken = args['refresh-token'];
  if (!refreshToken) {
    throw new Error(
      'Pass --refresh-token with a Graph-consented token (pnpm oauth:setup, microsoft-graph profile).',
    );
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    mcpServers?: Record<string, { env?: Record<string, string> }>;
  };
  const env = raw.mcpServers?.[serverName]?.env ?? {};

  // Minimal account shaped like a configured one, but backed by Graph.
  const account: AccountConfig = {
    name: serverName,
    email: env.MCP_EMAIL_ADDRESS ?? '',
    username: env.MCP_EMAIL_ADDRESS ?? '',
    backend: 'graph',
    oauth2: {
      provider: 'custom',
      clientId: env.MCP_EMAIL_OAUTH2_CLIENT_ID ?? '',
      clientSecret: env.MCP_EMAIL_OAUTH2_CLIENT_SECRET ?? '',
      refreshToken,
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    },
    imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
  };

  const service = new GraphService(
    new Map([[account.name, new GraphClient(account, new OAuthService())]]),
    () => account,
  );

  /* eslint-disable no-console -- this script's output IS its interface */
  console.log(`\nAccount: ${account.email}  (backend: graph)\n`);

  const mailboxes = await service.listMailboxes(account.name);
  console.log(`listMailboxes -> ${mailboxes.length} folders`);
  mailboxes.forEach((box) => {
    const special = box.specialUse ? `  ${box.specialUse}` : '';
    console.log(`   ${box.path.padEnd(44)} ${box.totalMessages} msgs, ${box.unseenMessages} unread${special}`);
  });

  const mailbox = args.mailbox ?? 'INBOX';
  const page = await service.listEmails(account.name, { mailbox, pageSize: 5 });
  console.log(`\nlistEmails("${mailbox}") -> ${page.total} total, showing ${page.items.length}`);
  page.items.forEach((mail) => {
    console.log(`   [${mail.date.slice(0, 10)}] ${mail.from.address} — ${mail.subject}`);
  });

  if (page.items.length > 0) {
    const full = await service.getEmail(account.name, page.items[0].id, mailbox);
    const body = full.bodyHtml ?? full.bodyText ?? '';
    console.log(`\ngetEmail(first) -> subject "${full.subject}"`);
    console.log(`   messageId  : ${full.messageId}`);
    console.log(`   body       : ${body.length} chars (${full.bodyHtml ? 'html' : 'text'})`);
    console.log(`   attachments: ${full.attachments.length}`);
  }
  console.log('');
  /* eslint-enable no-console */
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`\nGraph backend check failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
