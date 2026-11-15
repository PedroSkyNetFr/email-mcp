/**
 * CrossAccountMover (D15) — the cross-account move saga (D18).
 *
 * Transaction-script style. Source and destination are DIFFERENT accounts →
 * two independent imapflow clients → two independent mailbox locks (no
 * re-entrancy/deadlock: the D2 concern is sweep re-entering the SAME client;
 * not applicable to the standalone tool, which acquires its own locks like
 * every other tool in the codebase).
 *
 * Atomic sequence (D18):
 *   1. FETCH source: raw RFC822 + flags + INTERNALDATE + Message-ID + UIDVALIDITY
 *   2. Pre-flight dedup on destination by Message-ID
 *   3. APPEND to destination (preserve flags + INTERNALDATE), capture dest_uid
 *   4. STORE $Routed on dest if PERMANENTFLAGS allows (else warn)
 *   5. Synchronous audit INSERT (claim). 23505 → clean up our dup, duplicate_skipped.
 *      Other DB failure → audit_log_insert_failed, source untouched.
 *   6. Re-verify source UIDVALIDITY unchanged
 *   7. Resolve source \Trash (SPECIAL-USE)
 *   8. Source cleanup: UID MOVE source → source Trash (capability-gated).
 *      No MOVE capability → fail closed (source_cleanup_unsafe). The minimal
 *      tool never issues EXPUNGE — the spike proved Gmail mis-scopes it; the
 *      proven-safe-EXPUNGE fallback needs a per-account operator assertion that
 *      is out of scope here, so we fail closed instead of risking the footgun.
 *   9. recordSourceCleanup
 *
 * Deux backends en source, par compte (mail-router.ts) :
 *   - source IMAP : la saga ci-dessus, inchangée ;
 *   - source Graph : lecture par `GET /me/messages/{id}/$value` + état du
 *     message (readGraphSource, partagé avec la copie), id opaque accepté ;
 *     après APPEND vérifié (UID rendu) et journal écrit, nettoyage par
 *     `POST /me/messages/{id}/move` vers `deleteditems` (Éléments supprimés) —
 *     jamais un DELETE définitif. Graph n'a ni UIDVALIDITY ni capacité MOVE à
 *     vérifier : un id qui ne désigne plus le message fait échouer le
 *     déplacement (404), rapporté comme nettoyage échoué ;
 *   - destination Graph : refusée avant toute lecture (dest_backend_unsupported,
 *     même raison que la copie : Graph n'importe un MIME brut qu'en brouillon).
 *
 * Un nettoyage de source qui n'aboutit pas n'est jamais un succès muet : le
 * résultat porte `source_cleanup` différent de moved_to_trash,
 * `source_cleanup_error` et un avertissement `source_not_removed` (message
 * déposé, source conservée).
 */

import type ConnectionManager from '../connections/manager.js';
import type { IMailService } from '../services/mail-service.types.js';
import type { SourceMessage } from './cross-account-transfer.js';
import {
  appendAtDestination,
  emailIdError,
  formatFrom,
  graphDestinationRefusal,
  readGraphSource,
  toDate,
} from './cross-account-transfer.js';
import type { MoveWarning, SourceCleanup } from './error-kinds.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';
import type { MoveLogRepository } from './log-repository.js';

// Réexportés pour les appelants historiques ; la définition vit dans le module partagé.
export { classifyImapError, formatFrom, toDate } from './cross-account-transfer.js';

export interface MoveArgs {
  sourceAccount: string;
  sourceMailbox: string;
  /** UID IMAP, ou id Graph opaque pour un compte Graph. */
  emailId: string;
  destAccount: string;
  destMailbox: string;
}

export type MoveResult =
  | {
      success: true;
      status: 'success' | 'duplicate_skipped';
      source_account: string;
      source_mailbox: string;
      /** UID IMAP de la source ; null pour une source Graph (id opaque). */
      source_uid: number | null;
      /** UID IMAP ou id Graph de la source, tel que fourni. */
      source_id: string;
      dest_account: string;
      dest_mailbox: string;
      dest_uid: number | null;
      message_id: string | null;
      subject: string | null;
      from: string | null;
      size_bytes: number | null;
      source_cleanup: SourceCleanup;
      /**
       * Pourquoi la source n'a pas été retirée (message déposé à destination,
       * source conservée). Absent quand le nettoyage a abouti.
       */
      source_cleanup_error?: { kind: string; message: string };
      move_log_id: number;
      warnings: MoveWarning[];
    }
  | {
      success: false;
      error_kind: string;
      error_message: string;
      source_account: string;
      source_mailbox: string;
      source_uid: number | null;
      source_id: string;
      move_log_id?: number;
    };

interface FetchedSource extends SourceMessage {
  sizeBytes: number | null;
  /** UIDVALIDITY de la boîte source IMAP ; 0n pour une source Graph. */
  uidValidity: bigint;
}

/** Issue du nettoyage de la source, quel que soit son backend. */
interface CleanupOutcome {
  deleted: boolean;
  kind: SourceCleanup;
  warning?: MoveWarning;
  errorKind?: string;
  errorMessage?: string;
}

export class CrossAccountMover {
  constructor(
    private readonly connections: ConnectionManager,
    /** Routeur IMAP / Graph : lecture et nettoyage d'une source Graph. */
    private readonly mailService: IMailService,
    private readonly isGraphAccount: (name: string) => boolean,
    private readonly logRepo: MoveLogRepository,
  ) {}

  async moveMany(argsList: MoveArgs[]): Promise<MoveResult[]> {
    // Sequential (respect IMAP connection limits); one failure does not abort
    // the batch — each item gets its own result. Promise-chain reduce keeps it
    // sequential without a loop/await-in-loop.
    return argsList.reduce<Promise<MoveResult[]>>(async (accP, args) => {
      const acc = await accP;
      acc.push(await this.moveOne(args));
      return acc;
    }, Promise.resolve([]));
  }

  async moveOne(args: MoveArgs): Promise<MoveResult> {
    const { sourceAccount, sourceMailbox, emailId, destAccount, destMailbox } = args;
    const sourceIsGraph = this.isGraphAccount(sourceAccount);
    // Une source Graph n'a pas d'UID : elle est désignée par son id opaque.
    const parsedUid = sourceIsGraph ? Number.NaN : Number.parseInt(emailId, 10);
    const sourceUid = Number.isFinite(parsedUid) ? parsedUid : null;

    const fail = (kind: string, message: string, moveLogId?: number): MoveResult => ({
      success: false,
      error_kind: kind,
      error_message: message,
      source_account: sourceAccount,
      source_mailbox: sourceMailbox,
      source_uid: sourceUid,
      source_id: emailId,
      move_log_id: moveLogId,
    });

    // Contrôles sans réseau. Une destination Graph est refusée ici, avant
    // toute lecture ou modification de la source.
    const accounts = new Set(this.connections.getAccountNames());
    if (!accounts.has(sourceAccount)) {
      return fail(ERROR_KIND.SOURCE_NOT_FOUND, `source account "${sourceAccount}" not configured`);
    }
    if (!accounts.has(destAccount)) {
      return fail(
        ERROR_KIND.DEST_ACCOUNT_INVALID,
        `destination account "${destAccount}" not configured`,
      );
    }
    if (sourceAccount === destAccount) {
      return fail(
        ERROR_KIND.SAME_ACCOUNT_MOVE,
        'source and destination are the same account — use move_email instead',
      );
    }
    if (this.isGraphAccount(destAccount)) {
      const refusal = graphDestinationRefusal(destAccount, 'move');
      return fail(refusal.kind, refusal.message);
    }
    const badId = emailIdError(emailId, sourceIsGraph);
    if (badId) {
      return fail(badId.kind, badId.message);
    }
    // Colonne BIGINT du journal : une source Graph y est inscrite 0.
    const uid = sourceUid ?? 0;

    const warnings: MoveWarning[] = [];

    try {
      // 1. FETCH source.
      const src = sourceIsGraph
        ? await this.fetchGraphSource(sourceAccount, sourceMailbox, emailId)
        : await this.fetchSource(sourceAccount, sourceMailbox, uid);

      // 2-4. Destination work: dedup, APPEND, $Routed.
      // Le Message-ID est cherché à destination AVANT tout APPEND, et l'APPEND
      // doit rendre un UID : la source n'est touchée qu'après ce dépôt vérifié.
      const { destUid, dedupHit } = await appendAtDestination(
        this.connections,
        destAccount,
        destMailbox,
        src,
        { requireUid: true, routedKeyword: true, warnings },
      );

      // 5. Synchronous audit INSERT (D-Premise-2 — part of the move contract).
      // claim() throws a typed MoveError on DB-down/misconfig (→ outer catch);
      // returns ok:false when a concurrent move won the unique-index race.
      const status: 'success' | 'duplicate_skipped' = dedupHit ? 'duplicate_skipped' : 'success';
      const claimed = await this.logRepo.claim({
        source_account: sourceAccount,
        source_mailbox: sourceMailbox,
        // Source Graph (id opaque) : 0, identifiée par son Message-ID — même
        // convention que le journal des copies.
        source_uid: uid,
        dest_account: destAccount,
        dest_mailbox: destMailbox,
        dest_uid: destUid,
        message_id: src.messageId,
        subject: src.subject,
        from_addr: src.from,
        email_date: null,
        size_bytes: src.sizeBytes,
        status,
        manual: true,
      });
      if (!claimed.ok) {
        // A concurrent move won the race after our pre-flight dedup passed.
        // Remove our just-appended duplicate; report duplicate_skipped.
        if (!dedupHit && destUid !== null) {
          await this.discardDestDuplicate(destAccount, destMailbox, destUid).catch(() => {});
        }
        if (!claimed.existing) {
          throw new MoveError(
            ERROR_KIND.AUDIT_LOG_INSERT_FAILED,
            'duplicate detected but winner row not found',
          );
        }
        return {
          success: true,
          status: 'duplicate_skipped',
          source_account: sourceAccount,
          source_mailbox: sourceMailbox,
          source_uid: sourceUid,
          source_id: emailId,
          dest_account: destAccount,
          dest_mailbox: destMailbox,
          dest_uid: claimed.existing.dest_uid,
          message_id: src.messageId,
          subject: src.subject,
          from: src.from,
          size_bytes: src.sizeBytes,
          source_cleanup: 'skipped_unsafe',
          move_log_id: claimed.existing.id,
          warnings,
        };
      }
      const moveLogId = claimed.id;

      // 6-8. Source cleanup, capability-gated UID MOVE to source Trash.
      const cleanup = sourceIsGraph
        ? await this.cleanupGraphSource(sourceAccount, sourceMailbox, emailId)
        : await this.cleanupSource(sourceAccount, sourceMailbox, uid, src.uidValidity);
      await this.logRepo.recordSourceCleanup(moveLogId, {
        source_deleted: cleanup.deleted,
        source_cleanup: cleanup.kind,
        error_kind: cleanup.errorKind ?? null,
        error_message: cleanup.errorMessage ?? null,
      });
      if (cleanup.warning) {
        warnings.push(cleanup.warning);
      }
      // Jamais de succès muet : un message déposé dont la source reste en
      // place est dit dans le résultat, sur les deux backends.
      const cleanupError =
        !cleanup.deleted && cleanup.errorKind
          ? { kind: cleanup.errorKind, message: cleanup.errorMessage ?? cleanup.errorKind }
          : undefined;
      if (cleanupError) {
        warnings.push({
          kind: WARNING_KIND.SOURCE_NOT_REMOVED,
          message:
            `message ${dedupHit ? 'already present' : 'copied'} at the destination, but the ` +
            `source was NOT removed (${cleanupError.kind}: ${cleanupError.message})`,
        });
      }

      return {
        success: true,
        status,
        source_account: sourceAccount,
        source_mailbox: sourceMailbox,
        source_uid: sourceUid,
        source_id: emailId,
        dest_account: destAccount,
        dest_mailbox: destMailbox,
        dest_uid: destUid,
        message_id: src.messageId,
        subject: src.subject,
        from: src.from,
        size_bytes: src.sizeBytes,
        source_cleanup: cleanup.kind,
        ...(cleanupError ? { source_cleanup_error: cleanupError } : {}),
        move_log_id: moveLogId,
        warnings,
      };
    } catch (err) {
      if (err instanceof MoveError) {
        return fail(err.kind, err.message);
      }
      return fail(
        ERROR_KIND.CONNECTION_ERROR,
        `cross-account move failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fetchSource(account: string, mailbox: string, uid: number): Promise<FetchedSource> {
    const client = await this.connections.getImapClient(account);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const mb = client.mailbox;
      const uidValidity = mb === false ? undefined : mb.uidValidity;
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, source: true, flags: true, envelope: true, internalDate: true },
        { uid: true },
      );
      if (msg === false || !msg.source) {
        throw new MoveError(
          ERROR_KIND.SOURCE_NOT_FOUND,
          `email ${uid} not found in ${account}/${mailbox}`,
        );
      }
      const env = msg.envelope;
      return {
        raw: msg.source,
        flags: msg.flags ? [...msg.flags] : [],
        internalDate: toDate(msg.internalDate),
        messageId: env?.messageId ?? null,
        subject: env?.subject ?? null,
        from: formatFrom(env?.from?.[0]),
        sizeBytes: msg.source.length,
        uidValidity: typeof uidValidity === 'bigint' ? uidValidity : 0n,
      };
    } finally {
      lock.release();
    }
  }

  /** UID MOVE the source message into the source account's \Trash (D18). */
  private async cleanupSource(
    account: string,
    mailbox: string,
    uid: number,
    expectedUidValidity: bigint,
  ): Promise<CleanupOutcome> {
    const client = await this.connections.getImapClient(account);

    // 7. Resolve source \Trash via SPECIAL-USE.
    let trashPath: string | null = null;
    try {
      const mailboxes = await client.list();
      trashPath = mailboxes.find((mb) => mb.specialUse === '\\Trash')?.path ?? null;
    } catch {
      /* fall through to not-found */
    }
    if (!trashPath) {
      return {
        deleted: false,
        kind: 'skipped_no_trash',
        errorKind: ERROR_KIND.TRASH_MAILBOX_NOT_FOUND,
        errorMessage: `no \\Trash mailbox on "${account}"`,
      };
    }

    const lock = await client.getMailboxLock(mailbox);
    try {
      // 6. Re-verify UIDVALIDITY — the UID must still mean the same message.
      const nowMb = client.mailbox;
      const nowUidValidity = nowMb === false ? undefined : nowMb.uidValidity;
      if (
        expectedUidValidity !== 0n &&
        typeof nowUidValidity === 'bigint' &&
        nowUidValidity !== expectedUidValidity
      ) {
        return {
          deleted: false,
          kind: 'skipped_unsafe',
          errorKind: ERROR_KIND.SOURCE_NOT_FOUND,
          errorMessage: 'source UIDVALIDITY changed between fetch and cleanup',
        };
      }

      // 8. Capability-gated. UID MOVE only (proven safe on every current
      // account incl. Gmail). No MOVE → fail closed; never risk EXPUNGE.
      if (!client.capabilities.has('MOVE')) {
        return {
          deleted: false,
          kind: 'skipped_unsafe',
          errorKind: ERROR_KIND.SOURCE_CLEANUP_UNSAFE,
          errorMessage: `source "${account}" does not advertise MOVE; refusing unsafe EXPUNGE (fail closed)`,
        };
      }
      await client.messageMove(String(uid), trashPath, { uid: true });
      return { deleted: true, kind: 'moved_to_trash' };
    } catch (err) {
      return {
        deleted: false,
        kind: 'skipped_unsafe',
        errorKind: ERROR_KIND.SOURCE_CLEANUP_FAILED,
        errorMessage: `UID MOVE to Trash failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      lock.release();
    }
  }

  /** Source Graph : lecture partagée avec la copie, sans UIDVALIDITY. */
  private async fetchGraphSource(
    account: string,
    mailbox: string,
    emailId: string,
  ): Promise<FetchedSource> {
    const src = await readGraphSource(this.mailService, account, mailbox, emailId);
    return { ...src, sizeBytes: src.raw.length, uidValidity: 0n };
  }

  /**
   * Nettoyage d'une source Graph : `POST /me/messages/{id}/move` vers
   * `deleteditems` (Éléments supprimés), via `deleteEmail(…, permanent=false)`
   * du routeur — jamais le DELETE définitif. Un échec n'est pas levé : il est
   * rendu, le message étant déjà déposé et journalisé à destination.
   */
  private async cleanupGraphSource(
    account: string,
    mailbox: string,
    emailId: string,
  ): Promise<CleanupOutcome> {
    try {
      await this.mailService.deleteEmail(account, emailId, mailbox, false);
      return { deleted: true, kind: 'moved_to_trash' };
    } catch (err) {
      return {
        deleted: false,
        kind: 'skipped_unsafe',
        errorKind: ERROR_KIND.SOURCE_CLEANUP_FAILED,
        errorMessage: `Graph move to Deleted Items failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Remove a just-appended duplicate from the destination after a 23505 race. */
  private async discardDestDuplicate(
    destAccount: string,
    destMailbox: string,
    destUid: number,
  ): Promise<void> {
    const client = await this.connections.getImapClient(destAccount);
    const mailboxes = await client.list();
    const trashPath = mailboxes.find((mb) => mb.specialUse === '\\Trash')?.path;
    const lock = await client.getMailboxLock(destMailbox);
    try {
      if (trashPath && client.capabilities.has('MOVE')) {
        await client.messageMove(String(destUid), trashPath, { uid: true });
      }
      // No MOVE/Trash: leave the dup; the orphan is logged by the caller.
    } finally {
      lock.release();
    }
  }
}
