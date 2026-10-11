import type { AccountConfig, WatcherConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import WatcherService from './watcher.service.js';

// Instances créées par le mock, pour piloter les événements IMAP d'un test.
const { imapInstances } = vi.hoisted(() => ({
  imapInstances: [] as {
    on: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
  }[],
}));

// Mock imapflow module
vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;
    mailbox = { uidNext: 100 };
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    getMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
    on = vi.fn();
    fetch = vi.fn();

    constructor() {
      imapInstances.push(this);
    }
  }
  return { ImapFlow: MockImapFlow };
});

// Mock logging to prevent side effects
vi.mock('../logging.js', () => ({
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
});
