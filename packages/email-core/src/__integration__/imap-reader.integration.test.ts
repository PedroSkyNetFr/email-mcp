import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { inject } from 'vitest';
import ConnectionManager from '../connections/manager.js';
import { MailError } from '../contract/errors.js';
import ImapReader, { folderIdOf, messageIdOf } from '../engines/imap/imap-reader.js';
import ImapService from '../services/imap.service.js';
import type { AccountConfig } from '../types/index.js';
import { DOVECOT_PASSWORD } from './dovecot.setup.js';

// Every test logs in as a fresh user: Dovecot creates an empty mailbox for it,
// so no test sees another one's messages.

function account(user: string, overrides: Partial<AccountConfig> = {}): AccountConfig {
  const host = inject('dovecotHost');
  const port = inject('dovecotImapPort');
  return {
    name: user,
    email: `${user}@example.test`,
    username: user,
    password: DOVECOT_PASSWORD,
    imap: { host, port, tls: false, starttls: true, verifySsl: false },
    smtp: { host, port: 1, tls: false, starttls: false, verifySsl: false },
    ...overrides,
  };
}

async function seedClient(user: string): Promise<ImapFlow> {
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

const message = (n: number, extra = '') =>
  [
    `From: Sender ${n} <sender${n}@example.test>`,
    'To: someone@example.test',
    `Subject: Message ${n}`,
    `Message-ID: <msg-${n}@example.test>`,
    'Date: Mon, 16 Nov 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    extra,
  ]
    .filter(Boolean)
    .join('\r\n');

const plain = (n: number) =>
  `${message(n, 'Content-Type: text/plain; charset=utf-8')}\r\n\r\nBody of message ${n}\r\n`;

const withAttachment = (n: number) =>
  `${message(n, 'Content-Type: multipart/mixed; boundary="b"')}\r\n\r\n` +
  '--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached.\r\n' +
  '--b\r\nContent-Type: application/pdf; name="devis.pdf"\r\n' +
  'Content-Disposition: attachment; filename="devis.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
  `${Buffer.from('%PDF-1.4 fake').toString('base64')}\r\n--b--\r\n`;

let connections: ConnectionManager | undefined;

function reader(user: string, overrides: Partial<AccountConfig> = {}): ImapReader {
  connections = new ConnectionManager([account(user, overrides)]);
  return new ImapReader(user, connections, new ImapService(connections));
}

afterEach(async () => {
  await connections?.closeAll();
  connections = undefined;
});

const freshUser = () => `u${randomUUID().slice(0, 8)}`;

describe('ImapReader against Dovecot', () => {
  it('pages by UID: mail arriving while scrolling neither repeats nor hides a message', async () => {
    const user = freshUser();
    const seed = await seedClient(user);
    for (let n = 1; n <= 5; n++) await seed.append('INBOX', plain(n));
    const engine = reader(user);
    const inbox = folderIdOf('INBOX');

    const first = await engine.listMessages(inbox, { pageSize: 2 });
    await seed.append('INBOX', plain(6)); // arrives between two pages
    const second = await engine.listMessages(inbox, { pageSize: 2, page: first.next });
    const third = await engine.listMessages(inbox, { pageSize: 2, page: second.next });
    await seed.logout();

    const subjects = [...first.items, ...second.items, ...third.items].map((m) => m.subject);
    expect(subjects).toEqual(['Message 5', 'Message 4', 'Message 3', 'Message 2', 'Message 1']);
    expect(third.next).toBeUndefined();
  });

  it('maps envelope and flags to the neutral contract, and listing changes no flag', async () => {
    const user = freshUser();
    const seed = await seedClient(user);
    await seed.append('INBOX', plain(1), ['\\Flagged', 'Facture']);
    await seed.logout();
    const engine = reader(user);

    const [summary] = (await engine.listMessages(folderIdOf('INBOX'))).items;
    const [again] = (await engine.listMessages(folderIdOf('INBOX'))).items;

    expect(summary).toMatchObject({
      subject: 'Message 1',
      messageIdHeader: 'msg-1@example.test',
      from: { name: 'Sender 1', address: 'sender1@example.test' },
      flags: { seen: false, flagged: true, answered: false, draft: false, keywords: ['Facture'] },
      hasAttachments: false,
    });
    expect(again?.flags.seen).toBe(false);
  });

  it('reads a message, its raw source and an attachment by partId', async () => {
    const user = freshUser();
    const seed = await seedClient(user);
    const raw = withAttachment(1);
    await seed.append('INBOX', raw);
    await seed.logout();
    const engine = reader(user);
    const [summary] = (await engine.listMessages(folderIdOf('INBOX'))).items;
    if (!summary) throw new Error('seeded message missing');

    const full = await engine.getMessage(summary.id);
    const source = await engine.getRaw(summary.id);
    const pdf = full.attachments.find((a) => a.filename === 'devis.pdf');
    if (!pdf) throw new Error('attachment missing');
    const file = await engine.getAttachment(summary.id, pdf.partId);

    expect(full.text).toContain('See attached.');
    expect(full.hasAttachments).toBe(true);
    expect(source.toString()).toBe(raw);
    expect(file).toMatchObject({ filename: 'devis.pdf', contentType: 'application/pdf' });
    expect(file.content.toString()).toBe('%PDF-1.4 fake');
  });

  it('refuses an id made stale by a renumbering instead of reading another message', async () => {
    const user = freshUser();
    const seed = await seedClient(user);
    await seed.append('INBOX', plain(1));
    await seed.logout();
    const engine = reader(user);
    const [summary] = (await engine.listMessages(folderIdOf('INBOX'))).items;
    if (!summary) throw new Error('seeded message missing');
    // Same folder, same UID, but made under another UIDVALIDITY.
    const stale = messageIdOf('INBOX', '999999', 1);

    await expect(engine.getMessage(stale)).rejects.toMatchObject({ code: 'stale-id' });
    await expect(engine.getMessage(summary.id)).resolves.toMatchObject({ subject: 'Message 1' });
  });

  it('rejects a folder id passed as a message id, before reaching the server', async () => {
    const engine = reader(freshUser());

    await expect(engine.getMessage(folderIdOf('INBOX'))).rejects.toBeInstanceOf(MailError);
    await expect(engine.getMessage(folderIdOf('INBOX'))).rejects.toThrow(/got a folder id/);
  });

  it('reports a missing message as not-found', async () => {
    const engine = reader(freshUser());
    const inbox = await engine.listMessages(folderIdOf('INBOX'));
    expect(inbox.items).toEqual([]);
    const { uidValidity } = await (async () => {
      const seed = await seedClient(engine.account);
      const status = await seed.status('INBOX', { uidValidity: true });
      await seed.logout();
      return { uidValidity: String(status.uidValidity) };
    })();

    await expect(engine.getMessage(messageIdOf('INBOX', uidValidity, 4242))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('flags a sent folder that holds less mail than "Éléments envoyés" as disputed', async () => {
    const user = freshUser();
    const seed = await seedClient(user);
    await seed.mailboxCreate('Sent');
    await seed.mailboxCreate('Éléments envoyés');
    await seed.append('Sent', plain(1));
    for (let n = 2; n <= 4; n++) await seed.append('Éléments envoyés', plain(n));
    await seed.logout();

    const folders = await reader(user).listFolders();
    const sent = folders.find((f) => f.role === 'sent');
    const envoyes = folders.find((f) => f.name === 'Éléments envoyés');

    expect(folders.find((f) => f.name === 'INBOX')).toMatchObject({ role: 'inbox' });
    expect(sent?.name).toBe('Sent');
    expect(sent?.roleCandidates).toEqual([envoyes?.id]);
  });

  it('honours sent_folder from the config, and refuses one that does not exist', async () => {
    const user = freshUser();
    const seed = await seedClient(user);
    await seed.mailboxCreate('Sent');
    await seed.mailboxCreate('Éléments envoyés');
    await seed.logout();

    const folders = await reader(user, { sentFolder: 'Éléments envoyés' }).listFolders();
    await connections?.closeAll();
    const wrong = reader(user, { sentFolder: 'Elements envoyes' }); // no accents: another folder

    expect(folders.filter((f) => f.role === 'sent')).toMatchObject([
      { name: 'Éléments envoyés', roleSource: 'config' },
    ]);
    await expect(wrong.listFolders()).rejects.toMatchObject({ code: 'not-found' });
  });

  it('reports what the server allows', async () => {
    const caps = await reader(freshUser()).capabilities();

    expect(caps).toMatchObject({
      engine: 'imap',
      sync: { flags: 'exact', removals: 'exact' },
      realtime: 'push',
      serverMove: true,
    });
  });
});
