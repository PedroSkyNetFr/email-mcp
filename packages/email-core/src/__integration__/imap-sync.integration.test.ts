import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { inject } from 'vitest';
import ConnectionManager from '../connections/manager.js';
import type { ChangeBatch, SyncCursor } from '../contract/engine.types.js';
import { folderIdOf } from '../engines/imap/imap-reader.js';
import ImapSync from '../engines/imap/imap-sync.js';
import type { AccountConfig } from '../types/index.js';
import { DOVECOT_PASSWORD } from './dovecot.setup.js';

// "Another device" is a second IMAP session (`other`): it reads, flags and
// deletes mail the way a phone would, between two listChanges calls.

const freshUser = () => `s${randomUUID().slice(0, 8)}`;

function account(user: string): AccountConfig {
  const host = inject('dovecotHost');
  const port = inject('dovecotImapPort');
  return {
    name: user,
    email: `${user}@example.test`,
    username: user,
    password: DOVECOT_PASSWORD,
    imap: { host, port, tls: false, starttls: true, verifySsl: false },
    smtp: { host, port: 1, tls: false, starttls: false, verifySsl: false },
  };
}

async function otherDevice(user: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: inject('dovecotHost'),
    port: inject('dovecotImapPort'),
    secure: false,
    tls: { rejectUnauthorized: false },
    auth: { user, pass: DOVECOT_PASSWORD },
    logger: false,
  });
  await client.connect();
  return client;
}

const mail = (n: number) =>
  `From: a@example.test\r\nTo: b@example.test\r\nSubject: Message ${n}\r\n` +
  `Message-ID: <sync-${n}@example.test>\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n\r\nBody ${n}\r\n`;

const opened: { sync: ImapSync; connections: ConnectionManager; other?: ImapFlow }[] = [];

async function setup(messages: number, folder = 'INBOX') {
  const user = freshUser();
  const other = await otherDevice(user);
  if (folder !== 'INBOX') await other.mailboxCreate(folder);
  for (let n = 1; n <= messages; n++) await other.append(folder, mail(n));
  const connections = new ConnectionManager([account(user)]);
  const sync = new ImapSync(user, connections);
  opened.push({ sync, connections, other });
  return { sync, other, folderId: folderIdOf(folder) };
}

afterEach(async () => {
  for (const { sync, connections, other } of opened.splice(0)) {
    await sync.close();
    await connections.closeAll();
    await other?.logout().catch(() => other.close());
  }
});

/** Runs listChanges until complete, as a host does. */
async function drain(
  sync: ImapSync,
  folderId: string,
  cursor: SyncCursor | null,
  maxMessages = 50,
): Promise<{ batches: ChangeBatch[]; cursor: SyncCursor }> {
  const batches: ChangeBatch[] = [];
  let next = cursor;
  for (;;) {
    const batch = await sync.listChanges(folderId, next, { maxMessages });
    batches.push(batch);
    next = batch.nextCursor;
    if (batch.complete) return { batches, cursor: next };
  }
}

const subjects = (batch: ChangeBatch) =>
  batch.added.map((m) => /Subject: (.*)\r\n/.exec(m.raw?.toString() ?? '')?.[1]);

describe('ImapSync.listChanges against Dovecot', () => {
  it('delivers a first synchronisation in capped batches, oldest first, raw source included', async () => {
    const { sync, folderId } = await setup(5);

    const { batches } = await drain(sync, folderId, null, 2);

    expect(batches.map((b) => b.complete)).toEqual([false, false, true]);
    expect(batches.flatMap(subjects)).toEqual([
      'Message 1',
      'Message 2',
      'Message 3',
      'Message 4',
      'Message 5',
    ]);
    expect(batches[0]?.added[0]).toMatchObject({ messageIdHeader: 'sync-1@example.test' });
    expect(batches[0]?.fidelity).toEqual({ flags: 'exact', removals: 'exact' });
  });

  it('returns nothing, and the same cursor, for an untouched folder', async () => {
    const { sync, folderId } = await setup(2);
    const { cursor } = await drain(sync, folderId, null);

    const again = await sync.listChanges(folderId, cursor);

    expect(again).toMatchObject({ added: [], flagsChanged: [], removed: [], complete: true });
    expect(again.nextCursor).toBe(cursor);
  });

  it('reports only the new message, never the last known one again', async () => {
    const { sync, other, folderId } = await setup(3);
    const { cursor } = await drain(sync, folderId, null);
    await other.append('INBOX', mail(4));

    const batch = await sync.listChanges(folderId, cursor);
    // Nothing new: the STATUS shortcut answers. (The `UID n:*` trap, where the
    // last message comes back as new, is covered by the flag and removal tests,
    // whose change makes the engine search past the shortcut.)
    const quiet = await sync.listChanges(folderId, batch.nextCursor);

    expect(subjects(batch)).toEqual(['Message 4']);
    expect(quiet.added).toEqual([]);
  });

  it('reports a message read or flagged on another device', async () => {
    const { sync, other, folderId } = await setup(3);
    const first = await drain(sync, folderId, null);
    const ids = first.batches.flatMap((b) => b.added.map((m) => m.id));
    const lock = await other.getMailboxLock('INBOX');
    await other.messageFlagsAdd('2', ['\\Seen', '\\Flagged'], { uid: true });
    lock.release();

    const batch = await sync.listChanges(folderId, first.cursor);

    expect(batch.added).toEqual([]);
    expect(batch.flagsChanged).toEqual([
      {
        id: ids[1],
        flags: { seen: true, flagged: true, answered: false, draft: false, keywords: [] },
      },
    ]);
  });

  it('reports a message deleted on another device (QRESYNC)', async () => {
    const { sync, other, folderId } = await setup(3);
    const first = await drain(sync, folderId, null);
    const ids = first.batches.flatMap((b) => b.added.map((m) => m.id));
    const lock = await other.getMailboxLock('INBOX');
    await other.messageDelete('1', { uid: true });
    lock.release();

    const batch = await sync.listChanges(folderId, first.cursor);

    expect(batch.removed).toEqual([ids[0]]);
    expect(batch.added).toEqual([]);
  });

  it('does not lose a change made while a first synchronisation is still in progress', async () => {
    const { sync, other, folderId } = await setup(3);
    const firstBatch = await sync.listChanges(folderId, null, { maxMessages: 1 });
    // Message 1 is already with the host; the phone flags it before the end.
    const lock = await other.getMailboxLock('INBOX');
    await other.messageFlagsAdd('1', ['\\Flagged'], { uid: true });
    lock.release();

    const rest = await drain(sync, folderId, firstBatch.nextCursor, 1);
    const flagged = rest.batches.flatMap((b) => b.flagsChanged);

    expect(flagged.map((c) => c.id)).toContain(firstBatch.added[0]?.id);
    expect(flagged.find((c) => c.id === firstBatch.added[0]?.id)?.flags.flagged).toBe(true);
  });

  it('asks for a full resynchronisation when the folder was renumbered', async () => {
    const { sync, other, folderId } = await setup(2, 'Projets');
    const { cursor } = await drain(sync, folderId, null);
    // Deleting and recreating a folder gives it a new UIDVALIDITY.
    await other.mailboxDelete('Projets');
    await other.mailboxCreate('Projets');
    await other.append('Projets', mail(9));

    const batch = await sync.listChanges(folderId, cursor);
    const restart = await drain(sync, folderId, batch.nextCursor);

    expect(batch).toMatchObject({ reset: true, added: [], flagsChanged: [], removed: [] });
    expect(restart.batches.flatMap(subjects)).toEqual(['Message 9']);
  });

  it('caps a batch by the size of its sources, yet always delivers an oversized message', async () => {
    const user = freshUser();
    const other = await otherDevice(user);
    const padding = (kb: number) => `${'x'.repeat(76)}\r\n`.repeat(Math.ceil((kb * 1024) / 78));
    for (let n = 1; n <= 3; n++) await other.append('INBOX', `${mail(n)}${padding(40)}`);
    await other.append('INBOX', `${mail(4)}${padding(150)}`); // larger than the cap alone
    const connections = new ConnectionManager([account(user)]);
    const sync = new ImapSync(user, connections);
    opened.push({ sync, connections, other });
    const options = { maxBytes: 100 * 1024 };

    const sizes: string[][] = [];
    let cursor: SyncCursor | null = null;
    for (;;) {
      const batch = await sync.listChanges(folderIdOf('INBOX'), cursor, options);
      sizes.push(subjects(batch).map(String));
      cursor = batch.nextCursor;
      if (batch.complete) break;
    }

    expect(sizes).toEqual([['Message 1', 'Message 2'], ['Message 3'], ['Message 4']]);
  });

  it('leaves the source out on request', async () => {
    const { sync, folderId } = await setup(1);

    const batch = await sync.listChanges(folderId, null, { includeRaw: false });

    expect(batch.added).toHaveLength(1);
    expect(batch.added[0]?.raw).toBeUndefined();
  });

  it('refuses a cursor made for another folder', async () => {
    const { sync, other, folderId } = await setup(1);
    await other.mailboxCreate('Autre');
    const { cursor } = await drain(sync, folderId, null);

    await expect(sync.listChanges(folderIdOf('Autre'), cursor)).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
