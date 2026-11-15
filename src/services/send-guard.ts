/**
 * Garde anti-doublon des envois (issue codefuturist #62 : « a retried call is
 * indistinguishable from a new email »).
 *
 * Un client MCP qui relance un appel d'envoi — délai dépassé, reconnexion,
 * Claude Desktop qui redémarre le serveur — ne se distingue pas d'une
 * nouvelle demande : le destinataire reçoit le message deux fois. Claude
 * Desktop n'envoie aucune clé d'idempotence ; la protection est donc
 * automatique, au niveau des outils (identique sur IMAP/SMTP et Graph) :
 *
 *   - **Empreinte** : SHA-256 du compte, des destinataires normalisés (triés,
 *     minuscules), de l'objet, du corps, des empreintes des pièces jointes et,
 *     pour une réponse / un transfert / un brouillon, de l'identifiant de
 *     l'original. Un envoi de même empreinte dans la fenêtre
 *     (`duplicate_send_window_minutes`, 10 min par défaut) est REFUSÉ, sauf
 *     `allow_duplicate: true`.
 *   - **Clé explicite** (`idempotency_key`) : la même clé dans la fenêtre
 *     renvoie le résultat du premier envoi, sans renvoyer.
 *
 * L'empreinte n'est enregistrée qu'APRÈS un envoi réussi — ou à l'issue
 * incertaine (Graph : la requête /send a échoué mais le serveur a pu
 * envoyer) : un renvoi aveugle est alors bloqué aussi. Un échec net
 * n'enregistre rien et ne bloque pas un nouvel essai.
 *
 * Persistance : un petit fichier JSON dans le répertoire d'état XDG, réécrit
 * de façon atomique (fichier temporaire puis renommage), purgé des entrées de
 * plus de 24 h. Il ne contient que des empreintes et des identifiants de
 * message — jamais destinataires, objet ni corps. Le fichier est relu avant
 * chaque décision : plusieurs instances du serveur (une par connecteur
 * Claude Desktop) partagent le même répertoire d'état.
 *
 * Les envois du planificateur ne passent pas par ici : ils ont leur propre
 * verrou (fichiers `.claim`) et une création de planification n'est pas un
 * envoi.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { xdg } from '../config/xdg.js';

/** Fichier d'état par défaut. */
export const SEND_GUARD_FILE = path.join(xdg.state, 'send-guard.json');

/** Durée de conservation des entrées, quelle que soit la fenêtre. */
export const SEND_GUARD_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Fenêtre par défaut de détection des doublons, en minutes. */
export const DEFAULT_DUPLICATE_WINDOW_MINUTES = 10;

/** Issue enregistrée d'un envoi. */
export type SendRecordStatus = 'sent' | 'uncertain';

export interface SendRecord {
  /** Empreinte SHA-256 de l'envoi (voir {@link sendFingerprint}). */
  fingerprint: string;
  /** Empreinte de la clé d'idempotence (compte + clé), jamais la clé brute. */
  keyHash?: string;
  /** Outil à l'origine de l'envoi (send_email, reply_email…). */
  tool: string;
  /** Horodatage ISO de l'enregistrement. */
  at: string;
  /** Message-ID rendu par le serveur (vide sur Graph), ou id de planification. */
  messageId: string;
  status: SendRecordStatus;
}

interface GuardFile {
  version: 1;
  entries: SendRecord[];
}

/** Pièce jointe vue par l'empreinte : son nom et ses octets. */
export interface FingerprintAttachment {
  filename: string;
  content: Buffer;
}

/** Ce qui définit « le même envoi ». Les champs absents ne comptent pas. */
export interface FingerprintInput {
  /** Nature de l'envoi : un transfert et un envoi neuf ne se confondent pas. */
  kind: 'send' | 'reply' | 'forward' | 'draft' | 'schedule';
  account: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  html?: boolean;
  attachments?: FingerprintAttachment[];
  /** Original d'une réponse / d'un transfert. */
  emailId?: string;
  mailbox?: string;
  /** Brouillon envoyé par send_draft. */
  draftId?: string;
  /** Autres options qui changent le message (replyAll, includeAttachments…). */
  options?: Record<string, unknown>;
}

/** Dernier élément vérifiant le prédicat (Array.findLast est ES2023, la cible est ES2022). */
function lastMatch<T>(list: T[], predicate: (item: T) => boolean): T | undefined {
  return [...list].reverse().find(predicate);
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Adresses normalisées : espaces retirés, minuscules, triées, sans doublon. */
function normalizeAddresses(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))].sort();
}

/**
 * Empreinte d'un envoi. Les octets des pièces sont hachés un par un (le
 * contenu n'entre jamais tel quel dans l'empreinte, qui est elle-même un
 * hachage). Les listes sont triées : l'ordre des destinataires ou des pièces
 * ne fait pas un message différent.
 */
export function sendFingerprint(input: FingerprintInput): string {
  const canonical = {
    kind: input.kind,
    account: input.account,
    to: normalizeAddresses(input.to),
    cc: normalizeAddresses(input.cc),
    bcc: normalizeAddresses(input.bcc),
    subject: input.subject ?? '',
    body: input.body ?? '',
    html: input.html === true,
    attachments: (input.attachments ?? []).map((a) => `${a.filename}:${sha256(a.content)}`).sort(),
    emailId: input.emailId ?? '',
    mailbox: input.mailbox ?? '',
    draftId: input.draftId ?? '',
    options: Object.fromEntries(
      Object.entries(input.options ?? {})
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  return sha256(JSON.stringify(canonical));
}

/** Décision de la garde avant un envoi. */
export type GuardDecision =
  | { action: 'send'; ticket: GuardTicket }
  | { action: 'replay'; record: SendRecord }
  | { action: 'refuse'; record?: SendRecord; reason: 'duplicate' | 'key-mismatch' | 'in-flight' };

/** Envoi autorisé, en cours : à clore par {@link SendGuard.commit} ou {@link SendGuard.release}. */
export interface GuardTicket {
  id: string;
  account: string;
  tool: string;
  fingerprint: string;
  keyHash?: string;
}

export interface SendGuardOptions {
  /** Fenêtre en minutes ; 0 désactive la garde (clés comprises). */
  windowMinutes: number;
  filePath?: string;
  /** Horloge injectable (tests). */
  now?: () => number;
}

export default class SendGuard {
  private readonly windowMs: number;

  private readonly filePath: string;

  private readonly now: () => number;

  /**
   * Envois autorisés mais pas encore terminés, par empreinte : deux appels
   * identiques simultanés ne passent pas tous les deux la vérification
   * avant que le premier ait enregistré son issue.
   */
  private readonly inFlight = new Map<string, string>();

  /** Écritures sérialisées dans ce processus (lecture-fusion-écriture). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SendGuardOptions) {
    this.windowMs = Math.max(0, options.windowMinutes) * 60 * 1000;
    this.filePath = options.filePath ?? SEND_GUARD_FILE;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.windowMs > 0;
  }

  get windowMinutes(): number {
    return this.windowMs / 60_000;
  }

  /** Empreinte de la clé, liée au compte : deux comptes ne partagent pas leurs clés. */
  static keyHash(account: string, key: string): string {
    return sha256(`${account}\u0000${key}`);
  }

  /**
   * Décide si l'envoi peut partir.
   *
   * - clé connue dans la fenêtre, même empreinte → `replay` (rien n'est renvoyé) ;
   * - clé connue, empreinte différente → `refuse` (clé réutilisée pour un autre message) ;
   * - empreinte connue dans la fenêtre, sans `allowDuplicate` → `refuse` ;
   * - empreinte en cours d'envoi dans ce processus → `refuse` ;
   * - sinon `send`, avec un ticket à clore.
   */
  async check(req: {
    account: string;
    tool: string;
    fingerprint: string;
    idempotencyKey?: string;
    allowDuplicate?: boolean;
  }): Promise<GuardDecision> {
    const keyHash =
      req.idempotencyKey !== undefined && req.idempotencyKey !== ''
        ? SendGuard.keyHash(req.account, req.idempotencyKey)
        : undefined;
    const ticket: GuardTicket = {
      id: randomUUID(),
      account: req.account,
      tool: req.tool,
      fingerprint: req.fingerprint,
      ...(keyHash ? { keyHash } : {}),
    };
    if (!this.enabled) return { action: 'send', ticket };

    const cutoff = this.now() - this.windowMs;
    const recent = (await this.load()).filter((e) => Date.parse(e.at) >= cutoff);

    if (keyHash) {
      const byKey = lastMatch(recent, (e) => e.keyHash === keyHash);
      if (byKey) {
        return byKey.fingerprint === req.fingerprint
          ? { action: 'replay', record: byKey }
          : { action: 'refuse', record: byKey, reason: 'key-mismatch' };
      }
    }

    if (!req.allowDuplicate) {
      const same = lastMatch(recent, (e) => e.fingerprint === req.fingerprint);
      if (same) return { action: 'refuse', record: same, reason: 'duplicate' };
      if (this.inFlight.has(req.fingerprint)) return { action: 'refuse', reason: 'in-flight' };
    }

    this.inFlight.set(req.fingerprint, ticket.id);
    return { action: 'send', ticket };
  }

  /** Envoi terminé (ou à l'issue incertaine) : l'empreinte est enregistrée. */
  async commit(ticket: GuardTicket, messageId: string, status: SendRecordStatus): Promise<void> {
    this.forget(ticket);
    if (!this.enabled) return;
    const record: SendRecord = {
      fingerprint: ticket.fingerprint,
      ...(ticket.keyHash ? { keyHash: ticket.keyHash } : {}),
      tool: ticket.tool,
      at: new Date(this.now()).toISOString(),
      messageId,
      status,
    };
    await this.mutate((entries) => [...entries, record]);
  }

  /** Échec net : rien n'est enregistré, un nouvel essai reste possible. */
  release(ticket: GuardTicket): void {
    this.forget(ticket);
  }

  private forget(ticket: GuardTicket): void {
    if (this.inFlight.get(ticket.fingerprint) === ticket.id) {
      this.inFlight.delete(ticket.fingerprint);
    }
  }

  /** Entrées de moins de 24 h. Fichier absent ou illisible : aucune entrée. */
  private async load(): Promise<SendRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<GuardFile>;
      const cutoff = this.now() - SEND_GUARD_RETENTION_MS;
      return (Array.isArray(parsed.entries) ? parsed.entries : []).filter(
        (e): e is SendRecord =>
          !!e &&
          typeof e.fingerprint === 'string' &&
          typeof e.at === 'string' &&
          Date.parse(e.at) >= cutoff,
      );
    } catch {
      // Fichier corrompu (écriture interrompue d'une ancienne version…) : on
      // repart de zéro plutôt que de bloquer tout envoi.
      return [];
    }
  }

  /**
   * Relit, transforme, purge et réécrit le fichier de façon atomique : écrit
   * dans un fichier temporaire du même dossier, puis renommé par-dessus
   * l'ancien. Un arrêt brutal laisse l'ancien fichier intact, jamais un
   * fichier à moitié écrit.
   */
  private async mutate(change: (entries: SendRecord[]) => SendRecord[]): Promise<void> {
    const run = async (): Promise<void> => {
      const entries = change(await this.load());
      const payload: GuardFile = { version: 1, entries };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf-8', mode: 0o600 });
      try {
        await fs.rename(tmp, this.filePath);
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
    };
    const next = this.writeChain.then(run, run);
    // La chaîne survit à un échec ; l'appelant, lui, le voit.
    this.writeChain = next.catch(() => {});
    return next;
  }
}

/** Heure locale « HH:MM » d'un horodatage ISO. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
