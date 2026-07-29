#!/usr/bin/env tsx
/**
 * OAuth2 setup helper — obtain the refresh token used for IMAP/SMTP XOAUTH2.
 *
 * Providers that disabled basic authentication (Microsoft in particular) require
 * OAuth2 instead of a password. email-mcp can refresh an access token on its own,
 * but the FIRST refresh token has to be obtained interactively, once. This script
 * performs that one-time exchange and prints the token to paste into your config.
 *
 * Flow:
 *   1. Start a throwaway HTTP server on localhost to receive the redirect.
 *   2. Open the provider's consent page in your browser (URL printed as fallback).
 *   3. Capture the `code` query parameter from the redirect.
 *   4. Exchange it for tokens via OAuthService.exchangeCode().
 *   5. Print the refresh token and a ready-to-paste env block.
 *
 * The redirect URI must match EXACTLY what is registered with the provider.
 * With the default port that is: http://localhost:3000/callback
 *
 * Usage:
 *   pnpm oauth:setup --provider microsoft --client-id <id> --client-secret <secret>
 *
 * Anything omitted is asked for interactively, so the script can also be run with
 * no arguments at all — or, on Windows, by double-clicking scripts/oauth-setup.cmd.
 *
 * Profiles (--provider, or pick from the interactive menu):
 *   microsoft         IMAP + SMTP scopes — the token email-mcp authenticates with
 *   microsoft-graph   Graph Mail.Read — diagnostics only, must NOT go in the config
 *   google            Gmail IMAP + SMTP
 *   custom            supply --auth-url, --token-url and --scopes yourself
 *
 * Options:
 *   --provider <name>     profile from the list above               (default: menu)
 *   --client-id <id>      OAuth2 client/application ID           (or OAUTH_CLIENT_ID)
 *   --client-secret <s>   OAuth2 client secret                   (or OAUTH_CLIENT_SECRET)
 *   --port <n>            Local callback port                    (default: 3000)
 *   --token-url <url>     Token endpoint      (custom provider only)
 *   --auth-url <url>      Authorization endpoint (custom provider only)
 *   --scopes <list>       Space-separated scopes (custom provider only)
 *
 * Secrets can be passed through the environment instead of argv to keep them out
 * of your shell history.
 *
 * Provider setup notes:
 *   Microsoft — register an app in Entra ID (Azure) whose supported account types
 *     INCLUDE personal Microsoft accounts if you use an outlook.com/.fr address.
 *     Add a "Web" platform with the redirect URI above (the token exchange sends a
 *     client secret, so a confidential client is required), then grant the
 *     delegated Office 365 Exchange Online permissions IMAP.AccessAsUser.All and
 *     SMTP.Send. The `offline_access` scope is requested automatically.
 *   Google — create an OAuth client (type "Web application") and add the same
 *     redirect URI. The https://mail.google.com/ scope is requested automatically.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';

import OAuthService from '../src/services/oauth.service.js';
import type { OAuth2Config } from '../src/types/index.js';

/** Minimal `--flag value` parser (no dependency, mirrors the other scripts). */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      out[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}

/**
 * Ask the user for a value on stdin. When `mask` is set the typed characters are
 * echoed as `*` so a pasted secret does not stay readable on screen.
 */
// One readline interface shared by every plain prompt: closing and recreating it
// per question leaves stdin unusable for the next one (notably when input is
// piped rather than typed).
let sharedRl: ReturnType<typeof createInterface> | null = null;

function closePrompts(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

async function ask(question: string): Promise<string> {
  // Interactive prompts need a real terminal. With redirected input readline
  // emits every buffered line at once, so sequential questions silently lose
  // their answers — fail loudly instead, and point at the non-interactive route.
  if (!process.stdin.isTTY) {
    throw new Error(
      `No terminal available to ask for "${question.trim()}". Pass every value as an option ` +
        '(--provider / --client-id / --client-secret) or via OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET.',
    );
  }

  // The prompt MUST be rendered by readline itself: in terminal mode it redraws
  // the current line on every keystroke, which would erase anything written to
  // stdout beforehand.
  // `terminal` is deliberately left to its default (= stdin.isTTY): forcing it
  // on would make readline emulate a terminal for piped input and swallow
  // buffered lines ahead of the prompt that asked for them.
  sharedRl ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = await sharedRl.question(question);
  return answer.trim();
}

/**
 * Ask for a secret, echoing `*` instead of the typed characters.
 *
 * Reads raw keystrokes straight from stdin rather than driving readline: the
 * usual masking trick patches `_writeToOutput`, an internal that no longer
 * exists on modern Node. Falls back to a normal (visible) prompt when stdin is
 * not a terminal, e.g. when input is piped.
 */
async function askSecret(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return ask(question);

  // Hand stdin back before switching to raw mode: readline and the raw 'data'
  // listener below cannot both own the stream.
  closePrompts();

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };

    function onData(chunk: string): void {
      for (let i = 0; i < chunk.length; i += 1) {
        const char = chunk[i];
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003') {
          // Ctrl+C
          finish(new Error('Cancelled'));
          return;
        }
        if (char === '\u0008' || char === '\u007f') {
          // Backspace / Delete — drop one character and rub out one star.
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (char >= ' ') {
          value += char;
          stdout.write('*');
        }
      }
    }

    stdin.on('data', onData);
  });
}

/** Best-effort browser launch; failures are non-fatal (the URL is printed too). */
function openBrowser(url: string): void {
  // On Windows the URL must NOT be handed to `cmd /c start`: cmd treats the `&`
  // between query parameters as a command separator, so the browser would only
  // receive the URL up to the first one (dropping scope, redirect_uri, …).
  // rundll32 takes the argument verbatim, with no shell parsing at all.
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    spawn(command as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Headless environment — the user opens the printed URL manually.
  }
}

/** HTML shown in the browser once the redirect has been captured. */
function resultPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>email-mcp</title>
<body style="font-family:system-ui,sans-serif;padding:2rem">
<h1>email-mcp</h1><p>${message}</p></body>`;
}

/**
 * Wait for the provider to redirect back with an authorization code.
 * Resolves with the code, or rejects on an error redirect / timeout.
 */
async function waitForCode(port: number, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const description = url.searchParams.get('error_description');

      if (!code && !error) {
        // Ignore unrelated requests (favicon, probes) so they don't end the flow.
        res.writeHead(404).end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        resultPage(
          code
            ? 'Authorization received — you can close this tab and return to the terminal.'
            : `Authorization failed: ${description ?? error ?? 'unknown error'}`,
        ),
      );
      server.close();

      if (code) resolve(code);
      else reject(new Error(`Authorization denied by provider: ${description ?? error}`));
    });

    server.on('error', (err) => {
      reject(new Error(`Cannot listen on port ${port}: ${err.message}`));
    });

    server.listen(port, () => {
      // Listening — the consent URL is opened by the caller.
    });

    setTimeout(() => {
      server.close();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the redirect`));
    }, timeoutMs).unref();
  });
}

/**
 * Ready-made provider profiles. They spare the caller from typing endpoint URLs
 * and scope lists: picking a name is enough. Every field can still be overridden
 * with --auth-url / --token-url / --scopes.
 */
const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

const PRESETS: Record<
  string,
  { label: string; mailToken: boolean; backend?: 'graph'; config: Partial<OAuth2Config> }
> = {
  microsoft: {
    label: 'Microsoft — IMAP + SMTP (legacy; Exchange hides folders over IMAP)',
    mailToken: true,
    config: { provider: 'microsoft' },
  },
  'microsoft-graph': {
    label: 'Microsoft Graph — full mailbox access for Exchange / Outlook.com accounts',
    mailToken: true,
    backend: 'graph',
    config: {
      provider: 'custom',
      authUrl: MS_AUTH_URL,
      tokenUrl: MS_TOKEN_URL,
      // Read alone is not enough for the backend: flags, moves, drafts and
      // folder changes need ReadWrite, and sending needs Mail.Send.
      scopes: [
        'https://graph.microsoft.com/Mail.ReadWrite',
        'https://graph.microsoft.com/Mail.Send',
        'offline_access',
      ],
    },
  },
  'microsoft-graph-readonly': {
    label: 'Microsoft Graph — Mail.Read only (diagnostics, NOT for the config)',
    mailToken: false,
    config: {
      provider: 'custom',
      authUrl: MS_AUTH_URL,
      tokenUrl: MS_TOKEN_URL,
      scopes: ['https://graph.microsoft.com/Mail.Read', 'offline_access'],
    },
  },
  google: {
    label: 'Google — Gmail IMAP + SMTP',
    mailToken: true,
    config: { provider: 'google' },
  },
  custom: {
    label: 'Custom — supply your own endpoints and scopes',
    mailToken: true,
    config: { provider: 'custom' },
  },
};

/** Numbered menu so the profile can be picked without typing its full name. */
async function askPreset(): Promise<string> {
  const keys = Object.keys(PRESETS);
  // eslint-disable-next-line no-console
  console.log('What do you need a token for?\n');
  keys.forEach((key, index) => {
    // eslint-disable-next-line no-console
    console.log(`  ${index + 1}) ${key.padEnd(26)} ${PRESETS[key].label}`);
  });
  // eslint-disable-next-line no-console
  console.log('');

  const answer = await ask('Choice [1]: ');
  if (!answer) return keys[0];
  const index = Number.parseInt(answer, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= keys.length) return keys[index - 1];
  return answer; // also accept the profile name typed out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  /* eslint-disable no-console -- this script's output IS its interface */
  console.log('\n=== email-mcp — OAuth2 setup ===\n');

  // Anything not supplied on the command line (or in the environment) is asked
  // for interactively, so the script can simply be double-clicked.
  const presetName = args.provider || (await askPreset());
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `Unknown provider "${presetName}" (expected ${Object.keys(PRESETS).join(', ')})`,
    );
  }
  const provider = preset.config.provider ?? 'custom';

  const clientId =
    args['client-id'] ?? process.env.OAUTH_CLIENT_ID ?? (await ask('Client / application ID: '));
  if (!clientId) {
    throw new Error('A client ID is required (--client-id, OAUTH_CLIENT_ID, or the prompt).');
  }

  const clientSecret =
    args['client-secret'] ??
    process.env.OAUTH_CLIENT_SECRET ??
    (await askSecret('Client secret (hidden): '));
  if (!clientSecret) {
    throw new Error(
      'A client secret is required (--client-secret, OAUTH_CLIENT_SECRET, or the prompt).',
    );
  }

  // No more questions — release stdin so it stops holding the event loop open.
  closePrompts();
  if (process.stdin.isTTY) process.stdin.unref();

  const port = Number.parseInt(args.port ?? '3000', 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${args.port}"`);
  }
  const redirectUri = `http://localhost:${port}/callback`;

  // refreshToken is filled in by the exchange below; empty here by construction.
  // Precedence: explicit options override the profile, which overrides nothing.
  const config: OAuth2Config = {
    provider,
    clientId,
    clientSecret,
    refreshToken: '',
    ...(preset.config.tokenUrl ? { tokenUrl: preset.config.tokenUrl } : {}),
    ...(preset.config.authUrl ? { authUrl: preset.config.authUrl } : {}),
    ...(preset.config.scopes ? { scopes: preset.config.scopes } : {}),
    ...(args['token-url'] ? { tokenUrl: args['token-url'] } : {}),
    ...(args['auth-url'] ? { authUrl: args['auth-url'] } : {}),
    ...(args.scopes ? { scopes: args.scopes.split(' ').filter(Boolean) } : {}),
  };

  const authUrl = OAuthService.generateAuthUrl(config, redirectUri);

  console.log(`\nProfile      : ${presetName}`);
  console.log(`Scopes       : ${OAuthService.getProviderEndpoints(config).scopes.join(' ')}`);
  console.log(`Redirect URI : ${redirectUri}`);
  console.log('   (this must match the redirect URI registered with the provider)\n');
  console.log('Opening the consent page in your browser. If it does not open, visit:\n');
  console.log(`${authUrl}\n`);

  openBrowser(authUrl);

  const code = await waitForCode(port, 5 * 60 * 1000);
  console.log('Authorization code received — exchanging it for tokens…\n');

  const tokens = await OAuthService.exchangeCode(config, code, redirectUri);
  if (!tokens.refreshToken) {
    throw new Error(
      'The provider returned no refresh token. Re-run after revoking the previous consent, ' +
        'and make sure offline access is granted.',
    );
  }

  // A profile whose token is not the mail token must not end up in the config:
  // it would replace the credential the server authenticates IMAP/SMTP with.
  if (!preset.mailToken) {
    console.log('Success. Refresh token for this profile:\n');
    console.log(`  ${tokens.refreshToken}\n`);
    console.log('This token is for diagnostics only — do NOT put it in your MCP config, which');
    console.log('must keep the IMAP/SMTP token the server uses. Pass it explicitly instead:\n');
    console.log('  pnpm probe:graph --server <name> --refresh-token <the token above>\n');
    return;
  }

  // Emit JSON rather than KEY=value: MCP clients are configured through a JSON
  // file, so the block below can be pasted straight into the server's "env"
  // object. The secret stays a placeholder so it is never echoed to the screen.
  const entries: [string, string][] = [
    // A Graph profile also selects the backend: without it the account would
    // still be served over IMAP, which is what hides folders in the first place.
    ...(preset.backend ? ([['MCP_EMAIL_BACKEND', preset.backend]] as [string, string][]) : []),
    ['MCP_EMAIL_OAUTH2_PROVIDER', provider],
    ['MCP_EMAIL_OAUTH2_CLIENT_ID', clientId],
    ['MCP_EMAIL_OAUTH2_CLIENT_SECRET', '<paste the client secret you just used>'],
    ['MCP_EMAIL_OAUTH2_REFRESH_TOKEN', tokens.refreshToken],
  ];

  console.log('Success. Paste these inside the "env" block of your MCP server entry:\n');
  entries.forEach(([key, value], index) => {
    const comma = index < entries.length - 1 ? ',' : '';
    console.log(`        ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
  });
  console.log('\nReplace the client secret placeholder with its real value.');
  console.log('Then remove MCP_EMAIL_PASSWORD from that account and restart the MCP client.');
  if (preset.backend === 'graph') {
    console.log(
      'The IMAP and SMTP host settings become unused: this account now talks to Graph only.',
    );
  }
  console.log('The access token is refreshed automatically from now on.\n');
  /* eslint-enable no-console */
  /* eslint-enable no-console */
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`\nOAuth2 setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  // Set the code rather than calling process.exit(): forcing an immediate exit
  // while the raw-mode stdin handle is still closing trips a libuv assertion on
  // Windows, and can truncate the message printed just above.
  process.exitCode = 1;
});
