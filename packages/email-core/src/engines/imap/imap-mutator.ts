/**
 * The changing half of the IMAP engine: flags, move, copy, delete, folders.
 *
 * Ids are grouped by folder, and every group checks its folder's UIDVALIDITY
 * before touching anything: after a renumbering, a stale id would otherwise
 * flag, move or delete whichever message now holds its UID.
 *
 * A move or copy returns the new ids when the server gives them (UIDPLUS: OVH
 * and Dovecot do); a server without MOVE gets imapflow's copy + delete, whose
 * new ids come the same way.
 *
 * Gmail: a "folder" other than INBOX is a label. Deleting from one, even for
 * good, removes that label only: the message stays in All Mail.
 */

import type { ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../../connections/types.js';
import type {
  BatchResult,
  FlagChange,
  Folder,
  FolderId,
  MessageId,
  MoveResult,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { detectLabelStrategy } from '../../services/label-strategy.js';
import type ImapReader from './imap-reader.js';
import { folderIdOf, messageIdOf, parseMessageId, pathOf, toMailError } from './imap-reader.js';

interface Group {
  path: string;
  uidValidity: string;
  entries: { id: MessageId; uid: number }[];
}

/** Groups ids by folder; a malformed id is reported, never thrown (one bad id must not sink the batch). */
function groupByFolder(ids: MessageId[]): {
  groups: Group[];
  malformed: { id: MessageId; error: string }[];
} {
  const groups = new Map<string, Group>();
  const malformed: { id: MessageId; error: string }[] = [];
  ids.forEach((id) => {
    let parsed: ReturnType<typeof parseMessageId>;
    try {
      parsed = parseMessageId(id);
    } catch (err) {
      malformed.push({ id, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const { path, uidValidity, uid } = parsed;
    const key = `${path}\u0000${uidValidity}`;
    const group = groups.get(key) ?? { path, uidValidity, entries: [] };
    group.entries.push({ id, uid });
    groups.set(key, group);
  });
  return { groups: [...groups.values()], malformed };
}

/**
 * imapflow answers `false` when the server refused a STORE or EXPUNGE, or
 * when a keyword is not in the folder's PERMANENTFLAGS: never a success.
 */
function refusedUnless(ok: boolean, what: string): void {
  if (!ok) throw new Error(`The server refused to ${what}`);
}

const emptyBatch = (): BatchResult => ({ succeeded: [], failed: [] });
const emptyMove = (): MoveResult => ({ succeeded: [], failed: [], moved: [] });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A folder name as one path segment: never empty, never holding the separator. */
async function validName(client: ImapFlow, name: string): Promise<string> {
  const trimmed = name.trim();
  if (trimmed === '') throw new MailError('invalid', 'A folder name cannot be empty');
  const delimiter = (await client.list())[0]?.delimiter ?? '/';
  if (trimmed.includes(delimiter)) {
    // Otherwise "a/b" silently creates "b" inside "a".
    throw new MailError('invalid', `A folder name cannot contain "${delimiter}" on this server`);
  }
  return trimmed;
}

export default class ImapMutator {
  constructor(
    readonly account: string,
    private readonly connections: IConnectionManager,
    private readonly reader: ImapReader,
  ) {}

  /**
   * Runs `work` on each folder group with the folder open for writing, after
   * the UIDVALIDITY check. A group that fails is reported, the others still run.
   */
  private async perFolder<T extends BatchResult>(
    ids: MessageId[],
    empty: T,
    work: (client: ImapFlow, group: Group, result: T) => Promise<void>,
  ): Promise<T> {
    const result = empty;
    const { groups, malformed } = groupByFolder(ids);
    result.failed.push(...malformed);
    if (groups.length === 0) return result;
    const client = await this.connections.getImapClient(this.account);
    // Sequential: one connection, one selected folder at a time.
    await groups.reduce(async (previous, group) => {
      await previous;
      const fail = (error: string): void => {
        group.entries.forEach(({ id }) => {
          result.failed.push({ id, error });
        });
      };
      let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
      try {
        lock = await client.getMailboxLock(group.path);
      } catch (err) {
        fail(errorText(toMailError(err)));
        return;
      }
      try {
        // `mailbox` is `false` when nothing is selected (imapflow).
        const { mailbox } = client;
        if (mailbox === false || String(mailbox.uidValidity) !== group.uidValidity) {
          fail(`stale-id: folder "${group.path}" was renumbered, resynchronise it`);
          return;
        }
        await work(client, group, result);
      } catch (err) {
        fail(errorText(toMailError(err)));
      } finally {
        lock.release();
      }
    }, Promise.resolve());
    return result;
  }

  async setFlags(ids: MessageId[], change: FlagChange): Promise<BatchResult> {
    const add: string[] = [];
    const remove: string[] = [];
    const system: [keyof FlagChange, string][] = [
      ['seen', '\\Seen'],
      ['flagged', '\\Flagged'],
      ['answered', '\\Answered'],
    ];
    system.forEach(([key, flag]) => {
      if (change[key] === true) add.push(flag);
      if (change[key] === false) remove.push(flag);
    });
    const addKeywords = change.addKeywords ?? [];
    const removeKeywords = change.removeKeywords ?? [];
    const client = await this.connections.getImapClient(this.account);
    const keywordsTouched = addKeywords.length > 0 || removeKeywords.length > 0;
    const strategy = keywordsTouched ? (await detectLabelStrategy(client)).type : 'keyword';
    if (keywordsTouched && strategy !== 'keyword' && strategy !== 'gmail') {
      throw new MailError(
        'unsupported',
        `Keywords are not supported on this server (label strategy "${strategy}")`,
      );
    }
    const labels = strategy === 'gmail';

    return this.perFolder(ids, emptyBatch(), async (c, group, result) => {
      const range = group.entries.map((e) => e.uid).join(',');
      if (add.length > 0) {
        refusedUnless(await c.messageFlagsAdd(range, add, { uid: true }), 'set the flags');
      }
      if (remove.length > 0) {
        refusedUnless(await c.messageFlagsRemove(range, remove, { uid: true }), 'clear the flags');
      }
      // Gmail stores keywords as labels (X-GM-LABELS); other servers as IMAP keywords.
      if (addKeywords.length > 0) {
        refusedUnless(
          await c.messageFlagsAdd(range, addKeywords, { uid: true, useLabels: labels }),
          `add the keywords (${addKeywords.join(', ')})`,
        );
      }
      if (removeKeywords.length > 0) {
        refusedUnless(
          await c.messageFlagsRemove(range, removeKeywords, { uid: true, useLabels: labels }),
          `remove the keywords (${removeKeywords.join(', ')})`,
        );
      }
      result.succeeded.push(...group.entries.map((e) => e.id));
    });
  }

  private async transfer(
    kind: 'move' | 'copy',
    ids: MessageId[],
    to: FolderId,
  ): Promise<MoveResult> {
    const destination = pathOf(to);
    return this.perFolder(ids, emptyMove(), async (client, group, result) => {
      const range = group.entries.map((e) => e.uid).join(',');
      const response =
        kind === 'move'
          ? await client.messageMove(range, destination, { uid: true })
          : await client.messageCopy(range, destination, { uid: true });
      if (!response) throw new Error(`The server refused to ${kind} the messages`);
      group.entries.forEach(({ id, uid }) => {
        const newUid = response.uidMap?.get(uid);
        result.succeeded.push(id);
        result.moved.push(
          newUid !== undefined && response.uidValidity !== undefined
            ? { from: id, to: messageIdOf(destination, response.uidValidity, newUid) }
            : { from: id },
        );
      });
    });
  }

  async move(ids: MessageId[], to: FolderId): Promise<MoveResult> {
    return this.transfer('move', ids, to);
  }

  async copy(ids: MessageId[], to: FolderId): Promise<MoveResult> {
    return this.transfer('copy', ids, to);
  }

  /**
   * To the trash; `permanent`, or already in the trash: expunged for good.
   * A mailbox without a trash folder only allows `permanent`.
   */
  async delete(ids: MessageId[], options: { permanent?: boolean } = {}): Promise<BatchResult> {
    const trash = options.permanent
      ? undefined
      : (await this.reader.listFolders()).find((f) => f.role === 'trash');
    if (!options.permanent && !trash) {
      throw new MailError(
        'not-found',
        'This mailbox has no trash folder: delete with { permanent: true } to expunge',
      );
    }
    const trashPath = trash ? pathOf(trash.id) : undefined;
    return this.perFolder(ids, emptyBatch(), async (client, group, result) => {
      const range = group.entries.map((e) => e.uid).join(',');
      if (trashPath === undefined || group.path === trashPath) {
        refusedUnless(await client.messageDelete(range, { uid: true }), 'delete the messages');
      } else {
        const moved = await client.messageMove(range, trashPath, { uid: true });
        if (!moved) throw new Error('The server refused to move the messages to the trash');
      }
      result.succeeded.push(...group.entries.map((e) => e.id));
    });
  }

  private async folder(path: string): Promise<Folder> {
    const found = (await this.reader.listFolders()).find((f) => f.id === folderIdOf(path));
    if (!found) throw new MailError('not-found', `Folder "${path}" not found after the change`);
    return found;
  }

  async createFolder(name: string, parentId?: FolderId): Promise<Folder> {
    const client = await this.connections.getImapClient(this.account);
    const leaf = await validName(client, name);
    try {
      const parent = parentId ? (await this.folder(pathOf(parentId))).path : [];
      const created = await client.mailboxCreate([...parent, leaf]);
      return await this.folder(created.path);
    } catch (err) {
      throw toMailError(err);
    }
  }

  async renameFolder(id: FolderId, name: string): Promise<Folder> {
    const client = await this.connections.getImapClient(this.account);
    const leaf = await validName(client, name);
    try {
      const current = await this.folder(pathOf(id));
      // Same parent, new last segment; imapflow joins segments with the separator.
      const renamed = await client.mailboxRename(pathOf(id), [...current.path.slice(0, -1), leaf]);
      return await this.folder(renamed.newPath);
    } catch (err) {
      throw toMailError(err);
    }
  }

  async deleteFolder(id: FolderId): Promise<void> {
    const client = await this.connections.getImapClient(this.account);
    try {
      await client.mailboxDelete(pathOf(id));
    } catch (err) {
      throw toMailError(err);
    }
  }
}
