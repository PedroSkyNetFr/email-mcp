/**
 * Microsoft Graph send path.
 *
 * Counterpart of {@link SmtpService} for accounts served by Graph. They cannot
 * use SMTP at all: Microsoft refuses to redeem a Graph-consented refresh token
 * for the outlook.office.com scopes SMTP XOAUTH2 needs, so an account holds one
 * or the other. A Graph account therefore sends through `/me/sendMail`.
 *
 * Signatures mirror SmtpService so the send router can substitute one for the
 * other per account.
 */

import type { AccountConfig, SendResult } from '../../types/index.js';
import type { ResolvedAttachment } from '../attachment-resolver.js';
import { applyAccountSignature } from '../signature-loader.js';
import type GraphClient from './graph.client.js';

interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

/** Graph file attachment, inline ones carrying their content id. */
function toGraphAttachment(attachment: ResolvedAttachment): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: attachment.filename,
    contentType: attachment.contentType,
    contentBytes: attachment.content.toString('base64'),
    ...(attachment.cid ? { isInline: true, contentId: attachment.cid } : {}),
  };
}

function toRecipients(addresses: string[] | undefined): GraphRecipient[] {
  return (addresses ?? [])
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

export default class GraphSendService {
  constructor(
    private readonly clients: Map<string, GraphClient>,
    private readonly getAccount: (name: string) => AccountConfig,
  ) {}

  private client(accountName: string): GraphClient {
    const client = this.clients.get(accountName);
    if (!client) {
      throw new Error(`Account "${accountName}" is not served by the Graph backend`);
    }
    return client;
  }

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: ResolvedAttachment[];
      appendSignature?: boolean;
    },
  ): Promise<SendResult> {
    const account = this.getAccount(accountName);
    const signed = await applyAccountSignature(
      account,
      { body: options.body, html: options.html, attachments: options.attachments },
      options.appendSignature,
    );

    await this.client(accountName).request('POST', '/me/sendMail', {
      message: {
        subject: options.subject,
        body: { contentType: signed.html ? 'HTML' : 'Text', content: signed.body },
        toRecipients: toRecipients(options.to),
        ccRecipients: toRecipients(options.cc),
        bccRecipients: toRecipients(options.bcc),
        ...(signed.attachments.length
          ? { attachments: signed.attachments.map(toGraphAttachment) }
          : {}),
      },
      // Graph files the copy itself — no equivalent of the IMAP APPEND to Sent.
      saveToSentItems: true,
    });

    // sendMail returns 202 Accepted with no body, so no server-side id exists to
    // report. Reporting an empty id is honest; inventing one would not be.
    return { messageId: '', status: 'sent' };
  }

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
      includeAttachments?: boolean;
      appendSignature?: boolean;
    },
  ): Promise<SendResult> {
    const account = this.getAccount(accountName);
    const signed = await applyAccountSignature(
      account,
      { body: options.body, html: options.html },
      options.appendSignature,
    );

    // Graph threads the reply itself (In-Reply-To / References) and carries the
    // original's attachments when replying all, so neither is rebuilt here.
    const verb = options.replyAll ? 'replyAll' : 'reply';
    await this.client(accountName).request('POST', `/me/messages/${options.emailId}/${verb}`, {
      comment: signed.body,
    });

    return { messageId: '', status: 'sent' };
  }

  async forwardEmail(
    accountName: string,
    options: { emailId: string; mailbox?: string; to: string[]; body?: string; cc?: string[] },
  ): Promise<SendResult> {
    await this.client(accountName).request('POST', `/me/messages/${options.emailId}/forward`, {
      comment: options.body ?? '',
      toRecipients: toRecipients(options.to),
    });
    return { messageId: '', status: 'sent' };
  }

  /**
   * Send an existing draft. The IMAP signature takes a numeric UID; Graph ids
   * are opaque strings, so the value is passed through as-is.
   */
  async sendDraft(accountName: string, draftId: number | string): Promise<SendResult> {
    await this.client(accountName).request('POST', `/me/messages/${String(draftId)}/send`);
    return { messageId: '', status: 'sent' };
  }
}
