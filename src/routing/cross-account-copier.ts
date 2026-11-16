/**
 * CrossAccountCopier — copie NON destructive d'un message vers un autre compte
 * (outil `cross_account_copy`, wgs4 3a1444d).
 *
 * La copie doit avoir l'air d'avoir été reçue directement : expéditeur, en-tête
 * Date, arbre MIME et pièces jointes d'origine, drapeaux et date de réception
 * conservés — tout ce qu'un transfert détruit. Elle reprend donc les étapes 1
 * à 3 de la saga de `cross_account_move` (lecture de la source brute,
 * dédoublonnage par Message-ID, APPEND) et s'arrête là :
 *
 *   - la source n'est JAMAIS modifiée : lecture seule (EXAMINE côté IMAP),
 *     pas de corbeille, pas de \Deleted, pas d'EXPUNGE ;
 *   - pas de mot-clé $Routed : une copie n'est pas un routage ;
 *   - journal Postgres facultatif : « pas de journal, pas de déplacement » est
 *     la bonne règle pour une opération qui détruit l'original, pas pour une
 *     qui ne détruit rien. Sans `[database].url`, base injoignable ou schéma
 *     non migré, la copie réussit avec un avertissement `audit_log_skipped`.
 *
 * Deux backends, par compte (voir mail-router.ts) :
 *   - source IMAP : FETCH du source RFC822, des drapeaux et de l'INTERNALDATE ;
 *   - source Graph : `GET /me/messages/{id}/$value` (MIME brut) par le routeur,
 *     plus lu / suivi / date de réception lus sur le message ;
 *   - destination IMAP : APPEND avec drapeaux et date ;
 *   - destination Graph : REFUSÉE explicitement. Graph n'importe un MIME brut
 *     que par `POST /me/messages` (Content-Type text/plain, base64), et le
 *     message créé est un BROUILLON (`isDraft: true`, date de réception = date
 *     d'import, documenté par Microsoft) ; `POST /me/mailFolders/{id}/messages`
 *     n'accepte que du JSON. La copie ne ressemblerait pas à un message reçu.
 *
 * Lecture d'une source Graph, dédoublonnage + APPEND et refus d'une
 * destination Graph sont partagés avec CrossAccountMover
 * (cross-account-transfer.ts) : les deux outils ne peuvent pas diverger.
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
import type { ErrorKind, MoveWarning } from './error-kinds.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';
import type { MoveLogEntry, MoveLogRepository } from './log-repository.js';

export interface CopyArgs {
  sourceAccount: string;
  sourceMailbox: string;
  /** UID IMAP, ou id Graph opaque pour un compte Graph. */
  emailId: string;
  destAccount: string;
  destMailbox: string;
}

export type CopyResult =
  | {
      success: true;
      status: 'success' | 'duplicate_skipped';
      source_account: string;
      source_mailbox: string;
      /** UID IMAP ou id Graph de la source, tel que fourni. */
      source_id: string;
      dest_account: string;
      dest_mailbox: string;
      dest_uid: number | null;
      message_id: string | null;
      subject: string | null;
      from: string | null;
      size_bytes: number | null;
      /** Toujours null : une copie ne touche jamais la source. */
      source_cleanup: null;
      /** Id de la ligne email_move_log quand le journal a pu être écrit, sinon null. */
      copy_log_id: number | null;
      warnings: MoveWarning[];
    }
  | {
      success: false;
      error_kind: string;
      error_message: string;
      source_account: string;
      source_mailbox: string;
      source_id: string;
    };

export class CrossAccountCopier {
  constructor(
    private readonly connections: ConnectionManager,
    /** Routeur IMAP / Graph : sert à lire une source Graph. */
    private readonly mailService: IMailService,
    private readonly isGraphAccount: (name: string) => boolean,
    private readonly logRepo: MoveLogRepository,
  ) {}

  async copyMany(argsList: CopyArgs[]): Promise<CopyResult[]> {
    // Séquentiel (limites de connexions IMAP), un résultat par élément : un
    // échec n'interrompt pas le lot — même posture que moveMany.
    return argsList.reduce<Promise<CopyResult[]>>(async (accP, args) => {
      const acc = await accP;
      acc.push(await this.copyOne(args));
      return acc;
    }, Promise.resolve([]));
  }

  async copyOne(args: CopyArgs): Promise<CopyResult> {
    const { sourceAccount, sourceMailbox, emailId, destAccount, destMailbox } = args;
    const fail = (kind: string, message: string): CopyResult => ({
      success: false,
      error_kind: kind,
      error_message: message,
      source_account: sourceAccount,
      source_mailbox: sourceMailbox,
      source_id: emailId,
    });

    const invalid = this.validateArgs(args);
    if (invalid) return fail(invalid.kind, invalid.message);

    const warnings: MoveWarning[] = [];
    try {
      // 1. Lecture de la source, sans jamais la modifier.
      const src = this.isGraphAccount(sourceAccount)
        ? await readGraphSource(this.mailService, sourceAccount, sourceMailbox, emailId)
        : await this.readImapSource(sourceAccount, sourceMailbox, Number(emailId));

      // 2-3. Dédoublonnage par Message-ID puis APPEND sur la destination.
      const { destUid, dedupHit } = await appendAtDestination(
        this.connections,
        destAccount,
        destMailbox,
        src,
      );

      // Journal facultatif : n'échoue jamais, ne bloque jamais la copie.
      const status: 'success' | 'duplicate_skipped' = dedupHit ? 'duplicate_skipped' : 'success';
      const numericSource = Number(emailId);
      const copyLogId = await this.recordCopy(
        {
          source_account: sourceAccount,
          source_mailbox: sourceMailbox,
          // La colonne est un BIGINT : une source Graph (id opaque) y est
          // inscrite 0 et s'identifie par son Message-ID.
          source_uid: Number.isSafeInteger(numericSource) ? numericSource : 0,
          dest_account: destAccount,
          dest_mailbox: destMailbox,
          dest_uid: destUid,
          message_id: src.messageId,
          subject: src.subject,
          from_addr: src.from,
          email_date: null,
          size_bytes: src.raw.length,
          status,
          manual: true,
        },
        warnings,
      );

      return {
        success: true,
        status,
        source_account: sourceAccount,
        source_mailbox: sourceMailbox,
        source_id: emailId,
        dest_account: destAccount,
        dest_mailbox: destMailbox,
        dest_uid: destUid,
        message_id: src.messageId,
        subject: src.subject,
        from: src.from,
        size_bytes: src.raw.length,
        source_cleanup: null,
        copy_log_id: copyLogId,
        warnings,
      };
    } catch (err) {
      if (err instanceof MoveError) return fail(err.kind, err.message);
      return fail(
        ERROR_KIND.CONNECTION_ERROR,
        `cross-account copy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Contrôles d'entrée, sans aucun appel réseau. */
  private validateArgs(args: CopyArgs): { kind: ErrorKind; message: string } | null {
    const { sourceAccount, emailId, destAccount } = args;
    const accounts = new Set(this.connections.getAccountNames());
    if (!accounts.has(sourceAccount)) {
      return {
        kind: ERROR_KIND.SOURCE_NOT_FOUND,
        message: `source account "${sourceAccount}" not configured`,
      };
    }
    if (!accounts.has(destAccount)) {
      return {
        kind: ERROR_KIND.DEST_ACCOUNT_INVALID,
        message: `destination account "${destAccount}" not configured`,
      };
    }
    if (sourceAccount === destAccount) {
      return {
        kind: ERROR_KIND.SAME_ACCOUNT_COPY,
        message: 'source and destination are the same account — use copy_email instead',
      };
    }
    if (this.isGraphAccount(destAccount)) {
      return graphDestinationRefusal(destAccount, 'copy');
    }
    return emailIdError(emailId, this.isGraphAccount(sourceAccount));
  }

  /**
   * Source IMAP, ouverte en LECTURE SEULE (EXAMINE) : même un FETCH du corps
   * ne peut alors pas poser \Seen sur l'original.
   */
  private async readImapSource(
    account: string,
    mailbox: string,
    uid: number,
  ): Promise<SourceMessage> {
    const client = await this.connections.getImapClient(account);
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, source: true, flags: true, envelope: true, internalDate: true },
        { uid: true },
      );
      // biome-ignore lint/complexity/useOptionalChain: optional chain breaks TS type narrowing for union with false
      if (!msg || !msg.source) {
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
      };
    } finally {
      lock.release();
    }
  }

  /** Journal facultatif : toute erreur devient un avertissement `audit_log_skipped`. */
  private async recordCopy(entry: MoveLogEntry, warnings: MoveWarning[]): Promise<number | null> {
    try {
      return await this.logRepo.logCopy(entry);
    } catch (err) {
      warnings.push({
        kind: WARNING_KIND.AUDIT_LOG_SKIPPED,
        message: `copy completed but was not audit-logged: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
  }
}
