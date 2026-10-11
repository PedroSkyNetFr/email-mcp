/**
 * Microsoft Graph mail backend (read path).
 *
 * Serves accounts declared with `backend = "graph"`. Exchange Online and
 * Outlook.com only publish a legacy subset of a mailbox over IMAP — custom
 * folders are frequently absent from `LIST` altogether — so Graph is the only
 * way to see and read such a mailbox in full.
 *
 * Method signatures mirror {@link ImapService} so the router can substitute one
 * for the other per account. Two impedance mismatches are worth knowing about:
 *
 *   - Identifiers. IMAP uses numeric UIDs; Graph uses long opaque ids. Both are
 *     opaque strings at the tool boundary, so ids flow through unchanged — but
 *     a Graph id is only meaningful to a Graph account.
 *   - Folders. Tools address mailboxes by path ("NISSAN/Reçu nissan"); Graph
 *     addresses them by id. The folder tree is walked once and cached to
 *     translate between the two.
 */

import type {
  AccountConfig,
  BatchEmailSaveResult,
  BulkResult,
  Email,
  EmailAddress,
  EmailHeaderDump,
  EmailMeta,
  EmailSaveResult,
  LabelInfo,
  Mailbox,
  PaginatedResult,
  SearchCoverage,
} from '../../types/index.js';
import { normalizeDate } from '../../utils/date.js';
import type { HeaderEntry } from '../../utils/headers.js';
import {
  analyzeHeaders,
  flattenHeaders,
  groupHeaders,
  parseHeaderBlock,
  splitHeaderBlock,
} from '../../utils/headers.js';
import type { AttachmentInput, ResolvedAttachment } from '../attachment-resolver.js';
import { resolveAttachments } from '../attachment-resolver.js';
import {
  assertSafeDestination,
  defaultEmlFilename,
  exportSubfolder,
  resolveUniquePath,
  sanitizeFilename,
} from '../file-paths.js';
import type ImapService from '../imap.service.js';
import type { BeforeGranularity, CoverageStop } from '../search-coverage.js';
import { buildCoverage, MAX_SCANNED_MESSAGES, SEARCH_SCAN_BUDGET_MS } from '../search-coverage.js';
import { applyLiteralFilters } from '../search-criteria.js';
import { applyAccountSignature } from '../signature-loader.js';
import type GraphClient from './graph.client.js';

/** Graph mailFolder subset we rely on. */
interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  childFolderCount?: number;
  wellKnownName?: string | null;
}

/** Graph message subset we rely on. */
interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string; address?: string } } | null;
  sender?: { emailAddress?: { name?: string; address?: string } } | null;
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  bccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string } | null;
  hasAttachments?: boolean;
  bodyPreview?: string;
  categories?: string[];
  internetMessageId?: string;
  body?: { contentType?: string; content?: string } | null;
  internetMessageHeaders?: { name: string; value: string }[];
}

/** Page d'une collection de messages. */
interface GraphPage {
  value: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
  contentId?: string;
  isInline?: boolean;
}

/** Fields needed to build an EmailMeta — kept narrow to limit payload size. */
const META_SELECT =
  'id,subject,from,toRecipients,receivedDateTime,isRead,flag,hasAttachments,bodyPreview,categories';
// `internetMessageHeaders` fait partie de la sélection complète : sans lui,
// Graph ne renvoie rien et `Email.headers` restait systématiquement vide sur un
// compte Graph, là où le backend IMAP le remplit. Graph ne sert cette propriété
// que sur la lecture d'UN message avec `$select` explicite — d'où son absence
// de `META_SELECT`, qui sert aux listes.

/**
 * Sélection d'un parcours de pages : celle des listes, SANS `toRecipients`.
 *
 * Mesuré sur Outlook.com (3 902 messages, pages de 500) : avec
 * `toRecipients`, ~2,8 s par page et 23 s pour la boîte entière ; sans, ~0,15 s
 * par page et 1,3 s en tout. Le destinataire n'est donc lu que lorsqu'il sert
 * (`to_contains`, ou l'export, dont le CSV peut avoir une colonne `to`).
 */
const SCAN_SELECT =
  'id,subject,from,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,bodyPreview,categories';
const SCAN_SELECT_WITH_TO = `${SCAN_SELECT},toRecipients`;

const FULL_SELECT = `${META_SELECT},ccRecipients,bccRecipients,sentDateTime,internetMessageId,body,internetMessageHeaders`;

/**
 * Convertit la liste d'en-têtes de Graph vers la représentation partagée avec
 * le backend IMAP. Graph rend déjà chaque en-tête déplié et conserve les
 * occurrences répétées, il n'y a donc rien à analyser — seulement à
 * réétiqueter.
 */
function toHeaderEntries(headers: { name: string; value: string }[] | undefined): HeaderEntry[] {
  return (headers ?? []).map((header) => ({
    name: header.name,
    key: header.name.toLowerCase(),
    value: header.value,
  }));
}

function toAddress(
  input?: { emailAddress?: { name?: string; address?: string } } | null,
): EmailAddress {
  return {
    name: input?.emailAddress?.name,
    address: input?.emailAddress?.address ?? '',
  };
}

function toAddresses(
  input?: { emailAddress?: { name?: string; address?: string } }[],
): EmailAddress[] {
  return (input ?? []).map((entry) => toAddress(entry));
}

/** Tri des listes de messages : du plus récent au plus ancien, comme IMAP. */
const ORDER_BY = 'receivedDateTime desc';

/** Borne basse neutre placée en tête de $filter quand aucune date n'est donnée. */
const RECEIVED_LOWER_BOUND = '1900-01-01T00:00:00Z';

/** Filtres de date acceptés par les outils de recherche, communs à IMAP et Graph. */
interface DateFilters {
  since?: string;
  before?: string;
  on?: string;
  sentSince?: string;
  sentBefore?: string;
}

/**
 * Traduit les filtres de date en clauses OData.
 *
 * Les valeurs passent par `normalizeDate`, le même parseur que le backend
 * IMAP : ISO 8601, `AAAA-MM-JJ`, `7d` / `2w` / `1m`, `today`, `yesterday`. Un
 * `new Date("60d")` donnait une date invalide et `toISOString()` levait
 * « Invalid time value ». Sémantique alignée sur SEARCH IMAP :
 *   - `since` / `before` portent sur la réception (`receivedDateTime`) ;
 *   - `on` couvre le jour civil UTC entier de la date donnée ;
 *   - `sentSince` / `sentBefore` portent sur l'en-tête Date (`sentDateTime`).
 */
function dateFilterClauses(options: DateFilters): { received: string[]; sent: string[] } {
  const iso = (value: string): string => normalizeDate(value).toISOString();
  const received: string[] = [];
  const sent: string[] = [];

  if (options.since) received.push(`receivedDateTime ge ${iso(options.since)}`);
  if (options.before) received.push(`receivedDateTime lt ${iso(options.before)}`);
  if (options.on) {
    const parsed = normalizeDate(options.on);
    const dayStart = new Date(
      Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
    );
    const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    received.push(`receivedDateTime ge ${dayStart.toISOString()}`);
    received.push(`receivedDateTime lt ${nextDay.toISOString()}`);
  }
  if (options.sentSince) sent.push(`sentDateTime ge ${iso(options.sentSince)}`);
  if (options.sentBefore) sent.push(`sentDateTime lt ${iso(options.sentBefore)}`);

  return { received, sent };
}

/** Map the Graph well-known folder name onto the IMAP special-use flag. */
function specialUseOf(folder: GraphFolder): string | undefined {
  const map: Record<string, string> = {
    inbox: '\\Inbox',
    sentitems: '\\Sent',
    drafts: '\\Drafts',
    deleteditems: '\\Trash',
    junkemail: '\\Junk',
    archive: '\\Archive',
  };
  return folder.wellKnownName ? map[folder.wellKnownName.toLowerCase()] : undefined;
}

export function toEmailMeta(message: GraphMessage): EmailMeta {
  return {
    id: message.id,
    subject: message.subject ?? '',
    from: toAddress(message.from ?? message.sender),
    to: toAddresses(message.toRecipients),
    date: message.receivedDateTime ?? message.sentDateTime ?? '',
    seen: message.isRead ?? false,
    flagged: message.flag?.flagStatus === 'flagged',
    // Graph exposes no per-message "answered" equivalent; IMAP's \Answered has
    // no counterpart, so it is reported as false rather than guessed.
    answered: false,
    hasAttachments: message.hasAttachments ?? false,
    labels: message.categories ?? [],
    preview: message.bodyPreview,
  };
}

/** Options de recherche comprises par le backend Graph. */
interface GraphSearchOptions extends DateFilters {
  mailbox?: string;
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  subject?: string;
  seen?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  fromContains?: string;
  toContains?: string;
  subjectContains?: string;
  // Reçus du routeur comme pour IMAP, sans traduction Graph fidèle (voir
  // unsupportedFilters) :
  [key: string]: unknown;
}

/**
 * Filtres de l'outil sans équivalent Graph fidèle. Ils étaient ignorés en
 * silence — une recherche `attachment_filename: "bail"` rendait alors TOUTE la
 * boîte. Ils restent ignorés, mais la réponse le dit.
 */
const UNSUPPORTED_ON_GRAPH: [key: string, label: string][] = [
  ['cc', 'cc'],
  ['bcc', 'bcc'],
  ['text', 'text'],
  ['body', 'body'],
  ['answered', 'answered'],
  ['draft', 'draft'],
  ['deleted', 'deleted'],
  ['keyword', 'keyword'],
  ['notKeyword', 'not_keyword'],
  ['header', 'header'],
  ['uids', 'uids'],
  ['largerThan', 'larger_than'],
  ['smallerThan', 'smaller_than'],
  ['attachmentFilename', 'attachment_filename'],
  ['attachmentMimetype', 'attachment_mimetype'],
  ['gmailRaw', 'gmail_raw'],
];

function unsupportedFilterWarning(options: GraphSearchOptions): string | undefined {
  const ignored = UNSUPPORTED_ON_GRAPH.filter(([key]) => {
    const value = options[key];
    return value !== undefined && value !== null && value !== '';
  }).map(([, label]) => label);
  return ignored.length > 0
    ? `Not supported on this Microsoft Graph account and IGNORED: ${ignored.join(', ')}`
    : undefined;
}

/** Vrai quand un filtre littéral `*_contains` est demandé. */
function hasLiteralFilters(options: GraphSearchOptions): boolean {
  return [options.fromContains, options.toContains, options.subjectContains].some(
    (value) => typeof value === 'string' && value.length > 0,
  );
}

/** Texte envoyé à `$search` : requête libre + sujet / expéditeur / destinataire. */
function searchText(query: string, options: GraphSearchOptions): string {
  return [query, options.subject, options.from, options.to].filter(Boolean).join(' ').trim();
}

/** Messages lus par requête lors d'un parcours `$filter` (Graph accepte 1 à 1000). */
const GRAPH_SCAN_PAGE = 500;
/** Messages lus par requête lors d'un parcours `$search`. */
const GRAPH_SEARCH_PAGE = 250;
/** Graph ne rend pas plus de 1 000 résultats pour un `$search` sur des messages. */
const GRAPH_SEARCH_RESULT_CAP = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bornes de date exactes, en millisecondes (bornes basses incluses, hautes exclues). */
interface DateWindow {
  receivedFrom?: number;
  receivedTo?: number;
  sentFrom?: number;
  sentTo?: number;
}

/** Même sémantique que dateFilterClauses, sous forme numérique. */
function dateWindow(options: DateFilters): DateWindow {
  const ms = (value: string): number => normalizeDate(value).getTime();
  const window: DateWindow = {};
  const lower = (current: number | undefined, value: number): number =>
    current === undefined ? value : Math.max(current, value);
  const upper = (current: number | undefined, value: number): number =>
    current === undefined ? value : Math.min(current, value);

  if (options.since) window.receivedFrom = ms(options.since);
  if (options.before) window.receivedTo = ms(options.before);
  if (options.on) {
    const parsed = normalizeDate(options.on);
    const dayStart = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
    window.receivedFrom = lower(window.receivedFrom, dayStart);
    window.receivedTo = upper(window.receivedTo, dayStart + DAY_MS);
  }
  if (options.sentSince) window.sentFrom = ms(options.sentSince);
  if (options.sentBefore) window.sentTo = ms(options.sentBefore);
  return window;
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Clauses KQL de date pour `$search`, qui refuse `$filter`.
 *
 * KQL ne compare que des jours, dans un fuseau que Graph ne précise pas : les
 * bornes sont donc ÉLARGIES d'un jour de chaque côté pour ne rien perdre, et
 * la borne exacte est réappliquée sur chaque résultat (matchesSearchFilters).
 * Sans ces clauses, `$search` ignorait toute date — `since: "30d"` rendait des
 * messages de 2018 — et une reprise par `before` relisait sans fin la même
 * tranche.
 */
function kqlDateClauses(window: DateWindow): string[] {
  const clauses: string[] = [];
  if (window.receivedFrom !== undefined) {
    clauses.push(`received>=${isoDay(window.receivedFrom - DAY_MS)}`);
  }
  if (window.receivedTo !== undefined) {
    clauses.push(`received<${isoDay(window.receivedTo + 2 * DAY_MS)}`);
  }
  if (window.sentFrom !== undefined) clauses.push(`sent>=${isoDay(window.sentFrom - DAY_MS)}`);
  if (window.sentTo !== undefined) clauses.push(`sent<${isoDay(window.sentTo + 2 * DAY_MS)}`);
  return clauses;
}

function inWindow(value: string | undefined, from?: number, to?: number): boolean {
  if (from === undefined && to === undefined) return true;
  const time = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) return false;
  return (from === undefined || time >= from) && (to === undefined || time < to);
}

/**
 * Filtres appliqués à chaque résultat d'un `$search`, faute de `$filter` :
 * dates exactes, état lu / suivi / pièce jointe, filtres littéraux. Ces
 * critères étaient jusqu'ici IGNORÉS dès qu'un texte de recherche était donné.
 */
function matchesSearchFilters(
  message: GraphMessage,
  options: GraphSearchOptions,
  window: DateWindow,
): boolean {
  const meta = toEmailMeta(message);
  if (!inWindow(message.receivedDateTime, window.receivedFrom, window.receivedTo)) return false;
  if (!inWindow(message.sentDateTime, window.sentFrom, window.sentTo)) return false;
  if (options.seen !== undefined && meta.seen !== options.seen) return false;
  if (options.flagged !== undefined && meta.flagged !== options.flagged) return false;
  if (options.hasAttachment !== undefined && meta.hasAttachments !== options.hasAttachment) {
    return false;
  }
  return applyLiteralFilters([meta], options).length > 0;
}

/** Clauses `$filter` des filtres structurés, receivedDateTime en tête. */
function structuredFilterClauses(options: GraphSearchOptions): string[] {
  // Dates analysées avant tout appel réseau : une date illisible échoue tout
  // de suite avec « Invalid date: … ».
  const dates = dateFilterClauses(options);

  // Graph filters are OData; only the subset with a faithful translation is
  // applied here, so a filter is never silently reinterpreted.
  const others: string[] = [];
  if (options.seen !== undefined) others.push(`isRead eq ${options.seen ? 'true' : 'false'}`);
  if (options.flagged !== undefined) {
    others.push(`flag/flagStatus ${options.flagged ? 'eq' : 'ne'} 'flagged'`);
  }
  if (options.hasAttachment !== undefined) {
    others.push(`hasAttachments eq ${options.hasAttachment ? 'true' : 'false'}`);
  }
  if (options.from) {
    others.push(`from/emailAddress/address eq '${options.from.replace(/'/g, "''")}'`);
  }
  others.push(...dates.sent);

  // Règle Graph pour $filter + $orderby sur les messages : la propriété de
  // tri doit figurer dans $filter, EN PREMIER, avant toute autre propriété ;
  // sinon 400 InefficientFilter (« The restriction or sort order is too
  // complex for this operation »). Voir
  // https://learn.microsoft.com/graph/api/user-list-messages, section « Using
  // filter and orderby in the same query ». Les clauses receivedDateTime
  // passent donc en tête ; sans filtre de date, une borne basse neutre (1900)
  // est ajoutée — technique documentée — pour satisfaire la règle sans
  // restreindre le résultat.
  const received = [...dates.received];
  if (received.length === 0 && others.length > 0) {
    received.push(`receivedDateTime ge ${RECEIVED_LOWER_BOUND}`);
  }
  return [...received, ...others];
}

/** Résultat d'un parcours de pages Graph. */
interface GatherResult {
  /** Messages retenus, du plus récent au plus ancien. */
  matched: EmailMeta[];
  /** Présent quand une borne a interrompu le parcours. */
  coverage?: SearchCoverage;
  /** Vrai quand le parcours s'est arrêté parce que `limit` messages étaient retenus. */
  limited: boolean;
}

/** Trie du plus récent au plus ancien (date de réception). */
function byDateDesc(a: EmailMeta, b: EmailMeta): number {
  return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
}

/** Découpe un jeu retenu en page de résultat, bilan de couverture compris. */
function paginateGathered(
  gathered: GatherResult,
  page: number,
  pageSize: number,
  warnings: string[],
): PaginatedResult<EmailMeta> {
  const total = gathered.matched.length;
  const start = (page - 1) * pageSize;
  const allWarnings = gathered.coverage ? [...warnings, gathered.coverage.hint] : warnings;
  return {
    items: gathered.matched.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total,
    ...(allWarnings.length > 0 ? { warning: allWarnings.join('; ') } : {}),
    ...(gathered.coverage ? { totalApprox: true, coverage: gathered.coverage } : {}),
  };
}

export default class GraphService {
  /** path -> folder, rebuilt on demand. */
  private folderCache = new Map<string, GraphFolder>();

  constructor(
    private readonly clients: Map<string, GraphClient>,
    private readonly getAccount: (name: string) => AccountConfig,
  ) {}

  private client(accountName: string): GraphClient {
    const client = this.clients.get(accountName);
    if (!client) {
      throw new Error(`Account "${accountName}" is not served by the Graph backend`);
    }
    return client;
  }

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  /** Walk the folder tree, recording "Parent/Child" paths for every node. */
  private async walkFolders(
    accountName: string,
    url: string,
    prefix: string,
    depth: number,
    out: { path: string; folder: GraphFolder }[],
  ): Promise<void> {
    if (depth > 8) return;
    const folders = await this.client(accountName).collect<GraphFolder>(url);

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- depth-first walk, and Graph throttles bursts */
    for (const folder of folders) {
      const full = prefix ? `${prefix}/${folder.displayName}` : folder.displayName;
      out.push({ path: full, folder });
      if ((folder.childFolderCount ?? 0) > 0) {
        await this.walkFolders(
          accountName,
          `/me/mailFolders/${folder.id}/childFolders?$top=100`,
          full,
          depth + 1,
          out,
        );
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */
  }

  private async loadFolders(accountName: string): Promise<{ path: string; folder: GraphFolder }[]> {
    const out: { path: string; folder: GraphFolder }[] = [];
    await this.walkFolders(
      accountName,
      '/me/mailFolders?$top=100&includeHiddenFolders=true',
      '',
      0,
      out,
    );
    this.folderCache = new Map(out.map((entry) => [entry.path, entry.folder]));
    return out;
  }

  /**
   * Translate a mailbox path into a Graph folder id.
   *
   * "INBOX" is accepted case-insensitively and mapped to the well-known inbox,
   * so tools that default to the IMAP name keep working. Matching is otherwise
   * case-insensitive on the full path.
   */
  private async resolveFolderId(accountName: string, mailbox: string): Promise<string> {
    if (/^inbox$/i.test(mailbox)) return 'inbox';

    const entries = this.folderCache.size
      ? [...this.folderCache.entries()].map(([path, folder]) => ({ path, folder }))
      : await this.loadFolders(accountName);

    const wanted = mailbox.replace(/^\/+|\/+$/g, '').toLowerCase();
    const hit =
      entries.find((entry) => entry.path.toLowerCase() === wanted) ??
      // Tolerate an IMAP-style separator or a bare leaf name.
      entries.find((entry) => entry.path.replace(/\./g, '/').toLowerCase() === wanted) ??
      entries.find((entry) => entry.folder.displayName.toLowerCase() === wanted);

    if (!hit) {
      const available = entries
        .slice(0, 20)
        .map((entry) => entry.path)
        .join(', ');
      throw new Error(`Mailbox "${mailbox}" not found. Available: ${available}`);
    }
    return hit.folder.id;
  }

  async listMailboxes(accountName: string): Promise<Mailbox[]> {
    const entries = await this.loadFolders(accountName);
    return entries.map(({ path, folder }) => ({
      name: folder.displayName,
      path,
      specialUse: specialUseOf(folder),
      totalMessages: folder.totalItemCount ?? 0,
      unseenMessages: folder.unreadItemCount ?? 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async listEmails(
    accountName: string,
    options: GraphSearchOptions = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    // `$filter` ne sait exprimer ni le sujet ni le destinataire (contains()
    // n'est pas fiable sur les messages, voir gather) : ils passent par le
    // chemin `$search`, comme dans searchEmails, au lieu d'être ignorés.
    if (options.subject || options.to) return this.searchEmails(accountName, '', options);

    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    const deadline = Date.now() + SEARCH_SCAN_BUDGET_MS;
    const filters = structuredFilterClauses(options);
    const unsupported = unsupportedFilterWarning(options);
    const warnings = unsupported ? [unsupported] : [];

    // Filtres littéraux : ils ne filtraient que la page déjà lue (« No emails
    // found » alors que la boîte en contient, total de la boîte entière).
    // Le jeu filtré est désormais constitué AVANT la pagination.
    if (hasLiteralFilters(options)) {
      const gathered = await this.gather(accountName, '', options, {
        limit: Number.POSITIVE_INFINITY,
        deadline,
      });
      return paginateGathered(gathered, page, pageSize, warnings);
    }

    // Sans filtre côté client : inchangé, seule la page demandée est lue.
    const folderId = await this.resolveFolderId(accountName, options.mailbox ?? 'INBOX');
    const query = [
      `$select=${META_SELECT}`,
      `$orderby=${ORDER_BY}`,
      `$top=${pageSize}`,
      `$skip=${(page - 1) * pageSize}`,
      '$count=true',
      ...(filters.length ? [`$filter=${encodeURIComponent(filters.join(' and '))}`] : []),
    ].join('&');

    const response = await this.client(accountName).request<{
      value: GraphMessage[];
      '@odata.count'?: number;
    }>('GET', `/me/mailFolders/${folderId}/messages?${query}`);

    const items = response.value.map(toEmailMeta);
    const total = response['@odata.count'] ?? items.length;
    return {
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    };
  }

  async getEmail(accountName: string, emailId: string, _mailbox = 'INBOX'): Promise<Email> {
    const client = this.client(accountName);
    const message = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=${FULL_SELECT}`,
    );

    const attachments = message.hasAttachments
      ? await client.collect<GraphAttachment>(
          `/me/messages/${emailId}/attachments?$select=id,name,contentType,size`,
        )
      : [];

    const isHtml = (message.body?.contentType ?? '').toLowerCase() === 'html';
    const content = message.body?.content ?? '';

    return {
      ...toEmailMeta(message),
      cc: toAddresses(message.ccRecipients),
      bcc: toAddresses(message.bccRecipients),
      ...(isHtml ? { bodyHtml: content } : { bodyText: content }),
      messageId: message.internetMessageId ?? '',
      attachments: attachments.map((a) => ({
        filename: a.name ?? 'unnamed',
        mimeType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? 0,
      })),
      // Même aplatissement que le backend IMAP (la dernière occurrence gagne) ;
      // la chaîne Received complète s'obtient via `getEmailHeaders`.
      headers: flattenHeaders(toHeaderEntries(message.internetMessageHeaders)),
    };
  }

  async getEmailFlags(
    accountName: string,
    emailId: string,
    _mailbox = 'INBOX',
  ): Promise<{
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    labels: string[];
    subject: string;
    from: string;
    date: string;
  }> {
    const message = await this.client(accountName).request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=id,subject,from,receivedDateTime,isRead,flag,categories`,
    );
    const meta = toEmailMeta(message);
    return {
      seen: meta.seen,
      flagged: meta.flagged,
      answered: meta.answered,
      labels: meta.labels,
      subject: meta.subject,
      from: meta.from.address,
      date: meta.date,
    };
  }

  /**
   * Full-text search. Graph's `$search` covers the whole message (subject, body,
   * participants) and, unlike IMAP SEARCH, cannot be combined with `$filter` or
   * with `$orderby`. Dates are therefore pushed into the KQL query (widened by a
   * day) and every other criterion — exact dates, read / flagged / attachment
   * state, `*_contains` — is checked on each result (see matchesSearchFilters),
   * so no criterion is silently dropped when a query text is given.
   */
  async searchEmails(
    accountName: string,
    query: string,
    options: GraphSearchOptions = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const text = searchText(query, options);
    if (!text) return this.listEmails(accountName, options);

    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    const deadline = Date.now() + SEARCH_SCAN_BUDGET_MS;
    const unsupported = unsupportedFilterWarning(options);
    const gathered = await this.gather(accountName, text, options, {
      limit: Number.POSITIVE_INFINITY,
      deadline,
    });
    return paginateGathered(gathered, page, pageSize, unsupported ? [unsupported] : []);
  }

  /**
   * Constitue le jeu de messages qui satisfont TOUS les critères, du plus
   * récent au plus ancien, en suivant `@odata.nextLink`.
   *
   * Deux chemins, selon que `text` est vide ou non :
   *  - `$filter` + `$orderby=receivedDateTime desc` : les filtres structurés
   *    sont appliqués par Graph, les `*_contains` ici sur chaque page. Ils ne
   *    sont pas confiés à Graph : `contains(from/emailAddress/address,'edf')`
   *    est accepté mais ne rend RIEN (constaté sur Outlook.com, 2026-10-11),
   *    et la documentation de `$filter` sur les messages ne le couvre pas — un
   *    zéro silencieux, exactement le défaut à corriger.
   *  - `$search` (KQL) : voir searchEmails.
   *
   * Bornes communes avec IMAP : `MAX_SCANNED_MESSAGES` messages examinés et
   * l'échéance `deadline` ; la page 1 est toujours lue. `limit` arrête la
   * lecture dès que ce nombre de messages est retenu (export).
   */
  private async gather(
    accountName: string,
    text: string,
    options: GraphSearchOptions,
    opts: { limit: number; deadline: number; withRecipients?: boolean },
  ): Promise<GatherResult> {
    const select = opts.withRecipients || options.toContains ? SCAN_SELECT_WITH_TO : SCAN_SELECT;
    if (text) {
      const window = dateWindow(options);
      const kql = [text, ...kqlDateClauses(window)].join(' AND ');
      const folderId = await this.resolveFolderId(accountName, options.mailbox ?? 'INBOX');
      const url =
        `/me/mailFolders/${folderId}/messages?$select=${select}` +
        `&$search=${encodeURIComponent(`"${kql}"`)}` +
        `&$top=${GRAPH_SEARCH_PAGE}`;
      const gathered = await this.walkMessages(accountName, url, {
        keep: (message) => matchesSearchFilters(message, options, window),
        cap: MAX_SCANNED_MESSAGES,
        serverCap: GRAPH_SEARCH_RESULT_CAP,
        limit: opts.limit,
        deadline: opts.deadline,
        // `$search` trie par date d'ENVOI : c'est elle qui borne les messages
        // non examinés. La reprise se fait au jour (KQL), avec la marge de
        // continuationBefore, qui absorbe un délai d'acheminement de quelques
        // heures entre envoi et réception.
        dateOf: (message) => message.sentDateTime ?? message.receivedDateTime,
        granularity: 'day',
        before: options.before,
      });
      gathered.matched.sort(byDateDesc);
      return gathered;
    }

    const filters = structuredFilterClauses(options);
    const folderId = await this.resolveFolderId(accountName, options.mailbox ?? 'INBOX');
    const query = [
      `$select=${select}`,
      `$orderby=${ORDER_BY}`,
      `$top=${GRAPH_SCAN_PAGE}`,
      '$count=true',
      ...(filters.length ? [`$filter=${encodeURIComponent(filters.join(' and '))}`] : []),
    ].join('&');
    return this.walkMessages(accountName, `/me/mailFolders/${folderId}/messages?${query}`, {
      keep: (message) => applyLiteralFilters([toEmailMeta(message)], options).length > 0,
      // Sans filtre côté client (export), rien n'est « examiné » au sens du
      // tri : seul le budget de temps borne la lecture.
      cap: hasLiteralFilters(options) ? MAX_SCANNED_MESSAGES : Number.POSITIVE_INFINITY,
      limit: opts.limit,
      deadline: opts.deadline,
      dateOf: (message) => message.receivedDateTime,
      // `receivedDateTime lt …` compare l'instant exact.
      granularity: 'instant',
      before: options.before,
    });
  }

  /** Suit les pages d'une requête Graph en appliquant `keep` à chaque message. */
  private async walkMessages(
    accountName: string,
    firstUrl: string,
    opts: {
      keep: (message: GraphMessage) => boolean;
      cap: number;
      serverCap?: number;
      limit: number;
      deadline: number;
      dateOf: (message: GraphMessage) => string | undefined;
      granularity: BeforeGranularity;
      before?: string;
    },
  ): Promise<GatherResult> {
    const client = this.client(accountName);
    const matched: EmailMeta[] = [];
    let next: string | undefined = firstUrl;
    let examined = 0;
    let candidates: number | undefined;
    let oldest: string | undefined;
    let stoppedBy: CoverageStop | undefined;
    let limited = false;

    /* eslint-disable no-await-in-loop -- la pagination Graph est séquentielle */
    while (next) {
      if (matched.length >= opts.limit) {
        limited = true;
        break;
      }
      if (examined >= opts.cap) {
        stoppedBy = 'message_cap';
        break;
      }
      // La première page est toujours lue : jamais de page vide par manque de temps.
      if (examined > 0 && Date.now() > opts.deadline) {
        stoppedBy = 'time_budget';
        break;
      }
      const response: GraphPage = await client.request<GraphPage>('GET', next);
      if (candidates === undefined && typeof response['@odata.count'] === 'number') {
        candidates = response['@odata.count'];
      }
      const batch = response.value.slice(0, opts.cap - examined);
      matched.push(...batch.filter(opts.keep).map(toEmailMeta));
      const last = batch.at(-1);
      oldest = (last ? opts.dateOf(last) : undefined) ?? oldest;
      examined += batch.length;
      next = response['@odata.nextLink'];
      if (batch.length < response.value.length) {
        stoppedBy = 'message_cap';
        break;
      }
    }
    /* eslint-enable no-await-in-loop */

    if (!stoppedBy && !limited && opts.serverCap !== undefined && examined >= opts.serverCap) {
      stoppedBy = 'server_cap';
    }
    if (!stoppedBy) return { matched, limited };

    return {
      matched,
      limited,
      coverage: buildCoverage({
        stoppedBy,
        examined,
        candidates: candidates ?? examined,
        ...(candidates === undefined ? { candidatesApprox: true } : {}),
        oldestExamined: oldest ? new Date(oldest) : undefined,
        granularity: opts.granularity,
        currentBefore: opts.before,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Categories — the Graph equivalent of IMAP keywords / labels
  // -------------------------------------------------------------------------

  async listLabels(accountName: string): Promise<LabelInfo[]> {
    const categories = await this.client(accountName).collect<{ displayName: string }>(
      '/me/outlook/masterCategories',
    );
    return categories.map((category) => ({
      name: category.displayName,
      strategy: 'keyword' as LabelInfo['strategy'],
    }));
  }

  /** Categories live on the message as a whole array, so it is read then rewritten. */
  private async setCategories(
    accountName: string,
    emailId: string,
    update: (current: string[]) => string[],
  ): Promise<void> {
    const client = this.client(accountName);
    const message = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=categories`,
    );
    const next = update(message.categories ?? []);
    await client.request('PATCH', `/me/messages/${emailId}`, { categories: next });
  }

  async addLabel(
    accountName: string,
    emailId: string,
    _mailbox: string,
    label: string,
  ): Promise<void> {
    await this.setCategories(accountName, emailId, (current) =>
      current.includes(label) ? current : [...current, label],
    );
  }

  async removeLabel(
    accountName: string,
    emailId: string,
    _mailbox: string,
    label: string,
  ): Promise<void> {
    await this.setCategories(accountName, emailId, (current) =>
      current.filter((entry) => entry !== label),
    );
  }

  async createLabel(accountName: string, name: string): Promise<void> {
    await this.client(accountName).request('POST', '/me/outlook/masterCategories', {
      displayName: name,
      color: 'preset0',
    });
  }

  async deleteLabel(accountName: string, name: string): Promise<void> {
    const categories = await this.client(accountName).collect<{
      id: string;
      displayName: string;
    }>('/me/outlook/masterCategories');
    const match = categories.find((category) => category.displayName === name);
    if (!match) throw new Error(`Category "${name}" not found`);
    await this.client(accountName).request('DELETE', `/me/outlook/masterCategories/${match.id}`);
  }

  // -------------------------------------------------------------------------
  // Message state
  // -------------------------------------------------------------------------

  async setFlags(
    accountName: string,
    emailId: string,
    _mailbox: string,
    action: 'read' | 'unread' | 'flag' | 'unflag',
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      read: { isRead: true },
      unread: { isRead: false },
      flag: { flag: { flagStatus: 'flagged' } },
      unflag: { flag: { flagStatus: 'notFlagged' } },
    }[action];

    await this.client(accountName).request('PATCH', `/me/messages/${emailId}`, patch);
  }

  async moveEmail(
    accountName: string,
    emailId: string,
    _sourceMailbox: string,
    destinationMailbox: string,
  ): Promise<void> {
    const destinationId = await this.resolveFolderId(accountName, destinationMailbox);
    await this.client(accountName).request('POST', `/me/messages/${emailId}/move`, {
      destinationId,
    });
  }

  /**
   * Delete a message. The default moves it to Deleted Items, mirroring the IMAP
   * path; `permanent` issues a real DELETE, which Graph does not undo.
   */
  async deleteEmail(
    accountName: string,
    emailId: string,
    _mailbox = 'INBOX',
    permanent = false,
  ): Promise<void> {
    const client = this.client(accountName);
    if (permanent) {
      await client.request('DELETE', `/me/messages/${emailId}`);
      return;
    }
    await client.request('POST', `/me/messages/${emailId}/move`, {
      destinationId: 'deleteditems',
    });
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  /**
   * Apply a per-message operation across ids, collecting failures instead of
   * aborting. Graph has no multi-message verb, so this is genuinely one request
   * per id; they are issued sequentially because Graph throttles parallel bursts
   * hard enough that a batch would end up slower.
   */
  private static async runBulk(
    ids: (number | string)[],
    operation: (id: string) => Promise<void>,
  ): Promise<BulkResult> {
    const result: BulkResult = { total: ids.length, succeeded: 0, failed: 0, errors: [] };

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential on purpose, see above */
    for (const id of ids) {
      try {
        await operation(String(id));
        result.succeeded += 1;
      } catch (err) {
        result.failed += 1;
        result.errors?.push(`${String(id)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return result;
  }

  async bulkSetFlags(
    accountName: string,
    ids: (number | string)[],
    mailbox: string,
    action: 'mark_read' | 'mark_unread' | 'flag' | 'unflag',
  ): Promise<BulkResult> {
    const single = { mark_read: 'read', mark_unread: 'unread', flag: 'flag', unflag: 'unflag' }[
      action
    ] as 'read' | 'unread' | 'flag' | 'unflag';
    return GraphService.runBulk(ids, async (id) => this.setFlags(accountName, id, mailbox, single));
  }

  async bulkMove(
    accountName: string,
    ids: (number | string)[],
    mailbox: string,
    destination: string,
  ): Promise<BulkResult> {
    return GraphService.runBulk(ids, async (id) =>
      this.moveEmail(accountName, id, mailbox, destination),
    );
  }

  async bulkDelete(
    accountName: string,
    ids: (number | string)[],
    mailbox: string,
    permanent = false,
  ): Promise<BulkResult> {
    return GraphService.runBulk(ids, async (id) =>
      this.deleteEmail(accountName, id, mailbox, permanent),
    );
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  /**
   * Every message sharing the conversation. Graph tracks `conversationId`
   * natively, so no References/In-Reply-To reconstruction is needed.
   */
  async getThread(accountName: string, emailId: string, _mailbox = 'INBOX'): Promise<EmailMeta[]> {
    const client = this.client(accountName);
    const message = await client.request<GraphMessage & { conversationId?: string }>(
      'GET',
      `/me/messages/${emailId}?$select=conversationId`,
    );
    if (!message.conversationId) return [];

    const filter = encodeURIComponent(`conversationId eq '${message.conversationId}'`);
    const messages = await client.collect<GraphMessage>(
      `/me/messages?$select=${META_SELECT}&$filter=${filter}&$orderby=receivedDateTime asc&$top=100`,
    );
    return messages.map(toEmailMeta);
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  async saveDraft(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: { filename: string; content: Buffer; contentType: string; cid?: string }[];
    },
  ): Promise<{ id: number | string; mailbox: string }> {
    const recipients = (addresses?: string[]) =>
      (addresses ?? [])
        .map((address) => address.trim())
        .filter(Boolean)
        .map((address) => ({ emailAddress: { address } }));

    const created = await this.client(accountName).request<{ id: string }>('POST', '/me/messages', {
      subject: options.subject,
      body: { contentType: options.html ? 'HTML' : 'Text', content: options.body },
      toRecipients: recipients(options.to),
      ccRecipients: recipients(options.cc),
      bccRecipients: recipients(options.bcc),
      ...(options.attachments?.length
        ? {
            attachments: options.attachments.map((attachment) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: attachment.filename,
              contentType: attachment.contentType,
              contentBytes: attachment.content.toString('base64'),
              ...(attachment.cid ? { isInline: true, contentId: attachment.cid } : {}),
            })),
          }
        : {}),
    });

    // Graph files new messages in Drafts itself; the id is opaque, not a UID.
    return { id: created.id, mailbox: 'Drafts' };
  }

  /**
   * Resolve polymorphic attachment inputs into in-memory bytes for an outbound
   * send. Same strict contract as the IMAP service: one failure aborts the whole
   * operation rather than sending a message missing what the caller attached.
   */
  async resolveAttachmentsForSend(
    accountName: string,
    attachments: AttachmentInput[],
  ): Promise<ResolvedAttachment[]> {
    if (attachments.length === 0) return [];
    const result = await resolveAttachments(
      this as unknown as ImapService,
      accountName,
      attachments,
    );
    if (result.failures.length > 0) {
      const summary = result.failures.map((f) => `${f.label}: ${f.reason}`).join('; ');
      throw new Error(`Failed to resolve ${result.failures.length} attachment(s): ${summary}`);
    }
    return result.resolved;
  }

  /**
   * Entry point used by the save_draft tool: resolves the polymorphic attachment
   * inputs, then creates the draft.
   *
   * The resolver only needs a `downloadAttachment` to carry an attachment over
   * from another message, and this service provides exactly that — so it stands
   * in for the IMAP service rather than reimplementing the resolution.
   */
  async saveDraftWithAttachments(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: AttachmentInput[];
      appendSignature?: boolean;
    },
  ): Promise<{ id: number | string; mailbox: string }> {
    let resolved: ResolvedAttachment[] = [];
    if (options.attachments?.length) {
      const result = await resolveAttachments(
        this as unknown as ImapService,
        accountName,
        options.attachments,
      );
      if (result.failures.length > 0) {
        const summary = result.failures.map((f) => `${f.label}: ${f.reason}`).join('; ');
        throw new Error(`Failed to resolve ${result.failures.length} attachment(s): ${summary}`);
      }
      resolved = result.resolved;
    }

    const signed = await applyAccountSignature(
      this.getAccount(accountName),
      { body: options.body, html: options.html, attachments: resolved },
      options.appendSignature,
    );

    return this.saveDraft(accountName, {
      to: options.to,
      subject: options.subject,
      body: signed.body,
      cc: options.cc,
      bcc: options.bcc,
      html: signed.html,
      attachments: signed.attachments,
    });
  }

  /**
   * Update a draft in place.
   *
   * Graph PATCHes the existing message, so — unlike the IMAP path, which must
   * append a rebuilt copy and delete the original — no new id appears and
   * nothing is deleted. The result keeps the IMAP shape so callers do not have
   * to branch, with `id` equal to `oldId` and a note saying so.
   */
  async updateDraft(
    accountName: string,
    draftId: number | string,
    options: {
      mailbox?: string;
      subject?: string;
      body?: string;
      html?: boolean;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      attachmentsAdd?: AttachmentInput[];
      attachmentsRemove?: string[];
      /**
       * Même contrat que sur IMAP : signature ajoutée sous le NOUVEAU corps,
       * uniquement sur demande explicite (jamais via signature_default) ;
       * ignorée avec avertissement sans `body`.
       */
      appendSignature?: boolean;
    },
  ): Promise<{
    id: number | string;
    mailbox: string;
    oldId: number | string;
    oldDraftDeleted: boolean;
    warnings: string[];
  }> {
    const client = this.client(accountName);
    const id = String(draftId);
    const warnings: string[] = [];

    const recipients = (addresses?: string[]) =>
      addresses
        ?.map((address) => address.trim())
        .filter(Boolean)
        .map((address) => ({ emailAddress: { address } }));

    const patch: Record<string, unknown> = {};
    if (options.subject !== undefined) patch.subject = options.subject;

    // Corps : remplacé seulement s'il est fourni. Sans `body`, Graph ne touche
    // pas au corps existant — signature et images inline comprises.
    let newContent: string | undefined;
    let signatureAttachments: ResolvedAttachment[] = [];
    if (options.body !== undefined) {
      // `html` omis : hériter du type du brouillon existant, comme sur IMAP
      // (auparavant un brouillon HTML repassait en texte brut).
      let { html } = options;
      if (html === undefined) {
        const current = await client.request<{ body?: { contentType?: string } }>(
          'GET',
          `/me/messages/${id}?$select=body`,
        );
        html = current.body?.contentType?.toLowerCase() === 'html';
      }
      newContent = options.body;
      if (options.appendSignature === true) {
        const signed = await applyAccountSignature(
          this.getAccount(accountName),
          { body: newContent, html },
          true,
        );
        newContent = signed.body;
        html = signed.html;
        signatureAttachments = signed.attachments;
      }
      patch.body = { contentType: html ? 'HTML' : 'Text', content: newContent };
    } else if (options.appendSignature === true) {
      warnings.push(
        'append_signature ignored: no new body was given, so the existing body is kept as is ' +
          '(with its signature if it already had one).',
      );
    }
    if (options.to) patch.toRecipients = recipients(options.to);
    if (options.cc) patch.ccRecipients = recipients(options.cc);
    if (options.bcc) patch.bccRecipients = recipients(options.bcc);

    if (Object.keys(patch).length > 0) {
      await client.request('PATCH', `/me/messages/${id}`, patch);
    }

    // Nouveau corps : les images inline (cid) qu'il ne référence plus sont
    // orphelines, et celles que la signature réapporte feraient doublon. On les
    // retire, comme le fait la réécriture IMAP.
    if (newContent !== undefined) {
      const referenced = new Set(
        [...newContent.matchAll(/cid:([^"'\s>)]+)/gi)].map((m) => m[1].toLowerCase()),
      );
      const fresh = new Set(signatureAttachments.map((a) => a.cid?.toLowerCase()));
      const existingInline = await client.collect<GraphAttachment>(
        // `contentId` n'existe que sur le type dérivé fileAttachment : le
        // sélectionner sans transtypage fait échouer la requête (400).
        `/me/messages/${id}/attachments?$select=id,name,isInline,microsoft.graph.fileAttachment/contentId`,
      );
      const stale = existingInline.filter((a) => {
        const cid = a.contentId?.replace(/^<|>$/g, '').toLowerCase();
        return !!a.isInline && !!cid && (!referenced.has(cid) || fresh.has(cid));
      });
      /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential: Graph throttles bursts */
      for (const attachment of stale) {
        await client.request('DELETE', `/me/messages/${id}/attachments/${attachment.id}`);
      }
      for (const attachment of signatureAttachments) {
        await client.request('POST', `/me/messages/${id}/attachments`, {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: attachment.filename,
          contentType: attachment.contentType,
          contentBytes: attachment.content.toString('base64'),
          isInline: true,
          contentId: attachment.cid,
        });
      }
      /* eslint-enable no-restricted-syntax, no-await-in-loop */
    }

    // Attachments are separate resources on Graph: removals and additions are
    // applied to the existing message rather than rebuilt wholesale, so
    // untouched ones simply stay.
    if (options.attachmentsRemove?.length) {
      const existing = await client.collect<GraphAttachment>(
        `/me/messages/${id}/attachments?$select=id,name`,
      );
      const doomed = existing.filter((a) => options.attachmentsRemove?.includes(a.name ?? ''));
      options.attachmentsRemove.forEach((name) => {
        if (!existing.some((a) => a.name === name)) {
          warnings.push(`attachments_remove named "${name}" but the draft has no such attachment`);
        }
      });
      /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential: Graph throttles bursts */
      for (const attachment of doomed) {
        await client.request('DELETE', `/me/messages/${id}/attachments/${attachment.id}`);
      }
      /* eslint-enable no-restricted-syntax, no-await-in-loop */
    }

    if (options.attachmentsAdd?.length) {
      const resolved = await this.resolveAttachmentsForSend(accountName, options.attachmentsAdd);
      /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential: Graph throttles bursts */
      for (const attachment of resolved) {
        await client.request('POST', `/me/messages/${id}/attachments`, {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: attachment.filename,
          contentType: attachment.contentType,
          contentBytes: attachment.content.toString('base64'),
          ...(attachment.cid ? { isInline: true, contentId: attachment.cid } : {}),
        });
      }
      /* eslint-enable no-restricted-syntax, no-await-in-loop */
    }

    warnings.push(
      'Draft updated in place (Graph); its id is unchanged and no copy was left behind.',
    );
    return {
      id,
      mailbox: options.mailbox ?? 'Drafts',
      oldId: id,
      oldDraftDeleted: false,
      warnings,
    };
  }

  async deleteDraft(accountName: string, draftId: number | string): Promise<void> {
    await this.client(accountName).request('DELETE', `/me/messages/${String(draftId)}`);
  }

  // -------------------------------------------------------------------------
  // Server-side rules — no IMAP equivalent exists
  // -------------------------------------------------------------------------

  /**
   * Inbox rules run on the server, so they keep sorting mail when nothing of
   * ours is running. IMAP has no equivalent at all: this is Graph-only.
   */
  async listMessageRules(accountName: string): Promise<
    {
      id: string;
      displayName: string;
      sequence: number;
      isEnabled: boolean;
      conditions: Record<string, unknown>;
      actions: Record<string, unknown>;
    }[]
  > {
    return this.client(accountName).collect('/me/mailFolders/inbox/messageRules');
  }

  /**
   * Create an inbox rule. Conditions and actions follow the Graph shapes; the
   * destination folder is given as a path and translated to its id here, since
   * a caller should not have to know Graph's opaque identifiers.
   */
  async createMessageRule(
    accountName: string,
    input: {
      displayName: string;
      sequence?: number;
      isEnabled?: boolean;
      fromAddresses?: string[];
      subjectContains?: string[];
      bodyContains?: string[];
      moveToMailbox?: string;
      markAsRead?: boolean;
      markImportance?: 'low' | 'normal' | 'high';
      delete?: boolean;
      stopProcessingRules?: boolean;
    },
  ): Promise<{ id: string; displayName: string }> {
    const conditions: Record<string, unknown> = {};
    if (input.fromAddresses?.length) {
      conditions.senderContains = input.fromAddresses;
    }
    if (input.subjectContains?.length) conditions.subjectContains = input.subjectContains;
    if (input.bodyContains?.length) conditions.bodyContains = input.bodyContains;

    const actions: Record<string, unknown> = {};
    if (input.moveToMailbox) {
      actions.moveToFolder = await this.resolveFolderId(accountName, input.moveToMailbox);
    }
    if (input.markAsRead) actions.markAsRead = true;
    if (input.markImportance) actions.markImportance = input.markImportance;
    if (input.delete) actions.delete = true;
    actions.stopProcessingRules = input.stopProcessingRules ?? false;

    if (Object.keys(conditions).length === 0) {
      throw new Error('A rule needs at least one condition (from, subject or body).');
    }
    if (Object.keys(actions).length <= 1) {
      throw new Error('A rule needs at least one action (move, mark read, importance or delete).');
    }

    return this.client(accountName).request('POST', '/me/mailFolders/inbox/messageRules', {
      displayName: input.displayName,
      sequence: input.sequence ?? 1,
      isEnabled: input.isEnabled ?? true,
      conditions,
      actions,
    });
  }

  async deleteMessageRule(accountName: string, ruleId: string): Promise<void> {
    await this.client(accountName).request(
      'DELETE',
      `/me/mailFolders/inbox/messageRules/${ruleId}`,
    );
  }

  // -------------------------------------------------------------------------
  // Automatic replies (out of office)
  // -------------------------------------------------------------------------

  async getAutomaticReplies(accountName: string): Promise<{
    status: string;
    scheduledStartDateTime?: { dateTime: string; timeZone: string };
    scheduledEndDateTime?: { dateTime: string; timeZone: string };
    internalReplyMessage?: string;
    externalReplyMessage?: string;
    externalAudience?: string;
  }> {
    // The sub-resource returns the setting object itself (plus @odata.context),
    // not a wrapper, so it maps straight onto the result.
    return this.client(accountName).request('GET', '/me/mailboxSettings/automaticRepliesSetting');
  }

  /**
   * Turn the out-of-office reply on or off. `scheduled` requires both dates;
   * `alwaysEnabled` ignores them. Times are ISO strings with an explicit zone,
   * because Graph rejects a naive local time.
   */
  async setAutomaticReplies(
    accountName: string,
    input: {
      status: 'disabled' | 'alwaysEnabled' | 'scheduled';
      internalReplyMessage?: string;
      externalReplyMessage?: string;
      externalAudience?: 'none' | 'contactsOnly' | 'all';
      startDateTime?: string;
      endDateTime?: string;
      timeZone?: string;
    },
  ): Promise<void> {
    if (input.status === 'scheduled' && !(input.startDateTime && input.endDateTime)) {
      throw new Error('A scheduled automatic reply needs both startDateTime and endDateTime.');
    }

    const timeZone = input.timeZone ?? 'UTC';
    const setting: Record<string, unknown> = {
      status: input.status,
      externalAudience: input.externalAudience ?? 'all',
      ...(input.internalReplyMessage ? { internalReplyMessage: input.internalReplyMessage } : {}),
      ...(input.externalReplyMessage ? { externalReplyMessage: input.externalReplyMessage } : {}),
      ...(input.status === 'scheduled'
        ? {
            scheduledStartDateTime: { dateTime: input.startDateTime, timeZone },
            scheduledEndDateTime: { dateTime: input.endDateTime, timeZone },
          }
        : {}),
    };

    await this.client(accountName).request('PATCH', '/me/mailboxSettings', {
      automaticRepliesSetting: setting,
    });
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * Flat result set for the export tool. Only the single-account shape is
   * served here — the router refuses a call spanning both backends, so
   * `accountNames` never arrives with a Graph account mixed in.
   */
  async searchForExport(
    accountNames: string[] | null,
    accountName: string | null,
    query: string,
    options: { maxRows: number; mailbox?: string; [key: string]: unknown },
  ): Promise<{ items: EmailMeta[]; truncated: boolean; coverage?: SearchCoverage[] }> {
    const names = accountNames ?? (accountName ? [accountName] : []);
    if (names.length === 0) {
      throw new Error('searchForExport requires at least one account name');
    }

    const { maxRows, ...searchOptions } = options;
    const deadline = Date.now() + SEARCH_SCAN_BUDGET_MS;
    const collected: EmailMeta[] = [];
    const coverage: SearchCoverage[] = [];
    let truncated = false;

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- one account at a time, Graph throttles */
    for (const name of names) {
      const remaining = maxRows - collected.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      // Un seul parcours par compte, filtres appliqués AVANT la coupe à
      // maxRows — l'ancienne boucle page par page de searchEmails aurait
      // relu toute la boîte à chaque page.
      const gathered = await this.gather(
        name,
        searchText(query, searchOptions as GraphSearchOptions),
        searchOptions as GraphSearchOptions,
        { limit: remaining, deadline, withRecipients: true },
      );
      if (gathered.limited || gathered.matched.length > remaining) truncated = true;
      collected.push(
        ...gathered.matched.slice(0, remaining).map((item) => ({ ...item, account: name })),
      );
      if (gathered.coverage) coverage.push({ ...gathered.coverage, account: name });
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return {
      items: collected,
      truncated,
      ...(coverage.length > 0 ? { coverage } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Attachments to disk
  // -------------------------------------------------------------------------

  /** Write one resolved attachment, honouring the destination allow-list. */
  private static async writeToDisk(
    payload: { filename: string; mimeType: string; contentBase64: string },
    destination: string,
    overwrite: boolean,
  ): Promise<{
    filename: string;
    localPath: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  }> {
    const { mkdir, stat, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    assertSafeDestination(destination);

    let targetPath: string;
    try {
      const info = await stat(destination);
      targetPath = info.isDirectory()
        ? join(destination, sanitizeFilename(payload.filename))
        : destination;
    } catch {
      targetPath = destination;
    }
    // Re-check the resolved path: the filename component is caller-supplied.
    assertSafeDestination(targetPath);

    const finalPath = await resolveUniquePath(targetPath, overwrite);
    await mkdir(dirname(finalPath), { recursive: true });
    const bytes = Buffer.from(payload.contentBase64, 'base64');
    await writeFile(finalPath, bytes);

    return {
      filename: payload.filename,
      localPath: finalPath,
      fileUrl: pathToFileURL(finalPath).href,
      mimeType: payload.mimeType,
      size: bytes.length,
    };
  }

  async saveAttachmentToDisk(
    accountName: string,
    emailId: string,
    mailbox: string,
    filename: string,
    destination: string,
    overwrite = false,
  ): Promise<{
    filename: string;
    localPath: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  }> {
    const payload = await this.downloadAttachment(accountName, emailId, mailbox, filename);
    return GraphService.writeToDisk(payload, destination, overwrite);
  }

  async saveEmailAttachments(
    accountName: string,
    emailId: string,
    _mailbox: string,
    destDir: string,
    maxSizeBytes = 25 * 1024 * 1024,
  ): Promise<
    { filename: string; localPath: string; fileUrl: string; mimeType: string; size: number }[]
  > {
    const attachments = await this.client(accountName).collect<GraphAttachment>(
      `/me/messages/${emailId}/attachments?$select=id,name,contentType,size`,
    );

    const saved: {
      filename: string;
      localPath: string;
      fileUrl: string;
      mimeType: string;
      size: number;
    }[] = [];

    // Oversized attachments are skipped, matching the IMAP path.
    const withinBudget = attachments.filter((meta) => (meta.size ?? 0) <= maxSizeBytes);

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- sequential: Graph throttles bursts */
    for (const meta of withinBudget) {
      const full = await this.client(accountName).request<GraphAttachment>(
        'GET',
        `/me/messages/${emailId}/attachments/${meta.id}`,
      );
      saved.push(
        await GraphService.writeToDisk(
          {
            filename: full.name ?? 'unnamed',
            mimeType: full.contentType ?? 'application/octet-stream',
            contentBase64: full.contentBytes ?? '',
          },
          destDir,
          false,
        ),
      );
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return saved;
  }

  // -------------------------------------------------------------------------
  // Folder management
  // -------------------------------------------------------------------------

  /** Split "Parent/Child" into its parent path and leaf name. */
  private static splitPath(folderPath: string): { parent?: string; leaf: string } {
    const clean = folderPath.replace(/^\/+|\/+$/g, '');
    const index = clean.lastIndexOf('/');
    if (index < 0) return { leaf: clean };
    return { parent: clean.slice(0, index), leaf: clean.slice(index + 1) };
  }

  async createMailbox(accountName: string, folderPath: string): Promise<void> {
    const { parent, leaf } = GraphService.splitPath(folderPath);
    const base = parent
      ? `/me/mailFolders/${await this.resolveFolderId(accountName, parent)}/childFolders`
      : '/me/mailFolders';
    await this.client(accountName).request('POST', base, { displayName: leaf });
    this.folderCache.clear(); // the tree changed
  }

  async renameMailbox(accountName: string, folderPath: string, newPath: string): Promise<void> {
    const id = await this.resolveFolderId(accountName, folderPath);
    // Graph renames by display name; it cannot reparent through this call, so a
    // path change that moves the folder elsewhere is rejected rather than
    // silently renaming it in place.
    const from = GraphService.splitPath(folderPath);
    const to = GraphService.splitPath(newPath);
    if ((from.parent ?? '') !== (to.parent ?? '')) {
      throw new Error(
        `Graph can rename a folder but not move it: "${folderPath}" and "${newPath}" have ` +
          'different parents.',
      );
    }
    await this.client(accountName).request('PATCH', `/me/mailFolders/${id}`, {
      displayName: to.leaf,
    });
    this.folderCache.clear();
  }

  async deleteMailbox(accountName: string, folderPath: string): Promise<void> {
    const id = await this.resolveFolderId(accountName, folderPath);
    await this.client(accountName).request('DELETE', `/me/mailFolders/${id}`);
    this.folderCache.clear();
  }

  async downloadAttachment(
    accountName: string,
    emailId: string,
    _mailbox: string,
    filename: string,
    maxSizeBytes = 25 * 1024 * 1024,
  ): Promise<{ filename: string; mimeType: string; contentBase64: string; size: number }> {
    const client = this.client(accountName);
    const attachments = await client.collect<GraphAttachment>(
      `/me/messages/${emailId}/attachments?$select=id,name,contentType,size`,
    );
    const match = attachments.find((a) => a.name === filename);
    if (!match) {
      throw new Error(
        `Attachment "${filename}" not found. Available: ${
          attachments.map((a) => a.name).join(', ') || 'none'
        }`,
      );
    }
    if ((match.size ?? 0) > maxSizeBytes) {
      throw new Error(
        `Attachment "${filename}" is ${Math.round((match.size ?? 0) / 1024 / 1024)}MB, exceeds ` +
          `${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
      );
    }

    // Re-fetch the single attachment so contentBytes is included.
    const full = await client.request<GraphAttachment>(
      'GET',
      `/me/messages/${emailId}/attachments/${match.id}`,
    );
    return {
      filename: full.name ?? filename,
      mimeType: full.contentType ?? 'application/octet-stream',
      contentBase64: full.contentBytes ?? '',
      size: full.size ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // En-têtes Internet complets
  // -------------------------------------------------------------------------

  /**
   * En-têtes Internet complets d'un message Graph.
   *
   * Deux sources sont possibles, et l'ordre retenu est un compromis assumé :
   *
   *   1. `internetMessageHeaders` — quelques kilo-octets de JSON, une seule
   *      requête. Graph rend la liste ordonnée et RÉPÉTÉE, donc la chaîne
   *      `Received` est complète. Le bloc brut est reconstruit à partir de
   *      cette liste : les valeurs sont exactes, le pliage d'origine non.
   *   2. `$value` (MIME complet) — fidèle à l'octet, mais télécharge le message
   *      entier, pièces jointes comprises. Utilisé en repli, quand Graph ne
   *      fournit pas la liste (certains éléments de calendrier, messages de
   *      boîtes partagées).
   */
  async getEmailHeaders(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<EmailHeaderDump> {
    const client = this.client(accountName);

    const message = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=internetMessageHeaders`,
    );
    const listed = message.internetMessageHeaders ?? [];

    if (listed.length > 0) {
      const entries = toHeaderEntries(listed);
      return {
        emailId,
        account: accountName,
        mailbox,
        raw: entries.map((entry) => `${entry.name}: ${entry.value}`).join('\r\n'),
        entries,
        grouped: groupHeaders(entries),
        analysis: analyzeHeaders(entries),
        rawReconstructed: true,
      };
    }

    const raw = splitHeaderBlock(await client.getBinary(`/me/messages/${emailId}/$value`));
    const entries = parseHeaderBlock(raw);
    return {
      emailId,
      account: accountName,
      mailbox,
      raw,
      entries,
      grouped: groupHeaders(entries),
      analysis: analyzeHeaders(entries),
    };
  }

  // -------------------------------------------------------------------------
  // Export du message au format .eml
  // -------------------------------------------------------------------------

  /**
   * Source MIME complète du message (`GET /messages/{id}/$value`).
   *
   * Ce sont les octets tels qu'Exchange les a reçus : c'est ce qui rend le
   * `.eml` exploitable comme preuve (signatures DKIM et chaîne `Received`
   * intactes), à la différence d'un message reconstruit depuis les propriétés
   * Graph.
   */
  async getEmailRaw(accountName: string, emailId: string, _mailbox = 'INBOX'): Promise<Buffer> {
    return this.client(accountName).getBinary(`/me/messages/${emailId}/$value`);
  }

  /** Écrit un message sur disque au format `.eml`, cf. `ImapService`. */
  async saveEmailToDisk(
    accountName: string,
    emailId: string,
    _mailbox: string,
    destination: string,
    overwrite = false,
  ): Promise<EmailSaveResult> {
    const { mkdir, stat, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    assertSafeDestination(destination);

    const client = this.client(accountName);
    // Sujet et date servent uniquement à nommer le fichier — deux propriétés,
    // pas la sélection complète.
    const meta = await client.request<GraphMessage>(
      'GET',
      `/me/messages/${emailId}?$select=subject,receivedDateTime,sentDateTime`,
    );
    const source = await client.getBinary(`/me/messages/${emailId}/$value`);

    let targetPath: string;
    try {
      const info = await stat(destination);
      targetPath = info.isDirectory()
        ? join(
            destination,
            defaultEmlFilename(
              emailId,
              meta.subject ?? undefined,
              meta.sentDateTime ?? meta.receivedDateTime,
            ),
          )
        : destination;
    } catch {
      targetPath = destination;
    }
    // Le nom de fichier dérive du sujet, donc d'une source non maîtrisée.
    assertSafeDestination(targetPath);

    const finalPath = await resolveUniquePath(targetPath, overwrite);
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, source);

    return {
      emailId,
      account: accountName,
      path: finalPath,
      fileUrl: pathToFileURL(finalPath).href,
      size: source.length,
      ...(meta.subject ? { subject: meta.subject } : {}),
    };
  }

  /** Export `.eml` en lot depuis une recherche, cf. `ImapService`. */
  async saveEmailsFromSearch(input: {
    accountNames: string[] | null;
    accountName: string | null;
    query: string;
    searchOptions: { mailbox?: string; [key: string]: unknown };
    maxEmails: number;
    destinationFolder: string;
    organizeBy: 'flat' | 'date' | 'sender' | 'account';
  }): Promise<BatchEmailSaveResult> {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');

    assertSafeDestination(input.destinationFolder);
    await mkdir(input.destinationFolder, { recursive: true });

    const { items, truncated, coverage } = await this.searchForExport(
      input.accountNames,
      input.accountName,
      input.query,
      { ...input.searchOptions, maxRows: input.maxEmails },
    );

    let filesSaved = 0;
    let totalSize = 0;
    const errors: { emailId: string; account?: string; error: string }[] = [];

    /* eslint-disable no-restricted-syntax, no-await-in-loop -- Graph limite les rafales */
    for (const email of items) {
      const accountForEmail = email.account ?? input.accountName;
      if (!accountForEmail) {
        errors.push({ emailId: email.id, error: 'Could not determine account for email' });
      } else {
        const subfolder = join(
          input.destinationFolder,
          exportSubfolder(input.organizeBy, email, accountForEmail),
        );
        try {
          await mkdir(subfolder, { recursive: true });
          const saved = await this.saveEmailToDisk(
            accountForEmail,
            email.id,
            input.searchOptions.mailbox ?? 'INBOX',
            subfolder,
            false,
          );
          filesSaved += 1;
          totalSize += saved.size;
        } catch (err) {
          errors.push({
            emailId: email.id,
            account: accountForEmail,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return {
      folder: input.destinationFolder,
      matched: items.length,
      truncated,
      ...(coverage ? { coverage } : {}),
      files_saved: filesSaved,
      total_size: totalSize,
      errors,
    };
  }
}
