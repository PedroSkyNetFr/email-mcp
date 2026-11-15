import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SENT_RETENTION_DAYS, pruneSentHistory } from './scheduler-retention.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');

describe('pruneSentHistory', () => {
  let dir: string;

  async function write(name: string, entry: Record<string, unknown> | string): Promise<void> {
    await fs.writeFile(
      path.join(dir, name),
      typeof entry === 'string' ? entry : JSON.stringify(entry),
      'utf-8',
    );
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-retention-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps 30 days of history by default (user decision)', () => {
    expect(DEFAULT_SENT_RETENTION_DAYS).toBe(30);
  });

  it('with the default window, a 40-day-old sent entry goes and a 20-day-old one stays', async () => {
    await write('d40.json', { status: 'sent', sentAt: new Date(NOW - 40 * DAY).toISOString() });
    await write('d20.json', { status: 'sent', sentAt: new Date(NOW - 20 * DAY).toISOString() });
    // Jamais supprimée, quel que soit son âge : son statut n'est pas « sent ».
    await write('failed.json', {
      status: 'failed',
      createdAt: new Date(NOW - 400 * DAY).toISOString(),
    });

    const result = await pruneSentHistory({
      retentionDays: DEFAULT_SENT_RETENTION_DAYS,
      dir,
      now: NOW,
    });

    expect(result).toEqual({ deleted: 1, kept: 2 });
    expect((await fs.readdir(dir)).sort()).toEqual(['d20.json', 'failed.json']);
  });

  it('deletes sent entries older than the window and keeps the rest', async () => {
    await write('old.json', { status: 'sent', sentAt: new Date(NOW - 100 * DAY).toISOString() });
    await write('recent.json', { status: 'sent', sentAt: new Date(NOW - 10 * DAY).toISOString() });
    // Historique antérieur au champ sentAt : createdAt sert de repli.
    await write('legacy.json', {
      status: 'sent',
      createdAt: new Date(NOW - 200 * DAY).toISOString(),
    });

    const result = await pruneSentHistory({ retentionDays: 90, dir, now: NOW });

    expect(result).toEqual({ deleted: 2, kept: 1 });
    expect((await fs.readdir(dir)).sort()).toEqual(['recent.json']);
  });

  it('never deletes an entry whose own status is not "sent"', async () => {
    await write('pending.json', {
      status: 'pending',
      createdAt: new Date(NOW - 400 * DAY).toISOString(),
    });
    await write('broken.json', '{ not json');

    const result = await pruneSentHistory({ retentionDays: 90, dir, now: NOW });

    expect(result).toEqual({ deleted: 0, kept: 2 });
    expect((await fs.readdir(dir)).sort()).toEqual(['broken.json', 'pending.json']);
  });

  it('keeps everything when retention is 0', async () => {
    await write('old.json', { status: 'sent', sentAt: new Date(NOW - 1000 * DAY).toISOString() });
    await expect(pruneSentHistory({ retentionDays: 0, dir, now: NOW })).resolves.toEqual({
      deleted: 0,
      kept: 0,
    });
    expect(await fs.readdir(dir)).toEqual(['old.json']);
  });

  it('tolerates a missing directory', async () => {
    await expect(
      pruneSentHistory({ retentionDays: 90, dir: path.join(dir, 'absent'), now: NOW }),
    ).resolves.toEqual({ deleted: 0, kept: 0 });
  });
});
