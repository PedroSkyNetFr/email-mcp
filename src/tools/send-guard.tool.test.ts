/**
 * Garde anti-doublon vue des outils, comme par un client MCP qui relance un
 * appel : même comportement sur un compte IMAP/SMTP et sur un compte Graph
 * (la garde vit au-dessus du routeur de backends), rejeu par clé, échec qui
 * ne bloque pas, issue incertaine Graph, planification.
 */

/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { z } from 'zod';

import UncertainSendError from '../services/graph/uncertain-send-error.js';
import { createSendRouter } from '../services/mail-router.js';
import type { IMailService } from '../services/mail-service.types.js';
import type SchedulerService from '../services/scheduler.service.js';
import SendGuard from '../services/send-guard.js';
import type { AccountConfig } from '../types/index.js';
import registerDraftTools from './drafts.tool.js';
import registerSchedulerTools from './scheduler.tool.js';
import registerSendTools from './send.tool.js';

vi.mock('../safety/audit.js', () => ({ default: { log: vi.fn().mockResolvedValue(undefined) } }));

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}>;

/** Serveur factice : schéma + gestionnaire de chaque outil enregistré. */
function captureTools() {
  const tools = new Map<string, { schema: z.ZodType; handler: Handler }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodType }, handler: Handler) => {
      tools.set(name, { schema: config.inputSchema, handler });
    },
  } as never;
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    const result = await tool.handler(tool.schema.parse(input) as Record<string, unknown>);
    return { ...result, text: result.content.map((c) => c.text).join('\n') };
  };
  return { server, call };
}

const accounts: Record<string, Partial<AccountConfig>> = {
  imap: { name: 'imap', backend: undefined },
  exchange: { name: 'exchange', backend: 'graph' },
};

function setup(windowMinutes = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-tool-'));
  const guard = new SendGuard({ windowMinutes, filePath: join(dir, 'send-guard.json') });
  const smtp = {
    sendEmail: vi.fn().mockResolvedValue({ messageId: '<smtp-1@x>', status: 'sent' }),
    replyToEmail: vi.fn().mockResolvedValue({ messageId: '<smtp-r@x>', status: 'sent' }),
    forwardEmail: vi.fn().mockResolvedValue({ messageId: '<smtp-f@x>', status: 'sent' }),
    sendDraft: vi.fn().mockResolvedValue({ messageId: '<smtp-d@x>', status: 'sent' }),
  };
  // Graph ne rend pas de Message-ID.
  const graph = {
    sendEmail: vi.fn().mockResolvedValue({ messageId: '', status: 'sent' }),
    replyToEmail: vi.fn().mockResolvedValue({ messageId: '', status: 'sent' }),
    forwardEmail: vi.fn().mockResolvedValue({ messageId: '', status: 'sent' }),
    sendDraft: vi.fn().mockResolvedValue({ messageId: '', status: 'sent' }),
  };
  const router = createSendRouter(
    smtp as never,
    graph as never,
    (name) => accounts[name] as AccountConfig | undefined,
  );
  const mail = { resolveAttachmentsForSend: vi.fn() } as unknown as IMailService;
  const { server, call } = captureTools();
  registerSendTools(server, router, mail, guard);
  registerDraftTools(server, mail, router, guard);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { smtp, graph, call, cleanup, guard, server };
}

const email = (account: string, extra: Record<string, unknown> = {}) => ({
  account,
  to: ['dest@example.com'],
  subject: 'Devis',
  body: 'Voici le devis.',
  ...extra,
});

describe.each([
  ['imap', 'smtp'],
  ['exchange', 'graph'],
] as const)('send tools under the duplicate guard — %s account', (account, backend) => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.cleanup());

  it('send_email: a retried identical call is refused, nothing sent twice', async () => {
    const first = await ctx.call('send_email', email(account));
    const second = await ctx.call('send_email', email(account));

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/Refused: identical to an email already sent at \d\d:\d\d/);
    expect(second.text).toContain('allow_duplicate: true');
    expect(ctx[backend].sendEmail).toHaveBeenCalledTimes(1);
  });

  it('send_email: allow_duplicate sends the deliberate second copy', async () => {
    await ctx.call('send_email', email(account));
    const again = await ctx.call('send_email', email(account, { allow_duplicate: true }));

    expect(again.isError).toBeUndefined();
    expect(ctx[backend].sendEmail).toHaveBeenCalledTimes(2);
  });

  it('send_email: a different body is a different message', async () => {
    await ctx.call('send_email', email(account));
    await ctx.call('send_email', email(account, { body: 'Autre texte.' }));
    expect(ctx[backend].sendEmail).toHaveBeenCalledTimes(2);
  });

  it('send_email: the same idempotency_key returns the first result without sending', async () => {
    await ctx.call('send_email', email(account, { idempotency_key: 'devis-42' }));
    const replay = await ctx.call('send_email', email(account, { idempotency_key: 'devis-42' }));

    expect(replay.isError).toBeUndefined();
    expect(replay.text).toMatch(/Already sent — not repeated/);
    expect(ctx[backend].sendEmail).toHaveBeenCalledTimes(1);
  });

  it('send_email: a clean failure does not block the retry', async () => {
    ctx[backend].sendEmail.mockRejectedValueOnce(new Error('535 auth failed'));
    const failed = await ctx.call('send_email', email(account));
    const retry = await ctx.call('send_email', email(account));

    expect(failed.isError).toBe(true);
    expect(retry.isError).toBeUndefined();
    expect(ctx[backend].sendEmail).toHaveBeenCalledTimes(2);
  });

  it('reply_email / forward_email / send_draft: a retry is refused', async () => {
    const reply = { account, emailId: 'M1', body: 'Merci' };
    await ctx.call('reply_email', reply);
    expect((await ctx.call('reply_email', reply)).isError).toBe(true);
    // Autre original : pas un doublon.
    await ctx.call('reply_email', { ...reply, emailId: 'M2' });
    expect(ctx[backend].replyToEmail).toHaveBeenCalledTimes(2);

    const forward = { account, emailId: 'M1', to: ['x@example.com'] };
    await ctx.call('forward_email', forward);
    expect((await ctx.call('forward_email', forward)).isError).toBe(true);
    expect(ctx[backend].forwardEmail).toHaveBeenCalledTimes(1);

    await ctx.call('send_draft', { account, id: 'D7' });
    expect((await ctx.call('send_draft', { account, id: 'D7' })).isError).toBe(true);
    expect(ctx[backend].sendDraft).toHaveBeenCalledTimes(1);
  });
});

describe('Graph uncertain outcome', () => {
  it('records the attempt, so that a blind resend is refused with an explicit warning', async () => {
    const ctx = setup();
    try {
      ctx.graph.sendEmail.mockRejectedValueOnce(
        new UncertainSendError('Send outcome uncertain: the request to send failed (timeout)'),
      );
      const first = await ctx.call('send_email', email('exchange'));
      const retry = await ctx.call('send_email', email('exchange'));

      expect(first.isError).toBe(true);
      expect(first.text).toContain('Send outcome uncertain');
      expect(retry.isError).toBe(true);
      expect(retry.text).toMatch(/outcome was UNCERTAIN.*Check the Sent folder/s);
      expect(ctx.graph.sendEmail).toHaveBeenCalledTimes(1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('duplicate_send_window_minutes = 0', () => {
  it('disables the guard', async () => {
    const ctx = setup(0);
    try {
      await ctx.call('send_email', email('imap'));
      await ctx.call('send_email', email('imap'));
      expect(ctx.smtp.sendEmail).toHaveBeenCalledTimes(2);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('schedule_email under the guard', () => {
  it('refuses a retried schedule, but never blocks the matching immediate send', async () => {
    const ctx = setup();
    try {
      const scheduler = {
        schedule: vi.fn().mockResolvedValue({ id: 'sch-1', sendAt: '2026-12-01T09:00:00Z' }),
      } as unknown as SchedulerService & { schedule: ReturnType<typeof vi.fn> };
      registerSchedulerTools(ctx.server, scheduler, ctx.guard);

      const params = { ...email('imap'), send_at: '2026-12-01T09:00:00Z' };
      await ctx.call('schedule_email', params);
      const retry = await ctx.call('schedule_email', params);
      expect(retry.isError).toBe(true);
      expect(retry.text).toMatch(/already scheduled at .*schedule_id sch-1/);
      expect(scheduler.schedule).toHaveBeenCalledTimes(1);

      // Une planification n'est pas un envoi : le même message envoyé tout de
      // suite n'est pas pris pour un doublon (le planificateur, lui, envoie
      // sans passer par la garde).
      const now = await ctx.call('send_email', email('imap'));
      expect(now.isError).toBeUndefined();
    } finally {
      ctx.cleanup();
    }
  });
});
