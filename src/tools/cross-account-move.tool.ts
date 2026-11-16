/**
 * MCP tool: cross_account_move
 *
 * Moves a message between two *different* configured accounts, preserving the
 * raw RFC822 (headers, MIME, attachments), flags, and INTERNALDATE. Mechanism
 * (D18): FETCH source → APPEND dest → audit-log → UID MOVE source into the
 * source account's Trash (capability-gated, fail-closed). With a database
 * configured, the audit log is part of the move contract — a move that cannot
 * be logged does not happen (D-Premise-2 / D20). Sans `[database].url`, le
 * déplacement se fait sans journal (avertissement audit_log_skipped).
 *
 * Source IMAP ou Graph (lecture `/$value`, nettoyage vers Éléments supprimés) ;
 * destination IMAP seulement — une destination Graph est refusée avant de
 * toucher la source (voir cross-account-mover.ts).
 *
 * Registered only when settings.read_only is false (D17 — the read-only gate is
 * registration, not a runtime error). For same-account moves use move_email.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type { MoveResult } from '../routing/cross-account-mover.js';
import { CrossAccountMover } from '../routing/cross-account-mover.js';
import { MoveLogRepository } from '../routing/log-repository.js';
import audit from '../safety/audit.js';
import { sanitizeMailboxName } from '../safety/validation.js';
import type { IMailService } from '../services/mail-service.types.js';
import type { AppConfig } from '../types/index.js';

function summarize(results: MoveResult[]): string {
  const ok = results.filter((r) => r.success).length;
  const dup = results.filter((r) => r.success && r.status === 'duplicate_skipped').length;
  const failed = results.length - ok;
  // Déposé à destination mais source conservée : dit en clair, jamais « Moved. ».
  const kept = results.filter((r) => r.success && r.source_cleanup_error).length;
  // UID pour une source IMAP, id opaque pour une source Graph.
  const label = (r: MoveResult): string =>
    r.source_uid !== null ? `uid ${r.source_uid}` : r.source_id;
  const lines = results.map((r) => {
    if (r.success) {
      const keptNote = r.source_cleanup_error
        ? ` — SOURCE KEPT (${r.source_cleanup_error.kind}: ${r.source_cleanup_error.message})`
        : '';
      return `  ✅ ${label(r)} → ${r.dest_account}/${r.dest_mailbox} (${r.status}, dest_uid ${r.dest_uid ?? '?'}, source ${r.source_cleanup}, ${r.move_log_id === undefined ? 'not journaled' : `log #${r.move_log_id}`})${r.warnings.length ? ` ⚠️ ${r.warnings.map((w) => w.kind).join(',')}` : ''}${keptNote}`;
    }
    return `  ❌ ${label(r)} — ${r.error_kind}: ${r.error_message}`;
  });
  let header: string;
  if (results.length === 1) {
    const r = results[0];
    if (!r.success) {
      header = 'Move failed.';
    } else if (r.source_cleanup_error) {
      header =
        r.status === 'duplicate_skipped'
          ? 'Already present at the destination, but the source was NOT removed.'
          : 'Copied to the destination, but the source was NOT removed.';
    } else if (r.status === 'duplicate_skipped') {
      header = 'Already present (deduped).';
    } else {
      header = 'Moved.';
    }
  } else {
    header =
      `Moved ${ok}/${results.length} (${dup} deduped, ${failed} failed` +
      `${kept ? `, ${kept} with the source NOT removed` : ''}).`;
  }
  return `${header}\n${lines.join('\n')}\n\n${JSON.stringify(results, null, 2)}`;
}

export default function registerCrossAccountMoveTool(
  server: McpServer,
  connections: ConnectionManager,
  config: AppConfig,
  mailService: IMailService,
): void {
  // One repo (lazy Postgres pool) reused across calls.
  const logRepo = new MoveLogRepository(config.database?.url);
  const isGraphAccount = (name: string): boolean =>
    config.accounts.find((account) => account.name === name)?.backend === 'graph';
  const mover = new CrossAccountMover(connections, mailService, isGraphAccount, logRepo);

  server.registerTool(
    'cross_account_move',
    {
      description:
        'Move an email between two DIFFERENT configured accounts, preserving raw ' +
        'headers, flags, and original date (the message looks natively delivered ' +
        'at the destination). The source may be an IMAP or a Microsoft Graph (Exchange) ' +
        'account; the destination must be an IMAP account — a Graph destination is refused ' +
        'before the source is read or touched, because Graph can only import a raw message ' +
        'as a draft dated at import time. Only after the message is verified at the ' +
        "destination is the source moved to its account's Trash (IMAP: UID MOVE to \\Trash; " +
        'Graph: Deleted Items, never a permanent delete). If that cleanup fails, the result ' +
        'says so (source_cleanup_error, warning source_not_removed): the message is at the ' +
        'destination and the source is still in place. For moves within ONE account use ' +
        'move_email instead. With a Postgres database configured ([database].url) every move ' +
        'is audit-logged and a move that cannot be logged does not happen (its destination ' +
        'copy is removed); without one the move still runs, unjournaled (warning ' +
        'audit_log_skipped), duplicates being prevented by the Message-ID check.',
      inputSchema: z.object({
        sourceAccount: z.string().describe('Source account name (from list_accounts)'),
        sourceMailbox: z.string().describe('Source mailbox, e.g. INBOX'),
        emailId: z
          .union([z.string(), z.array(z.string())])
          .describe(
            'Source id — an IMAP UID, or the opaque message id of a Graph account — or an ' +
              'array of ids for a bulk move (sequential)',
          ),
        destAccount: z.string().describe('Destination account name (must differ from source)'),
        destMailbox: z.string().default('INBOX').describe('Destination mailbox (default INBOX)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ sourceAccount, sourceMailbox, emailId, destAccount, destMailbox }) => {
      const cleanSource = sanitizeMailboxName(sourceMailbox);
      const cleanDest = sanitizeMailboxName(destMailbox);
      const ids = Array.isArray(emailId) ? emailId : [emailId];
      try {
        const results = await mover.moveMany(
          ids.map((id) => ({
            sourceAccount,
            sourceMailbox: cleanSource,
            emailId: id,
            destAccount,
            destMailbox: cleanDest,
          })),
        );
        const anyFailed = results.some((r) => !r.success);
        await audit.log(
          'cross_account_move',
          sourceAccount,
          { sourceMailbox, emailId, destAccount, destMailbox },
          anyFailed ? 'error' : 'ok',
          anyFailed ? results.find((r) => !r.success)?.error_message : undefined,
        );
        const text = summarize(results);
        // Single-string input → single result object; array → array (the JSON
        // block in `text` carries the full structured result either way).
        return {
          ...(anyFailed ? { isError: true } : {}),
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'cross_account_move',
          sourceAccount,
          { sourceMailbox, emailId, destAccount, destMailbox },
          'error',
          msg,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `cross_account_move failed: ${msg}` }],
        };
      }
    },
  );
}
