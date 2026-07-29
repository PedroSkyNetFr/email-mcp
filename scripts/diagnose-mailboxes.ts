#!/usr/bin/env tsx
/**
 * Mailbox listing diagnostic — is the server hiding unsubscribed folders?
 *
 * `list_mailboxes` returns whatever `LIST "" "*"` reports. Some servers answer
 * that with every mailbox, others only with the subscribed ones. This script
 * separates the two so the behaviour can be attributed:
 *
 *   1. raw LIST  (listOnly: true — no LSUB merge at all)
 *   2. list()    (LIST + LSUB merge, exactly what email-mcp calls)
 *
 * If both counts match and some mailboxes come back with subscribed=false, the
 * server returns everything and nothing is being filtered. If every entry is
 * subscribed=true and folders you know exist are missing, the server is only
 * advertising subscribed mailboxes.
 *
 * Credentials are read from an MCP client config so nothing has to be retyped:
 *
 *   npx tsx scripts/diagnose-mailboxes.ts --server ovh-mail
 *
 * Options:
 *   --server <name>   Server entry to use inside "mcpServers" (required)
 *   --config <path>   Config file (default: %APPDATA%\Claude\claude_desktop_config.json)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config/loader.js';
import ConnectionManager from '../src/connections/manager.js';
import OAuthService from '../src/services/oauth.service.js';

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

interface McpConfig {
  mcpServers?: Record<string, { env?: Record<string, string> }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const configPath =
    args.config ??
    path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as McpConfig;
  const servers = raw.mcpServers ?? {};

  const serverName = args.server;
  if (!serverName || !servers[serverName]) {
    throw new Error(
      `Pass --server with one of: ${Object.keys(servers).join(', ') || '(none found)'}`,
    );
  }

  // Apply that server's env block, then load the config exactly like the server does.
  Object.entries(servers[serverName].env ?? {}).forEach(([key, value]) => {
    process.env[key] = value;
  });

  const config = await loadConfig();
  const account = config.accounts[0];
  const connections = new ConnectionManager(config.accounts, new OAuthService());

  /* eslint-disable no-console -- this script's output IS its interface */
  console.log(`\nAccount : ${account.email}`);
  console.log(`IMAP    : ${account.imap.host}:${account.imap.port}\n`);

  try {
    const client = await connections.getImapClient(account.name);

    // 1. Pure LIST, no LSUB merge. `run` is imapflow's internal command entry
    // point — not part of its public typings, hence the cast.
    const internal = client as unknown as {
      run: (cmd: string, ...cmdArgs: unknown[]) => Promise<{ path: string }[]>;
    };
    const rawList = await internal.run('LIST', '', '*', { listOnly: true });

    // 2. What email-mcp actually calls.
    const merged = await client.list();

    console.log(`LIST "" "*"        : ${rawList.length} mailboxes`);
    console.log(`client.list()      : ${merged.length} mailboxes`);
    const subscribed = merged.filter((m) => m.subscribed).length;
    console.log(`  of which subscribed=true : ${subscribed}`);
    console.log(`  of which subscribed=false: ${merged.length - subscribed}\n`);

    console.log('path                                     | subscribed | flags');
    console.log('-----------------------------------------+------------+---------------------');
    merged.forEach((m) => {
      const flags = [...m.flags].join(' ');
      console.log(`${m.path.padEnd(40)} | ${String(!!m.subscribed).padEnd(10)} | ${flags}`);
    });

    console.log(
      '\nIf folders you can see in your mail client are missing above, the server is\n' +
        'only advertising subscribed mailboxes — subscribe to them in your mail client\n' +
        '(or its IMAP folder settings) and they will appear here too.\n',
    );

    // --probe proves the point for one specific folder: STATUS succeeds only on
    // a mailbox that really exists, so a hit on a path absent from LIST means
    // the folder is there but simply not advertised (i.e. not subscribed).
    if (args.probe) {
      const delimiter = merged.find((m) => m.delimiter)?.delimiter ?? '/';
      const candidates = [
        args.probe,
        `INBOX${delimiter}${args.probe}`,
        `INBOX.${args.probe}`,
        args.probe.toUpperCase(),
      ].filter((value, index, all) => all.indexOf(value) === index);

      console.log(`Probing "${args.probe}" (delimiter "${delimiter}"):\n`);

      // A wildcard LIST catches the folder under an unexpected parent or with a
      // different capitalisation, without having to guess the full path.
      const pattern = `*${args.probe}*`;
      const wildcard = await internal.run('LIST', '', pattern, { listOnly: true });
      console.log(`  LIST "" "${pattern}" -> ${wildcard.length} match(es)`);
      wildcard.forEach((entry) => console.log(`     ${entry.path}`));
      console.log('');
      // Sequential on purpose: a failed STATUS on some servers drops the socket.
      /* eslint-disable no-await-in-loop */
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const listedHere = merged.some((m) => m.path === candidate);
        try {
          const status = await client.status(candidate, { messages: true });
          console.log(
            `  EXISTS  ${candidate}  (${status.messages ?? 0} messages)` +
              `${listedHere ? '' : '  <-- present but NOT returned by LIST'}`,
          );
        } catch {
          console.log(`  absent  ${candidate}`);
        }
      }
      /* eslint-enable no-await-in-loop */
      console.log('');
    }
    /* eslint-enable no-console */
  } finally {
    await connections.closeAll();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`\nDiagnostic failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
