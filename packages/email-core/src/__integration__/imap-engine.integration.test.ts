import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import { inject } from 'vitest';
import ConnectionManager from '../connections/manager.js';
import type { Folder, MailEngine, MessageSummary } from '../contract/engine.types.js';
import createImapEngine from '../engines/imap/imap-engine.js';
import { folderIdOf, messageIdOf } from '../engines/imap/imap-reader.js';
import RateLimiter from '../safety/rate-limiter.js';
import ImapService from '../services/imap.service.js';
import SmtpService from '../services/smtp.service.js';
import type { AccountConfig } from '../types/index.js';
import { DOVECOT_PASSWORD } from './dovecot.setup.js';

// IMAP is the real Dovecot; SMTP is a capturing transport (Dovecot has no
// relay), so a test sees exactly the bytes that would have gone out.

interface Sent {
  envelope: { from: string; to: string[] };
  raw: string;
}

class CapturingConnections extends ConnectionManager {
  readonly sent: Sent[] = [];

  override async getSmtpTransport(): Promise<Transporter> {
    const { sent } = this;
    return {
      sendMail: async (mail: { envelope: Sent['envelope']; raw: Buffer }) => {
        const raw = mail.raw.toString();
        sent.push({ envelope: mail.envelope, raw });
        return { messageId: /^Message-ID: (.*)$/im.exec(raw)?.[1]?.trim() };
      },
    } as unknown as Transporter;
  }
}

const freshUser = () => `e${randomUUID().slice(0, 8)}`;

function account(user: string): AccountConfig {
  const host = inject('dovecotHost');
  const port = inject('dovecotImapPort');
  return {
    name: user,
    email: `${user}@example.test`,
    fullName: 'Pierre Test',
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

const mail = (n: number, headers = '') =>
  `From: Alice <alice@example.test>\r\nTo: someone@example.test\r\nCc: carol@example.test\r\n` +
  `Subject: Message ${n}\r\nMessage-ID: <eng-${n}@example.test>\r\n${headers}` +
  `Date: Mon, 1${n % 10} Nov 2026 10:00:00 +0000\r\n` +
  'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
  `Body ${n}\r\n`;

const withPdf = (n: number) =>
  `From: Alice <alice@example.test>\r\nTo: someone@example.test\r\nSubject: Devis ${n}\r\n` +
  `Message-ID: <pdf-${n}@example.test>\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n` +
  'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
  '--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCi-joint.\r\n' +
  '--b\r\nContent-Type: application/pdf; name="devis.pdf"\r\n' +
  'Content-Disposition: attachment; filename="devis.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
  `${Buffer.from('%PDF-1.4 devis').toString('base64')}\r\n--b--\r\n`;

const open: { engine: MailEngine; connections: ConnectionManager; other: ImapFlow }[] = [];

async function setup(folders: string[] = []) {
  const user = freshUser();
  const other = await otherDevice(user);
  await Promise.all(folders.map(async (f) => other.mailboxCreate(f)));
  const connections = new CapturingConnections([account(user)]);
  const imap = new ImapService(connections);
  const engine = createImapEngine(
    user,
    connections,
    imap,
    new SmtpService(connections, new RateLimiter(100), imap),
  );
  open.push({ engine, connections, other });
  return { engine, other, connections };
}

afterEach(async () => {
  for (const { engine, connections, other } of open.splice(0)) {
    await engine.close();
    await connections.closeAll();
    await other.logout().catch(() => other.close());
  }
});

const inbox = folderIdOf('INBOX');
const subjects = (items: MessageSummary[]) => items.map((m) => m.subject);
const byName = (folders: Folder[], name: string) => folders.find((f) => f.name === name);

describe('waitForChange', () => {
  it('wakes up as soon as mail arrives in a watched folder', async () => {
    const { engine, other } = await setup(['Projets']);
    const started = Date.now();
    const waiting = engine.waitForChange({
      folderIds: [inbox, folderIdOf('Projets')],
      maxMs: 20_000,
    });
    await new Promise((r) => {
      setTimeout(r, 300); // let IDLE start
    });
    await other.append('Projets', mail(1));

    await expect(waiting).resolves.toBe('changed');
    // imapflow alone would wait 15 s before idling: the engine starts IDLE itself.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('times out, and can be aborted', async () => {
    const { engine } = await setup();
    const controller = new AbortController();

    await expect(engine.waitForChange({ folderIds: [inbox], maxMs: 300 })).resolves.toBe('timeout');
    const aborted = engine.waitForChange({
      folderIds: [inbox],
      maxMs: 20_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).resolves.toBe('aborted');
  });
});

describe('search and threads', () => {
  it('searches one folder with UID-anchored pages, and filters attachments client-side', async () => {
    const { engine, other } = await setup();
    for (let n = 1; n <= 3; n++) await other.append('INBOX', mail(n));
    await other.append('INBOX', withPdf(4));

    const first = await engine.search({ folderId: inbox, from: 'alice' }, { pageSize: 2 });
    const second = await engine.search({ folderId: inbox, from: 'alice' }, { page: first.next });
    const pdf = await engine.search({ folderId: inbox, hasAttachments: true });

    expect([...subjects(first.items), ...subjects(second.items)]).toEqual([
      'Devis 4',
      'Message 3',
      'Message 2',
      'Message 1',
    ]);
    expect(subjects(pdf.items)).toEqual(['Devis 4']);
    await expect(
      engine.search({ folderId: inbox, subject: 'other' }, { page: first.next }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('searches every folder but junk and trash, newest first', async () => {
    const { engine, other } = await setup(['Projets', 'Junk']);
    await other.append('INBOX', mail(1), [], new Date('2026-11-01T10:00:00Z'));
    await other.append('Projets', mail(2), [], new Date('2026-11-05T10:00:00Z'));
    await other.append('Junk', mail(3), [], new Date('2026-11-09T10:00:00Z'));

    const found = await engine.search({ subject: 'Message' });

    expect(subjects(found.items)).toEqual(['Message 2', 'Message 1']);
  });

  it('rebuilds a conversation, oldest first', async () => {
    const { engine, other } = await setup();
    await other.append('INBOX', mail(1));
    await other.append(
      'INBOX',
      mail(2, 'In-Reply-To: <eng-1@example.test>\r\nReferences: <eng-1@example.test>\r\n'),
    );
    const { items } = await engine.listMessages(inbox);
    const reply = items.find((m) => m.subject === 'Message 2');
    if (!reply) throw new Error('seeded reply missing');

    const thread = await engine.getThread(reply.id);

    expect(subjects(thread)).toEqual(['Message 1', 'Message 2']);
  });
});

describe('changes', () => {
  it('sets flags and keywords, and refuses a stale id without touching anything', async () => {
    const { engine, other } = await setup();
    await other.append('INBOX', mail(1));
    const [message] = (await engine.listMessages(inbox)).items;
    if (!message) throw new Error('seeded message missing');

    const done = await engine.setFlags([message.id], {
      seen: true,
      flagged: true,
      addKeywords: ['Chantier'],
    });
    const stale = await engine.setFlags([messageIdOf('INBOX', '999999', 1)], { seen: false });
    const [after] = (await engine.listMessages(inbox)).items;

    expect(done).toEqual({ succeeded: [message.id], failed: [] });
    expect(stale.failed[0]?.error).toMatch(/stale-id/);
    expect(after?.flags).toMatchObject({ seen: true, flagged: true, keywords: ['Chantier'] });
  });

  it('moves with the new id, copies, and deletes to the trash or for good', async () => {
    const { engine, other } = await setup(['Projets', 'Trash']);
    for (let n = 1; n <= 3; n++) await other.append('INBOX', mail(n));
    const [m3, m2, m1] = (await engine.listMessages(inbox)).items;
    if (!m1 || !m2 || !m3) throw new Error('seeded messages missing');

    const moved = await engine.move([m1.id], folderIdOf('Projets'));
    const copied = await engine.copy([m2.id], folderIdOf('Projets'));
    const trashed = await engine.delete([m3.id]);
    const newId = moved.moved[0]?.to;
    if (!newId) throw new Error('no new id');

    await expect(engine.getMessage(newId)).resolves.toMatchObject({ subject: 'Message 1' });
    await expect(engine.getMessage(m1.id)).rejects.toMatchObject({ code: 'not-found' });
    expect(copied.moved[0]?.to).toBeDefined();
    expect(trashed.succeeded).toEqual([m3.id]);
    expect(subjects((await engine.listMessages(folderIdOf('Trash'))).items)).toEqual(['Message 3']);
    expect(subjects((await engine.listMessages(inbox)).items)).toEqual(['Message 2']);

    const [inTrash] = (await engine.listMessages(folderIdOf('Trash'))).items;
    if (!inTrash) throw new Error('trash empty');
    await engine.delete([inTrash.id]); // already in the trash: for good
    expect((await engine.listMessages(folderIdOf('Trash'))).items).toEqual([]);
  });

  it('creates, renames and deletes folders, and refuses a name holding the separator', async () => {
    const { engine } = await setup(['Clients']);
    const clients = byName(await engine.listFolders(), 'Clients');
    if (!clients) throw new Error('parent missing');

    const created = await engine.createFolder('Dupont', clients.id);
    const renamed = await engine.renameFolder(created.id, 'Dupont SA');
    await engine.deleteFolder(renamed.id);

    expect(created.path).toEqual(['Clients', 'Dupont']);
    expect(renamed.path).toEqual(['Clients', 'Dupont SA']);
    expect(byName(await engine.listFolders(), 'Dupont SA')).toBeUndefined();
    await expect(engine.createFolder('a/b')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('sending', () => {
  it('sends, keeps the Bcc in the Sent copy only, same Message-ID', async () => {
    const { engine, connections } = await setup(['Sent']);

    const result = await engine.send({
      to: ['bob@example.test'],
      bcc: ['boss@example.test'],
      subject: 'Planning',
      text: 'Bonjour',
    });
    const [sent] = connections.sent;
    const [copy] = (await engine.listMessages(folderIdOf('Sent'))).items;
    if (!sent || !copy) throw new Error('nothing sent or filed');
    const stored = (await engine.getRaw(copy.id)).toString();

    expect(result.sentCopy).toBe('filed');
    expect(sent.envelope.to).toEqual(['bob@example.test', 'boss@example.test']);
    expect(sent.raw).not.toContain('boss@example.test');
    expect(stored).toMatch(/^Bcc: boss@example\.test\r?$/im);
    expect(copy.messageIdHeader).toBe(result.messageIdHeader);
  });

  it('prepares and sends a reply: recipients, quote, threading, original marked answered', async () => {
    const { engine, other, connections } = await setup(['Sent']);
    await other.append('INBOX', mail(1, 'Reply-To: alice.pro@example.test\r\n'));
    const [original] = (await engine.listMessages(inbox)).items;
    if (!original) throw new Error('seeded message missing');

    const draft = await engine.prepareReply(original.id, { all: true });
    await engine.send({ ...draft, text: `D'accord.\n${draft.text}`, html: undefined });
    const [sent] = connections.sent;
    const [after] = (await engine.listMessages(inbox)).items;

    expect(draft).toMatchObject({
      to: ['alice.pro@example.test', 'someone@example.test'],
      cc: ['carol@example.test'],
      subject: 'Re: Message 1',
    });
    expect(draft.text).toContain('Body 1');
    expect(sent?.raw).toMatch(/^In-Reply-To: <eng-1@example\.test>\r?$/im);
    expect(after?.flags.answered).toBe(true);
  });

  it('prepares a forward with the original attachment, and marks the original $Forwarded', async () => {
    const { engine, other, connections } = await setup(['Sent']);
    await other.append('INBOX', withPdf(1));
    const [original] = (await engine.listMessages(inbox)).items;
    if (!original) throw new Error('seeded message missing');

    const draft = await engine.prepareForward(original.id);
    await engine.send({ ...draft, to: ['dave@example.test'] });
    const [sent] = connections.sent;
    const [after] = (await engine.listMessages(inbox)).items;

    expect(draft.subject).toMatch(/^(Fwd|TR|Tr) ?: Devis 1$/);
    expect(draft.attachments?.map((a) => a.filename)).toEqual(['devis.pdf']);
    expect(sent?.raw).toContain(Buffer.from('%PDF-1.4 devis').toString('base64'));
    expect(after?.flags.keywords).toContain('$Forwarded');
  });

  it('saves, replaces and sends a draft', async () => {
    const { engine, connections } = await setup(['Drafts', 'Sent']);
    const first = await engine.saveDraft({ to: ['bob@example.test'], subject: 'v1', text: 'un' });
    const second = await engine.saveDraft(
      { to: ['bob@example.test'], bcc: ['boss@example.test'], subject: 'v2', text: 'deux' },
      first,
    );

    const drafts = (await engine.listMessages(folderIdOf('Drafts'))).items;
    const result = await engine.sendDraft(second);
    const [sent] = connections.sent;
    const [copy] = (await engine.listMessages(folderIdOf('Sent'))).items;
    if (!copy) throw new Error('no sent copy');

    expect(subjects(drafts)).toEqual(['v2']);
    expect(result.sentCopy).toBe('filed');
    expect(sent?.envelope.to).toEqual(['bob@example.test', 'boss@example.test']);
    expect(sent?.raw).not.toContain('boss@example.test');
    expect((await engine.getRaw(copy.id)).toString()).toMatch(/^Bcc: boss@example\.test/im);
  });

  it('refuses a message without any recipient', async () => {
    const { engine } = await setup();

    await expect(engine.send({ to: [], subject: 'x', text: 'y' })).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});
