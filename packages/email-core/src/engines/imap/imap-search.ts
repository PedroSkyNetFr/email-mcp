/**
 * Search and conversation threads for the IMAP engine.
 *
 * - One folder: the server searches, pages are anchored on a UID like
 *   `listMessages`, so new mail does not shift them.
 * - No folder: every searchable folder (junk and trash left out) is searched,
 *   results merged newest first. Pages are then positions in that merged
 *   list, recomputed per page: a search result is a snapshot, not a feed.
 * - "Has attachments" is not an IMAP search key: it is checked on the
 *   message structure of the newest MAX_SCANNED candidates, and the page says
 *   `truncated` when more were left unchecked.
 */

import { createHash } from 'node:crypto';
import type { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import type { IConnectionManager } from '../../connections/types.js';
import type {
  ListOptions,
  MessageId,
  MessageSummary,
  Page,
  SearchQuery,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { decodeId, encodeId } from '../../contract/ids.js';
import type ImapService from '../../services/imap.service.js';
import { hasAttachments } from '../../services/imap.service.js';
import type ImapReader from './imap-reader.js';
import {
  folderIdOf,
  IMAP_ENGINE,
  messageIdOf,
  parseMessageId,
  pathOf,
  SUMMARY_FIELDS,
  toFlags,
  toMailError,
  toSummary,
} from './imap-reader.js';

/** Candidates checked on the client for a filter the server cannot evaluate. */
export const MAX_SCANNED = 5000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function toCriteria(query: SearchQuery): SearchObject {
  const criteria: SearchObject = {};
  if (query.text) criteria.text = query.text;
  if (query.from) criteria.from = query.from;
  if (query.to) criteria.to = query.to;
  if (query.subject) criteria.subject = query.subject;
  // IMAP compares dates only (SINCE / BEFORE ignore the time of day).
  if (query.since) criteria.since = new Date(query.since);
  if (query.before) criteria.before = new Date(query.before);
  if (query.seen !== undefined) criteria.seen = query.seen;
  if (query.flagged !== undefined) criteria.flagged = query.flagged;
  return Object.keys(criteria).length > 0 ? criteria : { all: true };
}

/** Binds a page token to its query: a token reused with another query is refused. */
function queryKey(query: SearchQuery): string {
  // The folder is in the token already; the key binds the filters.
  const rest = Object.fromEntries(
    Object.entries(query).filter(([k, v]) => k !== 'folderId' && v !== undefined),
  );
  const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('base64url').slice(0, 16);
}

interface Hit {
  path: string;
  uidValidity: bigint;
  uid: number;
  receivedAt: number;
}

export default class ImapSearch {
  constructor(
    readonly account: string,
    private readonly connections: IConnectionManager,
    private readonly imap: ImapService,
    private readonly reader: ImapReader,
  ) {}

  /** Matching UIDs of one folder, newest first, the attachment filter applied. */
  private static async matching(
    client: ImapFlow,
    query: SearchQuery,
  ): Promise<{ uids: number[]; truncated: boolean; dates: Map<number, number> }> {
    const found = await client.search(toCriteria(query), { uid: true });
    // `false` is a refused search: no result would pass for "nothing matches".
    if (!Array.isArray(found)) {
      throw new MailError('transient', 'The server refused the search: try again or narrow it');
    }
    const uids = found.sort((a, b) => b - a);
    const dates = new Map<number, number>();
    if (query.hasAttachments === undefined) return { uids, truncated: false, dates };
    const scanned = uids.slice(0, MAX_SCANNED);
    const kept = new Set<number>();
    if (scanned.length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- imapflow streams FETCH responses
      for await (const msg of client.fetch(
        scanned.join(','),
        { uid: true, bodyStructure: true, internalDate: true },
        { uid: true },
      )) {
        const has = msg.bodyStructure ? hasAttachments(msg.bodyStructure) : false;
        if (has === query.hasAttachments) kept.add(msg.uid);
        dates.set(msg.uid, new Date(msg.internalDate ?? 0).getTime());
      }
    }
    return {
      uids: scanned.filter((uid) => kept.has(uid)),
      truncated: uids.length > MAX_SCANNED,
      dates,
    };
  }

  async search(query: SearchQuery, options: ListOptions = {}): Promise<Page<MessageSummary>> {
    const size = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const key = queryKey(query);
    try {
      return query.folderId
        ? await this.searchFolder(pathOf(query.folderId), query, key, size, options.page)
        : await this.searchAll(query, key, size, options.page);
    } catch (err) {
      throw toMailError(err);
    }
  }

  private async searchFolder(
    path: string,
    query: SearchQuery,
    key: string,
    size: number,
    page: string | undefined,
  ): Promise<Page<MessageSummary>> {
    let before = Number.POSITIVE_INFINITY;
    let expected: string | undefined;
    if (page) {
      const [kind, pagePath, pageKey, uidValidity, pageBefore] = decodeId(
        page,
        'page',
        IMAP_ENGINE,
      );
      if (
        kind !== 'search' ||
        pagePath !== path ||
        pageKey !== key ||
        typeof pageBefore !== 'number'
      ) {
        throw new MailError('invalid', 'Page token of another search');
      }
      before = pageBefore;
      expected = String(uidValidity);
    }
    const client = await this.connections.getImapClient(this.account);
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const uidValidity = client.mailbox ? client.mailbox.uidValidity : 0n;
      if (expected !== undefined && expected !== String(uidValidity)) {
        throw new MailError('stale-id', `Folder "${path}" was renumbered: search again`);
      }
      const { uids, truncated } = await ImapSearch.matching(client, query);
      const remaining = uids.filter((uid) => uid < before);
      const pageUids = remaining.slice(0, size);
      const items = await ImapSearch.summaries(client, path, uidValidity, pageUids);
      const oldest = pageUids.at(-1);
      return {
        items,
        ...(remaining.length > size && oldest !== undefined
          ? {
              next: encodeId('page', IMAP_ENGINE, [
                'search',
                path,
                key,
                String(uidValidity),
                oldest,
              ]),
            }
          : {}),
        ...(truncated ? { truncated } : {}),
      };
    } finally {
      lock.release();
    }
  }

  private async searchAll(
    query: SearchQuery,
    key: string,
    size: number,
    page: string | undefined,
  ): Promise<Page<MessageSummary>> {
    let offset = 0;
    if (page) {
      const [kind, pageKey, pageOffset] = decodeId(page, 'page', IMAP_ENGINE);
      if (kind !== 'search-all' || pageKey !== key || typeof pageOffset !== 'number') {
        throw new MailError('invalid', 'Page token of another search');
      }
      offset = pageOffset;
    }
    const folders = (await this.reader.listFolders()).filter(
      // Junk and trash are not searched; nor Gmail's All Mail, which holds every
      // message again and would list each one twice.
      (f) => f.selectable && f.role !== 'junk' && f.role !== 'trash' && f.role !== 'all',
    );
    const client = await this.connections.getImapClient(this.account);
    const hits: Hit[] = [];
    let truncated = false;
    // Sequential: one connection, one selected folder at a time.
    await folders.reduce(async (previous, folder) => {
      await previous;
      const path = pathOf(folder.id);
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const uidValidity = client.mailbox ? client.mailbox.uidValidity : 0n;
        const found = await ImapSearch.matching(client, query);
        // Dates are read for the newest MAX_SCANNED only: beyond, the merged
        // order would be wrong, so the rest is left out and said so.
        if (found.uids.length > MAX_SCANNED) found.uids = found.uids.slice(0, MAX_SCANNED);
        truncated ||= found.truncated || found.uids.length === MAX_SCANNED;
        const dated = await ImapSearch.dates(client, found.uids, found.dates);
        found.uids.forEach((uid) => {
          hits.push({ path, uidValidity, uid, receivedAt: dated.get(uid) ?? 0 });
        });
      } finally {
        lock.release();
      }
    }, Promise.resolve());

    hits.sort((a, b) => b.receivedAt - a.receivedAt);
    const pageHits = hits.slice(offset, offset + size);
    // A message filed in two folders (Gmail labels) appears once per page.
    const seen = new Set<string>();
    const items = (await ImapSearch.summariesOf(client, pageHits)).filter((m) => {
      if (!m.messageIdHeader) return true;
      if (seen.has(m.messageIdHeader)) return false;
      seen.add(m.messageIdHeader);
      return true;
    });
    return {
      items,
      ...(hits.length > offset + size
        ? { next: encodeId('page', IMAP_ENGINE, ['search-all', key, offset + size]) }
        : {}),
      ...(truncated ? { truncated } : {}),
    };
  }

  /** Arrival dates of `uids`, from `known` or a FETCH INTERNALDATE. */
  private static async dates(
    client: ImapFlow,
    uids: number[],
    known: Map<number, number>,
  ): Promise<Map<number, number>> {
    const missing = uids.filter((uid) => !known.has(uid)).slice(0, MAX_SCANNED);
    if (missing.length === 0) return known;
    const dates = new Map(known);
    // eslint-disable-next-line no-restricted-syntax -- imapflow streams FETCH responses
    for await (const msg of client.fetch(
      missing.join(','),
      { uid: true, internalDate: true },
      { uid: true },
    )) {
      dates.set(msg.uid, new Date(msg.internalDate ?? 0).getTime());
    }
    return dates;
  }

  private static async summaries(
    client: ImapFlow,
    path: string,
    uidValidity: bigint,
    uids: number[],
  ): Promise<MessageSummary[]> {
    if (uids.length === 0) return [];
    const fetched: FetchMessageObject[] = [];
    // eslint-disable-next-line no-restricted-syntax -- imapflow streams FETCH responses
    for await (const msg of client.fetch(uids.join(','), SUMMARY_FIELDS, { uid: true })) {
      fetched.push(msg);
    }
    return fetched.sort((a, b) => b.uid - a.uid).map((msg) => toSummary(path, uidValidity, msg));
  }

  /** Summaries of hits spread over folders, in the hits' order. */
  private static async summariesOf(client: ImapFlow, hits: Hit[]): Promise<MessageSummary[]> {
    const byPath = new Map<string, Hit[]>();
    hits.forEach((hit) => {
      byPath.set(hit.path, [...(byPath.get(hit.path) ?? []), hit]);
    });
    const found = new Map<MessageId, MessageSummary>();
    await [...byPath.entries()].reduce(async (previous, [path, folderHits]) => {
      await previous;
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const first = folderHits[0];
        if (!first) return;
        const summaries = await ImapSearch.summaries(
          client,
          path,
          first.uidValidity,
          folderHits.map((h) => h.uid),
        );
        summaries.forEach((s) => {
          found.set(s.id, s);
        });
      } finally {
        lock.release();
      }
    }, Promise.resolve());
    return hits
      .map((hit) => found.get(messageIdOf(hit.path, hit.uidValidity, hit.uid)))
      .filter((s): s is MessageSummary => s !== undefined);
  }

  /**
   * The conversation of a message, oldest first, from its folder (the
   * existing thread reconstruction, by References / In-Reply-To / Message-ID).
   */
  async getThread(id: MessageId): Promise<MessageSummary[]> {
    const { path, uidValidity } = parseMessageId(id);
    await this.reader.locate(id); // validates the id (stale, missing) before any work
    try {
      const { uid } = parseMessageId(id);
      const thread = await this.imap.getThread(this.account, String(uid), path);
      return thread.messages
        .map(
          (m): MessageSummary => ({
            id: messageIdOf(path, uidValidity, Number(m.id)),
            folderId: folderIdOf(path),
            messageIdHeader: m.messageId?.replace(/^<|>$/g, '') || undefined,
            subject: m.subject,
            from: m.from,
            to: m.to,
            cc: m.cc ?? [],
            sentAt: m.date,
            receivedAt: m.date,
            size: 0,
            flags: toFlags(
              new Set([
                ...(m.seen ? ['\\Seen'] : []),
                ...(m.flagged ? ['\\Flagged'] : []),
                ...(m.answered ? ['\\Answered'] : []),
                ...m.labels,
              ]),
            ),
            hasAttachments: m.hasAttachments,
          }),
        )
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    } catch (err) {
      throw toMailError(err);
    }
  }
}
