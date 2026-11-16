/**
 * CrossAccountMover — déplacement inter-comptes.
 *
 * Deux parties :
 *   - les garde-fous d'entrée, purs (aucun appel IMAP, Graph ni Postgres) ;
 *   - la saga, avec des faux clients IMAP, un faux routeur Graph et un faux
 *     journal : IMAP → IMAP (non-régression), Graph → IMAP (succès, échec du
 *     nettoyage), et refus d'une destination Graph sans toucher la source.
 */

import type ConnectionManager from '@pedroskynet/email-core/connections/manager.js';
import { GraphError } from '@pedroskynet/email-core/services/graph/graph.client.js';
import type { IMailService } from '@pedroskynet/email-core/services/mail-service.types.js';
import { CrossAccountMover } from './cross-account-mover.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';
import type { MoveLogRepository } from './log-repository.js';

const RAW = Buffer.from(
  'Message-ID: <m1@example.com>\r\nFrom: Alice <alice@example.com>\r\nSubject: Devis\r\n\r\nCorps\r\n',
);

/** Id Graph réaliste : opaque, avec des caractères non numériques. */
const GRAPH_ID = 'AAMkAGI2TG93AAA=';

function imapClient() {
  const release = vi.fn();
  return {
    release,
    mailbox: { uidValidity: 7n, permanentFlags: new Set(['\\*']) },
    capabilities: new Map<string, boolean | number>([['MOVE', true]]),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    fetchOne: vi.fn().mockResolvedValue({
      uid: 42,
      source: RAW,
      flags: new Set(['\\Seen']),
      internalDate: new Date('2026-01-02T03:04:05Z'),
      envelope: {
        messageId: '<m1@example.com>',
        subject: 'Devis',
        from: [{ name: 'Alice', address: 'alice@example.com' }],
      },
    }),
    search: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue({ uid: 900 }),
    list: vi.fn().mockResolvedValue([{ path: 'Trash', specialUse: '\\Trash' }]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn(),
    expunge: vi.fn(),
  };
}

type FakeClient = ReturnType<typeof imapClient>;

function setup(options: { graph?: string[]; journal?: boolean } = {}) {
  const clients: Record<string, FakeClient> = {
    perso: imapClient(),
    pro: imapClient(),
    exchange: imapClient(),
  };
  const connections = {
    getAccountNames: () => Object.keys(clients),
    getImapClient: vi.fn(async (name: string) => clients[name]),
  } as unknown as ConnectionManager;
  const mailService = {
    getEmailFlags: vi.fn().mockResolvedValue({
      seen: true,
      flagged: true,
      answered: false,
      labels: [],
      subject: 'Devis',
      from: 'alice@example.com',
      date: '2026-01-02T03:04:05Z',
    }),
    getEmailRaw: vi.fn().mockResolvedValue(RAW),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  };
  const logRepo = {
    isConfigured: vi.fn().mockReturnValue(options.journal ?? true),
    claim: vi.fn().mockResolvedValue({ ok: true, id: 11 }),
    recordSourceCleanup: vi.fn().mockResolvedValue(undefined),
  };
  const graph = new Set(options.graph ?? []);
  const mover = new CrossAccountMover(
    connections,
    mailService as unknown as IMailService,
    (n) => graph.has(n),
    logRepo as unknown as MoveLogRepository,
  );
  return { mover, clients, connections, mailService, logRepo };
}

const base = {
  sourceAccount: 'perso',
  sourceMailbox: 'INBOX',
  emailId: '42',
  destAccount: 'pro',
  destMailbox: 'INBOX',
};

describe('CrossAccountMover guards', () => {
  it('rejects a non-numeric email_id from an IMAP source, before any network call', async () => {
    const { mover, connections, logRepo } = setup();
    const r = await mover.moveOne({ ...base, emailId: 'abc' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.INVALID_EMAIL_ID);
      expect(r.source_uid).toBeNull();
      expect(r.source_id).toBe('abc');
    }
    expect(connections.getImapClient).not.toHaveBeenCalled();
    expect(logRepo.claim).not.toHaveBeenCalled();
  });

  it('rejects a Graph-looking id on an IMAP source', async () => {
    const { mover } = setup();
    const r = await mover.moveOne({ ...base, emailId: GRAPH_ID });
    expect(!r.success && r.error_kind).toBe(ERROR_KIND.INVALID_EMAIL_ID);
  });

  it('rejects a non-positive email_id', async () => {
    const { mover } = setup();
    const r = await mover.moveOne({ ...base, emailId: '0' });
    expect(!r.success && r.error_kind).toBe(ERROR_KIND.INVALID_EMAIL_ID);
  });

  it('rejects an empty id on a Graph source', async () => {
    const { mover } = setup({ graph: ['exchange'] });
    const r = await mover.moveOne({ ...base, sourceAccount: 'exchange', emailId: '  ' });
    expect(!r.success && r.error_kind).toBe(ERROR_KIND.INVALID_EMAIL_ID);
  });

  it('rejects an unknown source account', async () => {
    const { mover } = setup();
    const r = await mover.moveOne({ ...base, sourceAccount: 'nope' });
    expect(!r.success && r.error_kind).toBe(ERROR_KIND.SOURCE_NOT_FOUND);
  });

  it('rejects an unknown destination account', async () => {
    const { mover } = setup();
    const r = await mover.moveOne({ ...base, destAccount: 'nope' });
    expect(!r.success && r.error_kind).toBe(ERROR_KIND.DEST_ACCOUNT_INVALID);
  });

  it('rejects a same-account move (use move_email instead)', async () => {
    const { mover } = setup();
    const r = await mover.moveOne({ ...base, destAccount: 'perso' });
    expect(!r.success && r.error_kind).toBe(ERROR_KIND.SAME_ACCOUNT_MOVE);
  });

  it('moveMany returns one result per input, preserving order', async () => {
    const { mover } = setup();
    const results = await mover.moveMany([
      { ...base, emailId: 'x' },
      { ...base, emailId: '0' },
    ]);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.source_id)).toEqual(['x', '0']);
    expect(results.every((r) => !r.success)).toBe(true);
  });
});

describe('CrossAccountMover — Graph destination refused', () => {
  it.each([
    ['IMAP', 'perso', '42'],
    ['Graph', 'exchange', GRAPH_ID],
  ])('refuses before reading or touching a %s source', async (_kind, source, id) => {
    const { mover, clients, connections, mailService, logRepo } = setup({
      graph: ['exchange', 'pro'],
    });
    const r = await mover.moveOne({ ...base, sourceAccount: source, emailId: id });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.DEST_BACKEND_UNSUPPORTED);
      expect(r.error_message).toMatch(/DRAFT/);
    }
    expect(connections.getImapClient).not.toHaveBeenCalled();
    expect(mailService.getEmailRaw).not.toHaveBeenCalled();
    expect(mailService.deleteEmail).not.toHaveBeenCalled();
    expect(logRepo.claim).not.toHaveBeenCalled();
    expect(clients.perso.messageMove).not.toHaveBeenCalled();
  });
});

describe('CrossAccountMover — IMAP → IMAP (non-régression)', () => {
  it('fetches, dedups, appends with $Routed, logs, then UID MOVEs the source to Trash', async () => {
    const { mover, clients, mailService, logRepo } = setup();

    const r = await mover.moveOne(base);

    expect(r).toMatchObject({
      success: true,
      status: 'success',
      source_uid: 42,
      source_id: '42',
      dest_uid: 900,
      message_id: '<m1@example.com>',
      source_cleanup: 'moved_to_trash',
      move_log_id: 11,
      warnings: [],
    });
    expect(r.success && r.source_cleanup_error).toBeUndefined();
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
    expect(clients.pro.messageFlagsAdd).toHaveBeenCalledWith('900', ['$Routed'], { uid: true });
    expect(logRepo.claim).toHaveBeenCalledWith(
      expect.objectContaining({ source_uid: 42, dest_uid: 900, message_id: '<m1@example.com>' }),
    );
    expect(clients.perso.messageMove).toHaveBeenCalledWith('42', 'Trash', { uid: true });
    expect(logRepo.recordSourceCleanup).toHaveBeenCalledWith(11, {
      source_deleted: true,
      source_cleanup: 'moved_to_trash',
      error_kind: null,
      error_message: null,
    });
    expect(mailService.getEmailRaw).not.toHaveBeenCalled();
    expect(mailService.deleteEmail).not.toHaveBeenCalled();
  });

  it('fails without touching the source when APPEND returns no UID', async () => {
    const { mover, clients, logRepo } = setup();
    clients.pro.append.mockResolvedValue({});

    const r = await mover.moveOne(base);

    expect(!r.success && r.error_kind).toBe(ERROR_KIND.APPEND_FAILED);
    expect(logRepo.claim).not.toHaveBeenCalled();
    expect(clients.perso.messageMove).not.toHaveBeenCalled();
  });

  it('fails closed without MOVE nor UIDPLUS, and says the source was kept', async () => {
    const { mover, clients } = setup();
    clients.perso.capabilities = new Map();

    const r = await mover.moveOne(base);

    expect(r).toMatchObject({
      success: true,
      source_cleanup: 'skipped_unsafe',
      source_cleanup_error: { kind: ERROR_KIND.SOURCE_CLEANUP_UNSAFE },
    });
    expect(r.success && r.warnings.map((w) => w.kind)).toEqual([WARNING_KIND.SOURCE_NOT_REMOVED]);
    expect(clients.perso.messageMove).not.toHaveBeenCalled();
    expect(clients.perso.expunge).not.toHaveBeenCalled();
  });

  // Cas OVH constaté le 2026-11-16 : pas de MOVE, mais UIDPLUS. L'émulation
  // d'imapflow (COPY + \Deleted + UID EXPUNGE <uid>) ne touche que ce message.
  it('moves the source with UIDPLUS when MOVE is absent (OVH)', async () => {
    const { mover, clients } = setup();
    clients.perso.capabilities = new Map([['UIDPLUS', true]]);

    const r = await mover.moveOne(base);

    expect(r).toMatchObject({ success: true, source_cleanup: 'moved_to_trash' });
    expect(clients.perso.messageMove).toHaveBeenCalledWith('42', 'Trash', { uid: true });
  });

  it('reports a source move the server refused instead of claiming success', async () => {
    const { mover, clients } = setup();
    clients.perso.messageMove.mockResolvedValue(false);

    const r = await mover.moveOne(base);

    expect(r).toMatchObject({
      success: true,
      source_cleanup: 'skipped_unsafe',
      source_cleanup_error: { kind: ERROR_KIND.SOURCE_CLEANUP_FAILED },
    });
    expect(r.success && r.warnings.map((w) => w.kind)).toContain(WARNING_KIND.SOURCE_NOT_REMOVED);
  });
});

describe('CrossAccountMover — Graph → IMAP', () => {
  const graphBase = { ...base, sourceAccount: 'exchange', emailId: GRAPH_ID };

  it('accepts an opaque id, reads $value, appends, then moves the source to Deleted Items', async () => {
    const { mover, clients, mailService, logRepo } = setup({ graph: ['exchange'] });

    const r = await mover.moveOne(graphBase);

    expect(r).toMatchObject({
      success: true,
      status: 'success',
      source_uid: null,
      source_id: GRAPH_ID,
      dest_uid: 900,
      message_id: '<m1@example.com>',
      source_cleanup: 'moved_to_trash',
      move_log_id: 11,
    });
    expect(mailService.getEmailRaw).toHaveBeenCalledWith('exchange', GRAPH_ID, 'INBOX');
    // Lu + suivi traduits en drapeaux IMAP, date de réception conservée.
    expect(clients.pro.append).toHaveBeenCalledWith(
      'INBOX',
      RAW,
      ['\\Seen', '\\Flagged'],
      new Date('2026-01-02T03:04:05Z'),
    );
    // Journal : 0 + Message-ID pour une source Graph.
    expect(logRepo.claim).toHaveBeenCalledWith(
      expect.objectContaining({ source_uid: 0, message_id: '<m1@example.com>' }),
    );
    // Nettoyage : déplacement vers Éléments supprimés (permanent=false), jamais DELETE.
    expect(mailService.deleteEmail).toHaveBeenCalledWith('exchange', GRAPH_ID, 'INBOX', false);
    // Aucun client IMAP ouvert sur la source Graph.
    expect(clients.exchange.getMailboxLock).not.toHaveBeenCalled();
    // Le dépôt précède le nettoyage.
    expect(clients.pro.append.mock.invocationCallOrder[0]).toBeLessThan(
      mailService.deleteEmail.mock.invocationCallOrder[0],
    );
  });

  it('reports a failed source cleanup: message at destination, source kept, never a silent success', async () => {
    const { mover, mailService, logRepo } = setup({ graph: ['exchange'] });
    mailService.deleteEmail.mockRejectedValue(new GraphError('Service unavailable', 503, ''));

    const r = await mover.moveOne(graphBase);

    expect(r).toMatchObject({
      success: true,
      dest_uid: 900,
      source_cleanup: 'skipped_unsafe',
      source_cleanup_error: { kind: ERROR_KIND.SOURCE_CLEANUP_FAILED },
    });
    expect(r.success && r.warnings).toEqual([
      expect.objectContaining({
        kind: WARNING_KIND.SOURCE_NOT_REMOVED,
        message: expect.stringMatching(/source was NOT removed/),
      }),
    ]);
    expect(logRepo.recordSourceCleanup).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        source_deleted: false,
        source_cleanup: 'skipped_unsafe',
        error_kind: ERROR_KIND.SOURCE_CLEANUP_FAILED,
      }),
    );
  });

  it('does not touch the source when it cannot be read', async () => {
    const { mover, mailService, logRepo } = setup({ graph: ['exchange'] });
    mailService.getEmailRaw.mockRejectedValue(new GraphError('Not found', 404, ''));

    const r = await mover.moveOne(graphBase);

    expect(!r.success && r.error_kind).toBe(ERROR_KIND.SOURCE_NOT_FOUND);
    expect(logRepo.claim).not.toHaveBeenCalled();
    expect(mailService.deleteEmail).not.toHaveBeenCalled();
  });
});

// Régression constatée en conditions réelles (2026-11-16) : sans
// `[database].url`, le déplacement échouait APRÈS avoir déposé le message à
// destination — une copie restait chez le destinataire derrière « Move failed ».
describe('CrossAccountMover — journal d’audit', () => {
  it('moves without a journal when no database is configured, with a warning', async () => {
    const { mover, clients, logRepo } = setup({ journal: false });

    const r = await mover.moveOne(base);

    expect(r.success).toBe(true);
    expect(r.success && r.move_log_id).toBeUndefined();
    expect(r.success && r.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: WARNING_KIND.AUDIT_LOG_SKIPPED })]),
    );
    expect(logRepo.claim).not.toHaveBeenCalled();
    expect(logRepo.recordSourceCleanup).not.toHaveBeenCalled();
    // Dépôt à destination puis source à la corbeille, comme avec journal.
    expect(clients.pro?.append).toHaveBeenCalled();
    expect(clients.perso?.messageMove).toHaveBeenCalledWith('42', 'Trash', { uid: true });
  });

  it('removes its destination copy and leaves the source when a configured journal is down', async () => {
    const { mover, clients, logRepo } = setup();
    logRepo.claim.mockRejectedValue(
      new MoveError(ERROR_KIND.DATABASE_UNAVAILABLE, 'Postgres unreachable (ECONNREFUSED)'),
    );

    const r = await mover.moveOne(base);

    expect(!r.success && r.error_kind).toBe(ERROR_KIND.DATABASE_UNAVAILABLE);
    // La copie déposée (uid 900) part à la corbeille de la destination…
    expect(clients.pro?.messageMove).toHaveBeenCalledWith('900', 'Trash', { uid: true });
    // …et la source n'est pas touchée.
    expect(clients.perso?.messageMove).not.toHaveBeenCalled();
  });
});
