/**
 * Commande de test des connexions.
 *
 * Sonde chaque compte configuré par le transport qu'il utilise réellement à
 * l'exécution : Microsoft Graph pour `backend = "graph"`, IMAP + SMTP sinon.
 * Les comptes OAuth2 reçoivent le service de jetons que leur donne le serveur :
 * une boîte joignable par le serveur l'est aussi ici, et inversement.
 */

import { intro, log, outro, spinner as p_spinner } from '@clack/prompts';

import { loadConfig } from '../config/loader.js';
import ConnectionManager from '../connections/manager.js';
import GraphClient from '../services/graph/graph.client.js';
import GraphService from '../services/graph/graph.service.js';
import OAuthService from '../services/oauth.service.js';

import type { AccountConfig } from '../types/index.js';

/**
 * Un compte servi par Graph n'ouvre jamais de connexion IMAP ni SMTP : tester
 * ces ports signalerait un échec que le serveur ne rencontre jamais. Lister les
 * dossiers exerce au contraire toute la chaîne : jeton de rafraîchissement →
 * jeton d'accès → API Graph.
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
    // Graph nomme la boîte de réception dans la langue de la boîte (« Boîte de
    // réception ») : c'est l'attribut SPECIAL-USE qui l'identifie, pas le chemin.
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
 * Teste les points d'accès IMAP et SMTP d'un compte de messagerie classique.
 * Le service OAuth est transmis pour qu'un compte authentifié par jeton soit
 * testé avec un vrai jeton d'accès, et non avec un mot de passe inexistant.
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

  // Un seul cache de jetons pour toute l'exécution : un compte testé deux fois
  // (ou deux comptes partageant une application) n'échange pas son jeton de
  // rafraîchissement à chaque fois.
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
