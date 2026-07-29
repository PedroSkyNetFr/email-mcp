#!/usr/bin/env tsx
/**
 * Microsoft Graph folder probe — does Graph expose more than IMAP?
 *
 * Exchange Online and Outlook.com only present a legacy subset of the mailbox
 * over IMAP: custom folders, and anything living outside the primary mail
 * store, can be missing from LIST entirely. Microsoft Graph reads the real
 * mailbox instead.
 *
 * This script answers one question before any Graph backend work is considered:
 * are the folders that IMAP cannot see actually reachable through Graph?
 *
 *   pnpm probe:graph --server outlook-mail
 *
 * It reuses the OAuth2 credentials already stored in an MCP client config and
 * redeems the refresh token for a Graph access token. Because the token was
 * originally consented for the IMAP/SMTP scopes, the exchange usually fails the
 * first time — the script then prints the exact command that re-runs consent
 * with the Graph scope. Nothing is written to the mailbox: read-only.
 *
 * Options:
 *   --server <name>   Server entry inside "mcpServers" (default: outlook-mail)
 *   --config <path>   Config file (default: %APPDATA%\Claude\claude_desktop_config.json)
 *   --find <text>     Highlight folders whose name contains this text
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const GRAPH_SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';

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

interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  childFolderCount?: number;
}

async function graphGet<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Graph ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Walk the folder tree depth-first, returning "Parent/Child" style paths. */
async function walk(
  token: string,
  url: string,
  prefix: string,
  depth: number,
  out: { path: string; count: number }[],
): Promise<void> {
  if (depth > 6) return;
  const page = await graphGet<{ value: GraphFolder[]; '@odata.nextLink'?: string }>(url, token);

  // Sequential on purpose: Graph throttles aggressively on parallel bursts.
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < page.value.length; i += 1) {
    const folder = page.value[i];
    const full = prefix ? `${prefix}/${folder.displayName}` : folder.displayName;
    out.push({ path: full, count: folder.totalItemCount ?? 0 });
    if ((folder.childFolderCount ?? 0) > 0) {
      await walk(
        token,
        `https://graph.microsoft.com/v1.0/me/mailFolders/${folder.id}/childFolders?$top=100`,
        full,
        depth + 1,
        out,
      );
    }
  }
  if (page['@odata.nextLink']) {
    await walk(token, page['@odata.nextLink'], prefix, depth, out);
  }
  /* eslint-enable no-await-in-loop */
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const serverName = args.server ?? 'outlook-mail';
  const configPath =
    args.config ?? path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');

  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    mcpServers?: Record<string, { env?: Record<string, string> }>;
  };
  const env = config.mcpServers?.[serverName]?.env;
  if (!env) {
    throw new Error(
      `No "${serverName}" entry. Available: ${Object.keys(config.mcpServers ?? {}).join(', ')}`,
    );
  }

  const clientId = env.MCP_EMAIL_OAUTH2_CLIENT_ID ?? '';
  const clientSecret = env.MCP_EMAIL_OAUTH2_CLIENT_SECRET ?? '';
  // A Graph-scoped token can be supplied without touching the config: the token
  // stored there is the IMAP/SMTP one the server needs, and must stay in place.
  const refreshToken = args['refresh-token'] ?? env.MCP_EMAIL_OAUTH2_REFRESH_TOKEN ?? '';
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`"${serverName}" has no OAuth2 credentials — is it an IMAP-password account?`);
  }

  /* eslint-disable no-console -- this script's output IS its interface */
  console.log(`\nAccount : ${env.MCP_EMAIL_ADDRESS ?? '(unknown)'}`);
  console.log('Asking for a Microsoft Graph token…\n');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      scope: GRAPH_SCOPE,
    }).toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.log(`Graph token refused (${response.status}).\n`);
    console.log(detail.slice(0, 400));
    console.log('\nThis is expected when the stored token was consented for IMAP/SMTP only.');
    console.log('Grant the Graph scope once, then run this script again:\n');
    console.log(
      `  pnpm oauth:setup --provider custom --client-id ${clientId} \\\n` +
        `    --auth-url ${AUTH_URL} \\\n` +
        `    --token-url ${TOKEN_URL} \\\n` +
        `    --scopes "${GRAPH_SCOPE}"\n`,
    );
    console.log('Then pass the new token back here WITHOUT editing the config, which must keep');
    console.log('the IMAP/SMTP token the server itself uses:\n');
    console.log(`  pnpm probe:graph --server ${serverName} --find NISSAN --refresh-token <new>\n`);
    process.exitCode = 2;
    return;
  }

  const { access_token: accessToken } = (await response.json()) as { access_token: string };
  console.log('Token acquired. Listing folders through Graph…\n');

  const folders: { path: string; count: number }[] = [];
  await walk(
    accessToken,
    'https://graph.microsoft.com/v1.0/me/mailFolders?$top=100&includeHiddenFolders=true',
    '',
    0,
    folders,
  );

  console.log(`Graph reports ${folders.length} folders (IMAP reported 12):\n`);
  folders.forEach((f) => console.log(`   ${f.path}  (${f.count} items)`));

  if (args.find) {
    const needle = args.find.toLowerCase();
    const hits = folders.filter((f) => f.path.toLowerCase().includes(needle));
    console.log(`\nMatches for "${args.find}": ${hits.length}`);
    hits.forEach((f) => console.log(`   FOUND -> ${f.path} (${f.count} items)`));
  }
  console.log('');
  /* eslint-enable no-console */
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`\nGraph probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
