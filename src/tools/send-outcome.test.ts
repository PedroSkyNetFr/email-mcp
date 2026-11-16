import type { McpServer } from '@modelcontextprotocol/server';
import type { IMailService } from '../services/mail-service.types.js';
import type { ISendService } from '../services/send-service.types.js';
import registerDraftTools from './drafts.tool.js';
import describeSendOutcome from './send-outcome.js';

vi.mock('../safety/audit.js', () => ({ default: { log: vi.fn().mockResolvedValue(undefined) } }));

describe('describeSendOutcome', () => {
  it('stays silent for an intentional skip and nothing else to report', () => {
    expect(
      describeSendOutcome({
        messageId: 'x',
        status: 'sent',
        sentCopy: { kind: 'skipped', reason: 'r' },
      }),
    ).toBe('');
  });

  it('surfaces a failed Sent copy and warns against resending', () => {
    const text = describeSendOutcome({
      messageId: 'x',
      status: 'sent',
      sentCopy: { kind: 'failed', error: 'quota' },
    });
    expect(text).toContain('quota');
    expect(text).toContain('Do not resend');
  });

  it('lists warnings', () => {
    const text = describeSendOutcome({ messageId: 'x', status: 'sent', warnings: ['a', 'b'] });
    expect(text).toBe('\n⚠️ a\n⚠️ b');
  });
});

describe('send_draft tool outcome', () => {
  function handlerFor(sendDraft: ReturnType<typeof vi.fn>) {
    const registerTool = vi.fn();
    registerDraftTools(
      { registerTool } as unknown as McpServer,
      {} as IMailService,
      { sendDraft } as unknown as ISendService,
    );
    const call = registerTool.mock.calls.find((c) => c[0] === 'send_draft');
    return call?.at(-1) as (args: Record<string, unknown>) => Promise<{
      isError?: boolean;
      content: { text: string }[];
    }>;
  }

  it('reports delivery success, not an error, when deleting the draft failed', async () => {
    const handler = handlerFor(
      vi.fn().mockResolvedValue({
        messageId: '<sent@example.test>',
        status: 'sent',
        sentCopy: { kind: 'filed' },
        draftCleanup: { kind: 'failed', error: 'IMAP unavailable' },
      }),
    );

    const result = await handler({ account: 'test', id: 7 });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Draft sent');
    expect(result.content[0].text).toContain('IMAP unavailable');
    expect(result.content[0].text).toContain('Do not resend');
    expect(result.content[0].text).not.toContain('Draft removed');
  });

  it('says the draft was kept when the Sent copy failed', async () => {
    const handler = handlerFor(
      vi.fn().mockResolvedValue({
        messageId: '<sent@example.test>',
        status: 'sent',
        sentCopy: { kind: 'failed', error: 'quota' },
        draftCleanup: { kind: 'kept', reason: 'the copy to the Sent folder failed' },
      }),
    );

    const result = await handler({ account: 'test', id: 7 });

    expect(result.content[0].text).toContain('Draft kept');
  });

  it('keeps the historical wording for Graph (no detailed outcome)', async () => {
    const handler = handlerFor(vi.fn().mockResolvedValue({ messageId: '', status: 'sent' }));
    const result = await handler({ account: 'work', id: 'AAMk' });
    expect(result.content[0].text).toContain('Draft removed from folder.');
  });
});
