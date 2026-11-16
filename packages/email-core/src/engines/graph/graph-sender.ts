/**
 * Drafts and sending for the Graph engine, on the MailEngine contract.
 *
 * Exchange files every sent message in Sent Items itself, Bcc included: the
 * Sent copy is `by-server`. `send` transmits what the host composed, with the
 * threading headers of `replyTo`; the original is then marked answered or
 * forwarded (Outlook's arrows), failures reported as warnings since the
 * message is already gone.
 *
 * GraphService answers with regular (mutable) ids; the engine hands out
 * immutable ones, so a saved draft's id is translated
 * (`/me/translateExchangeIds`) before it reaches the host.
 */

import type {
  MessageId,
  OutgoingAttachment,
  OutgoingMessage,
  SendOutcome,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import type GraphClient from '../../services/graph/graph.client.js';
import type GraphService from '../../services/graph/graph.service.js';
import type GraphSendService from '../../services/graph/graph-send.service.js';
import type { AccountConfig, SendResult } from '../../types/index.js';
import { forwardedParts, prepareForwardFrom, prepareReplyFrom } from '../shared/compose.js';
import type GraphMutator from './graph-mutator.js';
import type GraphReader from './graph-reader.js';
import { graphMessageId, guard, messageIdOf, stripAngles, toMailError } from './graph-reader.js';

const toResolved = (attachments: OutgoingAttachment[] = []) =>
  attachments.map((a) => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType ?? 'application/octet-stream',
    ...(a.contentId ? { cid: a.contentId } : {}),
  }));

const bodyOf = (message: OutgoingMessage): { body: string; html: boolean } =>
  message.html !== undefined
    ? { body: message.html, html: true }
    : { body: message.text ?? '', html: false };

const outcome = (result: SendResult, warnings: string[] = []): SendOutcome => ({
  messageIdHeader: stripAngles(result.messageId) ?? '',
  sentCopy: 'by-server',
  warnings: [...(result.warnings ?? []), ...warnings],
});

export default class GraphSender {
  constructor(
    readonly account: string,
    private readonly client: GraphClient,
    private readonly graph: GraphService,
    private readonly transport: GraphSendService,
    private readonly reader: GraphReader,
    private readonly mutator: GraphMutator,
    private readonly config: () => AccountConfig,
  ) {}

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

  private async markOriginal(message: OutgoingMessage): Promise<string[]> {
    try {
      if (message.replyTo) {
        const result = await this.mutator.setFlags([message.replyTo.id], { answered: true });
        const failure = result.failed[0];
        return failure ? [`The original could not be marked answered: ${failure.error}`] : [];
      }
      if (message.forward) await this.mutator.markForwarded(message.forward.id);
      return [];
    } catch (err) {
      return [
        `The original could not be marked: ${err instanceof Error ? err.message : String(err)}`,
      ];
    }
  }

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    if ([...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].length === 0) {
      throw new MailError('invalid', 'A message needs at least one recipient (To, Cc or Bcc)');
    }
    const result = await guard(async () =>
      this.transport.sendEmail(this.account, {
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        ...bodyOf(message),
        attachments: toResolved(message.attachments),
        appendSignature: message.signature,
        ...(await this.threading(message.replyTo)),
      }),
    );
    return outcome(result, await this.markOriginal(message));
  }

  /** Immutable id of a message GraphService answered with a regular id. */
  private async immutable(regularId: string): Promise<string> {
    const translated = await this.client.request<{
      value: { sourceId: string; targetId: string }[];
    }>('POST', '/me/translateExchangeIds', {
      inputIds: [regularId],
      sourceIdType: 'restId',
      targetIdType: 'restImmutableEntryId',
    });
    const target = translated.value[0]?.targetId;
    if (!target) {
      throw new MailError('transient', 'Draft saved, but its id could not be translated');
    }
    return target;
  }

  async saveDraft(draft: OutgoingMessage, replaces?: MessageId): Promise<MessageId> {
    const threading = await this.threading(draft.replyTo);
    return guard(async () => {
      const saved = await this.graph.saveDraft(this.account, {
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        ...bodyOf(draft),
        ...(threading.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
        attachments: toResolved(draft.attachments),
      });
      const id = messageIdOf(await this.immutable(String(saved.id)));
      // The new version is safe on the server before the old one goes.
      if (replaces) await this.deleteDraft(replaces);
      return id;
    });
  }

  async deleteDraft(id: MessageId): Promise<void> {
    await guard(async () => this.graph.deleteDraft(this.account, graphMessageId(id)));
  }

  async sendDraft(id: MessageId): Promise<SendOutcome> {
    return outcome(
      await guard(async () => this.transport.sendDraft(this.account, graphMessageId(id))),
    );
  }

  async prepareReply(id: MessageId, options: { all?: boolean } = {}): Promise<OutgoingMessage> {
    const graphId = graphMessageId(id);
    try {
      const original = await this.graph.getEmail(this.account, graphId);
      return prepareReplyFrom(id, original, this.config(), options.all === true);
    } catch (err) {
      throw toMailError(err);
    }
  }

  async prepareForward(
    id: MessageId,
    options: { withAttachments?: boolean } = {},
  ): Promise<OutgoingMessage> {
    const graphId = graphMessageId(id);
    try {
      const original = await this.graph.getEmail(this.account, graphId);
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
      return prepareForwardFrom(id, original, this.config(), attachments);
    } catch (err) {
      throw toMailError(err);
    }
  }
}
