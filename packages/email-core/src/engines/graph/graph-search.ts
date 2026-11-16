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
  toSummary,
} from './graph-reader.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** A KQL value, quoted: spaces and quotes survive. */
const kql = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;
const day = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

function kqlQuery(query: SearchQuery): string {
  const terms: string[] = [];
  if (query.text) terms.push(kql(query.text));
  if (query.from) terms.push(`from:${kql(query.from)}`);
  if (query.to) terms.push(`to:${kql(query.to)}`);
  if (query.subject) terms.push(`subject:${kql(query.subject)}`);
  if (query.since) terms.push(`received>=${day(query.since)}`);
  if (query.before) terms.push(`received<${day(query.before)}`);
  if (query.hasAttachments !== undefined) terms.push(`hasattachments:${query.hasAttachments}`);
  return terms.join(' AND ');
}

function odataFilter(query: SearchQuery): string {
  const clauses: string[] = [];
  if (query.since) clauses.push(`receivedDateTime ge ${new Date(query.since).toISOString()}`);
  if (query.before) clauses.push(`receivedDateTime lt ${new Date(query.before).toISOString()}`);
  if (query.seen !== undefined) clauses.push(`isRead eq ${query.seen}`);
  if (query.flagged !== undefined) {
    clauses.push(query.flagged ? "flag/flagStatus eq 'flagged'" : "flag/flagStatus ne 'flagged'");
  }
  if (query.hasAttachments !== undefined) clauses.push(`hasAttachments eq ${query.hasAttachments}`);
  return clauses.join(' and ');
}

function queryKey(query: SearchQuery): string {
  const sorted = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
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
        ? `/me/mailFolders/${graphFolderId(query.folderId)}/messages`
        : '/me/messages';
      const filter = odataFilter(query);
      url = textual
        ? `${scope}?$search=${encodeURIComponent(kqlQuery(query))}&$top=${size}&${SUMMARY_QUERY}`
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
