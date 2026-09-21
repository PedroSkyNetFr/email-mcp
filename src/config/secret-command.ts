/**
 * Secret indirection — `*_command` config fields.
 *
 * Credentials in `config.toml` sit in plain text: mailbox passwords, an OAuth2
 * client secret, a refresh token. Encrypting the file in place would not buy
 * much, because the server has to hand the cleartext to the mail provider on
 * its own, at startup, with nobody around to unlock anything — so whatever key
 * it uses must be reachable by any code running as the same user.
 *
 * What does help is not holding the secret at all. `password_command`,
 * `client_secret_command` and `refresh_token_command` name a command; the
 * server runs it at load time and reads the secret from its standard output.
 * The store on the other end is the user's to choose — KeePassXC, Bitwarden,
 * 1Password, `pass`, the Windows Credential Manager — because the contract is
 * just "print the secret and exit 0".
 *
 * The command runs through the platform shell (`cmd.exe` on Windows, `sh`
 * elsewhere), which is what makes the published one-liners of those tools work
 * unchanged. That is not a new attack surface: anyone who can write to
 * `config.toml` can already read the secrets it holds.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { RawAppConfig } from './schema.js';

const execAsync = promisify(exec);

/**
 * How long a secret command may take. The server is started by an MCP client
 * with no terminal attached, so a vault that decides to prompt would otherwise
 * hang the whole process with nothing on screen to explain it.
 */
export const SECRET_COMMAND_TIMEOUT_MS = 30_000;

/** Longest stderr excerpt echoed back in an error. */
const STDERR_EXCERPT = 400;

/**
 * Run one secret command and return what it printed.
 *
 * `label` identifies the field in every error — "account \"work\" password_command"
 * — because a failure here surfaces at server startup, far from the file.
 */
export async function runSecretCommand(command: string, label: string): Promise<string> {
  let stdout: string;
  let stderr: string;

  try {
    ({ stdout, stderr } = await execAsync(command, {
      timeout: SECRET_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf-8',
    }));
  } catch (err) {
    const failure = err as { killed?: boolean; code?: number; stderr?: string };

    if (failure.killed) {
      throw new Error(
        `${label} timed out after ${SECRET_COMMAND_TIMEOUT_MS / 1000}s: ${command}\n` +
          'The command must be non-interactive — the server runs with no terminal, so a ' +
          'vault waiting for a passphrase never gets one.',
      );
    }

    const detail = failure.stderr?.trim().slice(0, STDERR_EXCERPT);
    const exit = failure.code === undefined ? '' : ` (exit ${failure.code})`;
    throw new Error(`${label} failed${exit}: ${command}${detail ? `\n${detail}` : ''}`);
  }

  // Only trailing newlines are stripped: a password may legitimately end with a
  // space, and silently trimming it would fail authentication for no visible
  // reason. Password managers print the secret followed by a newline.
  const secret = stdout.replace(/[\r\n]+$/, '');

  if (secret.length === 0) {
    const detail = stderr.trim().slice(0, STDERR_EXCERPT);
    throw new Error(
      `${label} printed nothing: ${command}${detail ? `\n${detail}` : ''}\n` +
        `The secret is expected on standard output.`,
    );
  }

  return secret;
}

/**
 * Replace every `*_command` field by the secret its command prints.
 *
 * Runs after the account filter, so an instance scoped with
 * `MCP_EMAIL_ACCOUNTS` only asks the vault for the mailboxes it actually
 * serves — three instances of the server do not mean three times the prompts.
 *
 * Commands run one after another rather than at once: a locked vault asking to
 * be opened should do it once, not in five simultaneous windows.
 */
export async function resolveSecretCommands(raw: RawAppConfig): Promise<RawAppConfig> {
  const needsResolution = raw.accounts.some(
    (account) =>
      account.password_command ??
      account.oauth2?.client_secret_command ??
      account.oauth2?.refresh_token_command,
  );

  if (!needsResolution) {
    return raw;
  }

  const accounts = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const account of raw.accounts) {
    const resolved = { ...account };

    if (account.password_command) {
      // eslint-disable-next-line no-await-in-loop
      resolved.password = await runSecretCommand(
        account.password_command,
        `account "${account.name}" password_command`,
      );
    }

    if (account.oauth2?.client_secret_command) {
      resolved.oauth2 = {
        ...account.oauth2,
        // eslint-disable-next-line no-await-in-loop
        client_secret: await runSecretCommand(
          account.oauth2.client_secret_command,
          `account "${account.name}" oauth2.client_secret_command`,
        ),
      };
    }

    if (account.oauth2?.refresh_token_command) {
      resolved.oauth2 = {
        ...(resolved.oauth2 ?? account.oauth2),
        // eslint-disable-next-line no-await-in-loop
        refresh_token: await runSecretCommand(
          account.oauth2.refresh_token_command,
          `account "${account.name}" oauth2.refresh_token_command`,
        ),
      };
    }

    accounts.push(resolved);
  }

  return { ...raw, accounts };
}
