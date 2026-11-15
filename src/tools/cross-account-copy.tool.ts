/**
 * MCP tool: cross_account_copy
 *
 * Dépose une COPIE d'un message dans un AUTRE compte configuré, en conservant
 * le RFC822 brut (en-têtes, MIME, pièces jointes), les drapeaux et la date de
 * réception : la copie apparaît reçue de l'expéditeur d'ORIGINE à sa date
 * d'ORIGINE, ce qu'un transfert détruit. La source n'est jamais modifiée.
 *
 * Source IMAP ou Graph ; destination IMAP seulement — une destination Graph est
 * refusée explicitement (voir cross-account-copier.ts). Pas de Postgres requis :
 * le journal est écrit quand `[database].url` est configuré, sinon la copie
 * réussit avec un avertissement `audit_log_skipped`.
 *
 * Enregistré seulement hors lecture seule (D17). Pour une copie dans UN compte,
 * utiliser copy_email.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type { CopyResult } from '../routing/cross-account-copier.js';
import { CrossAccountCopier } from '../routing/cross-account-copier.js';
import { MoveLogRepository } from '../routing/log-repository.js';
import audit from '../safety/audit.js';
import { sanitizeMailboxName } from '../safety/validation.js';
import type { IMailService } from '../services/mail-service.types.js';
import type { AppConfig } from '../types/index.js';

function summarize(results: CopyResult[]): string {
  const ok = results.filter((r) => r.success).length;
  const dup = results.filter((r) => r.success && r.status === 'duplicate_skipped').length;
  const failed = results.length - ok;
  const lines = results.map((r) => {
    if (r.success) {
      const log = r.copy_log_id === null ? '' : `, log #${r.copy_log_id}`;
      const warn = r.warnings.length ? ` ⚠️ ${r.warnings.map((w) => w.kind).join(',')}` : '';
      return `  ✅ ${r.source_id} → ${r.dest_account}/${r.dest_mailbox} (${r.status}, dest_uid ${r.dest_uid ?? '?'}, source untouched${log})${warn}`;
    }
    return `  ❌ ${r.source_id} — ${r.error_kind}: ${r.error_message}`;
  });
  let header: string;
  if (results.length === 1) {
    const [r] = results;
    if (!r.success) {
      header = 'Copy failed.';
    } else if (r.status === 'duplicate_skipped') {
      header = 'Already present at the destination (deduped by Message-ID).';
    } else {
      header = 'Copied.';
    }
  } else {
    header = `Copied ${ok}/${results.length} (${dup} deduped, ${failed} failed).`;
  }
  return `${header}\n${lines.join('\n')}\n\n${JSON.stringify(results, null, 2)}`;
}

export default function registerCrossAccountCopyTool(
  server: McpServer,
  connections: ConnectionManager,
  config: AppConfig,
  mailService: IMailService,
): void {
  // Un dépôt (pool Postgres paresseux) partagé entre les appels. Une URL
  // absente convient : le journal d'une copie est facultatif.
  const logRepo = new MoveLogRepository(config.database?.url);
  const isGraphAccount = (name: string): boolean =>
    config.accounts.find((account) => account.name === name)?.backend === 'graph';
  const copier = new CrossAccountCopier(connections, mailService, isGraphAccount, logRepo);

  server.registerTool(
    'cross_account_copy',
    {
      description:
        'Put a COPY of an email into a DIFFERENT configured account, preserving raw headers, MIME ' +
        'structure, attachments, flags and the original date — the copy looks natively delivered ' +
        'from the ORIGINAL sender, unlike a forward. The source is NEVER touched (no Trash, no ' +
        'delete). Messages already present at the destination are skipped by Message-ID. The ' +
        'source may be an IMAP or a Microsoft Graph (Exchange) account; the destination must be an ' +
        'IMAP account — a Graph destination is refused, because Graph can only import a raw ' +
        'message as a draft. For copies within ONE account use copy_email. No database required ' +
        '(the copy is audit-logged when [database] is configured).',
      inputSchema: z.object({
        sourceAccount: z.string().describe('Source account name (from list_accounts)'),
        sourceMailbox: z.string().describe('Source mailbox, e.g. INBOX'),
        emailId: z
          .union([z.string(), z.array(z.string())])
          .describe(
            'Source email ID (IMAP UID, or Graph id on an Exchange account), or an array of IDs ' +
              'for a bulk copy (sequential)',
          ),
        destAccount: z
          .string()
          .describe('Destination account name (must differ from source, must be IMAP)'),
        destMailbox: z.string().default('INBOX').describe('Destination mailbox (default INBOX)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ sourceAccount, sourceMailbox, emailId, destAccount, destMailbox }) => {
      const auditParams = { sourceMailbox, emailId, destAccount, destMailbox };
      try {
        const cleanSource = sanitizeMailboxName(sourceMailbox);
        const cleanDest = sanitizeMailboxName(destMailbox);
        const ids = Array.isArray(emailId) ? emailId : [emailId];
        const results = await copier.copyMany(
          ids.map((id) => ({
            sourceAccount,
            sourceMailbox: cleanSource,
            emailId: id,
            destAccount,
            destMailbox: cleanDest,
          })),
        );
        const firstFailure = results.find((r) => !r.success);
        await audit.log(
          'cross_account_copy',
          sourceAccount,
          auditParams,
          firstFailure ? 'error' : 'ok',
          firstFailure && !firstFailure.success ? firstFailure.error_message : undefined,
        );
        return {
          ...(firstFailure ? { isError: true } : {}),
          content: [{ type: 'text' as const, text: summarize(results) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await audit.log('cross_account_copy', sourceAccount, auditParams, 'error', msg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `cross_account_copy failed: ${msg}` }],
        };
      }
    },
  );
}
