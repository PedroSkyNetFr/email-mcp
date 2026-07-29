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

import type { Email, EmailAddress, EmailMeta, Mailbox, PaginatedResult } from '../../types/index.js';
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
const FULL_SELECT = `${META_SELECT},ccRecipients,bccRecipients,sentDateTime,internetMessageId,body`;

function toAddress(input?: { emailAddress?: { name?: string; address?: string } } | null): EmailAddress {
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

  constructor(private readonly clients: Map<string, GraphClient>) {}

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

    /* eslint-disable no-await-in-loop -- depth-first walk, and Graph throttles bursts */
    for (let i = 0; i < folders.length; i += 1) {
      const folder = folders[i];
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
    /* eslint-enable no-await-in-loop */
  }

  private async loadFolders(
    accountName: string,
  ): Promise<{ path: string; folder: GraphFolder }[]> {
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
    if (options.before) filters.push(`receivedDateTime lt ${new Date(options.before).toISOString()}`);
    if (options.from) filters.push(`from/emailAddress/address eq '${options.from.replace(/'/g, "''")}'`);

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
      headers: Object.fromEntries(
        (message.internetMessageHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value]),
      ),
    };
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
}
