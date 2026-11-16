/**
 * Provider-neutral mail engine contract (draft, not implemented yet).
 *
 * One `MailEngine` serves ONE account, whatever API is behind it (IMAP + SMTP,
 * Microsoft Graph, later JMAP). A host application (ONYX) talks to this
 * contract only; switching provider means switching the engine declared for
 * the account, not changing the host's code.
 *
 * It replaces, for new consumers, the contract derived from the IMAP class
 * (`IMailService = Pick<ImapService, keyof ImapService>`), which leaks IMAP
 * into every caller:
 * - a message is designated by its IMAP UID, valid in one folder only: a moved
 *   message changes identity, and after a UIDVALIDITY change an old id can
 *   silently designate another message;
 * - every call takes the account name first, and the router guesses where it
 *   is (a method that does not take it first is routed to IMAP for a Graph
 *   account, silently);
 * - pagination is by page number, which shifts when mail arrives while the
 *   user scrolls (a message shows twice, or never).
 *
 * The MCP server keeps `IMailService`; this contract is implemented by thin
 * adapters over the existing engines (ImapService, GraphService), so no engine
 * is rewritten.
 */

import type { EmailAddress } from '../types/index.js';

// ---------------------------------------------------------------------------
// Identifiers — opaque strings, produced and understood by the engine only
// ---------------------------------------------------------------------------

// Every identifier starts with a kind prefix the engine checks on input:
// `m` message, `f` folder, `p` page token, `c` sync cursor, followed by
// the engine and a format version (`m.imap1.…`). They stay plain strings — a
// host stores them as text with no conversion — and passing one kind where
// another is expected fails at once with a clear `MailError(not-found)`
// instead of designating a wrong object. See contract/ids.ts.

/**
 * A message, as the engine designates it. Opaque: never parse it, store it as
 * is. IMAP encodes folder + UIDVALIDITY + UID in it, so an id made stale by a
 * renumbering fails with `stale-id` instead of designating another message.
 * Graph uses its immutable id, which survives a move.
 *
 * Not stable across a move on IMAP servers without OBJECTID (OVH among them):
 * the stable key across folders is `messageIdHeader`.
 */
export type MessageId = string;

/** A folder, as the engine designates it. Opaque. */
export type FolderId = string;

/** Continuation of a listing. Opaque, short-lived: do not persist it. */
export type PageToken = string;

/**
 * Synchronisation position in one folder. Opaque and versioned by the engine
 * (e.g. `imap1:…`, `graph1:…`): persist it as is, per account and folder.
 */
export type SyncCursor = string;

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all';

/**
 * What decided a folder's role, from the strongest to the weakest:
 * - `config`: set for the account by the host (`AccountConfig.sentFolder`, …);
 * - `server`: announced by the server (IMAP SPECIAL-USE / XLIST, Graph
 *   well-known folder names);
 * - `name`: guessed from a usual name ("Sent", "Éléments envoyés", …).
 *
 * Reported because the server can be wrong for the account's habits: on an
 * OVH mailbox used with Outlook, the server flags "Sent" (5 messages) while
 * Outlook files sent mail in "Éléments envoyés" (560 messages). The right
 * folder differs per mailbox, even on one server: of four OVH mailboxes of the
 * same company, three file sent mail in "Éléments envoyés", one in "Sent".
 *
 * A folder set by `config` that does not exist on the server is reported as
 * an error, never created silently next to the real one.
 */
export type FolderRoleSource = 'config' | 'server' | 'name';

export interface Folder {
  id: FolderId;
  /** Display name of the folder itself ("Éléments envoyés"). */
  name: string;
  /** Names from the root down to this folder, delimiter-free. */
  path: string[];
  parentId?: FolderId;
  role?: FolderRole;
  roleSource?: FolderRoleSource;
  /**
   * Other folders that could hold this role, when the evidence disagrees (a
   * server flag on one folder, a usual name with far more mail on another).
   * Lets the host warn instead of silently filing mail where the user does not
   * look.
   */
  roleCandidates?: FolderId[];
  /** False for a pure container that cannot hold messages. */
  selectable: boolean;
  total?: number;
  unread?: number;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Neutral flags: no IMAP system flag (`\Seen`) leaks out of the engine. */
export interface Flags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  /** IMAP keywords / Gmail labels / Graph categories. */
  keywords: string[];
}

export interface AttachmentInfo {
  /** Stable designation of the part (MIME part number, Graph attachment id). */
  partId: string;
  filename: string;
  contentType: string;
  /** Bytes as stored; on IMAP, the encoded size (~1.37× for base64). */
  size: number;
  /** Image referenced by the HTML body (`cid:`), not a "real" attachment. */
  inline: boolean;
  contentId?: string;
}

export interface MessageSummary {
  id: MessageId;
  folderId: FolderId;
  /** `Message-ID` header without angle brackets: stable across folders. */
  messageIdHeader?: string;
  subject: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** `Date` header, ISO 8601. */
  sentAt?: string;
  /** Arrival in this mailbox (IMAP INTERNALDATE, Graph receivedDateTime), ISO 8601. */
  receivedAt: string;
  size: number;
  flags: Flags;
  hasAttachments: boolean;
  /** First characters of the text body, when the engine has them cheaply. */
  preview?: string;
}

export interface Message extends MessageSummary {
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  inReplyTo?: string;
  references: string[];
  text?: string;
  html?: string;
  attachments: AttachmentInfo[];
}

/** Newest first. `next` is absent on the last page. */
export interface Page<T> {
  items: T[];
  next?: PageToken;
  /**
   * True when the engine stopped scanning before the end: a filter the server
   * cannot evaluate (IMAP has no "has attachments" search) was applied to the
   * most recent messages only. The results are then not exhaustive.
   */
  truncated?: boolean;
}

export interface ListOptions {
  /** Default 50, capped by the engine. */
  pageSize?: number;
  page?: PageToken;
}

export interface SearchQuery {
  /** Searched in subject, addresses and body; how deep depends on the server. */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** ISO 8601 date or date-time, inclusive. */
  since?: string;
  /** ISO 8601 date or date-time, exclusive. */
  before?: string;
  seen?: boolean;
  flagged?: boolean;
  hasAttachments?: boolean;
  /** Restrict to one folder; all searchable folders otherwise. */
  folderId?: FolderId;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export interface FlagChange {
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  addKeywords?: string[];
  removeKeywords?: string[];
}

/** A batch never throws for one bad message: it reports it. */
export interface BatchResult {
  succeeded: MessageId[];
  failed: { id: MessageId; error: string }[];
}

export interface MoveResult extends BatchResult {
  /**
   * New id of each moved message, when the server tells it (IMAP UIDPLUS,
   * Graph). Absent: find the message again by `messageIdHeader`.
   */
  moved: { from: MessageId; to?: MessageId }[];
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface OutgoingAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
  /** Set for an image referenced by the HTML body as `cid:<contentId>`. */
  contentId?: string;
}

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  /**
   * Blind recipients: never in the transmitted message, always in the copy
   * filed in the sent folder, so the sender can see whom they Bcc'd (as
   * Outlook does).
   */
  bcc?: string[];
  subject: string;
  /** At least one of text / html. Given html only, the engine derives the text part. */
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  /**
   * This message answers `id`: the engine sets In-Reply-To / References from
   * it, and marks it answered once sent. Recipients, subject and quote are
   * what the message says: a GUI shows them to the user before sending, so
   * nothing is added behind their back. `prepareReply` fills them in.
   */
  replyTo?: { id: MessageId };
  /**
   * This message forwards `id`: marked `$Forwarded` once sent. Body and
   * attachments are what the message carries; `prepareForward` fills them in.
   */
  forward?: { id: MessageId };
  /** Append the account signature; the account default otherwise. */
  signature?: boolean;
}

export interface SendOutcome {
  /**
   * `Message-ID` header of the sent message, without angle brackets. Empty
   * when the provider does not report it (Graph sendMail): find the message
   * in the sent folder by the next listChanges instead.
   */
  messageIdHeader: string;
  /**
   * Copy in the sent folder:
   * - `filed`: the engine appended it (IMAP), `sentCopyId` says where;
   * - `by-server`: the provider files it itself (Graph, Gmail);
   * - `skipped` / `failed`: no copy; the message WAS sent.
   */
  sentCopy: 'filed' | 'by-server' | 'skipped' | 'failed';
  sentCopyId?: MessageId;
  /** Non-blocking discrepancies, never a hidden failure. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Synchronisation (lot 6 of the ONYX plan)
// ---------------------------------------------------------------------------

export interface AddedMessage {
  id: MessageId;
  messageIdHeader?: string;
  flags: Flags;
  receivedAt: string;
  size: number;
  /**
   * Full RFC 822 source, unless `includeRaw: false` was asked. Also absent
   * when the provider refused that one source (Graph, rare): the folder is not
   * blocked for it; fetch it later with `getRaw`.
   */
  raw?: Buffer;
}

export interface ChangeBatch {
  /**
   * Messages that appeared in the folder since the cursor. On Graph, which
   * does not tell a new message from a changed one, a changed message may be
   * reported here too: deduplicate by `messageIdHeader`.
   */
  added: AddedMessage[];
  flagsChanged: { id: MessageId; flags: Flags }[];
  removed: MessageId[];
  /**
   * The cursor is no longer valid (IMAP UIDVALIDITY changed, Graph delta token
   * expired): every id known for this folder is void. Resynchronise the folder
   * from `cursor: null`. `added`, `flagsChanged`, `removed` are then empty.
   */
  reset: boolean;
  /**
   * False when the batch was capped (`maxMessages`): call again with
   * `nextCursor` before considering the folder up to date. Persist
   * `nextCursor` only after the batch is stored: a crash in between replays
   * the batch, it never skips it.
   */
  complete: boolean;
  nextCursor: SyncCursor;
  /**
   * What this server lets the engine see, so the host knows what to re-check:
   * - flags `exact`: every change (IMAP CONDSTORE, Graph delta); `none`: only
   *   flags of added messages;
   * - removals `exact`: every removal (IMAP QRESYNC, Graph delta); `none`: a
   *   removed message is only noticed when fetched.
   */
  fidelity: { flags: 'exact' | 'none'; removals: 'exact' | 'none' };
}

export interface ListChangesOptions {
  /** Cap of `added` per batch (default 50). */
  maxMessages?: number;
  /**
   * Cap of the raw sources of one batch, in bytes (default 50 MB). A count
   * alone does not bound memory: on a mailbox measured on OVH, 20 sent
   * messages weighed 25 MB. A batch always holds at least one message, even
   * a larger one, so synchronisation never stalls. IMAP reads the sizes
   * first and stays under the cap; Graph's delta gives no size, so a Graph
   * batch stops after the message that crosses it (measured on Outlook.com: a
   * 2 MB cap, a 22 MB batch ending on a large message).
   */
  maxBytes?: number;
  /**
   * Default true: the host's ingestion needs the source; `maxBytes` bounds the
   * memory. False: ids and flags only, fetch sources with `getRaw`.
   */
  includeRaw?: boolean;
}

export type WaitResult = 'changed' | 'timeout' | 'aborted' | 'unsupported';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What the account's server can do, so the host adapts its screens up front
 * instead of meeting an "unsupported" error on click.
 */
export interface EngineCapabilities {
  engine: 'imap' | 'graph';
  sync: ChangeBatch['fidelity'];
  /** `push`: `waitForChange` returns as soon as mail arrives (IMAP IDLE). */
  realtime: 'push' | 'poll';
  /** How keywords are stored; `none`: `addKeywords` fails. */
  labels: 'gmail' | 'protonmail' | 'keyword' | 'none';
  /** Server-side move; otherwise copy + delete (new id, see MoveResult). */
  serverMove: boolean;
  /** Largest message the server accepts, encoded, when known. */
  maxMessageBytes?: number;
  quota: boolean;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface MailReader {
  listFolders: () => Promise<Folder[]>;
  listMessages: (folderId: FolderId, options?: ListOptions) => Promise<Page<MessageSummary>>;
  search: (query: SearchQuery, options?: ListOptions) => Promise<Page<MessageSummary>>;
  getMessage: (id: MessageId) => Promise<Message>;
  /** RFC 822 source, as stored. */
  getRaw: (id: MessageId) => Promise<Buffer>;
  getAttachment: (
    id: MessageId,
    partId: string,
  ) => Promise<{ filename: string; contentType: string; content: Buffer }>;
  /** The conversation of a message, oldest first, across folders when the server allows. */
  getThread: (id: MessageId) => Promise<MessageSummary[]>;
}

export interface MailMutator {
  setFlags: (ids: MessageId[], change: FlagChange) => Promise<BatchResult>;
  move: (ids: MessageId[], to: FolderId) => Promise<MoveResult>;
  copy: (ids: MessageId[], to: FolderId) => Promise<MoveResult>;
  /** To the trash folder; `permanent`: expunged for good. */
  delete: (ids: MessageId[], options?: { permanent?: boolean }) => Promise<BatchResult>;
  createFolder: (name: string, parentId?: FolderId) => Promise<Folder>;
  renameFolder: (id: FolderId, name: string) => Promise<Folder>;
  deleteFolder: (id: FolderId) => Promise<void>;
}

export interface DraftStore {
  /** Saves a new draft, or replaces `replaces`. Returns the draft's id. */
  saveDraft: (draft: OutgoingMessage, replaces?: MessageId) => Promise<MessageId>;
  deleteDraft: (id: MessageId) => Promise<void>;
}

export interface MailSender {
  /** Sends the message exactly as given (plus the account signature if asked). */
  send: (message: OutgoingMessage) => Promise<SendOutcome>;
  sendDraft: (id: MessageId) => Promise<SendOutcome>;
  /**
   * A reply ready for the composer: recipients (Reply-To honoured; `all`:
   * everyone but the account itself), "Re:" subject, original quoted in the
   * account's reply language, `replyTo` set. Sends nothing.
   */
  prepareReply: (id: MessageId, options?: { all?: boolean }) => Promise<OutgoingMessage>;
  /**
   * A forward ready for the composer: "Fwd:" subject, original quoted with
   * its header block, its real attachments carried over unless
   * `withAttachments: false`, `forward` set. Sends nothing.
   */
  prepareForward: (
    id: MessageId,
    options?: { withAttachments?: boolean },
  ) => Promise<OutgoingMessage>;
}

export interface MailSync {
  /**
   * What changed in one folder since `cursor` (`null`: from scratch, every
   * message counts as added). The only provider-dependent piece of a host's
   * synchronisation: storage, deduplication and archiving stay in the host.
   */
  listChanges: (
    folderId: FolderId,
    cursor: SyncCursor | null,
    options?: ListChangesOptions,
  ) => Promise<ChangeBatch>;
  /**
   * Resolves when one of the folders may have changed, then call
   * `listChanges`. A wake-up only, never a payload: nothing is lost if the
   * host misses one. `unsupported`: poll `listChanges` instead.
   */
  waitForChange: (options: {
    folderIds: FolderId[];
    maxMs: number;
    signal?: AbortSignal;
  }) => Promise<WaitResult>;
}

export interface MailEngine extends MailReader, MailMutator, DraftStore, MailSender, MailSync {
  readonly account: string;
  capabilities: () => Promise<EngineCapabilities>;
  /** Closes the engine's connections. */
  close: () => Promise<void>;
}
