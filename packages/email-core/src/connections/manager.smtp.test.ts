/**
 * Transports SMTP : une seule création en vol par compte, et jeton OAuth2
 * fourni à la demande (plus de jeton figé dans le transport mis en cache).
 */

import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

const smtp = vi.hoisted(() => ({
  created: [] as {
    options: Record<string, unknown>;
    verify: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
  /** Libère les verify() en attente. */
  release: [] as (() => void)[],
  holdVerify: false,
  /** Le prochain verify() échoue. */
  failNextVerify: false,
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn((options: Record<string, unknown>) => {
      const transport = {
        options,
        verify: vi.fn(
          async () =>
            new Promise<void>((resolve) => {
              if (smtp.failNextVerify) {
                smtp.failNextVerify = false;
                throw new Error('ECONNREFUSED');
              }
              if (smtp.holdVerify) smtp.release.push(resolve);
              else resolve();
            }),
        ),
        close: vi.fn(),
      };
      smtp.created.push(transport);
      return transport;
    }),
  },
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

function makeAccount(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    name: 'test',
    email: 'me@contoso.com',
    username: 'me@contoso.com',
    password: 'pw',
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 587, tls: false, starttls: true, verifySsl: true },
    ...overrides,
  };
}

beforeEach(() => {
  smtp.created.length = 0;
  smtp.release.length = 0;
  smtp.holdVerify = false;
  smtp.failNextVerify = false;
});

describe('getSmtpTransport — one creation in flight per account (12)', () => {
  it('two concurrent sends share one transport instead of creating two', async () => {
    smtp.holdVerify = true;
    const manager = new ConnectionManager([makeAccount()]);

    const both = Promise.all([manager.getSmtpTransport('test'), manager.getSmtpTransport('test')]);
    await vi.waitFor(() => expect(smtp.release.length).toBe(1));
    smtp.release.forEach((resolve) => {
      resolve();
    });
    const [a, b] = await both;

    expect(smtp.created).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('a failed creation is not served again: the next call retries', async () => {
    const manager = new ConnectionManager([makeAccount()]);
    smtp.failNextVerify = true;

    await expect(manager.getSmtpTransport('test')).rejects.toThrow('ECONNREFUSED');
    expect(smtp.created[0].close).toHaveBeenCalled();

    const retried = await manager.getSmtpTransport('test');
    expect(retried).toBe(smtp.created[1]);
    expect(smtp.created).toHaveLength(2);
  });
});

describe('getSmtpTransport — OAuth2 token stays fresh (12)', () => {
  function oauthAccount() {
    return makeAccount({
      password: undefined,
      oauth2: {
        provider: 'microsoft',
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'r',
        accessToken: 'token-1',
        tokenExpiry: Date.now() + 3_600_000,
      },
    });
  }

  it('gives nodemailer a provisionCallback, not only a frozen access token', async () => {
    const account = oauthAccount();
    let n = 1;
    const oauth = {
      getAccessToken: vi.fn(async (cfg: { accessToken?: string }) => {
        if (!cfg.accessToken) {
          n += 1;
          Object.assign(cfg, { accessToken: `token-${n}`, tokenExpiry: Date.now() + 3_600_000 });
        }
        return cfg.accessToken as string;
      }),
    };
    const manager = new ConnectionManager([account], oauth as unknown as OAuthService);

    await manager.getSmtpTransport('test');
    const auth = smtp.created[0].options.auth as {
      type: string;
      accessToken: string;
      expires: number;
      provisionCallback: (
        user: string,
        renew: boolean,
        cb: (err: Error | null, token?: string, expires?: number) => void,
      ) => void;
    };
    expect(auth).toMatchObject({ type: 'OAuth2', user: 'me@contoso.com', accessToken: 'token-1' });
    // Expiration transmise : nodemailer redemande un jeton avant qu'il expire.
    expect(auth.expires).toBeLessThan(account.oauth2?.tokenExpiry ?? 0);

    // Le serveur refuse le jeton (renew = true) : un VRAI rafraîchissement a lieu.
    const renewed = await new Promise<string | undefined>((resolve, reject) => {
      auth.provisionCallback('me@contoso.com', true, (err, token) =>
        err ? reject(err) : resolve(token),
      );
    });
    expect(renewed).toBe('token-2');

    // Le même transport reste en cache : aucune recréation nécessaire.
    expect(await manager.getSmtpTransport('test')).toBe(smtp.created[0]);
    expect(smtp.created).toHaveLength(1);
  });

  it('reports a refresh failure through the callback instead of throwing', async () => {
    const oauth = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce('token-1')
        .mockRejectedValueOnce(new Error('invalid_grant')),
    };
    const manager = new ConnectionManager([oauthAccount()], oauth as unknown as OAuthService);
    await manager.getSmtpTransport('test');
    const auth = smtp.created[0].options.auth as {
      provisionCallback: (u: string, r: boolean, cb: (err: Error | null) => void) => void;
    };

    const err = await new Promise<Error | null>((resolve) => {
      auth.provisionCallback('me@contoso.com', false, resolve);
    });
    expect(err?.message).toBe('invalid_grant');
  });
});
