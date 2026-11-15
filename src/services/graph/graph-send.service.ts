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
 *     brouillon est supprimé (Graph le déplace dans Éléments supprimés) : il
 *     ne reste pas d'orphelin dans Brouillons. Si c'est l'envoi lui-même dont
 *     l'issue est inconnue, le brouillon est gardé (voir sendViaDraft).
 */

import type { AccountConfig, SendResult } from '../../types/index.js';
import type { ResolvedAttachment } from '../attachment-resolver.js';
import { assertMessageSize, estimateEncodedMessageSize } from '../send-limit.js';
import { applyAccountSignature } from '../signature-loader.js';
import type GraphClient from './graph.client.js';
import { GraphError } from './graph.client.js';
import UncertainSendError from './uncertain-send-error.js';

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

/**
 * Un échec de `/send` est-il un refus net (rien n'est parti) ? Oui pour une
 * réponse 4xx du serveur, sauf 429 (trop de requêtes : le message a pu être
 * accepté avant la limitation) et 408 (délai dépassé). Tout le reste — coupure
 * réseau sans réponse, 5xx — laisse l'issue inconnue.
 */
function isDefiniteRejection(err: unknown): boolean {
  return (
    err instanceof GraphError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 429 &&
    err.status !== 408
  );
}

export { UncertainSendError };

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

  /**
   * Ajoute des pièces à un message existant : en ligne sous ~3 Mo, par session
   * d'upload au-delà. Publique : aussi utilisée par `GraphService.saveDraft`.
   */
  static async addAttachments(
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
   * Supprime un brouillon sans jamais lever. `DELETE /me/messages/{id}` ne
   * détruit pas le message : Graph le DÉPLACE dans Éléments supprimés, d'où il
   * reste récupérable.
   */
  static async discardDraft(client: GraphClient, draftId: string): Promise<void> {
    try {
      await client.request('DELETE', `/me/messages/${draftId}`);
    } catch {
      // Le nettoyage est accessoire : l'erreur d'origine est celle qui compte.
    }
  }

  /**
   * Prépare puis envoie un brouillon créé par `create`.
   *
   * - Échec de `prepare` (PATCH, pièces jointes) : rien n'est parti ; le
   *   brouillon est supprimé et l'erreur relevée.
   * - Échec de `/send` par un refus net (4xx hors 429/408) : rien n'est parti
   *   non plus ; même traitement.
   * - Échec de `/send` sans réponse claire (réseau, 5xx, 429, 408) : le
   *   message a PU partir. Le brouillon est gardé — le supprimer effacerait la
   *   seule trace locale si l'envoi a échoué — et une `UncertainSendError`
   *   demande de vérifier Éléments envoyés avant de renvoyer.
   *
   * L'appel `/send` est hors du bloc de nettoyage : avant, toute erreur de
   * `/send` supprimait le brouillon, y compris quand le message était parti.
   */
  private static async sendViaDraft(
    client: GraphClient,
    create: () => Promise<{ id: string }>,
    prepare: (draftId: string) => Promise<void>,
  ): Promise<void> {
    const draft = await create();
    try {
      await prepare(draft.id);
    } catch (err) {
      await GraphSendService.discardDraft(client, draft.id);
      throw err;
    }

    try {
      await client.request('POST', `/me/messages/${draft.id}/send`);
    } catch (err) {
      if (isDefiniteRejection(err)) {
        await GraphSendService.discardDraft(client, draft.id);
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new UncertainSendError(
        `Send outcome uncertain: the request to send failed (${reason}), but the server may ` +
          'have sent the message anyway. Check Sent Items before sending again; the draft was ' +
          'kept in Drafts.',
        { cause: err },
      );
    }
  }

  /**
   * Brouillon de RÉPONSE à `originalId`, au contenu entièrement remplacé par
   * `message`. Graph ne laisse pas poser In-Reply-To / References (seuls les
   * en-têtes X- sont acceptés) : partir de `createReply` est le seul moyen
   * qu'un message rejoigne le fil — Graph y pose lui-même les en-têtes. Le
   * PATCH du corps entier efface la citation que createReply a insérée, et les
   * destinataires qu'il a pré-remplis.
   *
   * Partagé par l'envoi planifié (sendEmail) et `save_draft` (GraphService).
   * Si le PATCH échoue, le brouillon est supprimé avant de relever l'erreur.
   */
  static async createThreadedReplyDraft(
    client: GraphClient,
    originalId: string,
    message: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const draft = await client.request<{ id: string }>(
      'POST',
      `/me/messages/${originalId}/createReply`,
      {},
    );
    try {
      await client.request('PATCH', `/me/messages/${draft.id}`, message);
    } catch (err) {
      await GraphSendService.discardDraft(client, draft.id);
      throw err;
    }
    return draft;
  }

  /** Id Graph du message portant ce Message-ID (toute la boîte), ou undefined. */
  static async findByInternetMessageId(
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

    // Réponse planifiée : elle doit rejoindre son fil, donc partir d'un vrai
    // brouillon de réponse au message d'origine (voir createThreadedReplyDraft).
    if (options.inReplyTo) {
      const originalId = await GraphSendService.findByInternetMessageId(client, options.inReplyTo);
      if (originalId) {
        await GraphSendService.sendViaDraft(
          client,
          async () => GraphSendService.createThreadedReplyDraft(client, originalId, message),
          async (draftId) => GraphSendService.addAttachments(client, draftId, signed.attachments),
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

  /**
   * Enregistre une réponse dans Brouillons SANS l'envoyer (outil `reply_draft`).
   *
   * Même construction que `replyToEmail`, arrêtée avant `/send` : le brouillon
   * part de `createReply` / `createReplyAll`, seul moyen sur Graph d'obtenir
   * une réponse rattachée au fil (Graph pose lui-même In-Reply-To et
   * References, qu'il refuse de laisser écrire). Avec citation, la réponse est
   * passée en `comment` et Exchange compose la citation à la manière
   * d'Outlook, dans la langue de la boîte — `reply_language` ne s'applique
   * pas. Sans citation, le corps du brouillon est remplacé par un PATCH.
   * Destinataires : ceux que Graph pré-remplit (expéditeur, ou tous moins
   * soi-même pour replyAll). Si une étape échoue après la création, le
   * brouillon est supprimé : pas d'orphelin dans Brouillons.
   *
   * L'id renvoyé est l'id Graph du brouillon, accepté par `send_draft` et
   * `update_draft`.
   */
  async saveReplyDraft(
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
      attachments?: ResolvedAttachment[];
      bcc?: string[];
    },
  ): Promise<{ id: number | string; mailbox: string; warnings: string[] }> {
    const account = this.getAccount(accountName);
    const client = this.client(accountName);
    const signed = await applyAccountSignature(
      account,
      { body: options.body, html: options.html, attachments: options.attachments },
      options.appendSignature,
    );

    const quote = options.quoteOriginal !== false;
    const original = options.includeAttachments
      ? await GraphSendService.fetchFileAttachments(client, options.emailId)
      : [];
    const attachments = [...original, ...signed.attachments];
    const bcc = toRecipients(options.bcc);

    const createVerb = options.replyAll ? 'createReplyAll' : 'createReply';
    const draft = await client.request<{ id: string }>(
      'POST',
      `/me/messages/${options.emailId}/${createVerb}`,
      quote ? { comment: signed.body } : {},
    );
    try {
      const patch: Record<string, unknown> = {
        ...(quote
          ? {}
          : { body: { contentType: signed.html ? 'HTML' : 'Text', content: signed.body } }),
        ...(bcc.length > 0 ? { bccRecipients: bcc } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await client.request('PATCH', `/me/messages/${draft.id}`, patch);
      }
      await GraphSendService.addAttachments(client, draft.id, attachments);
    } catch (err) {
      await GraphSendService.discardDraft(client, draft.id);
      throw err;
    }
    return { id: draft.id, mailbox: 'Drafts', warnings: [] };
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
