/**
 * MCP tools: send_email, reply_email, forward_email
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { validateInputLength } from '../safety/validation.js';

import type { IMailService } from '../services/mail-service.types.js';
import SendGuard, { sendFingerprint } from '../services/send-guard.js';
import type { ISendService } from '../services/send-service.types.js';
import { adaptAttachmentInput, attachmentInputSchema } from './attachment-input.js';
import { runGuardedSend, sendGuardParams } from './send-guard-params.js';
import describeSendOutcome from './send-outcome.js';

export default function registerSendTools(
  server: McpServer,
  smtpService: ISendService,
  imapService: IMailService,
  // Garde anti-doublon partagée ; désactivée quand rien n'est fourni (tests).
  sendGuard: SendGuard = new SendGuard({ windowMinutes: 0 }),
): void {
  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'send_email',
    {
      description:
        'Send a new email. Supports plain text or HTML body, CC, BCC, and attachments ' +
        '(from a local path, inline base64 bytes, or a reference to an attachment on an existing message). ' +
        'HTML mail also carries a generated plain-text alternative. The whole message, attachments ' +
        'encoded, must fit the size limit: on SMTP the limit the server announces (SIZE), or ' +
        'max_message_mb when set in the account config; on Graph 35 MB by default (Exchange Online), ' +
        'or max_message_mb. An oversized message is refused before anything is sent. ' +
        'Duplicate protection: an identical message sent from the same account in the last ' +
        'duplicate_send_window_minutes (default 10) is refused as a probable retry (pass ' +
        'allow_duplicate: true for a deliberate second copy); idempotency_key makes a retry return ' +
        'the first result instead of sending again.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        attachments: z
          .array(attachmentInputSchema)
          .optional()
          .describe(
            'Attachments to include. Each entry is one of: ' +
              '{ path }: read bytes from a local file (use absolute path); ' +
              '{ content_base64, filename }: provide bytes inline; ' +
              '{ source_email_id, source_mailbox, filename }: carry an attachment from another message ' +
              'without round-tripping bytes through this MCP. Strict failure: if any attachment cannot ' +
              'be resolved, the email is NOT sent.',
          ),
        append_signature: z
          .boolean()
          .optional()
          .describe(
            "Append the account's configured signature (signature_path) below the body, with its " +
              'logo/images embedded inline (cid). Forces HTML. Defaults to the account signature_default; pass false to disable.',
          ),
        ...sendGuardParams,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        validateInputLength(params.subject, 998, 'Subject');
        validateInputLength(params.body, 5_000_000, 'Body');

        // Resolve attachments BEFORE sending — strict failure means a bad
        // attachment aborts the whole send rather than mailing a partial.
        const resolvedAttachments =
          params.attachments && params.attachments.length > 0
            ? await imapService.resolveAttachmentsForSend(
                params.account,
                params.attachments.map(adaptAttachmentInput),
              )
            : undefined;

        const guarded = await runGuardedSend(
          sendGuard,
          {
            account: params.account,
            tool: 'send_email',
            wording: { what: 'email' },
            idempotencyKey: params.idempotency_key,
            allowDuplicate: params.allow_duplicate,
            // Empreinte calculée APRÈS résolution des pièces : leurs octets comptent.
            fingerprint: sendFingerprint({
              kind: 'send',
              account: params.account,
              to: params.to,
              cc: params.cc,
              bcc: params.bcc,
              subject: params.subject,
              body: params.body,
              html: params.html,
              attachments: resolvedAttachments,
            }),
          },
          async () =>
            smtpService.sendEmail(params.account, {
              to: params.to,
              subject: params.subject,
              body: params.body,
              cc: params.cc,
              bcc: params.bcc,
              html: params.html,
              attachments: resolvedAttachments,
              appendSignature: params.append_signature,
            }),
          (r) => r.messageId,
        );
        if ('stop' in guarded) return guarded.stop;
        const { result } = guarded;
        await audit.log(
          'send_email',
          params.account,
          {
            to: params.to,
            subject: params.subject,
            attachmentCount: params.attachments?.length ?? 0,
          },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent successfully!\nTo: ${params.to.join(', ')}\nSubject: ${params.subject}\nMessage-ID: ${result.messageId}${describeSendOutcome(result)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'reply_email',
    {
      description:
        'Reply to an email with proper threading (In-Reply-To & References headers). Use get_email first to read the original. ' +
        'Recipients follow mail clients and RFC 5322: the reply goes to the Reply-To address(es) when the ' +
        'original has one, otherwise to the sender; with replyAll, the original To and Cc are added, minus ' +
        "this account's own address (same behaviour on IMAP and Graph accounts). " +
        'The original message is quoted below the reply by default (attribution line + quoted text: ' +
        '"Le DATE, NAME a écrit :" in French by default, "On DATE, NAME wrote:" with reply_language = "en"; ' +
        'on Graph accounts Exchange writes its own header in the mailbox language), ' +
        'as desktop clients do — set quoteOriginal=false to send the bare body only. ' +
        'Sends immediately: to review the reply before it goes out, use reply_draft instead. ' +
        'With includeAttachments, every attachment of the original is fetched by its partId — two ' +
        'attachments with the same name are both carried, the second renamed "name (2).ext". ' +
        'Duplicate protection: an identical message sent from the same account in the last ' +
        'duplicate_send_window_minutes (default 10) is refused as a probable retry (pass ' +
        'allow_duplicate: true for a deliberate second copy); idempotency_key makes a retry return ' +
        'the first result instead of sending again.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID to reply to (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        body: z.string().describe('Reply body content'),
        replyAll: z
          .boolean()
          .default(false)
          .describe('Reply to all: Reply-To (or sender) + original To and Cc, minus yourself'),
        html: z.boolean().default(false).describe('Send as HTML'),
        includeAttachments: z
          .boolean()
          .default(false)
          .describe(
            'Re-attach attachments from the original email to this reply. Strict: if one cannot be ' +
              'fetched (or exceeds 25 MB), nothing is sent and the error names it.',
          ),
        quoteOriginal: z
          .boolean()
          .default(true)
          .describe(
            'Quote the original message below the reply (default true). In an HTML reply the original ' +
              'is quoted as escaped text inside <blockquote type="cite">. Set false for the bare body only.',
          ),
        appendSignature: z
          .boolean()
          .optional()
          .describe(
            "Append the account's configured signature (signature_path) below the reply, with its " +
              'logo/images embedded inline (cid). Forces HTML. Defaults to the account signature_default; pass false to disable.',
          ),
        ...sendGuardParams,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const guarded = await runGuardedSend(
          sendGuard,
          {
            account: params.account,
            tool: 'reply_email',
            wording: { what: 'reply' },
            idempotencyKey: params.idempotency_key,
            allowDuplicate: params.allow_duplicate,
            // Les destinataires d'une réponse découlent de l'original : c'est
            // lui (emailId + dossier) et les options qui la définissent.
            fingerprint: sendFingerprint({
              kind: 'reply',
              account: params.account,
              emailId: params.emailId,
              mailbox: params.mailbox,
              body: params.body,
              html: params.html,
              options: {
                replyAll: params.replyAll,
                includeAttachments: params.includeAttachments,
                quoteOriginal: params.quoteOriginal,
              },
            }),
          },
          async () =>
            smtpService.replyToEmail(params.account, {
              emailId: params.emailId,
              mailbox: params.mailbox,
              body: params.body,
              replyAll: params.replyAll,
              html: params.html,
              includeAttachments: params.includeAttachments,
              quoteOriginal: params.quoteOriginal,
              appendSignature: params.appendSignature,
            }),
          (r) => r.messageId,
        );
        if ('stop' in guarded) return guarded.stop;
        const { result } = guarded;
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Reply sent successfully!\nMessage-ID: ${result.messageId}${describeSendOutcome(result)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to reply: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'forward_email',
    {
      description:
        'Forward an email to new recipients with optional additional message. The original is included ' +
        'below (as readable text; an HTML original is converted, not pasted as markup) and its ' +
        'attachments are carried across by default. Strict failure: if an attachment cannot be fetched, ' +
        'nothing is sent (use includeAttachments=false to forward the body alone). Attachments are ' +
        'fetched by partId: two with the same name are both carried, the second renamed ' +
        '"name (2).ext" (on Graph accounts Exchange forwards the originals natively, names unchanged). ' +
        'Duplicate protection: an identical message sent from the same account in the last ' +
        'duplicate_send_window_minutes (default 10) is refused as a probable retry (pass ' +
        'allow_duplicate: true for a deliberate second copy); idempotency_key makes a retry return ' +
        'the first result instead of sending again.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID to forward (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        to: z.array(z.string().email()).min(1).describe('Forward to these recipients'),
        body: z.string().optional().describe('Additional message above the forwarded content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        includeAttachments: z
          .boolean()
          .default(true)
          .describe(
            "Carry the original email's attachments into the forward (default true). Set false for a body-only forward.",
          ),
        html: z
          .boolean()
          .default(false)
          .describe(
            'Also send an HTML part carrying the original HTML (default false: text only, the original ' +
              'converted to readable text). On Graph accounts the server builds the forward and the ' +
              'original always keeps its own format.',
          ),
        appendSignature: z
          .boolean()
          .optional()
          .describe(
            "Append the account's configured signature (signature_path) with its logo/images " +
              'embedded inline (cid). Forces HTML. Defaults to the account signature_default.',
          ),
        ...sendGuardParams,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const guarded = await runGuardedSend(
          sendGuard,
          {
            account: params.account,
            tool: 'forward_email',
            wording: { what: 'forward' },
            idempotencyKey: params.idempotency_key,
            allowDuplicate: params.allow_duplicate,
            fingerprint: sendFingerprint({
              kind: 'forward',
              account: params.account,
              emailId: params.emailId,
              mailbox: params.mailbox,
              to: params.to,
              cc: params.cc,
              body: params.body,
              html: params.html,
              options: { includeAttachments: params.includeAttachments },
            }),
          },
          async () =>
            smtpService.forwardEmail(params.account, {
              emailId: params.emailId,
              mailbox: params.mailbox,
              to: params.to,
              body: params.body,
              cc: params.cc,
              includeAttachments: params.includeAttachments,
              html: params.html,
              appendSignature: params.appendSignature,
            }),
          (r) => r.messageId,
        );
        if ('stop' in guarded) return guarded.stop;
        const { result } = guarded;
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email forwarded successfully!\nTo: ${params.to.join(', ')}\nMessage-ID: ${result.messageId}${!params.includeAttachments ? '\n(original attachments not included)' : ''}${describeSendOutcome(result)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to forward: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
