import type GraphClient from '../../services/graph/graph.client.js';
import { GraphError } from '../../services/graph/graph.client.js';
import type GraphService from '../../services/graph/graph.service.js';
import type GraphSendService from '../../services/graph/graph-send.service.js';
import type { AccountConfig } from '../../types/index.js';
import createGraphEngine from './graph-engine.js';
import { folderIdOf, messageIdOf } from './graph-reader.js';

// A fake Graph: each test routes request URLs to canned answers and records
// what the engine asked for.

type Route = (method: string, url: string, body: unknown) => unknown;

function fakeGraph(route: Route) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] =
    [];
  const client = {
    request: vi.fn(async (method: string, url: string, body?: unknown, headers = {}) => {
      calls.push({ method, url, body, headers });
      const answer = route(method, url, body);
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    getBinary: vi.fn(async (path: string) => Buffer.from(`RAW ${path}`.padEnd(100, '.'))),
  };
  const graph = {
    getEmail: vi.fn(),
    getEmailRaw: vi.fn(),
    downloadAttachment: vi.fn(),
    saveDraft: vi.fn(),
    deleteDraft: vi.fn(),
  };
  const send = { sendEmail: vi.fn(), sendDraft: vi.fn() };
  const account = { name: 'perso', email: 'me@outlook.test', backend: 'graph' } as AccountConfig;
  const engine = createGraphEngine(
    'perso',
    client as unknown as GraphClient,
    graph as unknown as GraphService,
    send as unknown as GraphSendService,
    () => account,
  );
  return { engine, calls, client, graph, send };
}

const message = (id: string, receivedDateTime: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Subject ${id}`,
  receivedDateTime,
  isRead: false,
  internetMessageId: `<${id}@outlook.test>`,
  ...extra,
});

describe('Graph engine: listMessages', () => {
  it('anchors pages on the arrival date and never repeats a message sharing that instant', async () => {
    const same = '2026-11-16T10:00:00Z';
    const { engine, calls } = fakeGraph((_m, url) => {
      // The page query always carries a $filter (in $expand): tell pages by the anchor.
      if (!url.includes('receivedDateTime le')) {
        return {
          value: [message('a', '2026-11-16T11:00:00Z'), message('b', same), message('c', same)],
        };
      }
      // Second page: Graph answers from the anchor instant, `b` included again.
      return {
        value: [message('b', same), message('c', same), message('d', '2026-11-16T09:00:00Z')],
      };
    });
    const inbox = folderIdOf('INBOX-ID');

    const first = await engine.listMessages(inbox, { pageSize: 2 });
    const second = await engine.listMessages(inbox, { pageSize: 2, page: first.next });

    expect(first.items.map((m) => m.subject)).toEqual(['Subject a', 'Subject b']);
    expect(second.items.map((m) => m.subject)).toEqual(['Subject c', 'Subject d']);
    expect(calls[1]?.url).toContain(`receivedDateTime le ${same}`);
    expect(calls[0]?.headers).toMatchObject({ Prefer: 'IdType="ImmutableId"' });
  });
});

describe('Graph engine: listChanges (delta)', () => {
  it('reports removals, follows pages, and completes on the deltaLink', async () => {
    const { engine } = fakeGraph((_m, url) =>
      url.startsWith('NEXT')
        ? {
            value: [{ id: 'gone', '@removed': { reason: 'deleted' } }],
            '@odata.deltaLink': 'DELTA',
          }
        : { value: [message('m1', '2026-11-16T10:00:00Z')], '@odata.nextLink': 'NEXT-1' },
    );
    const folder = folderIdOf('F');

    const first = await engine.listChanges(folder, null);
    const second = await engine.listChanges(folder, first.nextCursor);

    expect(first).toMatchObject({ complete: false, removed: [] });
    expect(first.added[0]).toMatchObject({
      id: messageIdOf('m1'),
      messageIdHeader: 'm1@outlook.test',
    });
    expect(first.added[0]?.raw?.toString()).toContain('/me/messages/m1/$value');
    expect(second).toMatchObject({ complete: true, removed: [messageIdOf('gone')] });
  });

  it('stops a page at maxBytes and resumes it without delivering a message twice', async () => {
    const page = {
      value: ['x', 'y', 'z'].map((id) => message(id, '2026-11-16T10:00:00Z')),
      '@odata.deltaLink': 'DELTA',
    };
    const { engine, calls } = fakeGraph(() => page);
    const folder = folderIdOf('F');

    const first = await engine.listChanges(folder, null, { maxBytes: 150 }); // 100 bytes per source
    const second = await engine.listChanges(folder, first.nextCursor, { maxBytes: 150 });

    expect(first.added.map((m) => m.id)).toEqual([messageIdOf('x'), messageIdOf('y')]);
    expect(first.complete).toBe(false);
    expect(second.added.map((m) => m.id)).toEqual([messageIdOf('z')]);
    expect(second.complete).toBe(true);
    expect(calls[1]?.url).toBe(calls[0]?.url); // same Graph page asked again
  });

  it('turns an expired delta token into a reset', async () => {
    const { engine } = fakeGraph(
      () => new GraphError('Gone', 410, '{"error":{"code":"syncStateNotFound"}}'),
    );
    const folder = folderIdOf('F');
    const first = await fakeGraph(() => ({
      value: [],
      '@odata.deltaLink': 'DELTA',
    })).engine.listChanges(folder, null);

    const batch = await engine.listChanges(folder, first.nextCursor);

    expect(batch).toMatchObject({ reset: true, added: [], removed: [] });
  });
});

describe('Graph engine: changes', () => {
  it('maps flags, answered (last verb) and keywords (categories) onto one PATCH', async () => {
    const { engine, calls } = fakeGraph((method) =>
      method === 'GET' ? { categories: ['Old', 'Keep'] } : undefined,
    );

    const result = await engine.setFlags([messageIdOf('m1')], {
      seen: true,
      flagged: true,
      answered: true,
      addKeywords: ['Chantier'],
      removeKeywords: ['Old'],
    });
    const patch = calls.find((c) => c.method === 'PATCH');

    expect(result).toEqual({ succeeded: [messageIdOf('m1')], failed: [] });
    expect(patch?.body).toEqual({
      isRead: true,
      flag: { flagStatus: 'flagged' },
      singleValueExtendedProperties: [{ id: 'Integer 0x1081', value: '102' }],
      categories: ['Keep', 'Chantier'],
    });
  });

  it('deletes to Deleted Items, and for good once there; reports each failure', async () => {
    const { engine, calls } = fakeGraph((method, url) => {
      if (url.includes('/mailFolders/deleteditems')) return { id: 'TRASH' };
      if (url.includes('/me/messages/broken')) return new GraphError('Not found', 404, '');
      if (url.includes('?$select=parentFolderId')) {
        return { parentFolderId: url.includes('/in-trash') ? 'TRASH' : 'INBOX' };
      }
      return method === 'POST' ? {} : undefined;
    });

    const result = await engine.delete([
      messageIdOf('m1'),
      messageIdOf('in-trash'),
      messageIdOf('broken'),
    ]);

    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      '/me/messages/m1/move',
      '/me/messages/in-trash/permanentDelete',
    ]);
    expect(result.succeeded).toEqual([messageIdOf('m1'), messageIdOf('in-trash')]);
    expect(result.failed).toMatchObject([{ id: messageIdOf('broken') }]);
  });
});

describe('Graph engine: sending', () => {
  it('does not send a reply unthreaded when the original cannot be read', async () => {
    const { engine, send, graph, calls } = fakeGraph((method, url) =>
      method === 'GET' && url.startsWith('/me/messages/orig')
        ? message('orig', '2026-11-16T10:00:00Z')
        : undefined,
    );
    graph.getEmail.mockRejectedValue(new Error('body unavailable'));

    await expect(
      engine.send({
        to: ['bob@example.test'],
        subject: 'Re: x',
        text: 'ok',
        replyTo: { id: messageIdOf('orig') },
      }),
    ).rejects.toThrow('body unavailable');
    expect(send.sendEmail).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('marks the original answered after a threaded send', async () => {
    const { engine, send, graph, calls } = fakeGraph((method, url) =>
      method === 'GET' && url.startsWith('/me/messages/orig')
        ? message('orig', '2026-11-16T10:00:00Z')
        : undefined,
    );
    graph.getEmail.mockResolvedValue({ references: ['root@outlook.test'], attachments: [] });
    send.sendEmail.mockResolvedValue({ messageId: '<new@outlook.test>', status: 'sent' });

    const result = await engine.send({
      to: ['bob@example.test'],
      bcc: ['boss@example.test'],
      subject: 'Re: x',
      text: 'ok',
      replyTo: { id: messageIdOf('orig') },
    });

    expect(send.sendEmail).toHaveBeenCalledWith(
      'perso',
      expect.objectContaining({
        bcc: ['boss@example.test'],
        inReplyTo: '<orig@outlook.test>',
        references: ['<root@outlook.test>'],
      }),
    );
    expect(result).toEqual({
      messageIdHeader: 'new@outlook.test',
      sentCopy: 'by-server',
      warnings: [],
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      singleValueExtendedProperties: [{ id: 'Integer 0x1081', value: '102' }],
    });
  });

  it('hands out the immutable id of a saved draft', async () => {
    const { engine, graph } = fakeGraph((_m, url) =>
      url === '/me/translateExchangeIds'
        ? { value: [{ sourceId: 'REG', targetId: 'IMM' }] }
        : undefined,
    );
    graph.saveDraft.mockResolvedValue({ id: 'REG', mailbox: 'Drafts' });

    await expect(engine.saveDraft({ to: ['a@b.test'], subject: 's', text: 't' })).resolves.toBe(
      messageIdOf('IMM'),
    );
  });

  it('answers unsupported to waitForChange: Graph accounts are polled', async () => {
    const { engine } = fakeGraph(() => undefined);

    await expect(engine.waitForChange({ folderIds: [], maxMs: 10 })).resolves.toBe('unsupported');
  });
});
