import type { AccountConfig } from '../types/index.js';
import {
  authFailureHint,
  describeAuthFailure,
  isAuthFailure,
  withAuthGuidance,
} from './auth-error.js';
import { imapCommand, serverRefusal } from './imap-error.js';

function account(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    name: 'personal',
    email: 'someone@gmail.com',
    username: 'someone@gmail.com',
    password: 'hunter2',
    imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
    ...overrides,
  };
}

/** nodemailer enveloppe ainsi une réponse 535. */
function smtpAuthError() {
  return Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
    code: 'EAUTH',
    responseCode: 535,
  });
}

describe('isAuthFailure', () => {
  it('recognizes nodemailer EAUTH and imapflow authenticationFailed', () => {
    expect(isAuthFailure(smtpAuthError())).toBe(true);
    expect(
      isAuthFailure(
        Object.assign(new Error('Authentication failed'), { authenticationFailed: true }),
      ),
    ).toBe(true);
    expect(
      isAuthFailure(Object.assign(new Error('x'), { serverResponseCode: 'AUTHENTICATIONFAILED' })),
    ).toBe(true);
  });

  it('leaves unreachable-server errors alone', () => {
    expect(
      isAuthFailure(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })),
    ).toBe(false);
    expect(isAuthFailure(new Error('self signed certificate in certificate chain'))).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});

describe('describeAuthFailure', () => {
  it("quotes the provider's app-password requirement for Gmail", () => {
    const message = describeAuthFailure(smtpAuthError(), account(), 'SMTP');
    expect(message).toContain('SMTP authentication failed for account "personal"');
    expect(message).toContain('smtp.gmail.com:465');
    expect(message).toContain('Gmail: Requires an App Password');
    expect(message).toContain('535-5.7.8 Username and Password not accepted');
  });

  it('points OAuth2 accounts at their refresh token instead of a password', () => {
    const message = describeAuthFailure(
      smtpAuthError(),
      account({
        oauth2: { provider: 'google', clientId: 'id', clientSecret: 's', refreshToken: 't' },
      }),
      'SMTP',
    );
    expect(message).toContain('refresh token looks expired or revoked');
    expect(message).not.toContain('App Password');
  });

  it('falls back to generic guidance for an unknown provider', () => {
    const hint = authFailureHint(
      smtpAuthError(),
      account({
        email: 'me@corp.example',
        imap: { host: 'mail.corp.example', port: 993, tls: true, starttls: false, verifySsl: true },
      }),
    );
    expect(hint).toContain('app password');
  });
});

describe('withAuthGuidance', () => {
  it('rewrites credential failures and passes everything else through', async () => {
    await expect(
      withAuthGuidance(account(), 'SMTP', async () => {
        throw smtpAuthError();
      }),
    ).rejects.toThrow('Gmail: Requires an App Password');

    const network = new Error('ECONNREFUSED');
    await expect(
      withAuthGuidance(account(), 'IMAP', async () => {
        throw network;
      }),
    ).rejects.toBe(network);
  });
});

describe('imapCommand / serverRefusal', () => {
  it('prefers imapflow responseText (response is a parsed object, not a string)', () => {
    const err = Object.assign(new Error('Command failed'), {
      response: { tag: '6', command: 'NO' },
      responseText: '[CANNOT] Invalid mailbox name',
    });
    expect(serverRefusal(err)).toBe('[CANNOT] Invalid mailbox name');
  });

  it('strips the tag from a raw string response', () => {
    const err = Object.assign(new Error('Command failed'), { response: 'a7 NO mailbox locked' });
    expect(serverRefusal(err)).toBe('mailbox locked');
  });

  it('wraps the refusal with the operation, keeping the original as cause', async () => {
    const original = Object.assign(new Error('Command failed'), { responseText: 'Over quota' });
    const err = await imapCommand('Creating mailbox "X"', async () => {
      throw original;
    }).catch((e: unknown) => e as Error);
    expect(err.message).toBe('Creating mailbox "X" rejected by server: Over quota');
    expect(err.cause).toBe(original);
  });
});
