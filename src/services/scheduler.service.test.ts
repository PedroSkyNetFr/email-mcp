/**
 * Tests for the scheduled-email queue.
 *
 * Every MCP client conversation starts its own server process, and each one
 * runs the queue check. These tests stand several SchedulerService instances on
 * the same queue directory — the in-process equivalent of several servers — to
 * pin down that a due email leaves exactly once.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEDULED_DIR, SCHEDULED_SENT_DIR } from '../config/xdg.js';
import { mcpLog } from '../logging.js';
import type { ScheduledEmail } from '../types/index.js';
import type { IMailService } from './mail-service.types.js';
import SchedulerService from './scheduler.service.js';
import type { ISendService } from './send-service.types.js';

// Point the queue at a throwaway directory instead of ~/.local/state.
vi.mock('../config/xdg.js', async () => {
  const nodeFs = await import('node:fs/promises');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const root = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'email-mcp-scheduler-'));
  return {
    SCHEDULED_DIR: nodePath.join(root, 'scheduled'),
    SCHEDULED_SENT_DIR: nodePath.join(root, 'scheduled', 'sent'),
  };
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A fake SMTP service that records every email it is asked to send. Given
 * `accounts`, it refuses any other one, as the real service does for an
 * account missing from its configuration.
 */
function createFakeSmtp(options: { fail?: boolean; accounts?: string[] } = {}) {
  const sendEmail = vi.fn(async (account: string, _email: { subject: string }) => {
    // Let the other instances run while this "network call" is in flight.
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    if (options.accounts && !options.accounts.includes(account)) {
      throw new Error(`Account "${account}" not found`);
    }
    if (options.fail) throw new Error('SMTP connection refused');
    return { messageId: `<${crypto.randomUUID()}@test>` };
  });
  return { sendEmail };
}

const fakeImap = {
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  saveDraft: vi.fn().mockResolvedValue({ id: 1, mailbox: 'Drafts' }),
};

function createScheduler(
  smtp: ReturnType<typeof createFakeSmtp>,
  accounts: string[] = ['work'],
): SchedulerService {
  return new SchedulerService(
    smtp as unknown as ISendService,
    fakeImap as unknown as IMailService,
    accounts,
  );
}

/** Write a queue entry directly — `schedule()` refuses a date in the past. */
async function seed(overrides: Partial<ScheduledEmail> = {}): Promise<ScheduledEmail> {
  const scheduled: ScheduledEmail = {
    id: crypto.randomUUID(),
    account: 'work',
    to: ['someone@example.com'],
    subject: 'Quarterly report',
    body: 'See attached.',
    html: false,
    sendAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
  await fs.mkdir(SCHEDULED_DIR, { recursive: true });
  await fs.writeFile(
    path.join(SCHEDULED_DIR, `${scheduled.id}.json`),
    JSON.stringify(scheduled, null, 2),
  );
  return scheduled;
}

async function readEntry(dir: string, id: string): Promise<ScheduledEmail | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf-8')) as ScheduledEmail;
  } catch {
    return null;
  }
}

/** Files other than queue entries and the sent/ directory — locks, temp files. */
async function leftovers(): Promise<string[]> {
  const files = await fs.readdir(SCHEDULED_DIR);
  return files.filter((f) => f !== 'sent' && !f.endsWith('.json'));
}

beforeEach(async () => {
  await fs.rm(SCHEDULED_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Concurrent checks
// ---------------------------------------------------------------------------

describe('SchedulerService.checkAndSend — concurrent instances', () => {
  it('sends a due email exactly once when eight instances check at the same time', async () => {
    const scheduled = await seed();
    const smtp = createFakeSmtp();
    const instances = Array.from({ length: 8 }, () => createScheduler(smtp));

    const results = await Promise.all(instances.map(async (s) => s.checkAndSend()));

    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1);
    expect(results.flatMap((r) => r.errors)).toEqual([]);

    // Recorded once, as sent, and gone from the queue.
    expect(await readEntry(SCHEDULED_DIR, scheduled.id)).toBeNull();
    const sent = await readEntry(SCHEDULED_SENT_DIR, scheduled.id);
    expect(sent?.status).toBe('sent');
    expect(sent?.attempts).toBe(1);
    expect(await leftovers()).toEqual([]);
  });

  it('sends each of several due emails exactly once', async () => {
    const entries = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => seed({ subject: `Email ${i}` })),
    );
    const smtp = createFakeSmtp();
    const instances = Array.from({ length: 6 }, () => createScheduler(smtp));

    await Promise.all(instances.map(async (s) => s.checkAndSend()));

    const sentSubjects = smtp.sendEmail.mock.calls.map(([, email]) => email.subject).sort();
    expect(sentSubjects).toEqual(entries.map((e) => e.subject).sort());
    expect(await leftovers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

describe('SchedulerService.checkAndSend — claims', () => {
  it('does not send an entry another process has claimed', async () => {
    const scheduled = await seed();
    await fs.writeFile(path.join(SCHEDULED_DIR, `${scheduled.id}.claim`), '');
    const smtp = createFakeSmtp();

    const result = await createScheduler(smtp).checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, errors: [] });
    expect((await readEntry(SCHEDULED_DIR, scheduled.id))?.status).toBe('pending');
  });

  it('returns a failed send to the queue and releases the claim for the next attempt', async () => {
    const scheduled = await seed();

    const first = await createScheduler(createFakeSmtp({ fail: true })).checkAndSend();

    expect(first.failed).toBe(1);
    expect(first.errors[0]).toContain('SMTP connection refused');
    const entry = await readEntry(SCHEDULED_DIR, scheduled.id);
    expect(entry).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'SMTP connection refused',
    });
    expect(await leftovers()).toEqual([]);

    // The claim was released: the next check sends it.
    const smtp = createFakeSmtp();
    const second = await createScheduler(smtp).checkAndSend();
    expect(second.sent).toBe(1);
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    expect((await readEntry(SCHEDULED_SENT_DIR, scheduled.id))?.attempts).toBe(2);
  });

  it('leaves an entry that is not due yet untouched, without claiming it', async () => {
    const scheduled = await seed({ sendAt: new Date(Date.now() + 3_600_000).toISOString() });
    const smtp = createFakeSmtp();

    await createScheduler(smtp).checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect((await readEntry(SCHEDULED_DIR, scheduled.id))?.status).toBe('pending');
    expect(await leftovers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('SchedulerService.cancel', () => {
  it('cancels a pending entry and releases its claim', async () => {
    const scheduled = await seed({ sendAt: new Date(Date.now() + 3_600_000).toISOString() });

    const result = await createScheduler(createFakeSmtp()).cancel(scheduled.id);

    expect(result.cancelled).toBe(true);
    expect(await readEntry(SCHEDULED_DIR, scheduled.id)).toBeNull();
    expect(await leftovers()).toEqual([]);
  });

  it('refuses while a check holds the claim, so a cancelled email cannot go out', async () => {
    const scheduled = await seed();
    await fs.writeFile(path.join(SCHEDULED_DIR, `${scheduled.id}.claim`), '');

    await expect(createScheduler(createFakeSmtp()).cancel(scheduled.id)).rejects.toThrow(
      /being sent right now/,
    );
    expect((await readEntry(SCHEDULED_DIR, scheduled.id))?.status).toBe('pending');
  });

  it('treats an id that is not a plain name as unknown', async () => {
    await expect(
      createScheduler(createFakeSmtp()).cancel('../../config/email-mcp/other'),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// start() — the in-process check
// ---------------------------------------------------------------------------

describe('SchedulerService.start', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never checks the queue in read-only mode, and logs why', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler(createFakeSmtp());
    const check = vi.spyOn(scheduler, 'checkAndSend');

    await scheduler.start({ readOnly: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(check).not.toHaveBeenCalled();
    expect(mcpLog).toHaveBeenCalledWith(
      'notice',
      'scheduler',
      expect.stringContaining('Scheduler disabled: read-only mode'),
    );
    scheduler.stop();
  });

  it('does not send a due email in read-only mode', async () => {
    const scheduled = await seed();
    const smtp = createFakeSmtp();
    const scheduler = createScheduler(smtp);

    await scheduler.start({ readOnly: true });
    scheduler.stop();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(await readEntry(SCHEDULED_DIR, scheduled.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('checks on start and then every minute otherwise, until stopped', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler(createFakeSmtp());
    const check = vi
      .spyOn(scheduler, 'checkAndSend')
      .mockResolvedValue({ sent: 0, failed: 0, errors: [] });

    await scheduler.start({ readOnly: false });
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(check).toHaveBeenCalledTimes(3);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(check).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Interrupted sends
// ---------------------------------------------------------------------------

describe('SchedulerService.checkAndSend — interrupted sends', () => {
  /** Backdate a file, as if written that many minutes ago. */
  async function age(filePath: string, minutes: number): Promise<void> {
    const then = new Date(Date.now() - minutes * 60_000);
    await fs.utimes(filePath, then, then);
  }

  const claimOf = (id: string) => path.join(SCHEDULED_DIR, `${id}.claim`);
  const entryOf = (id: string) => path.join(SCHEDULED_DIR, `${id}.json`);

  it('reports a send whose process died as failed, never sending it again', async () => {
    const scheduled = await seed({ status: 'sending', attempts: 1 });
    await fs.writeFile(claimOf(scheduled.id), '');
    await age(claimOf(scheduled.id), 16);
    const smtp = createFakeSmtp();

    const result = await createScheduler(smtp).checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(await readEntry(SCHEDULED_DIR, scheduled.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: expect.stringContaining('it may have gone out'),
    });
    expect(await leftovers()).toEqual([]);
  });

  it('leaves a send alone while its claim is recent, even on a retry', async () => {
    // Formerly reset to "pending" at once: the age came from createdAt, so a
    // retry running in another process looked stale and was sent twice.
    const scheduled = await seed({
      status: 'sending',
      attempts: 2,
      lastError: 'SMTP connection refused',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await fs.writeFile(claimOf(scheduled.id), '');
    await age(claimOf(scheduled.id), 14);
    const smtp = createFakeSmtp();

    const result = await createScheduler(smtp).checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, errors: [] });
    expect((await readEntry(SCHEDULED_DIR, scheduled.id))?.status).toBe('sending');
  });

  it('dates a "sending" entry without a claim from its last write', async () => {
    const scheduled = await seed({ status: 'sending', attempts: 1 });
    await age(entryOf(scheduled.id), 16);

    const result = await createScheduler(createFakeSmtp()).checkAndSend();

    expect(result.failed).toBe(1);
    expect((await readEntry(SCHEDULED_DIR, scheduled.id))?.status).toBe('failed');
  });

  it('reports a due entry claimed by a process that died before sending as not sent', async () => {
    const scheduled = await seed();
    await fs.writeFile(claimOf(scheduled.id), '');
    await age(claimOf(scheduled.id), 16);
    const smtp = createFakeSmtp();

    await createScheduler(smtp).checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(await readEntry(SCHEDULED_DIR, scheduled.id)).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('it did not go out'),
    });
    expect(await leftovers()).toEqual([]);
  });

  it('marks an interrupted send once and sends nothing, whatever the number of instances', async () => {
    const scheduled = await seed({ status: 'sending', attempts: 1 });
    await fs.writeFile(claimOf(scheduled.id), '');
    await age(claimOf(scheduled.id), 16);
    const smtp = createFakeSmtp();
    const instances = Array.from({ length: 6 }, () => createScheduler(smtp));

    await Promise.all(instances.map(async (s) => s.checkAndSend()));

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect((await readEntry(SCHEDULED_DIR, scheduled.id))?.status).toBe('failed');
    expect(await leftovers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Accounts served
// ---------------------------------------------------------------------------

describe('SchedulerService.checkAndSend — accounts this instance does not serve', () => {
  it('leaves them unclaimed and untouched, without spending an attempt', async () => {
    const scheduled = await seed({ account: 'personal' });
    const smtp = createFakeSmtp({ accounts: ['work'] });

    const result = await createScheduler(smtp, ['work']).checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, errors: [] });
    expect(await readEntry(SCHEDULED_DIR, scheduled.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(await leftovers()).toEqual([]);
  });

  it('lets each instance send only its own accounts, once each, on the first attempt', async () => {
    // One instance per account group, like three MCP client entries each
    // restricted to some accounts, all sharing the one queue.
    const accounts = ['pro', 'personal', 'team'];
    const entries = await Promise.all(accounts.map(async (account) => seed({ account })));
    const fakes = accounts.map((account) => createFakeSmtp({ accounts: [account] }));
    const instances = accounts.map((account, i) => createScheduler(fakes[i], [account]));

    await Promise.all(instances.map(async (s) => s.checkAndSend()));

    accounts.forEach((account, i) => {
      expect(fakes[i].sendEmail).toHaveBeenCalledTimes(1);
      expect(fakes[i].sendEmail.mock.calls[0][0]).toBe(account);
    });
    const sent = await Promise.all(entries.map(async (e) => readEntry(SCHEDULED_SENT_DIR, e.id)));
    expect(sent.map((e) => e?.attempts)).toEqual([1, 1, 1]);
  });
});
