/**
 * Drafts and sending for the IMAP + SMTP engine, on the MailEngine contract.
 *
 * `send` transmits the message as the host gives it — recipients, subject,
 * body, attachments are what the user saw in the composer — and only adds the
 * threading headers of `replyTo`. The pre-filled composer comes from
 * `prepareReply` / `prepareForward`, which reuse the MCP server's tested
 * pieces: Reply-To honoured, the account itself left out of a reply-all, the
 * original quoted in the account's reply language.
 *
 * The Sent copy keeps the Bcc header (never the transmitted bytes): the sender
 * can see whom they Bcc'd, as Outlook shows it.
 */

import type { IConnectionManager } from '../../connections/types.js';
import type {
  MessageId,
  OutgoingAttachment,
  OutgoingMessage,
  SendOutcome,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import type { ResolvedAttachment } from '../../services/attachment-resolver.js';
import type ImapService from '../../services/imap.service.js';
import type SmtpService from '../../services/smtp.service.js';
import type { SendResult } from '../../types/index.js';
import { forwardedParts, prepareForwardFrom, prepareReplyFrom } from '../shared/compose.js';
import type ImapMutator from './imap-mutator.js';
import type ImapReader from './imap-reader.js';
import { messageIdOf, stripAngles, toMailError } from './imap-reader.js';

const toResolved = (attachments: OutgoingAttachment[] = []): ResolvedAttachment[] =>
  attachments.map((a) => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType ?? 'application/octet-stream',
    ...(a.contentId ? { cid: a.contentId, contentDisposition: 'inline' as const } : {}),
  }));

/** HTML wins when both are given: SMTP derives the text part from it. */
const bodyOf = (message: OutgoingMessage): { body: string; html: boolean } =>
  message.html !== undefined
    ? { body: message.html, html: true }
    : { body: message.text ?? '', html: false };

function outcome(result: SendResult, extraWarnings: string[] = []): SendOutcome {
  const copy = result.sentCopy;
  let sentCopy: SendOutcome['sentCopy'] = 'skipped';
  if (copy?.kind === 'filed') sentCopy = 'filed';
  else if (copy?.kind === 'failed') sentCopy = 'failed';
  else if (copy?.kind === 'skipped' && /files the sent copy itself/i.test(copy.reason)) {
    sentCopy = 'by-server';
  }
  const copyWarning =
    copy?.kind === 'failed'
      ? [`The message was sent, but its copy in Sent failed: ${copy.error}`]
      : [];
  return {
    messageIdHeader: stripAngles(result.messageId) ?? '',
    sentCopy,
    warnings: [...(result.warnings ?? []), ...copyWarning, ...extraWarnings],
  };
}

/** SMTP-side failures, in the contract's terms. */
function toSendError(err: unknown): unknown {
  const mapped = toMailError(err);
  if (mapped instanceof MailError) return mapped;
  const message = err instanceof Error ? err.message : String(err);
  if (/too large/i.test(message)) return new MailError('too-large', message, { cause: err });
  if (/rate limit/i.test(message)) return new MailError('transient', message, { cause: err });
  if (/no recipients/i.test(message)) return new MailError('invalid', message, { cause: err });
  // A connection lost after it was opened may have delivered the message
  // (nodemailer: command other than CONN): uncertain, never retried blindly.
  const smtp = err as { code?: string; command?: string };
  if (
    ['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'EPROTOCOL'].includes(smtp.code ?? '') &&
    smtp.command !== 'CONN'
  ) {
    return new MailError(
      'uncertain',
      `${message} — the message may have been sent: check the sent folder before sending again`,
      { cause: err },
    );
  }
  return err;
}

export default class ImapSender {
  constructor(
    readonly account: string,
    private readonly connections: IConnectionManager,
    private readonly imap: ImapService,
    private readonly smtp: SmtpService,
    private readonly reader: ImapReader,
    private readonly mutator: ImapMutator,
  ) {}

  /** In-Reply-To / References of a reply to `id`. */
  private async threading(
    replyTo: OutgoingMessage['replyTo'],
  ): Promise<{ inReplyTo?: string; references?: string[] }> {
    if (!replyTo) return {};
    const original = await this.reader.getMessage(replyTo.id);
    if (!original.messageIdHeader) return {};
    return {
      inReplyTo: `<${original.messageIdHeader}>`,
      references: original.references.map((r) => `<${r}>`),
    };
  }

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    if ([...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].length === 0) {
      throw new MailError('invalid', 'A message needs at least one recipient (To, Cc or Bcc)');
    }
    try {
      const result = await this.smtp.sendEmail(this.account, {
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        ...bodyOf(message),
        attachments: toResolved(message.attachments),
        appendSignature: message.signature,
        ...(await this.threading(message.replyTo)),
        bccInSentCopy: true,
      });
      return outcome(result, await this.markOriginal(message));
    } catch (err) {
      throw toSendError(err);
    }
  }

  /**
   * Marks the original answered / forwarded. The message is already sent:
   * a failure here is a warning, never an error (an error would invite a
   * second send).
   */
  private async markOriginal(message: OutgoingMessage): Promise<string[]> {
    const target = message.replyTo ?? message.forward;
    if (!target) return [];
    try {
      const result = await this.mutator.setFlags(
        [target.id],
        message.replyTo ? { answered: true } : { addKeywords: ['$Forwarded'] },
      );
      const failure = result.failed[0];
      return failure ? [`The original could not be marked: ${failure.error}`] : [];
    } catch (err) {
      return [
        `The original could not be marked: ${err instanceof Error ? err.message : String(err)}`,
      ];
    }
  }

  async saveDraft(draft: OutgoingMessage, replaces?: MessageId): Promise<MessageId> {
    try {
      const saved = await this.imap.saveDraft(this.account, {
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        ...bodyOf(draft),
        attachments: toResolved(draft.attachments),
        appendSignature: draft.signature,
        ...(await this.threading(draft.replyTo)),
      });
      const client = await this.connections.getImapClient(this.account);
      const status = await client.status(saved.mailbox, { uidValidity: true });
      if (!status || status.uidValidity === undefined) {
        throw new MailError('transient', 'Draft saved, but its folder could not be read');
      }
      const id = messageIdOf(saved.mailbox, status.uidValidity, saved.id);
      // The new version is safe on the server before the old one goes.
      if (replaces) await this.deleteDraft(replaces);
      return id;
    } catch (err) {
      throw toSendError(err);
    }
  }

  async deleteDraft(id: MessageId): Promise<void> {
    const result = await this.mutator.delete([id], { permanent: true });
    const failure = result.failed[0];
    if (failure) throw new MailError('not-found', failure.error);
  }

  async sendDraft(id: MessageId): Promise<SendOutcome> {
    const { path, uid } = await this.reader.locate(id);
    try {
      return outcome(await this.smtp.sendDraft(this.account, uid, path, { bccInSentCopy: true }));
    } catch (err) {
      throw toSendError(err);
    }
  }

  async prepareReply(id: MessageId, options: { all?: boolean } = {}): Promise<OutgoingMessage> {
    const { path, uid } = await this.reader.locate(id);
    try {
      const original = await this.imap.getEmail(this.account, String(uid), path);
      return prepareReplyFrom(
        id,
        original,
        this.connections.getAccount(this.account),
        options.all === true,
      );
    } catch (err) {
      throw toMailError(err);
    }
  }

  async prepareForward(
    id: MessageId,
    options: { withAttachments?: boolean } = {},
  ): Promise<OutgoingMessage> {
    const { path, uid } = await this.reader.locate(id);
    try {
      const original = await this.imap.getEmail(this.account, String(uid), path);
      const full = await this.reader.getMessage(id);
      const attachments = await Promise.all(
        forwardedParts(full.attachments, options.withAttachments).map(
          async (a): Promise<OutgoingAttachment> => {
            const file = await this.reader.getAttachment(id, a.partId);
            return {
              filename: file.filename,
              contentType: file.contentType,
              content: file.content,
              ...(a.inline && a.contentId ? { contentId: a.contentId } : {}),
            };
          },
        ),
      );
      return prepareForwardFrom(
        id,
        original,
        this.connections.getAccount(this.account),
        attachments,
      );
    } catch (err) {
      throw toMailError(err);
    }
  }
}
