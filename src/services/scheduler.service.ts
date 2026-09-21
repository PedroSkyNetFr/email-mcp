/**
 * Scheduler service — JSON file-based email scheduling queue.
 *
 * Manages scheduled emails with a local file queue.
 * Source of truth is the JSON files in XDG state directory.
 *
 * Several processes share that directory: every MCP client conversation starts
 * its own server, and `email-mcp scheduler check` may run from cron or by hand.
 * Two rules keep them from stepping on each other:
 *
 * - An existing entry is only changed by the process holding its claim, a
 *   `<id>.claim` file created with `wx`. The filesystem lets exactly one
 *   process create it; that, and not the `status` field, decides who sends.
 * - Every write goes to a temporary file first and is renamed into place, so a
 *   reader sees the previous entry or the new one, never half of it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SCHEDULED_DIR, SCHEDULED_SENT_DIR } from '../config/xdg.js';
import { mcpLog } from '../logging.js';
import type { ScheduledEmail, SendResult } from '../types/index.js';
import type { IMailService } from './mail-service.types.js';
import type { ISendService } from './send-service.types.js';

/**
 * How long a send may hold its claim before it counts as interrupted. A stuck
 * send gives up well before: nodemailer's default timeouts (DNS 30 s,
 * connection 2 min, 10 min of socket silence) end one within about 12.5 min,
 * and a Graph request is bounded by fetch's 5-minute default plus one retry.
 */
const INTERRUPTED_AFTER_MS = 15 * 60 * 1000;

const INTERRUPTED_WHILE_SENDING =
  'Interrupted while sending: it may have gone out. ' +
  'Check the Sent folder before scheduling it again.';
const INTERRUPTED_BEFORE_SENDING =
  'Interrupted before sending: it did not go out. Schedule it again if it is still needed.';

/** Max retry attempts before marking as "failed" */
const MAX_ATTEMPTS = 3;

/** Interval between two queue checks while the server runs */
const CHECK_INTERVAL_MS = 60_000;

/**
 * Errors Windows returns while another program (antivirus, search indexer)
 * briefly holds a file that was just written. Worth a few retries.
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const FS_RETRIES = 5;

interface CheckResult {
  sent: number;
  failed: number;
  errors: string[];
}

/** What one check did with one queue entry */
interface EntryOutcome {
  outcome: 'skipped' | 'sent' | 'failed';
  errors: string[];
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function renameWithRetry(from: string, to: string, attempt = 0): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (attempt >= FS_RETRIES || !TRANSIENT_FS_CODES.has(errorCode(err) ?? '')) throw err;
    await new Promise((resolve) => {
      setTimeout(resolve, 20 * 2 ** attempt);
    });
    await renameWithRetry(from, to, attempt + 1);
  }
}

export default class SchedulerService {
  private interval: ReturnType<typeof setInterval> | undefined;

  /**
   * Both services route per account: a Graph-backed account sends and keeps
   * its draft mirror through Microsoft Graph, never through SMTP or IMAP.
   */
  constructor(
    private sendService: ISendService,
    private mailService: IMailService,
  ) {}

  // -------------------------------------------------------------------------
  // Schedule a new email
  // -------------------------------------------------------------------------

  async schedule(
    account: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      sendAt: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<ScheduledEmail> {
    const sendAtDate = new Date(options.sendAt);
    if (Number.isNaN(sendAtDate.getTime())) {
      throw new Error(`Invalid send_at date: ${options.sendAt}`);
    }
    if (sendAtDate.getTime() <= Date.now()) {
      throw new Error('send_at must be in the future');
    }

    const scheduled: ScheduledEmail = {
      id: crypto.randomUUID(),
      account,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      html: options.html ?? false,
      sendAt: sendAtDate.toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      inReplyTo: options.inReplyTo,
      references: options.references,
    };

    // Mirror it as a draft (best-effort)
    try {
      const draftResult = await this.mailService.saveDraft(account, {
        to: options.to,
        subject: `[Scheduled: ${sendAtDate.toLocaleString()}] ${options.subject}`,
        body: options.body,
        cc: options.cc,
        html: options.html,
      });
      scheduled.draftMessageId = String(draftResult.id);
      scheduled.draftMailbox = draftResult.mailbox;
    } catch {
      // Draft mirror is best-effort
    }

    await SchedulerService.ensureDirs();
    await SchedulerService.writeEntry(path.join(SCHEDULED_DIR, `${scheduled.id}.json`), scheduled);
    return scheduled;
  }

  // -------------------------------------------------------------------------
  // List scheduled emails
  // -------------------------------------------------------------------------

  // eslint-disable-next-line class-methods-use-this
  async list(
    options: { account?: string; status?: 'pending' | 'sent' | 'failed' | 'all' } = {},
  ): Promise<ScheduledEmail[]> {
    const status = options.status ?? 'pending';
    const emails: ScheduledEmail[] = [];

    // Read pending/sending/failed from main dir
    if (status !== 'sent') {
      const pending = await SchedulerService.readDir(SCHEDULED_DIR);
      emails.push(...pending);
    }

    // Read sent from sent/ subdir
    if (status === 'sent' || status === 'all') {
      const sent = await SchedulerService.readDir(SCHEDULED_SENT_DIR);
      emails.push(...sent);
    }

    // Filter by account if specified
    const filtered = options.account ? emails.filter((e) => e.account === options.account) : emails;

    // Filter by status unless "all"
    if (status !== 'all') {
      return filtered.filter((e) => e.status === status);
    }

    return filtered.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
  }

  // -------------------------------------------------------------------------
  // Cancel a scheduled email
  // -------------------------------------------------------------------------

  async cancel(scheduleId: string): Promise<{ cancelled: boolean; draftDeleted: boolean }> {
    // The id becomes a file name inside the queue directory: never let it
    // point anywhere else.
    if (!/^[\w-]+$/.test(scheduleId)) {
      throw new Error(`Scheduled email "${scheduleId}" not found`);
    }

    const filePath = path.join(SCHEDULED_DIR, `${scheduleId}.json`);
    let draftDeleted = false;

    // Take the claim, so a check cannot send the email while it is cancelled.
    await SchedulerService.ensureDirs();
    if (!(await SchedulerService.claim(scheduleId))) {
      throw new Error(
        `Scheduled email "${scheduleId}" is being sent right now and can no longer be cancelled`,
      );
    }

    try {
      const scheduled = await SchedulerService.readEntry(filePath);
      if (!scheduled) {
        throw new Error(`Scheduled email "${scheduleId}" not found`);
      }

      if (scheduled.status !== 'pending') {
        throw new Error(`Cannot cancel email with status "${scheduled.status}"`);
      }

      // Delete the draft mirror (best-effort)
      if (scheduled.draftMessageId && scheduled.draftMailbox) {
        try {
          await this.mailService.deleteEmail(
            scheduled.account,
            scheduled.draftMessageId,
            scheduled.draftMailbox,
          );
          draftDeleted = true;
        } catch {
          // Draft deletion is best-effort
        }
      }

      await fs.rm(filePath, { maxRetries: FS_RETRIES });
      return { cancelled: true, draftDeleted };
    } finally {
      await SchedulerService.release(scheduleId);
    }
  }

  // -------------------------------------------------------------------------
  // In-process queue check
  // -------------------------------------------------------------------------

  /**
   * Check the queue now, then every minute while the server runs.
   *
   * A read-only server never starts it. Read-only means this process sends
   * nothing, and a scheduled email is a send like any other — including one
   * queued from another client, since every process shares the queue on disk.
   */
  async start(options: { readOnly: boolean }): Promise<void> {
    if (options.readOnly) {
      await mcpLog(
        'notice',
        'scheduler',
        'Scheduler disabled: read-only mode sends nothing, scheduled emails included. ' +
          'A server without read_only, or `email-mcp scheduler check`, sends them.',
      );
      return;
    }

    // Check for overdue scheduled emails on startup
    try {
      const result = await this.checkAndSend();
      if (result.sent > 0) {
        await mcpLog('info', 'scheduler', `Sent ${result.sent} overdue email(s) on startup`);
      }
    } catch {
      // Non-fatal: scheduler check failure shouldn't prevent server start
    }

    // Periodic check. Runs may overlap if one takes over a minute; the claim
    // keeps them from sending the same email twice.
    this.interval = setInterval(async () => {
      try {
        await this.checkAndSend();
      } catch {
        // Silent — don't spam logs
      }
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  // -------------------------------------------------------------------------
  // Check and send overdue emails
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop -- Sequential file processing required */
  async checkAndSend(): Promise<CheckResult> {
    const result: CheckResult = { sent: 0, failed: 0, errors: [] };
    await SchedulerService.ensureDirs();

    let files: string[];
    try {
      files = await fs.readdir(SCHEDULED_DIR);
    } catch {
      return result;
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const now = Date.now();

    // eslint-disable-next-line no-restricted-syntax
    for (const file of jsonFiles) {
      try {
        const { outcome, errors } = await this.processEntry(file, now);
        if (outcome === 'sent') result.sent += 1;
        if (outcome === 'failed') result.failed += 1;
        result.errors.push(...errors.map((error) => `${file}: ${error}`));
      } catch (err) {
        // Nothing was sent: whatever failed happened before the SMTP call.
        result.errors.push(`${file}: ${errorMessage(err)}`);
        result.failed += 1;
      }
    }

    return result;
  }
  /* eslint-enable no-await-in-loop */

  /**
   * Send one queue entry if it is due, under its claim.
   *
   * Throws only when nothing left the machine; once the email is sent, later
   * failures come back in `errors` and never put it back in the queue.
   */
  private async processEntry(file: string, now: number): Promise<EntryOutcome> {
    const filePath = path.join(SCHEDULED_DIR, file);
    const id = path.basename(file, '.json');
    // Shared with every outcome returned below, so an error pushed by the
    // `finally` block (failed release) still reaches the caller.
    const errors: string[] = [];

    // A first look without the claim, so entries that are not due do not take
    // one every minute in every process.
    const unclaimed = await SchedulerService.readEntry(filePath);
    if (!unclaimed) return { outcome: 'skipped', errors };
    const firstLook = SchedulerService.nextStep(unclaimed, now);
    if (firstLook === 'skip') return { outcome: 'skipped', errors };
    if (firstLook === 'check-interrupted') {
      const failed = await SchedulerService.failIfInterrupted(filePath, id, unclaimed, now);
      return { outcome: failed ? 'failed' : 'skipped', errors };
    }

    // Another process holds it: normally it is sending this email, or
    // cancelling it — unless it died before starting, leaving an old claim.
    if (!(await SchedulerService.claim(id))) {
      const failed = await SchedulerService.failIfInterrupted(filePath, id, unclaimed, now);
      return { outcome: failed ? 'failed' : 'skipped', errors };
    }

    let keepClaim = false;
    try {
      // Decide again under the claim: between the first read and the claim,
      // another process may have sent, retried or cancelled this entry.
      const scheduled = await SchedulerService.readEntry(filePath);
      if (!scheduled) return { outcome: 'skipped', errors };
      const step = SchedulerService.nextStep(scheduled, now);
      if (step !== 'send' && step !== 'expire') return { outcome: 'skipped', errors };

      if (step === 'expire') {
        scheduled.status = 'failed';
        scheduled.lastError = 'Max retry attempts exceeded';
        await SchedulerService.writeEntry(filePath, scheduled);
        return { outcome: 'failed', errors };
      }

      // Record the attempt before sending, so an interrupted send leaves a trace
      scheduled.status = 'sending';
      scheduled.attempts += 1;
      await SchedulerService.writeEntry(filePath, scheduled);

      let sendResult: SendResult;
      try {
        sendResult = await this.sendService.sendEmail(scheduled.account, {
          to: scheduled.to,
          subject: scheduled.subject,
          body: scheduled.body,
          cc: scheduled.cc,
          bcc: scheduled.bcc,
          html: scheduled.html,
        });
      } catch (err) {
        // Not sent: back in the queue for another attempt, or failed for good
        scheduled.status = scheduled.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        scheduled.lastError = errorMessage(err);
        await SchedulerService.writeEntry(filePath, scheduled);
        errors.push(scheduled.lastError);
        return { outcome: 'failed', errors };
      }

      // The email is out. From here on, a failure must not return the entry
      // to "pending": the next check would send it a second time.
      scheduled.status = 'sent';
      scheduled.sentAt = new Date().toISOString();
      scheduled.sentMessageId = sendResult.messageId;

      try {
        await SchedulerService.writeEntry(filePath, scheduled);
      } catch (err) {
        // Still "sending" on disk. Keeping the claim stops every process from
        // sending it again, exactly as if this one had crashed mid-send: it is
        // later reported as interrupted, never sent a second time.
        keepClaim = true;
        errors.push(
          `sent, but could not be marked as sent (${errorMessage(err)}); ` +
            'left claimed so it is not sent again',
        );
        return { outcome: 'sent', errors };
      }

      // Marked "sent" in place first, so if this move fails the entry stays
      // in the queue directory as sent — never as something to send.
      try {
        await renameWithRetry(filePath, path.join(SCHEDULED_SENT_DIR, file));
      } catch (err) {
        errors.push(`sent, but not moved to sent/ (${errorMessage(err)})`);
      }

      // Delete draft (best-effort)
      if (scheduled.draftMessageId && scheduled.draftMailbox) {
        try {
          await this.mailService.deleteEmail(
            scheduled.account,
            scheduled.draftMessageId,
            scheduled.draftMailbox,
          );
        } catch {
          // Best-effort
        }
      }

      return { outcome: 'sent', errors };
    } finally {
      if (!keepClaim) {
        try {
          await SchedulerService.release(id);
        } catch (err) {
          errors.push(
            `could not release its claim (${errorMessage(err)}); ` +
              `it stays blocked until ${id}.claim is removed`,
          );
        }
      }
    }
  }

  /**
   * Mark as failed an entry whose sending process died, so it shows up in
   * `scheduler list` instead of sitting unseen. It is never sent again: the
   * SMTP server may have accepted the message before the process died, and
   * only the Sent folder can tell. Returns false while the send may still be
   * running.
   *
   * Taking over another process's claim is safe here because nothing is sent:
   * two processes doing it at once write the same "failed" entry.
   */
  private static async failIfInterrupted(
    filePath: string,
    id: string,
    scheduled: ScheduledEmail,
    now: number,
  ): Promise<boolean> {
    // When the send began: the claim's creation, or — for an entry left
    // "sending" without one — the entry's last write.
    const since =
      (await SchedulerService.modifiedAt(SchedulerService.claimPath(id))) ??
      (await SchedulerService.modifiedAt(filePath));
    if (since === null || now - since <= INTERRUPTED_AFTER_MS) return false;

    await SchedulerService.writeEntry(filePath, {
      ...scheduled,
      status: 'failed',
      // "pending" under a claim means the process died before it started
      lastError:
        scheduled.status === 'sending' ? INTERRUPTED_WHILE_SENDING : INTERRUPTED_BEFORE_SENDING,
    });
    await SchedulerService.release(id);
    return true;
  }

  /**
   * What a check should do with an entry, as last written.
   * "send" and "expire" are only acted on while holding the entry's claim.
   */
  private static nextStep(
    scheduled: ScheduledEmail,
    now: number,
  ): 'skip' | 'send' | 'expire' | 'check-interrupted' {
    // Either a send in progress or one whose process died; only its age tells
    // them apart. It is never sent again either way.
    if (scheduled.status === 'sending') return 'check-interrupted';

    // Skip non-pending
    if (scheduled.status !== 'pending') return 'skip';

    // Skip if not yet due
    if (new Date(scheduled.sendAt).getTime() > now) return 'skip';

    // Skip if max attempts exceeded
    if (scheduled.attempts >= MAX_ATTEMPTS) return 'expire';

    return 'send';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private static async ensureDirs(): Promise<void> {
    await fs.mkdir(SCHEDULED_DIR, { recursive: true });
    await fs.mkdir(SCHEDULED_SENT_DIR, { recursive: true });
  }

  private static claimPath(id: string): string {
    return path.join(SCHEDULED_DIR, `${id}.claim`);
  }

  /**
   * Claim an entry for this process. `wx` creates the file only if it does
   * not exist (O_EXCL, CREATE_NEW on Windows): exactly one caller succeeds,
   * every other one gets EEXIST. Returns false when someone else holds it.
   */
  private static async claim(id: string): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(SchedulerService.claimPath(id), 'wx');
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return false;
      throw err;
    }

    try {
      // Who holds it and since when, for anyone inspecting a stuck entry
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          claimedAt: new Date().toISOString(),
        }),
      );
    } catch {
      // The claim is the file existing, not what it says
    } finally {
      await handle.close();
    }
    return true;
  }

  private static async release(id: string): Promise<void> {
    await fs.rm(SchedulerService.claimPath(id), { force: true, maxRetries: FS_RETRIES });
  }

  /** Last modification time of a file, or null when it does not exist. */
  private static async modifiedAt(filePath: string): Promise<number | null> {
    try {
      return (await fs.stat(filePath)).mtimeMs;
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return null;
      throw err;
    }
  }

  /** Read an entry; null when it no longer exists (sent or cancelled). */
  private static async readEntry(filePath: string): Promise<ScheduledEmail | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf-8')) as ScheduledEmail;
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Write an entry atomically: a temporary file in the same directory, renamed
   * over the target. Its name does not end in `.json`, so no reader picks it up.
   */
  private static async writeEntry(filePath: string, scheduled: ScheduledEmail): Promise<void> {
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(scheduled, null, 2));
    try {
      await renameWithRetry(tmpPath, filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
  }

  private static async readDir(dirPath: string): Promise<ScheduledEmail[]> {
    const emails: ScheduledEmail[] = [];
    try {
      const files = await fs.readdir(dirPath);
      // eslint-disable-next-line no-restricted-syntax
      for (const file of files) {
        if (!file.endsWith('.json')) continue; // eslint-disable-line no-continue
        try {
          const content = await fs.readFile(path.join(dirPath, file), 'utf-8'); // eslint-disable-line no-await-in-loop
          emails.push(JSON.parse(content) as ScheduledEmail);
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory may not exist yet
    }
    return emails;
  }
}
