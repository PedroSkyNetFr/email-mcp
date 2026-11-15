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
 *
 * Deux façons d'envoyer coexistent :
 *   - l'action directe (`/sendMail`, `/reply`, `/forward`) : un seul appel,
 *     quand Graph fait exactement ce qui est demandé ;
 *   - le brouillon intermédiaire (`createReply` / `createForward` / POST
 *     `/messages`, puis PATCH, pièces jointes, `/send`) dès qu'il faut s'écarter
 *     du comportement natif : réponse sans citation, transfert sans les pièces
 *     de l'original, pièces à ajouter (signature, includeAttachments), réponse
 *     planifiée à rattacher à son fil. Si une étape échoue avant l'envoi, le
 *     brouillon est supprimé : il ne reste pas d'orphelin dans Brouillons.
 */

import type { AccountConfig, SendResult } from '../../types/index.js';
import type { ResolvedAttachment } from '../attachment-resolver.js';
import { assertMessageSize, estimateEncodedMessageSize } from '../send-limit.js';
import { applyAccountSignature } from '../signature-loader.js';
import type GraphClient from './graph.client.js';

interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

/** Pièce jointe telle que la liste Graph la décrit. */
interface GraphAttachmentInfo {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
  '@odata.type'?: string;
}

/**
 * Largest attachment Graph accepts inside a message payload. Past this, the
 * bytes must go through an upload session against an existing message. Graph
 * documents the limit as "about 3 MB"; staying under it avoids a rejection whose
 * error message does not name the offending attachment.
 */
const INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

/** Plafond par pièce reprise de l'original (même valeur que côté SMTP). */
const ORIGINAL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

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

/** Valeur littérale OData : guillemets simples doublés. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

  // -------------------------------------------------------------------------
  // Briques communes
  // -------------------------------------------------------------------------

  /** Ajoute des pièces à un message existant : en ligne sous ~3 Mo, par session d'upload au-delà. */
  private static async addAttachments(
    client: GraphClient,
    messageId: string,
    attachments: ResolvedAttachment[],
  ): Promise<void> {
    /* eslint-disable no-restricted-syntax, no-await-in-loop -- uploads are sequential by design */
    for (const attachment of attachments) {
      if (attachment.content.length > INLINE_ATTACHMENT_LIMIT) {
        await client.uploadLargeAttachment(messageId, attachment);
      } else {
        await client.request(
          'POST',
          `/me/messages/${messageId}/attachments`,
          toGraphAttachment(attachment),
        );
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */
  }

  /**
   * Prépare puis envoie un brouillon créé par `create`. Si une étape de
   * `prepare` (ou l'envoi) échoue, le brouillon est supprimé avant de relever
   * l'erreur — rien n'est parti, et Brouillons ne garde pas de reste.
   */
  private static async sendViaDraft(
    client: GraphClient,
    create: () => Promise<{ id: string }>,
    prepare: (draftId: string) => Promise<void>,
  ): Promise<void> {
    const draft = await create();
    try {
      await prepare(draft.id);
      await client.request('POST', `/me/messages/${draft.id}/send`);
    } catch (err) {
      try {
        await client.request('DELETE', `/me/messages/${draft.id}`);
      } catch {
        // Le nettoyage est accessoire : l'erreur d'origine est celle qui compte.
      }
      throw err;
    }
  }

  /** Id Graph du message portant ce Message-ID (toute la boîte), ou undefined. */
  private static async findByInternetMessageId(
    client: GraphClient,
    internetMessageId: string,
  ): Promise<string | undefined> {
    const filter = encodeURIComponent(`internetMessageId eq ${odataString(internetMessageId)}`);
    const found = await client.request<{ value?: { id: string }[] }>(
      'GET',
      `/me/messages?$filter=${filter}&$select=id&$top=1`,
    );
    return found?.value?.[0]?.id;
  }

  /**
   * Pièces jointes (non inline) d'un message, octets compris — pour une
   * réponse avec includeAttachments. Stricte : une pièce introuvable, trop
   * grosse ou non téléchargeable (élément Outlook joint, pièce de référence
   * OneDrive) fait échouer l'envoi avec un message qui la nomme.
   */
  private static async fetchFileAttachments(
    client: GraphClient,
    emailId: string,
  ): Promise<ResolvedAttachment[]> {
    const listed = await client.collect<GraphAttachmentInfo>(
      `/me/messages/${emailId}/attachments?$select=id,name,contentType,size,isInline`,
    );
    const wanted = listed.filter((a) => !a.isInline);
    const failures: string[] = [];
    const out: ResolvedAttachment[] = [];
    /* eslint-disable no-restricted-syntax, no-await-in-loop -- one attachment at a time bounds memory */
    for (const meta of wanted) {
      const name = meta.name ?? meta.id;
      if ((meta.size ?? 0) > ORIGINAL_ATTACHMENT_MAX_BYTES * 1.4) {
        failures.push(`"${name}" (larger than the 25MB per-attachment limit)`);
      } else {
        const full = await client.request<GraphAttachmentInfo>(
          'GET',
          `/me/messages/${emailId}/attachments/${meta.id}`,
        );
        if (full['@odata.type'] !== '#microsoft.graph.fileAttachment' || !full.contentBytes) {
          failures.push(
            `"${name}" (not a file attachment: attached Outlook items are not supported)`,
          );
        } else {
          const content = Buffer.from(full.contentBytes, 'base64');
          if (content.length > ORIGINAL_ATTACHMENT_MAX_BYTES) {
            failures.push(`"${name}" (larger than the 25MB per-attachment limit)`);
          } else {
            out.push({
              filename: full.name ?? name,
              content,
              contentType: full.contentType ?? 'application/octet-stream',
            });
          }
        }
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */
    if (failures.length > 0) {
      throw new Error(
        `Cannot reply: ${failures.length} attachment(s) of the original could not be included — ` +
          `${failures.join('; ')}. Nothing was sent. Pass includeAttachments=false to reply without them.`,
      );
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

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
      /** Message-ID auquel ce message répond (réponse planifiée). */
      inReplyTo?: string;
      /** Accepté pour la parité avec SMTP ; Graph reconstruit lui-même la chaîne. */
      references?: string[];
    },
  ): Promise<SendResult> {
    const account = this.getAccount(accountName);
    const signed = await applyAccountSignature(
      account,
      { body: options.body, html: options.html, attachments: options.attachments },
      options.appendSignature,
    );
    assertMessageSize(
      account,
      estimateEncodedMessageSize(signed.body, signed.attachments),
      signed.attachments,
    );

    const client = this.client(accountName);
    const message = {
      subject: options.subject,
      body: { contentType: signed.html ? 'HTML' : 'Text', content: signed.body },
      toRecipients: toRecipients(options.to),
      ccRecipients: toRecipients(options.cc),
      bccRecipients: toRecipients(options.bcc),
    };
    const warnings: string[] = [];

    // Graph ne laisse pas poser In-Reply-To / References (seuls les en-têtes
    // X- sont acceptés). Pour qu'une réponse planifiée rejoigne son fil, on
    // part donc d'un vrai brouillon de réponse au message d'origine — Graph y
    // pose lui-même les en-têtes de fil — dont on remplace tout le contenu.
    if (options.inReplyTo) {
      const originalId = await GraphSendService.findByInternetMessageId(client, options.inReplyTo);
      if (originalId) {
        await GraphSendService.sendViaDraft(
          client,
          async () =>
            client.request<{ id: string }>('POST', `/me/messages/${originalId}/createReply`, {}),
          async (draftId) => {
            // PATCH du corps entier : la citation que createReply a insérée
            // disparaît, le message est exactement celui qui a été planifié.
            await client.request('PATCH', `/me/messages/${draftId}`, message);
            await GraphSendService.addAttachments(client, draftId, signed.attachments);
          },
        );
        return { messageId: '', status: 'sent' };
      }
      warnings.push(
        `The message being replied to (${options.inReplyTo}) was not found in this mailbox, so ` +
          'the email was sent without threading headers (Graph cannot set In-Reply-To directly).',
      );
    }

    const small = signed.attachments.filter((a) => a.content.length <= INLINE_ATTACHMENT_LIMIT);
    const large = signed.attachments.filter((a) => a.content.length > INLINE_ATTACHMENT_LIMIT);

    // sendMail carries attachments inside the request, which Graph caps at about
    // 3 MB. Anything larger needs an upload session, and a session needs a
    // message that already exists — so the send becomes create-draft, upload,
    // send. The simple path is kept when everything fits, to avoid the extra
    // round trips.
    if (large.length === 0) {
      await client.request('POST', '/me/sendMail', {
        message: {
          ...message,
          ...(small.length ? { attachments: small.map(toGraphAttachment) } : {}),
        },
        // Graph files the copy itself — no equivalent of the IMAP APPEND to Sent.
        saveToSentItems: true,
      });
      return { messageId: '', status: 'sent', ...(warnings.length ? { warnings } : {}) };
    }

    await GraphSendService.sendViaDraft(
      client,
      async () =>
        client.request<{ id: string }>('POST', '/me/messages', {
          ...message,
          ...(small.length ? { attachments: small.map(toGraphAttachment) } : {}),
        }),
      async (draftId) => GraphSendService.addAttachments(client, draftId, large),
    );

    // sendMail returns 202 Accepted with no body, so no server-side id exists to
    // report. Reporting an empty id is honest; inventing one would not be.
    return { messageId: '', status: 'sent', ...(warnings.length ? { warnings } : {}) };
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  /**
   * Répondre. Graph enfile la réponse lui-même (In-Reply-To / References) et
   * cite l'original comme le ferait Outlook.
   *
   * - `quoteOriginal: false` : brouillon `createReply`, corps remplacé par la
   *   réponse seule, envoi ;
   * - `includeAttachments: true` : les pièces (non inline) de l'original sont
   *   recopiées dans le brouillon — Graph ne le fait jamais de lui-même ;
   * - signature avec images : les images inline sont ajoutées au brouillon
   *   (l'action directe `/reply` ne transporte pas de pièces).
   */
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
      quoteOriginal?: boolean;
    },
  ): Promise<SendResult> {
    const account = this.getAccount(accountName);
    const client = this.client(accountName);
    const signed = await applyAccountSignature(
      account,
      { body: options.body, html: options.html },
      options.appendSignature,
    );

    const quote = options.quoteOriginal !== false;
    const original = options.includeAttachments
      ? await GraphSendService.fetchFileAttachments(client, options.emailId)
      : [];
    const attachments = [...original, ...signed.attachments];
    assertMessageSize(account, estimateEncodedMessageSize(signed.body, attachments), attachments);

    const verb = options.replyAll ? 'replyAll' : 'reply';

    if (quote && attachments.length === 0) {
      await client.request('POST', `/me/messages/${options.emailId}/${verb}`, {
        comment: signed.body,
      });
      return { messageId: '', status: 'sent' };
    }

    const createVerb = options.replyAll ? 'createReplyAll' : 'createReply';
    await GraphSendService.sendViaDraft(
      client,
      async () =>
        client.request<{ id: string }>(
          'POST',
          `/me/messages/${options.emailId}/${createVerb}`,
          quote ? { comment: signed.body } : {},
        ),
      async (draftId) => {
        if (!quote) {
          await client.request('PATCH', `/me/messages/${draftId}`, {
            body: { contentType: signed.html ? 'HTML' : 'Text', content: signed.body },
          });
        }
        await GraphSendService.addAttachments(client, draftId, attachments);
      },
    );
    return { messageId: '', status: 'sent' };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  /**
   * Transférer. Graph `/forward` reprend nativement le corps ET les pièces de
   * l'original, et accepte les Cc via `message.ccRecipients` (ils étaient
   * jusqu'ici ignorés en silence).
   *
   * - `includeAttachments: false` : brouillon `createForward`, suppression des
   *   pièces non inline (les images inline restent : le corps les affiche),
   *   envoi ;
   * - signature : ajoutée sous la note (elle était ignorée sur Graph), ses
   *   images inline jointes au brouillon ;
   * - `html` : sans effet sur Graph, qui construit le transfert lui-même ;
   *   l'original y garde toujours son format.
   */
  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
      appendSignature?: boolean;
      includeAttachments?: boolean;
      html?: boolean;
    },
  ): Promise<SendResult> {
    const account = this.getAccount(accountName);
    const client = this.client(accountName);
    const signed = await applyAccountSignature(
      account,
      { body: options.body ?? '', html: false },
      options.appendSignature,
    );
    // Sans signature, la note part telle quelle (comportement inchangé).
    const comment = signed.html ? signed.body : (options.body ?? '');
    const cc = toRecipients(options.cc);
    const payload = {
      comment,
      toRecipients: toRecipients(options.to),
      ...(cc.length > 0 ? { message: { ccRecipients: cc } } : {}),
    };

    const dropAttachments = options.includeAttachments === false;
    if (!dropAttachments && signed.attachments.length === 0) {
      await client.request('POST', `/me/messages/${options.emailId}/forward`, payload);
      return { messageId: '', status: 'sent' };
    }

    await GraphSendService.sendViaDraft(
      client,
      async () =>
        client.request<{ id: string }>(
          'POST',
          `/me/messages/${options.emailId}/createForward`,
          payload,
        ),
      async (draftId) => {
        if (dropAttachments) {
          const listed = await client.collect<GraphAttachmentInfo>(
            `/me/messages/${draftId}/attachments?$select=id,isInline`,
          );
          /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential deletes */
          for (const attachment of listed.filter((a) => !a.isInline)) {
            await client.request('DELETE', `/me/messages/${draftId}/attachments/${attachment.id}`);
          }
          /* eslint-enable no-restricted-syntax, no-await-in-loop */
        }
        await GraphSendService.addAttachments(client, draftId, signed.attachments);
      },
    );
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
