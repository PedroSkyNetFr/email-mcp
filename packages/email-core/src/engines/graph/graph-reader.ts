/**
 * The reading half of the Microsoft Graph engine, on the MailEngine contract.
 *
 * Every request that returns message ids asks for immutable ids
 * (`Prefer: IdType="ImmutableId"`): an Exchange message keeps its id when it
 * is moved, so a host's selection survives a move. Measured on Outlook.com:
 * Graph accepts these ids on requests made without the header too, so the
 * existing GraphService methods (body, raw source, attachments) are reused
 * with them unchanged.
 *
 * Pages are anchored on the arrival date (`receivedDateTime lt …`, the ids
 * already shown at that instant skipped), not on `$skip`, so mail arriving
 * while the user scrolls neither repeats nor hides a message.
 */

import type {
  EngineCapabilities,
  Flags,
  Folder,
  FolderId,
  FolderRole,
  ListOptions,
  Message,
  MessageId,
  MessageSummary,
  Page,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { decodeId, encodeId } from '../../contract/ids.js';
import type GraphClient from '../../services/graph/graph.client.js';
import { GraphError } from '../../services/graph/graph.client.js';
import type GraphService from '../../services/graph/graph.service.js';
import { maxMessageBytes } from '../../services/send-limit.js';
import type { AccountConfig, EmailAddress } from '../../types/index.js';

export const GRAPH_ENGINE = 'graph1';
export const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' } as const;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Graph refuses a $top above 1000 on message lists. */
const GRAPH_MAX_TOP = 1000;

/** An instant as Graph shows it: ISO 8601 to the second, UTC. */
const toSecond = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** MAPI properties read along: last verb (answered / forwarded), message size. */
const VERB = 'Integer 0x1081';
const SIZE = 'Integer 0x0E08';
export const VERB_REPLIED = '102';
export const VERB_REPLIED_ALL = '103';
export const VERB_FORWARDED = '104';
export const SUMMARY_QUERY =
  '$select=id,parentFolderId,conversationId,subject,from,sender,toRecipients,ccRecipients,' +
  'receivedDateTime,sentDateTime,isRead,isDraft,flag,hasAttachments,bodyPreview,categories,' +
  `internetMessageId&$expand=singleValueExtendedProperties($filter=id eq '${VERB}' or id eq '${SIZE}')`;

// ---------------------------------------------------------------------------
// Identifiers and mapping
// ---------------------------------------------------------------------------

export const folderIdOf = (graphId: string): FolderId =>
  encodeId('folder', GRAPH_ENGINE, [graphId]);
export const messageIdOf = (graphId: string): MessageId =>
  encodeId('message', GRAPH_ENGINE, [graphId]);

/**
 * A Graph id decoded from a contract id. Ids are only ever path segments: a
 * forged one such as "../mailFolders/X" would otherwise turn a message
 * deletion into a folder deletion (found in review). URLs encode them too.
 */
function single(id: string, kind: 'folder' | 'message'): string {
  const [graphId] = decodeId(id, kind, GRAPH_ENGINE);
  if (
    typeof graphId !== 'string' ||
    graphId === '' ||
    graphId === '.' ||
    graphId === '..' ||
    /[/\\?#%\s]/.test(graphId)
  ) {
    throw new MailError('not-found', `Malformed ${kind} id`);
  }
  return graphId;
}

/** A Graph id as a URL path segment. */
export const seg = (graphId: string): string => encodeURIComponent(graphId);
export const graphFolderId = (id: FolderId): string => single(id, 'folder');
export const graphMessageId = (id: MessageId): string => single(id, 'message');

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphSummary {
  id: string;
  parentFolderId?: string;
  conversationId?: string;
  subject?: string | null;
  from?: GraphAddress | null;
  sender?: GraphAddress | null;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string } | null;
  hasAttachments?: boolean;
  bodyPreview?: string;
  categories?: string[];
  internetMessageId?: string;
  singleValueExtendedProperties?: { id: string; value: string }[];
  '@removed'?: { reason?: string };
}

export interface GraphPageOf<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

const toAddress = (a: GraphAddress | null | undefined): EmailAddress | undefined =>
  a?.emailAddress?.address
    ? {
        address: a.emailAddress.address,
        ...(a.emailAddress.name ? { name: a.emailAddress.name } : {}),
      }
    : undefined;

const toAddresses = (list: GraphAddress[] | undefined): EmailAddress[] =>
  (list ?? []).map(toAddress).filter((a): a is EmailAddress => a !== undefined);

const property = (m: GraphSummary, id: string): string | undefined =>
  m.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === id.toLowerCase())?.value;

export const stripAngles = (value: string | undefined): string | undefined => {
  const bare = value?.replace(/^<|>$/g, '');
  return bare === '' ? undefined : bare;
};

export function toFlags(m: GraphSummary): Flags {
  const verb = property(m, VERB);
  return {
    seen: m.isRead ?? false,
    flagged: m.flag?.flagStatus === 'flagged',
    answered: verb === VERB_REPLIED || verb === VERB_REPLIED_ALL,
    draft: m.isDraft ?? false,
    keywords: m.categories ?? [],
  };
}

export function toSummary(m: GraphSummary): MessageSummary {
  const from = toAddress(m.from ?? m.sender);
  return {
    id: messageIdOf(m.id),
    folderId: folderIdOf(m.parentFolderId ?? ''),
    messageIdHeader: stripAngles(m.internetMessageId),
    subject: m.subject ?? '',
    ...(from ? { from } : {}),
    to: toAddresses(m.toRecipients),
    cc: toAddresses(m.ccRecipients),
    ...(m.sentDateTime ? { sentAt: new Date(m.sentDateTime).toISOString() } : {}),
    receivedAt: new Date(m.receivedDateTime ?? 0).toISOString(),
    size: Number(property(m, SIZE) ?? 0),
    flags: toFlags(m),
    hasAttachments: m.hasAttachments ?? false,
    ...(m.bodyPreview ? { preview: m.bodyPreview } : {}),
  };
}

/** Graph failures in the contract's terms. */
export function toMailError(err: unknown): unknown {
  if (err instanceof MailError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GraphError) {
    if ([500, 502, 504].includes(err.status)) {
      return new MailError('transient', message, { cause: err });
    }
    const code = (
      {
        404: 'not-found',
        401: 'auth',
        403: 'auth',
        413: 'too-large',
        429: 'transient',
        503: 'transient',
      } as const
    )[err.status as 404];
    if (code) return new MailError(code, message, { cause: err });
    if (err.status === 400) return new MailError('invalid', message, { cause: err });
  }
  // Only a non-Graph error is read by its text: a Graph message quotes the
  // URL, whose $skiptoken / $deltatoken would read as an auth failure.
  if (err instanceof GraphError) return err;
  if (err instanceof TypeError) return new MailError('transient', message, { cause: err }); // fetch failed
  if (/oauth|refresh token|consent|invalid_grant/i.test(message)) {
    return new MailError('auth', message, { cause: err });
  }
  return err;
}

export async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toMailError(err);
  }
}

const ROLES: Record<string, FolderRole> = {
  inbox: 'inbox',
  sentitems: 'sent',
  drafts: 'drafts',
  deleteditems: 'trash',
  junkemail: 'junk',
  archive: 'archive',
};

interface GraphFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
  wellKnownName?: string | null;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export default class GraphReader {
  constructor(
    readonly account: string,
    private readonly client: GraphClient,
    private readonly graph: GraphService,
    private readonly config: () => AccountConfig,
  ) {}

  /** Every page of a collection, following `@odata.nextLink`. */
  async all<T>(path: string, headers: Record<string, string> = IMMUTABLE): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
      // eslint-disable-next-line no-await-in-loop -- paging is sequential
      const page: GraphPageOf<T> = await this.client.request<GraphPageOf<T>>(
        'GET',
        next,
        undefined,
        headers,
      );
      out.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return out;
  }

  async listFolders(): Promise<Folder[]> {
    return guard(async () => {
      // No $select: Graph returns wellKnownName by default but refuses it in a
      // $select ("Could not find a property named 'wellKnownName'", measured).
      const select = '$top=100';
      const found: GraphFolder[] = [];
      const walk = async (path: string): Promise<void> => {
        const level = await this.all<GraphFolder>(path, {});
        found.push(...level);
        await Promise.all(
          level
            .filter((f) => (f.childFolderCount ?? 0) > 0)
            .map(async (f) => walk(`/me/mailFolders/${seg(f.id)}/childFolders?${select}`)),
        );
      };
      await walk(`/me/mailFolders?${select}`);
      const byId = new Map(found.map((f) => [f.id, f]));
      const pathOf = (f: GraphFolder): string[] => {
        const parent = f.parentFolderId ? byId.get(f.parentFolderId) : undefined;
        return parent ? [...pathOf(parent), f.displayName] : [f.displayName];
      };
      return found.map((f): Folder => {
        const role = f.wellKnownName ? ROLES[f.wellKnownName.toLowerCase()] : undefined;
        return {
          id: folderIdOf(f.id),
          name: f.displayName,
          path: pathOf(f),
          ...(f.parentFolderId && byId.has(f.parentFolderId)
            ? { parentId: folderIdOf(f.parentFolderId) }
            : {}),
          ...(role ? { role, roleSource: 'server' as const } : {}),
          selectable: true,
          total: f.totalItemCount ?? 0,
          unread: f.unreadItemCount ?? 0,
        };
      });
    });
  }

  /** The Graph id of a well-known folder ("deleteditems", "drafts"…). */
  async wellKnown(name: string): Promise<string> {
    const folder = await guard(async () =>
      this.client.request<{ id: string }>('GET', `/me/mailFolders/${seg(name)}?$select=id`),
    );
    return folder.id;
  }

  async listMessages(folderId: FolderId, options: ListOptions = {}): Promise<Page<MessageSummary>> {
    const folder = graphFolderId(folderId);
    const size = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    let anchor: string | undefined;
    let shown: string[] = [];
    if (options.page) {
      const [kind, pageFolder, pageAnchor, ...ids] = decodeId(options.page, 'page', GRAPH_ENGINE);
      if (kind !== 'list' || pageFolder !== folder || typeof pageAnchor !== 'string') {
        throw new MailError('invalid', 'Page token of another folder');
      }
      // Re-serialised: the token is host-held text, never put in a $filter as is.
      const parsed = Date.parse(pageAnchor);
      if (Number.isNaN(parsed)) throw new MailError('invalid', 'Malformed page token');
      anchor = toSecond(parsed);
      shown = ids.filter((i): i is string => typeof i === 'string');
    }
    return guard(async () => {
      // Graph shows receivedDateTime to the second while Exchange keeps more:
      // `le 10:00:00Z` would drop a message at 10:00:00.437 not shown yet. So
      // the page takes everything before the next second and skips the ids
      // already shown within this one.
      const filter = anchor
        ? `&$filter=receivedDateTime lt ${toSecond(Date.parse(anchor) + 1000)}`
        : '';
      // One more than needed tells whether a next page exists. Graph caps $top.
      const top = Math.min(size + shown.length + 1, GRAPH_MAX_TOP);
      const page = await this.client.request<GraphPageOf<GraphSummary>>(
        'GET',
        `/me/mailFolders/${seg(folder)}/messages?$top=${top}&$orderby=receivedDateTime desc${filter}&${SUMMARY_QUERY}`,
        undefined,
        IMMUTABLE,
      );
      const fresh = page.value.filter((m) => !shown.includes(m.id));
      const items = fresh.slice(0, size).map(toSummary);
      const last = fresh[size - 1];
      if (fresh.length <= size || !last?.receivedDateTime) return { items };
      const instant = toSecond(Date.parse(last.receivedDateTime));
      const sameSecond = fresh
        .slice(0, size)
        .filter((m) => m.receivedDateTime && toSecond(Date.parse(m.receivedDateTime)) === instant)
        .map((m) => m.id);
      const carried = instant === anchor ? [...shown, ...sameSecond] : sameSecond;
      return { items, next: encodeId('page', GRAPH_ENGINE, ['list', folder, instant, ...carried]) };
    });
  }

  async summary(id: MessageId): Promise<GraphSummary> {
    return guard(async () =>
      this.client.request<GraphSummary>(
        'GET',
        `/me/messages/${seg(graphMessageId(id))}?${SUMMARY_QUERY}`,
        undefined,
        IMMUTABLE,
      ),
    );
  }

  async getMessage(id: MessageId): Promise<Message> {
    const meta = await this.summary(id);
    const email = await guard(async () => this.graph.getEmail(this.account, meta.id));
    return {
      ...toSummary(meta),
      bcc: email.bcc ?? [],
      replyTo: email.replyTo ?? [],
      ...(email.inReplyTo ? { inReplyTo: stripAngles(email.inReplyTo) } : {}),
      references: (email.references ?? []).map((r) => stripAngles(r) ?? r),
      ...(email.bodyText ? { text: email.bodyText } : {}),
      ...(email.bodyHtml ? { html: email.bodyHtml } : {}),
      attachments: email.attachments.map((a) => ({
        partId: a.partId ?? '',
        filename: a.filename,
        contentType: a.mimeType,
        size: a.size,
        inline: Boolean(a.inline),
        ...(a.contentId ? { contentId: a.contentId } : {}),
      })),
    };
  }

  async getRaw(id: MessageId): Promise<Buffer> {
    return guard(async () => this.graph.getEmailRaw(this.account, graphMessageId(id)));
  }

  async getAttachment(
    id: MessageId,
    partId: string,
  ): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const file = await guard(async () =>
      this.graph.downloadAttachment(
        this.account,
        graphMessageId(id),
        'INBOX',
        { partId },
        MAX_ATTACHMENT_BYTES,
      ),
    );
    return {
      filename: file.filename,
      contentType: file.mimeType,
      content: Buffer.from(file.contentBase64, 'base64'),
    };
  }

  /** The conversation, oldest first, across folders (Graph's conversationId). */
  async getThread(id: MessageId): Promise<MessageSummary[]> {
    const meta = await this.summary(id);
    if (!meta.conversationId) return [toSummary(meta)];
    // OData string literal: quotes doubled, then URL-encoded.
    const conversation = encodeURIComponent(meta.conversationId.replace(/'/g, "''"));
    const messages = await guard(async () =>
      this.all<GraphSummary>(
        `/me/messages?$filter=conversationId eq '${conversation}'&$top=50&${SUMMARY_QUERY}`,
      ),
    );
    return messages.map(toSummary).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  async capabilities(): Promise<EngineCapabilities> {
    const limit = maxMessageBytes(this.config());
    return {
      engine: 'graph',
      sync: { flags: 'exact', removals: 'exact' },
      // Graph push needs a public webhook endpoint: hosts poll listChanges.
      realtime: 'poll',
      labels: 'keyword',
      serverMove: true,
      ...(limit === undefined ? {} : { maxMessageBytes: limit }),
      quota: false,
    };
  }
}
