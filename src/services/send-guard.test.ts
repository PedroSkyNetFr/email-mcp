/**
 * Garde anti-doublon : empreinte, fenêtre, clé d'idempotence, échec qui ne
 * bloque pas, persistance entre instances, purge, écriture atomique.
 */

/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SendGuard, { SEND_GUARD_RETENTION_MS, sendFingerprint } from './send-guard.js';

const base = {
  kind: 'send' as const,
  account: 'perso',
  to: ['Alice@Example.com', 'bob@example.com'],
  subject: 'Devis',
  body: 'Bonjour, voici le devis.',
};

describe('sendFingerprint', () => {
  it('ignores recipient order, case and surrounding blanks', () => {
    expect(sendFingerprint(base)).toBe(
      sendFingerprint({ ...base, to: [' bob@example.com', 'alice@example.com '] }),
    );
  });

  it('changes with the body, the subject, the account or an attachment byte', () => {
    const ref = sendFingerprint(base);
    expect(sendFingerprint({ ...base, body: 'Bonjour.' })).not.toBe(ref);
    expect(sendFingerprint({ ...base, subject: 'Devis v2' })).not.toBe(ref);
    expect(sendFingerprint({ ...base, account: 'pro' })).not.toBe(ref);
    const withPdf = { ...base, attachments: [{ filename: 'd.pdf', content: Buffer.from('A') }] };
    expect(sendFingerprint(withPdf)).not.toBe(ref);
    expect(
      sendFingerprint({ ...base, attachments: [{ filename: 'd.pdf', content: Buffer.from('B') }] }),
    ).not.toBe(sendFingerprint(withPdf));
  });

  it('keeps to / cc / bcc apart and a reply apart from a forward of the same original', () => {
    expect(sendFingerprint({ ...base, to: [], cc: base.to })).not.toBe(sendFingerprint(base));
    const reply = sendFingerprint({ kind: 'reply', account: 'perso', emailId: '42', body: 'ok' });
    const forward = sendFingerprint({
      kind: 'forward',
      account: 'perso',
      emailId: '42',
      body: 'ok',
    });
    expect(reply).not.toBe(forward);
    expect(
      sendFingerprint({ kind: 'reply', account: 'perso', emailId: '43', body: 'ok' }),
    ).not.toBe(reply);
  });
});

describe('SendGuard', () => {
  let dir: string;
  let file: string;
  let clock: number;
  const now = () => clock;
  const make = (windowMinutes = 10) => new SendGuard({ windowMinutes, filePath: file, now });
  const fp = sendFingerprint(base);
  const req = { account: 'perso', tool: 'send_email', fingerprint: fp };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'send-guard-'));
    file = join(dir, 'state', 'send-guard.json');
    clock = Date.parse('2026-11-16T09:00:00.000Z');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function sendOnce(guard: SendGuard, extra: Record<string, unknown> = {}) {
    const decision = await guard.check({ ...req, ...extra });
    if (decision.action !== 'send') return decision;
    await guard.commit(decision.ticket, '<m1@example.com>', 'sent');
    return decision;
  }

  it('lets a first send through, then refuses the same fingerprint inside the window', async () => {
    const guard = make();
    expect((await sendOnce(guard)).action).toBe('send');

    clock += 9 * 60_000;
    const second = await guard.check(req);
    expect(second).toMatchObject({ action: 'refuse', reason: 'duplicate' });
    expect(second.action === 'refuse' && second.record?.messageId).toBe('<m1@example.com>');
  });

  it('lets it through again once the window has passed', async () => {
    const guard = make();
    await sendOnce(guard);
    clock += 11 * 60_000;
    expect((await guard.check(req)).action).toBe('send');
  });

  it('honours allow_duplicate', async () => {
    const guard = make();
    await sendOnce(guard);
    expect((await guard.check({ ...req, allowDuplicate: true })).action).toBe('send');
  });

  it('does not block a retry after a clean failure (nothing recorded)', async () => {
    const guard = make();
    const first = await guard.check(req);
    if (first.action !== 'send') throw new Error('expected send');
    guard.release(first.ticket);

    expect((await guard.check(req)).action).toBe('send');
    expect(existsSync(file)).toBe(false);
  });

  it('records an uncertain outcome so that a blind resend is refused', async () => {
    const guard = make();
    const first = await guard.check(req);
    if (first.action !== 'send') throw new Error('expected send');
    await guard.commit(first.ticket, '', 'uncertain');

    const again = await guard.check(req);
    expect(again).toMatchObject({ action: 'refuse', record: { status: 'uncertain' } });
  });

  it('replays the first result for the same idempotency_key, refuses it for another message', async () => {
    const guard = make();
    await sendOnce(guard, { idempotencyKey: 'k-1' });

    // Même clé, même message : rejeu (même avec allow_duplicate).
    expect(
      await guard.check({ ...req, idempotencyKey: 'k-1', allowDuplicate: true }),
    ).toMatchObject({ action: 'replay', record: { messageId: '<m1@example.com>' } });

    // Même clé, autre message : refus.
    const other = sendFingerprint({ ...base, body: 'autre' });
    expect(await guard.check({ ...req, fingerprint: other, idempotencyKey: 'k-1' })).toMatchObject({
      action: 'refuse',
      reason: 'key-mismatch',
    });

    // La clé est propre au compte.
    expect(
      (await guard.check({ ...req, account: 'pro', fingerprint: other, idempotencyKey: 'k-1' }))
        .action,
    ).toBe('send');
  });

  it('refuses a concurrent identical send while the first is in flight', async () => {
    const guard = make();
    const first = await guard.check(req);
    expect(first.action).toBe('send');
    expect(await guard.check(req)).toMatchObject({ action: 'refuse', reason: 'in-flight' });
  });

  it('persists across instances (server restart) and stores no mail content', async () => {
    await sendOnce(make(), { idempotencyKey: 'secret-key' });

    // Nouvelle instance = redémarrage du serveur par Claude Desktop.
    expect((await make().check(req)).action).toBe('refuse');

    const raw = readFileSync(file, 'utf-8');
    expect(raw).not.toContain('Devis');
    expect(raw).not.toContain('alice');
    expect(raw).not.toContain('secret-key');
    expect(JSON.parse(raw).entries[0]).toMatchObject({ fingerprint: fp, status: 'sent' });
  });

  it('merges entries written by another instance instead of overwriting them', async () => {
    const a = make();
    const b = make();
    await sendOnce(a);
    const other = sendFingerprint({ ...base, body: 'deuxième' });
    const d = await b.check({ ...req, fingerprint: other });
    if (d.action !== 'send') throw new Error('expected send');
    await b.commit(d.ticket, '<m2@x>', 'sent');

    expect(JSON.parse(readFileSync(file, 'utf-8')).entries).toHaveLength(2);
  });

  it('purges entries older than 24 h on the next write, and leaves no temp file', async () => {
    const guard = make();
    await sendOnce(guard);
    clock += SEND_GUARD_RETENTION_MS + 60_000;
    await sendOnce(guard, { fingerprint: sendFingerprint({ ...base, body: 'plus tard' }) });

    const { entries } = JSON.parse(readFileSync(file, 'utf-8'));
    expect(entries).toHaveLength(1);
    expect(readdirSync(join(dir, 'state'))).toEqual(['send-guard.json']);
  });

  it('treats a corrupted state file as empty rather than blocking every send', async () => {
    await sendOnce(make());
    writeFileSync(file, '{ not json');
    expect((await make().check(req)).action).toBe('send');
  });

  it('window 0 disables the guard entirely (no file written)', async () => {
    const guard = make(0);
    await sendOnce(guard);
    expect((await guard.check(req)).action).toBe('send');
    expect(existsSync(file)).toBe(false);
  });
});
