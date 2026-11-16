/**
 * Shared attachment-input schema for MCP tools (snake_case at the MCP boundary).
 *
 * The polymorphic `attachmentInputSchema` (a z.union of three shapes) and the
 * `adaptAttachmentInput` adapter are shared by every tool that accepts
 * attachments — save_draft / update_draft (drafts.tool.ts) and send_email
 * (send.tool.ts) — so the wire shape and the adaptation to the internal
 * {@link AttachmentInput} type stay identical across them.
 */

import type { AttachmentInput } from '@pedroskynet/email-core/services/attachment-resolver.js';
import { z } from 'zod';

// Shared field: marks an attachment as an inline "cid" image. Any attachment
// carrying a `cid` is treated as inline (Content-Disposition: inline) and
// referenced from the HTML via <img src="cid:the_cid">. Its presence switches
// nodemailer to multipart/related. Without `cid`, classic attachment behavior.
const cidField = z
  .string()
  .optional()
  .describe(
    'Content-ID for an inline image (e.g. "companyLogo"). Reference it from the HTML via ' +
      '<img src="cid:companyLogo">. The attachment then becomes inline (multipart/related) ' +
      'instead of a classic attachment. Omitted = ordinary attachment.',
  );

const attachmentFromPath = z.object({
  path: z.string().describe('Absolute local filesystem path to the file'),
  filename: z.string().optional().describe('Override filename (defaults to basename of path)'),
  mime_type: z.string().optional().describe('MIME type override (auto-detected if omitted)'),
  cid: cidField,
});

const attachmentFromBase64 = z.object({
  content_base64: z.string().describe('Base64-encoded file content'),
  filename: z.string().describe('Filename to use on the message'),
  mime_type: z.string().optional().describe('MIME type override (auto-detected if omitted)'),
  cid: cidField,
});

const attachmentFromMessage = z.object({
  source_email_id: z.string().describe('UID of an existing message holding this attachment'),
  source_mailbox: z
    .string()
    .describe('Mailbox path containing the source message (e.g. "INBOX" or "Drafts")'),
  filename: z
    .string()
    .optional()
    .describe(
      'Attachment filename on the source message — exact match. Refused when several ' +
        'attachments carry that name: pass part_id instead.',
    ),
  part_id: z
    .string()
    .optional()
    .describe(
      'partId of the attachment on the source message (shown by get_email); takes precedence ' +
        'over filename and is the only way to pick one of two same-named attachments.',
    ),
  cid: cidField,
});

export const attachmentInputSchema = z.union([
  attachmentFromPath,
  attachmentFromBase64,
  attachmentFromMessage,
]);

export type AttachmentInputRaw = z.infer<typeof attachmentInputSchema>;

export function adaptAttachmentInput(raw: AttachmentInputRaw): AttachmentInput {
  if ('path' in raw) {
    return {
      path: raw.path,
      filename: raw.filename,
      mimeType: raw.mime_type,
      cid: raw.cid,
    };
  }
  if ('content_base64' in raw) {
    return {
      contentBase64: raw.content_base64,
      filename: raw.filename,
      mimeType: raw.mime_type,
      cid: raw.cid,
    };
  }
  return {
    sourceEmailId: raw.source_email_id,
    sourceMailbox: raw.source_mailbox,
    filename: raw.filename,
    ...(raw.part_id !== undefined ? { partId: raw.part_id } : {}),
    cid: raw.cid,
  };
}
