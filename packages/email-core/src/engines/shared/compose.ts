/**
 * Pre-filled replies and forwards, shared by every engine so that IMAP and
 * Graph accounts get the same composer: Reply-To honoured, the account itself
 * left out of a reply-all, "Re:" / "Fwd:" subjects, the original quoted in
 * the account's reply language (the MCP server's tested pieces).
 */

import type {
  MessageId,
  OutgoingAttachment,
  OutgoingMessage,
} from '../../contract/engine.types.js';
import { computeReplyRecipients } from '../../services/smtp.service.js';
import type { AccountConfig, Email } from '../../types/index.js';
import {
  DEFAULT_REPLY_LANGUAGE,
  forwardAsHtml,
  forwardAsText,
  quoteOriginalAsHtml,
  quoteOriginalAsText,
} from '../../utils/quote.js';
import { forwardSubject, replySubject } from '../../utils/subject-prefix.js';

export function prepareReplyFrom(
  id: MessageId,
  original: Email,
  account: AccountConfig,
  all: boolean,
): OutgoingMessage {
  const lang = account.replyLanguage ?? DEFAULT_REPLY_LANGUAGE;
  const { to, cc } = computeReplyRecipients(original, [account.email], all);
  return {
    to,
    ...(cc.length > 0 ? { cc } : {}),
    subject: replySubject(original.subject),
    text: `\n\n${quoteOriginalAsText(original, lang)}`,
    html: `<p><br></p>${quoteOriginalAsHtml(original, lang)}`,
    replyTo: { id },
  };
}

export function prepareForwardFrom(
  id: MessageId,
  original: Email,
  account: AccountConfig,
  attachments: OutgoingAttachment[],
): OutgoingMessage {
  const lang = account.replyLanguage ?? DEFAULT_REPLY_LANGUAGE;
  return {
    to: [],
    subject: forwardSubject(original.subject),
    text: forwardAsText(undefined, original, lang),
    ...(original.bodyHtml ? { html: forwardAsHtml(undefined, original, false, lang) } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    forward: { id },
  };
}

/** Which attachments of the original a forward carries. */
export function forwardedParts<T extends { inline: boolean; contentId?: string }>(
  attachments: T[],
  withAttachments: boolean | undefined,
): T[] {
  // Inline images go with the HTML that references them; real attachments
  // unless the host asked to leave them out.
  return attachments.filter((a) => Boolean(a.inline && a.contentId) || withAttachments !== false);
}
