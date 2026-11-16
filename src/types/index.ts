/**
 * Shared TypeScript types for the Email MCP Server.
 */

import type { HeaderAnalysis, HeaderEntry } from '../utils/headers.js';
import type { MailClassification } from '../utils/mail-classification.js';

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

export interface EmailAddress {
  name?: string;
  address: string;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface Account {
  name: string;
  email: string;
  fullName?: string;
}

export interface ImapConfig {
  host: string;
  port: number;
  tls: boolean;
  starttls: boolean;
  verifySsl: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  tls: boolean;
  starttls: boolean;
  verifySsl: boolean;
  pool?: {
    enabled: boolean;
    maxConnections: number;
    maxMessages: number;
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Langue de la ligne qui introduit une citation (« Le …, X a écrit : ») et de
 * l'en-tête d'un transfert. Défaut : français.
 */
export type ReplyLanguage = 'fr' | 'en';

export interface OAuth2Config {
  provider: 'google' | 'microsoft' | 'custom';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
  // Custom provider endpoints (only when provider = "custom")
  tokenUrl?: string;
  authUrl?: string;
  scopes?: string[];
}

export interface AccountConfig {
  name: string;
  email: string;
  fullName?: string;
  username: string;
  password?: string;
  oauth2?: OAuth2Config;
  imap: ImapConfig;
  smtp: SmtpConfig;
  sentFolder?: string;
  saveToSent?: boolean;
  gmailAutoSave?: boolean;
  /** Path to an Outlook HTML signature (.htm) to embed inline. */
  signaturePath?: string;
  /** Which API serves this account; "graph" for Exchange / Outlook.com. */
  backend?: 'imap' | 'graph';
  /** Append the signature by default on every composed message (unless overridden per call). */
  signatureDefault?: boolean;
  /**
   * Taille maximale d'un message sortant, encodé (Mo). Défaut : aucune limite
   * locale en SMTP (le serveur décide, extension SIZE), 35 sur Graph (limite
   * d'envoi par défaut d'Exchange Online). Voir send-limit.ts.
   */
  maxMessageMb?: number;
  /**
   * Langue des citations et en-têtes de transfert composés localement (IMAP /
   * SMTP) : `reply_language` du compte, sinon celle de `[settings]`, sinon
   * « fr ». Sans effet sur Graph `/reply` et `/forward`, dont Exchange écrit
   * lui-même l'en-tête dans la langue de la boîte.
   */
  replyLanguage?: ReplyLanguage;
}

export interface WatcherConfig {
  enabled: boolean;
  folders: string[];
  idleTimeout: number;
}

// ---------------------------------------------------------------------------
// Hook Rules
// ---------------------------------------------------------------------------

export interface HookRuleMatch {
  from?: string;
  to?: string;
  subject?: string;
}

export interface HookRuleActions {
  labels?: string[];
  flag?: boolean;
  markRead?: boolean;
  alert?: boolean;
  /** Add the email's calendar event to the local calendar (triggers confirmation dialog). */
  addToCalendar?: boolean;
}

export interface HookRule {
  name: string;
  match: HookRuleMatch;
  actions: HookRuleActions;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertsConfig {
  desktop: boolean;
  sound: boolean;
  urgencyThreshold: 'urgent' | 'high' | 'normal' | 'low';
  webhookUrl: string;
  webhookEvents: ('urgent' | 'high' | 'normal' | 'low')[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HooksConfig {
  onNewEmail: 'triage' | 'notify' | 'none';
  preset: 'inbox-zero' | 'gtd' | 'priority-focus' | 'notification-only' | 'custom';
  autoLabel: boolean;
  autoFlag: boolean;
  batchDelay: number;
  customInstructions?: string;
  systemPrompt?: string;
  rules: HookRule[];
  alerts: AlertsConfig;
  /** Automatically add calendar events detected in new emails to the local calendar. */
  autoCalendar?: boolean;
  /** Target calendar name for auto-add (empty = default calendar). */
  calendarName?: string;
  /** Minutes before event to show an alert (default: 15). */
  calendarAlarmMinutes?: number;
  /** Show a native confirmation dialog before adding (default: true). */
  calendarConfirm?: boolean;
}

export interface AppConfig {
  settings: {
    rateLimit: number;
    readOnly: boolean;
    watcher: WatcherConfig;
    hooks: HooksConfig;
    /** Langue par défaut des citations et en-têtes de transfert (défaut « fr »). */
    replyLanguage?: ReplyLanguage;
    /** Jours d'historique d'envois programmés conservés (défaut 30 ; 0 = tout garder). */
    sentRetentionDays?: number;
    /**
     * Fenêtre anti-doublon des envois, en minutes (défaut 10 ; 0 = désactivée) :
     * un envoi identique dans la fenêtre est refusé (voir services/send-guard.ts).
     */
    duplicateSendWindowMinutes?: number;
  };
  accounts: AccountConfig[];
  /** Saved-search presets from `[[searches]]` in config.toml. Empty when none. */
  searches: SearchPreset[];
  /**
   * Postgres connection for the cross-account routing engine. Undefined when
   * neither `[database].url` in config.toml nor EMAIL_MCP_DATABASE_URL is set.
   * Only the routing tools require it; the rest of email-mcp runs without it.
   * EMAIL_MCP_DATABASE_URL takes precedence over the TOML value.
   */
  database?: { url: string };
}

// ---------------------------------------------------------------------------
// Saved-search presets
// ---------------------------------------------------------------------------

/**
 * Camel-cased view of a `[[searches]]` entry from config.toml. Bundles a
 * named filter combination that can be executed via `run_preset`.
 *
 * Every search parameter mirrors the `SearchParams` shape. Either `account`
 * (single-account) or `accounts` (cross-account) may be set — not both.
 */
export interface SearchPreset {
  name: string;
  description?: string;
  account?: string;
  accounts?: string[];
  mailbox?: string;
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
  largerThan?: number;
  smallerThan?: number;
  hasAttachment?: boolean;
  attachmentFilename?: string;
  attachmentMimetype?: string;
  facets?: ('sender' | 'year' | 'mailbox')[];
  gmailRaw?: string;
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

export interface Mailbox {
  name: string;
  path: string;
  specialUse?: string;
  totalMessages: number;
  unseenMessages: number;
}

/** Compteurs bon marché d'un dossier, pour la ressource `email://{compte}/stats`. */
export interface MailboxSnapshot {
  /** Messages dans le dossier. */
  total: number;
  /** Messages non lus. */
  unread: number;
  /**
   * Messages reçus depuis minuit (heure locale). Absent quand le serveur ne
   * fournit pas le compte (Graph sans `@odata.count`) : inconnu, pas zéro.
   */
  receivedToday?: number;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface EmailMeta {
  id: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  labels: string[];
  /**
   * Début du corps en texte (≈ 200 caractères). Sur IMAP, rempli seulement
   * quand l'appelant le demande (`preview: true`, une lecture partielle de la
   * partie texte par message) ; sur Graph, `bodyPreview` est servi d'office.
   */
  preview?: string;
  /**
   * Indice « liste de diffusion / message automatique » tiré d'en-têtes posés
   * par l'expéditeur (List-Id, Precedence, Auto-Submitted…) — jamais une
   * garantie. Rempli par les listes IMAP et par la lecture d'un message sur
   * les deux backends ; absent des listes Graph (en-têtes non servis en liste).
   */
  classification?: MailClassification;
  /**
   * Attachment metadata, populated when bodyStructure is fetched. Undefined
   * means "unknown" (e.g. envelope-only fetches); an empty array means the
   * message was inspected and has no attachments.
   */
  attachments?: AttachmentMeta[];
  /**
   * Account name — populated only by cross-account search
   * (`ImapService.searchAcrossAccounts`). Single-account callers leave this
   * undefined.
   */
  account?: string;
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  /** IMAP : taille déclarée par BODYSTRUCTURE, donc ENCODÉE (~1,37× en base64). */
  size: number;
  /**
   * Identifiant stable de la pièce, seul désignateur sans ambiguïté (deux
   * `image001.png` dans une signature Outlook) : numéro de partie MIME sur IMAP
   * (« 2 », « 1.2 »), identifiant de pièce jointe sur Graph.
   */
  partId?: string;
  /** Content-ID sans chevrons : ce que vise un `<img src="cid:…">` du corps. */
  contentId?: string;
  /**
   * Image inline à Content-ID (logo de signature, image du corps HTML).
   * Listée pour être téléchargeable, mais pas comptée comme pièce jointe
   * « réelle » (hasAttachments, filtres de recherche, transfert).
   */
  inline?: boolean;
}

export interface Email extends EmailMeta {
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  /**
   * Adresses de l'en-tête Reply-To (RFC 5322 §3.6.2), seulement quand
   * l'expéditeur l'a posé : une réponse leur est adressée à la place de From.
   * Absent (ou vide) : on répond à From. IMAP : lu par mailparser ; Graph :
   * propriété `replyTo` du message.
   */
  replyTo?: EmailAddress[];
  bodyText?: string;
  bodyHtml?: string;
  /**
   * Capped raw RFC822 source. Populated by `messageToEmail` ONLY when no
   * decodable text/html body part was recovered, so `get_email format=full`
   * still has an escape hatch instead of returning a blank section.
   * Undefined on the normal path to keep thread fetches memory-bounded.
   */
  raw?: string;
  /**
   * One-line reason body extraction produced nothing (oversized source,
   * MIME parse error, or no decodable part). Surfaced as a visible marker
   * so an extraction failure is never presented as a clean empty body.
   */
  bodyWarning?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments: AttachmentMeta[];
  headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Sort de la copie d'un message envoyé dans le dossier Envoyés (IMAP APPEND).
 *
 * Un échec ne fait jamais échouer l'envoi — le message est déjà parti, et
 * annoncer un échec pousserait à le renvoyer en double. Il est donc rapporté,
 * pas levé. `skipped` : copie volontairement omise (save_to_sent désactivé, ou
 * Gmail qui la classe lui-même).
 */
export type SentCopyResult =
  | { kind: 'filed' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string };

/**
 * Sort du brouillon après send_draft. `kept` : volontairement conservé (la
 * copie dans Envoyés a échoué : le supprimer ferait disparaître la seule trace
 * du message). `failed` : la suppression a échoué APRÈS un envoi réussi.
 */
export type DraftCleanupResult =
  | { kind: 'removed' }
  | { kind: 'kept'; reason: string }
  | { kind: 'failed'; error: string };

export interface SendResult {
  messageId: string;
  status: 'sent' | 'failed';
  /** Copie dans Envoyés (IMAP uniquement ; Graph classe la copie lui-même). */
  sentCopy?: SentCopyResult;
  /** send_draft uniquement : ce qu'il est advenu du brouillon. */
  draftCleanup?: DraftCleanupResult;
  /** Écarts non bloquants à signaler à l'appelant (jamais un échec masqué). */
  warnings?: string[];
}

/**
 * IMAP SEARCH failure classification (R1 — search false-negatives).
 *
 * const-object-derived union mirroring ERROR_KIND/WARNING_KIND. Lives here in
 * the shared-contract leaf because `PaginatedResult` carries it; the runtime
 * error class + status builders live in `src/services/search-status.ts`.
 *
 * D8 (revised, locked): only three honest kinds. imapflow's `SearchCommand`
 * collapses a server `NO`, a swallowed socket-timeout, AND a local command
 * failure all into a single `false` — they are NOT distinguishable on the
 * shared client path. Fabricating a finer label (e.g. `server_no`) would be
 * the same silent-misclassification class this feature exists to fix.
 */
export const SEARCH_FAIL_KIND = {
  /** `client.search()` resolved non-array (`false`) — imapflow swallowed the cause. */
  SEARCH_FAILED: 'search_failed',
  /** `client.search()` rejected — a connection error that escaped SearchCommand. */
  CONNECTION_ERROR: 'connection_error',
  /** Our own bounded-wait expiry on an ephemeral connection (PR-2/R3). Reserved. */
  TIMEOUT: 'timeout',
} as const;

export type SearchFailKind = (typeof SEARCH_FAIL_KIND)[keyof typeof SEARCH_FAIL_KIND];

export interface SearchStatus {
  kind: SearchFailKind;
  /** Human-readable explanation of what failed (never implies "zero matches"). */
  message: string;
  /**
   * Posé par le repli fenêtré (wgs4 0c2c2b4, R6) quand une relance restreinte
   * aux `sinceDays` derniers jours a été tentée après l'échec d'une recherche
   * IMAP sans date. Présent AVEC `searchFailed` si la relance n'a rien donné,
   * SANS `searchFailed` (résultats partiels, `totalApprox`) si elle a trouvé.
   * `since` : premier jour couvert (AAAA-MM-JJ) — l'appelant élargit avec un
   * `before` antérieur ou égal. Jamais posé par le backend Graph.
   */
  windowed?: { applied: true; sinceDays: number; since?: string };
  /** Actionable next step for the caller (narrow the query, retry, etc.). */
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Couverture d'une recherche filtrée côté client (voir services/search-coverage.ts)
// ---------------------------------------------------------------------------

/** Ce qui a interrompu le parcours. */
export type CoverageStop =
  /** Budget de temps atteint. */
  | 'time_budget'
  /** Plafond de `MAX_SCANNED_MESSAGES` (5000) messages examinés atteint. */
  | 'message_cap'
  /** Le serveur n'a pas rendu davantage de résultats (plafond de `$search` Graph). */
  | 'server_cap';

/**
 * Bilan d'un parcours INCOMPLET. Absent du résultat quand tous les candidats
 * ont été examinés : sa présence suffit à signaler une couverture partielle.
 */
export interface SearchCoverage {
  /** Compte concerné — renseigné par les recherches multi-comptes. */
  account?: string;
  stoppedBy: CoverageStop;
  /** Messages effectivement examinés (les plus récents). */
  examined: number;
  /** Candidats renvoyés par le serveur avant le tri côté client. */
  candidates: number;
  /** Vrai quand le serveur ne donne pas le nombre exact de candidats. */
  candidatesApprox?: boolean;
  /** Date de réception (ISO 8601) du plus ancien message examiné. */
  oldestExamined?: string;
  /**
   * Valeur à passer en `before` pour reprendre. Absente quand on ne peut pas
   * avancer par date (voir `continuationBefore`).
   */
  continueBefore?: string;
  /** Consigne lisible, reprise telle quelle dans l'avertissement. */
  hint: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Optional human-readable warning (e.g. "Truncated to 5000 of 78000 matches"). */
  warning?: string;
  /**
   * When true, `total` is an approximation — typically because the server
   * returned more UIDs than the cap and results were truncated before counting.
   */
  totalApprox?: boolean;
  /**
   * Set when the underlying IMAP SEARCH failed (R1). Distinguishes a failure
   * from a genuine zero-match so callers never read an empty page as
   * authoritative. Always accompanied by `searchStatus` + `warning`.
   */
  searchFailed?: true;
  /**
   * Structured failure detail when `searchFailed` is set. Also present WITHOUT
   * `searchFailed` when the windowed fallback served partial results
   * (`searchStatus.windowed`): then it describes the original failure.
   */
  searchStatus?: SearchStatus;
  /**
   * Message count of the opened mailbox (R8). Free under the search lock —
   * lets callers judge truncation/timeout risk on huge folders.
   */
  folderSize?: number;
  /** Optional bucketed counts across the full match set (capped). */
  facets?: FacetResult;
  /**
   * Présent quand le tri côté client n'a pas examiné tous les candidats
   * (budget de temps, plafond de messages) : résultats et total ne portent
   * que sur les messages examinés, et `continueBefore` dit comment reprendre.
   */
  coverage?: SearchCoverage;
}

export interface FacetResult {
  /** Map of sender address (lowercased) → count. */
  sender?: Record<string, number>;
  /** Map of year (stringified) → count. */
  year?: Record<string, number>;
  /** Map of mailbox path → count. Reserved for cross-account search. */
  mailbox?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Bulk Operations
// ---------------------------------------------------------------------------

export interface BulkResult {
  total: number;
  succeeded: number;
  failed: number;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface Contact {
  name?: string;
  email: string;
  frequency: number;
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  ts: string;
  tool: string;
  account: string;
  params: Record<string, unknown>;
  result: 'ok' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export interface ThreadResult {
  threadId: string;
  messages: Email[];
  participants: EmailAddress[];
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  name: string;
  description?: string;
  subject: string;
  body: string;
  variables: string[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  name: string;
  domains: string[];
  imap: ImapConfig;
  smtp: SmtpConfig;
  notes?: string;
  oauth2?: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  organizer?: EmailAddress;
  attendees: EmailAddress[];
  status: 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';
  method?: string;
  recurrence?: string;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface SenderStat {
  email: string;
  name?: string;
  count: number;
}

export interface DailyVolume {
  date: string;
  count: number;
}

export interface EmailStats {
  period: 'day' | 'week' | 'month';
  dateRange: { from: string; to: string };
  totalReceived: number;
  unreadCount: number;
  flaggedCount: number;
  topSenders: SenderStat[];
  dailyVolume: DailyVolume[];
  hasAttachmentsCount: number;
  avgPerDay: number;
}

export interface QuotaInfo {
  usedMb: number;
  totalMb: number;
  percentage: number;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type LabelStrategyType = 'protonmail' | 'gmail' | 'keyword' | 'unsupported';

export interface LabelInfo {
  name: string;
  path?: string;
  strategy: LabelStrategyType;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface ScheduledEmail {
  id: string;
  account: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html: boolean;
  sendAt: string;
  createdAt: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  lastError?: string;
  draftMessageId?: string;
  draftMailbox?: string;
  inReplyTo?: string;
  references?: string[];
  sentAt?: string;
  sentMessageId?: string;
}

// ---------------------------------------------------------------------------
// Export & Attachment Save — PR 4
// ---------------------------------------------------------------------------

export interface ExportResult {
  path: string;
  rows_written: number;
  truncated: boolean;
  format: 'csv' | 'ndjson';
}

export interface AttachmentSaveResult {
  path: string;
  size: number;
  mimeType: string;
}

export interface BatchAttachmentResult {
  folder: string;
  /** Messages the search returned — see {@link BatchEmailSaveResult.matched}. */
  matched: number;
  /** True when the search hit `max_emails` and the set is a prefix, not the whole. */
  truncated: boolean;
  /** Comptes dont le tri côté client est resté partiel — voir {@link SearchCoverage}. */
  coverage?: SearchCoverage[];
  files_saved: number;
  total_size: number;
  skipped: number;
  errors: { emailId: string; filename: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Internet headers / message export
// ---------------------------------------------------------------------------

/**
 * En-têtes Internet complets d'un message, sous les trois formes utiles :
 * bloc brut (fidélité), liste ordonnée (multiplicité) et analyse (lisibilité).
 *
 * Un `Record<string, string>` ne suffit pas ici : la chaîne `Received` compte
 * autant d'occurrences que de relais traversés, et c'est justement la séquence
 * qui répond à « par où ce message est-il passé ».
 */
export interface EmailHeaderDump {
  emailId: string;
  account: string;
  mailbox: string;
  /** Bloc d'en-têtes tel qu'il a été obtenu du serveur. */
  raw: string;
  /** En-têtes dépliés, dans l'ordre du message, occurrences répétées comprises. */
  entries: HeaderEntry[];
  /** Regroupement par nom en minuscules — toutes les valeurs, dans l'ordre. */
  grouped: Record<string, string[]>;
  /** Chaîne Received chronologique, verdicts d'authentification, alignement. */
  analysis: HeaderAnalysis;
  /**
   * Vrai quand `raw` a été RECONSTRUIT à partir d'une liste d'en-têtes fournie
   * par l'API (Graph `internetMessageHeaders`) au lieu d'être lu tel quel dans
   * le message. Les valeurs sont exactes, mais ni l'ordre de pliage ni les
   * espacements d'origine ne sont garantis.
   */
  rawReconstructed?: boolean;
}

/** Résultat de l'écriture d'un message sur disque au format `.eml`. */
export interface EmailSaveResult {
  emailId: string;
  account?: string;
  path: string;
  fileUrl: string;
  size: number;
  subject?: string;
}

/**
 * Bilan d'un export de messages en lot.
 *
 * `matched` est délibérément rapporté à côté de `files_saved`. Sans lui, un
 * export incomplet est indiscernable d'un dossier vide : `files_saved: 1` avec
 * `errors: []` se lit comme un succès, alors que la RECHERCHE peut n'avoir
 * ramené qu'un message sur neuf — les filtres d'en-tête sont interprétés par le
 * serveur, dont l'index ne fait pas forcément la correspondance de sous-chaîne
 * attendue. L'écriture, elle, n'a rien raté.
 *
 * Avec `matched`, l'appelant distingue les trois cas : la recherche n'a rien
 * trouvé (`matched: 0`), elle a trouvé moins que prévu (`matched` inférieur à
 * l'attendu — c'est le critère qu'il faut revoir), ou l'écriture a échoué
 * (`matched` supérieur à `files_saved`, avec le détail dans `errors`).
 */
export interface BatchEmailSaveResult {
  folder: string;
  /** Messages retournés par la recherche, avant toute écriture. */
  matched: number;
  /** True quand la recherche a atteint `max_emails` : le lot est un préfixe. */
  truncated: boolean;
  /** Comptes dont le tri côté client est resté partiel — voir {@link SearchCoverage}. */
  coverage?: SearchCoverage[];
  files_saved: number;
  total_size: number;
  errors: { emailId: string; account?: string; error: string }[];
}
