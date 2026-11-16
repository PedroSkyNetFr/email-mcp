import type { AccountConfig, IMailService, ISendService } from './index.js';
import {
  ConnectionManager,
  createMailBackends,
  detectProvider,
  GraphSendService,
  GraphService,
  ImapService,
  OAuthService,
  SEARCH_FAIL_KIND,
  SmtpService,
} from './index.js';

// A host application (not the MCP server) only ever sees this entry point:
// these tests pin what it can rely on.

const imapAccount: AccountConfig = {
  name: 'work',
  email: 'me@example.org',
  username: 'me@example.org',
  password: 'secret',
  imap: { host: 'imap.example.org', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.org', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('public entry point', () => {
  it('exposes the engines, the wiring and the connection seam', () => {
    expect(ImapService).toBeTypeOf('function');
    expect(SmtpService).toBeTypeOf('function');
    expect(GraphService).toBeTypeOf('function');
    expect(GraphSendService).toBeTypeOf('function');
    expect(ConnectionManager).toBeTypeOf('function');
    expect(OAuthService).toBeTypeOf('function');
    expect(createMailBackends).toBeTypeOf('function');
    expect(SEARCH_FAIL_KIND).toBeTypeOf('object');
    expect(detectProvider('someone@gmail.com')?.name).toBe('Gmail');
  });

  it('builds the per-account backends from a host config, without the MCP server', async () => {
    // Only `accounts` and `settings.rateLimit` are read: any host config of
    // that shape is accepted as is.
    const backends = createMailBackends({
      accounts: [imapAccount],
      settings: { rateLimit: 10 },
    });
    const mail: IMailService = backends.mailService;
    const send: ISendService = backends.sendService;

    expect(mail.listMailboxes).toBeTypeOf('function');
    expect(send.sendEmail).toBeTypeOf('function');
    expect(backends.connections.getAccountNames()).toEqual(['work']);
    await backends.connections.closeAll();
  });

  it('gives one MailEngine per account, IMAP for an IMAP account, cached', async () => {
    const backends = createMailBackends({ accounts: [imapAccount], settings: { rateLimit: 10 } });
    const engine = backends.engine('work');

    expect(engine.account).toBe('work');
    expect(backends.engine('work')).toBe(engine);
    await expect(engine.waitForChange({ folderIds: [], maxMs: 1 })).resolves.toBe('timeout');
    expect(() => backends.engine('nope')).toThrow(/Unknown account/);
    await backends.close();
  });
});
