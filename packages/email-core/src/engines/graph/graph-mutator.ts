/**
 * The changing half of the Graph engine: flags, move, copy, delete, folders.
 *
 * Exchange has no IMAP \Answered flag: "answered" and "forwarded" are the
 * message's last verb (MAPI PidTagLastVerbExecuted, 102 / 104), which Outlook
 * shows as the reply / forward arrow. Keywords are Outlook categories.
 * Immutable ids survive a move: the id returned by a move is the same.
 */

import type {
  BatchResult,
  FlagChange,
  Folder,
  FolderId,
  MessageId,
  MoveResult,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import type GraphClient from '../../services/graph/graph.client.js';
import type GraphReader from './graph-reader.js';
import {
  folderIdOf,
  graphFolderId,
  graphMessageId,
  guard,
  IMMUTABLE,
  messageIdOf,
  toMailError,
  VERB_FORWARDED,
  VERB_REPLIED,
} from './graph-reader.js';

const errorText = (err: unknown): string => {
  const mapped = toMailError(err);
  return mapped instanceof Error ? mapped.message : String(mapped);
};

export default class GraphMutator {
  constructor(
    private readonly client: GraphClient,
    private readonly reader: GraphReader,
  ) {}

  /** Runs `work` per message, sequentially (Graph throttles bursts); never throws per id. */
  private static async each<T extends BatchResult>(
    ids: MessageId[],
    result: T,
    work: (graphId: string, id: MessageId) => Promise<void>,
  ): Promise<T> {
    await ids.reduce(async (previous, id) => {
      await previous;
      try {
        await work(graphMessageId(id), id);
        result.succeeded.push(id);
      } catch (err) {
        result.failed.push({ id, error: errorText(err) });
      }
    }, Promise.resolve());
    return result;
  }

  async setFlags(ids: MessageId[], change: FlagChange): Promise<BatchResult> {
    const touchesKeywords =
      (change.addKeywords?.length ?? 0) > 0 || (change.removeKeywords?.length ?? 0) > 0;
    return GraphMutator.each(ids, { succeeded: [], failed: [] }, async (graphId) => {
      const patch: Record<string, unknown> = {};
      if (change.seen !== undefined) patch.isRead = change.seen;
      if (change.flagged !== undefined) {
        patch.flag = { flagStatus: change.flagged ? 'flagged' : 'notFlagged' };
      }
      if (change.answered !== undefined) {
        patch.singleValueExtendedProperties = [
          { id: 'Integer 0x1081', value: change.answered ? VERB_REPLIED : '0' },
        ];
      }
      if (touchesKeywords) {
        const current = await this.client.request<{ categories?: string[] }>(
          'GET',
          `/me/messages/${graphId}?$select=categories`,
        );
        const next = new Set(current.categories ?? []);
        change.addKeywords?.forEach((k) => {
          next.add(k);
        });
        change.removeKeywords?.forEach((k) => {
          next.delete(k);
        });
        patch.categories = [...next];
      }
      if (Object.keys(patch).length > 0) {
        await this.client.request('PATCH', `/me/messages/${graphId}`, patch);
      }
    });
  }

  /** Marks a message forwarded (Outlook's forward arrow). */
  async markForwarded(id: MessageId): Promise<void> {
    await guard(async () =>
      this.client.request('PATCH', `/me/messages/${graphMessageId(id)}`, {
        singleValueExtendedProperties: [{ id: 'Integer 0x1081', value: VERB_FORWARDED }],
      }),
    );
  }

  private async transfer(
    kind: 'move' | 'copy',
    ids: MessageId[],
    to: FolderId,
  ): Promise<MoveResult> {
    const destinationId = graphFolderId(to);
    const result: MoveResult = { succeeded: [], failed: [], moved: [] };
    return GraphMutator.each(ids, result, async (graphId, id) => {
      const moved = await this.client.request<{ id: string }>(
        'POST',
        `/me/messages/${graphId}/${kind}`,
        { destinationId },
        IMMUTABLE,
      );
      result.moved.push({ from: id, to: messageIdOf(moved.id) });
    });
  }

  async move(ids: MessageId[], to: FolderId): Promise<MoveResult> {
    return this.transfer('move', ids, to);
  }

  async copy(ids: MessageId[], to: FolderId): Promise<MoveResult> {
    return this.transfer('copy', ids, to);
  }

  /** To Deleted Items; `permanent`, or already there: deleted for good. */
  async delete(ids: MessageId[], options: { permanent?: boolean } = {}): Promise<BatchResult> {
    const trash = await this.reader.wellKnown('deleteditems');
    return GraphMutator.each(ids, { succeeded: [], failed: [] }, async (graphId) => {
      const { parentFolderId } = await this.client.request<{ parentFolderId?: string }>(
        'GET',
        `/me/messages/${graphId}?$select=parentFolderId`,
      );
      if (options.permanent || parentFolderId === trash) {
        await this.client.request('POST', `/me/messages/${graphId}/permanentDelete`);
      } else {
        await this.client.request('POST', `/me/messages/${graphId}/move`, {
          destinationId: 'deleteditems',
        });
      }
    });
  }

  private async folder(graphId: string): Promise<Folder> {
    const found = (await this.reader.listFolders()).find((f) => f.id === folderIdOf(graphId));
    if (!found) throw new MailError('not-found', 'Folder not found after the change');
    return found;
  }

  async createFolder(name: string, parentId?: FolderId): Promise<Folder> {
    const displayName = name.trim();
    if (displayName === '') throw new MailError('invalid', 'A folder name cannot be empty');
    const path = parentId
      ? `/me/mailFolders/${graphFolderId(parentId)}/childFolders`
      : '/me/mailFolders';
    const created = await guard(async () =>
      this.client.request<{ id: string }>('POST', path, { displayName }),
    );
    return this.folder(created.id);
  }

  async renameFolder(id: FolderId, name: string): Promise<Folder> {
    const displayName = name.trim();
    if (displayName === '') throw new MailError('invalid', 'A folder name cannot be empty');
    const graphId = graphFolderId(id);
    await guard(async () =>
      this.client.request('PATCH', `/me/mailFolders/${graphId}`, { displayName }),
    );
    return this.folder(graphId);
  }

  async deleteFolder(id: FolderId): Promise<void> {
    await guard(async () => this.client.request('DELETE', `/me/mailFolders/${graphFolderId(id)}`));
  }
}
