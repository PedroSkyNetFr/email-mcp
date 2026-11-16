/**
 * Connexions IMAP : mutualisation de la tentative en cours, éviction par
 * identité, STARTTLS obligatoire, consigne sur identifiants refusés.
 */

import type { EventEmitter } from 'node:events';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager, { buildImapFlowOptions } from './manager.js';

const state = vi.hoisted(() => ({
  instances: [] as {
    options: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
  /** Comportement de connect() pour la prochaine instance créée. */
  nextConnect: undefined as undefined | (() => Promise<void>),
}));

vi.mock('imapflow', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  class MockImapFlow extends NodeEventEmitter {
    usable = true;
    options: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    close = vi.fn(() => {
      this.usable = false;
    });
    logout = vi.fn().mockResolvedValue(undefined);
    list = vi.fn().mockResolvedValue([]);
    status = vi.fn().mockResolvedValue({ messages: 0 });

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      const behaviour = state.nextConnect;
      state.nextConnect = undefined;
      this.connect = vi.fn(behaviour ?? (async () => undefined));
      state.instances.push(this);
    }
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

function makeAccount(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    name: 'test',
    email: 'someone@gmail.com',
    username: 'someone@gmail.com',
    password: 'pw',
    imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
    ...overrides,
  };
}

beforeEach(() => {
  state.instances.length = 0;
  state.nextConnect = undefined;
});

describe('getImapClient — one connection attempt in flight per account (3)', () => {
  it('concurrent callers share the same connection instead of opening several', async () => {
    let release: () => void = () => {};
    state.nextConnect = async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const manager = new ConnectionManager([makeAccount()]);

    const calls = [
      manager.getImapClient('test'),
      manager.getImapClient('test'),
      manager.getImapClient('test'),
    ];
    // Laisser la construction asynchrone atteindre connect().
    await vi.waitFor(() => {
      expect(state.instances).toHaveLength(1);
    });
    release();
    const clients = await Promise.all(calls);

    // Avant correction : trois connexions, dont deux fantômes jamais fermées.
    expect(state.instances).toHaveLength(1);
    expect(new Set(clients).size).toBe(1);
  });

  it('a failed attempt is not reused: the next call reconnects', async () => {
    state.nextConnect = async () => {
      throw new Error('ECONNRESET');
    };
    const manager = new ConnectionManager([makeAccount()]);

    await expect(manager.getImapClient('test')).rejects.toThrow('ECONNRESET');
    // Le client qui a échoué est fermé, pas laissé ouvert.
    expect(state.instances[0].close).toHaveBeenCalled();

    const client = await manager.getImapClient('test');
    expect(client).toBe(state.instances[1]);
  });

  it("a stale client's late error does not evict its healthy replacement", async () => {
    const manager = new ConnectionManager([makeAccount()]);
    const first = await manager.getImapClient('test');
    // Le serveur ferme la première connexion : elle n'est plus utilisable.
    (first as unknown as { usable: boolean }).usable = false;
    const second = await manager.getImapClient('test');
    expect(second).not.toBe(first);

    // Erreur tardive de l'ANCIEN client.
    (first as unknown as EventEmitter).emit('error', new Error('late socket error'));

    // Le client courant reste en cache : pas de troisième connexion.
    await expect(manager.getImapClient('test')).resolves.toBe(second);
    expect(state.instances).toHaveLength(2);
  });

  it('closes the client that errored and evicts it', async () => {
    const manager = new ConnectionManager([makeAccount()]);
    const client = await manager.getImapClient('test');

    (client as unknown as EventEmitter).emit('error', new Error('boom'));

    expect(state.instances[0].close).toHaveBeenCalled();
    await expect(manager.getImapClient('test')).resolves.not.toBe(client);
  });

  it("evicts the current client on 'close'", async () => {
    const manager = new ConnectionManager([makeAccount()]);
    const client = await manager.getImapClient('test');

    (client as unknown as EventEmitter).emit('close');

    await expect(manager.getImapClient('test')).resolves.not.toBe(client);
  });
});

describe('testImap — error listener (3)', () => {
  it('a socket error during the test does not crash the process', async () => {
    let fail: (err: Error) => void = () => {};
    state.nextConnect = async () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    const pending = ConnectionManager.testImap(makeAccount());
    await vi.waitFor(() => {
      expect(state.instances).toHaveLength(1);
    });
    const client = state.instances[0] as unknown as EventEmitter;

    expect(() => client.emit('error', new Error('socket timeout'))).not.toThrow();
    fail(new Error('socket timeout'));
    await expect(pending).resolves.toMatchObject({ success: false, error: 'socket timeout' });
  });
});

describe('STARTTLS is enforced when requested (4)', () => {
  it('passes doSTARTTLS: true when starttls is set without TLS (remote host)', () => {
    const account = makeAccount({
      imap: { host: 'mail.example.com', port: 143, tls: false, starttls: true, verifySsl: true },
    });
    const options = buildImapFlowOptions(account, { user: 'u', pass: 'p' });
    expect(options.secure).toBe(false);
    expect(options.doSTARTTLS).toBe(true);
  });

  it.each(['localhost', 'localhost.', '127.0.0.1', '127.0.0.2', '::1', '[::1]'])(
    'keeps opportunistic STARTTLS on the loopback host %s (local clear-text gateways)',
    (host) => {
      const account = makeAccount({
        imap: { host, port: 1143, tls: false, starttls: true, verifySsl: true },
      });
      const options = buildImapFlowOptions(account, { user: 'u', pass: 'p' });
      expect(options.secure).toBe(false);
      expect(options.doSTARTTLS).toBeUndefined();
    },
  );

  it('still requires STARTTLS on a host that only looks local', () => {
    const account = makeAccount({
      imap: {
        host: 'localhost.evil.example',
        port: 143,
        tls: false,
        starttls: true,
        verifySsl: true,
      },
    });
    expect(buildImapFlowOptions(account, { user: 'u' }).doSTARTTLS).toBe(true);
  });

  it('leaves direct TLS alone (secure and doSTARTTLS are mutually exclusive in imapflow)', () => {
    const options = buildImapFlowOptions(makeAccount(), { user: 'u', pass: 'p' });
    expect(options.secure).toBe(true);
    expect(options.doSTARTTLS).toBeUndefined();
  });

  it('keeps the opportunistic default when neither TLS nor STARTTLS is requested', () => {
    const account = makeAccount({
      imap: { host: 'mail.example.com', port: 143, tls: false, starttls: false, verifySsl: true },
    });
    expect(buildImapFlowOptions(account, { user: 'u' }).doSTARTTLS).toBeUndefined();
  });

  it('the cached client is built with it', async () => {
    const manager = new ConnectionManager([
      makeAccount({
        imap: { host: 'mail.example.com', port: 143, tls: false, starttls: true, verifySsl: true },
      }),
    ]);
    await manager.getImapClient('test');
    expect(state.instances[0].options).toMatchObject({ doSTARTTLS: true, secure: false });
  });
});

describe('rejected credentials are explained (5b)', () => {
  it('names the Gmail app-password requirement and keeps the server words', async () => {
    state.nextConnect = async () => {
      throw Object.assign(new Error('Authentication failed'), {
        authenticationFailed: true,
        responseText: 'Invalid credentials (Failure)',
      });
    };
    const manager = new ConnectionManager([makeAccount()]);

    const err = await manager.getImapClient('test').then(
      () => new Error('expected a rejection'),
      (e: unknown) => e as Error,
    );

    expect(err.message).toContain('IMAP authentication failed for account "test"');
    expect(err.message).toContain('Gmail: Requires an App Password');
    expect(err.message).toContain('Invalid credentials (Failure)');
    expect(err.message).toContain('email-mcp account edit test');
  });

  it('leaves network failures untouched', async () => {
    state.nextConnect = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmail.com'), {
        code: 'ENOTFOUND',
      });
    };
    const manager = new ConnectionManager([makeAccount()]);

    await expect(manager.getImapClient('test')).rejects.toThrow(
      /^getaddrinfo ENOTFOUND imap.gmail.com$/,
    );
  });

  it('testImap returns a hint alongside the raw error', async () => {
    state.nextConnect = async () => {
      throw Object.assign(new Error('Authentication failed'), { authenticationFailed: true });
    };
    const result = await ConnectionManager.testImap(makeAccount());
    expect(result.success).toBe(false);
    expect(result.hint).toContain('App Password');
  });
});
