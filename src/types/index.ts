/**
 * Shared TypeScript types for the Email MCP Server.
 *
 * The mail domain types (accounts, mailboxes, messages, search and send
 * results) belong to the engine package and are re-exported here, so the
 * server keeps a single import point. This file only adds the types that
 * describe the MCP application itself: its configuration, triage hooks,
 * watcher, templates, calendar and scheduled sends.
 */

import type {
  AccountConfig,
  EmailAddress,
  ReplyLanguage,
} from '@pedroskynet/email-core/types/index.js';

export * from '@pedroskynet/email-core/types/index.js';

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
