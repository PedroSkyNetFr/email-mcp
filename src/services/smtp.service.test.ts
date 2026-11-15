import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import { formatQuoteDate } from '../utils/quote.js';
import type { ResolvedAttachment } from './attachment-resolver.js';
import type ImapService from './imap.service.js';
import SmtpService, { normalizeEnvelopeRecipients, stripBccHeader } from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(
  mockTransport: ReturnType<typeof createMockTransport>,
  accountOverrides: Record<string, unknown> = {},
) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      ...accountOverrides,
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    createEphemeralImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    subject: 'Original Subject',
    from: { name: 'Sender', address: 'sender@example.com' },
    to: [{ name: 'Test User', address: 'test@example.com' }],
    cc: [],
    bodyText: 'Original body',
    bodyHtml: undefined,
    messageId: '<original@example.com>',
    inReplyTo: undefined,
    references: [],
    date: '2025-01-01',
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

function createMockImapService() {
  return {
    appendToSent: vi.fn().mockResolvedValue(undefined),
    resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
    getEmail: vi.fn().mockResolvedValue(createMockEmail()),
  } as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imapService: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imapService = createMockImapService();
    service = new SmtpService(connections, rateLimiter, imapService);
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport as raw bytes with an explicit envelope', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
        // La copie Envoyés est désormais rapportée, plus avalée.
        sentCopy: { kind: 'filed' },
      });
      const call = transport.sendMail.mock.calls[0][0];
      // Compose-once → raw: nodemailer receives opaque bytes + explicit envelope.
      expect(call.raw).toBeInstanceOf(Buffer);
      expect(call.envelope).toEqual({
        from: 'test@example.com',
        to: ['recipient@example.com'],
      });
      const rawStr = (call.raw as Buffer).toString('utf-8');
      // MailComposer normalizes the display name (drops quotes for all-ASCII).
      expect(rawStr).toContain('From: Test User <test@example.com>');
      expect(rawStr).toContain('To: recipient@example.com');
      expect(rawStr).toContain('Subject: Hello');
      expect(rawStr).toContain('World');
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, imapService);

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes Cc in the message and To+Cc+Bcc in the envelope', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      const call = transport.sendMail.mock.calls[0][0];
      const rawStr = (call.raw as Buffer).toString('utf-8');
      // Cc appears as a header; Bcc must NOT (it rides only in the envelope).
      expect(rawStr).toContain('Cc: cc1@example.com, cc2@example.com');
      expect(rawStr).not.toMatch(/^Bcc:/im);
      // The envelope RCPT TO covers every To + Cc + Bcc recipient.
      expect(call.envelope.to).toEqual([
        'a@example.com',
        'cc1@example.com',
        'cc2@example.com',
        'bcc@example.com',
      ]);
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      const rawStr = (call.raw as Buffer).toString('utf-8');
      expect(rawStr).toContain('text/html');
      expect(rawStr).toContain('<h1>Hello</h1>');
    });

    it('calls appendToSent with the same raw bytes that were sent', async () => {
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).toHaveBeenCalledWith('test', expect.any(Buffer));
      const [[, appended]] = vi.mocked(imapService.appendToSent).mock.calls;
      expect((appended as Buffer).toString('utf-8')).toContain('Subject: Hello');
      const sent = transport.sendMail.mock.calls[0][0].raw as Buffer;
      expect((appended as Buffer).equals(sent)).toBe(true);
    });

    it('skips appendToSent for Gmail accounts', async () => {
      connections = createMockConnectionManager(transport, {
        imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
      });
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).not.toHaveBeenCalled();
    });

    it('skips appendToSent when saveToSent is false', async () => {
      connections = createMockConnectionManager(transport, { saveToSent: false });
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).not.toHaveBeenCalled();
    });

    it('does not throw when appendToSent fails', async () => {
      vi.mocked(imapService.appendToSent).mockRejectedValue(new Error('IMAP connection lost'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save to Sent folder'),
        expect.any(Error),
      );

      warnSpy.mockRestore();
    });

    it('forces appendToSent for Gmail when gmailAutoSave is false', async () => {
      connections = createMockConnectionManager(transport, {
        imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
        gmailAutoSave: false,
      });
      service = new SmtpService(connections, rateLimiter, imapService);

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).toHaveBeenCalled();
    });

    it('composes attachments into the raw message and stores the same bytes', async () => {
      const attachments: ResolvedAttachment[] = [
        {
          filename: 'invoice.pdf',
          content: Buffer.from('%PDF-1.4 fake invoice bytes'),
          contentType: 'application/pdf',
        },
      ];

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'With attachment',
        body: 'See attached',
        cc: ['cc1@example.com'],
        bcc: ['secret@example.com'],
        attachments,
      });

      const call = transport.sendMail.mock.calls[0][0];
      // Raw passthrough, not the old mailOptions shape.
      expect(call.raw).toBeInstanceOf(Buffer);
      const rawStr = (call.raw as Buffer).toString('utf-8');
      // The attachment filename survives in the composed MIME.
      expect(rawStr).toContain('invoice.pdf');
      // Bcc must never appear as a header in the composed/stored message.
      expect(rawStr).not.toMatch(/^Bcc:/im);
      // Envelope RCPT TO includes To + Cc + Bcc (de-duped).
      expect(call.envelope.from).toBe('test@example.com');
      expect(call.envelope.to).toEqual([
        'recipient@example.com',
        'cc1@example.com',
        'secret@example.com',
      ]);

      // appendToSent receives the SAME raw bytes that were transmitted.
      const [[, appended]] = vi.mocked(imapService.appendToSent).mock.calls;
      expect((appended as Buffer).toString('utf-8')).toContain('invoice.pdf');
      expect((appended as Buffer).equals(call.raw as Buffer)).toBe(true);
    });

    it('embeds an inline image (cid) as multipart/related', async () => {
      const attachments: ResolvedAttachment[] = [
        {
          filename: 'logo.png',
          content: Buffer.from('PNGfakebytes'),
          contentType: 'image/png',
          cid: 'companyLogo',
          contentDisposition: 'inline',
        },
      ];

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Inline logo',
        body: '<p>Hello</p><img src="cid:companyLogo">',
        html: true,
        attachments,
      });

      const call = transport.sendMail.mock.calls[0][0];
      const rawStr = (call.raw as Buffer).toString('utf-8');
      // The presence of a cid switches the message to multipart/related.
      expect(rawStr).toMatch(/Content-Type: multipart\/related/i);
      // The image is inline with the correct Content-ID.
      expect(rawStr).toMatch(/Content-Disposition: inline/i);
      expect(rawStr).toMatch(/Content-ID: <companyLogo>/i);
      expect(rawStr).toContain('logo.png');
    });

    it('coexists: inline logo (cid) + classic PDF attachment', async () => {
      const attachments: ResolvedAttachment[] = [
        {
          filename: 'logo.png',
          content: Buffer.from('PNGfakebytes'),
          contentType: 'image/png',
          cid: 'companyLogo',
          contentDisposition: 'inline',
        },
        {
          filename: 'quote.pdf',
          content: Buffer.from('%PDF-1.4 fake'),
          contentType: 'application/pdf',
        },
      ];

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Inline logo + PDF',
        body: '<p>See the quote</p><img src="cid:companyLogo">',
        html: true,
        attachments,
      });

      const rawStr = (transport.sendMail.mock.calls[0][0].raw as Buffer).toString('utf-8');
      // Nested multipart/related (inline image) plus the PDF as a classic attachment.
      expect(rawStr).toMatch(/Content-Type: multipart\/related/i);
      expect(rawStr).toMatch(/Content-ID: <companyLogo>/i);
      expect(rawStr).toContain('logo.png');
      // The PDF stays a downloadable attachment (Content-Disposition: attachment).
      expect(rawStr).toContain('quote.pdf');
      expect(rawStr).toMatch(/Content-Disposition: attachment/i);
    });

    it('delivers a bcc via the envelope but keeps it out of the raw/Sent message', async () => {
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Blind copy',
        body: 'Body',
        bcc: ['secret@example.com'],
      });

      const call = transport.sendMail.mock.calls[0][0];
      const rawStr = (call.raw as Buffer).toString('utf-8');
      // Bcc is in the SMTP envelope…
      expect(call.envelope.to).toEqual(['recipient@example.com', 'secret@example.com']);
      // …but NOT in the transmitted message.
      expect(rawStr).not.toMatch(/^Bcc:/im);
      expect(rawStr).not.toContain('secret@example.com');
      // …and NOT in the Sent copy.
      const [[, appended]] = vi.mocked(imapService.appendToSent).mock.calls;
      const appendedStr = (appended as Buffer).toString('utf-8');
      expect(appendedStr).not.toMatch(/^Bcc:/im);
      expect(appendedStr).not.toContain('secret@example.com');
    });
  });

  describe('replyToEmail', () => {
    it('calls appendToSent after successful reply', async () => {
      await service.replyToEmail('test', {
        emailId: '42',
        body: 'Reply body',
      });

      expect(imapService.appendToSent).toHaveBeenCalledWith('test', expect.any(Buffer));
      const [[, rawMsg]] = vi.mocked(imapService.appendToSent).mock.calls;
      expect((rawMsg as Buffer).toString()).toContain('Subject: Re: Original Subject');
    });

    // Regression: a raw-only sendMail({ raw }) gives nodemailer an empty SMTP
    // envelope ("No recipients defined"). The envelope must be passed explicitly
    // and must carry the original sender as a recipient.
    it('sends with an explicit, non-empty envelope addressed to the original sender', async () => {
      await service.replyToEmail('test', {
        emailId: '42',
        body: 'Reply body',
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.raw).toBeInstanceOf(Buffer);
      expect(call.envelope).toBeDefined();
      expect(call.envelope.from).toBe('test@example.com');
      expect(call.envelope.to).toEqual(['sender@example.com']);
    });

    it('includes To and Cc recipients (minus self) in the envelope on replyAll', async () => {
      imapService.getEmail = vi.fn().mockResolvedValue(
        createMockEmail({
          to: [
            { name: 'Test User', address: 'test@example.com' }, // us — must be dropped
            { name: 'Other', address: 'other@example.com' },
          ],
          cc: [{ name: 'CC One', address: 'cc1@example.com' }],
        }),
      );

      await service.replyToEmail('test', {
        emailId: '42',
        body: 'Reply body',
        replyAll: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.envelope.to).toEqual([
        'sender@example.com',
        'other@example.com',
        'cc1@example.com',
      ]);
      expect(call.envelope.to).not.toContain('test@example.com');
    });
  });

  describe('forwardEmail', () => {
    it('calls appendToSent after successful forward', async () => {
      await service.forwardEmail('test', {
        emailId: '42',
        to: ['forward@example.com'],
        body: 'FYI',
      });

      // Composé une seule fois : la copie Envoyés reçoit les octets bruts envoyés.
      expect(imapService.appendToSent).toHaveBeenCalledWith('test', expect.any(Buffer));
      const [[, appended]] = vi.mocked(imapService.appendToSent).mock.calls;
      expect((appended as Buffer).toString('utf-8')).toContain('Subject: Fwd: Original Subject');
      const sent = transport.sendMail.mock.calls[0][0].raw as Buffer;
      expect((appended as Buffer).equals(sent)).toBe(true);
    });

    it('forwards as HTML with the signature appended when signature_default is set', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'fwd-sig-'));
      const htmPath = join(dir, 'sig.htm');
      await writeFile(htmPath, '<html><body><p>Jane Doe</p></body></html>', 'latin1');
      try {
        const conn = createMockConnectionManager(transport, {
          signaturePath: htmPath,
          signatureDefault: true,
        });
        const svc = new SmtpService(conn, rateLimiter, imapService);

        await svc.forwardEmail('test', { emailId: '42', to: ['fwd@example.com'], body: 'FYI' });

        const call = transport.sendMail.mock.calls[0][0];
        // Signature → compose-once raw bytes (not the plain { text } shape), and
        // the message is HTML (the plain forward path emits text/plain instead).
        expect(call.raw).toBeInstanceOf(Buffer);
        expect((call.raw as Buffer).toString('utf-8')).toMatch(/Content-Type: text\/html/i);
        expect(call.envelope.to).toEqual(['fwd@example.com']);
        // appendToSent stores the same raw bytes that were transmitted.
        const [[, appended]] = vi.mocked(imapService.appendToSent).mock.calls;
        expect((appended as Buffer).equals(call.raw as Buffer)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('sendDraft', () => {
    // A full MIME draft (multipart/mixed) carrying a Bcc header AND a PDF
    // attachment. send_draft must transmit these RAW bytes (minus the Bcc
    // header) so attachments survive — recomposing from the parsed Email loses
    // the binary parts.
    const ATTACHMENT_FILENAME = 'invoice.pdf';
    function buildRawDraftWithAttachmentAndBcc(): Buffer {
      const raw = [
        'From: "Test User" <test@example.com>',
        'To: recipient@example.com',
        'Cc: cc1@example.com',
        'Bcc: secret@example.com',
        'Subject: Draft Subject',
        'Message-ID: <draft@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="BOUNDARY42"',
        '',
        '--BOUNDARY42',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Draft body',
        '--BOUNDARY42',
        'Content-Type: application/pdf',
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${ATTACHMENT_FILENAME}"`,
        '',
        Buffer.from('%PDF-1.4 fake invoice bytes').toString('base64'),
        '--BOUNDARY42--',
        '',
      ].join('\r\n');
      return Buffer.from(raw);
    }

    function createDraftMocks() {
      const mockDraft = {
        email: {
          id: '1',
          subject: 'Draft Subject',
          from: { address: 'test@example.com' },
          to: [{ address: 'recipient@example.com' }],
          cc: [{ address: 'cc1@example.com' }],
          bcc: [{ address: 'secret@example.com' }],
          bodyText: 'Draft body',
          bodyHtml: undefined,
          messageId: '<draft@example.com>',
          inReplyTo: undefined,
          references: [],
          date: '2025-01-01',
          seen: false,
          flagged: false,
          answered: false,
          hasAttachments: true,
          labels: [],
          attachments: [],
          headers: {},
        },
        mailbox: 'Drafts',
      };

      const rawDraft = buildRawDraftWithAttachmentAndBcc();

      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(mockDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;

      return { mockDraft, rawDraft, imapServiceWithDraft };
    }

    it('appends to Sent before deleting draft', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      // Verify order: appendToSent called before deleteDraft
      const appendCall = vi.mocked(imapServiceWithDraft.appendToSent).mock.invocationCallOrder[0];
      const deleteCall = vi.mocked(imapServiceWithDraft.deleteDraft).mock.invocationCallOrder[0];
      expect(appendCall).toBeLessThan(deleteCall);
    });

    it('sends the raw draft bytes (preserving the attachment) with an explicit envelope', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      const call = transport.sendMail.mock.calls[0][0];
      // Raw passthrough — not a recomposed text/html message.
      expect(call.raw).toBeInstanceOf(Buffer);
      const rawStr = (call.raw as Buffer).toString('utf-8');
      // The attachment part / filename must survive.
      expect(rawStr).toContain(ATTACHMENT_FILENAME);
      // The Bcc header must NOT leak into the transmitted message.
      expect(rawStr).not.toMatch(/^Bcc:/im);
      // Envelope is explicit and includes To + Cc + Bcc recipients.
      expect(call.envelope).toBeDefined();
      expect(call.envelope.from).toBe('test@example.com');
      expect(call.envelope.to).toEqual([
        'recipient@example.com',
        'cc1@example.com',
        'secret@example.com',
      ]);
    });

    it('appends the SAME sanitized raw bytes to Sent (attachment kept, Bcc stripped)', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      expect(imapServiceWithDraft.appendToSent).toHaveBeenCalledWith('test', expect.any(Buffer));
      const [[, appended]] = vi.mocked(imapServiceWithDraft.appendToSent).mock.calls;
      const appendedStr = (appended as Buffer).toString('utf-8');
      expect(appendedStr).toContain(ATTACHMENT_FILENAME);
      expect(appendedStr).not.toMatch(/^Bcc:/im);

      // The bytes sent and the bytes stored must be identical.
      const sent = transport.sendMail.mock.calls[0][0].raw as Buffer;
      expect((appended as Buffer).equals(sent)).toBe(true);
    });

    it('throws before calling SMTP when the draft has no recipients', async () => {
      const { mockDraft, rawDraft } = createDraftMocks();
      const noRecipientDraft = {
        ...mockDraft,
        email: { ...mockDraft.email, to: [], cc: [], bcc: [] },
      };
      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(noRecipientDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await expect(service.sendDraft('test', 1)).rejects.toThrow(/no recipients/i);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('de-dupes the envelope recipients case-insensitively (To + Cc + case-variant → one RCPT)', async () => {
      const { mockDraft, rawDraft } = createDraftMocks();
      const dupDraft = {
        ...mockDraft,
        email: {
          ...mockDraft.email,
          // Same address in To and Cc, plus a case-variant — must collapse to ONE.
          to: [{ address: 'dup@example.com' }, { address: 'other@example.com' }],
          cc: [{ address: 'DUP@example.com' }],
          bcc: [],
        },
      };
      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(dupDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      const call = transport.sendMail.mock.calls[0][0];
      // First-seen order preserved, original casing of the first occurrence kept.
      expect(call.envelope.to).toEqual(['dup@example.com', 'other@example.com']);
    });

    it('throws (before SMTP) when the only recipient is a blank address', async () => {
      const { mockDraft, rawDraft } = createDraftMocks();
      const blankDraft = {
        ...mockDraft,
        email: {
          ...mockDraft.email,
          // A parsed-but-empty address must NOT count as a recipient.
          to: [{ address: '' }],
          cc: [{ address: '   ' }],
          bcc: [],
        },
      };
      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(blankDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await expect(service.sendDraft('test', 1)).rejects.toThrow(/no recipients/i);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('keeps the draft (and says so) when the Sent-copy APPEND fails', async () => {
      // Supprimer le brouillon alors que la copie Envoyés a échoué effacerait
      // la seule trace locale du message envoyé.
      const { imapServiceWithDraft } = createDraftMocks();
      vi.mocked(imapServiceWithDraft.appendToSent).mockRejectedValue(new Error('IMAP error'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      const result = await service.sendDraft('test', 1);

      expect(transport.sendMail).toHaveBeenCalledTimes(1);
      expect(imapServiceWithDraft.deleteDraft).not.toHaveBeenCalled();
      expect(result.status).toBe('sent');
      expect(result.sentCopy).toEqual({ kind: 'failed', error: 'IMAP error' });
      expect(result.draftCleanup?.kind).toBe('kept');
      warnSpy.mockRestore();
    });

    it('reports success with a cleanup warning when deleting the draft fails after the send', async () => {
      // Lever ici ferait croire à un échec d'envoi : le modèle renverrait le
      // message, livré alors en double.
      const { imapServiceWithDraft } = createDraftMocks();
      vi.mocked(imapServiceWithDraft.deleteDraft).mockRejectedValue(new Error('EXPUNGE refused'));
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      const result = await service.sendDraft('test', 1);

      expect(result.status).toBe('sent');
      expect(result.sentCopy).toEqual({ kind: 'filed' });
      expect(result.draftCleanup).toEqual({ kind: 'failed', error: 'EXPUNGE refused' });
    });

    it('reports draftCleanup "removed" on the normal path', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      const result = await service.sendDraft('test', 1);

      expect(result.draftCleanup).toEqual({ kind: 'removed' });
    });

    it('refuses an oversized draft before SMTP and leaves it in place', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      const conn = createMockConnectionManager(transport, { maxMessageMb: 0.0001 });
      service = new SmtpService(conn, rateLimiter, imapServiceWithDraft);

      await expect(service.sendDraft('test', 1)).rejects.toThrow(/too large/i);
      expect(transport.sendMail).not.toHaveBeenCalled();
      expect(imapServiceWithDraft.deleteDraft).not.toHaveBeenCalled();
    });
  });

  describe('stripBccHeader', () => {
    it('removes a simple Bcc header', () => {
      const raw = Buffer.from(
        ['To: a@example.com', 'Bcc: secret@example.com', 'Subject: Hi', '', 'Body'].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/^Bcc:/im);
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('removes a folded Bcc header including its continuation lines', () => {
      const raw = Buffer.from(
        [
          'To: a@example.com',
          'Bcc: one@example.com,',
          '\ttwo@example.com,',
          ' three@example.com',
          'Subject: Hi',
          '',
          'Body',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/bcc/i);
      expect(out).not.toContain('two@example.com');
      expect(out).not.toContain('three@example.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('is a no-op when there is no Bcc header', () => {
      const raw = Buffer.from(
        ['To: a@example.com', 'Subject: Hi', '', 'Body line one', 'Body line two'].join('\r\n'),
      );
      const out = stripBccHeader(raw);
      expect(out.equals(raw)).toBe(true);
    });

    it('does not disturb other headers or the body', () => {
      const raw = Buffer.from(
        [
          'From: f@example.com',
          'To: a@example.com',
          'Bcc: secret@example.com',
          'Cc: c@example.com',
          'Subject: Keep me',
          'Content-Type: text/plain',
          '',
          'Bcc: this is body text, not a header — keep it',
          'second body line',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).toContain('From: f@example.com');
      expect(out).toContain('Cc: c@example.com');
      expect(out).toContain('Subject: Keep me');
      expect(out).toContain('Content-Type: text/plain');
      // Header Bcc gone…
      expect(out).not.toMatch(/^Bcc: secret@example\.com/im);
      // …but the body line that happens to start with "Bcc:" is preserved.
      expect(out).toContain('Bcc: this is body text, not a header — keep it');
      expect(out).toContain('second body line');
    });

    it('handles both CRLF and LF line endings', () => {
      const crlf = Buffer.from(
        ['To: a@example.com', 'Bcc: secret@example.com', 'Subject: Hi', '', 'Body'].join('\r\n'),
      );
      const lf = Buffer.from(
        ['To: a@example.com', 'Bcc: secret@example.com', 'Subject: Hi', '', 'Body'].join('\n'),
      );

      const crlfOut = stripBccHeader(crlf).toString('utf-8');
      const lfOut = stripBccHeader(lf).toString('utf-8');

      expect(crlfOut).not.toMatch(/^Bcc:/im);
      expect(lfOut).not.toMatch(/^Bcc:/im);
      // Original line endings preserved.
      expect(crlfOut).toContain('\r\n');
      expect(lfOut).not.toContain('\r\n');
      expect(lfOut).toContain('To: a@example.com\nSubject: Hi');
    });

    it('removes a Resent-Bcc header (RFC 5322 blind-recipient leak)', () => {
      const raw = Buffer.from(
        ['To: a@example.com', 'Resent-Bcc: secret@x.com', 'Subject: Hi', '', 'Body'].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/^Resent-Bcc:/im);
      expect(out).not.toContain('secret@x.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('removes a folded Resent-Bcc header including its continuation lines', () => {
      const raw = Buffer.from(
        [
          'To: a@example.com',
          'Resent-Bcc: one@x.com,',
          '\ttwo@x.com,',
          ' three@x.com',
          'Subject: Hi',
          '',
          'Body',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/resent-bcc/i);
      expect(out).not.toContain('one@x.com');
      expect(out).not.toContain('two@x.com');
      expect(out).not.toContain('three@x.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('does NOT strip unrelated headers like X-Original-Bcc', () => {
      const raw = Buffer.from(
        [
          'To: a@example.com',
          'X-Original-Bcc: archived@example.com',
          'Subject: Hi',
          '',
          'Body',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      // The X-Original-Bcc header (not a real Bcc) must be retained verbatim.
      expect(out).toContain('X-Original-Bcc: archived@example.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('returns the buffer unchanged when there is no header/body separator', () => {
      // A degenerate message with NO blank-line boundary. A later line happens
      // to start with "Bcc:" — but without a boundary we must NOT treat the
      // whole thing as headers and delete body content. Return byte-identical.
      const raw = Buffer.from(
        ['To: a@example.com', 'Subject: Hi', 'Bcc: looks-like-a-header@example.com'].join('\r\n'),
      );
      const out = stripBccHeader(raw);
      expect(out.equals(raw)).toBe(true);
    });
  });

  describe('normalizeEnvelopeRecipients', () => {
    it('de-dupes case-insensitively, preserving first-seen order and casing', () => {
      const out = normalizeEnvelopeRecipients([
        'dup@example.com',
        'other@example.com',
        'DUP@example.com',
      ]);
      expect(out).toEqual(['dup@example.com', 'other@example.com']);
    });

    it('drops empty and whitespace-only addresses', () => {
      const out = normalizeEnvelopeRecipients(['', '   ', 'a@example.com', '\t']);
      expect(out).toEqual(['a@example.com']);
    });

    it('trims surrounding whitespace before de-duping', () => {
      const out = normalizeEnvelopeRecipients(['  a@example.com  ', 'A@EXAMPLE.COM']);
      expect(out).toEqual(['a@example.com']);
    });

    it('returns an empty array when every address is blank', () => {
      expect(normalizeEnvelopeRecipients(['', '   '])).toEqual([]);
    });

    it('preserves order across To + Cc + Bcc concatenation', () => {
      const out = normalizeEnvelopeRecipients([
        'to@example.com',
        'cc@example.com',
        'bcc@example.com',
      ]);
      expect(out).toEqual(['to@example.com', 'cc@example.com', 'bcc@example.com']);
    });
  });
});

// ---------------------------------------------------------------------------
// Lot « envoi et brouillons » : pièces jointes, citations, préfixes, HTML,
// fil de discussion, taille, issue de la copie Envoyés.
// ---------------------------------------------------------------------------

describe('SmtpService — envoi et brouillons', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;

  /** Service IMAP simulé dont l'original porte des pièces jointes. */
  function imapWith(
    email: Record<string, unknown>,
    download?: (filename: string) => Promise<unknown>,
  ) {
    return {
      appendToSent: vi.fn().mockResolvedValue(undefined),
      getEmail: vi.fn().mockResolvedValue(createMockEmail(email)),
      downloadAttachment: vi.fn(
        async (_a: string, _id: string, _mb: string, filename: string, _max?: number) =>
          download
            ? download(filename)
            : {
                filename,
                mimeType: 'application/pdf',
                size: 4,
                contentBase64: Buffer.from(`bytes of ${filename}`).toString('base64'),
              },
      ),
    } as unknown as ImapService & {
      appendToSent: ReturnType<typeof vi.fn>;
      downloadAttachment: ReturnType<typeof vi.fn>;
    };
  }

  function sentRaw(): string {
    return (transport.sendMail.mock.calls[0][0].raw as Buffer).toString('utf-8');
  }

  /** Message envoyé, décodé (en-têtes RFC 2047, corps quoted-printable). */
  async function sentParsed() {
    return simpleParser(transport.sendMail.mock.calls[0][0].raw as Buffer);
  }

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
  });

  describe('forwardEmail — pièces jointes', () => {
    const withAttachments = {
      attachments: [
        { filename: 'facture.pdf', mimeType: 'application/pdf', size: 10 },
        { filename: 'devis.pdf', mimeType: 'application/pdf', size: 10 },
      ],
    };

    it('carries the original attachments by default, same bytes to SMTP and Sent', async () => {
      const imap = imapWith(withAttachments);
      const service = new SmtpService(connections, rateLimiter, imap);

      await service.forwardEmail('test', { emailId: '42', to: ['fwd@example.com'] });

      const raw = sentRaw();
      expect(raw).toContain('filename=facture.pdf');
      expect(raw).toContain('filename=devis.pdf');
      expect(raw).toContain(Buffer.from('bytes of facture.pdf').toString('base64'));
      // Plafond de 25 Mo par pièce (et non les 5 Mo par défaut de downloadAttachment).
      expect(imap.downloadAttachment).toHaveBeenCalledWith(
        'test',
        '42',
        'INBOX',
        'facture.pdf',
        25 * 1024 * 1024,
      );
      const [[, appended]] = imap.appendToSent.mock.calls;
      expect((appended as Buffer).equals(transport.sendMail.mock.calls[0][0].raw)).toBe(true);
    });

    it('sends nothing and names the attachment when one cannot be fetched', async () => {
      const imap = imapWith(withAttachments, async (filename) => {
        if (filename === 'devis.pdf') throw new Error('server said NO');
        return { filename, mimeType: 'application/pdf', size: 1, contentBase64: 'eA==' };
      });
      const service = new SmtpService(connections, rateLimiter, imap);

      await expect(
        service.forwardEmail('test', { emailId: '42', to: ['fwd@example.com'] }),
      ).rejects.toThrow(/devis\.pdf.*server said NO.*Nothing was sent/s);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('fetches a duplicated filename once and warns about the second part', async () => {
      const imap = imapWith({
        attachments: [
          { filename: 'scan.pdf', mimeType: 'application/pdf', size: 1 },
          { filename: 'scan.pdf', mimeType: 'application/pdf', size: 1 },
        ],
      });
      const service = new SmtpService(connections, rateLimiter, imap);

      const result = await service.forwardEmail('test', { emailId: '42', to: ['f@example.com'] });

      expect(imap.downloadAttachment).toHaveBeenCalledTimes(1);
      expect(result.warnings?.[0]).toMatch(/several attachments named "scan\.pdf"/);
    });

    it('forwards the body alone with includeAttachments=false', async () => {
      const imap = imapWith(withAttachments);
      const service = new SmtpService(connections, rateLimiter, imap);

      await service.forwardEmail('test', {
        emailId: '42',
        to: ['fwd@example.com'],
        includeAttachments: false,
      });

      expect(imap.downloadAttachment).not.toHaveBeenCalled();
      expect(sentRaw()).not.toContain('facture.pdf');
    });

    it('puts Cc in the message and the envelope', async () => {
      const service = new SmtpService(connections, rateLimiter, imapWith({}));

      await service.forwardEmail('test', {
        emailId: '42',
        to: ['fwd@example.com'],
        cc: ['copy@example.com'],
      });

      expect(sentRaw()).toContain('Cc: copy@example.com');
      expect(transport.sendMail.mock.calls[0][0].envelope.to).toEqual([
        'fwd@example.com',
        'copy@example.com',
      ]);
    });
  });

  describe('forwardEmail — corps', () => {
    const htmlOriginal = {
      bodyText: undefined,
      bodyHtml: '<html><body><p>Bonjour <b>Jean</b></p><p>Voir &eacute;tat</p></body></html>',
    };

    it('converts an HTML-only original to text instead of pasting markup', async () => {
      const service = new SmtpService(connections, rateLimiter, imapWith(htmlOriginal));

      await service.forwardEmail('test', { emailId: '42', to: ['f@example.com'], body: 'FYI' });

      const raw = sentRaw();
      expect(raw).toMatch(/Content-Type: text\/plain/i);
      expect(raw).not.toMatch(/Content-Type: text\/html/i);
      expect(raw).not.toContain('<b>');
      expect(raw).toContain('Bonjour Jean');
      // En-tête de transfert en français par défaut (reply_language).
      const parsed = await sentParsed();
      expect(parsed.text).toContain('---------- Message transféré ----------');
      expect(parsed.text).toContain('De : Sender <sender@example.com>');
      expect(parsed.text).toContain('Objet : ');
    });

    it('html=true adds an HTML part with the original HTML, plus the text alternative', async () => {
      const service = new SmtpService(connections, rateLimiter, imapWith(htmlOriginal));

      await service.forwardEmail('test', {
        emailId: '42',
        to: ['f@example.com'],
        body: 'Note <importante>',
        html: true,
      });

      const raw = sentRaw();
      expect(raw).toMatch(/multipart\/alternative/i);
      expect(raw).toMatch(/Content-Type: text\/plain/i);
      expect(raw).toMatch(/Content-Type: text\/html/i);
      // La note est échappée, l'original garde sa mise en forme.
      expect(raw).toContain('Note &lt;importante&gt;');
      expect(raw).toContain('<b>Jean</b>');
    });

    it('does not stack a forward prefix in another language', async () => {
      const service = new SmtpService(
        connections,
        rateLimiter,
        imapWith({ subject: 'TR: Réunion' }),
      );

      await service.forwardEmail('test', { emailId: '42', to: ['f@example.com'] });

      // L'objet peut être encodé (RFC 2047) : on compare sa valeur décodée.
      expect((await sentParsed()).subject).toBe('TR: Réunion');
      expect(sentRaw()).not.toContain('Fwd: TR:');
    });
  });

  describe('replyToEmail — citation', () => {
    it('quotes the original as "> " lines by default', async () => {
      const service = new SmtpService(
        connections,
        rateLimiter,
        imapWith({ bodyText: 'ligne 1\nligne 2' }),
      );

      await service.replyToEmail('test', { emailId: '42', body: 'Merci' });

      const { text } = await sentParsed();
      expect(text).toContain('Merci');
      // Français par défaut, date formatée dans le fuseau local.
      expect(text).toContain(
        `Le ${formatQuoteDate('2025-01-01', 'fr')}, Sender <sender@example.com> a écrit :`,
      );
      expect(text).toContain('> ligne 1');
      expect(text).toContain('> ligne 2');
    });

    it('reply_language = "en" on the account keeps the English attribution (14)', async () => {
      const conn = createMockConnectionManager(transport, { replyLanguage: 'en' });
      const service = new SmtpService(conn, rateLimiter, imapWith({ bodyText: 'ligne 1' }));

      await service.replyToEmail('test', { emailId: '42', body: 'Thanks' });

      const { text } = await sentParsed();
      expect(text).toContain(
        `On ${formatQuoteDate('2025-01-01', 'en')}, Sender <sender@example.com> wrote:`,
      );
      expect(text).not.toContain('a écrit');
    });

    it('reply_language = "en" also gives the English forward header (14)', async () => {
      const conn = createMockConnectionManager(transport, { replyLanguage: 'en' });
      const service = new SmtpService(conn, rateLimiter, imapWith({ bodyText: 'x' }));

      await service.forwardEmail('test', { emailId: '42', to: ['f@example.com'] });

      const { text } = await sentParsed();
      expect(text).toContain('---------- Forwarded message ----------');
      expect(text).toContain('From: Sender <sender@example.com>');
    });

    it('sends the bare body with quoteOriginal=false', async () => {
      const service = new SmtpService(
        connections,
        rateLimiter,
        imapWith({ bodyText: 'texte original' }),
      );

      await service.replyToEmail('test', { emailId: '42', body: 'Merci', quoteOriginal: false });

      expect(sentRaw()).not.toContain('texte original');
      expect(sentRaw()).not.toContain('wrote:');
      expect((await sentParsed()).text).not.toContain('a écrit');
    });

    it('quotes the original HTML as escaped text in an HTML reply', async () => {
      const service = new SmtpService(
        connections,
        rateLimiter,
        imapWith({
          bodyText: undefined,
          bodyHtml: '<p>avant</p></blockquote><p>INJECTION</p>',
        }),
      );

      await service.replyToEmail('test', { emailId: '42', body: '<p>Merci</p>', html: true });

      const raw = sentRaw();
      expect(raw).toContain('<blockquote type=3D"cite"');
      // Le HTML d'origine n'est jamais repris tel quel : pas de </blockquote>
      // en provenance de l'expéditeur.
      expect(raw.match(/<\/blockquote>/g)?.length).toBe(1);
      expect(raw).toMatch(/multipart\/alternative/i);
    });

    it('does not stack "Re:" on an upper-case or foreign reply prefix', async () => {
      const service = new SmtpService(
        connections,
        rateLimiter,
        imapWith({ subject: 'AW: Angebot' }),
      );

      await service.replyToEmail('test', { emailId: '42', body: 'Danke' });

      expect(sentRaw()).toContain('Subject: AW: Angebot');
    });
  });

  describe('replyToEmail — includeAttachments', () => {
    it('fails explicitly (nothing sent) when an attachment is over the cap', async () => {
      const imap = imapWith(
        { attachments: [{ filename: 'gros.zip', mimeType: 'application/zip', size: 1 }] },
        async () => {
          throw new Error('Attachment "gros.zip" is about 30MB, exceeds 25MB limit');
        },
      );
      const service = new SmtpService(connections, rateLimiter, imap);

      await expect(
        service.replyToEmail('test', { emailId: '42', body: 'x', includeAttachments: true }),
      ).rejects.toThrow(/Cannot reply.*gros\.zip.*includeAttachments=false/s);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('sendEmail — HTML, fil, taille, copie Envoyés', () => {
    it('adds a generated text/plain alternative to an HTML send', async () => {
      const service = new SmtpService(connections, rateLimiter, imapWith({}));

      await service.sendEmail('test', {
        to: ['r@example.com'],
        subject: 'S',
        body: '<p>Bonjour</p><p><a href="https://example.com/x">le lien</a></p>',
        html: true,
      });

      const raw = sentRaw();
      expect(raw).toMatch(/multipart\/alternative/i);
      expect(raw).toContain('le lien [https://example.com/x]');
    });

    it('sets In-Reply-To and References when replying from a scheduled send', async () => {
      const service = new SmtpService(connections, rateLimiter, imapWith({}));

      await service.sendEmail('test', {
        to: ['r@example.com'],
        subject: 'Re: S',
        body: 'b',
        inReplyTo: '<orig@example.com>',
        references: ['<root@example.com>'],
      });

      const raw = sentRaw();
      expect(raw).toContain('In-Reply-To: <orig@example.com>');
      expect(raw).toContain('References: <root@example.com> <orig@example.com>');
    });

    it('refuses a message whose encoded size exceeds the account limit, before SMTP', async () => {
      const conn = createMockConnectionManager(transport, { maxMessageMb: 1 });
      const service = new SmtpService(conn, rateLimiter, imapWith({}));

      await expect(
        service.sendEmail('test', {
          to: ['r@example.com'],
          subject: 'S',
          body: 'b',
          // 800 Ko décodés ≈ 1,08 Mo en base64 : sous la limite par fichier, au-dessus du total.
          attachments: [
            {
              filename: 'a.bin',
              content: Buffer.alloc(800 * 1024),
              contentType: 'application/octet-stream',
            },
          ],
        }),
      ).rejects.toThrow(/too large.*a\.bin/s);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('without max_message_mb, applies no local limit on SMTP (the server SIZE decides)', async () => {
      const service = new SmtpService(connections, rateLimiter, imapWith({}));

      // ~34 Mo une fois encodé : refusé autrefois par la limite locale de 25 Mo.
      await service.sendEmail('test', {
        to: ['r@example.com'],
        subject: 'S',
        body: 'b',
        attachments: [
          {
            filename: 'big.bin',
            content: Buffer.alloc(25 * 1024 * 1024),
            contentType: 'application/octet-stream',
          },
        ],
      });

      expect(transport.sendMail).toHaveBeenCalledTimes(1);
    });

    it('turns a server-side size rejection (SIZE / 552) into a clear error', async () => {
      const sizeError = Object.assign(new Error('Message size larger than allowed 10485760'), {
        code: 'EMESSAGE',
        command: 'MAIL FROM',
      });
      transport.sendMail.mockRejectedValueOnce(sizeError);
      const service = new SmtpService(connections, rateLimiter, imapWith({}));

      await expect(
        service.sendEmail('test', { to: ['r@example.com'], subject: 'S', body: 'b' }),
      ).rejects.toThrow(/too large for the SMTP server.*server limit 10\.0 MB.*Nothing was sent/s);
    });

    it('reports a failed Sent copy in the result instead of swallowing it', async () => {
      const imap = imapWith({});
      imap.appendToSent.mockRejectedValue(new Error('quota exceeded'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new SmtpService(connections, rateLimiter, imap);

      const result = await service.sendEmail('test', {
        to: ['r@example.com'],
        subject: 'S',
        body: 'b',
      });

      expect(result.status).toBe('sent');
      expect(result.sentCopy).toEqual({ kind: 'failed', error: 'quota exceeded' });
      warn.mockRestore();
    });

    it('reports a skipped Sent copy when save_to_sent is off', async () => {
      const conn = createMockConnectionManager(transport, { saveToSent: false });
      const service = new SmtpService(conn, rateLimiter, imapWith({}));

      const result = await service.sendEmail('test', {
        to: ['r@example.com'],
        subject: 'S',
        body: 'b',
      });

      expect(result.sentCopy?.kind).toBe('skipped');
    });

    it('never folds a long attachment filename inside its quotes', async () => {
      const service = new SmtpService(connections, rateLimiter, imapWith({}));

      await service.sendEmail('test', {
        to: ['r@example.com'],
        subject: 'S',
        body: 'b',
        attachments: [
          {
            filename: 'Farmpedals Statement 08-07-2026 with a rather long name.pdf',
            content: Buffer.from('%PDF'),
            contentType: 'application/pdf',
          },
        ],
      });

      const raw = sentRaw();
      expect(raw).toContain(
        'filename="Farmpedals Statement 08-07-2026 with a rather long name.pdf"',
      );
      expect(raw).not.toMatch(/filename="[^"]*\r\n/);
    });
  });
});
