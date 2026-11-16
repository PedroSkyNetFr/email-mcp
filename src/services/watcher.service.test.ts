import fs from 'node:fs/promises';
import path from 'node:path';
import { mcpLog } from '@pedroskynet/email-core/logging.js';
import type { AccountConfig, WatcherConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import WatcherService from './watcher.service.js';
import { readWatermark, writeWatermark } from './watcher-state.js';

// Le watcher persiste sa position sous XDG_STATE_HOME, résolu au chargement de
// xdg.ts : le rediriger AVANT tout import (vi.hoisted passe devant les
// imports), sinon une exécution des tests réécrirait les vrais repères et le
// prochain démarrage réel reprendrait d'un UID inventé ici.
const { stateHome } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  const dir = `${base}/email-mcp-watcher-test-${process.pid}-${Date.now()}`;
  process.env.XDG_STATE_HOME = dir;
  return { stateHome: dir };
});
const stateDir = path.join(stateHome, 'email-mcp', 'watcher');

beforeEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
  vi.mocked(eventBus.emit).mockClear();
});

afterAll(async () => {
  await fs.rm(stateHome, { recursive: true, force: true });
});

// Instances créées par le mock, pour piloter les événements IMAP d'un test.
const { imapInstances, mockControl } = vi.hoisted(() => ({
  /** `failNextLock` : la prochaine instance refuse le SELECT (getMailboxLock). */
  mockControl: {
    failNextLock: false,
    uidNext: 100,
    uidValidity: 7n,
    /** UID « arrivés pendant l'arrêt » : réponse du SEARCH et du FETCH du rattrapage. */
    missed: [] as number[],
  },
  imapInstances: [] as {
    options: Record<string, unknown>;
    on: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getMailboxLock: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
  }[],
}));

// Mock imapflow module
vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;
    mailbox = { uidNext: mockControl.uidNext, uidValidity: mockControl.uidValidity };
    search = vi.fn().mockResolvedValue([...mockControl.missed]);
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    getMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
    on = vi.fn();
    fetch = vi.fn().mockImplementation((range: string) => {
      const wanted = new Set(String(range).split(',').map(Number));
      const uids = mockControl.missed.filter((uid) => wanted.has(uid));
      // eslint-disable-next-line @stylistic/wrap-iife -- même motif que les autres mocks de fetch
      return (async function* gen() {
        for (const uid of uids) {
          yield { uid, flags: new Set<string>(), envelope: { subject: `m${uid}` } };
        }
      })();
    });
    close = vi.fn();
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      if (mockControl.failNextLock) {
        mockControl.failNextLock = false;
        this.getMailboxLock = vi.fn().mockRejectedValue(new Error('NONEXISTENT'));
      }
      imapInstances.push(this);
    }
  }
  return { ImapFlow: MockImapFlow };
});

// Mock logging to prevent side effects
vi.mock('@pedroskynet/email-core/logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// Mock event bus
vi.mock('./event-bus.js', () => ({
  default: { emit: vi.fn() },
}));

const testAccount: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('WatcherService', () => {
  it('does not start when disabled', async () => {
    const config: WatcherConfig = { enabled: false, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    expect(watcher.getStatus()).toHaveLength(0);
  });

  it('returns status after start', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    const status = watcher.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].account).toBe('test');
    expect(status[0].folder).toBe('INBOX');
    expect(status[0].connected).toBe(true);
    await watcher.stop();
  });

  it('stops all connections', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    await watcher.stop();
    expect(watcher.getStatus()).toHaveLength(0);
  });

  it('notifies a new email whose Date header imapflow could not parse', async () => {
    // imapflow garde l'en-tête Date brut (string) quand il est illisible.
    // L'ancien `date.toISOString()` levait alors une TypeError et toute la
    // notification était perdue.
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    const client = imapInstances[imapInstances.length - 1];
    client.fetch.mockReturnValue(
      // eslint-disable-next-line @stylistic/wrap-iife -- même motif que les autres mocks de fetch
      (async function* gen() {
        yield {
          uid: 100,
          flags: new Set<string>(),
          envelope: { subject: 'Hello', date: 'not a real date' },
        };
      })(),
    );
    const existsHandler = client.on.mock.calls.find(
      ([event]) => event === 'exists',
    )?.[1] as (data: { path: string; count: number; prevCount: number }) => void;

    existsHandler({ path: 'INBOX', count: 2, prevCount: 1 });

    await vi.waitFor(() => {
      expect(eventBus.emit).toHaveBeenCalled();
    });
    const [, payload] = vi.mocked(eventBus.emit).mock.calls[0] as [
      string,
      { emails: { subject: string; date: string }[] },
    ];
    expect(payload.emails[0].subject).toBe('Hello');
    expect(Number.isNaN(Date.parse(payload.emails[0].date))).toBe(false);
    await watcher.stop();
  });

  it('starts idle for multiple folders', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX', 'Sent'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    const status = watcher.getStatus();
    expect(status).toHaveLength(2);
    await watcher.stop();
  });

  // -------------------------------------------------------------------------
  // Lot connexions (point 8)
  // -------------------------------------------------------------------------

  it('authenticates an OAuth2 account with an access token from the token service', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const oauthAccount: AccountConfig = {
      ...testAccount,
      password: undefined,
      oauth2: { provider: 'google', clientId: 'id', clientSecret: 's', refreshToken: 'r' },
    };
    const oauthService = { getAccessToken: vi.fn().mockResolvedValue('ya29.token') };
    const watcher = new WatcherService(config, [oauthAccount], oauthService as never);
    await watcher.start();

    const client = imapInstances[imapInstances.length - 1];
    // Avant : `accessToken: account.password` — vide pour un compte OAuth2.
    expect(client.options.auth).toEqual({ user: 'test@example.com', accessToken: 'ya29.token' });
    expect(oauthService.getAccessToken).toHaveBeenCalledWith(oauthAccount.oauth2);
    await watcher.stop();
  });

  it('skips Graph-backed accounts', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const before = imapInstances.length;
    const watcher = new WatcherService(config, [{ ...testAccount, backend: 'graph' }]);
    await watcher.start();
    expect(watcher.getStatus()).toHaveLength(0);
    expect(imapInstances.length).toBe(before);
    await watcher.stop();
  });

  it('requires STARTTLS when the account asks for it', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [
      { ...testAccount, imap: { ...testAccount.imap, port: 143, tls: false, starttls: true } },
    ]);
    await watcher.start();
    const client = imapInstances[imapInstances.length - 1];
    expect(client.options).toMatchObject({ doSTARTTLS: true, secure: false, maxIdleTime: 1740000 });
    await watcher.stop();
  });

  it('fetches new mail by UID range (third fetch argument)', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    await watcher.start();
    const client = imapInstances[imapInstances.length - 1];
    client.fetch.mockReturnValue(
      // eslint-disable-next-line @stylistic/wrap-iife -- même motif que les autres mocks de fetch
      (async function* gen() {})(),
    );
    const existsHandler = client.on.mock.calls.find(
      ([event]) => event === 'exists',
    )?.[1] as (data: { path: string; count: number; prevCount: number }) => void;

    existsHandler({ path: 'INBOX', count: 2, prevCount: 1 });

    await vi.waitFor(() => {
      expect(client.fetch).toHaveBeenCalled();
    });
    const [range, , options] = client.fetch.mock.calls[0] as [string, unknown, unknown];
    expect(range).toBe('100:*');
    expect(options).toEqual({ uid: true });
    await watcher.stop();
  });

  it('closes the client when SELECT fails after connect, and registers listeners before connect', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['Missing'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [testAccount]);
    const before = imapInstances.length;
    mockControl.failNextLock = true;
    await watcher.start();
    const client = imapInstances[before];

    // Avant : le client connecté mais sans dossier restait ouvert, et chaque
    // reconnexion en ajoutait un.
    expect(client.close).toHaveBeenCalled();
    expect(client.on.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
    const events = client.on.mock.calls.map(([event]) => event);
    expect(events).toEqual(expect.arrayContaining(['error', 'close', 'exists']));
    // stop() annule la reconnexion programmée.
    await watcher.stop();
  });

  // -------------------------------------------------------------------------
  // Reprise après coupure (repère persistant)
  // -------------------------------------------------------------------------

  describe('resume after a restart', () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

    afterEach(() => {
      mockControl.uidNext = 100;
      mockControl.uidValidity = 7n;
      mockControl.missed = [];
    });

    it('persists the starting position on a first watch', async () => {
      const watcher = new WatcherService(config, [testAccount]);
      await watcher.start();
      expect(await readWatermark('test', 'INBOX', stateDir)).toMatchObject({
        uidValidity: '7',
        lastSeenUid: 99,
      });
      expect(watcher.getStatus()[0].lastSeenUid).toBe(99);
      await watcher.stop();
    });

    it('reports mail that arrived while stopped (same UIDVALIDITY)', async () => {
      // Avant : la connexion repartait de UIDNEXT-1 = 104, ces 3 messages
      // n'étaient jamais notifiés.
      await writeWatermark('test', 'INBOX', '7', 101, stateDir);
      mockControl.uidNext = 105;
      mockControl.missed = [102, 103, 104];
      const watcher = new WatcherService(config, [testAccount]);
      await watcher.start();
      const client = imapInstances[imapInstances.length - 1];

      await vi.waitFor(() => {
        expect(eventBus.emit).toHaveBeenCalled();
      });
      expect(client.search).toHaveBeenCalledWith({ uid: '102:*' }, { uid: true });
      const [range, , options] = client.fetch.mock.calls[0] as [string, unknown, unknown];
      expect(range).toBe('102,103,104');
      expect(options).toEqual({ uid: true });
      const [, payload] = vi.mocked(eventBus.emit).mock.calls[0] as [
        string,
        { emails: { id: string }[] },
      ];
      expect(payload.emails.map((e) => e.id)).toEqual(['102', '103', '104']);
      await vi.waitFor(async () => {
        expect((await readWatermark('test', 'INBOX', stateDir))?.lastSeenUid).toBe(104);
      });
      await watcher.stop();
    });

    it('caps the catch-up to the most recent messages and logs the rest', async () => {
      await writeWatermark('test', 'INBOX', '7', 1, stateDir);
      mockControl.uidNext = 62;
      mockControl.missed = Array.from({ length: 60 }, (_, i) => i + 2); // 2..61
      const watcher = new WatcherService(config, [testAccount]);
      await watcher.start();
      const client = imapInstances[imapInstances.length - 1];

      await vi.waitFor(() => {
        expect(eventBus.emit).toHaveBeenCalled();
      });
      const [range] = client.fetch.mock.calls[0] as [string];
      expect(range.split(',')).toHaveLength(50);
      expect(range.startsWith('12,')).toBe(true);
      expect(vi.mocked(mcpLog)).toHaveBeenCalledWith(
        'warning',
        'watcher',
        expect.stringContaining('10 older one(s) not notified'),
      );
      // Les messages sautés ne seront pas rattrapés au prochain démarrage.
      await vi.waitFor(async () => {
        expect((await readWatermark('test', 'INBOX', stateDir))?.lastSeenUid).toBe(61);
      });
      await watcher.stop();
    });

    it('ignores a position saved under another UIDVALIDITY', async () => {
      await writeWatermark('test', 'INBOX', '6', 50, stateDir);
      const watcher = new WatcherService(config, [testAccount]);
      await watcher.start();
      expect(watcher.getStatus()[0].lastSeenUid).toBe(99);
      expect((await readWatermark('test', 'INBOX', stateDir))?.uidValidity).toBe('7');
      const client = imapInstances[imapInstances.length - 1];
      expect(client.search).not.toHaveBeenCalled();
      await watcher.stop();
    });
  });
});
