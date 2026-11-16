/**
 * Search for the Graph engine.
 *
 * Graph offers two query modes that cannot be combined: `$search` (KQL, full
 * text, relevance order, no `$filter`) and `$filter` (exact properties, date
 * order). A query with text criteria (text, from, to, subject) goes to
 * `$search`, with dates and attachments in KQL too; read / flagged status,
 * which KQL cannot express here, is then checked on each page, so a page may
 * hold fewer items than asked while `next` still continues. A query without
 * text goes to `$filter`, newest first.
 *
 * Pages follow Graph's own `@odata.nextLink`: a search result is a snapshot.
 */

import { createHash } from 'node:crypto';
import type {
  ListOptions,
  MessageSummary,
  Page,
  SearchQuery,
} from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { decodeId, encodeId } from '../../contract/ids.js';
import type GraphClient from '../../services/graph/graph.client.js';
import type { GraphPageOf, GraphSummary } from './graph-reader.js';
import {
  GRAPH_ENGINE,
  graphFolderId,
  guard,
  IMMUTABLE,
  SUMMARY_QUERY,
  seg,
  toSummary,
} from './graph-reader.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * KQL in the form the MCP server's search uses on Outlook.com (measured): the
 * whole query goes inside one pair of quotes in $search, so values carry no
 * quotes of their own; a multi-word value becomes one term per word.
 */
const words = (value: string): string[] =>
  value.replace(/["\\]/g, ' ').split(/\s+/).filter(Boolean);
const property = (name: string, value: string): string | undefined => {
  const list = words(value);
  if (list.length === 0) return undefined;
  return list.length === 1
    ? `${name}:${list[0]}`
    : `(${list.map((w) => `${name}:${w}`).join(' AND ')})`;
};
const DAY_MS = 24 * 60 * 60 * 1000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function kqlQuery(query: SearchQuery): string {
  const terms: (string | undefined)[] = [
    query.text ? words(query.text).join(' ') : undefined,
    query.from ? property('from', query.from) : undefined,
    query.to ? property('to', query.to) : undefined,
    query.subject ? property('subject', query.subject) : undefined,
    // KQL dates are whole days in the mailbox's zone: widened by a day each
    // side, the exact bounds are applied to the results (see inBounds).
    query.since ? `received>=${day(Date.parse(query.since) - DAY_MS)}` : undefined,
    query.before ? `received<${day(Date.parse(query.before) + 2 * DAY_MS)}` : undefined,
    query.hasAttachments === undefined ? undefined : `hasattachments:${query.hasAttachments}`,
  ];
  return terms.filter((t): t is string => Boolean(t)).join(' AND ');
}

const inBounds = (query: SearchQuery, received: string | undefined): boolean => {
  const t = received ? Date.parse(received) : Number.NaN;
  if (query.since && !(t >= Date.parse(query.since))) return false;
  if (query.before && !(t < Date.parse(query.before))) return false;
  return true;
};

function odataFilter(query: SearchQuery): string {
  // Graph requires the $orderby property (receivedDateTime) first in $filter,
  // or answers InefficientFilter (found in review): a lower bound always leads.
  const clauses: string[] = [
    `receivedDateTime ge ${query.since ? new Date(query.since).toISOString() : '1900-01-01T00:00:00Z'}`,
  ];
  if (query.before) clauses.push(`receivedDateTime lt ${new Date(query.before).toISOString()}`);
  if (query.seen !== undefined) clauses.push(`isRead eq ${query.seen}`);
  if (query.flagged !== undefined) {
    clauses.push(query.flagged ? "flag/flagStatus eq 'flagged'" : "flag/flagStatus ne 'flagged'");
  }
  if (query.hasAttachments !== undefined) clauses.push(`hasAttachments eq ${query.hasAttachments}`);
  return clauses.join(' and ');
}

/** Binds a page token to its query; a field left undefined is no criterion. */

function queryKey(query: SearchQuery): string {
  const sorted = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('base64url').slice(0, 16);
}

export default class GraphSearch {
  constructor(private readonly client: GraphClient) {}

  async search(query: SearchQuery, options: ListOptions = {}): Promise<Page<MessageSummary>> {
    const size = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const key = queryKey(query);
    // An empty string is no criterion.
    const textual = [query.text, query.from, query.to, query.subject].some(
      (v) => v !== undefined && v !== '',
    );
    let url: string;
    if (options.page) {
      const [kind, pageKey, link] = decodeId(options.page, 'page', GRAPH_ENGINE);
      if (kind !== 'search' || pageKey !== key || typeof link !== 'string') {
        throw new MailError('invalid', 'Page token of another search');
      }
      url = link;
    } else {
      const scope = query.folderId
        ? `/me/mailFolders/${seg(graphFolderId(query.folderId))}/messages`
        : '/me/messages';
      const filter = odataFilter(query);
      url = textual
        ? `${scope}?$search=${encodeURIComponent(`"${kqlQuery(query)}"`)}&$top=${size}&${SUMMARY_QUERY}`
        : `${scope}?$top=${size}&$orderby=receivedDateTime desc${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}&${SUMMARY_QUERY}`;
    }
    return guard(async () => {
      const page = await this.client.request<GraphPageOf<GraphSummary>>(
        'GET',
        url,
        undefined,
        IMMUTABLE,
      );
      // With $search, read / flagged status is checked here (see header).
      const kept = textual
        ? page.value.filter(
            (m) =>
              inBounds(query, m.receivedDateTime) &&
              (query.seen === undefined || (m.isRead ?? false) === query.seen) &&
              (query.flagged === undefined || (m.flag?.flagStatus === 'flagged') === query.flagged),
          )
        : page.value;
      const next = page['@odata.nextLink'];
      return {
        items: kept.map(toSummary),
        ...(next ? { next: encodeId('page', GRAPH_ENGINE, ['search', key, next]) } : {}),
      };
    });
  }
}
