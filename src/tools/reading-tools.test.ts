/**
 * Comportement observable des outils de lecture : format par défaut, plafond
 * et suite d'un corps tronqué, format html, aperçu opt-in, indice liste /
 * automatique, refus d'une recherche sans critère.
 *
 * Les outils sont pilotés comme par un client MCP : arguments validés par
 * leur schéma (défauts compris), puis gestionnaire appelé.
 */

import type { z } from 'zod';

import type { Email, EmailMeta, PaginatedResult } from '../types/index.js';
import { DEFAULT_MULTI_BODY_MAX, DEFAULT_SINGLE_BODY_MAX } from '../utils/body-format.js';
import registerEmailsTools, { hasSearchCriterion } from './emails.tool.js';
import registerThreadTools from './thread.tool.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}>;

/** Serveur factice : garde la forme d'entrée et le gestionnaire de chaque outil. */
function captureTools(register: (server: never) => void) {
  const tools = new Map<string, { schema: z.ZodType; handler: Handler }>();
  register({
    // SDK v2 : registerTool(nom, { description, inputSchema, annotations }, gestionnaire)
    registerTool: (name: string, config: { inputSchema: z.ZodType }, handler: Handler) => {
      tools.set(name, { schema: config.inputSchema, handler });
    },
  } as never);
  return async (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    const args = tool.schema.parse(input) as Record<string, unknown>;
    const result = await tool.handler(args);
    return { ...result, text: result.content.map((c) => c.text).join('\n') };
  };
}

function email(overrides: Partial<Email> = {}): Email {
  return {
    id: '42',
    subject: 'Sujet',
    from: { address: 'a@example.com' },
    to: [{ address: 'b@example.com' }],
    date: '2026-11-01T10:00:00.000Z',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    messageId: '<m1@example.com>',
    attachments: [],
    headers: {},
    ...overrides,
  };
}

function page(items: EmailMeta[]): PaginatedResult<EmailMeta> {
  return { items, total: items.length, page: 1, pageSize: 20, hasMore: false };
}

describe('get_email', () => {
  const service = { getEmail: vi.fn(), setFlags: vi.fn() };
  const call = captureTools((server) => registerEmailsTools(server, service as never, {} as never));

  beforeEach(() => {
    service.getEmail.mockReset();
  });

  it('defaults to format "text": an HTML-only body comes back as readable text', async () => {
    service.getEmail.mockResolvedValue(
      email({ bodyHtml: '<p>Bonjour <a href="https://ex.com/f">la facture</a> &eacute;mise</p>' }),
    );
    const { text } = await call('get_email', { account: 'a', emailId: '42' });
    expect(text).toContain('Bonjour la facture [https://ex.com/f] émise');
    expect(text).not.toContain('<p>');
  });

  it(`caps the body at ${DEFAULT_SINGLE_BODY_MAX} chars by default and says how to read on`, async () => {
    service.getEmail.mockResolvedValue(
      email({ bodyText: 'a'.repeat(DEFAULT_SINGLE_BODY_MAX + 500) }),
    );
    const { text } = await call('get_email', { account: 'a', emailId: '42' });
    expect(text).toContain('✂️');
    expect(text).toContain('500 more characters');
    expect(text).toContain(`call get_email again with offset=${DEFAULT_SINGLE_BODY_MAX}`);
    expect(text).toContain('maxLength=0 for the whole body');
  });

  it('offset (sent as a string, as many clients do) returns the continuation', async () => {
    service.getEmail.mockResolvedValue(email({ bodyText: `${'a'.repeat(100)}SUITE` }));
    const { text, isError } = await call('get_email', {
      account: 'a',
      emailId: '42',
      offset: '100',
      maxLength: '50',
    });
    expect(isError).toBeUndefined();
    expect(text).toContain('characters 100–105 of 105');
    expect(text).toContain('SUITE');
  });

  it('maxLength 0 disables the cap', async () => {
    service.getEmail.mockResolvedValue(
      email({ bodyText: 'b'.repeat(DEFAULT_SINGLE_BODY_MAX + 1) }),
    );
    const { text } = await call('get_email', { account: 'a', emailId: '42', maxLength: 0 });
    expect(text).not.toContain('✂️');
  });

  it('format "html" returns the raw HTML part, uncapped by default (works for Graph bodyHtml too)', async () => {
    const html = `<table><tr><td>${'x'.repeat(DEFAULT_SINGLE_BODY_MAX + 10)}</td></tr></table>`;
    service.getEmail.mockResolvedValue(email({ bodyText: 'plain', bodyHtml: html }));
    const { text } = await call('get_email', { account: 'a', emailId: '42', format: 'html' });
    expect(text).toContain(html);
    expect(text).not.toContain('✂️');
  });

  it('shows the mailing-list hint from the full headers, worded as unverified', async () => {
    service.getEmail.mockResolvedValue(
      email({
        bodyText: 'hi',
        headers: { 'list-unsubscribe': '<https://news.example/u>', 'list-id': '<news.example>' },
      }),
    );
    const { text } = await call('get_email', { account: 'a', emailId: '42' });
    expect(text).toContain('📰 mailing-list hint (sender-set headers, not verified');
    expect(text).toContain('Unsubscribe: https://news.example/u');
  });
});

describe('get_emails', () => {
  it(`caps each body at ${DEFAULT_MULTI_BODY_MAX} and points to get_email for the rest`, async () => {
    const service = {
      getEmail: vi
        .fn()
        .mockResolvedValue(email({ bodyText: 'c'.repeat(DEFAULT_MULTI_BODY_MAX + 1) })),
    };
    const call = captureTools((server) =>
      registerEmailsTools(server, service as never, {} as never),
    );
    const { text } = await call('get_emails', { account: 'a', ids: ['42'] });
    expect(text).toContain(`use get_email with emailId=42 and offset=${DEFAULT_MULTI_BODY_MAX}`);
  });

  it('accepts format "html"', async () => {
    const service = { getEmail: vi.fn().mockResolvedValue(email({ bodyHtml: '<b>x</b>' })) };
    const call = captureTools((server) =>
      registerEmailsTools(server, service as never, {} as never),
    );
    const { text } = await call('get_emails', { account: 'a', ids: ['42'], format: 'html' });
    expect(text).toContain('<b>x</b>');
  });
});

describe('get_thread', () => {
  const thread = (messages: Email[]) => ({
    threadId: '<m1@example.com>',
    messages,
    participants: [{ address: 'a@example.com' }],
    messageCount: messages.length,
  });

  it('defaults to text with a per-message cap naming the get_email call for the rest', async () => {
    const service = {
      getThread: vi
        .fn()
        .mockResolvedValue(
          thread([
            email({ id: '7', bodyHtml: `<p>${'d'.repeat(DEFAULT_MULTI_BODY_MAX + 3)}</p>` }),
          ]),
        ),
    };
    const call = captureTools((server) => registerThreadTools(server, service as never));
    const { text } = await call('get_thread', { account: 'a', message_id: '<m1@example.com>' });
    expect(text).not.toContain('<p>');
    expect(text).toContain(
      `use get_email with emailId=7, mailbox="INBOX" and offset=${DEFAULT_MULTI_BODY_MAX}`,
    );
  });

  it('accepts format "html"', async () => {
    const service = {
      getThread: vi.fn().mockResolvedValue(thread([email({ bodyHtml: '<i>raw</i>' })])),
    };
    const call = captureTools((server) => registerThreadTools(server, service as never));
    const { text } = await call('get_thread', {
      account: 'a',
      message_id: '<m1@example.com>',
      format: 'html',
    });
    expect(text).toContain('<i>raw</i>');
  });
});

describe('list_emails / search_emails', () => {
  const meta: EmailMeta = {
    id: '9',
    subject: 'Promo',
    from: { address: 'news@shop.example' },
    to: [],
    date: '2026-11-01T10:00:00.000Z',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    preview: 'Les soldes commencent',
    classification: { kind: 'list', signals: ['List-Unsubscribe'] },
  };

  it('the preview is shown only on request (same output for IMAP and Graph)', async () => {
    const service = { listEmails: vi.fn().mockResolvedValue(page([meta])) };
    const call = captureTools((server) =>
      registerEmailsTools(server, service as never, {} as never),
    );

    const plain = await call('list_emails', { account: 'a' });
    expect(plain.text).not.toContain('Les soldes commencent');
    expect(service.listEmails.mock.calls[0][1].preview).toBe(false);

    const withPreview = await call('list_emails', { account: 'a', preview: true });
    expect(withPreview.text).toContain('Les soldes commencent');
    expect(service.listEmails.mock.calls[1][1].preview).toBe(true);
  });

  it('search_all_accounts takes the same preview parameter as search_emails (7b)', async () => {
    const service = { searchAcrossAccounts: vi.fn().mockResolvedValue(page([meta])) };
    const call = captureTools((server) =>
      registerEmailsTools(
        server,
        service as never,
        {
          getAccountNames: () => ['a', 'b'],
        } as never,
      ),
    );

    const plain = await call('search_all_accounts', { query: 'soldes' });
    expect(plain.text).not.toContain('Les soldes commencent');
    expect(service.searchAcrossAccounts.mock.calls[0][2].preview).toBe(false);

    const withPreview = await call('search_all_accounts', { query: 'soldes', preview: true });
    expect(withPreview.text).toContain('Les soldes commencent');
    expect(service.searchAcrossAccounts.mock.calls[1][2].preview).toBe(true);
  });

  it('list lines carry the mailing-list hint', async () => {
    const service = { listEmails: vi.fn().mockResolvedValue(page([meta])) };
    const call = captureTools((server) =>
      registerEmailsTools(server, service as never, {} as never),
    );
    const { text } = await call('list_emails', { account: 'a', page: '1', pageSize: '20' });
    expect(text).toContain(
      '📰 mailing-list hint (sender-set headers, not verified: List-Unsubscribe)',
    );
  });

  it('search_emails with no criterion at all is refused, nothing is searched', async () => {
    const service = { searchEmails: vi.fn() };
    const call = captureTools((server) =>
      registerEmailsTools(server, service as never, {} as never),
    );
    const result = await call('search_emails', { account: 'a', mailbox: 'INBOX', page: 2 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/needs at least one search criterion/);
    expect(result.text).toMatch(/use list_emails/);
    expect(service.searchEmails).not.toHaveBeenCalled();
  });

  it('search_emails with a single filter (even seen=false) runs', async () => {
    const service = { searchEmails: vi.fn().mockResolvedValue(page([])) };
    const call = captureTools((server) =>
      registerEmailsTools(server, service as never, {} as never),
    );
    const result = await call('search_emails', { account: 'a', seen: false });
    expect(result.isError).toBeUndefined();
    expect(service.searchEmails).toHaveBeenCalledTimes(1);
  });
});

describe('hasSearchCriterion', () => {
  it('ignores location / presentation params and empty values', () => {
    expect(
      hasSearchCriterion({
        account: 'a',
        mailbox: 'INBOX',
        page: 1,
        pageSize: 20,
        preview: true,
        facets: ['sender'],
        query: '  ',
        keyword: [],
        header: {},
      }),
    ).toBe(false);
  });

  it('counts a query, a string filter, a boolean, a number or a header match', () => {
    expect(hasSearchCriterion({ query: 'facture' })).toBe(true);
    expect(hasSearchCriterion({ from: 'edf.fr' })).toBe(true);
    expect(hasSearchCriterion({ flagged: false })).toBe(true);
    expect(hasSearchCriterion({ larger_than: 100 })).toBe(true);
    expect(hasSearchCriterion({ header: { 'X-Tag': 'v' } })).toBe(true);
  });
});
