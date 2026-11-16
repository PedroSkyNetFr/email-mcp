/**
 * Tests du lot « connexions » sur ImapService : reprise de la détection de
 * stratégie de libellés, arrêt de find_email_folder au premier dossier, refus
 * serveur remontés tels quels, compteurs de la ressource `stats`.
 */

import type { IConnectionManager } from '../connections/types.js';
import ImapService from './imap.service.js';

function createClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    mailbox: { exists: 5 },
    capabilities: new Map<string, boolean>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn(),
    fetchOne: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    mailboxCreate: vi.fn().mockResolvedValue({}),
    mailboxRename: vi.fn().mockResolvedValue({}),
    mailboxDelete: vi.fn().mockResolvedValue({}),
    close: vi.fn(),
    _releaseFn: releaseFn,
  };
}

function createConnections(client: ReturnType<typeof createClient>) {
  return {
    getAccount: vi.fn(),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(client),
    createEphemeralImapClient: vi.fn().mockResolvedValue(client),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

/** Erreur telle qu'ImapFlow la lève sur une réponse NO. */
function imapNo(text: string): Error {
  return Object.assign(new Error('Command failed'), {
    responseStatus: 'NO',
    responseText: text,
    response: { tag: 'A5', command: 'NO' },
  });
}

describe('label strategy detection — retry after a transient failure (10a)', () => {
  it('does not pin a rejected detection: the next label call retries', async () => {
    const client = createClient();
    const connections = createConnections(client);
    // Premier appel : la connexion échoue ; ensuite elle répond.
    connections.getImapClient
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue(client);
    const service = new ImapService(connections);

    await expect(service.listLabels('test')).rejects.toThrow('ETIMEDOUT');
    // Avant correction : la promesse rejetée restait en cache et ce second
    // appel échouait encore, sans même retenter.
    await expect(service.listLabels('test')).resolves.toEqual([]);
  });
});

describe('findEmailFolder — stops at the first match (10b)', () => {
  it('searches INBOX and Sent first and stops at the first folder holding the message', async () => {
    const client = createClient();
    client.fetchOne.mockResolvedValue({
      headers: Buffer.from('Message-ID: <abc@example.com>\r\n'),
    });
    client.list.mockResolvedValue([
      { path: 'Projects', listed: true, flags: new Set() },
      { path: 'Archive', listed: true, flags: new Set(), specialUse: '\\Archive' },
      { path: 'Sent', listed: true, flags: new Set(), specialUse: '\\Sent' },
      { path: 'INBOX', listed: true, flags: new Set() },
    ]);
    // Le message est dans Sent ET dans Projects.
    const selected: string[] = [];
    client.getMailboxLock.mockImplementation(async (path: string) => {
      selected.push(path);
      return { release: vi.fn() };
    });
    client.search.mockImplementation(async () => {
      const current = selected[selected.length - 1];
      return current === 'Sent' || current === 'Projects' ? [7] : [];
    });
    const service = new ImapService(createConnections(client));

    const result = await service.findEmailFolder('test', '12', 'All Mail');

    expect(result.folders).toEqual(['Sent']);
    // Source (All Mail), puis INBOX, puis Sent — Archive et Projects jamais ouverts.
    expect(selected).toEqual(['All Mail', 'INBOX', 'Sent']);
  });
});

describe('server refusals keep the server text (5c)', () => {
  it('createMailbox reports the server text instead of "Command failed"', async () => {
    const client = createClient();
    client.mailboxCreate.mockRejectedValue(imapNo('[ALREADYEXISTS] Mailbox already exists'));
    const service = new ImapService(createConnections(client));

    await expect(service.createMailbox('test', 'Projects')).rejects.toThrow(
      'Creating mailbox "Projects" rejected by server: [ALREADYEXISTS] Mailbox already exists',
    );
  });

  it('moveEmail reports the server text', async () => {
    const client = createClient();
    client.messageMove.mockRejectedValue(imapNo('[TRYCREATE] No such mailbox'));
    const service = new ImapService(createConnections(client));

    await expect(service.moveEmail('test', '5', 'INBOX', 'Nope')).rejects.toThrow(
      'Moving message to "Nope" rejected by server: [TRYCREATE] No such mailbox',
    );
  });

  it('passes errors without a server response through untouched', async () => {
    const client = createClient();
    client.mailboxDelete.mockRejectedValue(new Error('socket hang up'));
    const service = new ImapService(createConnections(client));

    await expect(service.deleteMailbox('test', 'X')).rejects.toThrow(/^socket hang up$/);
  });

  it('label operations report the server text (keyword strategy)', async () => {
    const client = createClient();
    // Pas de X-GM-EXT-1 ni de dossier « Labels » : stratégie par mots-clés.
    client.messageFlagsAdd.mockRejectedValue(imapNo('Keywords are not permitted'));
    const service = new ImapService(createConnections(client));

    await expect(service.addLabel('test', '5', 'INBOX', 'Work')).rejects.toThrow(
      'rejected by server: Keywords are not permitted',
    );
  });
});

describe('getMailboxSnapshot (6)', () => {
  it('reads totals from STATUS and today from a UID-only SEARCH, never FETCHing', async () => {
    const client = createClient();
    client.status.mockResolvedValue({ messages: 42, unseen: 7 });
    client.search.mockResolvedValue([101, 102, 103]);
    const service = new ImapService(createConnections(client));

    const snapshot = await service.getMailboxSnapshot('test', 'INBOX');

    expect(snapshot).toEqual({ total: 42, unread: 7, receivedToday: 3 });
    expect(client.status).toHaveBeenCalledWith('INBOX', { messages: true, unseen: true });
    const [criteria, options] = client.search.mock.calls[0] as [{ since: Date }, unknown];
    expect(options).toEqual({ uid: true });
    // imapflow formate SINCE avec `toISOString()` : la date UTC du critère
    // doit être la date LOCALE du jour.
    const now = new Date();
    const localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(criteria.since.toISOString().slice(0, 10)).toBe(localDay);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(client._releaseFn).toHaveBeenCalled();
  });

  it('SINCE carries the local date even just after local midnight east of UTC (Paris)', async () => {
    // 00:30 à Paris le 15 juin = 22:30Z le 14 : un minuit local passé tel quel
    // à imapflow serait formaté « 14-Jun-2026 » et compterait deux jours.
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/Paris';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-14T22:30:00Z'));
    try {
      const client = createClient();
      client.status.mockResolvedValue({ messages: 1, unseen: 0 });
      client.search.mockResolvedValue([]);
      const service = new ImapService(createConnections(client));

      await service.getMailboxSnapshot('test', 'INBOX');

      const [criteria] = client.search.mock.calls[0] as [{ since: Date }];
      expect(criteria.since.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it('falls back to zero when STATUS is refused', async () => {
    const client = createClient();
    client.status.mockResolvedValue(false);
    const service = new ImapService(createConnections(client));

    await expect(service.getMailboxSnapshot('test')).resolves.toEqual({
      total: 0,
      unread: 0,
      receivedToday: 0,
    });
  });
});
