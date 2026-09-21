/**
 * Connection test command.
 *
 * Probes each configured account over the transport it actually uses at
 * runtime: Microsoft Graph for `backend = "graph"`, IMAP + SMTP otherwise.
 * OAuth2 accounts get the token service the server gives them, so a mailbox
 * reachable by the server is reachable here too — and vice versa.
 */

import { intro, log, outro, spinner as p_spinner } from '@clack/prompts';

import { loadConfig } from '../config/loader.js';
import ConnectionManager from '../connections/manager.js';
import GraphClient from '../services/graph/graph.client.js';
import GraphService from '../services/graph/graph.service.js';
import OAuthService from '../services/oauth.service.js';

import type { AccountConfig } from '../types/index.js';

/**
 * Graph-backed accounts never open an IMAP or SMTP socket, so testing those
 * ports would report a failure the server would never hit. Listing folders
 * exercises the whole chain instead: refresh token → access token → Graph API.
 */
async function testGraphAccount(
  account: AccountConfig,
  oauthService: OAuthService,
): Promise<boolean> {
  const spinner = p_spinner();
  spinner.start('Graph graph.microsoft.com...');

  try {
    const service = new GraphService(
      new Map([[account.name, new GraphClient(account, oauthService)]]),
      () => account,
    );
    const mailboxes = await service.listMailboxes(account.name);
    // Graph names the inbox after the mailbox language ("Boîte de réception"),
    // so the SPECIAL-USE attribute is what identifies it, not the path.
    const inbox = mailboxes.find((box) => box.specialUse === '\\Inbox' || box.path === 'INBOX');
    const inboxInfo = inbox ? `, INBOX ${inbox.totalMessages} messages` : '';
    spinner.stop(`Graph ✓ graph.microsoft.com — ${mailboxes.length} folders${inboxInfo}`);
    return true;
  } catch (err) {
    spinner.stop(
      `Graph ✗ graph.microsoft.com — ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Test the IMAP and SMTP endpoints of a mail-protocol account. The OAuth
 * service is forwarded so token-authenticated accounts are exercised with a
 * real access token instead of a missing password.
 */
async function testImapAccount(
  account: AccountConfig,
  oauthService: OAuthService,
): Promise<boolean> {
  let ok = true;

  // Test IMAP
  const spinner = p_spinner();
  spinner.start(`IMAP ${account.imap.host}:${account.imap.port}...`);
  const imapResult = await ConnectionManager.testImap(account, oauthService);
  if (imapResult.success) {
    spinner.stop(
      `IMAP  ✓ ${account.imap.host}:${account.imap.port} — ${imapResult.details?.messages} messages, ${imapResult.details?.folders} folders`,
    );
  } else {
    spinner.stop(`IMAP  ✗ ${account.imap.host}:${account.imap.port} — ${imapResult.error}`);
    ok = false;
  }

  // Test SMTP
  spinner.start(`SMTP ${account.smtp.host}:${account.smtp.port}...`);
  const smtpResult = await ConnectionManager.testSmtp(account, oauthService);
  if (smtpResult.success) {
    spinner.stop(`SMTP  ✓ ${account.smtp.host}:${account.smtp.port} — authenticated`);
  } else {
    spinner.stop(`SMTP  ✗ ${account.smtp.host}:${account.smtp.port} — ${smtpResult.error}`);
    ok = false;
  }

  return ok;
}

async function testAccount(account: AccountConfig, oauthService: OAuthService): Promise<boolean> {
  const transport = account.backend === 'graph' ? 'Graph' : 'IMAP/SMTP';
  const auth = account.oauth2 ? 'OAuth2' : 'password';
  log.step(`Testing account: ${account.name} (${account.email}) — ${transport}, ${auth}`);

  if (account.backend === 'graph') {
    return testGraphAccount(account, oauthService);
  }
  return testImapAccount(account, oauthService);
}

export default async function runTest(accountFilter?: string): Promise<void> {
  intro('email-mcp test');

  const config = await loadConfig();

  const accounts = accountFilter
    ? config.accounts.filter((a) => a.name === accountFilter)
    : config.accounts;

  if (accounts.length === 0) {
    if (accountFilter) {
      log.error(
        `Account "${accountFilter}" not found. Available: ${config.accounts.map((a) => a.name).join(', ')}`,
      );
    } else {
      log.error('No accounts configured.');
    }
    throw new Error('No matching accounts found');
  }

  // One token cache for the whole run — an account tested twice (or two
  // accounts sharing an app registration) does not re-redeem its refresh token.
  const oauthService = new OAuthService();

  let allPassed = true;

  // Sequential testing — connections can't be parallelized reliably
  // eslint-disable-next-line no-restricted-syntax
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await testAccount(account, oauthService);
    if (!ok) allPassed = false;
  }

  if (allPassed) {
    outro('All accounts OK ✅');
  } else {
    outro('Some connections failed ❌');
    throw new Error('Connection tests failed');
  }
}
