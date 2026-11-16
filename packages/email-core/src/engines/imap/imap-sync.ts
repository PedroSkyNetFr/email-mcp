/**
 * `listChanges` for IMAP: what changed in one folder since a cursor.
 *
 * The algorithm is adapted from Zero's IMAP sync engine
 * (https://github.com/Mail-0/Zero, apps/server/src/lib/imap/sync.ts, commit
 * 4b642dfd9890a1fdcb1b98a177fe74ca3142c445), used under the MIT License:
 *
 *   Copyright (c) 2025 Zero Email
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the
 *   following conditions: The above copyright notice and this permission
 *   notice shall be included in all copies or substantial portions of the
 *   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 *   KIND, EXPRESS OR IMPLIED.
 *
 * What is taken from Zero, each for a failure it prevents:
 * - a STATUS comparison first: an untouched folder costs one command;
 * - UIDVALIDITY checked on every pass: a renumbered folder is reported as a
 *   `reset`, never merged with the old numbering;
 * - `UID n:*` filtered on `uid >= n`: IMAP answers that range with the last
 *   message even when its UID is below n, which would otherwise be reported
 *   as new on every pass;
 * What differs: Zero keeps a local index of known UIDs; this engine keeps
 * nothing. Zero also holds its modification sequence back until a folder is
 * caught up, because a capped pass leaves holes in its index; here every
 * batch reads the sequence when the folder is opened, before fetching, so it
 * can always move on (see step 5). The whole state is the cursor the host stores, so removals rely on
 * QRESYNC (VANISHED) instead of comparing with known UIDs.
 */

import type { FetchMessageObject, ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../../connections/types.js';
import type {
  AddedMessage,
  ChangeBatch,
  FolderId,
  ListChangesOptions,
  SyncCursor,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { decodeId, encodeId } from '../../contract/ids.js';
import {
  IMAP_ENGINE,
  messageIdOf,
  pathOf,
  stripAngles,
  toFlags,
  toMailError,
} from './imap-reader.js';

const DEFAULT_MAX_MESSAGES = 50;
const MAX_MESSAGES = 500;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Cursor state: everything needed to resume, nothing kept in the engine. */
interface CursorState {
  path: string;
  uidValidity: string;
  /** Highest UID already reported as added; 0 before the first batch. */
  lastUid: number;
  /** Changes after this modification sequence are still to report; null without CONDSTORE. */
  modseq: string | null;
}

function encodeCursor(state: CursorState): SyncCursor {
  return encodeId('cursor', IMAP_ENGINE, [
    state.path,
    state.uidValidity,
    state.lastUid,
    state.modseq,
  ]);
}

function decodeCursor(cursor: SyncCursor, path: string): CursorState {
  const [cursorPath, uidValidity, lastUid, modseq] = decodeId(cursor, 'cursor', IMAP_ENGINE);
  if (
    cursorPath !== path ||
    typeof uidValidity !== 'string' ||
    typeof lastUid !== 'number' ||
    (modseq !== null && typeof modseq !== 'string')
  ) {
    throw new MailError('not-found', 'Sync cursor of another folder');
  }
  return { path: cursorPath, uidValidity, lastUid, modseq };
}

const emptyBatch = (
  nextCursor: SyncCursor,
  fidelity: ChangeBatch['fidelity'],
  reset = false,
): ChangeBatch => ({
  added: [],
  flagsChanged: [],
  removed: [],
  reset,
  complete: true,
  nextCursor,
  fidelity,
});

/**
 * The longest prefix of `uids` whose sources fit in `maxBytes`, at least one
 * message. Sizes come from a cheap FETCH (RFC822.SIZE) before any source is
 * downloaded.
 */
async function withinBytes(client: ImapFlow, uids: number[], maxBytes: number): Promise<number[]> {
  if (uids.length <= 1) return uids;
  const sizes = new Map<number, number>();
  // eslint-disable-next-line no-restricted-syntax -- imapflow streams FETCH responses
  for await (const msg of client.fetch(uids.join(','), { uid: true, size: true }, { uid: true })) {
    sizes.set(msg.uid, msg.size ?? 0);
  }
  let total = 0;
  const kept: number[] = [];
  // `some` stops at the first message that no longer fits.
  uids.some((uid) => {
    total += sizes.get(uid) ?? 0;
    if (kept.length > 0 && total > maxBytes) return true;
    kept.push(uid);
    return false;
  });
  return kept;
}

export default class ImapSync {
  private client: ImapFlow | undefined;

  constructor(
    readonly account: string,
    private readonly connections: IConnectionManager,
  ) {}

  /**
   * The engine's own connection, with QRESYNC asked for. Kept between calls
   * (a host polls every folder regularly), reopened when the server dropped it.
   */
  private async syncClient(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    this.client = await this.connections.createEphemeralImapClient(this.account, {
      qresync: true,
    });
    return this.client;
  }

  async close(): Promise<void> {
    const { client } = this;
    this.client = undefined;
    await client?.logout().catch(() => client.close());
  }

  async listChanges(
    folderId: FolderId,
    cursor: SyncCursor | null,
    options: ListChangesOptions = {},
  ): Promise<ChangeBatch> {
    const path = pathOf(folderId);
    const previous = cursor === null ? undefined : decodeCursor(cursor, path);
    const max = Math.min(Math.max(options.maxMessages ?? DEFAULT_MAX_MESSAGES, 1), MAX_MESSAGES);
    const includeRaw = options.includeRaw ?? true;
    const maxBytes = Math.max(options.maxBytes ?? DEFAULT_MAX_BYTES, 1);

    try {
      const client = await this.syncClient();
      const condstore = client.enabled.has('CONDSTORE');
      const fidelity: ChangeBatch['fidelity'] = {
        flags: condstore ? 'exact' : 'none',
        removals: condstore && client.enabled.has('QRESYNC') ? 'exact' : 'none',
      };

      // 1. A cheap STATUS first: an untouched folder costs one command.
      // imapflow answers `false` when the server refused STATUS: then the
      // folder is simply opened below, never taken as empty (the trap of
      // treating it as "position 0", which re-reads the whole folder).
      const status = previous
        ? await client.status(path, { uidNext: true, uidValidity: true, highestModseq: condstore })
        : false;
      if (previous && status) {
        const sameNumbering = String(status.uidValidity) === previous.uidValidity;
        const noNewMail = (status.uidNext ?? 0) <= previous.lastUid + 1;
        const noChange =
          !condstore ||
          (previous.modseq !== null && String(status.highestModseq) === previous.modseq);
        if (sameNumbering && noNewMail && noChange) return emptyBatch(cursor ?? '', fidelity);
      }

      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const { mailbox } = client;
        if (!mailbox) throw new MailError('not-found', `Folder "${path}" could not be opened`);
        const uidValidity = String(mailbox.uidValidity);
        const modseqNow =
          condstore && !mailbox.noModseq && mailbox.highestModseq !== undefined
            ? String(mailbox.highestModseq)
            : null;

        // 2. Renumbered folder: every id the host holds for it is void.
        if (previous && previous.uidValidity !== uidValidity) {
          const restart = encodeCursor({ path, uidValidity, lastUid: 0, modseq: null });
          return emptyBatch(restart, fidelity, true);
        }

        const lastUid = previous?.lastUid ?? 0;

        // 3. New messages, oldest first, capped.
        const from = lastUid + 1;
        const found = await client.search({ uid: `${from}:*` }, { uid: true });
        // `n:*` always matches the last message, even below n: keep only real news.
        const fresh = (Array.isArray(found) ? found : []).filter((uid) => uid >= from);
        fresh.sort((a, b) => a - b);
        const take = includeRaw
          ? await withinBytes(client, fresh.slice(0, max), maxBytes)
          : fresh.slice(0, max);
        const complete = take.length === fresh.length;
        const added = await this.fetchAdded(client, path, uidValidity, take, includeRaw);

        // 4. Flag changes and removals among the messages already reported.
        const { flagsChanged, removed } =
          previous && lastUid > 0 && previous.modseq !== null && modseqNow !== null
            ? await this.changesSince(client, path, uidValidity, lastUid, previous.modseq)
            : { flagsChanged: [], removed: [] };

        // 5. Next time, report changes made after this folder was opened. Safe
        // at every batch, capped or not: a message not reported yet will come
        // with its flags as they are then; one already reported and changed
        // after the opening has a higher modification sequence. (A change made
        // between the opening and the fetch above is reported twice: harmless.)
        const nextModseq = modseqNow;
        const newestTaken = take.at(-1) ?? lastUid;
        const nextLastUid = complete
          ? Math.max(newestTaken, (mailbox.uidNext ?? 1) - 1, lastUid)
          : newestTaken;

        return {
          added,
          flagsChanged,
          removed,
          reset: false,
          complete,
          nextCursor: encodeCursor({
            path,
            uidValidity,
            lastUid: nextLastUid,
            modseq: nextModseq,
          }),
          fidelity,
        };
      } finally {
        lock.release();
        // Leave no folder selected between calls: a server answers STATUS on
        // the selected folder with this session's frozen view of it (measured
        // on Dovecot), so the next call would miss new mail, flag changes and
        // even a renumbering. Opened read-only: closing it expunges nothing.
        await client.mailboxClose().catch(() => undefined);
      }
    } catch (err) {
      throw toMailError(err);
    }
  }

  // eslint-disable-next-line class-methods-use-this -- kept with the sync steps it serves
  private async fetchAdded(
    client: ImapFlow,
    path: string,
    uidValidity: string,
    uids: number[],
    includeRaw: boolean,
  ): Promise<AddedMessage[]> {
    if (uids.length === 0) return [];
    const fetched: FetchMessageObject[] = [];
    // eslint-disable-next-line no-restricted-syntax -- imapflow streams FETCH responses
    for await (const msg of client.fetch(
      uids.join(','),
      {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true,
        source: includeRaw,
      },
      { uid: true },
    )) {
      fetched.push(msg);
    }
    return fetched
      .sort((a, b) => a.uid - b.uid)
      .map((msg) => ({
        id: messageIdOf(path, uidValidity, msg.uid),
        messageIdHeader: stripAngles(msg.envelope?.messageId),
        flags: toFlags(msg.flags),
        receivedAt: new Date(msg.internalDate ?? 0).toISOString(),
        size: msg.size ?? 0,
        ...(includeRaw && msg.source ? { raw: msg.source } : {}),
      }));
  }

  /**
   * CHANGEDSINCE over the already-reported range. With QRESYNC enabled,
   * imapflow adds VANISHED and the server reports the expunged UIDs as
   * `expunge` events (VANISHED EARLIER), in the same round trip.
   */
  // eslint-disable-next-line class-methods-use-this -- kept with the sync steps it serves
  private async changesSince(
    client: ImapFlow,
    path: string,
    uidValidity: string,
    lastUid: number,
    modseq: string,
  ): Promise<Pick<ChangeBatch, 'flagsChanged' | 'removed'>> {
    const vanished: number[] = [];
    const onExpunge = (event: { path: string; uid?: number; vanished: boolean }): void => {
      if (
        event.path === path &&
        event.vanished &&
        event.uid !== undefined &&
        event.uid <= lastUid
      ) {
        vanished.push(event.uid);
      }
    };
    client.on('expunge', onExpunge);
    const changed: FetchMessageObject[] = [];
    try {
      // eslint-disable-next-line no-restricted-syntax -- imapflow streams FETCH responses
      for await (const msg of client.fetch(
        `1:${lastUid}`,
        { uid: true, flags: true },
        { uid: true, changedSince: BigInt(modseq) },
      )) {
        if (msg.uid <= lastUid) changed.push(msg);
      }
    } finally {
      client.off('expunge', onExpunge);
    }
    return {
      flagsChanged: changed.map((msg) => ({
        id: messageIdOf(path, uidValidity, msg.uid),
        flags: toFlags(msg.flags),
      })),
      removed: [...new Set(vanished)].map((uid) => messageIdOf(path, uidValidity, uid)),
    };
  }
}
