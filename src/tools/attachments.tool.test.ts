/**
 * Outils de pièces jointes vus d'un client MCP : get_email affiche le partId
 * de chaque pièce (images inline marquées), download_attachment /
 * save_attachment le transmettent au backend, un nom ambigu remonte en erreur
 * lisible.
 */

import type { IMailService } from '@pedroskynet/email-core/services/mail-service.types.js';
import type { z } from 'zod';
import type { Email } from '../types/index.js';
import registerAttachmentTools from './attachments.tool.js';
import registerEmailsTools from './emails.tool.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}>;

function captureTools(register: (server: never) => void) {
  const tools = new Map<string, { schema: z.ZodType; handler: Handler }>();
  register({
    registerTool: (name: string, config: { inputSchema: z.ZodType }, handler: Handler) => {
      tools.set(name, { schema: config.inputSchema, handler });
    },
  } as never);
  return async (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    const result = await tool.handler(tool.schema.parse(input) as Record<string, unknown>);
    return { ...result, text: result.content.map((c) => c.text).join('\n') };
  };
}

const outlookMail: Email = {
  id: '42',
  subject: 'Signature',
  from: { address: 'a@example.com' },
  to: [{ address: 'b@example.com' }],
  date: '2026-11-01T10:00:00.000Z',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: true,
  labels: [],
  messageId: '<m1@example.com>',
  bodyText: 'Bonjour',
  headers: {},
  attachments: [
    { filename: 'image001.png', mimeType: 'image/png', size: 1000, partId: '2' },
    { filename: 'image001.png', mimeType: 'image/png', size: 2000, partId: '3' },
    {
      filename: 'logo.png',
      mimeType: 'image/png',
      size: 300,
      partId: '1.2',
      contentId: 'logo@x',
      inline: true,
    },
  ],
};

describe('attachment tools — partId', () => {
  it('get_email lists every attachment with its partId and marks inline images', async () => {
    const mail = { getEmail: vi.fn().mockResolvedValue(outlookMail) } as unknown as IMailService;
    const call = captureTools((server) => registerEmailsTools(server, mail, {} as never));

    const { text } = await call('get_email', { account: 'a', emailId: '42' });

    expect(text).toContain('image001.png (image/png, 1000B, partId 2)');
    expect(text).toContain('image001.png (image/png, 2.0KB, partId 3)');
    expect(text).toContain('logo.png (image/png, 300B, partId 1.2, inline cid:logo@x)');
  });

  it('download_attachment passes partId first, filename as fallback', async () => {
    const downloadAttachment = vi.fn().mockResolvedValue({
      filename: 'image001.png',
      mimeType: 'image/png',
      size: 3,
      contentBase64: 'QUJD',
    });
    const mail = { downloadAttachment } as unknown as IMailService;
    const call = captureTools((server) => registerAttachmentTools(server, mail, {} as never));

    await call('download_attachment', { account: 'a', id: '42', partId: '3' });
    await call('download_attachment', { account: 'a', id: '42', filename: 'devis.pdf' });

    expect(downloadAttachment.mock.calls[0][3]).toEqual({ partId: '3' });
    expect(downloadAttachment.mock.calls[1][3]).toEqual({ filename: 'devis.pdf' });
  });

  it('download_attachment surfaces the ambiguity error and requires a selector', async () => {
    const mail = {
      downloadAttachment: vi
        .fn()
        .mockRejectedValue(new Error('Ambiguous attachment name "image001.png": 2 attachments')),
    } as unknown as IMailService;
    const call = captureTools((server) => registerAttachmentTools(server, mail, {} as never));

    const ambiguous = await call('download_attachment', {
      account: 'a',
      id: '42',
      filename: 'image001.png',
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('Ambiguous attachment name');

    const none = await call('download_attachment', { account: 'a', id: '42' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('Provide partId or filename');
  });

  it('save_attachment passes partId through to the backend', async () => {
    const saveAttachmentToDisk = vi
      .fn()
      .mockResolvedValue({ path: '/tmp/image001.png', size: 3, mimeType: 'image/png' });
    const mail = { saveAttachmentToDisk } as unknown as IMailService;
    const call = captureTools((server) => registerAttachmentTools(server, mail, {} as never));

    const result = await call('save_attachment', {
      account: 'a',
      emailId: '42',
      partId: '3',
      destination: '/tmp',
    });

    expect(result.isError).toBeUndefined();
    expect(saveAttachmentToDisk.mock.calls[0][3]).toEqual({ partId: '3' });
  });
});
