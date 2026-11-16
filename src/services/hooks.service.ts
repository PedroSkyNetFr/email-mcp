/**
 * AI Hooks Service — intelligent email triage via MCP sampling.
 *
 * Listens for new email events on the event bus and:
 * - Matches static rules FIRST (fast, free, deterministic)
 * - Falls through to AI triage via `sampling/createMessage` if no rule matched
 * - Uses preset system prompts + custom instructions for AI triage
 * - Auto-applies labels and flags based on AI response
 * - Falls back to logging if sampling is unavailable
 */

import type { Server } from '@modelcontextprotocol/server';
import { mcpLog } from '@pedroskynet/email-core/logging.js';
import type ImapService from '@pedroskynet/email-core/services/imap.service.js';
import type { EmailMeta, HookRule, HooksConfig } from '../types/index.js';
import type { NewEmailEvent } from './event-bus.js';
import eventBus from './event-bus.js';
import LocalCalendarService from './local-calendar.service.js';
import type { AlertPayload, UrgencyLevel } from './notifier.service.js';
import NotifierService from './notifier.service.js';

import { buildSystemPrompt } from './presets.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TriageResult {
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  labels?: string[];
  flag?: boolean;
  action?: string;
  addToCalendar?: boolean;
}

interface BatchEmail {
  account: string;
  mailbox: string;
  meta: EmailMeta;
}

interface RuleMatchResult {
  matched: true;
  rule: HookRule;
}

interface RuleNoMatch {
  matched: false;
}

type StaticMatchOutcome = RuleMatchResult | RuleNoMatch;

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

/** Convert a glob-like pattern (with `*` wildcards and `|` OR) to a RegExp. */
function globToRegex(pattern: string): RegExp {
  const parts = pattern
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const regexParts = parts.map((part) => {
    const escaped = part.replace(/[.+?^${}()[\]\\]/g, '\\$&');
    return escaped.replace(/\*/g, '.*');
  });
  return new RegExp(`^(?:${regexParts.join('|')})$`, 'i');
}

/** Test whether a value matches a glob pattern (case-insensitive). */
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return globToRegex(pattern).test(value);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HooksService
// ---------------------------------------------------------------------------

export default class HooksService {
  private config: HooksConfig;

  private imapService: ImapService;

  private lowLevelServer: Server | null = null;

  private samplingSupported = false;

  private pendingEmails: BatchEmail[] = [];

  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  private rateCounter = 0;

  private rateResetTimer: ReturnType<typeof setInterval> | null = null;

  private readonly resolvedSystemPrompt: string;

  private readonly notifier: NotifierService;

  private readonly localCalendar: LocalCalendarService;

  private static readonly MAX_SAMPLING_PER_MIN = 10;

  /**
   * Les actions qui MODIFIENT la boîte (libellés, drapeaux, marquer lu) sont-
   * elles permises ? Décidé une fois, à la construction, à partir de
   * `read_only` : une instance en lecture seule promet de ne changer aucune
   * boîte, et les règles statiques comme le tri IA (`auto_label`,
   * `auto_flag`) passaient jusqu'ici outre. Les notifications, elles, ne
   * touchent pas la boîte et restent actives.
   */
  private readonly mailboxWritesAllowed: boolean;

  /**
   * Écouteur nommé, pour que stop() détache exactement CET abonnement. Le
   * canal `email:new` est partagé : `removeAllListeners` désabonnait en
   * silence tout autre consommateur.
   */
  private readonly onNewEmailHandler = (event: NewEmailEvent): void => {
    this.onNewEmail(event);
  };

  private listening = false;

  constructor(config: HooksConfig, imapService: ImapService, options: { readOnly?: boolean } = {}) {
    this.config = config;
    this.imapService = imapService;
    this.mailboxWritesAllowed = options.readOnly !== true;
    this.notifier = new NotifierService(config.alerts);
    this.localCalendar = new LocalCalendarService();
    this.resolvedSystemPrompt = buildSystemPrompt(config.preset, {
      customInstructions: config.customInstructions,
      systemPrompt: config.systemPrompt,
    });
  }

  /** Returns the NotifierService instance for direct tool access. */
  getNotifier(): NotifierService {
    return this.notifier;
  }

  /** Returns the current hooks configuration. */
  getHooksConfig(): HooksConfig {
    return this.config;
  }

  /**
   * Start listening for email events.
   * Call after MCP server is connected so we can access the low-level server.
   */
  start(lowLevelServer: Server, clientCapabilities: { sampling?: boolean }): void {
    this.lowLevelServer = lowLevelServer;
    this.samplingSupported = clientCapabilities.sampling === true;

    if (this.config.onNewEmail === 'none') return;

    if (!this.listening) {
      eventBus.on('email:new', this.onNewEmailHandler);
      this.listening = true;
    }

    if (!this.mailboxWritesAllowed && this.hasMailboxActions()) {
      mcpLog(
        'info',
        'hooks',
        'read_only is set: hook actions that change the mailbox (labels, flags, mark read, ' +
          'auto_label, auto_flag) are skipped; notifications still run.',
      ).catch(() => {});
    }

    // Rate limit reset every 60s
    this.rateResetTimer = setInterval(() => {
      this.rateCounter = 0;
    }, 60_000);

    const ruleCount = this.config.rules.length;
    mcpLog(
      'info',
      'hooks',
      `Hooks active: mode=${this.config.onNewEmail}, preset=${this.config.preset}, ` +
        `rules=${ruleCount}, sampling=${this.samplingSupported ? 'yes' : 'no'}`,
    ).catch(() => {});
  }

  stop(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingEmails = [];
    if (this.rateResetTimer) {
      clearInterval(this.rateResetTimer);
      this.rateResetTimer = null;
    }
    this.notifier.stop();
    eventBus.off('email:new', this.onNewEmailHandler);
    this.listening = false;
  }

  /** La configuration demande-t-elle au moins une action qui modifie la boîte ? */
  private hasMailboxActions(): boolean {
    return (
      this.config.autoLabel ||
      this.config.autoFlag ||
      this.config.rules.some(
        (rule) =>
          (rule.actions.labels?.length ?? 0) > 0 ||
          rule.actions.flag === true ||
          rule.actions.markRead === true,
      )
    );
  }

  /** Message d'une erreur, pour la journaliser au lieu de l'avaler. */
  private static describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // -------------------------------------------------------------------------
  // Event handling + batching
  // -------------------------------------------------------------------------

  private onNewEmail(event: NewEmailEvent): void {
    const items = event.emails.map((meta) => ({
      account: event.account,
      mailbox: event.mailbox,
      meta,
    }));
    this.pendingEmails.push(...items);

    this.batchTimer ??= setTimeout(() => {
      this.flushBatch().catch(() => {});
    }, this.config.batchDelay * 1000);
  }

  private async flushBatch(): Promise<void> {
    this.batchTimer = null;
    const batch = [...this.pendingEmails];
    this.pendingEmails = [];
    if (batch.length === 0) return;

    await this.sendResourceUpdates(batch);

    // Partition: static-rule-matched vs needs-AI-triage
    const ruleMatched: { email: BatchEmail; rule: HookRule }[] = [];
    const needsTriage: BatchEmail[] = [];

    batch.forEach((email) => {
      const outcome = HooksService.matchStaticRules(email, this.config.rules);
      if (outcome.matched) {
        ruleMatched.push({ email, rule: outcome.rule });
      } else {
        needsTriage.push(email);
      }
    });

    // Apply static rule actions
    if (ruleMatched.length > 0) {
      const ruleOps = ruleMatched.map(async ({ email, rule }) => this.applyStaticRule(email, rule));
      await Promise.allSettled(ruleOps);
    }

    // AI triage for remaining emails
    if (needsTriage.length > 0) {
      if (this.config.onNewEmail === 'triage' && this.samplingSupported) {
        await this.triageBatch(needsTriage);
      } else {
        await this.notifyBatch(needsTriage);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Static rule matching
  // -------------------------------------------------------------------------

  static matchStaticRules(email: BatchEmail, rules: HookRule[]): StaticMatchOutcome {
    const matched = rules.find((rule) => HooksService.emailMatchesRule(email, rule));
    return matched ? { matched: true, rule: matched } : { matched: false };
  }

  private static emailMatchesRule(email: BatchEmail, rule: HookRule): boolean {
    const { match } = rule;
    const fromAddr = email.meta.from.address;
    const fromFull = email.meta.from.name ? `${email.meta.from.name} <${fromAddr}>` : fromAddr;
    const toAddrs = email.meta.to.map((t) => t.address).join(', ');
    const { subject } = email.meta;

    // All specified match conditions must pass (AND logic)
    if (
      match.from &&
      !matchesPattern(match.from, fromAddr) &&
      !matchesPattern(match.from, fromFull)
    ) {
      return false;
    }
    if (match.to && !matchesPattern(match.to, toAddrs)) {
      return false;
    }
    if (match.subject && !matchesPattern(match.subject, subject)) {
      return false;
    }

    // At least one match condition must be specified
    return Boolean(match.from ?? match.to ?? match.subject);
  }

  private async applyStaticRule(email: BatchEmail, rule: HookRule): Promise<void> {
    const { actions } = rule;

    // Les actions sur la boîte sont sautées en lecture seule (voir
    // `mailboxWritesAllowed`) ; l'alerte et le calendrier local restent.
    if (this.mailboxWritesAllowed) {
      // Apply labels
      if (actions.labels?.length) {
        await this.applyLabels(email, actions.labels);
      }

      // Apply flag
      if (actions.flag) {
        await this.applyFlag(email, 'flag');
      }

      // Mark read
      if (actions.markRead) {
        await this.applyFlag(email, 'read');
      }
    }

    // Send alert via notifier (rule with alert=true forces desktop notification)
    const payload: AlertPayload = {
      ...HooksService.messageRef(email),
      account: email.account,
      sender: email.meta.from,
      subject: email.meta.subject,
      priority: actions.flag ? 'high' : 'normal',
      labels: actions.labels,
      ruleName: rule.name,
    };
    await this.notifier.alert(payload, actions.alert === true);

    // Add to calendar if rule requests it or global auto_calendar is on
    if (actions.addToCalendar ?? this.config.autoCalendar) {
      const { isCalendarProcessed, markCalendarProcessed } = await import(
        '../utils/calendar-state.js'
      );
      const already = await isCalendarProcessed(email.account, email.meta.id);
      if (!already) {
        await this.applyCalendarAction(email);
        await markCalendarProcessed(email.account, email.meta.id, 'event', email.meta.subject);
      } else {
        await mcpLog(
          'info',
          'hooks',
          `Calendar: skipping auto-add for ${email.meta.id} (already processed once)`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mailbox actions (labels / flags)
  // -------------------------------------------------------------------------

  /** Pose des libellés ; un échec est journalisé avec sa cause, jamais avalé. */
  private async applyLabels(email: BatchEmail, labels: string[]): Promise<void> {
    const labelOps = labels.map(async (label) => {
      try {
        await this.imapService.addLabel(email.account, email.meta.id, email.mailbox, label);
      } catch (err) {
        await mcpLog(
          'warning',
          'hooks',
          `Could not add label "${label}" to email ${email.meta.id}: ${HooksService.describe(err)}`,
        );
      }
    });
    await Promise.allSettled(labelOps);
  }

  /**
   * Pose un drapeau. L'ordre des arguments est celui de
   * `setFlags(compte, idMessage, dossier, action)` : l'ancien appel passait le
   * dossier à la place de l'identifiant (et inversement), si bien que chaque
   * `flag` / `mark_read` d'un hook échouait — en silence, l'erreur étant
   * avalée par un `catch` vide.
   */
  private async applyFlag(email: BatchEmail, action: 'flag' | 'read'): Promise<void> {
    try {
      await this.imapService.setFlags(email.account, email.meta.id, email.mailbox, action);
    } catch (err) {
      const what = action === 'flag' ? 'flag' : 'mark as read';
      await mcpLog(
        'warning',
        'hooks',
        `Could not ${what} email ${email.meta.id}: ${HooksService.describe(err)}`,
      );
    }
  }

  /** Références du message pour un consommateur de webhook (le retrouver, savoir où). */
  private static messageRef(
    email: BatchEmail,
  ): Pick<AlertPayload, 'uid' | 'folder' | 'hasAttachments'> {
    return {
      uid: email.meta.id,
      folder: email.mailbox,
      hasAttachments: email.meta.hasAttachments,
    };
  }

  // -------------------------------------------------------------------------
  // Resource subscription notifications
  // -------------------------------------------------------------------------

  private async sendResourceUpdates(emails: BatchEmail[]): Promise<void> {
    if (!this.lowLevelServer) return;

    const accounts = [...new Set(emails.map((e) => e.account))];
    const srv = this.lowLevelServer;

    const ops = accounts.flatMap((account) => [
      srv.sendResourceUpdated({ uri: `email://${account}/unread` }).catch(() => {}),
      srv.sendResourceUpdated({ uri: `email://${account}/mailboxes` }).catch(() => {}),
    ]);
    await Promise.allSettled(ops);
  }

  // -------------------------------------------------------------------------
  // Notify mode (alerts-aware fallback)
  // -------------------------------------------------------------------------

  private async notifyBatch(emails: BatchEmail[]): Promise<void> {
    const ops = emails.map(async (e) => {
      const payload: AlertPayload = {
        ...HooksService.messageRef(e),
        account: e.account,
        sender: e.meta.from,
        subject: e.meta.subject,
        priority: 'normal',
      };
      return this.notifier.alert(payload);
    });
    await Promise.allSettled(ops);
  }

  // -------------------------------------------------------------------------
  // Triage mode (AI sampling with preset prompts)
  // -------------------------------------------------------------------------

  private async triageBatch(emails: BatchEmail[]): Promise<void> {
    if (this.rateCounter >= HooksService.MAX_SAMPLING_PER_MIN) {
      await mcpLog('warning', 'hooks', 'Sampling rate limit reached — falling back to notify');
      await this.notifyBatch(emails);
      return;
    }

    // Skip AI for notification-only preset
    if (this.config.preset === 'notification-only' || !this.resolvedSystemPrompt) {
      await this.notifyBatch(emails);
      return;
    }

    this.rateCounter += 1;

    const emailSummaries = emails.map((e, i) => HooksService.formatEmailSummary(e, i)).join('\n\n');
    const userPrompt = `Analyze these ${emails.length} new email(s):\n\n${emailSummaries}`;

    try {
      const srv = this.lowLevelServer;
      if (!srv) throw new Error('Server not available');

      const result = await srv.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: userPrompt } }],
        systemPrompt: this.resolvedSystemPrompt,
        maxTokens: 1000,
        modelPreferences: {
          hints: [{ name: 'fast' }],
          speedPriority: 0.8,
          intelligencePriority: 0.5,
        },
      });

      const text = result.model && result.content?.type === 'text' ? result.content.text : '';

      const triageResults = HooksService.parseTriageResponse(text, emails.length);
      await this.applyTriageResults(emails, triageResults);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'hooks', `Sampling failed: ${errMsg} — falling back to notify`);
      await this.notifyBatch(emails);
    }
  }

  private static formatEmailSummary(e: BatchEmail, index: number): string {
    const flagIcons = [
      e.meta.flagged ? '⭐' : '',
      e.meta.seen ? '👁️' : '🆕',
      e.meta.hasAttachments ? '📎' : '',
    ].join('');
    return (
      `[${index + 1}] From: ${e.meta.from.name ?? e.meta.from.address}\n` +
      `    Subject: ${e.meta.subject}\n` +
      `    Date: ${e.meta.date}\n` +
      `    Flags: ${flagIcons}`
    );
  }

  // -------------------------------------------------------------------------
  // Triage application
  // -------------------------------------------------------------------------

  private async applyTriageResults(emails: BatchEmail[], results: TriageResult[]): Promise<void> {
    const ops = emails.map(async (email, i) => this.applySingleTriage(email, results[i] ?? {}));
    await Promise.allSettled(ops);
  }

  private async applySingleTriage(email: BatchEmail, triage: TriageResult): Promise<void> {
    // Auto-label (sauté en lecture seule)
    if (this.mailboxWritesAllowed && this.config.autoLabel && triage.labels?.length) {
      await this.applyLabels(email, triage.labels);
    }

    // Auto-flag (sauté en lecture seule)
    if (this.mailboxWritesAllowed && this.config.autoFlag && triage.flag) {
      await this.applyFlag(email, 'flag');
    }

    // Route through notifier for urgency-based alerts
    const priority: UrgencyLevel = triage.priority ?? 'normal';
    const payload: AlertPayload = {
      ...HooksService.messageRef(email),
      account: email.account,
      sender: email.meta.from,
      subject: email.meta.subject,
      priority,
      labels: triage.labels,
    };
    await this.notifier.alert(payload);
    if (triage.action) {
      await mcpLog('info', 'hooks', `   Action: ${triage.action}`);
    }

    // Add to calendar if AI triage requested it or global auto_calendar is on
    if (triage.addToCalendar ?? this.config.autoCalendar) {
      const { isCalendarProcessed, markCalendarProcessed } = await import(
        '../utils/calendar-state.js'
      );
      const already = await isCalendarProcessed(email.account, email.meta.id);
      if (!already) {
        await this.applyCalendarAction(email);
        await markCalendarProcessed(email.account, email.meta.id, 'event', email.meta.subject);
      } else {
        await mcpLog(
          'info',
          'hooks',
          `Calendar: skipping auto-add for ${email.meta.id} (already processed once — instruct AI to add again)`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Calendar auto-add helper
  // -------------------------------------------------------------------------

  private async applyCalendarAction(email: BatchEmail): Promise<void> {
    const { buildCalendarNotes } = await import('../utils/calendar-notes.js');
    const { extractConferenceDetails } = await import('../utils/conference-details.js');
    const { extractMeetingUrl } = await import('../utils/meeting-url.js');
    const { CALENDAR_ATTACHMENTS_DIR } = await import('../config/xdg.js');
    const path = await import('node:path');

    try {
      const full = await this.imapService.getEmail(email.account, email.meta.id, email.mailbox);
      const bodyText = full.bodyText ?? '';
      const bodyHtml = full.bodyHtml ?? '';
      const combined = `${bodyText}\n${bodyHtml}`;

      // Try ICS extraction
      let start = new Date(full.date);
      let end = new Date(start.getTime() + 60 * 60 * 1000);
      let location: string | undefined;
      let icsUid: string | undefined;

      try {
        const { default: CalSvc } = await import('./calendar.service.js');
        const calSvc = new CalSvc();
        const icsContents = await this.imapService.getCalendarParts(
          email.account,
          email.mailbox,
          email.meta.id,
        );
        if (icsContents.length > 0) {
          const events = calSvc.extractFromParts(icsContents);
          if (events.length > 0) {
            start = new Date(events[0].start);
            end = new Date(events[0].end);
            location = events[0].location;
            icsUid = events[0].uid;
          }
        }
      } catch {
        // ICS extraction is best-effort
      }

      const meetingUrl = extractMeetingUrl(combined);
      const conference = extractConferenceDetails(bodyText !== '' ? bodyText : bodyHtml);

      // Save attachments
      let savedAttachments: Awaited<ReturnType<typeof this.imapService.saveEmailAttachments>> = [];
      if (full.attachments.length > 0) {
        const destDir = path.join(
          CALENDAR_ATTACHMENTS_DIR,
          `${email.account}-${email.meta.id}`.replace(/[^a-zA-Z0-9-_]/g, '_'),
        );
        savedAttachments = await this.imapService.saveEmailAttachments(
          email.account,
          email.meta.id,
          email.mailbox,
          destDir,
        );
      }

      const notes = buildCalendarNotes({
        emailFrom: full.from.name ? `${full.from.name} <${full.from.address}>` : full.from.address,
        emailSubject: full.subject,
        emailDate: new Date(full.date).toLocaleString(),
        meetingUrl: meetingUrl?.url,
        meetingUrlLabel: meetingUrl?.label,
        dialIn: conference?.dialIn,
        meetingId: conference?.meetingId,
        passcode: conference?.passcode,
        conferenceProvider: conference?.provider,
        bodyExcerpt: bodyText !== '' ? bodyText : bodyHtml,
        savedAttachments,
      });

      const result = await this.localCalendar.addEvent(
        {
          title: full.subject,
          start,
          end,
          location,
          notes,
          url: meetingUrl?.url,
          urlLabel: meetingUrl?.label,
          alarmMinutes: this.config.calendarAlarmMinutes ?? 15,
          savedAttachments,
          dialIn: conference?.dialIn,
          meetingId: conference?.meetingId,
          passcode: conference?.passcode,
          icsUid,
        },
        this.config.calendarName !== '' ? this.config.calendarName : undefined,
        { confirm: this.config.calendarConfirm !== false },
      );

      await mcpLog('info', 'hooks', `Calendar: ${result.message}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'hooks', `Calendar auto-add failed: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // Response parsing
  // -------------------------------------------------------------------------

  static parseTriageResponse(text: string, expectedCount: number): TriageResult[] {
    try {
      const cleaned = text.replace(/```(?:json)?\n?/g, '').trim();
      const parsed = JSON.parse(cleaned) as unknown;

      if (Array.isArray(parsed)) {
        return parsed.slice(0, expectedCount).map(HooksService.sanitizeTriageResult);
      }
      if (typeof parsed === 'object' && parsed !== null) {
        return [HooksService.sanitizeTriageResult(parsed)];
      }
    } catch {
      // Parse failure — return empty results
    }
    return Array.from({ length: expectedCount }, () => ({}));
  }

  static sanitizeTriageResult(raw: unknown): TriageResult {
    if (typeof raw !== 'object' || raw === null) return {};
    const obj = raw as Record<string, unknown>;
    return {
      priority: ['urgent', 'high', 'normal', 'low'].includes(obj.priority as string)
        ? (obj.priority as TriageResult['priority'])
        : undefined,
      labels: Array.isArray(obj.labels)
        ? obj.labels.filter((l): l is string => typeof l === 'string').slice(0, 5)
        : undefined,
      flag: typeof obj.flag === 'boolean' ? obj.flag : undefined,
      action: typeof obj.action === 'string' ? obj.action.slice(0, 200) : undefined,
      addToCalendar: typeof obj.add_to_calendar === 'boolean' ? obj.add_to_calendar : undefined,
    };
  }
}
