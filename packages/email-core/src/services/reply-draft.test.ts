/**
 * reply_draft — réponse enregistrée dans Brouillons sans être envoyée, sur les
 * deux backends : IMAP (SmtpService.saveReplyDraft → ImapService.saveDraft) et
 * Graph (GraphSendService.saveReplyDraft → createReply / createReplyAll).
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { AccountConfig } from '../types/index.js';
import type GraphClient from './graph/graph.client.js';
import GraphSendService from './graph/graph-send.service.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

function original(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    subject: 'Devis toiture',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [
      { name: 'Moi', address: 'Me@Example.com' },
      { name: 'Bob', address: 'bob@example.com' },
    ],
    cc: [{ address: 'carol@example.com' }],
    bodyText: 'Voici le devis.',
    bodyHtml: undefined,
    messageId: '<orig@example.com>',
    inReplyTo: undefined,
    references: ['<root@example.com>'],
    date: '2026-11-10T09:30:00Z',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    attachments: [],
    headers: {},
    ...overrides,
  };
}

function imapSetup(accountOverrides: Record<string, unknown> = {}) {
  const transport = { sendMail: vi.fn() };
  const connections = {
    getAccount: vi.fn().mockReturnValue({
      name: 'perso',
      email: 'me@example.com',
      fullName: 'Moi',
      username: 'me@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      ...accountOverrides,
    }),
    getAccountNames: vi.fn().mockReturnValue(['perso']),
    getImapClient: vi.fn(),
    createEphemeralImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(transport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
  const rateLimiter = {
    tryConsume: vi.fn().mockReturnValue(true),
    remaining: vi.fn().mockReturnValue(9),
  } as unknown as RateLimiter;
  const imap = {
    getEmail: vi.fn().mockResolvedValue(original()),
    saveDraft: vi.fn().mockResolvedValue({ id: 77, mailbox: 'Drafts' }),
    downloadAttachment: vi.fn(),
    appendToSent: vi.fn(),
  };
  const service = new SmtpService(connections, rateLimiter, imap as unknown as ImapService);
  return { service, imap, transport, rateLimiter };
}

describe('SmtpService.saveReplyDraft (IMAP)', () => {
  it('adresse le brouillon au Reply-To, et en replyAll y ajoute To/Cc sans soi-même', async () => {
    const { service, imap } = imapSetup();
    imap.getEmail.mockResolvedValue(
      original({ replyTo: [{ address: 'devis@example.com' }, { address: 'ME@example.com' }] }),
    );
    await service.saveReplyDraft('perso', { emailId: '42', body: 'x', replyAll: true });
    expect(imap.saveDraft).toHaveBeenCalledWith(
      'perso',
      expect.objectContaining({
        to: ['devis@example.com', 'bob@example.com'],
        cc: ['carol@example.com'],
      }),
    );
  });

  it('saves a threaded reply to Drafts and sends nothing', async () => {
    const { service, imap, transport, rateLimiter } = imapSetup();

    const result = await service.saveReplyDraft('perso', {
      emailId: '42',
      mailbox: 'INBOX',
      body: 'Merci, je regarde.',
    });

    // Objet et destinataires rappelés à l'appelant, comme dans le brouillon.
    const saved = imap.saveDraft.mock.calls[0]?.[1] as { to: string[]; subject: string };
    expect(result).toEqual({
      id: 77,
      mailbox: 'Drafts',
      subject: saved.subject,
      to: saved.to,
      cc: expect.any(Array),
      warnings: [],
    });
    expect(result.subject).toMatch(/^Re: /);
    expect(transport.sendMail).not.toHaveBeenCalled();
    // Un brouillon ne consomme pas la limite d'envoi.
    expect(rateLimiter.tryConsume).not.toHaveBeenCalled();
    const draft = imap.saveDraft.mock.calls[0][1];
    expect(draft).toMatchObject({
      to: ['alice@example.com'],
      cc: [],
      subject: 'Re: Devis toiture',
      inReplyTo: '<orig@example.com>',
      references: ['<root@example.com>', '<orig@example.com>'],
      html: false,
      // La signature éventuelle est déjà dans le corps : jamais deux fois.
      appendSignature: false,
    });
    // Citation française par défaut sous la réponse.
    expect(draft.body).toMatch(/^Merci, je regarde\./);
    expect(draft.body).toMatch(/a écrit :/);
    expect(draft.body).toMatch(/> Voici le devis\./);
  });

  it('replyAll adds the original To/Cc minus the account itself', async () => {
    const { service, imap } = imapSetup();

    await service.saveReplyDraft('perso', {
      emailId: '42',
      body: 'Pour tous',
      replyAll: true,
      bcc: ['archive@example.com'],
    });

    const draft = imap.saveDraft.mock.calls[0][1];
    expect(draft.to).toEqual(['alice@example.com', 'bob@example.com']);
    expect(draft.cc).toEqual(['carol@example.com']);
    // Bcc confié à saveDraft, qui le garde dans l'en-tête du brouillon.
    expect(draft.bcc).toEqual(['archive@example.com']);
  });

  it('quoteOriginal=false keeps the bare body; reply_language "en" changes the quote', async () => {
    const bare = imapSetup();
    await bare.service.saveReplyDraft('perso', {
      emailId: '42',
      body: 'Seul',
      quoteOriginal: false,
    });
    expect(bare.imap.saveDraft.mock.calls[0][1].body).toBe('Seul');

    const en = imapSetup({ replyLanguage: 'en' });
    await en.service.saveReplyDraft('perso', { emailId: '42', body: 'Hi' });
    expect(en.imap.saveDraft.mock.calls[0][1].body).toMatch(/wrote:/);
  });

  it('includeAttachments carries the original attachments, strictly', async () => {
    const { service, imap } = imapSetup();
    imap.getEmail.mockResolvedValue(
      original({ attachments: [{ filename: 'devis.pdf', mimeType: 'application/pdf', size: 3 }] }),
    );
    imap.downloadAttachment.mockResolvedValue({
      filename: 'devis.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('pdf').toString('base64'),
    });

    await service.saveReplyDraft('perso', {
      emailId: '42',
      body: 'Ci-joint',
      includeAttachments: true,
    });
    expect(imap.saveDraft.mock.calls[0][1].attachments).toEqual([
      { filename: 'devis.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' },
    ]);

    imap.downloadAttachment.mockRejectedValue(new Error('gone'));
    imap.saveDraft.mockClear();
    await expect(
      service.saveReplyDraft('perso', { emailId: '42', body: 'x', includeAttachments: true }),
    ).rejects.toThrow(/Cannot draft a reply: .*devis\.pdf/);
    expect(imap.saveDraft).not.toHaveBeenCalled();
  });

  it('warns when the server did not report the draft UID', async () => {
    const { service, imap } = imapSetup();
    imap.saveDraft.mockResolvedValue({ id: 0, mailbox: 'Drafts' });

    const result = await service.saveReplyDraft('perso', { emailId: '42', body: 'x' });

    expect(result.warnings[0]).toMatch(/did not report the UID/);
  });
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

const graphAccount: AccountConfig = {
  name: 'work',
  email: 'me@contoso.com',
  username: 'me@contoso.com',
  backend: 'graph',
  imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
};

function graphSetup(
  routes: Record<string, unknown> = {},
  collections: Record<string, unknown[]> = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    const value = key ? routes[key] : undefined;
    if (value instanceof Error) throw value;
    return value;
  });
  const collect = vi.fn(async (path: string) => {
    const key = Object.keys(collections).find((k) => path.startsWith(k));
    return key ? collections[key] : [];
  });
  const client = { request, collect, uploadLargeAttachment: vi.fn() } as unknown as GraphClient;
  const service = new GraphSendService(new Map([['work', client]]), () => graphAccount);
  return { service, calls };
}

describe('GraphSendService.saveReplyDraft (Graph)', () => {
  it('quoted reply: createReply with the body as comment, never /send', async () => {
    const { service, calls } = graphSetup({
      'POST /me/messages/AAA/createReply': {
        id: 'D1',
        subject: 'RE: Devis',
        toRecipients: [{ emailAddress: { address: 'support@boutique.fr' } }],
        ccRecipients: [],
      },
    });

    const result = await service.saveReplyDraft('work', { emailId: 'AAA', body: 'Merci' });

    // Objet et destinataires tels qu'Exchange les a calculés (Reply-To compris).
    expect(result).toEqual({
      id: 'D1',
      mailbox: 'Drafts',
      subject: 'RE: Devis',
      to: ['support@boutique.fr'],
      cc: [],
      warnings: [],
    });
    expect(calls).toEqual([
      { method: 'POST', path: '/me/messages/AAA/createReply', body: { comment: 'Merci' } },
    ]);
  });

  it('replyAll + quoteOriginal=false + bcc: createReplyAll then one PATCH', async () => {
    const { service, calls } = graphSetup({ 'POST /me/messages/AAA/createReplyAll': { id: 'D2' } });

    await service.saveReplyDraft('work', {
      emailId: 'AAA',
      body: '<p>Bonjour</p>',
      html: true,
      replyAll: true,
      quoteOriginal: false,
      bcc: ['audit@contoso.com'],
    });

    expect(calls).toEqual([
      { method: 'POST', path: '/me/messages/AAA/createReplyAll', body: {} },
      {
        method: 'PATCH',
        path: '/me/messages/D2',
        body: {
          body: { contentType: 'HTML', content: '<p>Bonjour</p>' },
          bccRecipients: [{ emailAddress: { address: 'audit@contoso.com' } }],
        },
      },
    ]);
    expect(calls.some((c) => c.path.endsWith('/send'))).toBe(false);
  });

  it('adds the original attachments with includeAttachments', async () => {
    const { service, calls } = graphSetup(
      {
        'POST /me/messages/AAA/createReply': { id: 'D3' },
        'GET /me/messages/AAA/attachments/att1': {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'devis.pdf',
          contentType: 'application/pdf',
          contentBytes: Buffer.from('pdf').toString('base64'),
        },
      },
      { '/me/messages/AAA/attachments': [{ id: 'att1', name: 'devis.pdf', size: 3 }] },
    );

    await service.saveReplyDraft('work', {
      emailId: 'AAA',
      body: 'Ci-joint',
      includeAttachments: true,
    });

    const upload = calls.find((c) => c.path === '/me/messages/D3/attachments');
    expect(upload?.body).toMatchObject({ name: 'devis.pdf', contentBytes: 'cGRm' });
  });

  it('discards the draft when a later step fails (no orphan in Drafts)', async () => {
    const { service, calls } = graphSetup({
      'POST /me/messages/AAA/createReply': { id: 'D4' },
      'PATCH /me/messages/D4': new Error('patch refused'),
    });

    await expect(
      service.saveReplyDraft('work', { emailId: 'AAA', body: 'x', quoteOriginal: false }),
    ).rejects.toThrow('patch refused');
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/me/messages/D4', body: undefined });
  });
});
