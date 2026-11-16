/**
 * The reading half of the IMAP engine, on the MailEngine contract.
 *
 * Built over the existing ImapService (body decoding, attachments, raw
 * source), so nothing of its tested behaviour is rewritten; what it adds is
 * what the old contract got wrong:
 * - message ids carry folder + UIDVALIDITY + UID, and every read checks the
 *   UIDVALIDITY first: after a renumbering an old id fails with `stale-id`
 *   instead of returning whichever message now holds that UID;
 * - pages are anchored on a UID ("older than UID n"), not numbered, so mail
 *   arriving while the user scrolls neither repeats nor hides a message;
 * - folders carry their role, what decided it, and the competing candidates.
 *
 * Folders are opened read-only (EXAMINE): listing never changes a flag.
 */

import type { FetchMessageObject, ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../../connections/types.js';
import type {
  AttachmentInfo,
  EngineCapabilities,
  Flags,
  Folder,
  FolderId,
  ListOptions,
  Message,
  MessageId,
  MessageSummary,
  Page,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { decodeId, encodeId } from '../../contract/ids.js';
import type ImapService from '../../services/imap.service.js';
import { hasAttachments } from '../../services/imap.service.js';
import { detectLabelStrategy } from '../../services/label-strategy.js';
import { maxMessageBytes } from '../../services/send-limit.js';
import type { EmailAddress } from '../../types/index.js';
import { isAuthFailure } from '../../utils/auth-error.js';
import { resolveRoles } from './folder-roles.js';

export const IMAP_ENGINE = 'imap1';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Same cap as the cross-backend attachment rebuild (REBUILD_ATTACHMENT_CAP_BYTES). */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const SUMMARY_FIELDS = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
} as const;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const folderIdOf = (path: string): FolderId => encodeId('folder', IMAP_ENGINE, [path]);

export function pathOf(folderId: FolderId): string {
  const [path] = decodeId(folderId, 'folder', IMAP_ENGINE);
  if (typeof path !== 'string') throw new MailError('not-found', 'Malformed folder id');
  return path;
}

export const messageIdOf = (path: string, uidValidity: bigint | string, uid: number): MessageId =>
  encodeId('message', IMAP_ENGINE, [path, String(uidValidity), uid]);

export function parseMessageId(id: MessageId): { path: string; uidValidity: string; uid: number } {
  const [path, uidValidity, uid] = decodeId(id, 'message', IMAP_ENGINE);
  if (typeof path !== 'string' || typeof uidValidity !== 'string' || typeof uid !== 'number') {
    throw new MailError('not-found', 'Malformed message id');
  }
  return { path, uidValidity, uid };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function toFlags(flags: Set<string> | undefined): Flags {
  const set = flags ?? new Set<string>();
  return {
    seen: set.has('\\Seen'),
    flagged: set.has('\\Flagged'),
    answered: set.has('\\Answered'),
    draft: set.has('\\Draft'),
    keywords: [...set].filter((f) => !f.startsWith('\\')),
  };
}

export function stripAngles(value: string | undefined): string | undefined {
  const bare = value?.replace(/^<|>$/g, '');
  return bare === '' ? undefined : bare;
}

function toAddresses(list: { name?: string; address?: string }[] | undefined): EmailAddress[] {
  return (list ?? [])
    .filter((a): a is { name?: string; address: string } => Boolean(a.address))
    .map((a) => (a.name ? { name: a.name, address: a.address } : { address: a.address }));
}

const toIso = (date: Date | string | undefined): string | undefined =>
  date === undefined ? undefined : new Date(date).toISOString();

export function toSummary(
  path: string,
  uidValidity: bigint,
  msg: FetchMessageObject,
): MessageSummary {
  const env = msg.envelope;
  return {
    id: messageIdOf(path, uidValidity, msg.uid),
    folderId: folderIdOf(path),
    messageIdHeader: stripAngles(env?.messageId),
    subject: env?.subject ?? '',
    from: toAddresses(env?.from)[0],
    to: toAddresses(env?.to),
    cc: toAddresses(env?.cc),
    sentAt: toIso(env?.date),
    receivedAt: toIso(msg.internalDate) ?? new Date(0).toISOString(),
    size: msg.size ?? 0,
    flags: toFlags(msg.flags),
    hasAttachments: msg.bodyStructure ? hasAttachments(msg.bodyStructure) : false,
  };
}

/** Translates a server or library error into the contract's MailError. */
export function toMailError(err: unknown): unknown {
  if (err instanceof MailError) return err;
  const e = err as { serverResponseCode?: string; message?: string };
  const message = e?.message ?? String(err);
  if (isAuthFailure(err)) return new MailError('auth', message, { cause: err });
  if (
    e?.serverResponseCode === 'NONEXISTENT' ||
    /not found|doesn't exist|does not exist/i.test(message)
  ) {
    return new MailError('not-found', message, { cause: err });
  }
  return err;
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toMailError(err);
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export default class ImapReader {
  constructor(
    readonly account: string,
    private readonly connections: IConnectionManager,
    private readonly imap: ImapService,
  ) {}

  private async client(): Promise<ImapFlow> {
    return this.connections.getImapClient(this.account);
  }

  /**
   * Runs `work` with the folder open read-only, after checking that the
   * folder still has the UIDVALIDITY the caller's id was made with.
   */
  private async inFolder<T>(
    path: string,
    expectedUidValidity: string | undefined,
    work: (client: ImapFlow, uidValidity: bigint) => Promise<T>,
  ): Promise<T> {
    const client = await this.client();
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const { mailbox } = client;
      if (!mailbox) throw new MailError('not-found', `Folder "${path}" could not be opened`);
      if (
        expectedUidValidity !== undefined &&
        String(mailbox.uidValidity) !== expectedUidValidity
      ) {
        throw new MailError(
          'stale-id',
          `Folder "${path}" was renumbered by the server (UIDVALIDITY ${expectedUidValidity} → ` +
            `${mailbox.uidValidity}): resynchronise it`,
        );
      }
      return await work(client, mailbox.uidValidity);
    } finally {
      lock.release();
    }
  }

  /** Checks a message id against the server (stale, missing); returns where it lives. */
  async locate(id: MessageId): Promise<{ path: string; uid: number; meta: FetchMessageObject }> {
    const { path, uidValidity, uid } = parseMessageId(id);
    return guard(async () =>
      this.inFolder(path, uidValidity, async (client) => {
        const meta = await client.fetchOne(String(uid), SUMMARY_FIELDS, { uid: true });
        if (!meta) throw new MailError('not-found', `Message no longer in "${path}"`);
        return { path, uid, meta };
      }),
    );
  }

  async listFolders(): Promise<Folder[]> {
    const config = this.connections.getAccount(this.account);
    return guard(async () => {
      const client = await this.client();
      const boxes = await client.list({
        statusQuery: { messages: true, unseen: true },
        ...(config.sentFolder ? { specialUseHints: { sent: config.sentFolder } } : {}),
      });
      if (config.sentFolder && !boxes.some((b) => b.path === config.sentFolder)) {
        throw new MailError(
          'not-found',
          `The sent folder set for account "${this.account}" ("${config.sentFolder}") does not ` +
            'exist on the server: fix sent_folder in the configuration',
        );
      }
      // A server may answer a folder's STATUS with `false` (see listMailboxes): no counts.
      const status = (b: (typeof boxes)[number]) =>
        typeof b.status === 'object' ? b.status : undefined;
      const roles = resolveRoles(
        boxes.map((b) => ({
          path: b.path,
          name: b.name,
          specialUse: b.specialUse,
          specialUseSource: b.specialUseSource,
          total: status(b)?.messages,
        })),
      );
      return boxes.map((b, i): Folder => {
        const { role, roleSource, candidatePaths } = roles[i] ?? {};
        return {
          id: folderIdOf(b.path),
          name: b.name,
          path: [...b.parent, b.name],
          ...(b.parentPath ? { parentId: folderIdOf(b.parentPath) } : {}),
          ...(role ? { role, roleSource } : {}),
          ...(candidatePaths ? { roleCandidates: candidatePaths.map(folderIdOf) } : {}),
          selectable: !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent'),
          total: status(b)?.messages,
          unread: status(b)?.unseen,
        };
      });
    });
  }

  async listMessages(folderId: FolderId, options: ListOptions = {}): Promise<Page<MessageSummary>> {
    const path = pathOf(folderId);
    const size = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    let before: number | undefined;
    let expected: string | undefined;
    if (options.page) {
      const [pagePath, pageUidValidity, pageBefore] = decodeId(options.page, 'page', IMAP_ENGINE);
      if (
        pagePath !== path ||
        typeof pageBefore !== 'number' ||
        typeof pageUidValidity !== 'string'
      ) {
        throw new MailError('not-found', 'Page token of another folder');
      }
      before = pageBefore;
      expected = pageUidValidity;
    }

    return guard(async () =>
      this.inFolder(path, expected, async (client, uidValidity) => {
        if (before !== undefined && before <= 1) return { items: [] };
        const found = await client.search(before ? { uid: `1:${before - 1}` } : { all: true }, {
          uid: true,
        });
        // imapflow answers `false` (or nothing) when the search failed: nothing to list.
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
        const pageUids = uids.slice(0, size);
        if (pageUids.length === 0) return { items: [] };

        const fetched: FetchMessageObject[] = [];
        // eslint-disable-next-line no-restricted-syntax -- imapflow streams FETCH responses
        for await (const msg of client.fetch(pageUids.join(','), SUMMARY_FIELDS, { uid: true })) {
          fetched.push(msg);
        }
        const items = fetched
          .sort((a, b) => b.uid - a.uid)
          .map((msg) => toSummary(path, uidValidity, msg));
        const oldest = pageUids[pageUids.length - 1];
        return uids.length > size && oldest !== undefined
          ? { items, next: encodeId('page', IMAP_ENGINE, [path, String(uidValidity), oldest]) }
          : { items };
      }),
    );
  }

  async getMessage(id: MessageId): Promise<Message> {
    const { path, uid, meta } = await this.locate(id);
    const { uidValidity } = parseMessageId(id);
    const email = await guard(async () => this.imap.getEmail(this.account, String(uid), path));
    const attachments = email.attachments.map(
      (a): AttachmentInfo => ({
        partId: a.partId ?? '',
        filename: a.filename,
        contentType: a.mimeType,
        size: a.size,
        inline: Boolean(a.inline),
        ...(a.contentId ? { contentId: a.contentId } : {}),
      }),
    );
    return {
      ...toSummary(path, BigInt(uidValidity), meta),
      bcc: email.bcc ?? [],
      replyTo: email.replyTo ?? [],
      inReplyTo: stripAngles(email.inReplyTo),
      references: (email.references ?? []).map((r) => stripAngles(r) ?? r),
      text: email.bodyText,
      html: email.bodyHtml,
      attachments,
    };
  }

  async getRaw(id: MessageId): Promise<Buffer> {
    const { path, uid } = await this.locate(id);
    return guard(async () => this.imap.getEmailRaw(this.account, String(uid), path));
  }

  async getAttachment(
    id: MessageId,
    partId: string,
  ): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const { path, uid } = await this.locate(id);
    const file = await guard(async () =>
      this.imap.downloadAttachment(
        this.account,
        String(uid),
        path,
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

  async capabilities(): Promise<EngineCapabilities> {
    return guard(async () => {
      const client = await this.client();
      const has = (name: string) => client.capabilities.has(name);
      const strategy = await detectLabelStrategy(client);
      const limit = maxMessageBytes(this.connections.getAccount(this.account));
      return {
        engine: 'imap',
        sync: {
          flags: has('CONDSTORE') ? 'exact' : 'none',
          removals: has('QRESYNC') ? 'exact' : 'none',
        },
        realtime: has('IDLE') ? 'push' : 'poll',
        labels: strategy.type === 'unsupported' ? 'none' : strategy.type,
        serverMove: has('MOVE'),
        ...(limit === undefined ? {} : { maxMessageBytes: limit }),
        quota: has('QUOTA'),
      };
    });
  }
}
