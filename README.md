# email-mcp

[![license](https://img.shields.io/github/license/PedroSkyNetFr/email-mcp.svg?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/PedroSkyNetFr/email-mcp/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/PedroSkyNetFr/email-mcp/actions/workflows/ci.yml)

**English** · [Français](README.fr.md)

An MCP (Model Context Protocol) server that gives an AI assistant — Claude
Desktop or any other MCP client — a full email client: read, search, export,
compose, send, schedule and organise mail across several accounts. Mailboxes are
reached over **IMAP + SMTP**, or over **Microsoft Graph** for Exchange Online and
Outlook.com accounts, whose IMAP endpoint hides part of the mailbox.

The server exposes **64 tools** (35 when it runs read-only), **7 prompts** and
**6 resources**.

> **About this fork.** This repository is a fork maintained by
> [@PedroSkyNetFr](https://github.com/PedroSkyNetFr). The npm package
> `@codefuturist/email-mcp` and the `ghcr.io/codefuturist/email-mcp` /
> `codefuturist/email-mcp` Docker images are published by the **original**
> project and do **not** contain this fork's changes (Microsoft Graph backend,
> `.eml` export, secret commands, search coverage reports, …). Install this fork
> from source, as described below.

## Contents

- [Highlights](#highlights)
- [Installation](#installation)
- [Configuration](#configuration)
- [Connecting an MCP client](#connecting-an-mcp-client)
- [Command line](#command-line)
- [Tools reference](#tools-reference)
- [Prompts and resources](#prompts-and-resources)
- [Searching](#searching)
- [Exporting and saving to disk](#exporting-and-saving-to-disk)
- [Drafts, attachments and signatures](#drafts-attachments-and-signatures)
- [Internet headers](#internet-headers)
- [Calendar and reminders](#calendar-and-reminders)
- [Watcher, notifications and AI hooks](#watcher-notifications-and-ai-hooks)
- [Scheduled sending](#scheduled-sending)
- [Mailbox management](#mailbox-management)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Development and contributing](#development-and-contributing)
- [Maintainer](#maintainer)
- [History and credits](#history-and-credits)
- [License](#license)

## Highlights

- **Multi-account**, IMAP and Microsoft Graph accounts side by side; each tool
  call names the account it acts on.
- **Search that says when it is incomplete**: server-side filters, literal
  `*_contains` filters, attachment filters, relative dates (`7d`, `yesterday`),
  facets, Gmail native syntax, search across all accounts. A scan cut short by
  its time budget reports what it covered and how to continue — never a silent
  partial result.
- **Export**: search results to CSV/NDJSON, messages to `.eml` (exact source),
  attachments straight to disk.
- **Compose**: send, reply, forward, drafts that keep their attachments,
  templates, inline (`cid`) images, automatic Outlook signature with its logo.
- **Forensics**: complete Internet headers with the Received chain,
  SPF/DKIM/DMARC verdicts and domain alignment.
- **Organise**: move, delete, flag, labels (Gmail, ProtonMail, IMAP keywords,
  Exchange categories), folders, bulk actions, cross-account move, Exchange
  server-side rules and automatic reply.
- **Automate**: scheduled sending (with an OS-level task on macOS, Linux and
  Windows), IMAP IDLE watcher with static rules, AI triage and desktop/webhook
  alerts, calendar and reminders extraction.
- **Safety**: read-only mode, credentials fetched from a password manager,
  disk-write allow-list, send rate limit, audit log.

## Installation

### Requirements

- **Node.js ≥ 24** (`engines` in `package.json`).
- **pnpm** — the repository pins `pnpm@9.15.0` through `packageManager`;
  `corepack enable` provides it.
- **git**, to clone and to receive updates.

### From source

```bash
git clone https://github.com/PedroSkyNetFr/email-mcp.git
cd email-mcp
pnpm install      # also installs the git hooks (lefthook)
pnpm build        # compiles src/ to dist/ — dist/main.js is what clients run
node dist/main.js --help
```

Then [configure an account](#configuration) and
[register the server with your MCP client](#connecting-an-mcp-client).

### Updating

```bash
git pull
```

`dist/` is not versioned: a pull changes `src/` but the client keeps running the
old compiled code. The git hooks installed by `pnpm install` take care of it —
after a `git pull`, a branch switch or a rebase they rebuild `dist/`, and first
reinstall the locked dependencies when `pnpm-lock.yaml` changed
(`scripts/rebuild-after-update.mjs`). If the hooks are missing, run
`pnpm hooks:install`, or `pnpm install && pnpm build` by hand.

**Then restart the MCP client.** A stdio server is a process the client starts
once; it keeps serving the code it was started with. `check_health` reports which
build is actually running (version, `dist` or `src`, build date) — check it first
when a documented tool seems to be missing.

### Docker (build it yourself)

The repository contains a `Dockerfile` (Node 24, multi-stage) and a
`Dockerfile.alpine`. CI builds the image as a smoke test, but no image of this
fork is published — build your own:

```bash
docker build -t email-mcp-fork .
docker run --rm -i \
  -v ~/.config/email-mcp:/home/node/.config/email-mcp:ro \
  email-mcp-fork
```

The container runs `node dist/main.js stdio` and reads its configuration from the
mounted directory. Keep in mind that inside a container `*_command` secrets,
`signature_path`, the save directories and desktop notifications refer to the
container's filesystem and tools, not the host's.

## Configuration

### Where the configuration lives

The configuration file is `config.toml` in the XDG config directory:
`$XDG_CONFIG_HOME/email-mcp/config.toml`, by default
`~/.config/email-mcp/config.toml` — on Windows too
(`C:\Users\<you>\.config\email-mcp\config.toml`). `node dist/main.js config path`
prints it.

Other locations, also XDG-based:

| Path | Contents |
|------|----------|
| `~/.config/email-mcp/templates/` | email templates (`*.toml`) |
| `~/.local/state/email-mcp/scheduled/` | scheduled-email queue (JSON) |
| `~/.local/state/email-mcp/calendar-processed.json` | emails already added to the calendar |
| `~/.local/share/email-mcp/audit.log` | audit log of write operations (JSON Lines) |
| `~/.local/share/email-mcp/calendar-attachments/` | attachments linked from calendar events |

### First account

```bash
node dist/main.js account add     # interactive wizard (alias: setup)
node dist/main.js test            # test every account
```

The wizard detects the server settings from the address domain, tests the
connection and writes `config.toml`. It handles password accounts; OAuth2 and
Microsoft Graph accounts are written by hand (see
[OAuth2 and Microsoft Graph](#oauth2-and-microsoft-graph)).
`config init` writes a commented template instead, and `config.example.toml` in
the repository shows cPanel, Gmail and iCloud accounts.

Detected providers:

| Provider | Domains |
|----------|---------|
| Gmail | gmail.com, googlemail.com |
| Outlook / Hotmail | outlook.com, hotmail.com, live.com, outlook.de, outlook.co.uk |
| Yahoo Mail | yahoo.com, yahoo.co.uk, yahoo.de, ymail.com |
| iCloud | icloud.com, me.com, mac.com |
| Fastmail | fastmail.com, fastmail.fm |
| ProtonMail Bridge | proton.me, protonmail.com, protonmail.ch, pm.me |
| Zoho Mail | zoho.com, zohomail.com |
| GMX | gmx.com, gmx.de, gmx.net, gmx.at, gmx.ch |

### Accounts (`[[accounts]]`)

```toml
[[accounts]]
name = "personal"                 # the name tools use in their `account` parameter
email = "you@example.com"
full_name = "Your Name"
password_command = 'op read "op://Private/mail/password"'   # or: password = "..."
signature_path = "C:\\Users\\You\\AppData\\Roaming\\Microsoft\\Signatures\\Main.htm"
signature_default = true

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.example.com"
port = 465
tls = true
```

| Key | Default | Meaning |
|-----|---------|---------|
| `name` | *required* | Account name used by every tool. |
| `email` | *required* | Address of the account. |
| `full_name` | — | Display name on sent mail. |
| `username` | `email` | Login, when it differs from the address. |
| `password` | — | Password or app password. |
| `password_command` | — | Command printing the password ([secrets](#keeping-credentials-out-of-the-file)). Exactly one of `password`, `password_command` or an `oauth2` block is required. |
| `oauth2` | — | OAuth2 block (below). |
| `backend` | `"imap"` | `"graph"` serves the account through Microsoft Graph. |
| `sent_folder` | auto | Folder receiving the copy of sent mail (auto-detected through SPECIAL-USE). |
| `save_to_sent` | `true` | `false` stops appending a copy of each SMTP-sent message to the Sent folder. |
| `gmail_auto_save` | `true` | Gmail files sent mail itself, so the append is skipped on Gmail; `false` appends anyway. |
| `signature_path` | — | Outlook `.htm` signature appended on request ([signatures](#outlook-signature)). |
| `signature_default` | `false` | Append the signature to every composed message unless a call says otherwise. |
| `imap.host` / `smtp.host` | *required* | Server host names — required by the schema even for a Graph account, where they are unused. |
| `imap.port` | `993` | |
| `smtp.port` | `465` | |
| `imap.tls` / `smtp.tls` | `true` | Implicit TLS. |
| `imap.starttls` / `smtp.starttls` | `false` | STARTTLS (for SMTP on port 587: `tls = false`, `starttls = true`). |
| `imap.verify_ssl` / `smtp.verify_ssl` | `true` | Verify the server certificate. |
| `smtp.pool.enabled` | `true` | Reuse SMTP connections. |
| `smtp.pool.max_connections` | `1` | |
| `smtp.pool.max_messages` | `100` | Messages per pooled connection. |

### OAuth2 and Microsoft Graph

```toml
[accounts.oauth2]
provider = "google"               # "google" | "microsoft" | "custom"
client_id = "…"
client_secret_command = "…"       # or client_secret = "…"
refresh_token_command = "…"       # or refresh_token = "…"
# provider = "custom" only:
# token_url = "https://…/token"
# auth_url  = "https://…/authorize"
# scopes    = ["…"]
```

The server refreshes the access token by itself, but the first refresh token is
obtained once, interactively, with the helper script:

```bash
pnpm oauth:setup                  # menu of profiles; asks for whatever is missing
pnpm oauth:setup --provider microsoft-graph --client-id <id>
```

It opens the provider's consent page, receives the redirect on
`http://localhost:3000/callback` (register that exact URI with the provider;
`--port` changes it), and prints the refresh token. Pass the client secret
through `OAUTH_CLIENT_SECRET` (and the id through `OAUTH_CLIENT_ID`) to keep it
out of your shell history; it is asked masked otherwise. On Windows,
`scripts/oauth-setup.cmd` can be double-clicked.

| Profile | Scopes | Use |
|---------|--------|-----|
| `microsoft` | `IMAP.AccessAsUser.All`, `SMTP.Send` | Microsoft over IMAP/SMTP — custom folders may be missing |
| `microsoft-graph` | `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite` | **Exchange / Outlook.com accounts with `backend = "graph"`** |
| `microsoft-graph-readonly` | `Mail.Read` | diagnostics only (`pnpm probe:graph`) — never in the configuration |
| `google` | `https://mail.google.com/` | Gmail over IMAP/SMTP |
| `custom` | your own | `--auth-url`, `--token-url`, `--scopes` |

**Why Graph.** Exchange Online and Outlook.com publish only a legacy subset of
the mailbox over IMAP: custom folders can be absent from `LIST` altogether, so
`list_mailboxes` simply does not show them. `pnpm diagnose:mailboxes` compares
the raw IMAP listings to prove it; `pnpm probe:graph` checks what Graph exposes.
An account with `backend = "graph"` is read, written and sent through Graph
only — it never falls back to IMAP, which would return quietly incomplete
results.

A Graph account in `config.toml`, using the endpoints and scopes of the
`microsoft-graph` profile:

```toml
[[accounts]]
name = "outlook"
email = "you@outlook.com"
full_name = "Your Name"
backend = "graph"

[accounts.oauth2]
provider = "custom"
client_id = "<application id>"
client_secret_command = "…"
refresh_token_command = "…"
auth_url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
scopes = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/MailboxSettings.ReadWrite",
  "offline_access",
]

# Required by the schema, unused by a Graph account.
[accounts.imap]
host = "outlook.office365.com"

[accounts.smtp]
host = "smtp-mail.outlook.com"
```

Register the application in Microsoft Entra ID with *supported account types*
that include personal Microsoft accounts if you use an outlook.com address, and
a **Web** platform with the redirect URI above (the token exchange sends a client
secret, so the client must be confidential). Prefer `config.toml` for Graph
accounts: the single-account environment variables have no equivalent of
`token_url` / `auth_url`.

### Keeping credentials out of the file

`config.toml` holds credentials in clear text. Three fields let a command supply
them instead, so the secret stays in a password manager and the file only says
where to fetch it:

| Field | Replaces |
|-------|----------|
| `password_command` | `password` |
| `oauth2.client_secret_command` | `oauth2.client_secret` |
| `oauth2.refresh_token_command` | `oauth2.refresh_token` |

```toml
password_command = 'keepassxc-cli show -q -s -a Password --no-password -k "C:\keys\mail.keyx" "C:\keys\mail.kdbx" "mail/you@example.com"'
```

Other one-liners work unchanged, because the command runs through the platform
shell (`cmd.exe` on Windows, `sh` elsewhere): `bw get password …` (Bitwarden),
`op read "op://…"` (1Password), `pass show …`, `secret-tool lookup …`,
`security find-generic-password … -w` (macOS keychain).

- Give the literal field **or** its `_command`, never both.
- The secret is read from standard output; only trailing newlines are removed.
  Empty output is an error, not an empty password.
- The command must be **non-interactive**: the server has no terminal, so a vault
  that prompts would wait forever. It is killed after 30 seconds with an
  explicit error. With KeePassXC this means a key-file database
  (`--no-password -k`).
- Commands run one at a time, only for the accounts the instance serves (see
  [`MCP_EMAIL_ACCOUNTS`](#several-connectors-on-one-configuration)).
- `email-mcp account edit` never writes the resolved secret back into the file.

This keeps the secret out of backups and synced folders; it is not a defence
against code running as the same user, which can run the same command.

### Global settings (`[settings]`)

| Key | Default | Meaning |
|-----|---------|---------|
| `rate_limit` | `10` | Max messages sent per minute and per account (SMTP sends). |
| `read_only` | `false` | Read-only mode: write tools are not registered and the scheduled queue is not processed ([details](#read-only-mode)). |
| `watcher.enabled` | `false` | IMAP IDLE watcher. |
| `watcher.folders` | `["INBOX"]` | Folders watched in each account. |
| `watcher.idle_timeout` | `1740` | IDLE renewal, in seconds (60–1740). |
| `hooks.*`, `hooks.alerts.*`, `hooks.rules` | | See [watcher and hooks](#watcher-notifications-and-ai-hooks). |

Optional sections: `[[searches]]` ([saved searches](#saved-searches)) and
`[database]` ([cross-account move](#cross-account-move)).

### Environment variables

**Single-account mode.** When `MCP_EMAIL_ADDRESS`, `MCP_EMAIL_IMAP_HOST`,
`MCP_EMAIL_SMTP_HOST` and one of `MCP_EMAIL_PASSWORD`,
`MCP_EMAIL_PASSWORD_COMMAND` or `MCP_EMAIL_OAUTH2_PROVIDER` are all set, the
server builds one account from the environment and **does not read
`config.toml` at all** (no other account, no `[[searches]]`).

| Variable | Default | TOML equivalent |
|----------|---------|-----------------|
| `MCP_EMAIL_ADDRESS` | *required* | `email` |
| `MCP_EMAIL_IMAP_HOST` / `MCP_EMAIL_SMTP_HOST` | *required* | `imap.host` / `smtp.host` |
| `MCP_EMAIL_PASSWORD` / `MCP_EMAIL_PASSWORD_COMMAND` | | `password` / `password_command` |
| `MCP_EMAIL_OAUTH2_PROVIDER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` | | `oauth2.*` |
| `MCP_EMAIL_ACCOUNT_NAME` | `default` | `name` |
| `MCP_EMAIL_FULL_NAME`, `MCP_EMAIL_USERNAME` | | `full_name`, `username` |
| `MCP_EMAIL_BACKEND` | `imap` | `backend` (`graph`) |
| `MCP_EMAIL_SIGNATURE_PATH`, `MCP_EMAIL_SIGNATURE_DEFAULT` | | `signature_path`, `signature_default` |
| `MCP_EMAIL_IMAP_PORT`, `_TLS`, `_STARTTLS`, `_VERIFY_SSL` | `993`, `true`, `false`, `true` | `imap.*` |
| `MCP_EMAIL_SMTP_PORT`, `_TLS`, `_STARTTLS`, `_VERIFY_SSL` | `465`, `true`, `false`, `true` | `smtp.*` |
| `MCP_EMAIL_SMTP_POOL_ENABLED`, `_MAX_CONNECTIONS`, `_MAX_MESSAGES` | `true`, `1`, `100` | `smtp.pool.*` |
| `MCP_EMAIL_RATE_LIMIT` | `10` | `settings.rate_limit` |
| `MCP_EMAIL_WATCHER_ENABLED`, `_FOLDERS` (comma-separated), `_IDLE_TIMEOUT` | `false`, `INBOX`, `1740` | `settings.watcher.*` |
| `MCP_EMAIL_HOOK_ON_NEW_EMAIL`, `_PRESET`, `_AUTO_LABEL`, `_AUTO_FLAG`, `_BATCH_DELAY`, `_CUSTOM_INSTRUCTIONS` | | `settings.hooks.*` |
| `MCP_EMAIL_HOOK_AUTO_CALENDAR`, `_CALENDAR_NAME`, `_CALENDAR_ALARM_MINUTES`, `_CALENDAR_CONFIRM` | | `settings.hooks.*` |
| `MCP_EMAIL_ALERT_DESKTOP`, `_SOUND`, `_URGENCY_THRESHOLD`, `_WEBHOOK_URL` | | `settings.hooks.alerts.*` |

**Variables that also apply on top of `config.toml`:**

| Variable | Effect |
|----------|--------|
| `MCP_EMAIL_ACCOUNTS` | Comma-separated account names this instance exposes ([below](#several-connectors-on-one-configuration)). |
| `MCP_EMAIL_READ_ONLY` | `true` makes the instance read-only. It can only tighten: it never lifts a `read_only = true` set in the file. |
| `EMAIL_MCP_DATABASE_URL` | Postgres URL for `cross_account_move`; wins over `[database].url`. |
| `MAIL_ALLOWED_SAVE_DIRS` | Extra directories (`;`-separated) where files may be written ([details](#where-files-may-be-written)). |
| `MAIL_ALLOW_ANY_SAVE_DIR` | `true` disables the save-directory allow-list. |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | Move the directories listed [above](#where-the-configuration-lives). |

## Connecting an MCP client

### Claude Desktop

Edit the client configuration file, then **quit Claude Desktop completely and
start it again**:

| OS | File |
|----|------|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Windows:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["C:\\path\\to\\email-mcp\\dist\\main.js", "stdio"]
    }
  }
}
```

macOS / Linux:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/email-mcp/dist/main.js", "stdio"]
    }
  }
}
```

If `node` is not on the client's `PATH`, give its absolute path in `command`.
Environment variables (`MCP_EMAIL_ACCOUNTS`, `MAIL_ALLOWED_SAVE_DIRS`, …) go in an
`"env": { … }` object next to `args`.

### Several connectors on one configuration

An MCP client switches a whole server on or off, never one account inside it. To
get one switch per account, declare several entries pointing at the same
`dist/main.js` and the same `config.toml`, each restricted with
`MCP_EMAIL_ACCOUNTS`:

```json
{
  "mcpServers": {
    "email-personal": {
      "command": "node",
      "args": ["C:\\path\\to\\email-mcp\\dist\\main.js", "stdio"],
      "env": { "MCP_EMAIL_ACCOUNTS": "personal" }
    },
    "email-work": {
      "command": "node",
      "args": ["C:\\path\\to\\email-mcp\\dist\\main.js", "stdio"],
      "env": { "MCP_EMAIL_ACCOUNTS": "work,outlook", "MCP_EMAIL_READ_ONLY": "true" }
    }
  }
}
```

- Unset or empty: every account is exposed.
- An unknown name is **refused at startup**, with the list of configured
  accounts — a typo would otherwise silently shrink what the instance serves.
- Account order comes from the file, not from the variable.
- The filter never touches the file; secret commands run only for the accounts
  the instance serves; a scheduled email is sent only by an instance that serves
  its account.

### Guided registration and other clients

`node dist/main.js install` detects Claude Desktop, Cursor (`~/.cursor/mcp.json`)
and Windsurf (`~/.codeium/windsurf/mcp_config.json`) and writes an `email` entry.
**Choose "Direct node (current dist/main.js)"**: the `npx`, `pnpm dlx` and global
options launch the original npm package, not this fork. `install status` and
`install remove` show or undo the registration.

Any other MCP client works the same way: a stdio server whose command is
`node <path>/dist/main.js stdio`.

## Command line

`node dist/main.js <command>` (or `email-mcp <command>` if you link the package):

| Command | Effect |
|---------|--------|
| `stdio` | Run the MCP server over stdio (default when no command is given). |
| `account list` / `add` / `edit [name]` / `delete [name]` | Manage accounts interactively (`ls`, `new`, `rm`, `remove` are aliases). |
| `setup` | Alias of `account add`. |
| `test [name]` | Test every account, or one, over the transport it really uses (Graph for a Graph account, IMAP + SMTP otherwise). |
| `install` / `install status` / `install remove` | Register / show / remove the server in MCP clients. |
| `config show` | Show the configuration, passwords masked. |
| `config edit` | Edit global settings (rate limit, read-only). |
| `config path` | Print the configuration file path. |
| `config init` | Write a commented template. |
| `scheduler check` | Send the scheduled emails that are due. |
| `scheduler list` | Show pending, sent and failed scheduled emails. |
| `scheduler install` / `uninstall` / `status` | Manage the OS-level periodic check. |
| `notify test` / `notify status` | Send a test desktop notification / diagnose support. |
| `--version`, `help` | |

Developer scripts (`pnpm <script>`): `oauth:setup`, `diagnose:mailboxes`,
`probe:graph`, `verify:graph` (Graph smoke test), `mcp:call` (call tools of the
built server the way a client does), `db:migrate`.

## Tools reference

**64 tools.** *Backend* says which accounts a tool serves: **both** (IMAP and
Graph), **IMAP** only (a Graph account gets an explicit "not supported yet"
error), **Graph** only (the tool refuses an IMAP account), or **local** (no
mailbox involved). *Read-only* says whether the tool is still registered when the
server is [read-only](#read-only-mode).

### Reading

| Tool | What it does | Backend | Read-only |
|------|--------------|---------|-----------|
| `list_accounts` | Configured accounts — call it first to learn the names. | local | ✅ |
| `list_mailboxes` | Folders with unread counts and special-use flags. | both | ✅ |
| `list_emails` | Paginated listing with filters. | both | ✅ |
| `get_email` | One message (`format`: `full`, `text`, `stripped`; `maxLength`); does not mark it read unless `markRead`. | both | ✅ |
| `get_emails` | Up to 20 messages in one call (text by default). | both | ✅ |
| `get_email_status` | Read / flag / label state without the body. | both | ✅ |
| `get_thread` | Conversation rebuilt from `References` / `In-Reply-To`. | both | ✅ |
| `get_email_headers` | Complete Internet headers and their analysis ([details](#internet-headers)). | both | ✅ |
| `find_email_folder` | Real folder(s) of a message seen in a virtual folder (Gmail "All Mail"). | IMAP | ✅ |
| `extract_contacts` | Frequent correspondents from recent headers. | IMAP | ✅ |
| `get_email_stats` | Volume, top senders, daily trend over a day / week / month. | IMAP | ✅ |
| `check_health` | Running build, connection, latency, quota and capabilities per account. | both | ✅ |

### Searching

| Tool | What it does | Backend | Read-only |
|------|--------------|---------|-----------|
| `search_emails` | Free text and filters, facets, Gmail syntax ([details](#searching)). | both | ✅ |
| `search_all_accounts` | Same search across several accounts, merged by date; IMAP and Graph accounts can be mixed. | both | ✅ |
| `run_preset` | Run a saved search from `[[searches]]`. | both | ✅ |
| `list_presets` | List AI triage presets and saved searches. | local | ✅ |

### Export and saving to disk

| Tool | What it does | Backend | Read-only |
|------|--------------|---------|-----------|
| `export_search` | Search results to a CSV or NDJSON file. | both (mixable) | ✅ |
| `save_email` | One message as an `.eml` file (exact source). | both | ✅ |
| `save_emails_from_search` | Every message of a search as `.eml` files. | both (one backend per call) | ✅ |
| `download_attachment` | One attachment, returned base64 (≤ 5 MB). | both | ✅ |
| `save_attachment` | One attachment written to disk, no size cap. | both | ✅ |
| `save_all_attachments_from_search` | Every attachment of a search to a folder. | IMAP | ✅ |

### Composing and sending

| Tool | What it does | Backend | Read-only |
|------|--------------|---------|-----------|
| `send_email` | New message: text or HTML, cc/bcc, attachments, inline images, signature. | both | — |
| `reply_email` | Threaded reply (`replyAll`, `includeAttachments`, `appendSignature`). | both | — |
| `forward_email` | Forward with the original quoted. | both | — |
| `save_draft` | Save a draft (attachments, `in_reply_to`, signature). | both | — |
| `update_draft` | Rewrite a draft, keeping or changing its attachments. | both | — |
| `send_draft` | Send a draft and remove it from Drafts. | both | — |
| `list_templates` | Templates found in `~/.config/email-mcp/templates/`. | local | ✅ |
| `apply_template` | Fill a template: `preview`, `draft` or `send`. | both | — |
| `schedule_email` | Queue a message for a later time. | both | — |
| `list_scheduled` | Scheduled emails by status. | local | — |
| `cancel_scheduled` | Cancel a scheduled email and delete its draft mirror. | both | — |

### Organising

| Tool | What it does | Backend | Read-only |
|------|--------------|---------|-----------|
| `move_email` | Move to another folder of the same account. | both | — |
| `delete_email` | To Trash, or permanently with `permanent: true`. | both | — |
| `mark_email` | Read / unread / flag / unflag. | both | — |
| `bulk_action` | Same action on up to 100 messages. | both | — |
| `list_labels` | Labels of the account. | both | — |
| `add_label` / `remove_label` | Label a message / remove the label. | both | — |
| `create_label` / `delete_label` | Create / delete a label. | both | — |
| `create_mailbox` / `rename_mailbox` / `delete_mailbox` | Folder management (`delete_mailbox` deletes the content too). | both | — |
| `cross_account_move` | Move messages to another account, keeping headers, flags and date. Needs Postgres. | IMAP | — |
| `list_mail_rules` | Server-side inbox rules. | Graph | — |
| `create_mail_rule` / `delete_mail_rule` | Create / delete a server-side rule. | Graph | — |
| `get_auto_reply` / `set_auto_reply` | Read / set the automatic reply (out of office). | Graph | — |

### Calendar and reminders

| Tool | What it does | Backend | Read-only |
|------|--------------|---------|-----------|
| `extract_calendar` | Events (ICS) carried by a message. | IMAP | ✅ |
| `analyze_email_for_scheduling` | Detect an event or a reminder-worthy request in a message. | IMAP | ✅ |
| `add_to_calendar` | Add the message's event to the local calendar. | IMAP | ✅ |
| `create_reminder` | Create a macOS Reminders item from a message. | both | ✅ |
| `list_calendars` / `list_events` | Local calendars and events (macOS). | local | ✅ |
| `list_reminders` | Reminders (macOS). | local | ✅ |
| `check_calendar_permissions` | Check calendar access and explain how to grant it. | local | ✅ |

### Watcher and alerts

| Tool | What it does | Backend | Read-only |
|------|--------------|---------|-----------|
| `get_watcher_status` | IDLE connections and recent activity. | IMAP | ✅ |
| `get_hooks_config` | Current hooks configuration (preset, rules, instructions). | local | ✅ |
| `check_notification_setup` | Diagnose desktop notifications on this OS. | local | ✅ |
| `test_notification` | Send a test notification. | local | ✅ |
| `configure_alerts` | Change alert settings at runtime, optionally saved to `config.toml`. | local | — |

### IMAP and Exchange at a glance

| Capability | IMAP | Microsoft Graph |
|------------|:----:|:---------------:|
| Read, threads, headers, status | ✅ | ✅ |
| Search, list, export, `.eml`, single attachments | ✅ | ✅ (some filters ignored, [see below](#on-microsoft-graph-accounts)) |
| Facets, `gmail_raw` | ✅ (Gmail for `gmail_raw`) | — |
| Send, reply, forward, drafts, templates, scheduling | ✅ | ✅ |
| Move, delete, flags, bulk, folders | ✅ | ✅ |
| Labels | Gmail labels, ProtonMail label folders, IMAP keywords | Outlook categories |
| `save_all_attachments_from_search`, `extract_contacts`, `get_email_stats`, `find_email_folder` | ✅ | — |
| Calendar extraction (`extract_calendar`, `analyze_email_for_scheduling`, `add_to_calendar`) | ✅ | — |
| `cross_account_move` | ✅ | — |
| Watcher (IMAP IDLE) and per-account resources (`mailboxes`, `unread`, `stats`) | ✅ | — (they go through IMAP) |
| Server-side rules, automatic reply | — | ✅ |

## Prompts and resources

**Prompts (7)** — ready-made instructions the client can offer the user:

| Prompt | Arguments | Purpose |
|--------|-----------|---------|
| `triage_inbox` | `account`, `mailbox`, `limit` | Sort unread mail by urgency, with suggested actions. |
| `summarize_thread` | `account`, `message_id`, `mailbox` | Participants, timeline, decisions, action items. |
| `compose_reply` | `account`, `email_id`, `mailbox`, `intent`, `tone` | Draft a reply with the thread as context. |
| `draft_from_context` | `account`, `topic`, `to`, `tone` | Write a new email, searching past mail for context. |
| `extract_action_items` | `account`, `mailbox`, `limit` | Tasks, deadlines and commitments from recent mail. |
| `summarize_meetings` | `account`, `days` | Meeting overview from recent invitations. |
| `cleanup_inbox` | `account`, `older_than_days`, `dry_run` | Suggest — or carry out — archiving and deletions. |

**Resources (6)** — read-only data the client can attach:

| URI | Contents |
|-----|----------|
| `email://accounts` | Configured accounts. |
| `email://scheduled` | Pending scheduled emails. |
| `email://{account}/mailboxes` | Folder tree with message counts. |
| `email://{account}/unread` | Unread counts by folder. |
| `email://{account}/stats` | Daily statistics snapshot and quota. |
| `email://templates/{name}` | One template. |

The three per-account resources query IMAP directly, so they are meant for IMAP
accounts.

## Searching

`list_emails`, `search_emails`, `search_all_accounts`, `export_search`,
`save_emails_from_search` and `save_all_attachments_from_search` share one set of
filters. Filters combine with AND. Results are paginated (`page`, `pageSize` up
to 100, default 20).

### Filters

| Parameter | Matches |
|-----------|---------|
| `query` | Free text across subject, sender and body (`search_emails` and the multi-account / export tools). |
| `from`, `to`, `cc`, `bcc`, `subject` | Header, **matched by the mail server** (see below). |
| `from_contains`, `to_contains`, `subject_contains` | Literal, case-insensitive substring of the decoded header, checked by email-mcp. |
| `body`, `text` | Body / headers + body. |
| `since`, `before`, `on` | Arrival date — on or after, strictly before, on. |
| `sent_since`, `sent_before` | `Date:` header. |
| `seen`, `flagged`, `answered`, `draft`, `deleted` | `true` / `false`. |
| `keyword`, `not_keyword` | IMAP keyword(s) — custom flags, used as labels by keyword-based servers. |
| `header` | `{ "X-Header": "value" }`. |
| `uids` | UID list or range (`"1:100"`) — `list_emails` and `search_emails`. |
| `larger_than`, `smaller_than` | Size in KB. |
| `has_attachment` | Has at least one attachment. |
| `attachment_filename` | Substring of an attachment file name. |
| `attachment_mimetype` | Case-insensitive regular expression on `type/subtype` (`"application/pdf"`, `"image/.*"`). |
| `facets` | `["sender", "year", "mailbox"]` — counts over the whole match set (`search_emails`, `search_all_accounts`). |
| `gmail_raw` | Gmail native search syntax (`from:x has:attachment older_than:30d`), Gmail accounts only. |

**Dates** accept ISO 8601, `YYYY-MM-DD`, relative tokens `Nd`, `Nw`, `Nm`
(days, weeks, months ago) and `today` / `yesterday`, evaluated in UTC — on every
search tool and both backends.

```jsonc
// search_emails
{ "account": "work", "subject": "invoice", "since": "60d", "has_attachment": true }
```

### Server-matched filters and `*_contains`

`from`, `to` and `subject` are handed to the mail server, and its index decides.
RFC 3501 defines a substring match, but a server with a full-text index (Dovecot
FTS, as used by OVH for instance) matches indexed **tokens**: `example.com` then
misses `news.example.com`, and a fragment that starts mid-word finds nothing —
with nothing in the answer to tell it apart from an empty mailbox. When the
result must be exhaustive, use `from_contains`, `to_contains`,
`subject_contains`: they are checked here on the decoded header and give the same
result on IMAP and Graph. They do not narrow the server query, so pair them with
`since` / `before` or a coarse filter on a large folder.

### Partial scans and continuation

Some filters require reading each candidate message: `has_attachment` and
`attachment_*` on IMAP, `*_contains` on both backends. They are applied
**before pagination** — pages and totals count only matching messages — newest
first, within two bounds per call:

- a **45-second time budget** (MCP clients give up on a call after about 60 s);
- **5000 examined messages**.

When a bound stops the scan, the answer says so — the warning shows the total as
`~N`, and a `coverage` object (also in the JSON output of the export tools, per
account) gives what was covered and how to continue:

```jsonc
{
  "stoppedBy": "time_budget",            // or "message_cap", or "server_cap" (Graph)
  "examined": 1200,
  "candidates": 2199,
  "oldestExamined": "2025-03-14T22:10:05.000Z",
  "continueBefore": "2025-03-16",
  "hint": "Partial scan: … re-run the same call with before: \"2025-03-16\" …"
}
```

Re-run the same call with `before: <continueBefore>` to scan the next slice;
repeating covers the whole mailbox. Slices may overlap slightly (a message can
appear twice) but never leave a gap. When a single day holds more than one call
can examine, no continuation is offered and the hint asks for another filter.

A search the server rejects or times out is reported as a failure
(`searchFailed` and a warning), never as zero results. On a very large folder
without a full-text index, a body search runs on a bounded connection and comes
with a cost warning.

### On Microsoft Graph accounts

- Without query text, Graph's `$filter` handles dates, `seen`, `flagged` and
  `has_attachment`; `*_contains` filters then walk the folder page by page,
  newest first, and are applied before pagination with the same budget, cap and
  `coverage` as IMAP.
- With query text, `subject`, `from` or `to`, Graph's `$search` is used. It
  refuses date filters alongside, so dates are pushed into the query and every
  other criterion is checked on each result. Graph returns at most 1000 `$search`
  results; reaching that ceiling is reported as `stoppedBy: "server_cap"`.
- Filters with no faithful Graph translation — `cc`, `bcc`, `text`, `body`,
  `answered`, `draft`, `deleted`, `keyword`, `not_keyword`, `header`, `uids`,
  `larger_than`, `smaller_than`, `attachment_filename`, `attachment_mimetype`,
  `gmail_raw` — are ignored, and the answer lists them
  (`Not supported on this Microsoft Graph account and IGNORED: …`). `facets` are
  not computed on Graph.

### Searching across accounts

`search_all_accounts` runs the same search on several accounts in parallel
(`accounts`, every account when omitted), merges by date and prefixes each result
with its account. One failing account becomes a warning instead of failing the
call. When the requested `mailbox` does not exist in an account, its equivalent
is found through the server's SPECIAL-USE flags (`\All`, `\Archive`, `\Sent`,
`\Trash`, `\Drafts`, `\Junk`), and the remapping is reported. With `facets`, the
`mailbox` facet is keyed by account.

### Gmail native search

On an account whose IMAP host is `imap.gmail.com`, `gmail_raw` passes Gmail's own
search syntax to the server (`X-GM-RAW`) — much faster on large mailboxes. The
other filters are then ignored, with a warning; on any other account it is an
error.

### Saved searches

```toml
[[searches]]
name = "lease-2024"
description = "Lease paperwork for 2024"
accounts = ["personal", "work"]      # or account = "…"; neither = first account
subject = "lease"
since = "2024-01-01"
before = "2025-01-01"
has_attachment = true
attachment_filename = "lease"
facets = ["sender", "year"]
```

A preset accepts `query`, `mailbox`, the header, date, state, size and
attachment filters, `keyword` / `not_keyword`, `header`, `facets` and
`gmail_raw` (not `*_contains` nor `uids`). Run it with
`run_preset { "name": "lease-2024", "pageSize": 20 }`; `list_presets` lists them.

## Exporting and saving to disk

| You want | Tool | Writes |
|----------|------|--------|
| Metadata of many messages | `export_search` | one CSV or NDJSON file |
| The messages themselves | `save_email`, `save_emails_from_search` | one `.eml` per message |
| The attached files | `save_attachment`, `save_all_attachments_from_search` | the attachments |

The answer carries a short summary — path, counts, `truncated`, `coverage` —
while the data stays on disk, so large exports do not fill the conversation.

- **`export_search`** — `format`: `csv` (default) or `ndjson`; `max_rows` 5000 by
  default, 50 000 at most. Default CSV columns: `id`, `account`, `date`, `from`,
  `subject`, `labels`, `attachments`, `has_attachments`, `seen`, `flagged`;
  `columns` picks among `id`, `account`, `date`, `from`, `to`, `subject`, `flags`,
  `labels`, `attachments`, `preview`, `size`. NDJSON writes the full record. Default
  file: `~/Downloads/email-export-<timestamp>.csv`.
- **`save_email`** — the exact RFC 822 source, so attachments, formatting, DKIM
  signatures and the Received chain survive, and the file reopens in any mail
  client. Default name: `~/Downloads/<date>_<subject>_<id>.eml`.
- **`save_emails_from_search`** — `max_emails` (500 by default),
  `organize_by`: `flat`, `date` (`YYYY-MM/`), `sender` (sender domain) or
  `account`. A failing message is listed in `errors` and the batch goes on. The
  answer gives `matched` (what the search returned) next to `files_saved`: a low
  `matched` points at the query, a gap between the two points at the writes.
- **`save_attachment`** — streams the file to disk with no size cap (unlike
  `download_attachment`, base64 and 5 MB). `open: true` opens it afterwards
  (macOS). An existing file gets a `-1`, `-2` suffix unless `overwrite: true`.
- **`save_all_attachments_from_search`** — every attachment of the matches,
  optionally narrowed by `attachment_filename` / `attachment_mimetype`, into
  `~/Downloads/email-attachments-<timestamp>/`, with the same `organize_by`
  values; `max_emails` 1000 by default.

### Where files may be written

Every destination must be an absolute path under an allowed root: your home
directory and the OS temp directory by default. Literal `..` segments are
refused and the comparison is OS-aware (case-insensitive on Windows, so
`D:\Exports-evil` is not inside `D:\Exports`). Add roots with
`MAIL_ALLOWED_SAVE_DIRS` (`;`-separated):

```json
"env": { "MAIL_ALLOWED_SAVE_DIRS": "D:\\Archives;D:\\Exports" }
```

`MAIL_ALLOW_ANY_SAVE_DIR=true` removes the allow-list. It exists because the
server is driven by a model that reads untrusted email: a prompt-injection must
not be able to steer a write into a startup folder.

## Drafts, attachments and signatures

### Attachments

`send_email`, `save_draft` and `update_draft` take attachments in three forms:

```jsonc
"attachments": [
  { "path": "C:\\Docs\\quote.pdf" },                                     // local file
  { "content_base64": "JVBERi0…", "filename": "note.pdf" },             // bytes
  { "source_email_id": "4711", "source_mailbox": "INBOX", "filename": "plan.pdf" } // from a message, server side
]
```

The third form copies an attachment from an existing message without the bytes
travelling through the conversation. `reply_email` can re-attach the original's
files with `includeAttachments: true`. On Graph accounts, attachments over 3 MB
go through an upload session.

### Inline images (`cid`)

Any attachment carrying a `cid` becomes an inline image (`multipart/related`),
referenced from the HTML body:

```jsonc
{
  "account": "work", "to": ["someone@example.com"], "subject": "Hello",
  "html": true,
  "body": "<p>Hi!</p><img src=\"cid:logo\">",
  "attachments": [{ "path": "/abs/logo.png", "cid": "logo" }]
}
```

### Outlook signature

With `signature_path` pointing at an Outlook `.htm` signature (on Windows under
`%APPDATA%\Microsoft\Signatures\`), the server reads the file, embeds the images
of its sibling folder as inline `cid` images, appends it below the body and
switches the message to HTML. The server must run on the machine where that file
exists.

| Tool | Parameter | Omitted means |
|------|-----------|---------------|
| `send_email`, `save_draft` | `append_signature` | the account's `signature_default` |
| `reply_email`, `forward_email` | `appendSignature` | the account's `signature_default` |
| `update_draft` | `append_signature` | **no signature** |

`update_draft` never signs implicitly, so rewriting a draft cannot stack a
second signature: a new `body` replaces the old one as given, an omitted `body`
is kept as is (with its signature and inline images). Pass
`append_signature: true` with a new `body` to sign it; without a new body it is
ignored with a warning.

### Drafts

- `save_draft` saves to the Drafts folder; `send_draft` sends it and removes it,
  keeping its attachments.
- `update_draft` rewrites a draft. Omitted fields (subject, body, recipients)
  keep their value; `attachments_keep` (all by default, `[]` drops them),
  `attachments_add` and `attachments_remove` handle files. On IMAP, which has no
  in-place edit, the new copy is appended first and the old one deleted only
  afterwards; the tool returns the **new** id. Inline images referenced by the
  body are kept; a `cid:` with no matching image produces a warning.

### Templates

A template is a TOML file in `~/.config/email-mcp/templates/`:

```toml
name = "follow-up"
description = "Polite follow-up"
subject = "Following up on {{topic}}"
body = "Hello {{name}},\n\nI am following up on {{topic}}."
variables = ["name", "topic"]
```

`apply_template { "account": "work", "template": "follow-up", "variables": {…},
"action": "preview" | "draft" | "send", "to": […] }`.

## Internet headers

`get_email` exposes a flattened header map — one value per name, enough for a
`List-Unsubscribe`, useless for tracing a message that crossed several relays.
`get_email_headers` returns:

- **`analysis`** — the `Received` chain in chronological order with the delay at
  each hop, SPF / DKIM / DMARC verdicts from `Authentication-Results` (the
  topmost one, added by your own server, wins), DKIM signatures, and
  From / Return-Path / SPF / DKIM domain alignment;
- **`headers`** — every occurrence, unfolded, in message order
  (`include_all_headers: false` drops it);
- **`raw`** — the header block as received (`include_raw: true`).

`format: "json"` returns the structured dump instead of the readable report. Only
the header block is fetched and the message is not marked read. On Graph accounts
the list comes from `internetMessageHeaders` and the raw block is rebuilt from it
(`rawReconstructed: true`). The verdicts are claims made by relays, not checks
re-run locally — see [SECURITY.md](SECURITY.md).

## Calendar and reminders

- `extract_calendar` returns the events of the ICS parts of a message (inline
  `text/calendar` or `.ics` attachment).
- `analyze_email_for_scheduling` tells the model whether a message holds an
  event, a reminder-worthy request, both or neither — the first step before
  creating anything.
- `add_to_calendar` adds the event to the local calendar with the meeting link
  (Zoom, Teams, Meet), dial-in details, attendees, an excerpt and links to the
  saved attachments (`calendar_name`, `alarm_minutes`, `save_attachments`).
  On **macOS** it writes to Calendar.app after a native confirmation dialog
  (`confirm`) and skips duplicates; on **Linux** it opens a generated `.ics` with
  `xdg-open`. Windows has no calendar integration.
- `create_reminder`, `list_reminders`, `list_calendars`, `list_events` use macOS
  Reminders and Calendar. `check_calendar_permissions` explains how to grant
  access (System Settings → Privacy & Security).

These tools stay available in read-only mode: they write to the local calendar,
never to the mailbox.

## Watcher, notifications and AI hooks

With `settings.watcher.enabled = true`, the server keeps an IMAP IDLE connection
per watched folder (separate from tool connections, reconnecting with a backoff
from 1 s up to 60 s). New messages go through:

1. **Static rules** — patterns on from / to / subject; the first matching rule
   applies its actions and the message skips AI triage.
2. **AI triage** — when `on_new_email = "triage"` and the client supports MCP
   *sampling*, messages are batched (`batch_delay`) and sent to the model with
   the chosen preset (at most 10 sampling calls a minute). Without sampling
   support it falls back to notification.
3. **Notify** — logs the arrival, and raises an alert when the priority reaches
   the threshold.

```toml
[settings.watcher]
enabled = true
folders = ["INBOX"]

[settings.hooks]
on_new_email = "triage"           # "triage" | "notify" | "none"
preset = "priority-focus"         # "inbox-zero" | "gtd" | "priority-focus" | "notification-only" | "custom"
auto_label = false                # apply labels suggested by the AI
auto_flag = false                 # flag urgent messages
batch_delay = 5                   # seconds (1–60)
custom_instructions = "Mail from @mycompany.com is high priority."
# system_prompt = "…"             # full prompt, with preset = "custom"
auto_calendar = false             # add detected events to the calendar
calendar_name = ""
calendar_alarm_minutes = 15
calendar_confirm = true

[[settings.hooks.rules]]
name = "GitHub"
match = { from = "*@github.com|*@gitlab.com" }
actions = { labels = ["Dev"], mark_read = true }

[[settings.hooks.rules]]
name = "VIP"
match = { from = "ceo@company.com" }
actions = { flag = true, alert = true, labels = ["VIP"] }

[settings.hooks.alerts]
desktop = true
sound = false
urgency_threshold = "high"        # "urgent" | "high" | "normal" | "low"
webhook_url = "https://ntfy.sh/my-mail"
webhook_events = ["urgent", "high"]
```

- **Patterns**: `*` wildcard, `|` for alternatives, case-insensitive; conditions
  of one rule are combined with AND.
- **Rule actions**: `labels`, `flag`, `mark_read`, `alert` (desktop
  notification whatever the threshold), `add_to_calendar`.
- **Presets**: `inbox-zero` (aggressive categorisation), `gtd` (`@Action`,
  `@Waiting`, …), `priority-focus` (priority only, default), `notification-only`,
  `custom`.
- **Desktop notifications**: macOS (`osascript`), Linux (`notify-send`, plus
  `paplay` for sound), Windows (PowerShell). `check_notification_setup` diagnoses,
  `test_notification` or `email-mcp notify test` verifies.
- **Webhook**: an HTTP POST of
  `{ "event": "email.urgent", "account", "sender", "subject", "priority", … }`
  for the priorities listed in `webhook_events` (Slack, Discord, ntfy.sh, …).
- `configure_alerts` changes these alert settings at runtime and, with
  `save: true`, writes them to `config.toml`. It is not registered in read-only
  mode, since it can set a webhook and rewrite the file.

When new mail is processed, the server pushes `notifications/resources/updated`
for the account's `unread` and `mailboxes` resources to subscribed clients. The
watcher works over IMAP only.

## Scheduled sending

`schedule_email` queues a message (`send_at` in ISO 8601) as a JSON file in
`~/.local/state/email-mcp/scheduled/` and mirrors it as a `[Scheduled: …]` draft.
It goes out through its account's own backend (SMTP or Graph). Three things can
send it:

1. a running MCP server — at startup, then every minute — unless it is
   read-only;
2. `email-mcp scheduler check`, by hand;
3. the **OS-level periodic check**, which sends even when no client is open:

```bash
node dist/main.js scheduler install     # macOS launchd, Linux crontab, Windows Task Scheduler — every minute
node dist/main.js scheduler status
node dist/main.js scheduler list
node dist/main.js scheduler uninstall
```

On Windows the task, `email-mcp scheduler`, runs without a window. From an
administrator terminal it runs whether you are signed in or not; from a normal
terminal only while you are signed in — `install` says which, `status` shows it
with the last run. The task records the paths of `node` and of email-mcp at
install time: reinstall after moving the folder or changing Node.

Delivery guarantees: several processes may share the queue, but each email is
claimed (`<id>.claim`) by one process only, so it is sent once. A failed send is
retried up to **3 times**, then marked `failed`. A send interrupted midway is
never retried automatically — the server may already have accepted it — and is
marked `failed` after 15 minutes ("Interrupted while sending: it may have gone
out"); check the Sent folder before scheduling it again. An instance only sends
the emails of the accounts it serves. `cancel_scheduled` removes the entry and its
draft.

## Mailbox management

### Labels

`list_labels` detects the account's label system:

| Provider | Labels are |
|----------|-----------|
| Gmail | Gmail labels (`X-GM-LABELS`) |
| ProtonMail (Bridge) | folders under `Labels/` — `add_label` copies the message there |
| Other IMAP servers | IMAP keywords (created on first use; cannot be deleted server-wide) |
| Microsoft Graph | Outlook categories |

### Folders and virtual folders

`move_email` and `delete_email` need the real folder of a message. A message
found in a virtual folder (Gmail "All Mail", "Starred") must first be located with
`find_email_folder`. `delete_mailbox` permanently deletes the folder and its
content.

### Cross-account move

`cross_account_move` moves messages between two configured IMAP accounts: it
fetches the raw message, appends it to the destination with its flags and
original date (it looks natively delivered), records the move, then moves the
source copy to the source account's Trash. A message already present at the
destination is skipped. The move log lives in **PostgreSQL**; without a database,
this tool refuses and every other tool works normally.

```toml
[database]
url = "postgresql://email_mcp:PASSWORD@HOST:5432/email_mcp"   # or EMAIL_MCP_DATABASE_URL
```

```bash
pnpm db:migrate             # apply pending migrations (migrations/*.sql)
pnpm db:migrate --status    # applied and pending, change nothing
pnpm db:migrate --dry-run   # list pending
```

Migrations are forward-only and recorded in `schema_migrations`. Use a dedicated
role that can only reach the `email_mcp` database; on PostgreSQL 15+ also run
`ALTER SCHEMA public OWNER TO email_mcp;` in that database, or the first migration
fails with "permission denied for schema public".

### Exchange rules and automatic reply

On Graph accounts, `create_mail_rule` creates a server-side inbox rule —
conditions `from_addresses`, `subject_contains`, `body_contains`; actions
`move_to_mailbox` (a folder path such as `"Clients/Invoices"`), `mark_as_read`,
`mark_importance`, `delete_message`, `stop_processing`; `sequence`, `enabled`.
Rules run in the mailbox, even when nothing is connected. `set_auto_reply` sets
the out-of-office reply: `status` `disabled`, `alwaysEnabled` or `scheduled`
(with `start_datetime`, `end_datetime`, `time_zone`), `internal_message`,
`external_message`, `external_audience` (`none`, `contactsOnly`, `all`).

## Security

### Read-only mode

`read_only = true` in `[settings]`, or `MCP_EMAIL_READ_ONLY=true` for one
instance:

- the 29 write tools are **not registered** — the model cannot even see them
  (sending, drafts, moves, deletions, flags, labels, folders, templates,
  scheduling, rules, automatic reply, `configure_alerts`);
- the scheduled queue is not processed (the server logs `Scheduler disabled`);
- tools that write only locally remain: the `save_*` / `export_*` tools (files),
  `add_to_calendar` and `create_reminder` (local calendar), `test_notification`.

Read-only mode does **not** cover the watcher's hooks: static rules and AI
triage still apply their labels, flags and read marks when the watcher is
enabled. Leave `settings.watcher.enabled = false` on an instance that must not
touch the mailbox. `email-mcp scheduler check` also sends regardless of the
setting.

### Other safeguards

- **Secrets** — `*_command` fields keep credentials in a password manager; OAuth2
  refresh tokens are scoped and revocable. Passwords are never logged.
- **Confirmation** — every tool carries MCP annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) that clients use to ask
  before acting; `delete_email` goes to Trash unless `permanent: true`; calendar
  and reminder writes on macOS show a native confirmation dialog.
- **Rate limit** — `rate_limit` messages per minute and per account on SMTP sends.
- **Disk writes** — the [allow-list](#where-files-may-be-written) above.
- **Audit log** — write operations are appended to
  `~/.local/share/email-mcp/audit.log`, sensitive fields redacted.
- **TLS** — implicit TLS or STARTTLS, certificate verification on by default.

What ends up on disk (`.eml`, attachments, exports) is as sensitive as the
mailbox itself; see [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| A documented tool is missing, or a fix seems absent | The client runs an old build. Run `pnpm build` (the git hooks do it after a pull), **restart the client**, and check `server_build` in `check_health`. |
| A tool is missing entirely | The instance is read-only (write tools are not registered). |
| Startup error naming `MCP_EMAIL_ACCOUNTS` | An account name in the client entry does not exist in `config.toml`. |
| Startup error `… timed out after 30s` / `… printed nothing` | A `*_command` prompts for input or fails; run it in a terminal. |
| Search returns fewer messages than expected | Server token matching on `from` / `to` / `subject`: use `*_contains`. Or a partial scan: read `coverage` and continue with `before`. |
| The call is abandoned after about a minute | MCP clients stop waiting around 60 s. Add a date filter (`since: "90d"`) or narrow the folder; client-side scans already stop at 45 s and report how to continue. |
| Empty bodies, or `the server returned no data for MIME part N` | An antivirus inspecting unencrypted IMAP can strip message parts (observed with ESET). Use TLS (`tls = true`, port 993) or exclude the mail server from the antivirus' email scanning. |
| Folders missing on Exchange / Outlook.com | Their IMAP endpoint hides custom folders: use `backend = "graph"`. |
| `… is not supported yet on Graph-backed account` | The tool is IMAP-only ([table](#imap-and-exchange-at-a-glance)). |
| Sent copy in the wrong folder (cPanel, Mac Mail) | Set `sent_folder` — [docs/troubleshooting-sent-folder.md](docs/troubleshooting-sent-folder.md). |
| Leftover `email-mcp` processes holding IMAP connections | [docs/troubleshooting-orphan-processes.md](docs/troubleshooting-orphan-processes.md) and `bin/email-mcp-wrapper.sh` (POSIX). |
| Desktop notifications do not show | `check_notification_setup` / `email-mcp notify status`. |
| Scheduled emails do not leave | No server running and no `scheduler install`; or the instance is read-only; `scheduler list` shows the state and last error. |

## Architecture

```
src/
├── main.ts            entry point and CLI commands
├── server.ts          MCP server factory
├── cli/               account, setup, test, install, config, scheduler, notify
├── config/            TOML + environment loading, Zod schema, secret commands, XDG paths
├── connections/       lazy, persistent IMAP / SMTP connections (OAuth2 aware)
├── services/          business logic
│   ├── imap.service.ts, smtp.service.ts      IMAP / SMTP backends
│   ├── graph/                                Microsoft Graph backend and sending
│   ├── mail-router.ts, mail-backends.ts      per-account routing IMAP ↔ Graph
│   ├── search-*.ts                           search criteria, coverage, presets
│   ├── watcher, hooks, notifier, presets     IDLE watcher, triage, alerts
│   └── scheduler, calendar, reminders, templates, signature-loader, …
├── routing/           cross-account move and its Postgres log
├── tools/ prompts/ resources/   MCP surface (64 tools, 7 prompts, 6 resources)
├── safety/            validation, rate limiter, audit log
└── utils/             dates, headers, body formatting, build info
```

Tools call one mail contract (`IMailService`, `ISendService`); a router sends each
call to IMAP/SMTP or to Graph according to the account's `backend`. A Graph
account never falls back to IMAP, and an operation Graph does not implement fails
explicitly rather than returning a partial answer.

## Development and contributing

```bash
pnpm install
pnpm dev              # watch mode (tsx)
pnpm typecheck
pnpm check            # Biome + ESLint
pnpm test             # unit tests (Vitest)
pnpm test:integration # integration tests — needs Docker (GreenMail via Testcontainers)
pnpm build
```

Git hooks (lefthook) run automatically and must not be bypassed (no
`--no-verify`): **pre-commit** Biome, ESLint, type check and `actionlint`;
**commit-msg** Conventional Commits; **pre-push** tests, `pnpm check` and the
build; **post-merge / post-checkout / post-rewrite** rebuild `dist/`.

Every change must keep **both backends** working. A new tool needs its method on
`ImapService` and `GraphService` (or accepts the explicit "not supported yet"
error on Graph), registration in `src/tools/register.ts` — inside the
`if (!readOnly)` block when it writes — and a line in the tools tables of
**both** `README.md` and `README.fr.md`. See [CONTRIBUTING.md](CONTRIBUTING.md).

Issues and security reports: see [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## Maintainer

[@PedroSkyNetFr](https://github.com/PedroSkyNetFr) maintains this fork.

## History and credits

- **Colin ([@codefuturist](https://github.com/codefuturist))** created
  [email-mcp](https://github.com/codefuturist/email-mcp) in February 2026: the
  IMAP/SMTP server and its multi-account design, the setup wizard, client
  installer and CLI, provider-aware labels, the IMAP IDLE watcher with AI triage,
  presets, static rules and alerts, calendar and reminders integration,
  templates, scheduling, analytics, prompts and resources, the integration test
  suite and the npm / Docker release pipeline.
- **David Young ([@wgs4](https://github.com/wgs4))** extended it in
  [his fork](https://github.com/wgs4/email-mcp) (March–June 2026, releases 0.3.0
  and 0.4.0): Sent-folder copies after SMTP sends, server-side filter parity and
  the Gmail fast path, attachment filters and facets, cross-account search, saved
  searches and SPECIAL-USE mailbox aliasing, `export_search` and the
  save-to-disk tools, bounded deep search with explicit search failures,
  MIME-aware body extraction, attachments on `send_email`, drafts and
  `update_draft`, `includeAttachments` on replies, and `cross_account_move` with
  its Postgres log.
- **This fork ([@PedroSkyNetFr](https://github.com/PedroSkyNetFr))**, since June
  2026: the Microsoft Graph backend (reading, writing, sending, search, categories,
  drafts, export), Exchange rules and automatic reply, the OAuth2 setup helper,
  inline `cid` images and Outlook signatures, `.eml` export and full Internet
  headers, the save-directory allow-list, `MCP_EMAIL_ACCOUNTS` and `*_command`
  secrets, search coverage reports with `before` continuation and `*_contains`
  filters, scheduler hardening and the Windows Task Scheduler, read-only fixes,
  build visibility in `check_health`, the imapflow 2 / nodemailer 10 upgrade and
  the git hooks that keep `dist/` current.

## License

[LGPL-3.0-or-later](LICENSE).
