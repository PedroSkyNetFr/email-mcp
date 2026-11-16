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

function groupByFolder(ids: MessageId[]): Group[] {
  const groups = new Map<string, Group>();
  ids.forEach((id) => {
    const { path, uidValidity, uid } = parseMessageId(id);
    const key = `${path}\u0000${uidValidity}`;
    const group = groups.get(key) ?? { path, uidValidity, entries: [] };
    group.entries.push({ id, uid });
    groups.set(key, group);
  });
  return [...groups.values()];
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
    const client = await this.connections.getImapClient(this.account);
    // Sequential: one connection, one selected folder at a time.
    await groupByFolder(ids).reduce(async (previous, group) => {
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
      if (add.length > 0) await c.messageFlagsAdd(range, add, { uid: true });
      if (remove.length > 0) await c.messageFlagsRemove(range, remove, { uid: true });
      // Gmail stores keywords as labels (X-GM-LABELS); other servers as IMAP keywords.
      if (addKeywords.length > 0) {
        await c.messageFlagsAdd(range, addKeywords, { uid: true, useLabels: labels });
      }
      if (removeKeywords.length > 0) {
        await c.messageFlagsRemove(range, removeKeywords, { uid: true, useLabels: labels });
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
        await client.messageDelete(range, { uid: true });
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
