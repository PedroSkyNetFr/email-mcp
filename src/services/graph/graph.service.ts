/**
 * Microsoft Graph mail backend (read path).
 *
 * Serves accounts declared with `backend = "graph"`. Exchange Online and
 * Outlook.com only publish a legacy subset of a mailbox over IMAP — custom
 * folders are frequently absent from `LIST` altogether — so Graph is the only
 * way to see and read such a mailbox in full.
 *
 * Method signatures mirror {@link ImapService} so the router can substitute one
 * for the other per account. Two impedance mismatches are worth knowing about:
 *
 *   - Identifiers. IMAP uses numeric UIDs; Graph uses long opaque ids. Both are
 *     opaque strings at the tool boundary, so ids flow through unchanged — but
 *     a Graph id is only meaningful to a Graph account.
 *   - Folders. Tools address mailboxes by path ("NISSAN/Reçu nissan"); Graph
 *     addresses them by id. The folder tree is walked once and cached to
 *     translate between the two.
 */

import type {
  AccountConfig,
  BatchEmailSaveResult,
  BulkResult,
  Email,
  EmailAddress,
  EmailHeaderDump,
  EmailMeta,
  EmailSaveResult,
  LabelInfo,
  Mailbox,
  PaginatedResult,
} from '../../types/index.js';
import type { HeaderEntry } from '../../utils/headers.js';
import {
  analyzeHeaders,
  flattenHeaders,
  groupHeaders,
  parseHeaderBlock,
  splitHeaderBlock,
} from '../../utils/headers.js';
import type { AttachmentInput, ResolvedAttachment } from '../attachment-resolver.js';
import { resolveAttachments } from '../attachment-resolver.js';
import {
  assertSafeDestination,
  defaultEmlFilename,
  exportSubfolder,
  resolveUniquePath,
  sanitizeFilename,
} from '../file-paths.js';
import type ImapService from '../imap.service.js';
import { applyLiteralFilters } from '../search-criteria.js';
import { applyAccountSignature } from '../signature-loader.js';
import type GraphClient from './graph.client.js';

/** Graph mailFolder subset we rely on. */
interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  childFolderCount?: number;
  wellKnownName?: string | null;
}

/** Graph message subset we rely on. */
interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string; address?: string } } | null;
  sender?: { emailAddress?: { name?: string; address?: string } } | null;
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  bccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string } | null;
  hasAttachments?: boolean;
  bodyPreview?: string;
  categories?: string[];
  internetMessageId?: string;
  body?: { contentType?: string; content?: string } | null;
  internetMessageHeaders?: { name: string; value: string }[];
}

interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
}

/** Fields needed to build an EmailMeta — kept narrow to limit payload size. */
const META_SELECT =
  'id,subject,from,toRecipients,receivedDateTime,isRead,flag,hasAttachments,bodyPreview,categories';
// `internetMessageHeaders` fait partie de la sélection complète : sans lui,
// Graph ne renvoie rien et `Email.headers` restait systématiquement vide sur un
// compte Graph, là où le backend IMAP le remplit. Graph ne sert cette propriété
// que sur la lecture d'UN message avec `$select` explicite — d'où son absence
// de `META_SELECT`, qui sert aux listes.
const FULL_SELECT = `${META_SELECT},ccRecipients,bccRecipients,sentDateTime,internetMessageId,body,internetMessageHeaders`;

/**
 * Convertit la liste d'en-têtes de Graph vers la représentation partagée avec
 * le backend IMAP. Graph rend déjà chaque en-tête déplié et conserve les
 * occurrences répétées, il n'y a donc rien à analyser — seulement à
 * réétiqueter.
 */
function toHeaderEntries(headers: { name: string; value: string }[] | undefined): HeaderEntry[] {
  return (headers ?? []).map((header) => ({
    name: header.name,
    key: header.name.toLowerCase(),
    value: header.value,
  }));
}

function toAddress(
  input?: { emailAddress?: { name?: string; address?: string } } | null,
): EmailAddress {
  return {
    name: input?.emailAddress?.name,
    address: input?.emailAddress?.address ?? '',
  };
}

function toAddresses(
  input?: { emailAddress?: { name?: string; address?: string } }[],
): EmailAddress[] {
  return (input ?? []).map((entry) => toAddress(entry));
}

/** Map the Graph well-known folder name onto the IMAP special-use flag. */
function specialUseOf(folder: GraphFolder): string | undefined {
  const map: Record<string, string> = {
    inbox: '\\Inbox',
    sentitems: '\\Sent',
    drafts: '\\Drafts',
    deleteditems: '\\Trash',
    junkemail: '\\Junk',
    archive: '\\Archive',
  };
  return folder.wellKnownName ? map[folder.wellKnownName.toLowerCase()] : undefined;
}

export function toEmailMeta(message: GraphMessage): EmailMeta {
  return {
    id: message.id,
    subject: message.subject ?? '',
    from: toAddress(message.from ?? message.sender),
    to: toAddresses(message.toRecipients),
    date: message.receivedDateTime ?? message.sentDateTime ?? '',
    seen: message.isRead ?? false,
    flagged: message.flag?.flagStatus === 'flagged',
    // Graph exposes no per-message "answered" equivalent; IMAP's \Answered has
    // no counterpart, so it is reported as false rather than guessed.
    answered: false,
    hasAttachments: message.hasAttachments ?? false,
    labels: message.categories ?? [],
    preview: message.bodyPreview,
  };
}

export default class GraphService {
  /** path -> folder, rebuilt on demand. */
  private folderCache = new Map<string, GraphFolder>();

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
  // Folders
  // -------------------------------------------------------------------------

  /** Walk the folder tree, recording "Parent/Child" paths for every node. */
  private async walkFolders(
    accountName: string,
    url: string,
    prefix: string,
    depth: number,
    out: { path: string; folder: GraphFolder }[],
  ): Promise<void> {
    if (depth > 8) return;
    const folders = await this.client(accountName).collect<GraphFolder>(url);

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- depth-first walk, and Graph throttles bursts */
    for (const folder of folders) {
      const full = prefix ? `${prefix}/${folder.displayName}` : folder.displayName;
      out.push({ path: full, folder });
      if ((folder.childFolderCount ?? 0) > 0) {
        await this.walkFolders(
          accountName,
          `/me/mailFolders/${folder.id}/childFolders?$top=100`,
          full,
          depth + 1,
          out,
        );
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */
  }

  private async loadFolders(accountName: string): Promise<{ path: string; folder: GraphFolder }[]> {
    const out: { path: string; folder: GraphFolder }[] = [];
    await this.walkFolders(
      accountName,
      '/me/mailFolders?$top=100&includeHiddenFolders=true',
      '',
      0,
      out,
    );
    this.folderCache = new Map(out.map((entry) => [entry.path, entry.folder]));
    return out;
  }

  /**
   * Translate a mailbox path into a Graph folder id.
   *
   * "INBOX" is accepted case-insensitively and mapped to the well-known inbox,
   * so tools that default to the IMAP name keep working. Matching is otherwise
   * case-insensitive on the full path.
   */
  private async resolveFolderId(accountName: string, mailbox: string): Promise<string> {
    if (/^inbox$/i.test(mailbox)) return 'inbox';

    const entries = this.folderCache.size
      ? [...this.folderCache.entries()].map(([path, folder]) => ({ path, folder }))
      : await this.loadFolders(accountName);

    const wanted = mailbox.replace(/^\/+|\/+$/g, '').toLowerCase();
    const hit =
      entries.find((entry) => entry.path.toLowerCase() === wanted) ??
      // Tolerate an IMAP-style separator or a bare leaf name.
      entries.find((entry) => entry.path.replace(/\./g, '/').toLowerCase() === wanted) ??
      entries.find((entry) => entry.folder.displayName.toLowerCase() === wanted);

    if (!hit) {
      const available = entries
        .slice(0, 20)
        .map((entry) => entry.path)
        .join(', ');
      throw new Error(`Mailbox "${mailbox}" not found. Available: ${available}`);
    }
    return hit.folder.id;
  }

  async listMailboxes(accountName: string): Promise<Mailbox[]> {
    const entries = await this.loadFolders(accountName);
    return entries.map(({ path, folder }) => ({
      name: folder.displayName,
      path,
      specialUse: specialUseOf(folder),
      totalMessages: folder.totalItemCount ?? 0,
      unseenMessages: folder.unreadItemCount ?? 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async listEmails(
    accountName: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      seen?: boolean;
      flagged?: boolean;
      hasAttachment?: boolean;
      from?: string;
      subject?: string;
      since?: string;
      before?: string;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    const folderId = await this.resolveFolderId(accountName, options.mailbox ?? 'INBOX');

    // Graph filters are OData; only the subset with a faithful translation is
    // applied here, so a filter is never silently reinterpreted.
    const filters: string[] = [];
    if (options.seen !== undefined) filters.push(`isRead eq ${options.seen ? 'true' : 'false'}`);
    if (options.hasAttachment !== undefined) {
      filters.push(`hasAttachments eq ${options.hasAttachment ? 'true' : 'false'}`);
    }
    if (options.since) filters.push(`receivedDateTime ge ${new Date(options.since).toISOString()}`);
    if (options.before) {
      filters.push(`receivedDateTime lt ${new Date(options.before).toISOString()}`);
    }
    if (options.from) {
      filters.push(`from/emailAddress/address eq '${options.from.replace(/'/g, "''")}'`);
    }

    const query = [
      `$select=${META_SELECT}`,
      '$orderby=receivedDateTime desc',
      `$top=${pageSize}`,
      `$skip=${(page - 1) * pageSize}`,
      '$count=true',
      ...(filters.length ? [`$filter=${encodeURIComponent(filters.join(' and '))}`] : []),
    ].join('&');

    const response = await this.client(accountName).request<{
      value: GraphMessage[];
      '@odata.count'?: number;
    }>('GET', `/me/mailFolders/${folderId}/messages?${query}`);

    const items = response.value.map(toEmailMeta);
    const total = response['@odata.count'] ?? items.length;
    return {
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  async getEmail(accountName: string, emailId: string, _mailbox = 'INBOX'): Promise<Email> {
    const client = this.client(accountName);
    const message = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=${FULL_SELECT}`,
    );

    const attachments = message.hasAttachments
      ? await client.collect<GraphAttachment>(
          `/me/messages/${emailId}/attachments?$select=id,name,contentType,size`,
        )
      : [];

    const isHtml = (message.body?.contentType ?? '').toLowerCase() === 'html';
    const content = message.body?.content ?? '';

    return {
      ...toEmailMeta(message),
      cc: toAddresses(message.ccRecipients),
      bcc: toAddresses(message.bccRecipients),
      ...(isHtml ? { bodyHtml: content } : { bodyText: content }),
      messageId: message.internetMessageId ?? '',
      attachments: attachments.map((a) => ({
        filename: a.name ?? 'unnamed',
        mimeType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? 0,
      })),
      // Même aplatissement que le backend IMAP (la dernière occurrence gagne) ;
      // la chaîne Received complète s'obtient via `getEmailHeaders`.
      headers: flattenHeaders(toHeaderEntries(message.internetMessageHeaders)),
    };
  }

  async getEmailFlags(
    accountName: string,
    emailId: string,
    _mailbox = 'INBOX',
  ): Promise<{
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    labels: string[];
    subject: string;
    from: string;
    date: string;
  }> {
    const message = await this.client(accountName).request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=id,subject,from,receivedDateTime,isRead,flag,categories`,
    );
    const meta = toEmailMeta(message);
    return {
      seen: meta.seen,
      flagged: meta.flagged,
      answered: meta.answered,
      labels: meta.labels,
      subject: meta.subject,
      from: meta.from.address,
      date: meta.date,
    };
  }

  /**
   * Full-text search. Graph's `$search` covers the whole message (subject, body,
   * participants) and, unlike IMAP SEARCH, cannot be combined with `$filter` or
   * with `$orderby` — so a free-text query is served by `$search` alone, and the
   * structured filters are applied only when no query text is given. Mixing them
   * silently would drop half the criteria.
   */
  async searchEmails(
    accountName: string,
    query: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      from?: string;
      to?: string;
      subject?: string;
      since?: string;
      before?: string;
      seen?: boolean;
      flagged?: boolean;
      hasAttachment?: boolean;
      fromContains?: string;
      toContains?: string;
      subjectContains?: string;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const text = [query, options.subject, options.from, options.to]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!text) {
      const listed = await this.listEmails(accountName, options);
      return { ...listed, items: applyLiteralFilters(listed.items, options) };
    }

    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    const folderId = await this.resolveFolderId(accountName, options.mailbox ?? 'INBOX');

    // $search rejects $skip (Graph answers 400), so paging is done by taking the
    // first page*pageSize matches and keeping the last slice. $top is capped at
    // 250 for a search, which bounds how deep paging can go.
    const wanted = Math.min(page * pageSize, 250);
    const response = await this.client(accountName).request<{
      value: GraphMessage[];
    }>(
      'GET',
      `/me/mailFolders/${folderId}/messages?$select=${META_SELECT}` +
        `&$search=${encodeURIComponent(`"${text}"`)}` +
        `&$top=${wanted}`,
    );

    // `$search` matches indexed tokens, exactly like the IMAP full-text case, so
    // the literal filters are applied here too — same result on both backends.
    const all = applyLiteralFilters(response.value.map(toEmailMeta), options);
    const items = all.slice((page - 1) * pageSize, page * pageSize);
    return {
      items,
      total: all.length,
      page,
      pageSize,
      hasMore: all.length >= wanted && wanted < 250,
      // Graph reports no match count alongside $search, and the 250 cap means a
      // deeper result set is invisible — the total is a floor, not a count.
      totalApprox: true,
    };
  }

  // -------------------------------------------------------------------------
  // Categories — the Graph equivalent of IMAP keywords / labels
  // -------------------------------------------------------------------------

  async listLabels(accountName: string): Promise<LabelInfo[]> {
    const categories = await this.client(accountName).collect<{ displayName: string }>(
      '/me/outlook/masterCategories',
    );
    return categories.map((category) => ({
      name: category.displayName,
      strategy: 'keyword' as LabelInfo['strategy'],
    }));
  }

  /** Categories live on the message as a whole array, so it is read then rewritten. */
  private async setCategories(
    accountName: string,
    emailId: string,
    update: (current: string[]) => string[],
  ): Promise<void> {
    const client = this.client(accountName);
    const message = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=categories`,
    );
    const next = update(message.categories ?? []);
    await client.request('PATCH', `/me/messages/${emailId}`, { categories: next });
  }

  async addLabel(
    accountName: string,
    emailId: string,
    _mailbox: string,
    label: string,
  ): Promise<void> {
    await this.setCategories(accountName, emailId, (current) =>
      current.includes(label) ? current : [...current, label],
    );
  }

  async removeLabel(
    accountName: string,
    emailId: string,
    _mailbox: string,
    label: string,
  ): Promise<void> {
    await this.setCategories(accountName, emailId, (current) =>
      current.filter((entry) => entry !== label),
    );
  }

  async createLabel(accountName: string, name: string): Promise<void> {
    await this.client(accountName).request('POST', '/me/outlook/masterCategories', {
      displayName: name,
      color: 'preset0',
    });
  }

  async deleteLabel(accountName: string, name: string): Promise<void> {
    const categories = await this.client(accountName).collect<{
      id: string;
      displayName: string;
    }>('/me/outlook/masterCategories');
    const match = categories.find((category) => category.displayName === name);
    if (!match) throw new Error(`Category "${name}" not found`);
    await this.client(accountName).request('DELETE', `/me/outlook/masterCategories/${match.id}`);
  }

  // -------------------------------------------------------------------------
  // Message state
  // -------------------------------------------------------------------------

  async setFlags(
    accountName: string,
    emailId: string,
    _mailbox: string,
    action: 'read' | 'unread' | 'flag' | 'unflag',
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      read: { isRead: true },
      unread: { isRead: false },
      flag: { flag: { flagStatus: 'flagged' } },
      unflag: { flag: { flagStatus: 'notFlagged' } },
    }[action];

    await this.client(accountName).request('PATCH', `/me/messages/${emailId}`, patch);
  }

  async moveEmail(
    accountName: string,
    emailId: string,
    _sourceMailbox: string,
    destinationMailbox: string,
  ): Promise<void> {
    const destinationId = await this.resolveFolderId(accountName, destinationMailbox);
    await this.client(accountName).request('POST', `/me/messages/${emailId}/move`, {
      destinationId,
    });
  }

  /**
   * Delete a message. The default moves it to Deleted Items, mirroring the IMAP
   * path; `permanent` issues a real DELETE, which Graph does not undo.
   */
  async deleteEmail(
    accountName: string,
    emailId: string,
    _mailbox = 'INBOX',
    permanent = false,
  ): Promise<void> {
    const client = this.client(accountName);
    if (permanent) {
      await client.request('DELETE', `/me/messages/${emailId}`);
      return;
    }
    await client.request('POST', `/me/messages/${emailId}/move`, {
      destinationId: 'deleteditems',
    });
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  /**
   * Apply a per-message operation across ids, collecting failures instead of
   * aborting. Graph has no multi-message verb, so this is genuinely one request
   * per id; they are issued sequentially because Graph throttles parallel bursts
   * hard enough that a batch would end up slower.
   */
  private static async runBulk(
    ids: (number | string)[],
    operation: (id: string) => Promise<void>,
  ): Promise<BulkResult> {
    const result: BulkResult = { total: ids.length, succeeded: 0, failed: 0, errors: [] };

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential on purpose, see above */
    for (const id of ids) {
      try {
        await operation(String(id));
        result.succeeded += 1;
      } catch (err) {
        result.failed += 1;
        result.errors?.push(`${String(id)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return result;
  }

  async bulkSetFlags(
    accountName: string,
    ids: (number | string)[],
    mailbox: string,
    action: 'mark_read' | 'mark_unread' | 'flag' | 'unflag',
  ): Promise<BulkResult> {
    const single = { mark_read: 'read', mark_unread: 'unread', flag: 'flag', unflag: 'unflag' }[
      action
    ] as 'read' | 'unread' | 'flag' | 'unflag';
    return GraphService.runBulk(ids, async (id) => this.setFlags(accountName, id, mailbox, single));
  }

  async bulkMove(
    accountName: string,
    ids: (number | string)[],
    mailbox: string,
    destination: string,
  ): Promise<BulkResult> {
    return GraphService.runBulk(ids, async (id) =>
      this.moveEmail(accountName, id, mailbox, destination),
    );
  }

  async bulkDelete(
    accountName: string,
    ids: (number | string)[],
    mailbox: string,
    permanent = false,
  ): Promise<BulkResult> {
    return GraphService.runBulk(ids, async (id) =>
      this.deleteEmail(accountName, id, mailbox, permanent),
    );
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  /**
   * Every message sharing the conversation. Graph tracks `conversationId`
   * natively, so no References/In-Reply-To reconstruction is needed.
   */
  async getThread(accountName: string, emailId: string, _mailbox = 'INBOX'): Promise<EmailMeta[]> {
    const client = this.client(accountName);
    const message = await client.request<GraphMessage & { conversationId?: string }>(
      'GET',
      `/me/messages/${emailId}?$select=conversationId`,
    );
    if (!message.conversationId) return [];

    const filter = encodeURIComponent(`conversationId eq '${message.conversationId}'`);
    const messages = await client.collect<GraphMessage>(
      `/me/messages?$select=${META_SELECT}&$filter=${filter}&$orderby=receivedDateTime asc&$top=100`,
    );
    return messages.map(toEmailMeta);
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  async saveDraft(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: { filename: string; content: Buffer; contentType: string; cid?: string }[];
    },
  ): Promise<{ id: number | string; mailbox: string }> {
    const recipients = (addresses?: string[]) =>
      (addresses ?? [])
        .map((address) => address.trim())
        .filter(Boolean)
        .map((address) => ({ emailAddress: { address } }));

    const created = await this.client(accountName).request<{ id: string }>('POST', '/me/messages', {
      subject: options.subject,
      body: { contentType: options.html ? 'HTML' : 'Text', content: options.body },
      toRecipients: recipients(options.to),
      ccRecipients: recipients(options.cc),
      bccRecipients: recipients(options.bcc),
      ...(options.attachments?.length
        ? {
            attachments: options.attachments.map((attachment) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: attachment.filename,
              contentType: attachment.contentType,
              contentBytes: attachment.content.toString('base64'),
              ...(attachment.cid ? { isInline: true, contentId: attachment.cid } : {}),
            })),
          }
        : {}),
    });

    // Graph files new messages in Drafts itself; the id is opaque, not a UID.
    return { id: created.id, mailbox: 'Drafts' };
  }

  /**
   * Resolve polymorphic attachment inputs into in-memory bytes for an outbound
   * send. Same strict contract as the IMAP service: one failure aborts the whole
   * operation rather than sending a message missing what the caller attached.
   */
  async resolveAttachmentsForSend(
    accountName: string,
    attachments: AttachmentInput[],
  ): Promise<ResolvedAttachment[]> {
    if (attachments.length === 0) return [];
    const result = await resolveAttachments(
      this as unknown as ImapService,
      accountName,
      attachments,
    );
    if (result.failures.length > 0) {
      const summary = result.failures.map((f) => `${f.label}: ${f.reason}`).join('; ');
      throw new Error(`Failed to resolve ${result.failures.length} attachment(s): ${summary}`);
    }
    return result.resolved;
  }

  /**
   * Entry point used by the save_draft tool: resolves the polymorphic attachment
   * inputs, then creates the draft.
   *
   * The resolver only needs a `downloadAttachment` to carry an attachment over
   * from another message, and this service provides exactly that — so it stands
   * in for the IMAP service rather than reimplementing the resolution.
   */
  async saveDraftWithAttachments(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: AttachmentInput[];
      appendSignature?: boolean;
    },
  ): Promise<{ id: number | string; mailbox: string }> {
    let resolved: ResolvedAttachment[] = [];
    if (options.attachments?.length) {
      const result = await resolveAttachments(
        this as unknown as ImapService,
        accountName,
        options.attachments,
      );
      if (result.failures.length > 0) {
        const summary = result.failures.map((f) => `${f.label}: ${f.reason}`).join('; ');
        throw new Error(`Failed to resolve ${result.failures.length} attachment(s): ${summary}`);
      }
      resolved = result.resolved;
    }

    const signed = await applyAccountSignature(
      this.getAccount(accountName),
      { body: options.body, html: options.html, attachments: resolved },
      options.appendSignature,
    );

    return this.saveDraft(accountName, {
      to: options.to,
      subject: options.subject,
      body: signed.body,
      cc: options.cc,
      bcc: options.bcc,
      html: signed.html,
      attachments: signed.attachments,
    });
  }

  /**
   * Update a draft in place.
   *
   * Graph PATCHes the existing message, so — unlike the IMAP path, which must
   * append a rebuilt copy and delete the original — no new id appears and
   * nothing is deleted. The result keeps the IMAP shape so callers do not have
   * to branch, with `id` equal to `oldId` and a note saying so.
   */
  async updateDraft(
    accountName: string,
    draftId: number | string,
    options: {
      mailbox?: string;
      subject?: string;
      body?: string;
      html?: boolean;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      attachmentsAdd?: AttachmentInput[];
      attachmentsRemove?: string[];
    },
  ): Promise<{
    id: number | string;
    mailbox: string;
    oldId: number | string;
    oldDraftDeleted: boolean;
    warnings: string[];
  }> {
    const client = this.client(accountName);
    const id = String(draftId);
    const warnings: string[] = [];

    const recipients = (addresses?: string[]) =>
      addresses
        ?.map((address) => address.trim())
        .filter(Boolean)
        .map((address) => ({ emailAddress: { address } }));

    const patch: Record<string, unknown> = {};
    if (options.subject !== undefined) patch.subject = options.subject;
    if (options.body !== undefined) {
      patch.body = { contentType: options.html ? 'HTML' : 'Text', content: options.body };
    }
    if (options.to) patch.toRecipients = recipients(options.to);
    if (options.cc) patch.ccRecipients = recipients(options.cc);
    if (options.bcc) patch.bccRecipients = recipients(options.bcc);

    if (Object.keys(patch).length > 0) {
      await client.request('PATCH', `/me/messages/${id}`, patch);
    }

    // Attachments are separate resources on Graph: removals and additions are
    // applied to the existing message rather than rebuilt wholesale, so
    // untouched ones simply stay.
    if (options.attachmentsRemove?.length) {
      const existing = await client.collect<GraphAttachment>(
        `/me/messages/${id}/attachments?$select=id,name`,
      );
      const doomed = existing.filter((a) => options.attachmentsRemove?.includes(a.name ?? ''));
      options.attachmentsRemove.forEach((name) => {
        if (!existing.some((a) => a.name === name)) {
          warnings.push(`attachments_remove named "${name}" but the draft has no such attachment`);
        }
      });
      /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential: Graph throttles bursts */
      for (const attachment of doomed) {
        await client.request('DELETE', `/me/messages/${id}/attachments/${attachment.id}`);
      }
      /* eslint-enable no-restricted-syntax, no-await-in-loop */
    }

    if (options.attachmentsAdd?.length) {
      const resolved = await this.resolveAttachmentsForSend(accountName, options.attachmentsAdd);
      /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential: Graph throttles bursts */
      for (const attachment of resolved) {
        await client.request('POST', `/me/messages/${id}/attachments`, {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: attachment.filename,
          contentType: attachment.contentType,
          contentBytes: attachment.content.toString('base64'),
          ...(attachment.cid ? { isInline: true, contentId: attachment.cid } : {}),
        });
      }
      /* eslint-enable no-restricted-syntax, no-await-in-loop */
    }

    warnings.push(
      'Draft updated in place (Graph); its id is unchanged and no copy was left behind.',
    );
    return {
      id,
      mailbox: options.mailbox ?? 'Drafts',
      oldId: id,
      oldDraftDeleted: false,
      warnings,
    };
  }

  async deleteDraft(accountName: string, draftId: number | string): Promise<void> {
    await this.client(accountName).request('DELETE', `/me/messages/${String(draftId)}`);
  }

  // -------------------------------------------------------------------------
  // Server-side rules — no IMAP equivalent exists
  // -------------------------------------------------------------------------

  /**
   * Inbox rules run on the server, so they keep sorting mail when nothing of
   * ours is running. IMAP has no equivalent at all: this is Graph-only.
   */
  async listMessageRules(accountName: string): Promise<
    {
      id: string;
      displayName: string;
      sequence: number;
      isEnabled: boolean;
      conditions: Record<string, unknown>;
      actions: Record<string, unknown>;
    }[]
  > {
    return this.client(accountName).collect('/me/mailFolders/inbox/messageRules');
  }

  /**
   * Create an inbox rule. Conditions and actions follow the Graph shapes; the
   * destination folder is given as a path and translated to its id here, since
   * a caller should not have to know Graph's opaque identifiers.
   */
  async createMessageRule(
    accountName: string,
    input: {
      displayName: string;
      sequence?: number;
      isEnabled?: boolean;
      fromAddresses?: string[];
      subjectContains?: string[];
      bodyContains?: string[];
      moveToMailbox?: string;
      markAsRead?: boolean;
      markImportance?: 'low' | 'normal' | 'high';
      delete?: boolean;
      stopProcessingRules?: boolean;
    },
  ): Promise<{ id: string; displayName: string }> {
    const conditions: Record<string, unknown> = {};
    if (input.fromAddresses?.length) {
      conditions.senderContains = input.fromAddresses;
    }
    if (input.subjectContains?.length) conditions.subjectContains = input.subjectContains;
    if (input.bodyContains?.length) conditions.bodyContains = input.bodyContains;

    const actions: Record<string, unknown> = {};
    if (input.moveToMailbox) {
      actions.moveToFolder = await this.resolveFolderId(accountName, input.moveToMailbox);
    }
    if (input.markAsRead) actions.markAsRead = true;
    if (input.markImportance) actions.markImportance = input.markImportance;
    if (input.delete) actions.delete = true;
    actions.stopProcessingRules = input.stopProcessingRules ?? false;

    if (Object.keys(conditions).length === 0) {
      throw new Error('A rule needs at least one condition (from, subject or body).');
    }
    if (Object.keys(actions).length <= 1) {
      throw new Error('A rule needs at least one action (move, mark read, importance or delete).');
    }

    return this.client(accountName).request('POST', '/me/mailFolders/inbox/messageRules', {
      displayName: input.displayName,
      sequence: input.sequence ?? 1,
      isEnabled: input.isEnabled ?? true,
      conditions,
      actions,
    });
  }

  async deleteMessageRule(accountName: string, ruleId: string): Promise<void> {
    await this.client(accountName).request(
      'DELETE',
      `/me/mailFolders/inbox/messageRules/${ruleId}`,
    );
  }

  // -------------------------------------------------------------------------
  // Automatic replies (out of office)
  // -------------------------------------------------------------------------

  async getAutomaticReplies(accountName: string): Promise<{
    status: string;
    scheduledStartDateTime?: { dateTime: string; timeZone: string };
    scheduledEndDateTime?: { dateTime: string; timeZone: string };
    internalReplyMessage?: string;
    externalReplyMessage?: string;
    externalAudience?: string;
  }> {
    // The sub-resource returns the setting object itself (plus @odata.context),
    // not a wrapper, so it maps straight onto the result.
    return this.client(accountName).request('GET', '/me/mailboxSettings/automaticRepliesSetting');
  }

  /**
   * Turn the out-of-office reply on or off. `scheduled` requires both dates;
   * `alwaysEnabled` ignores them. Times are ISO strings with an explicit zone,
   * because Graph rejects a naive local time.
   */
  async setAutomaticReplies(
    accountName: string,
    input: {
      status: 'disabled' | 'alwaysEnabled' | 'scheduled';
      internalReplyMessage?: string;
      externalReplyMessage?: string;
      externalAudience?: 'none' | 'contactsOnly' | 'all';
      startDateTime?: string;
      endDateTime?: string;
      timeZone?: string;
    },
  ): Promise<void> {
    if (input.status === 'scheduled' && !(input.startDateTime && input.endDateTime)) {
      throw new Error('A scheduled automatic reply needs both startDateTime and endDateTime.');
    }

    const timeZone = input.timeZone ?? 'UTC';
    const setting: Record<string, unknown> = {
      status: input.status,
      externalAudience: input.externalAudience ?? 'all',
      ...(input.internalReplyMessage ? { internalReplyMessage: input.internalReplyMessage } : {}),
      ...(input.externalReplyMessage ? { externalReplyMessage: input.externalReplyMessage } : {}),
      ...(input.status === 'scheduled'
        ? {
            scheduledStartDateTime: { dateTime: input.startDateTime, timeZone },
            scheduledEndDateTime: { dateTime: input.endDateTime, timeZone },
          }
        : {}),
    };

    await this.client(accountName).request('PATCH', '/me/mailboxSettings', {
      automaticRepliesSetting: setting,
    });
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * Flat result set for the export tool. Only the single-account shape is
   * served here — the router refuses a call spanning both backends, so
   * `accountNames` never arrives with a Graph account mixed in.
   */
  async searchForExport(
    accountNames: string[] | null,
    accountName: string | null,
    query: string,
    options: { maxRows: number; mailbox?: string; [key: string]: unknown },
  ): Promise<{ items: EmailMeta[]; truncated: boolean }> {
    const names = accountNames ?? (accountName ? [accountName] : []);
    if (names.length === 0) {
      throw new Error('searchForExport requires at least one account name');
    }

    const { maxRows } = options;
    const collected: EmailMeta[] = [];
    let truncated = false;

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- one account at a time, Graph throttles */
    for (const name of names) {
      let page = 1;
      // Graph caps a page at 1000; walk pages until the row budget is reached.
      while (collected.length < maxRows) {
        const pageSize = Math.min(100, maxRows - collected.length);
        const result = await this.searchEmails(name, query, {
          ...options,
          page,
          pageSize,
        });
        collected.push(...result.items.map((item) => ({ ...item, account: name })));
        if (!result.hasMore || result.items.length === 0) break;
        page += 1;
      }
      if (collected.length >= maxRows) {
        truncated = true;
        break;
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return { items: collected.slice(0, maxRows), truncated };
  }

  // -------------------------------------------------------------------------
  // Attachments to disk
  // -------------------------------------------------------------------------

  /** Write one resolved attachment, honouring the destination allow-list. */
  private static async writeToDisk(
    payload: { filename: string; mimeType: string; contentBase64: string },
    destination: string,
    overwrite: boolean,
  ): Promise<{
    filename: string;
    localPath: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  }> {
    const { mkdir, stat, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    assertSafeDestination(destination);

    let targetPath: string;
    try {
      const info = await stat(destination);
      targetPath = info.isDirectory()
        ? join(destination, sanitizeFilename(payload.filename))
        : destination;
    } catch {
      targetPath = destination;
    }
    // Re-check the resolved path: the filename component is caller-supplied.
    assertSafeDestination(targetPath);

    const finalPath = await resolveUniquePath(targetPath, overwrite);
    await mkdir(dirname(finalPath), { recursive: true });
    const bytes = Buffer.from(payload.contentBase64, 'base64');
    await writeFile(finalPath, bytes);

    return {
      filename: payload.filename,
      localPath: finalPath,
      fileUrl: pathToFileURL(finalPath).href,
      mimeType: payload.mimeType,
      size: bytes.length,
    };
  }

  async saveAttachmentToDisk(
    accountName: string,
    emailId: string,
    mailbox: string,
    filename: string,
    destination: string,
    overwrite = false,
  ): Promise<{
    filename: string;
    localPath: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  }> {
    const payload = await this.downloadAttachment(accountName, emailId, mailbox, filename);
    return GraphService.writeToDisk(payload, destination, overwrite);
  }

  async saveEmailAttachments(
    accountName: string,
    emailId: string,
    _mailbox: string,
    destDir: string,
    maxSizeBytes = 25 * 1024 * 1024,
  ): Promise<
    { filename: string; localPath: string; fileUrl: string; mimeType: string; size: number }[]
  > {
    const attachments = await this.client(accountName).collect<GraphAttachment>(
      `/me/messages/${emailId}/attachments?$select=id,name,contentType,size`,
    );

    const saved: {
      filename: string;
      localPath: string;
      fileUrl: string;
      mimeType: string;
      size: number;
    }[] = [];

    // Oversized attachments are skipped, matching the IMAP path.
    const withinBudget = attachments.filter((meta) => (meta.size ?? 0) <= maxSizeBytes);

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential: Graph throttles bursts */
    for (const meta of withinBudget) {
      const full = await this.client(accountName).request<GraphAttachment>(
        'GET',
        `/me/messages/${emailId}/attachments/${meta.id}`,
      );
      saved.push(
        await GraphService.writeToDisk(
          {
            filename: full.name ?? 'unnamed',
            mimeType: full.contentType ?? 'application/octet-stream',
            contentBase64: full.contentBytes ?? '',
          },
          destDir,
          false,
        ),
      );
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return saved;
  }

  // -------------------------------------------------------------------------
  // Folder management
  // -------------------------------------------------------------------------

  /** Split "Parent/Child" into its parent path and leaf name. */
  private static splitPath(folderPath: string): { parent?: string; leaf: string } {
    const clean = folderPath.replace(/^\/+|\/+$/g, '');
    const index = clean.lastIndexOf('/');
    if (index < 0) return { leaf: clean };
    return { parent: clean.slice(0, index), leaf: clean.slice(index + 1) };
  }

  async createMailbox(accountName: string, folderPath: string): Promise<void> {
    const { parent, leaf } = GraphService.splitPath(folderPath);
    const base = parent
      ? `/me/mailFolders/${await this.resolveFolderId(accountName, parent)}/childFolders`
      : '/me/mailFolders';
    await this.client(accountName).request('POST', base, { displayName: leaf });
    this.folderCache.clear(); // the tree changed
  }

  async renameMailbox(accountName: string, folderPath: string, newPath: string): Promise<void> {
    const id = await this.resolveFolderId(accountName, folderPath);
    // Graph renames by display name; it cannot reparent through this call, so a
    // path change that moves the folder elsewhere is rejected rather than
    // silently renaming it in place.
    const from = GraphService.splitPath(folderPath);
    const to = GraphService.splitPath(newPath);
    if ((from.parent ?? '') !== (to.parent ?? '')) {
      throw new Error(
        `Graph can rename a folder but not move it: "${folderPath}" and "${newPath}" have ` +
          'different parents.',
      );
    }
    await this.client(accountName).request('PATCH', `/me/mailFolders/${id}`, {
      displayName: to.leaf,
    });
    this.folderCache.clear();
  }

  async deleteMailbox(accountName: string, folderPath: string): Promise<void> {
    const id = await this.resolveFolderId(accountName, folderPath);
    await this.client(accountName).request('DELETE', `/me/mailFolders/${id}`);
    this.folderCache.clear();
  }

  async downloadAttachment(
    accountName: string,
    emailId: string,
    _mailbox: string,
    filename: string,
    maxSizeBytes = 25 * 1024 * 1024,
  ): Promise<{ filename: string; mimeType: string; contentBase64: string; size: number }> {
    const client = this.client(accountName);
    const attachments = await client.collect<GraphAttachment>(
      `/me/messages/${emailId}/attachments?$select=id,name,contentType,size`,
    );
    const match = attachments.find((a) => a.name === filename);
    if (!match) {
      throw new Error(
        `Attachment "${filename}" not found. Available: ${
          attachments.map((a) => a.name).join(', ') || 'none'
        }`,
      );
    }
    if ((match.size ?? 0) > maxSizeBytes) {
      throw new Error(
        `Attachment "${filename}" is ${Math.round((match.size ?? 0) / 1024 / 1024)}MB, exceeds ` +
          `${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
      );
    }

    // Re-fetch the single attachment so contentBytes is included.
    const full = await client.request<GraphAttachment>(
      'GET',
      `/me/messages/${emailId}/attachments/${match.id}`,
    );
    return {
      filename: full.name ?? filename,
      mimeType: full.contentType ?? 'application/octet-stream',
      contentBase64: full.contentBytes ?? '',
      size: full.size ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // En-têtes Internet complets
  // -------------------------------------------------------------------------

  /**
   * En-têtes Internet complets d'un message Graph.
   *
   * Deux sources sont possibles, et l'ordre retenu est un compromis assumé :
   *
   *   1. `internetMessageHeaders` — quelques kilo-octets de JSON, une seule
   *      requête. Graph rend la liste ordonnée et RÉPÉTÉE, donc la chaîne
   *      `Received` est complète. Le bloc brut est reconstruit à partir de
   *      cette liste : les valeurs sont exactes, le pliage d'origine non.
   *   2. `$value` (MIME complet) — fidèle à l'octet, mais télécharge le message
   *      entier, pièces jointes comprises. Utilisé en repli, quand Graph ne
   *      fournit pas la liste (certains éléments de calendrier, messages de
   *      boîtes partagées).
   */
  async getEmailHeaders(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<EmailHeaderDump> {
    const client = this.client(accountName);

    const message = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=internetMessageHeaders`,
    );
    const listed = message.internetMessageHeaders ?? [];

    if (listed.length > 0) {
      const entries = toHeaderEntries(listed);
      return {
        emailId,
        account: accountName,
        mailbox,
        raw: entries.map((entry) => `${entry.name}: ${entry.value}`).join('\r\n'),
        entries,
        grouped: groupHeaders(entries),
        analysis: analyzeHeaders(entries),
        rawReconstructed: true,
      };
    }

    const raw = splitHeaderBlock(await client.getBinary(`/me/messages/${emailId}/$value`));
    const entries = parseHeaderBlock(raw);
    return {
      emailId,
      account: accountName,
      mailbox,
      raw,
      entries,
      grouped: groupHeaders(entries),
      analysis: analyzeHeaders(entries),
    };
  }

  // -------------------------------------------------------------------------
  // Export du message au format .eml
  // -------------------------------------------------------------------------

  /**
   * Source MIME complète du message (`GET /messages/{id}/$value`).
   *
   * Ce sont les octets tels qu'Exchange les a reçus : c'est ce qui rend le
   * `.eml` exploitable comme preuve (signatures DKIM et chaîne `Received`
   * intactes), à la différence d'un message reconstruit depuis les propriétés
   * Graph.
   */
  async getEmailRaw(accountName: string, emailId: string, _mailbox = 'INBOX'): Promise<Buffer> {
    return this.client(accountName).getBinary(`/me/messages/${emailId}/$value`);
  }

  /** Écrit un message sur disque au format `.eml`, cf. `ImapService`. */
  async saveEmailToDisk(
    accountName: string,
    emailId: string,
    _mailbox: string,
    destination: string,
    overwrite = false,
  ): Promise<EmailSaveResult> {
    const { mkdir, stat, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    assertSafeDestination(destination);

    const client = this.client(accountName);
    // Sujet et date servent uniquement à nommer le fichier — deux propriétés,
    // pas la sélection complète.
    const meta = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=subject,receivedDateTime,sentDateTime`,
    );
    const source = await client.getBinary(`/me/messages/${emailId}/$value`);

    let targetPath: string;
    try {
      const info = await stat(destination);
      targetPath = info.isDirectory()
        ? join(
            destination,
            defaultEmlFilename(
              emailId,
              meta.subject ?? undefined,
              meta.sentDateTime ?? meta.receivedDateTime,
            ),
          )
        : destination;
    } catch {
      targetPath = destination;
    }
    // Le nom de fichier dérive du sujet, donc d'une source non maîtrisée.
    assertSafeDestination(targetPath);

    const finalPath = await resolveUniquePath(targetPath, overwrite);
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, source);

    return {
      emailId,
      account: accountName,
      path: finalPath,
      fileUrl: pathToFileURL(finalPath).href,
      size: source.length,
      ...(meta.subject ? { subject: meta.subject } : {}),
    };
  }

  /** Export `.eml` en lot depuis une recherche, cf. `ImapService`. */
  async saveEmailsFromSearch(input: {
    accountNames: string[] | null;
    accountName: string | null;
    query: string;
    searchOptions: { mailbox?: string; [key: string]: unknown };
    maxEmails: number;
    destinationFolder: string;
    organizeBy: 'flat' | 'date' | 'sender' | 'account';
  }): Promise<BatchEmailSaveResult> {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');

    assertSafeDestination(input.destinationFolder);
    await mkdir(input.destinationFolder, { recursive: true });

    const { items, truncated } = await this.searchForExport(
      input.accountNames,
      input.accountName,
      input.query,
      { ...input.searchOptions, maxRows: input.maxEmails },
    );

    let filesSaved = 0;
    let totalSize = 0;
    const errors: { emailId: string; account?: string; error: string }[] = [];

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- Graph limite les rafales */
    for (const email of items) {
      const accountForEmail = email.account ?? input.accountName;
      if (!accountForEmail) {
        errors.push({ emailId: email.id, error: 'Could not determine account for email' });
      } else {
        const subfolder = join(
          input.destinationFolder,
          exportSubfolder(input.organizeBy, email, accountForEmail),
        );
        try {
          await mkdir(subfolder, { recursive: true });
          const saved = await this.saveEmailToDisk(
            accountForEmail,
            email.id,
            input.searchOptions.mailbox ?? 'INBOX',
            subfolder,
            false,
          );
          filesSaved += 1;
          totalSize += saved.size;
        } catch (err) {
          errors.push({
            emailId: email.id,
            account: accountForEmail,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return {
      folder: input.destinationFolder,
      matched: items.length,
      truncated,
      files_saved: filesSaved,
      total_size: totalSize,
      errors,
    };
  }
}
