import type { AccountConfig } from '../../types/index.js';
import type GraphClient from './graph.client.js';
import GraphSendService from './graph-send.service.js';

const account: AccountConfig = {
  name: 'work',
  email: 'me@contoso.com',
  username: 'me@contoso.com',
  backend: 'graph',
  imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
};

/**
 * Client Graph simulé : `routes` associe « MÉTHODE chemin » (préfixe) à une
 * réponse ; chaque appel est consigné dans `calls`.
 */
function fakeClient(
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
  const uploadLargeAttachment = vi.fn().mockResolvedValue(undefined);
  const client = { request, collect, uploadLargeAttachment } as unknown as GraphClient;
  return { client, calls, request, collect, uploadLargeAttachment };
}

function service(client: GraphClient, overrides: Partial<AccountConfig> = {}) {
  return new GraphSendService(new Map([['work', client]]), () => ({ ...account, ...overrides }));
}

describe('GraphSendService', () => {
  describe('forwardEmail', () => {
    it('passes Cc through message.ccRecipients (they were silently dropped)', async () => {
      const fake = fakeClient();
      await service(fake.client).forwardEmail('work', {
        emailId: 'AAA',
        to: ['to@example.com'],
        cc: ['cc@example.com'],
        body: 'FYI',
      });

      expect(fake.calls).toEqual([
        {
          method: 'POST',
          path: '/me/messages/AAA/forward',
          body: {
            comment: 'FYI',
            toRecipients: [{ emailAddress: { address: 'to@example.com' } }],
            message: { ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }] },
          },
        },
      ]);
    });

    it('includeAttachments=false: createForward, delete non-inline attachments, send', async () => {
      const fake = fakeClient(
        { 'POST /me/messages/AAA/createForward': { id: 'D1' } },
        {
          '/me/messages/D1/attachments': [
            { id: 'att1', isInline: false },
            { id: 'logo', isInline: true },
          ],
        },
      );
      await service(fake.client).forwardEmail('work', {
        emailId: 'AAA',
        to: ['to@example.com'],
        includeAttachments: false,
      });

      expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /me/messages/AAA/createForward',
        'DELETE /me/messages/D1/attachments/att1',
        'POST /me/messages/D1/send',
      ]);
    });

    it('deletes the intermediate draft when a step fails, and rethrows', async () => {
      const fake = fakeClient(
        {
          'POST /me/messages/AAA/createForward': { id: 'D1' },
          'DELETE /me/messages/D1/attachments/att1': new Error('boom'),
        },
        { '/me/messages/D1/attachments': [{ id: 'att1', isInline: false }] },
      );
      await expect(
        service(fake.client).forwardEmail('work', {
          emailId: 'AAA',
          to: ['to@example.com'],
          includeAttachments: false,
        }),
      ).rejects.toThrow('boom');
      expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/me/messages/D1' });
      expect(fake.calls.some((c) => c.path.endsWith('/send'))).toBe(false);
    });
  });

  describe('replyToEmail', () => {
    it('keeps the native /reply (Graph quotes the original) by default', async () => {
      const fake = fakeClient();
      await service(fake.client).replyToEmail('work', { emailId: 'AAA', body: 'Merci' });
      expect(fake.calls).toEqual([
        { method: 'POST', path: '/me/messages/AAA/reply', body: { comment: 'Merci' } },
      ]);
    });

    it('quoteOriginal=false: createReply, body replaced by the reply alone, send', async () => {
      const fake = fakeClient({ 'POST /me/messages/AAA/createReplyAll': { id: 'D2' } });
      await service(fake.client).replyToEmail('work', {
        emailId: 'AAA',
        body: 'Merci',
        replyAll: true,
        quoteOriginal: false,
      });

      expect(fake.calls).toEqual([
        { method: 'POST', path: '/me/messages/AAA/createReplyAll', body: {} },
        {
          method: 'PATCH',
          path: '/me/messages/D2',
          body: { body: { contentType: 'Text', content: 'Merci' } },
        },
        { method: 'POST', path: '/me/messages/D2/send', body: undefined },
      ]);
    });

    it('includeAttachments=true copies the original file attachments into the reply', async () => {
      const fake = fakeClient(
        {
          'GET /me/messages/AAA/attachments/a1': {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'plan.pdf',
            contentType: 'application/pdf',
            contentBytes: Buffer.from('PDF').toString('base64'),
          },
          'POST /me/messages/AAA/createReply': { id: 'D3' },
        },
        { '/me/messages/AAA/attachments': [{ id: 'a1', name: 'plan.pdf', size: 3 }] },
      );
      await service(fake.client).replyToEmail('work', {
        emailId: 'AAA',
        body: 'Ci-joint',
        includeAttachments: true,
      });

      const add = fake.calls.find((c) => c.path === '/me/messages/D3/attachments');
      expect(add?.body).toMatchObject({ name: 'plan.pdf', contentBytes: 'UERG' });
      expect(fake.calls.at(-1)?.path).toBe('/me/messages/D3/send');
    });

    it('includeAttachments=true refuses an attached Outlook item explicitly', async () => {
      const fake = fakeClient(
        {
          'GET /me/messages/AAA/attachments/i1': {
            '@odata.type': '#microsoft.graph.itemAttachment',
            name: 'Réunion',
          },
        },
        { '/me/messages/AAA/attachments': [{ id: 'i1', name: 'Réunion', size: 10 }] },
      );
      await expect(
        service(fake.client).replyToEmail('work', {
          emailId: 'AAA',
          body: 'x',
          includeAttachments: true,
        }),
      ).rejects.toThrow(/Réunion.*not a file attachment.*Nothing was sent/s);
      expect(fake.calls.some((c) => c.path.includes('reply'))).toBe(false);
    });
  });

  describe('sendEmail', () => {
    it('threads a reply via createReply when inReplyTo matches a message', async () => {
      const fake = fakeClient({
        'GET /me/messages?$filter=': { value: [{ id: 'ORIG' }] },
        'POST /me/messages/ORIG/createReply': { id: 'D4' },
      });
      const result = await service(fake.client).sendEmail('work', {
        to: ['a@example.com'],
        subject: 'Re: x',
        body: 'planifié',
        inReplyTo: "<o'id@example.com>",
      });

      const lookup = decodeURIComponent(fake.calls[0].path);
      expect(lookup).toContain("internetMessageId eq '<o''id@example.com>'");
      expect(fake.calls.map((c) => `${c.method} ${c.path}`).slice(1)).toEqual([
        'POST /me/messages/ORIG/createReply',
        'PATCH /me/messages/D4',
        'POST /me/messages/D4/send',
      ]);
      expect(fake.calls[2].body).toMatchObject({
        subject: 'Re: x',
        body: { contentType: 'Text', content: 'planifié' },
      });
      expect(result.warnings).toBeUndefined();
    });

    it('falls back to sendMail with a warning when the original is not found', async () => {
      const fake = fakeClient({ 'GET /me/messages?$filter=': { value: [] } });
      const result = await service(fake.client).sendEmail('work', {
        to: ['a@example.com'],
        subject: 'Re: x',
        body: 'b',
        inReplyTo: '<gone@example.com>',
      });

      expect(fake.calls.at(-1)?.path).toBe('/me/sendMail');
      expect(result.warnings?.[0]).toMatch(/not found.*without threading headers/);
    });

    it('refuses a message above the account limit before calling Graph', async () => {
      const fake = fakeClient();
      await expect(
        service(fake.client, { maxMessageMb: 1 }).sendEmail('work', {
          to: ['a@example.com'],
          subject: 's',
          body: 'b',
          attachments: [
            {
              filename: 'big.bin',
              content: Buffer.alloc(900 * 1024),
              contentType: 'application/octet-stream',
            },
          ],
        }),
      ).rejects.toThrow(/too large/);
      expect(fake.calls).toHaveLength(0);
    });
  });
});
