/**
 * MCP tools: save_draft, reply_draft, send_draft, update_draft
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { validateInputLength } from '../safety/validation.js';

import type { IMailService } from '../services/mail-service.types.js';
import type { ISendService } from '../services/send-service.types.js';
import { adaptAttachmentInput, attachmentInputSchema } from './attachment-input.js';
import describeSendOutcome from './send-outcome.js';

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function registerDraftTools(
  server: McpServer,
  imapService: IMailService,
  smtpService: ISendService,
): void {
  // ---------------------------------------------------------------------------
  // save_draft
  // ---------------------------------------------------------------------------
  server.registerTool(
    'save_draft',
    {
      description:
        'Save an email draft to the Drafts folder. Compose over time, then use send_draft to send it. ' +
        'Supports attachments from a local path, inline base64 bytes, or references to attachments on ' +
        'an existing message (server-side carry — bytes do not traverse the MCP wire). ' +
        'Use list_emails with the Drafts mailbox to see saved drafts.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        to: z
          .array(z.string().email())
          .default([])
          .describe('Recipient email addresses (can be empty for drafts)'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        in_reply_to: z.string().optional().describe('Message-ID for threading (from get_email)'),
        attachments: z
          .array(attachmentInputSchema)
          .optional()
          .describe(
            'Attachments to include. Each entry is one of: ' +
              '{ path }: read bytes from a local file (use absolute path); ' +
              '{ content_base64, filename }: provide bytes inline; ' +
              '{ source_email_id, source_mailbox, filename }: carry an attachment from another message ' +
              'without round-tripping bytes through this MCP. Strict failure: if any attachment cannot ' +
              'be resolved, no draft is saved.',
          ),
        append_signature: z
          .boolean()
          .optional()
          .describe(
            "Append the account's configured signature (signature_path) below the body, with its " +
              'logo/images embedded inline (cid). Forces HTML. Defaults to the account signature_default; pass false to disable.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      account,
      to,
      subject,
      body,
      cc,
      bcc,
      html,
      in_reply_to: inReplyTo,
      attachments,
      append_signature: appendSignature,
    }) => {
      try {
        const result = await imapService.saveDraftWithAttachments(account, {
          to,
          subject,
          body,
          cc,
          bcc,
          html,
          inReplyTo,
          attachments: attachments?.map(adaptAttachmentInput),
          appendSignature,
        });

        await audit.log(
          'save_draft',
          account,
          { to, subject, attachmentCount: attachments?.length ?? 0 },
          'ok',
        );

        const attachSummary =
          attachments && attachments.length > 0 ? `, ${attachments.length} attachment(s)` : '';

        return {
          content: [
            {
              type: 'text' as const,
              text: `📝 Draft saved (ID: ${result.id}, folder: ${result.mailbox}${attachSummary}).${
                'warning' in result && result.warning ? `\n⚠️ ${result.warning}` : ''
              }`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('save_draft', account, { to, subject }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to save draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_draft
  // ---------------------------------------------------------------------------
  server.registerTool(
    'reply_draft',
    {
      description:
        'Save a threaded REPLY to an email in the Drafts folder WITHOUT sending it — the review-first ' +
        'counterpart of reply_email. The draft is built like reply_email builds a reply: "Re:" subject, ' +
        'recipients (the Reply-To address(es) when the original has one, otherwise the sender; with replyAll ' +
        'also the original To/Cc minus yourself), In-Reply-To and ' +
        'References so it joins the conversation, the original quoted below by default and the account ' +
        'signature when configured. Nothing is sent. Returns the draft id to pass to send_draft (to send ' +
        'it) or update_draft (to rewrite it). On Graph-backed (Exchange) accounts the draft comes from ' +
        "Exchange's own createReply / createReplyAll, which writes the quote header in the mailbox " +
        'language (reply_language does not apply there).',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID to reply to (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        body: z.string().describe('Reply body content'),
        html: z.boolean().default(false).describe('Body is HTML (default: plain text)'),
        replyAll: z
          .boolean()
          .default(false)
          .describe('Address the draft to all recipients of the original (minus yourself)'),
        quoteOriginal: z
          .boolean()
          .default(true)
          .describe(
            'Quote the original message below the reply (default true). Set false for the bare body only.',
          ),
        includeAttachments: z
          .boolean()
          .default(false)
          .describe(
            'Copy the attachments of the original into the draft. Strict: if one cannot be fetched ' +
              '(or exceeds 25 MB), no draft is saved and the error names it.',
          ),
        attachments: z
          .array(attachmentInputSchema)
          .optional()
          .describe(
            'Extra attachments, same shape as save_draft.attachments ({ path } / { content_base64, ' +
              'filename } / { source_email_id, source_mailbox, filename }). Strict: if any cannot be ' +
              'resolved, no draft is saved.',
          ),
        bcc: z
          .array(z.string().email())
          .optional()
          .describe('Blind recipients, kept on the draft until it is sent'),
        appendSignature: z
          .boolean()
          .optional()
          .describe(
            "Append the account's configured signature (signature_path) below the reply. Forces HTML. " +
              'Defaults to the account signature_default; pass false to disable.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (params) => {
      const auditParams = {
        emailId: params.emailId,
        mailbox: params.mailbox,
        replyAll: params.replyAll,
        attachmentCount: params.attachments?.length ?? 0,
      };
      try {
        validateInputLength(params.body, 5_000_000, 'Body');
        // Pièces résolues AVANT la création du brouillon : un échec ne laisse
        // rien dans Brouillons.
        const extra =
          params.attachments && params.attachments.length > 0
            ? await imapService.resolveAttachmentsForSend(
                params.account,
                params.attachments.map(adaptAttachmentInput),
              )
            : undefined;

        const result = await smtpService.saveReplyDraft(params.account, {
          emailId: params.emailId,
          mailbox: params.mailbox,
          body: params.body,
          html: params.html,
          replyAll: params.replyAll,
          quoteOriginal: params.quoteOriginal,
          includeAttachments: params.includeAttachments,
          attachments: extra,
          bcc: params.bcc,
          appendSignature: params.appendSignature,
        });

        await audit.log('reply_draft', params.account, auditParams, 'ok');

        const warningBlock =
          result.warnings.length > 0 ? `\n⚠️ ${result.warnings.join('\n⚠️ ')}` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `📝 Reply saved as a draft — NOT sent (ID: ${result.id}, folder: ${result.mailbox}). ` +
                `Send it with send_draft, or rewrite it with update_draft.${warningBlock}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('reply_draft', params.account, auditParams, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to save reply draft: ${errMsg}` }],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------------
  server.registerTool(
    'send_draft',
    {
      description:
        'Send an existing draft email and remove it from Drafts. The draft is fetched, sent via SMTP, then deleted. ' +
        'Once the message is sent, the result never reports a failure: if filing the Sent copy failed the draft ' +
        'is kept, and if deleting the draft failed a warning says so — in both cases the message WAS sent, do not ' +
        'resend it. Use list_emails with the Drafts mailbox to find draft IDs.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        id: z
          .union([z.number().int(), z.string()])
          .describe(
            'Draft id from list_emails on the Drafts mailbox: a numeric UID on IMAP accounts, an ' +
              'opaque string id on Graph-backed (Exchange) accounts.',
          ),
        mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ account, id, mailbox }) => {
      try {
        const result = await smtpService.sendDraft(account, id, mailbox);

        await audit.log('send_draft', account, { id, mailbox }, 'ok');

        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Draft sent (Message-ID: ${result.messageId}).${
                // Graph ne détaille pas l'issue : son envoi déplace lui-même le brouillon dans Envoyés.
                result.draftCleanup === undefined ? ' Draft removed from folder.' : ''
              }${describeSendOutcome(result)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('send_draft', account, { id, mailbox }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // update_draft
  // ---------------------------------------------------------------------------
  server.registerTool(
    'update_draft',
    {
      description:
        'Replace an existing draft with new content while preserving (or modifying) its attachments. ' +
        'Use this to rewrite a draft body without losing attached files, or to carry attachments from ' +
        'another message into a draft. IMAP has no in-place edit, so the implementation APPENDs a new ' +
        'copy first, then deletes the old UID only after the APPEND succeeds. If anything fails before ' +
        'APPEND, the old draft is left intact. Returns the NEW draft UID. ' +
        'Omitted fields (subject, body, recipients) keep the existing draft values. ' +
        'attachments_keep defaults to ALL existing attachments; pass [] to drop them all. ' +
        'Never adds the account signature implicitly (signature_default does not apply here): a new ' +
        'body replaces the old one as given, and an omitted body is kept as is — with its signature ' +
        'and inline (cid) images if it had them. Pass append_signature: true with a new body to ' +
        'sign it.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        draft_id: z
          .union([z.number().int(), z.string()])
          .describe(
            'Id of the existing draft: a numeric UID on IMAP accounts, an opaque string id on ' +
              'Graph-backed (Exchange) accounts.',
          ),
        mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
        subject: z.string().optional().describe('New subject (omit to keep existing)'),
        body: z.string().optional().describe('New body content (omit to keep existing)'),
        html: z.boolean().optional().describe('Body is HTML (omit to inherit from existing draft)'),
        to: z
          .array(z.string().email())
          .optional()
          .describe('New recipient list (omit to keep existing). Pass [] for none.'),
        cc: z.array(z.string().email()).optional().describe('New CC list (omit to keep existing)'),
        bcc: z
          .array(z.string().email())
          .optional()
          .describe('New BCC list (omit to keep existing)'),
        in_reply_to: z.string().optional().describe('New In-Reply-To (omit to keep existing)'),
        attachments_keep: z
          .array(z.string())
          .optional()
          .describe(
            'Filenames of existing attachments to keep. Omit = keep ALL. Pass [] to drop all. ' +
              'Filenames not present on the draft are ignored (with a warning in the response).',
          ),
        attachments_add: z
          .array(attachmentInputSchema)
          .optional()
          .describe(
            'New attachments to add — same input shape as save_draft.attachments (path / base64 / ' +
              'message-reference). Use the message-reference form to carry attachments from another ' +
              'draft or any message without round-tripping bytes through this MCP.',
          ),
        attachments_remove: z
          .array(z.string())
          .optional()
          .describe(
            'Filenames to drop from the existing draft (subtracted from attachments_keep set)',
          ),
        append_signature: z
          .boolean()
          .optional()
          .describe(
            "Append the account's configured signature (signature_path) below the NEW body, with " +
              'its images embedded inline (cid). Forces HTML. Default false — unlike save_draft, ' +
              'the account signature_default is NOT applied. Ignored (with a warning) when body ' +
              'is omitted, since the kept body already carries its signature if it had one.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({
      account,
      draft_id: draftId,
      mailbox,
      subject,
      body,
      html,
      to,
      cc,
      bcc,
      in_reply_to: inReplyTo,
      attachments_keep: attachmentsKeep,
      attachments_add: attachmentsAdd,
      attachments_remove: attachmentsRemove,
      append_signature: appendSignature,
    }) => {
      try {
        const result = await imapService.updateDraft(account, draftId, {
          mailbox,
          subject,
          body,
          html,
          to,
          cc,
          bcc,
          inReplyTo,
          attachmentsKeep,
          attachmentsAdd: attachmentsAdd?.map(adaptAttachmentInput),
          attachmentsRemove,
          appendSignature,
        });

        await audit.log(
          'update_draft',
          account,
          {
            draftId,
            mailbox,
            subject,
            attachmentsKeepCount: attachmentsKeep?.length,
            attachmentsAddCount: attachmentsAdd?.length ?? 0,
            attachmentsRemoveCount: attachmentsRemove?.length ?? 0,
          },
          'ok',
        );

        const warningBlock =
          result.warnings.length > 0 ? `\n\nWarnings:\n  - ${result.warnings.join('\n  - ')}` : '';

        // IMAP replaces a draft by appending a rebuilt copy and deleting the
        // original, so the id changes and a leftover is worth flagging. Graph
        // patches in place: reporting a "new id" and an undeleted old one there
        // reads like a failure when nothing went wrong.
        const summary =
          String(result.id) === String(result.oldId)
            ? `✏️ Draft updated in place (id unchanged, folder: ${result.mailbox}).`
            : `✏️ Draft updated. New UID: ${result.id} (folder: ${result.mailbox}); ${
                result.oldDraftDeleted
                  ? `old draft UID ${result.oldId} removed`
                  : `old draft UID ${result.oldId} NOT deleted (see warnings)`
              }.`;

        return {
          content: [{ type: 'text' as const, text: `${summary}${warningBlock}` }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('update_draft', account, { draftId, mailbox }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to update draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
