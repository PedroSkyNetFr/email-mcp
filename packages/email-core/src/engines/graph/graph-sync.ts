/**
 * `listChanges` for Microsoft Graph: the folder's delta query.
 *
 * `GET /me/mailFolders/{id}/messages/delta` returns pages of changed
 * messages, then a `@odata.deltaLink` to resume from next time. The cursor
 * holds the link of the page being consumed and the ids already delivered
 * from it: a batch capped by size stops in the middle of a Graph page, and the
 * next call asks for the same page again and skips what was delivered.
 *
 * Graph does not tell a new message from a changed one: every message in the
 * delta is reported in `added` (raw source included), as the contract allows;
 * the host deduplicates by Message-ID. `@removed` entries are removals. An
 * expired delta token (410 Gone) is a `reset`.
 *
 * The delta query returns no message size, so `maxBytes` is applied while
 * downloading the sources: the batch stops after the message that crosses it.
 */

import type {
  AddedMessage,
  ChangeBatch,
  FolderId,
  ListChangesOptions,
  SyncCursor,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { decodeId, encodeId } from '../../contract/ids.js';
import type GraphClient from '../../services/graph/graph.client.js';
import { GraphError } from '../../services/graph/graph.client.js';
import type { GraphPageOf, GraphSummary } from './graph-reader.js';
import {
  GRAPH_ENGINE,
  graphFolderId,
  messageIdOf,
  stripAngles,
  toFlags,
  toMailError,
} from './graph-reader.js';

const DEFAULT_MAX_MESSAGES = 50;
const MAX_MESSAGES = 500;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DELTA_SELECT =
  'id,internetMessageId,isRead,isDraft,flag,categories,receivedDateTime,parentFolderId';
const FIDELITY: ChangeBatch['fidelity'] = { flags: 'exact', removals: 'exact' };

const firstLink = (folder: string): string =>
  `/me/mailFolders/${folder}/messages/delta?$select=${DELTA_SELECT}`;

const encodeCursor = (folder: string, link: string, delivered: string[]): SyncCursor =>
  encodeId('cursor', GRAPH_ENGINE, [folder, link, ...delivered]);

export default class GraphSync {
  constructor(private readonly client: GraphClient) {}

  async listChanges(
    folderId: FolderId,
    cursor: SyncCursor | null,
    options: ListChangesOptions = {},
  ): Promise<ChangeBatch> {
    const folder = graphFolderId(folderId);
    const max = Math.min(Math.max(options.maxMessages ?? DEFAULT_MAX_MESSAGES, 1), MAX_MESSAGES);
    const maxBytes = Math.max(options.maxBytes ?? DEFAULT_MAX_BYTES, 1);
    const includeRaw = options.includeRaw ?? true;

    let link = firstLink(folder);
    let delivered = new Set<string>();
    if (cursor !== null) {
      const [cursorFolder, cursorLink, ...ids] = decodeId(cursor, 'cursor', GRAPH_ENGINE);
      if (cursorFolder !== folder || typeof cursorLink !== 'string') {
        throw new MailError('not-found', 'Sync cursor of another folder');
      }
      link = cursorLink;
      delivered = new Set(ids.filter((i): i is string => typeof i === 'string'));
    }

    let page: GraphPageOf<GraphSummary>;
    try {
      page = await this.client.request<GraphPageOf<GraphSummary>>('GET', link, undefined, {
        Prefer: `odata.maxpagesize=${max}, IdType="ImmutableId"`,
      });
    } catch (err) {
      // An expired or unknown delta token: start this folder over.
      if (
        err instanceof GraphError &&
        (err.status === 410 || /syncStateNotFound/i.test(err.body ?? ''))
      ) {
        return {
          added: [],
          flagsChanged: [],
          removed: [],
          reset: true,
          complete: true,
          nextCursor: encodeCursor(folder, firstLink(folder), []),
          fidelity: FIDELITY,
        };
      }
      throw toMailError(err);
    }

    const added: AddedMessage[] = [];
    const removed: string[] = [];
    let bytes = 0;
    let stoppedEarly = false;
    const pending = page.value.filter((m) => !delivered.has(m.id));
    // Sequential: a size cap needs each source's size before the next download.
    await pending.reduce(async (previous, message) => {
      await previous;
      if (stoppedEarly) return;
      if (message['@removed']) {
        removed.push(messageIdOf(message.id));
        delivered.add(message.id);
        return;
      }
      if (includeRaw && added.length > 0 && bytes >= maxBytes) {
        stoppedEarly = true;
        return;
      }
      const raw = includeRaw
        ? await this.client.getBinary(`/me/messages/${message.id}/$value`).catch((err: unknown) => {
            throw toMailError(err);
          })
        : undefined;
      bytes += raw?.length ?? 0;
      added.push({
        id: messageIdOf(message.id),
        ...(message.internetMessageId
          ? { messageIdHeader: stripAngles(message.internetMessageId) }
          : {}),
        flags: toFlags(message),
        receivedAt: new Date(message.receivedDateTime ?? 0).toISOString(),
        size: raw?.length ?? 0,
        ...(raw ? { raw } : {}),
      });
      delivered.add(message.id);
    }, Promise.resolve());

    const next = page['@odata.nextLink'];
    const delta = page['@odata.deltaLink'];
    let nextCursor: SyncCursor;
    let complete = false;
    if (stoppedEarly) {
      nextCursor = encodeCursor(folder, link, [...delivered]); // same page, minus what was delivered
    } else if (next) {
      nextCursor = encodeCursor(folder, next, []);
    } else {
      nextCursor = encodeCursor(folder, delta ?? link, []);
      complete = true;
    }

    return {
      added,
      flagsChanged: [],
      removed,
      reset: false,
      complete,
      nextCursor,
      fidelity: FIDELITY,
    };
  }
}
