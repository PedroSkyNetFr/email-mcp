/**
 * Traduction des identifiants refusés en consigne actionnable.
 *
 * Chaque protocole signale un mauvais mot de passe dans son dialecte : imapflow
 * pose `authenticationFailed` (réponse `[AUTHENTICATIONFAILED]`), nodemailer une
 * erreur `EAUTH` enveloppant `535-5.7.8 Username and Password not accepted`.
 * Aucun ne dit ce que l'utilisateur doit faire — pour Gmail, Yahoo ou iCloud,
 * « un mot de passe ordinaire ne peut pas marcher ici, créez un mot de passe
 * d'application ». Cette consigne existe déjà, fournisseur par fournisseur,
 * dans la table `cli/providers.ts` ; ce module y rattache l'échec.
 */

import { detectProvider, PROVIDERS } from '../cli/providers.js';
import type { AccountConfig, ProviderConfig } from '../types/index.js';

/** Codes d'erreur des deux protocoles pour « identifiants refusés ». */
const AUTH_CODES = new Set(['EAUTH', 'AUTHENTICATIONFAILED']);

/** Réponses SMTP : 534/535 authentification refusée, 538 chiffrement exigé. */
const AUTH_REPLY_CODES = new Set([534, 535, 538]);

const AUTH_TEXT =
  /authenticationfailed|authentication failed|invalid login|invalid credentials|username and password not accepted|login failed|password.*(incorrect|rejected)|invalid_grant/i;

/**
 * L'erreur signifie-t-elle que les identifiants ont été refusés, et non que le
 * serveur est injoignable ? Seul le premier cas mérite une consigne
 * d'identifiants : l'accoler à une panne DNS enverrait l'utilisateur sur une
 * fausse piste.
 */
export function isAuthFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    responseCode?: unknown;
    serverResponseCode?: unknown;
    authenticationFailed?: unknown;
    message?: unknown;
    response?: unknown;
    responseText?: unknown;
  };

  if (e.authenticationFailed === true) return true;
  if (typeof e.code === 'string' && AUTH_CODES.has(e.code.toUpperCase())) return true;
  if (
    typeof e.serverResponseCode === 'string' &&
    AUTH_CODES.has(e.serverResponseCode.toUpperCase())
  ) {
    return true;
  }
  if (typeof e.responseCode === 'number' && AUTH_REPLY_CODES.has(e.responseCode)) return true;

  const text = [e.message, e.response, e.responseText]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return text.length > 0 && AUTH_TEXT.test(text);
}

/** Fournisseur connu d'un compte : par le domaine de l'adresse, sinon par l'hôte IMAP. */
function providerOf(account: AccountConfig): ProviderConfig | undefined {
  return (
    detectProvider(account.email) ??
    PROVIDERS.find((provider) => provider.imap.host === account.imap.host)
  );
}

/** Ce que l'utilisateur doit faire, selon qui héberge la boîte et d'où vient le secret. */
function remedy(account: AccountConfig): string {
  if (account.oauth2) {
    return (
      'The OAuth2 refresh token looks expired or revoked — re-authorize (pnpm oauth:setup) ' +
      `and update the oauth2 block of account "${account.name}" in your config.`
    );
  }

  const provider = providerOf(account);
  if (provider?.notes) {
    return `${provider.name}: ${provider.notes}.`;
  }
  if (provider?.oauth2) {
    return `${provider.name} may require OAuth2 rather than a password.`;
  }
  return (
    'Check the username and password — many providers require an app password ' +
    'rather than your account password.'
  );
}

/**
 * La consigne seule, pour un appelant qui affiche déjà le message du serveur
 * et l'hôte (une ligne de spinner du CLI). `undefined` quand l'échec ne porte
 * pas sur les identifiants.
 */
export function authFailureHint(err: unknown, account: AccountConfig): string | undefined {
  if (!isAuthFailure(err)) return undefined;
  return `${remedy(account)} Update it with: email-mcp account edit ${account.name}`;
}

/**
 * Reformule un refus d'identifiants en message actionnable, en gardant les mots
 * du serveur pour ne pas perdre une raison propre au fournisseur.
 */
export function describeAuthFailure(
  err: unknown,
  account: AccountConfig,
  protocol: 'IMAP' | 'SMTP',
): string {
  const server =
    protocol === 'IMAP'
      ? `${account.imap.host}:${account.imap.port}`
      : `${account.smtp.host}:${account.smtp.port}`;
  const responseText = (err as { responseText?: unknown } | null)?.responseText;
  const message = err instanceof Error ? err.message : String(err);
  const detail =
    typeof responseText === 'string' && responseText.length > 0 && !message.includes(responseText)
      ? `${message} (${responseText})`
      : message;

  return [
    `${protocol} authentication failed for account "${account.name}" at ${server}.`,
    remedy(account),
    `Server said: ${detail}`,
    `Update the credential with: email-mcp account edit ${account.name}`,
  ].join('\n');
}

/**
 * Exécute une étape de connexion/authentification en remplaçant un refus
 * d'identifiants par la consigne. Tout le reste — délais, TLS, DNS — passe tel
 * quel.
 */
export async function withAuthGuidance<T>(
  account: AccountConfig,
  protocol: 'IMAP' | 'SMTP',
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isAuthFailure(err)) throw err;
    throw new Error(describeAuthFailure(err, account, protocol), { cause: err });
  }
}
