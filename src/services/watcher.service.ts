/**
 * IMAP IDLE Watcher — real-time email monitoring.
 *
 * Maintains dedicated IMAP connections per account using IDLE to detect
 * new emails in real-time. Emits events on the shared event bus.
 *
 * Key design decisions:
 * - Separate ImapFlow connections from ConnectionManager (IDLE holds lock)
 * - Auto-reconnect with exponential backoff on connection failures
 * - Tracks last-seen UID per folder to detect genuinely new messages
 */

import { ImapFlow } from 'imapflow';
import { buildImapFlowOptions, resolveImapAuth } from '../connections/manager.js';
import { mcpLog } from '../logging.js';
import type { AccountConfig, EmailMeta, WatcherConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import { hasAttachments as hasAttachmentsLenient, safeIsoDate } from './imap.service.js';
import type OAuthService from './oauth.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdleState {
  client: ImapFlow | null;
  account: AccountConfig;
  folder: string;
  lastSeenUid: number;
  lock: { release: () => void } | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  stopped: boolean;
}

export interface WatcherStatus {
  account: string;
  folder: string;
  connected: boolean;
  lastSeenUid: number;
}

// ---------------------------------------------------------------------------
// System flags excluded from label extraction
// ---------------------------------------------------------------------------

const SYSTEM_FLAGS = new Set([
  '\\Seen',
  '\\Answered',
  '\\Flagged',
  '\\Deleted',
  '\\Draft',
  '\\Recent',
  '\\*',
]);

// ---------------------------------------------------------------------------
// WatcherService
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;

export default class WatcherService {
  private idleStates = new Map<string, IdleState>();

  private config: WatcherConfig;

  private accounts: AccountConfig[];

  private oauthService?: OAuthService;

  /**
   * @param oauthService service de jetons partagé avec le reste du serveur :
   *   un compte OAuth2 s'authentifie en IDLE avec un vrai jeton d'accès, et un
   *   seul rafraîchissement sert toutes les connexions du compte.
   */
  constructor(config: WatcherConfig, accounts: AccountConfig[], oauthService?: OAuthService) {
    this.config = config;
    this.accounts = accounts;
    this.oauthService = oauthService;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    // Un compte servi par Microsoft Graph n'a pas de session IMAP utilisable :
    // ses identifiants sont consentis pour Graph, et l'IMAP d'Exchange masque
    // des dossiers. Le surveiller en IDLE échouerait en boucle (reconnexion
    // toutes les minutes au mieux) : il est écarté, en le disant.
    const graphAccounts = this.accounts.filter((account) => account.backend === 'graph');
    if (graphAccounts.length > 0) {
      mcpLog(
        'info',
        'watcher',
        `IDLE watcher skips Graph-backed account(s): ${graphAccounts
          .map((account) => account.name)
          .join(', ')} — real-time watching is IMAP-only.`,
      ).catch(() => {});
    }
    const watchable = this.accounts.filter((account) => account.backend !== 'graph');

    const { folders } = this.config;
    const startOps: Promise<void>[] = [];
    watchable.forEach((account) => {
      folders.forEach((folder) => {
        startOps.push(this.startIdle(account, folder));
      });
    });
    await Promise.allSettled(startOps);
  }

  async stop(): Promise<void> {
    const stopOps = [...this.idleStates.values()].map(async (state) => {
      this.updateState(WatcherService.stateKey(state), { stopped: true });
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try {
        state.lock?.release();
        if (state.client) await state.client.logout();
      } catch {
        /* ignore */
      }
    });
    await Promise.allSettled(stopOps);
    this.idleStates.clear();
  }

  getStatus(): WatcherStatus[] {
    return [...this.idleStates.values()].map((state) => ({
      account: state.account.name,
      folder: state.folder,
      connected: state.client?.usable === true,
      lastSeenUid: state.lastSeenUid,
    }));
  }

  // -------------------------------------------------------------------------
  // State helpers (avoid param reassignment)
  // -------------------------------------------------------------------------

  private static stateKey(state: IdleState): string {
    return `${state.account.name}:${state.folder}`;
  }

  private updateState(key: string, updates: Partial<IdleState>): void {
    const state = this.idleStates.get(key);
    if (state) Object.assign(state, updates);
  }

  // -------------------------------------------------------------------------
  // IDLE connection lifecycle
  // -------------------------------------------------------------------------

  private async startIdle(account: AccountConfig, folder: string): Promise<void> {
    const key = `${account.name}:${folder}`;
    this.idleStates.set(key, {
      client: null,
      account,
      folder,
      lastSeenUid: 0,
      lock: null,
      reconnectTimer: null,
      backoffMs: INITIAL_BACKOFF_MS,
      stopped: false,
    });
    await this.connectIdle(key);
  }

  private async connectIdle(key: string): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state || state.stopped) return;

    let client: ImapFlow | null = null;
    try {
      // Un compte OAuth2 s'authentifie avec un JETON D'ACCÈS obtenu par le
      // service de jetons, exactement comme le client du ConnectionManager.
      // L'ancien code passait `account.password` comme jeton — vide ou faux
      // pour un compte OAuth2 —, si bien que l'IDLE d'un tel compte échouait
      // à chaque tentative, en boucle de reconnexion.
      if (state.account.oauth2 && !this.oauthService) {
        throw new Error('OAuth2 account but no token service was provided to the watcher');
      }
      const auth = await resolveImapAuth(state.account, this.oauthService);

      const created = new ImapFlow(
        buildImapFlowOptions(state.account, auth, {
          maxIdleTime: this.config.idleTimeout * 1000,
        }),
      );
      client = created;

      // Écouteurs posés AVANT connect() : une erreur de socket émise pendant la
      // connexion, sans écouteur 'error', faisait planter tout le processus.
      created.on('error', (err: unknown) => {
        // Suivie d'un 'close', qui déclenche la reconnexion.
        const errMsg = err instanceof Error ? err.message : String(err);
        mcpLog(
          'debug',
          'watcher',
          `IDLE client error for ${state.account.name}/${state.folder}: ${errMsg}`,
        ).catch(() => {});
      });

      // Reconnexion automatique — seulement pour le client ENREGISTRÉ. Un
      // client qui se ferme avant d'avoir été enregistré (échec de connect ou
      // de SELECT) est déjà pris en charge par le `catch` ci-dessous : sans ce
      // garde-fou, les deux chemins programmaient chacun une reconnexion.
      created.on('close', () => {
        const current = this.idleStates.get(key);
        if (current?.client !== created) return;
        this.updateState(key, { lock: null, client: null });
        if (!current.stopped) {
          this.scheduleReconnect(key);
        }
      });

      // Listen for new messages
      created.on('exists', (data: { path: string; count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          this.handleNewEmails(key).catch(() => {});
        }
      });

      await created.connect();

      const lock = await created.getMailboxLock(state.folder);

      // Arrêt demandé pendant la connexion : ne rien laisser ouvert derrière.
      if (this.idleStates.get(key) !== state || state.stopped) {
        lock.release();
        await created.logout().catch(() => {});
        return;
      }

      const { mailbox } = created;
      const uidNext =
        mailbox && typeof mailbox === 'object'
          ? ((mailbox as { uidNext?: number }).uidNext ?? 1)
          : 1;

      this.updateState(key, {
        client: created,
        lock,
        lastSeenUid: uidNext - 1,
        backoffMs: INITIAL_BACKOFF_MS,
      });

      await mcpLog(
        'info',
        'watcher',
        `IDLE started: ${state.account.name}/${state.folder} (uid > ${uidNext - 1})`,
      );
    } catch (err) {
      // Connexion établie mais SELECT refusé (dossier absent, droits) : fermer
      // le client, sinon chaque tentative de reconnexion laissait une session
      // IMAP ouverte de plus.
      if (client) {
        try {
          client.close();
        } catch {
          /* déjà fermé */
        }
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog(
        'warning',
        'watcher',
        `IDLE connect failed for ${state.account.name}/${state.folder}: ${errMsg}`,
      );
      this.scheduleReconnect(key);
    }
  }

  private scheduleReconnect(key: string): void {
    const state = this.idleStates.get(key);
    if (!state || state.stopped) return;

    const { backoffMs } = state;
    mcpLog(
      'info',
      'watcher',
      `Reconnecting ${state.account.name}/${state.folder} in ${backoffMs}ms`,
    ).catch(() => {});

    const timer = setTimeout(() => {
      this.updateState(key, { backoffMs: Math.min(backoffMs * 2, MAX_BACKOFF_MS) });
      this.connectIdle(key).catch(() => {});
    }, backoffMs);

    this.updateState(key, { reconnectTimer: timer });
  }

  // -------------------------------------------------------------------------
  // New email detection
  // -------------------------------------------------------------------------

  private async handleNewEmails(key: string): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state?.client) return;

    try {
      const searchRange = `${state.lastSeenUid + 1}:*`;
      const emails: EmailMeta[] = [];
      let maxUid = state.lastSeenUid;

      // `{ uid: true }` en TROISIÈME argument : c'est lui qui fait lire la plage
      // comme des UID. Le `uid: true` de la requête ne fait que demander l'UID
      // dans la réponse — sans l'option, « 101:* » était lu comme des numéros
      // de séquence, et un nouveau message pouvait être manqué ou un ancien
      // renvoyé.
      // eslint-disable-next-line no-restricted-syntax -- need sequential async iteration
      for await (const msg of state.client.fetch(
        searchRange,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        if (msg.uid > state.lastSeenUid) {
          emails.push(WatcherService.buildEmailMeta(msg));
          maxUid = Math.max(maxUid, msg.uid);
        }
      }

      if (maxUid > state.lastSeenUid) {
        this.updateState(key, { lastSeenUid: maxUid });
      }

      if (emails.length > 0) {
        eventBus.emit('email:new', {
          account: state.account.name,
          mailbox: state.folder,
          emails,
        });

        await mcpLog(
          'info',
          'watcher',
          `📬 ${emails.length} new email(s) in ${state.account.name}/${state.folder}`,
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'watcher', `Failed to fetch new emails: ${errMsg}`);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private static buildEmailMeta(msg: {
    uid: number;
    flags?: Set<string>;
    envelope?: {
      subject?: string;
      from?: { name?: string; address?: string }[];
      to?: { name?: string; address?: string }[];
      // imapflow garde la valeur brute (string) quand l'en-tête Date est
      // illisible : ne jamais supposer un objet Date ici.
      date?: Date | string;
    };
    bodyStructure?: unknown;
  }): EmailMeta {
    const flags = msg.flags ?? new Set<string>();
    const labels = [...flags].filter((f) => !SYSTEM_FLAGS.has(f));

    const from = msg.envelope?.from?.[0];
    const to = msg.envelope?.to ?? [];

    return {
      id: String(msg.uid),
      subject: msg.envelope?.subject ?? '(no subject)',
      from: { name: from?.name, address: from?.address ?? '' },
      to: to.map((a) => ({ name: a.name, address: a.address ?? '' })),
      date: safeIsoDate(msg.envelope?.date),
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      hasAttachments: WatcherService.hasAttachments(msg.bodyStructure),
      labels,
    };
  }

  private static hasAttachments(bodyStructure: unknown): boolean {
    // Single source of truth — same lenient detection as the IMAP metadata
    // and download paths. A stricter local recursion here previously
    // under-reported attachments on forwarded / Outlook mail.
    return hasAttachmentsLenient(bodyStructure);
  }
}
