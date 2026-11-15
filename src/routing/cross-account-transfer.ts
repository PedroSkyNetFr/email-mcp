/**
 * Briques communes aux transferts inter-comptes : `cross_account_copy`
 * (CrossAccountCopier) et `cross_account_move` (CrossAccountMover).
 *
 * Les deux opérations lisent la source brute, dédoublonnent par Message-ID sur
 * la destination puis y font un APPEND ; seule la suite diffère (la copie
 * s'arrête là, le déplacement journalise puis nettoie la source). Ces étapes
 * vivent ici une seule fois pour que les deux outils ne puissent pas diverger
 * — même refus d'une destination Graph, même lecture d'une source Graph, même
 * dédoublonnage.
 *
 * Deux backends, par compte (voir mail-router.ts) :
 *   - source IMAP : lue par chaque appelant (la copie en EXAMINE, le
 *     déplacement en SELECT avec UIDVALIDITY : leurs garde-fous diffèrent) ;
 *   - source Graph : `GET /me/messages/{id}/$value` (MIME brut) par le routeur,
 *     plus lu / suivi / date de réception lus sur le message ({@link readGraphSource}) ;
 *   - destination IMAP : APPEND avec drapeaux et date ({@link appendAtDestination}) ;
 *   - destination Graph : REFUSÉE ({@link graphDestinationRefusal}). Graph
 *     n'importe un MIME brut que par `POST /me/messages`, et le message créé
 *     est un BROUILLON (`isDraft: true`, date de réception = date d'import) :
 *     il ne ressemblerait pas à un message reçu.
 */

import type ConnectionManager from '../connections/manager.js';
import { GraphError } from '../services/graph/graph.client.js';
import type { IMailService } from '../services/mail-service.types.js';
import { firstHeader, parseHeaderBlock, splitHeaderBlock } from '../utils/headers.js';
import type { ErrorKind, MoveWarning } from './error-kinds.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';

/** Message source lu, quel que soit son backend. */
export interface SourceMessage {
  raw: Buffer;
  flags: string[];
  internalDate: Date | undefined;
  messageId: string | null;
  subject: string | null;
  from: string | null;
}

export function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) {
    return v;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export function formatFrom(addr?: { name?: string; address?: string }): string | null {
  if (!addr) {
    return null;
  }
  const name = addr.name ? `${addr.name} ` : '';
  return `${name}<${addr.address ?? ''}>`.trim();
}

/** Map a raw IMAP/imapflow error to a typed MoveError. */
export function classifyImapError(err: unknown, fallback: ErrorKind): MoveError {
  if (err instanceof MoveError) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/quota|OVERQUOTA|LIMIT/i.test(msg)) {
    return new MoveError(ERROR_KIND.QUOTA_EXCEEDED, `destination over quota: ${msg}`);
  }
  if (/connection|ECONNRESET|ETIMEDOUT|socket/i.test(msg)) {
    return new MoveError(ERROR_KIND.CONNECTION_ERROR, msg);
  }
  return new MoveError(fallback, msg);
}

/** Message-ID lu dans le bloc d'en-têtes d'un MIME brut. */
export function messageIdOf(raw: Buffer): string | null {
  const value = firstHeader(parseHeaderBlock(splitHeaderBlock(raw)), 'message-id');
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Refus d'une destination Graph, commun à la copie et au déplacement. Rendu
 * AVANT toute lecture de la source : rien n'a été touché quand il tombe.
 */
export function graphDestinationRefusal(
  destAccount: string,
  operation: 'copy' | 'move',
): { kind: ErrorKind; message: string } {
  const what = operation === 'copy' ? 'the copy' : 'the moved message';
  const alternative =
    operation === 'copy'
      ? 'Copy into an IMAP account, or use forward_email.'
      : 'Move into an IMAP account, or use forward_email (the source is left untouched).';
  return {
    kind: ERROR_KIND.DEST_BACKEND_UNSUPPORTED,
    message:
      `destination "${destAccount}" is served by Microsoft Graph, which can only import a raw ` +
      `message as a DRAFT (isDraft, received date = import time): ${what} would not look ` +
      `natively delivered, so it is refused. ${alternative}`,
  };
}

/**
 * Contrôle de l'identifiant source selon le backend : id Graph opaque (non
 * vide), ou UID IMAP entier strictement positif.
 */
export function emailIdError(
  emailId: string,
  sourceIsGraph: boolean,
): { kind: ErrorKind; message: string } | null {
  if (sourceIsGraph) {
    return emailId.trim() === ''
      ? { kind: ERROR_KIND.INVALID_EMAIL_ID, message: 'email_id is empty' }
      : null;
  }
  const uid = Number(emailId);
  if (!/^\d+$/.test(emailId) || !Number.isInteger(uid) || uid <= 0) {
    return {
      kind: ERROR_KIND.INVALID_EMAIL_ID,
      message: `email_id "${emailId}" is not a positive integer`,
    };
  }
  return null;
}

/**
 * Source Graph : MIME brut (`/$value`) et état du message, lus par le
 * routeur. Graph n'a d'équivalent qu'à \Seen (isRead) et \Flagged (flag) ;
 * la date de réception tient lieu d'INTERNALDATE. Lecture seule.
 */
export async function readGraphSource(
  mailService: IMailService,
  account: string,
  mailbox: string,
  emailId: string,
): Promise<SourceMessage> {
  let state: Awaited<ReturnType<IMailService['getEmailFlags']>>;
  let raw: Buffer;
  try {
    state = await mailService.getEmailFlags(account, emailId, mailbox);
    raw = await mailService.getEmailRaw(account, emailId, mailbox);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound = err instanceof GraphError && err.status === 404;
    throw new MoveError(
      notFound ? ERROR_KIND.SOURCE_NOT_FOUND : ERROR_KIND.CONNECTION_ERROR,
      `could not read ${emailId} from ${account}: ${message}`,
    );
  }
  const flags = [...(state.seen ? ['\\Seen'] : []), ...(state.flagged ? ['\\Flagged'] : [])];
  return {
    raw,
    flags,
    internalDate: toDate(state.date),
    messageId: messageIdOf(raw),
    subject: state.subject || null,
    from: state.from || null,
  };
}

/**
 * Dédoublonnage par Message-ID puis APPEND (drapeaux + date conservés), sous
 * un seul verrou de la boîte de destination. Un message déjà présent n'est pas
 * ajouté une seconde fois ; rien n'est jamais supprimé côté destination.
 *
 * Options propres au déplacement :
 *   - `requireUid` : un APPEND sans UID rendu (pas d'UIDPLUS) est un échec —
 *     le déplacement a besoin de l'UID pour journaliser et pour retirer son
 *     doublon en cas de course ; la copie s'en passe ;
 *   - `routedKeyword` : pose le mot-clé `$Routed` si PERMANENTFLAGS l'accepte,
 *     sinon un avertissement `flag_not_set` dans `warnings`.
 */
export async function appendAtDestination(
  connections: ConnectionManager,
  destAccount: string,
  destMailbox: string,
  src: SourceMessage,
  options: { requireUid?: boolean; routedKeyword?: boolean; warnings?: MoveWarning[] } = {},
): Promise<{ destUid: number | null; dedupHit: boolean }> {
  const warnings = options.warnings ?? [];
  const destClient = await connections.getImapClient(destAccount);
  const destLock = await destClient.getMailboxLock(destMailbox);
  try {
    if (src.messageId) {
      const found = await destClient.search(
        { header: { 'message-id': src.messageId } },
        { uid: true },
      );
      if (found && found.length > 0) {
        return { destUid: found[0], dedupHit: true };
      }
    }
    // \Recent est posé par le serveur seul : le transmettre ferait refuser l'APPEND.
    const flags = src.flags.filter((flag) => flag.toLowerCase() !== '\\recent');
    const appended = await destClient.append(destMailbox, src.raw, flags, src.internalDate);
    if (options.requireUid && (appended === false || typeof appended.uid !== 'number')) {
      throw new MoveError(ERROR_KIND.APPEND_FAILED, 'destination APPEND failed or returned no UID');
    }
    if (appended === false) {
      throw new MoveError(ERROR_KIND.APPEND_FAILED, 'destination APPEND failed');
    }
    if (typeof appended.uid !== 'number') {
      // Sans UIDPLUS, le serveur ne rend pas l'UID : la copie a réussi quand même.
      return { destUid: null, dedupHit: false };
    }
    const destUid = appended.uid;
    if (options.routedKeyword) {
      // $Routed, conditionné à PERMANENTFLAGS.
      const mb = destClient.mailbox;
      const permFlags = mb === false ? new Set<string>() : (mb.permanentFlags ?? new Set<string>());
      if (permFlags.has('\\*') || permFlags.has('$Routed')) {
        await destClient.messageFlagsAdd(String(destUid), ['$Routed'], { uid: true }).catch(() => {
          warnings.push({
            kind: WARNING_KIND.FLAG_NOT_SET,
            message: '$Routed STORE failed on destination',
          });
        });
      } else {
        warnings.push({
          kind: WARNING_KIND.FLAG_NOT_SET,
          message: 'destination PERMANENTFLAGS does not accept custom keywords',
        });
      }
    }
    return { destUid, dedupHit: false };
  } catch (err) {
    throw classifyImapError(err, ERROR_KIND.APPEND_FAILED);
  } finally {
    destLock.release();
  }
}
