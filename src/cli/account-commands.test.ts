/**
 * `account edit` : fusion dans l'entrée existante. L'ancien code reconstruisait
 * le compte de zéro et perdait tout ce que l'assistant ne gère pas.
 */

import type { RawAccountConfig } from '../config/schema.js';
import { AccountConfigSchema } from '../config/schema.js';
import type { ServerSettings } from './account-commands.js';
import { buildRawAccount, credentialFields, externalSecretSource } from './account-commands.js';

/** Paramètres serveur tels que l'éditeur les pré-remplit depuis le compte. */
function serverOf(account: RawAccountConfig): ServerSettings {
  return {
    imapHost: account.imap.host,
    imapPort: account.imap.port,
    imapTls: account.imap.tls,
    smtpHost: account.smtp.host,
    smtpPort: account.smtp.port,
    smtpTls: account.smtp.tls,
    smtpStarttls: account.smtp.starttls,
    smtpPoolEnabled: account.smtp.pool.enabled,
    smtpPoolMaxConnections: account.smtp.pool.max_connections,
    smtpPoolMaxMessages: account.smtp.pool.max_messages,
  };
}

function identityOf(account: RawAccountConfig) {
  return { name: account.name, email: account.email, fullName: account.full_name ?? '' };
}

const graphAccount = AccountConfigSchema.parse({
  name: 'exchange',
  email: 'me@outlook.com',
  full_name: 'Me',
  backend: 'graph',
  signature_path: 'C:/sig/me.htm',
  signature_default: true,
  sent_folder: 'Sent Items',
  oauth2: {
    provider: 'microsoft',
    client_id: 'client',
    client_secret_command: 'kp secret',
    refresh_token_command: 'kp refresh',
  },
  imap: { host: 'outlook.office365.com', verify_ssl: false },
  smtp: { host: 'smtp.office365.com', port: 587, tls: false, starttls: true },
});

const commandAccount = AccountConfigSchema.parse({
  name: 'perso',
  email: 'me@example.com',
  username: 'login-me',
  password_command: 'keepassxc-cli show -a password db.kdbx perso',
  imap: { host: 'imap.example.com', port: 143, tls: false, starttls: true },
  smtp: { host: 'smtp.example.com' },
});

describe('buildRawAccount — edit merges into the existing entry (1)', () => {
  it('editing only the display name keeps oauth2, backend, signature and other fields', () => {
    const updated = buildRawAccount(
      { ...identityOf(graphAccount), fullName: 'Me Myself' },
      { username: 'me@outlook.com', password: '' },
      serverOf(graphAccount),
      graphAccount,
    );

    expect(updated.full_name).toBe('Me Myself');
    expect(updated.backend).toBe('graph');
    expect(updated.oauth2).toEqual(graphAccount.oauth2);
    expect(updated.signature_path).toBe('C:/sig/me.htm');
    expect(updated.signature_default).toBe(true);
    expect(updated.sent_folder).toBe('Sent Items');
    expect(updated.imap.verify_ssl).toBe(false);
    // Avant : password = "" écrit en clair.
    expect(updated.password).toBeUndefined();
    // L'identifiant implicite (= adresse) n'est pas rendu explicite.
    expect(updated.username).toBeUndefined();
    // Toujours un compte valide.
    expect(AccountConfigSchema.safeParse(updated).success).toBe(true);
  });

  it('keeps password_command when credentials were not retyped', () => {
    const updated = buildRawAccount(
      identityOf(commandAccount),
      { username: 'login-me', password: '' },
      serverOf(commandAccount),
      commandAccount,
    );

    expect(updated.password_command).toBe(commandAccount.password_command);
    expect(updated.password).toBeUndefined();
    expect(updated.username).toBe('login-me');
    // STARTTLS déjà configuré : conservé.
    expect(updated.imap).toMatchObject({ tls: false, starttls: true, port: 143 });
  });

  it('a typed password replaces password_command (never both)', () => {
    const updated = buildRawAccount(
      identityOf(commandAccount),
      { username: 'login-me', password: 'new-app-password' },
      serverOf(commandAccount),
      commandAccount,
    );

    expect(updated.password).toBe('new-app-password');
    expect(updated.password_command).toBeUndefined();
    expect(AccountConfigSchema.safeParse(updated).success).toBe(true);
  });

  it('server edits apply on top of the existing entry', () => {
    const updated = buildRawAccount(
      identityOf(commandAccount),
      { username: 'login-me', password: '' },
      { ...serverOf(commandAccount), imapHost: 'imap2.example.com', imapPort: 993, imapTls: true },
      commandAccount,
    );

    expect(updated.imap).toMatchObject({
      host: 'imap2.example.com',
      port: 993,
      tls: true,
      starttls: false,
    });
    expect(updated.password_command).toBe(commandAccount.password_command);
  });

  it('a new account (no existing entry) is built as before', () => {
    const created = buildRawAccount(
      { name: 'new', email: 'new@example.com', fullName: '' },
      { username: '', password: 'pw' },
      serverOf(commandAccount),
    );
    expect(created).toMatchObject({ name: 'new', username: 'new@example.com', password: 'pw' });
    expect(created.imap.verify_ssl).toBe(true);
  });
});

describe('credentialFields / externalSecretSource', () => {
  it('returns no key when no password was typed', () => {
    expect(credentialFields({ username: 'u', password: '' })).toEqual({});
  });

  it('names the external source so the wizard does not offer a password', () => {
    expect(externalSecretSource(graphAccount)).toBe('oauth2 (microsoft)');
    expect(externalSecretSource(commandAccount)).toBe('password_command');
    expect(
      externalSecretSource({ ...commandAccount, password_command: undefined, password: 'x' }),
    ).toBeUndefined();
  });
});
