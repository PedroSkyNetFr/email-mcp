import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readWatermark,
  resolveBaselineUid,
  selectCatchUp,
  watermarkFileName,
  writeWatermark,
} from './watcher-state.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-state-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('watermark persistence', () => {
  it('round-trips a watermark for an account and folder', async () => {
    await writeWatermark('work', 'INBOX', '42', 1200, dir);
    expect(await readWatermark('work', 'INBOX', dir)).toMatchObject({
      uidValidity: '42',
      lastSeenUid: 1200,
    });
  });

  it('keeps folders and accounts separate', async () => {
    await writeWatermark('work', 'INBOX', '42', 1200, dir);
    await writeWatermark('work', 'Archive', '42', 7, dir);
    await writeWatermark('personal', 'INBOX', '99', 3, dir);
    expect((await readWatermark('work', 'INBOX', dir))?.lastSeenUid).toBe(1200);
    expect((await readWatermark('work', 'Archive', dir))?.lastSeenUid).toBe(7);
    expect((await readWatermark('personal', 'INBOX', dir))?.lastSeenUid).toBe(3);
  });

  it('returns undefined for a folder never watched, or a corrupt file', async () => {
    expect(await readWatermark('work', 'Nope', dir)).toBeUndefined();
    await fs.writeFile(path.join(dir, watermarkFileName('work', 'Bad')), '{ tronqué');
    expect(await readWatermark('work', 'Bad', dir)).toBeUndefined();
  });

  it('overwrites atomically and leaves no temporary file behind', async () => {
    await writeWatermark('work', 'INBOX', '42', 1200, dir);
    await writeWatermark('work', 'INBOX', '42', 1300, dir);
    expect((await readWatermark('work', 'INBOX', dir))?.lastSeenUid).toBe(1300);
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files).toHaveLength(1);
  });

  it('builds Windows-safe, collision-free file names', () => {
    expect(watermarkFileName('work', 'INBOX/Sub:Dir*')).not.toMatch(/[\\/:*?"<>|]/);
    expect(watermarkFileName('a', 'b/c')).not.toBe(watermarkFileName('a', 'b_c'));
  });
});

describe('resolveBaselineUid', () => {
  const base = { uidValidity: '42', uidNext: 1001 };
  const noMemory = { lastSeenUid: 0, uidValidity: '' };

  it('resumes from the stored watermark after a restart', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemory: noMemory,
        stored: { uidValidity: '42', lastSeenUid: 900, updatedAt: 'x' },
      }),
    ).toEqual({ uid: 900, reason: 'resumed' });
  });

  it('baselines to uidNext-1 the first time a folder is watched', () => {
    expect(resolveBaselineUid({ ...base, inMemory: noMemory, stored: undefined })).toEqual({
      uid: 1000,
      reason: 'first-watch',
    });
  });

  it('ignores a watermark recorded under a different UIDVALIDITY', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemory: noMemory,
        stored: { uidValidity: '7', lastSeenUid: 900, updatedAt: 'x' },
      }),
    ).toEqual({ uid: 1000, reason: 'uidvalidity-changed' });
  });

  it('also ignores the in-memory watermark after a renumbering during a reconnect', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemory: { lastSeenUid: 950, uidValidity: '7' },
        stored: undefined,
      }),
    ).toEqual({ uid: 1000, reason: 'uidvalidity-changed' });
  });

  it('takes whichever of memory and file is further ahead', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemory: { lastSeenUid: 950, uidValidity: '42' },
        stored: { uidValidity: '42', lastSeenUid: 900, updatedAt: 'x' },
      }).uid,
    ).toBe(950);
    expect(
      resolveBaselineUid({
        ...base,
        inMemory: { lastSeenUid: 800, uidValidity: '42' },
        stored: { uidValidity: '42', lastSeenUid: 960, updatedAt: 'x' },
      }).uid,
    ).toBe(960);
  });

  it('falls back to the baseline when the watermark runs past uidNext', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemory: noMemory,
        stored: { uidValidity: '42', lastSeenUid: 99_999, updatedAt: 'x' },
      }),
    ).toEqual({ uid: 1000, reason: 'ahead-of-uidnext' });
  });

  it('handles an empty mailbox without returning a negative uid', () => {
    expect(
      resolveBaselineUid({ uidValidity: '42', uidNext: 1, inMemory: noMemory, stored: undefined })
        .uid,
    ).toBe(0);
  });
});

describe('selectCatchUp', () => {
  it('keeps everything under the limit, sorted', () => {
    expect(selectCatchUp([5, 3, 4], 50)).toEqual({ report: [3, 4, 5], skipped: 0 });
  });

  it('keeps only the most recent beyond the limit', () => {
    expect(selectCatchUp([1, 2, 3, 4, 5], 2)).toEqual({ report: [4, 5], skipped: 3 });
  });
});
