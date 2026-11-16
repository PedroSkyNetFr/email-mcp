/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type {
  AccountConfig,
  DraftCleanupResult,
  Email,
  ReplyDraftResult,
  SendResult,
  SentCopyResult,
} from '../types/index.js';
import { htmlToPlainText } from '../utils/html-text.js';
import type { ComposeOptions } from '../utils/mime-headers.js';
import { buildReferences, composeMessage } from '../utils/mime-headers.js';
import {
  DEFAULT_REPLY_LANGUAGE,
  forwardAsHtml,
  forwardAsText,
  quoteOriginalAsHtml,
  quoteOriginalAsText,
} from '../utils/quote.js';
import { forwardSubject, replySubject } from '../utils/subject-prefix.js';
import type { ResolvedAttachment } from './attachment-resolver.js';
import { realAttachments, uniqueAttachmentNames } from './attachment-select.js';
import type ImapService from './imap.service.js';
import { assertMessageSize, explainSmtpSizeRejection } from './send-limit.js';
import { applyAccountSignature, shouldAppendSignature } from './signature-loader.js';

// ---------------------------------------------------------------------------
// Helpers (must be defined before SmtpService)
// ---------------------------------------------------------------------------

/**
 * Plafond PAR PIÈCE quand on reprend les pièces de l'original (réponse avec
 * includeAttachments, transfert). Plus haut que les 5 Mo par défaut de
 * `downloadAttachment`, qui visent à ne pas faire transiter un gros fichier en
 * base64 dans une RÉPONSE d'outil MCP : ici les octets vont directement dans
 * le message composé et n'atteignent jamais le modèle. La taille totale du
 * message est contrôlée à part (send-limit.ts).
 */
export const ORIGINAL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function isGmailAccount(account: AccountConfig): boolean {
  return account.imap.host.includes('gmail.com') || account.smtp.host.includes('gmail.com');
}

function fromAddress(account: AccountConfig): string {
  return account.fullName ? `"${account.fullName}" <${account.email}>` : account.email;
}

/**
 * Parties du corps pour MailComposer. Un corps HTML reçoit toujours une
 * alternative text/plain générée : sans elle, le message part en text/html
 * seul (nodemailer 10 a retiré `text: 'auto'`), ce que les filtres anti-spam
 * pénalisent et que les clients en mode texte affichent balises comprises.
 */
function bodyParts(body: string, html: boolean): { html: string; text: string } | { text: string } {
  return html ? { html: body, text: htmlToPlainText(body) } : { text: body };
}

/**
 * Remove any `Bcc:` header (and its folded continuation lines) from a raw RFC822
 * message, operating ONLY on the header block (everything before the first
 * blank line). Bcc addresses belong in the SMTP envelope, never in the
 * transmitted/stored message — a leaked `Bcc:` header would disclose the blind
 * recipients to everyone who receives the mail.
 *
 * No-op when there is no Bcc header. Original line endings and body bytes are
 * preserved exactly. Exported for unit testing.
 */
/**
 * The Message-ID a raw message actually carries. nodemailer does not parse a
 * `raw` message it is handed: the `messageId` it reports for one is a fresh
 * random id, not the one transmitted (found in review), so a host looking the
 * sent message up by it would never find it.
 */
export function messageIdOfRaw(raw: Buffer): string | undefined {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  // Header section only, folded lines unfolded.
  const headers = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  return /^Message-ID:[ \t]*(<[^>\r\n]+>)/im.exec(headers)?.[1];
}

export function stripBccHeader(raw: Buffer): Buffer {
  const text = raw.toString('binary');

  // Locate the header/body boundary (first blank line), supporting CRLF and LF.
  const crlfIdx = text.indexOf('\r\n\r\n');
  const lfIdx = text.indexOf('\n\n');
  let boundary: number;
  let eol: string;
  if (crlfIdx >= 0 && (lfIdx < 0 || crlfIdx <= lfIdx)) {
    boundary = crlfIdx;
    eol = '\r\n';
  } else if (lfIdx >= 0) {
    boundary = lfIdx;
    eol = '\n';
  } else {
    // No header/body separator (malformed/degenerate message). We cannot tell
    // headers from body, so treating everything as headers risks deleting body
    // lines that merely start with `Bcc:`. Return the original bytes untouched.
    return raw;
  }

  const headerBlock = text.slice(0, boundary);
  const rest = text.slice(boundary); // blank-line separator + body, untouched

  const headerLines = headerBlock.split(eol);
  // Walk the header lines, dropping any `Bcc:` header and the folded
  // continuation lines (leading space/tab) that belong to it. `dropping`
  // tracks whether we are mid-drop so continuation lines are removed too.
  const { kept } = headerLines.reduce<{ kept: string[]; dropping: boolean }>(
    (acc, line) => {
      const isContinuation = line.startsWith(' ') || line.startsWith('\t');
      if (acc.dropping && isContinuation) {
        return acc; // folded continuation of the Bcc header — drop it
      }
      if (/^(resent-)?bcc:/i.test(line)) {
        // Drop both `Bcc:` and the RFC 5322 `Resent-Bcc:` header — each carries
        // blind recipients that must never be transmitted. `X-Original-Bcc:`
        // and similar prefixed headers are deliberately NOT matched.
        return { kept: acc.kept, dropping: true };
      }
      return { kept: [...acc.kept, line], dropping: false };
    },
    { kept: [], dropping: false },
  );

  // Nothing changed — return the original buffer untouched.
  if (kept.length === headerLines.length) return raw;

  const rebuilt = kept.join(eol) + rest;
  return Buffer.from(rebuilt, 'binary');
}

/**
 * Normalize an SMTP envelope recipient list (the RCPT TO set). Drops
 * empty/whitespace-only addresses (a parsed `{address:''}` is not a recipient)
 * and de-dupes case-insensitively (an address appearing in both To and Cc, or
 * differing only in case, yields ONE RCPT). First-seen order and the first
 * occurrence's original casing are preserved. Exported for unit testing.
 */
export function normalizeEnvelopeRecipients(addrs: string[]): string[] {
  return addrs.reduce<{ seen: Set<string>; list: string[] }>(
    (acc, addr) => {
      const trimmed = addr.trim();
      const key = trimmed.toLowerCase();
      if (trimmed.length === 0 || acc.seen.has(key)) return acc;
      acc.seen.add(key);
      acc.list.push(trimmed);
      return acc;
    },
    { seen: new Set<string>(), list: [] },
  ).list;
}

/**
 * Destinataires d'une réponse composée localement (IMAP / SMTP), comme le font
 * les clients de messagerie (RFC 5322 §3.6.2) et Graph `/reply` :
 *
 * - destinataire principal : toutes les adresses de Reply-To quand l'original
 *   en porte un, sinon From ;
 * - `replyAll` : principal + To de l'original en To, Cc de l'original en Cc,
 *   moins les adresses du compte (`selfAddresses`), sans tenir compte de la
 *   casse. Si ce retrait vide To (réponse à tous à un message qu'on s'est
 *   envoyé à soi seul), le principal est gardé tel quel plutôt que de
 *   composer une réponse sans destinataire.
 *
 * Une adresse présente à la fois en To et en Cc n'est gardée qu'en To ; les
 * doublons (casse différente comprise) sont fusionnés. Exportée pour les tests.
 */
export function computeReplyRecipients(
  original: Pick<Email, 'from' | 'to' | 'cc' | 'replyTo'>,
  selfAddresses: string[],
  replyAll: boolean,
): { to: string[]; cc: string[] } {
  const replyTo = (original.replyTo ?? []).map((a) => a.address).filter(Boolean);
  const primary = replyTo.length > 0 ? replyTo : [original.from.address];
  if (!replyAll) return { to: normalizeEnvelopeRecipients(primary), cc: [] };

  const self = new Set(selfAddresses.map((a) => a.trim().toLowerCase()));
  const notSelf = (address: string) => !self.has(address.trim().toLowerCase());
  let toList = normalizeEnvelopeRecipients(
    [...primary, ...original.to.map((a) => a.address)].filter(notSelf),
  );
  if (toList.length === 0) toList = normalizeEnvelopeRecipients(primary);
  const toKeys = new Set(toList.map((a) => a.toLowerCase()));
  const ccList = normalizeEnvelopeRecipients(
    (original.cc ?? []).map((a) => a.address).filter(notSelf),
  ).filter((a) => !toKeys.has(a.toLowerCase()));
  return { to: toList, cc: ccList };
}

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
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
      /**
       * Message-ID auquel ce message répond (envoi planifié d'une réponse).
       * Posé avec References pour que le message rejoigne son fil.
       */
      inReplyTo?: string;
      /** Chaîne References du fil ; défaut : `[inReplyTo]`. */
      references?: string[];
      /**
       * Keep the Bcc header in the copy filed in Sent (never in the bytes
       * transmitted), so the sender can see whom they Bcc'd. Off by default:
       * the MCP tools keep their behaviour; the MailEngine contract asks for it.
       */
      bccInSentCopy?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const toAddrs = options.to;
    const ccAddrs = options.cc ?? [];
    const bccAddrs = options.bcc ?? [];

    // Optional signature: append the HTML below the body + inline (cid) images.
    const signed = await applyAccountSignature(
      account,
      { body: options.body, html: options.html, attachments: options.attachments },
      options.appendSignature,
    );

    // Compose ONCE → raw bytes (same approach as replyToEmail / sendDraft): the
    // identical bytes are transmitted via SMTP and stored in Sent. Bcc is
    // deliberately NOT placed in mailOptions — we send the raw message, so
    // nodemailer would not strip a Bcc header for us; the blind recipients ride
    // only in the SMTP envelope below.
    const mailOptions: ComposeOptions = {
      from: fromAddress(account),
      to: toAddrs.join(', '),
      cc: ccAddrs.length > 0 ? ccAddrs.join(', ') : undefined,
      ...(options.bccInSentCopy && bccAddrs.length > 0 ? { bcc: bccAddrs.join(', ') } : {}),
      subject: options.subject,
      ...(options.inReplyTo
        ? {
            inReplyTo: options.inReplyTo,
            references: buildReferences(options.inReplyTo, options.references),
          }
        : {}),
      ...bodyParts(signed.body, signed.html),
      ...(signed.attachments.length ? { attachments: signed.attachments } : {}),
    };

    return this.composeAndTransmit(accountName, account, transport, {
      mailOptions,
      recipients: [...toAddrs, ...ccAddrs, ...bccAddrs],
      attachments: signed.attachments,
      what: 'email',
      keepBccInSentCopy: Boolean(options.bccInSentCopy) && bccAddrs.length > 0,
    });
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

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
      /**
       * Cite l'original sous la réponse (défaut : true), comme le font les
       * clients de bureau et Graph `/reply`. false : corps seul.
       */
      quoteOriginal?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const reply = await this.composeReply(accountName, options, 'reply');
    const transport = await this.connections.getSmtpTransport(accountName);

    // Build the raw message once — same bytes sent via SMTP and stored in Sent folder
    const mailOptions: ComposeOptions = {
      from: fromAddress(reply.account),
      to: reply.to.join(', '),
      cc: reply.cc.length > 0 ? reply.cc.join(', ') : undefined,
      subject: reply.subject,
      inReplyTo: reply.inReplyTo,
      references: reply.references.join(' '),
      ...bodyParts(reply.body, reply.html),
      ...(reply.attachments.length > 0 ? { attachments: reply.attachments } : {}),
    };

    // When sending a pre-composed raw message, nodemailer cannot derive the SMTP
    // envelope from the (opaque) raw bytes — it would compute an empty recipient
    // list and throw "No recipients defined". The envelope is passed explicitly
    // (composeAndTransmit) so the RCPT TO list covers every To + Cc recipient.
    const result = await this.composeAndTransmit(accountName, reply.account, transport, {
      mailOptions,
      recipients: [...reply.to, ...reply.cc],
      attachments: reply.attachments,
      what: 'reply',
    });
    return SmtpService.withWarnings(result, reply.warnings);
  }

  /**
   * Enregistre une réponse dans Brouillons SANS l'envoyer (outil `reply_draft`).
   *
   * Composée exactement comme `replyToEmail` (même {@link composeReply} :
   * destinataires, sujet « Re: », In-Reply-To / References, citation, signature,
   * pièces de l'original), puis déposée par `ImapService.saveDraft`, qui garde
   * l'en-tête Bcc — un brouillon n'a pas d'enveloppe SMTP. Rien ne part : ni
   * SMTP, ni quota d'envoi consommé. Le brouillon s'envoie ensuite avec
   * `send_draft` ou se réécrit avec `update_draft`.
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
      /** Pièces supplémentaires, déjà résolues. */
      attachments?: ResolvedAttachment[];
      /** Destinataires cachés, conservés dans l'en-tête Bcc du brouillon. */
      bcc?: string[];
    },
  ): Promise<ReplyDraftResult> {
    const reply = await this.composeReply(accountName, options, 'draft a reply');
    const saved = await this.imapService.saveDraft(accountName, {
      to: reply.to,
      cc: reply.cc,
      bcc: options.bcc,
      subject: reply.subject,
      body: reply.body,
      html: reply.html,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
      attachments: reply.attachments,
      // La signature est déjà dans `reply.body` : saveDraft ne doit pas
      // l'ajouter une seconde fois (son défaut suit signature_default).
      appendSignature: false,
    });
    const warnings = [...reply.warnings];
    if (!saved.id) {
      warnings.push(
        'The server did not report the UID of the saved draft (no UIDPLUS): find it with ' +
          `list_emails on "${saved.mailbox}" before calling send_draft or update_draft.`,
      );
    }
    return {
      id: saved.id,
      mailbox: saved.mailbox,
      subject: reply.subject,
      to: reply.to,
      cc: reply.cc,
      warnings,
    };
  }

  /**
   * Compose une réponse à `options.emailId`, sans rien transmettre. Partagé
   * par l'envoi (`replyToEmail`) et le brouillon (`saveReplyDraft`) pour que
   * les deux ne puissent pas diverger : une réponse enregistrée puis envoyée
   * doit être identique à une réponse envoyée directement.
   */
  private async composeReply(
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
    },
    context: 'reply' | 'draft a reply',
  ): Promise<{
    account: AccountConfig;
    to: string[];
    cc: string[];
    subject: string;
    inReplyTo: string | undefined;
    references: string[];
    body: string;
    html: boolean;
    attachments: ResolvedAttachment[];
    warnings: string[];
  }> {
    const account = this.connections.getAccount(accountName);
    const mailbox = options.mailbox ?? 'INBOX';
    const original = await this.imapService.getEmail(accountName, options.emailId, mailbox);

    // Destinataires : Reply-To prioritaire sur From, soi-même retiré en
    // réponse à tous (voir computeReplyRecipients). Le compte n'a pas d'alias
    // déclarés dans la config : seule son adresse principale est « soi ».
    const { to: toList, cc: ccList } = computeReplyRecipients(
      original,
      [account.email],
      options.replyAll === true,
    );

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = replySubject(original.subject);

    // Pièces de l'original : stricte, comme pour un transfert — l'appelant les
    // a demandées, un envoi qui en perdrait une en silence serait trompeur.
    const fetched = options.includeAttachments
      ? await this.fetchOriginalAttachments(
          accountName,
          original,
          options.emailId,
          mailbox,
          context,
        )
      : { attachments: [], warnings: [] };

    // Optional signature: append the HTML below the body + inline (cid) images.
    // La signature se place sous la réponse et AU-DESSUS de la citation.
    const signed = await applyAccountSignature(
      account,
      {
        body: options.body,
        html: options.html,
        attachments: [...fetched.attachments, ...(options.attachments ?? [])],
      },
      options.appendSignature,
    );

    // Citation de l'original, au format du message (HTML dès qu'une signature
    // a forcé le HTML). En HTML, l'original est cité en texte échappé.
    let { body } = signed;
    if (options.quoteOriginal !== false) {
      const lang = account.replyLanguage ?? DEFAULT_REPLY_LANGUAGE;
      body += signed.html
        ? quoteOriginalAsHtml(original, lang)
        : quoteOriginalAsText(original, lang);
    }

    return {
      account,
      to: toList,
      cc: ccList,
      subject,
      inReplyTo: original.messageId || undefined,
      references,
      body,
      html: signed.html,
      // Doublons de noms (pièces de l'original + pièces ajoutées) renommés
      // « nom (2).ext » : le destinataire distingue ce que l'original ne
      // distinguait que par numéro de partie.
      attachments: uniqueAttachmentNames(signed.attachments),
      warnings: fetched.warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  /**
   * Forward a message, carrying its attachments across by default (wgs4 9d6df7b).
   *
   * Attachment handling is strict: a forward's attachments are usually the
   * whole point of forwarding, so a fetch failure throws instead of quietly
   * transmitting a gutted message. Pass `includeAttachments: false` for a
   * body-only forward.
   *
   * Le message est composé UNE fois en octets bruts : les mêmes octets partent
   * en SMTP et sont copiés dans Envoyés (l'ancienne copie, reconstruite à part
   * en text/plain seul, perdait pièces et mise en forme).
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
      /** Reprendre les pièces jointes de l'original (défaut : true). */
      includeAttachments?: boolean;
      /**
       * Ajouter une partie HTML reprenant le HTML de l'original (défaut :
       * false — texte seul, original HTML converti en texte lisible).
       */
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const mailbox = options.mailbox ?? 'INBOX';
    const original = await this.imapService.getEmail(accountName, options.emailId, mailbox);

    const subject = forwardSubject(original.subject);

    const transport = await this.connections.getSmtpTransport(accountName);

    const fetched =
      options.includeAttachments === false
        ? { attachments: [], warnings: [] }
        : await this.fetchOriginalAttachments(
            accountName,
            original,
            options.emailId,
            mailbox,
            'forward',
          );

    // Une signature force le HTML (comme ailleurs) ; sinon c'est `html` qui
    // décide. La signature se place sous la note, au-dessus du message transféré.
    const signing = shouldAppendSignature(account, options.appendSignature);
    const asHtml = options.html === true || signing;
    // Langue de l'en-tête « Message transféré » (réglage reply_language).
    const lang = account.replyLanguage ?? DEFAULT_REPLY_LANGUAGE;

    let parts: { html: string; text: string } | { text: string };
    let signatureAttachments: ResolvedAttachment[] = [];
    if (asHtml) {
      const signed = await applyAccountSignature(
        account,
        { body: options.body ?? '', html: false },
        options.appendSignature,
      );
      signatureAttachments = signed.attachments;
      const noteText = signed.html ? htmlToPlainText(signed.body) : options.body;
      parts = {
        html: forwardAsHtml(signed.html ? signed.body : options.body, original, signed.html, lang),
        // L'alternative texte reprend la note (signature comprise) et l'original
        // converti — pas une conversion du HTML complet, qui perdrait la
        // structure de l'en-tête de transfert.
        text: forwardAsText(noteText, original, lang),
      };
    } else {
      // Texte seul : l'original HTML est converti en texte lisible, jamais
      // collé brut (ses balises s'affichaient telles quelles).
      parts = { text: forwardAsText(options.body, original, lang) };
    }

    const attachments = uniqueAttachmentNames([...fetched.attachments, ...signatureAttachments]);
    const ccAddrs = options.cc ?? [];
    const mailOptions: ComposeOptions = {
      from: fromAddress(account),
      to: options.to.join(', '),
      cc: ccAddrs.length > 0 ? ccAddrs.join(', ') : undefined,
      subject,
      ...parts,
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    const result = await this.composeAndTransmit(accountName, account, transport, {
      mailOptions,
      recipients: [...options.to, ...ccAddrs],
      attachments,
      what: 'forward',
    });
    return SmtpService.withWarnings(result, fetched.warnings);
  }

  /**
   * Télécharge les pièces jointes de l'original (réponse avec
   * includeAttachments, transfert).
   *
   * Chaque pièce est désignée par son numéro de partie MIME : deux pièces de
   * même nom (les `image001.png` des signatures Outlook) sont TOUTES reprises,
   * avec leurs propres octets — autrefois seule la première l'était, avec un
   * avertissement. À l'envoi, les doublons sont renommés « image001 (2).png »
   * (`uniqueAttachmentNames`) pour que le destinataire les distingue.
   *
   * Les images inline à cid restent derrière, comme avant qu'elles soient
   * listées : la réponse et le transfert ne reprennent pas le HTML qui les
   * référence, elles deviendraient des pièces jointes parasites.
   *
   * Stricte : le moindre échec lève une erreur qui nomme chaque pièce, et rien
   * n'est envoyé.
   */
  private async fetchOriginalAttachments(
    accountName: string,
    original: Pick<Email, 'attachments'>,
    emailId: string,
    mailbox: string,
    context: 'reply' | 'draft a reply' | 'forward',
  ): Promise<{ attachments: ResolvedAttachment[]; warnings: string[] }> {
    const metas = realAttachments(original.attachments);
    if (metas.length === 0) return { attachments: [], warnings: [] };

    const results = await Promise.allSettled(
      metas.map(async (meta) =>
        this.imapService.downloadAttachment(
          accountName,
          emailId,
          mailbox,
          meta.partId !== undefined ? { partId: meta.partId } : meta.filename,
          ORIGINAL_ATTACHMENT_MAX_BYTES,
        ),
      ),
    );

    const failures = results.flatMap((result, i) =>
      result.status === 'rejected'
        ? [
            `"${metas[i].filename}"${metas[i].partId !== undefined ? ` (partId ${metas[i].partId})` : ''} (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`,
          ]
        : [],
    );
    if (failures.length > 0) {
      throw new Error(
        `Cannot ${context}: ${failures.length} of ${metas.length} attachment(s) of the original ` +
          `could not be fetched — ${failures.join('; ')}. Nothing was sent. Retry, or pass ` +
          `includeAttachments=false to ${context} without them.`,
      );
    }

    const attachments = results.flatMap((result) =>
      result.status === 'fulfilled'
        ? [
            {
              filename: result.value.filename,
              content: Buffer.from(result.value.contentBase64, 'base64'),
              contentType: result.value.mimeType,
            },
          ]
        : [],
    );
    return { attachments, warnings: [] };
  }

  /**
   * Compose le message, contrôle sa taille, l'envoie, puis en dépose une
   * copie dans Envoyés — les MÊMES octets dans les deux cas.
   *
   * La taille contrôlée est celle du message composé, exacte : c'est ce que
   * reçoit le serveur SMTP (pièces encodées en base64 comprises).
   */
  private async composeAndTransmit(
    accountName: string,
    account: AccountConfig,
    transport: Awaited<ReturnType<IConnectionManager['getSmtpTransport']>>,
    params: {
      mailOptions: ComposeOptions;
      recipients: string[];
      attachments: ResolvedAttachment[];
      what: 'email' | 'reply' | 'forward';
      /** The Sent copy keeps the Bcc header (mailOptions carries bcc). */
      keepBccInSentCopy?: boolean;
    },
  ): Promise<SendResult> {
    // Build the SMTP envelope explicitly — nodemailer cannot derive it from the
    // opaque raw bytes. The RCPT TO list covers every To + Cc + Bcc recipient,
    // de-duped case-insensitively.
    const envelope = {
      from: account.email,
      to: normalizeEnvelopeRecipients(params.recipients),
    };
    if (envelope.to.length === 0) {
      // The tool schema requires `to` (minItems 1); guard anyway so we never
      // hand SMTP an empty RCPT TO list.
      throw new Error(`Cannot send ${params.what}: no recipients (To/Cc/Bcc all empty)`);
    }

    // Les noms de fichiers longs ne sont plus pliés au milieu des guillemets
    // (composeMessage → refoldParamHeaders).
    // Composed once: with keepBccInSentCopy, the Bcc header is kept for the
    // Sent copy and stripped from the transmitted bytes — same Message-ID,
    // same body, so the two cannot drift apart.
    const storedRaw = await composeMessage(params.mailOptions, {
      keepBcc: params.keepBccInSentCopy === true,
    });
    const rawMessage = params.keepBccInSentCopy ? stripBccHeader(storedRaw) : storedRaw;
    assertMessageSize(account, rawMessage.length, params.attachments);

    const result = await transport
      .sendMail({ envelope, raw: rawMessage })
      .catch((error: unknown) => {
        throw explainSmtpSizeRejection(error, account, rawMessage.length);
      });

    // Append the SAME raw bytes to Sent — "one raw message, sent and stored".
    const sentCopy = await this.appendToSentFolder(accountName, storedRaw);

    return {
      messageId: messageIdOfRaw(storedRaw) ?? result.messageId ?? '',
      status: 'sent',
      sentCopy,
    };
  }

  private static withWarnings(result: SendResult, warnings: string[]): SendResult {
    if (warnings.length === 0) return result;
    return { ...result, warnings: [...(result.warnings ?? []), ...warnings] };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Sent folder helpers
  // -------------------------------------------------------------------------

  /**
   * Dépose une copie dans Envoyés. Ne lève jamais : le message est déjà parti,
   * et annoncer un échec pousserait l'appelant à le renvoyer en double. Le
   * résultat est RENVOYÉ (il était auparavant avalé par un console.warn) pour
   * que l'outil puisse le signaler et que send_draft garde le brouillon quand
   * la copie a échoué.
   */
  private async appendToSentFolder(
    accountName: string,
    rawMessage: string | Buffer,
  ): Promise<SentCopyResult> {
    const account = this.connections.getAccount(accountName);

    // Skip if disabled in config
    if (account.saveToSent === false) {
      return { kind: 'skipped', reason: 'save_to_sent is disabled for this account' };
    }

    // Skip Gmail (auto-saves via SMTP)
    if (isGmailAccount(account) && account.gmailAutoSave !== false) {
      return { kind: 'skipped', reason: 'Gmail files the sent copy itself' };
    }

    try {
      await this.imapService.appendToSent(accountName, rawMessage);
      return { kind: 'filed' };
    } catch (error) {
      // Log warning but do not throw — SMTP send already succeeded
      // eslint-disable-next-line no-console
      console.warn(`Failed to save to Sent folder for ${accountName}:`, error);
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  /**
   * Send an existing draft. The id arrives in its wire shape — a UID on IMAP, an
   * opaque string on a Graph account — but only IMAP ids reach here, the router
   * sending Graph accounts to the Graph send service.
   *
   * Après un envoi SMTP réussi, plus rien ne lève (inspiré de la PR
   * codefuturist #108) : un échec rapporté inviterait à renvoyer, donc à
   * livrer le message en double. L'issue est décrite dans le résultat :
   *   - copie Envoyés en échec → brouillon GARDÉ (`draftCleanup.kind = 'kept'`) :
   *     le supprimer effacerait la seule trace locale du message ;
   *   - suppression du brouillon en échec → succès + `draftCleanup.kind = 'failed'`.
   */
  async sendDraft(
    accountName: string,
    draftIdInput: number | string,
    mailbox?: string,
    /** See sendEmail: file the draft as written, Bcc header included, in Sent. */
    options: { bccInSentCopy?: boolean } = {},
  ): Promise<SendResult> {
    const draftId =
      typeof draftIdInput === 'number' ? draftIdInput : Number.parseInt(draftIdInput, 10);
    if (!Number.isFinite(draftId)) {
      throw new Error(
        `Invalid draft id "${String(draftIdInput)}" for an IMAP account: expected a numeric UID.`,
      );
    }
    this.checkRateLimit(accountName);

    // Fetch the parsed draft for its recipient addresses (and the resolved
    // Drafts mailbox path)…
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    // …and the FULL raw bytes so attachments are sent as-is (recomposing from
    // the parsed Email loses attachment binaries — that was the bug).
    const rawBuffer = await this.imapService.fetchDraftRaw(accountName, draftId, draftsPath);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    // Build the SMTP envelope from the parsed draft. Bcc lives only in the
    // envelope; it is stripped from the transmitted/stored message below.
    const toAddrs = draft.to.map((a) => a.address);
    const ccAddrs = (draft.cc ?? []).map((a) => a.address);
    const bccAddrs = (draft.bcc ?? []).map((a) => a.address);

    // Normalize the RCPT TO list (drop blanks, de-dupe case-insensitively,
    // preserve first-seen order). See {@link normalizeEnvelopeRecipients}.
    const recipients = normalizeEnvelopeRecipients([...toAddrs, ...ccAddrs, ...bccAddrs]);
    const envelope = { from: account.email, to: recipients };

    if (envelope.to.length === 0) {
      throw new Error('Draft has no recipients (To/Cc/Bcc all empty)');
    }

    // Strip the Bcc header so blind recipients never leak into the delivered
    // message or the Sent copy. Threading headers (In-Reply-To/References) and
    // Message-ID/Date are already embedded in the raw bytes — leave them as-is.
    const sanitizedRaw = stripBccHeader(rawBuffer);

    // Taille totale contrôlée avant l'envoi si le compte fixe `max_message_mb` ;
    // en cas de refus, le brouillon reste intact.
    assertMessageSize(account, sanitizedRaw.length);

    // When sending pre-composed raw bytes, nodemailer cannot derive the SMTP
    // envelope from the opaque message — pass it explicitly (mirrors
    // replyToEmail) so the RCPT TO list covers every To + Cc + Bcc recipient.
    const result = await transport
      .sendMail({ envelope, raw: sanitizedRaw })
      .catch((error: unknown) => {
        throw explainSmtpSizeRejection(error, account, sanitizedRaw.length);
      });

    // Append the SAME sanitized bytes to Sent BEFORE deleting the draft —
    // "one raw message, sent and stored".
    const sentCopy = await this.appendToSentFolder(
      accountName,
      options.bccInSentCopy ? rawBuffer : sanitizedRaw,
    );

    let draftCleanup: DraftCleanupResult;
    if (sentCopy.kind === 'failed') {
      draftCleanup = {
        kind: 'kept',
        reason: 'the copy to the Sent folder failed, so the draft is the only local copy left',
      };
    } else {
      try {
        await this.imapService.deleteDraft(accountName, draftId, draftsPath);
        draftCleanup = { kind: 'removed' };
      } catch (err) {
        draftCleanup = { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      messageId: messageIdOfRaw(rawBuffer) ?? result.messageId ?? '',
      status: 'sent',
      sentCopy,
      draftCleanup,
    };
  }
}
