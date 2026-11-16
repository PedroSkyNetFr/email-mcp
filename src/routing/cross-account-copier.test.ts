/**
 * CrossAccountCopier — copie inter-comptes non destructive.
 *
 * Ce qui est épinglé : la source n'est jamais écrite (aucun MOVE / DELETE /
 * STORE / EXPUNGE, verrou en lecture seule), drapeaux et date passent à
 * l'APPEND, le dédoublonnage évite un second APPEND, le journal Postgres est
 * facultatif, une source Graph est lue en MIME brut et une destination Graph
 * est refusée explicitement.
 */

import type ConnectionManager from '@pedroskynet/email-core/connections/manager.js';
import { GraphError } from '@pedroskynet/email-core/services/graph/graph.client.js';
import type { IMailService } from '@pedroskynet/email-core/services/mail-service.types.js';
import { CrossAccountCopier } from './cross-account-copier.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';
import { MoveLogRepository } from './log-repository.js';

const RAW = Buffer.from(
  'Message-ID: <m1@example.com>\r\nFrom: Alice <alice@example.com>\r\nSubject: Devis\r\n\r\nCorps\r\n',
);

function imapClient(name: string) {
  const release = vi.fn();
  return {
    name,
    release,
    mailbox: { permanentFlags: new Set(['\\*']) },
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    fetchOne: vi.fn().mockResolvedValue({
      uid: 42,
      source: RAW,
      flags: new Set(['\\Seen', '\\Flagged', '\\Recent']),
      internalDate: new Date('2026-01-02T03:04:05Z'),
      envelope: {
        messageId: '<m1@example.com>',
        subject: 'Devis',
        from: [{ name: 'Alice', address: 'alice@example.com' }],
      },
    }),
    search: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue({ uid: 900 }),
    messageMove: vi.fn(),
    messageCopy: vi.fn(),
    messageDelete: vi.fn(),
    messageFlagsAdd: vi.fn(),
    messageFlagsRemove: vi.fn(),
    expunge: vi.fn(),
    list: vi.fn(),
  };
}

type FakeClient = ReturnType<typeof imapClient>;

function setup(options: { graph?: string[]; logRepo?: MoveLogRepository } = {}) {
  const clients: Record<string, FakeClient> = {
    perso: imapClient('perso'),
    pro: imapClient('pro'),
    work: imapClient('work'),
  };
  const connections = {
    getAccountNames: () => Object.keys(clients),
    getImapClient: vi.fn(async (name: string) => clients[name]),
  } as unknown as ConnectionManager;
  const mailService = {
    getEmailFlags: vi.fn().mockResolvedValue({
      seen: true,
      flagged: false,
      answered: false,
      labels: [],
      subject: 'Devis',
      from: 'alice@example.com',
      date: '2026-01-02T03:04:05Z',
    }),
    getEmailRaw: vi.fn().mockResolvedValue(RAW),
  } as unknown as IMailService;
  const graph = new Set(options.graph ?? []);
  // Dépôt réel sans URL : chaque écriture lève database_misconfigured.
  const logRepo = options.logRepo ?? new MoveLogRepository(undefined);
  const copier = new CrossAccountCopier(connections, mailService, (n) => graph.has(n), logRepo);
  return { copier, clients, connections, mailService };
}

const base = {
  sourceAccount: 'perso',
  sourceMailbox: 'INBOX',
  emailId: '42',
  destAccount: 'pro',
  destMailbox: 'INBOX',
};

function expectSourceUntouched(client: FakeClient): void {
  expect(client.messageMove).not.toHaveBeenCalled();
  expect(client.messageCopy).not.toHaveBeenCalled();
  expect(client.messageDelete).not.toHaveBeenCalled();
  expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  expect(client.messageFlagsRemove).not.toHaveBeenCalled();
  expect(client.expunge).not.toHaveBeenCalled();
}

describe('CrossAccountCopier — IMAP → IMAP', () => {
  it('appends the raw source with flags and date, source read-only and untouched', async () => {
    const { copier, clients } = setup();

    const result = await copier.copyOne(base);

    expect(result).toMatchObject({
      success: true,
      status: 'success',
      dest_uid: 900,
      message_id: '<m1@example.com>',
      source_cleanup: null,
      copy_log_id: null,
    });
    expect(clients.perso.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    // \Recent est retiré : seul le serveur peut le poser.
    expect(clients.pro.append).toHaveBeenCalledWith(
      'INBOX',
      RAW,
      ['\\Seen', '\\Flagged'],
      new Date('2026-01-02T03:04:05Z'),
    );
    // Pas de $Routed sur une copie.
    expect(clients.pro.messageFlagsAdd).not.toHaveBeenCalled();
    expectSourceUntouched(clients.perso);
    expect(clients.perso.release).toHaveBeenCalled();
    expect(clients.pro.release).toHaveBeenCalled();
  });

  it('works with no database: the copy succeeds with an audit_log_skipped warning', async () => {
    const { copier } = setup();

    const result = await copier.copyOne(base);

    expect(result.success && result.warnings.map((w) => w.kind)).toEqual([
      WARNING_KIND.AUDIT_LOG_SKIPPED,
    ]);
  });

  it('records the copy when the journal accepts it', async () => {
    const logRepo = { logCopy: vi.fn().mockResolvedValue(7) } as unknown as MoveLogRepository;
    const { copier } = setup({ logRepo });

    const result = await copier.copyOne(base);

    expect(result).toMatchObject({ success: true, copy_log_id: 7, warnings: [] });
    expect(logRepo.logCopy).toHaveBeenCalledWith(
      expect.objectContaining({ source_uid: 42, dest_uid: 900, message_id: '<m1@example.com>' }),
    );
  });

  it('dedupes by Message-ID without a second APPEND', async () => {
    const { copier, clients } = setup();
    clients.pro.search.mockResolvedValue([555]);

    const result = await copier.copyOne(base);

    expect(result).toMatchObject({ success: true, status: 'duplicate_skipped', dest_uid: 555 });
    expect(clients.pro.append).not.toHaveBeenCalled();
  });

  it('reports a missing source without touching the destination', async () => {
    const { copier, clients } = setup();
    clients.perso.fetchOne.mockResolvedValue(null);

    const result = await copier.copyOne(base);

    expect(result).toMatchObject({ success: false, error_kind: ERROR_KIND.SOURCE_NOT_FOUND });
    expect(clients.pro.append).not.toHaveBeenCalled();
  });

  it('maps a failed APPEND to append_failed and releases the lock', async () => {
    const { copier, clients } = setup();
    clients.pro.append.mockRejectedValue(new Error('NO [TRYCREATE] no such mailbox'));

    const result = await copier.copyOne(base);

    expect(result).toMatchObject({ success: false, error_kind: ERROR_KIND.APPEND_FAILED });
    expect(clients.pro.release).toHaveBeenCalled();
    expectSourceUntouched(clients.perso);
  });

  it('copyMany returns one result per id, in order', async () => {
    const { copier } = setup();

    const results = await copier.copyMany([base, { ...base, emailId: 'abc' }]);

    expect(results.map((r) => r.success)).toEqual([true, false]);
  });
});

describe('CrossAccountCopier — guards', () => {
  it.each([
    [{ emailId: 'abc' }, ERROR_KIND.INVALID_EMAIL_ID],
    [{ emailId: '0' }, ERROR_KIND.INVALID_EMAIL_ID],
    [{ sourceAccount: 'nope' }, ERROR_KIND.SOURCE_NOT_FOUND],
    [{ destAccount: 'nope' }, ERROR_KIND.DEST_ACCOUNT_INVALID],
    [{ destAccount: 'perso' }, ERROR_KIND.SAME_ACCOUNT_COPY],
  ])('refuses %o with %s before any IMAP call', async (override, kind) => {
    const { copier, connections } = setup();

    const result = await copier.copyOne({ ...base, ...override });

    expect(result).toMatchObject({ success: false, error_kind: kind });
    expect(connections.getImapClient).not.toHaveBeenCalled();
  });

  it('refuses a Graph destination explicitly, without reading the source', async () => {
    const { copier, connections } = setup({ graph: ['work'] });

    const result = await copier.copyOne({ ...base, destAccount: 'work' });

    expect(result).toMatchObject({
      success: false,
      error_kind: ERROR_KIND.DEST_BACKEND_UNSUPPORTED,
    });
    expect(!result.success && result.error_message).toMatch(/only import a raw message as a DRAFT/);
    expect(connections.getImapClient).not.toHaveBeenCalled();
  });
});

describe('CrossAccountCopier — Graph source', () => {
  const graphBase = { ...base, sourceAccount: 'work', emailId: 'AAMkAD=' };

  it('reads the raw MIME through the router and appends it with seen/flag and received date', async () => {
    const { copier, clients, mailService } = setup({ graph: ['work'] });

    const result = await copier.copyOne(graphBase);

    expect(mailService.getEmailRaw).toHaveBeenCalledWith('work', 'AAMkAD=', 'INBOX');
    expect(clients.work.getMailboxLock).not.toHaveBeenCalled();
    expect(clients.pro.search).toHaveBeenCalledWith(
      { header: { 'message-id': '<m1@example.com>' } },
      { uid: true },
    );
    expect(clients.pro.append).toHaveBeenCalledWith(
      'INBOX',
      RAW,
      ['\\Seen'],
      new Date('2026-01-02T03:04:05Z'),
    );
    expect(result).toMatchObject({
      success: true,
      source_id: 'AAMkAD=',
      message_id: '<m1@example.com>',
    });
  });

  it('logs a Graph source with source_uid 0 (opaque id)', async () => {
    const logRepo = { logCopy: vi.fn().mockResolvedValue(8) } as unknown as MoveLogRepository;
    const { copier } = setup({ graph: ['work'], logRepo });

    await copier.copyOne(graphBase);

    expect(logRepo.logCopy).toHaveBeenCalledWith(expect.objectContaining({ source_uid: 0 }));
  });

  it('maps a Graph 404 to source_not_found', async () => {
    const { copier, mailService } = setup({ graph: ['work'] });
    vi.mocked(mailService.getEmailFlags).mockRejectedValue(
      new GraphError('Graph GET /me/messages/x failed (404): not found', 404, ''),
    );

    const result = await copier.copyOne(graphBase);

    expect(result).toMatchObject({ success: false, error_kind: ERROR_KIND.SOURCE_NOT_FOUND });
  });
});

describe('MoveError passthrough', () => {
  it('keeps a typed kind thrown by the journal as a warning, not a failure', async () => {
    const logRepo = {
      logCopy: vi
        .fn()
        .mockRejectedValue(new MoveError(ERROR_KIND.DATABASE_UNAVAILABLE, 'Postgres unreachable')),
    } as unknown as MoveLogRepository;
    const { copier } = setup({ logRepo });

    const result = await copier.copyOne(base);

    expect(result.success).toBe(true);
    expect(result.success && result.warnings[0].message).toMatch(/Postgres unreachable/);
  });
});
