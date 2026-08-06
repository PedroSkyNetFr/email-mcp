/**
 * Shared helper that translates a high-level Power Search parameter object
 * into an imapflow search criteria object plus any post-pagination filters.
 *
 * Used by `ImapService.searchEmails` and `ImapService.listEmails` so the two
 * entry points share identical filter semantics.
 */

import { sanitizeSearchQuery } from '../safety/validation.js';
import { normalizeDate } from '../utils/date.js';

export interface SearchParams {
  query?: string;
  to?: string;
  from?: string;
  subject?: string;
  cc?: string;
  bcc?: string;
  text?: string;
  body?: string;
  since?: string;
  before?: string;
  on?: string;
  sentSince?: string;
  sentBefore?: string;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
  deleted?: boolean;
  keyword?: string | string[];
  notKeyword?: string | string[];
  header?: Record<string, string>;
  uids?: number[] | string;
  largerThan?: number; // tool-facing KB — multiplied to bytes here
  smallerThan?: number;
  // Post-pagination filters (not part of IMAP search — applied client-side):
  hasAttachment?: boolean;
  /** Substring match (case-insensitive) against any attachment filename. */
  attachmentFilename?: string;
  /** Regex (case-insensitive) applied to `${type}/${subtype}` of each attachment. */
  attachmentMimetype?: string;
  /**
   * Literal substring match on the `From` header, applied HERE rather than by
   * the server.
   *
   * `from` is handed to the server untouched, so what it matches is whatever
   * the server's index does. RFC 3501 defines `SEARCH FROM` as a substring
   * match, but a server with a full-text index (Dovecot FTS, and OVH's in
   * particular) matches indexed TOKENS instead: searching
   * `enviropro-salon.fr` then misses `contact@news.enviropro-salon.fr`, and
   * `salon.fr` misses everything — while the shorter `enviropro` matches both.
   * A caller expecting `contains` gets a silent subset.
   *
   * These `*Contains` filters never reach the server. The set the server
   * returns is filtered here on the decoded header, so the result is the same
   * on every provider. The cost is that the server-side query must be wide
   * enough to contain the answer — hence the warning when nothing else narrows
   * it.
   */
  fromContains?: string;
  /** Literal substring match on any `To` recipient. See {@link fromContains}. */
  toContains?: string;
  /** Literal substring match on the decoded subject. See {@link fromContains}. */
  subjectContains?: string;
  /** Faceted counts to return alongside the paginated result. */
  facets?: ('sender' | 'year' | 'mailbox')[];
  gmailRaw?: string;
}

export interface BuildResult {
  criteria: Record<string, unknown>;
  postFilters: {
    hasAttachment?: boolean;
    attachmentFilename?: string;
    attachmentMimetype?: string;
    fromContains?: string;
    toContains?: string;
    subjectContains?: string;
    facets?: ('sender' | 'year' | 'mailbox')[];
  };
  gmailRawUsed: boolean;
  /**
   * True when the built criteria will make the server scan message BODIES —
   * a free-text `query` (deep by default: subject/from/body OR), or an
   * explicit `body:`/`text:` filter. Drives PR-2's R5 at-risk gate (a body
   * scan over a large non-FTS folder is the expensive/abortable case).
   */
  bodyScan: boolean;
  warnings: string[];
}

export function buildSearchCriteria(params: SearchParams, opts: { isGmail: boolean }): BuildResult {
  const warnings: string[] = [];

  // ---------------------------------------------------------------------------
  // Gmail fast-path short-circuit
  // ---------------------------------------------------------------------------
  if (params.gmailRaw !== undefined && params.gmailRaw !== null && params.gmailRaw !== '') {
    if (!opts.isGmail) {
      throw new Error('gmail_raw is only valid on Gmail accounts (imap.host === "imap.gmail.com")');
    }
    const otherFilters = Object.keys(params).filter(
      (k) => k !== 'gmailRaw' && params[k as keyof SearchParams] !== undefined,
    );
    if (otherFilters.length > 0) {
      warnings.push(
        `gmail_raw takes precedence — other filters ignored: ${otherFilters.join(', ')}`,
      );
    }
    return {
      criteria: { gmailRaw: params.gmailRaw },
      postFilters: {},
      gmailRawUsed: true,
      // Gmail searches natively server-side — our at-risk gate does not apply.
      bodyScan: false,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Regular filter build — AND across all conditions, OR across query fields
  // ---------------------------------------------------------------------------
  const andConditions: Record<string, unknown>[] = [];

  // Free-text `query` is DEEP BY DEFAULT — subject/from/body OR (the behavior
  // users expect). The big-folder body-scan risk this used to create is now
  // handled by PR-2: a body scan over a large non-FTS folder is detected
  // (R5), warned about, and run on a bounded ephemeral connection (R3) so it
  // fails loudly/cleanly instead of silently. `bodyScan` (below) flags this
  // path for that gate.
  if (params.query && params.query.length > 0) {
    const q = sanitizeSearchQuery(params.query);
    andConditions.push({
      or: [{ subject: q }, { from: q }, { body: q }],
    });
  }

  // Simple passthrough string fields
  if (params.to) andConditions.push({ to: params.to });
  if (params.from) andConditions.push({ from: params.from });
  if (params.subject) andConditions.push({ subject: params.subject });
  if (params.cc) andConditions.push({ cc: params.cc });
  if (params.bcc) andConditions.push({ bcc: params.bcc });
  if (params.text) andConditions.push({ text: params.text });
  if (params.body) andConditions.push({ body: params.body });

  // Dates
  if (params.since) andConditions.push({ since: normalizeDate(params.since) });
  if (params.before) andConditions.push({ before: normalizeDate(params.before) });
  if (params.on) andConditions.push({ on: normalizeDate(params.on) });
  if (params.sentSince) andConditions.push({ sentSince: normalizeDate(params.sentSince) });
  if (params.sentBefore) andConditions.push({ sentBefore: normalizeDate(params.sentBefore) });

  // Flags — imapflow accepts booleans and handles UN- prefixing internally
  if (params.seen !== undefined) andConditions.push({ seen: params.seen });
  if (params.flagged !== undefined) andConditions.push({ flagged: params.flagged });
  if (params.answered !== undefined) andConditions.push({ answered: params.answered });
  if (params.draft !== undefined) andConditions.push({ draft: params.draft });
  if (params.deleted !== undefined) andConditions.push({ deleted: params.deleted });

  // Keywords (custom IMAP flags / labels)
  if (params.keyword) {
    const kws = Array.isArray(params.keyword) ? params.keyword : [params.keyword];
    kws.forEach((k) => {
      andConditions.push({ keyword: k });
    });
  }
  if (params.notKeyword) {
    const kws = Array.isArray(params.notKeyword) ? params.notKeyword : [params.notKeyword];
    // imapflow's compiler upper-cases keys; both `unKeyword` and `unkeyword` compile to UNKEYWORD.
    kws.forEach((k) => {
      andConditions.push({ unKeyword: k });
    });
  }

  // Arbitrary header match (pass-through object)
  if (params.header && Object.keys(params.header).length > 0) {
    andConditions.push({ header: params.header });
  }

  // UIDs
  if (params.uids !== undefined) {
    const uidStr = Array.isArray(params.uids) ? params.uids.join(',') : params.uids;
    if (uidStr && uidStr.length > 0) {
      andConditions.push({ uid: uidStr });
    }
  }

  // Size — tool accepts KB, IMAP expects bytes
  if (params.largerThan !== undefined) {
    andConditions.push({ larger: params.largerThan * 1024 });
  }
  if (params.smallerThan !== undefined) {
    andConditions.push({ smaller: params.smallerThan * 1024 });
  }

  let criteria: Record<string, unknown>;
  if (andConditions.length === 0) {
    criteria = {};
  } else if (andConditions.length === 1) {
    [criteria] = andConditions;
  } else {
    criteria = Object.assign({}, ...andConditions);
  }

  // A free-text query (now body-inclusive) or an explicit body:/text: filter
  // makes the server scan message bodies — the expensive/abortable case the
  // R5 at-risk gate guards. TEXT covers headers+body, so it counts too.
  // (Boolean sub-expressions: an empty string is "no value", and `||` here is
  // a true logical-OR of booleans — not a nullish-default, hence not `??`.)
  const nonEmpty = (v: string | undefined): boolean => v !== undefined && v.length > 0;
  const bodyScan = nonEmpty(params.query) || nonEmpty(params.body) || nonEmpty(params.text);

  // A `*Contains` filter narrows nothing server-side. On its own it therefore
  // asks the server for the whole mailbox and sifts the result here — correct,
  // but worth saying out loud on a folder of any size, and worth pairing with a
  // date range or a coarse `from` when the caller knows one.
  const literalOnly =
    (nonEmpty(params.fromContains) ||
      nonEmpty(params.toContains) ||
      nonEmpty(params.subjectContains)) &&
    andConditions.length === 0;
  if (literalOnly) {
    warnings.push(
      'ℹ️ from_contains / to_contains / subject_contains are matched locally, not by the server. ' +
        'With no other filter the whole mailbox is scanned — add since/before, or a coarse from, ' +
        'to keep it bounded.',
    );
  }

  return {
    criteria,
    postFilters: {
      hasAttachment: params.hasAttachment,
      attachmentFilename: params.attachmentFilename,
      attachmentMimetype: params.attachmentMimetype,
      fromContains: params.fromContains,
      toContains: params.toContains,
      subjectContains: params.subjectContains,
      facets: params.facets,
    },
    gmailRawUsed: false,
    bodyScan,
    warnings,
  };
}

/** Forme d'un message telle qu'utilisée par les filtres littéraux. */
interface MatchableMessage {
  subject: string;
  from: { name?: string; address: string };
  to: { name?: string; address: string }[];
}

/** Recompose un en-tête d'adresse : `Nom <adresse>`, ou l'adresse seule. */
function addressText(entry: { name?: string; address: string } | undefined): string {
  if (!entry) return '';
  return entry.name ? `${entry.name} <${entry.address}>` : entry.address;
}

/**
 * Applique les filtres littéraux (`*Contains`) à un jeu de résultats.
 *
 * Partagé par les deux chemins de recherche et les deux backends : c'est ce qui
 * garantit qu'un même critère donne le même résultat sur IMAP et sur Graph,
 * indépendamment de ce que chaque index de serveur juge être une
 * correspondance. La comparaison est faite en minuscules sur l'en-tête
 * reconstitué, donc `enviropro-salon.fr` retrouve bien
 * `ENVIROpro Rennes <contact@news.enviropro-salon.fr>`.
 */
export function applyLiteralFilters<T extends MatchableMessage>(
  items: T[],
  filters: { fromContains?: string; toContains?: string; subjectContains?: string },
): T[] {
  let out = items;

  if (filters.fromContains) {
    const needle = filters.fromContains.toLowerCase();
    out = out.filter((m) => addressText(m.from).toLowerCase().includes(needle));
  }
  if (filters.toContains) {
    const needle = filters.toContains.toLowerCase();
    out = out.filter((m) =>
      (m.to ?? []).some((t) => addressText(t).toLowerCase().includes(needle)),
    );
  }
  if (filters.subjectContains) {
    const needle = filters.subjectContains.toLowerCase();
    out = out.filter((m) => (m.subject ?? '').toLowerCase().includes(needle));
  }

  return out;
}

/** Splits a UID list into fixed-size chunks — handy for bounded FETCH ranges. */
export function chunkUids(uids: number[], chunkSize: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < uids.length; i += chunkSize) {
    chunks.push(uids.slice(i, i + chunkSize));
  }
  return chunks;
}
