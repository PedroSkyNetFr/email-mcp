/**
 * Connection manager for lazy-persistent IMAP and SMTP connections.
 *
 * - Creates connections on first use per account
 * - Reuses open connections across tool calls
 * - Auto-reconnects on failure
 * - Graceful shutdown closes all connections
 */

import type { ImapFlowOptions } from 'imapflow';
import { ImapFlow } from 'imapflow';
import type { Transporter, TransportOptions } from 'nodemailer';
import nodemailer from 'nodemailer';
import { mcpLog } from '../logging.js';

import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import { authFailureHint, withAuthGuidance } from '../utils/auth-error.js';
import { isLoopbackHost } from '../utils/host.js';
import type { EphemeralImapOptions, IConnectionManager } from './types.js';

/**
 * Rappel de nodemailer pour obtenir un jeton OAuth2 : `renew` vaut vrai quand
 * le serveur vient de refuser le jeton courant.
 */
type ProvisionCallback = (
  user: string,
  renew: boolean,
  callback: (err: Error | null, accessToken?: string, expires?: number) => void,
) => void;

type SmtpAuth =
  | { user: string; pass?: string }
  | {
      type: 'OAuth2';
      user: string;
      accessToken: string;
      expires?: number;
      provisionCallback: ProvisionCallback;
    };

/** Marge avant l'expiration au-delà de laquelle nodemailer redemande un jeton. */
const SMTP_TOKEN_MARGIN_MS = 60_000;

/** Identifiants IMAP : mot de passe, ou jeton d'accès OAuth2 (XOAUTH2). */
export interface ImapAuth {
  user: string;
  pass?: string;
  accessToken?: string;
}

/**
 * Redact known + common credential substrings before logging an error
 * ([P2] codex). imapflow errors rarely echo the password, but auth/OAuth/TLS
 * failures can carry server text or diagnostic context — defense in depth so
 * a process-stderr log line can never leak a credential.
 */
export function redactSecrets(message: string, secrets: (string | undefined)[]): string {
  let out = message;
  secrets.forEach((s) => {
    if (s && s.length >= 4) {
      out = out.split(s).join('***');
    }
  });
  // Mask `Bearer <token>` / `Basic <blob>` auth schemes.
  out = out.replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, '$1 ***');
  // Mask `key: value` / `key=value` for credential-bearing keys.
  out = out.replace(
    /\b(password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\b(\s*[:=]\s*)[^\s"',;]+/gi,
    '$1$2***',
  );
  return out;
}

/**
 * Options ImapFlow communes à toutes les connexions IMAP d'un compte : client
 * mis en cache, client éphémère, test de connexion et veille IDLE. Une seule
 * source de vérité, pour qu'une option de sécurité ne puisse plus manquer à
 * l'une d'elles.
 *
 * STARTTLS : pour un hôte DISTANT, `starttls = true` avec `tls = false`
 * devient `doSTARTTLS: true`, c'est-à-dire une montée en TLS OBLIGATOIRE — la
 * connexion échoue si le serveur ne la propose pas. Sans cette option, ImapFlow
 * ne fait qu'un STARTTLS opportuniste : un intermédiaire qui retire la capacité
 * STARTTLS de la réponse (reçue en clair) obtenait l'identifiant en clair,
 * alors que la configuration demandait explicitement le chiffrement.
 *
 * Exception, l'hôte de bouclage (localhost, 127.0.0.0/8, ::1) : le trafic ne
 * quitte pas la machine, il n'y a pas d'intermédiaire à craindre, et l'ancien
 * assistant écrivait `starttls = !tls` — beaucoup de configurations de
 * passerelles locales en clair (DavMail, Proton Bridge…) portent donc
 * `starttls = true` sans que la passerelle propose STARTTLS. Elles gardent le
 * comportement opportuniste d'avant : STARTTLS si proposé, clair sinon.
 *
 * Les autres cas ne changent pas : `tls = true` reste du TLS direct,
 * `tls = false` + `starttls = false` garde le comportement opportuniste
 * d'ImapFlow.
 */
export function buildImapFlowOptions(
  account: AccountConfig,
  auth: ImapAuth,
  extra: Partial<ImapFlowOptions> = {},
): ImapFlowOptions {
  const requireStarttls =
    !account.imap.tls && account.imap.starttls && !isLoopbackHost(account.imap.host);
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    ...(requireStarttls ? { doSTARTTLS: true } : {}),
    tls: {
      rejectUnauthorized: account.imap.verifySsl,
    },
    auth,
    logger: false,
    ...extra,
  };
}

/**
 * Identifiants IMAP d'un compte : jeton d'accès OAuth2 quand le compte a un
 * bloc oauth2 (et que le service de jetons est fourni), mot de passe sinon.
 */
export async function resolveImapAuth(
  account: AccountConfig,
  oauthService?: OAuthService,
): Promise<ImapAuth> {
  if (account.oauth2 && oauthService) {
    const accessToken = await oauthService.getAccessToken(account.oauth2);
    return { user: account.username, accessToken };
  }
  return { user: account.username, pass: account.password };
}

/** Ferme un client ImapFlow sans jamais lever (déjà fermé, socket détruite…). */
function closeQuietly(client: ImapFlow): void {
  try {
    client.close();
  } catch {
    /* déjà fermé */
  }
}

export default class ConnectionManager implements IConnectionManager {
  private imapClients = new Map<string, ImapFlow>();

  /**
   * Connexions IMAP en cours d'établissement, par compte.
   *
   * Sans elle, deux appels d'outils arrivés ensemble sur un compte sans client
   * ouvraient chacun leur connexion : la seconde écrasait la première dans
   * `imapClients`, et la première restait ouverte sans plus aucune référence —
   * une connexion fantôme qui occupe l'une des sessions simultanées que le
   * serveur accorde (Gmail en limite 15 par compte) jusqu'à ce qu'il la coupe.
   * Les appels concurrents attendent désormais la même tentative.
   */
  private imapConnecting = new Map<string, Promise<ImapFlow>>();

  private smtpTransports = new Map<string, Transporter>();

  /**
   * Transports SMTP en cours de création, par compte — même raison que
   * `imapConnecting` : deux envois simultanés sur un compte sans transport en
   * créaient chacun un ; le second écrasait le premier dans le cache, qui
   * restait ouvert (pool compris) sans plus aucune référence.
   */
  private smtpConnecting = new Map<string, Promise<Transporter>>();

  private accounts = new Map<string, AccountConfig>();

  private oauthService?: OAuthService;

  constructor(accounts: AccountConfig[], oauthService?: OAuthService) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
    });
    this.oauthService = oauthService;
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  getAccount(name: string): AccountConfig {
    const account = this.accounts.get(name);
    if (!account) {
      throw new Error(
        `Account "${name}" not found. Available: ${[...this.accounts.keys()].join(', ')}`,
      );
    }
    return account;
  }

  getAccountNames(): string[] {
    return [...this.accounts.keys()];
  }

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  /**
   * Build an UNCONNECTED ImapFlow for an account (auth/OAuth + transport
   * options). Single source of truth for client construction — shared by the
   * cached `getImapClient` and the throwaway `createEphemeralImapClient` (D3
   * infra: do NOT reimplement auth elsewhere).
   */
  private async buildImapClient(
    accountName: string,
    extra: Partial<ImapFlowOptions> = {},
  ): Promise<ImapFlow> {
    const account = this.getAccount(accountName);
    const auth = await resolveImapAuth(account, this.oauthService);
    return new ImapFlow(buildImapFlowOptions(account, auth, extra));
  }

  async getImapClient(accountName: string): Promise<ImapFlow> {
    const existing = this.imapClients.get(accountName);
    if (existing?.usable) {
      return existing;
    }

    // Une connexion est déjà en train de s'établir pour ce compte : l'attendre
    // plutôt que d'en ouvrir une seconde (voir `imapConnecting`).
    const pending = this.imapConnecting.get(accountName);
    if (pending) {
      return pending;
    }

    // Clean up stale connection
    if (existing) {
      this.imapClients.delete(accountName);
      closeQuietly(existing);
    }

    const attempt = this.connectImapClient(accountName);
    this.imapConnecting.set(accountName, attempt);
    try {
      return await attempt;
    } finally {
      // Retirée sur échec aussi : une tentative rejetée laissée ici serait
      // resservie à chaque appel suivant, et le compte ne se reconnecterait
      // plus jamais.
      if (this.imapConnecting.get(accountName) === attempt) {
        this.imapConnecting.delete(accountName);
      }
    }
  }

  /** Ouvre, authentifie et met en cache un nouveau client IMAP pour un compte. */
  private async connectImapClient(accountName: string): Promise<ImapFlow> {
    const account = this.getAccount(accountName);
    const client = await this.buildImapClient(accountName);

    // Retire ce client du cache — mais SEULEMENT s'il est encore le client
    // courant. Un client remplacé entre-temps peut émettre 'error' ou 'close'
    // bien plus tard : sans cette comparaison d'identité, il évinçait du cache
    // le client sain qui l'avait remplacé, et l'appel suivant ouvrait une
    // connexion de plus en laissant la précédente ouverte.
    const forget = (): void => {
      if (this.imapClients.get(accountName) === client) {
        this.imapClients.delete(accountName);
      }
    };

    // R1c/D6/F2: a socket-timeout emitError() on a client with NO 'error'
    // listener crashes the whole process. Attach a default handler at creation
    // — before connect(), so connection-phase errors are caught too. Le client
    // fautif est retiré du cache ET fermé : laissé ouvert, il restait une
    // connexion fantôme côté serveur. The watcher uses its own clients.
    client.on('error', (err: Error) => {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err), [
        account.password,
      ]);
      mcpLog('error', 'imap', `IMAP client error for "${accountName}": ${detail}`).catch(() => {});
      forget();
      closeQuietly(client);
    });

    // Fermeture côté serveur (délai d'inactivité, redémarrage) : même éviction,
    // pour que l'appel suivant reconnecte au lieu de recevoir un client mort.
    client.on('close', forget);

    try {
      await withAuthGuidance(account, 'IMAP', async () => client.connect());
    } catch (err) {
      // Échec de connexion ou d'authentification : ne rien laisser ouvert.
      closeQuietly(client);
      throw err;
    }
    await mcpLog(
      'info',
      'imap',
      `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    this.imapClients.set(accountName, client);
    return client;
  }

  /**
   * Create a throwaway, UNCACHED IMAP connection for a bounded deep search
   * (D3/R3). The caller owns its lifecycle and MUST `close()` it (e.g. on a
   * bounded-wait timeout). It is never stored in `imapClients`, so its
   * failure can never poison the account's shared client. It still gets a
   * log-and-swallow `'error'` listener so a socket-timeout emitError on the
   * ephemeral socket cannot crash the process (F2), but — unlike the cached
   * client's handler — it does NOT touch the shared-client map.
   */
  async createEphemeralImapClient(
    accountName: string,
    options: EphemeralImapOptions = {},
  ): Promise<ImapFlow> {
    const account = this.getAccount(accountName);
    const client = await this.buildImapClient(
      accountName,
      options.qresync ? { qresync: true } : {},
    );

    client.on('error', (err: Error) => {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err), [
        account.password,
      ]);
      mcpLog('error', 'imap', `Ephemeral IMAP client error for "${accountName}": ${detail}`).catch(
        () => {},
      );
      // Intentionally NOT touching this.imapClients — the ephemeral client is
      // not cached; the caller closes it. D3: never poison the shared client.
    });

    try {
      await withAuthGuidance(account, 'IMAP', async () => client.connect());
    } catch (err) {
      closeQuietly(client);
      throw err;
    }
    await mcpLog(
      'info',
      'imap',
      `Ephemeral connection to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    return client;
  }

  // -------------------------------------------------------------------------
  // SMTP
  // -------------------------------------------------------------------------

  private static buildSmtpTransportOptions(
    account: AccountConfig,
    auth: SmtpAuth,
  ): TransportOptions {
    const pool = account.smtp.pool ?? {
      enabled: true,
      maxConnections: 1,
      maxMessages: 100,
    };

    return {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.tls,
      requireTLS: account.smtp.starttls,
      ignoreTLS: !account.smtp.tls && !account.smtp.starttls,
      tls: {
        rejectUnauthorized: account.smtp.verifySsl,
      },
      auth,
      pool: pool.enabled,
      ...(pool.enabled
        ? {
            maxConnections: pool.maxConnections,
            maxMessages: pool.maxMessages,
          }
        : {}),
    } as TransportOptions;
  }

  async getSmtpTransport(
    accountName: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    const verify = options?.verify ?? false;
    const existing = this.smtpTransports.get(accountName);
    if (existing) {
      if (!verify) {
        return existing;
      }
      try {
        await existing.verify();
        return existing;
      } catch {
        this.smtpTransports.delete(accountName);
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
    }

    // Un transport est déjà en cours de création pour ce compte : l'attendre.
    const pending = this.smtpConnecting.get(accountName);
    if (pending) return pending;

    const attempt = this.connectSmtpTransport(accountName);
    this.smtpConnecting.set(accountName, attempt);
    try {
      return await attempt;
    } finally {
      // Retirée sur échec aussi, pour que l'appel suivant retente.
      if (this.smtpConnecting.get(accountName) === attempt) {
        this.smtpConnecting.delete(accountName);
      }
    }
  }

  /**
   * Identifiants SMTP d'un compte. En OAuth2, le transport reçoit un
   * `provisionCallback` au lieu d'un jeton figé : le transport mis en cache
   * gardait le jeton du premier envoi, et tout envoi après son expiration
   * (~1 h chez Microsoft et Google) échouait en « 535 authentication failed ».
   * Nodemailer rappelle désormais ce rappel quand le jeton a expiré (`expires`)
   * ou que le serveur l'a refusé (`renew`), et le service OAuth fournit un
   * jeton frais — chaque connexion du pool comprise.
   */
  private async resolveSmtpAuth(account: AccountConfig): Promise<SmtpAuth> {
    const { oauth2 } = account;
    const { oauthService } = this;
    if (!oauth2 || !oauthService) {
      return { user: account.username, pass: account.password };
    }
    const expiresAt = (): number | undefined =>
      oauth2.tokenExpiry ? oauth2.tokenExpiry - SMTP_TOKEN_MARGIN_MS : undefined;
    const accessToken = await oauthService.getAccessToken(oauth2);
    return {
      type: 'OAuth2',
      user: account.username,
      accessToken,
      expires: expiresAt(),
      provisionCallback: (_user, renew, callback) => {
        if (renew) {
          // Jeton refusé par le serveur alors qu'il paraissait valide : on
          // l'oublie pour forcer un vrai rafraîchissement.
          Object.assign(oauth2, { accessToken: undefined, tokenExpiry: undefined });
        }
        oauthService.getAccessToken(oauth2).then(
          (token) => callback(null, token, expiresAt()),
          (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
        );
      },
    };
  }

  /** Crée, vérifie et met en cache un nouveau transport SMTP pour un compte. */
  private async connectSmtpTransport(accountName: string): Promise<Transporter> {
    const account = this.getAccount(accountName);
    const auth = await this.resolveSmtpAuth(account);

    const transport = nodemailer.createTransport(
      ConnectionManager.buildSmtpTransportOptions(account, auth),
    );

    try {
      await withAuthGuidance(account, 'SMTP', async () => transport.verify());
    } catch (err) {
      transport.close();
      throw err;
    }
    await mcpLog(
      'info',
      'smtp',
      `Connected to ${account.smtp.host}:${account.smtp.port} for "${accountName}"`,
    );
    // Un transport précédent encore en cache (remplacé) est fermé, pour ne pas
    // laisser ses connexions de pool ouvertes sans référence.
    const previous = this.smtpTransports.get(accountName);
    if (previous && previous !== transport) {
      try {
        previous.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.smtpTransports.set(accountName, transport);
    return transport;
  }

  async verifySmtpTransport(accountName: string): Promise<void> {
    await this.getSmtpTransport(accountName, { verify: true });
  }

  // -------------------------------------------------------------------------
  // Test connections (for setup wizard / test command)
  // -------------------------------------------------------------------------

  static async testImap(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{
    success: boolean;
    error?: string;
    /** Que faire d'un identifiant refusé, pour que l'appelant l'affiche. */
    hint?: string;
    details?: { messages: number; folders: number };
  }> {
    let client: ImapFlow | undefined;
    try {
      const auth = await resolveImapAuth(account, oauthService);
      client = new ImapFlow(buildImapFlowOptions(account, auth));
      // Sans écouteur 'error', une erreur de socket émise pendant le test
      // (délai dépassé, coupure) faisait planter tout le processus CLI au lieu
      // d'être rapportée comme un échec du test. L'échec lui-même remonte par
      // le rejet de connect()/list() ci-dessous.
      client.on('error', () => {});
      await client.connect();
      // Référence non nullable pour la fermeture `countMessages` ci-dessous
      // (TypeScript ne propage pas le rétrécissement de `client` dans un callback).
      const connected = client;

      const mailboxes = await connected.list();
      // imapflow distingue deux échecs de STATUS : un dossier absent lève une
      // erreur `NotFound` (ex. Google Workspace sans INBOX, qui utilise « All
      // Mail »), un refus du serveur sur un dossier existant renvoie `false`.
      // Les deux mènent au même repli : compter le premier dossier listé.
      // Le compteur reste indicatif : la connexion, elle, fonctionne.
      const countMessages = async (path: string): Promise<number | undefined> => {
        try {
          const status = await connected.status(path, { messages: true });
          return status === false ? undefined : (status.messages ?? 0);
        } catch {
          return undefined;
        }
      };
      let messageCount = await countMessages('INBOX');
      if (messageCount === undefined && mailboxes.length > 0) {
        messageCount = await countMessages(mailboxes[0].path);
      }

      return {
        success: true,
        details: {
          messages: messageCount ?? 0,
          folders: mailboxes.length,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        hint: authFailureHint(err, account),
      };
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      }
    }
  }

  static async testSmtp(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{ success: boolean; error?: string; hint?: string }> {
    let transport: Transporter | undefined;
    try {
      let auth: SmtpAuth;
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { type: 'OAuth2', user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      transport = nodemailer.createTransport(
        ConnectionManager.buildSmtpTransportOptions(account, auth),
      );
      await transport.verify();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        hint: authFailureHint(err, account),
      };
    } finally {
      transport?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async closeAll(): Promise<void> {
    await mcpLog('info', 'connections', 'Closing all connections');
    const closeOps: Promise<void>[] = [];

    Array.from(this.imapClients.entries()).forEach(([name, client]) => {
      closeOps.push(
        client
          .logout()
          .catch(() => {})
          .then(() => {
            this.imapClients.delete(name);
          }),
      );
    });

    Array.from(this.smtpTransports.entries()).forEach(([name, transport]) => {
      transport.close();
      this.smtpTransports.delete(name);
    });

    await Promise.allSettled(closeOps);
  }
}
