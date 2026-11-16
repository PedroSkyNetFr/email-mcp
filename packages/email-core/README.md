# @pedroskynet/email-core

The mail engines behind [email-mcp](../../README.md), as a library: read,
search, organise and send mail through one contract, whatever serves the
account.

| Account hosted at | Engine |
|---|---|
| Any IMAP server (OVH, Ionos, Gandi, Infomaniak, Dovecot, Zimbra, …) | IMAP + SMTP, password |
| Google Workspace / Gmail | IMAP + SMTP with OAuth2 (XOAUTH2), Gmail labels |
| Microsoft 365 / Exchange Online / Outlook.com | Microsoft Graph, OAuth2 |
| Proton (through Proton Bridge) | IMAP + SMTP, ProtonMail labels |

The engine is chosen per account (`backend = "imap"` or `"graph"` in
`AccountConfig`); callers only see `IMailService` and `ISendService`.

> **Status: 0.1.0, not published.** Two contracts live side by side:
>
> - `MailEngine` (`src/contract/`), provider-neutral, for new hosts: one
>   engine per account, opaque ids, folder roles, UID- or date-anchored pages,
>   `listChanges` for synchronisation, `waitForChange` for real time.
>   Implemented for IMAP + SMTP (`src/engines/imap/`) and Microsoft Graph
>   (`src/engines/graph/`).
> - `IMailService` / `ISendService`, derived from the IMAP classes, used by the
>   email-mcp server; unchanged.
>
> Expect breaking changes between minor versions.

## Installation

Not on npm yet: install it from Git, pinned to a commit, with pnpm (tested
with pnpm 10.22):

```bash
pnpm add "github:PedroSkyNetFr/email-mcp#<commit>&path:/packages/email-core"
```

The compiled code is not committed, so pnpm builds the package on install
(`prepare` script). To do so it first installs the development dependencies
of the whole email-mcp workspace: the first install takes a while; the
application itself keeps only the package and its four runtime dependencies.

## Usage

```ts
import { createMailBackends } from '@pedroskynet/email-core';

const backends = createMailBackends({
  accounts: [myAccount], // AccountConfig[]: backend "imap" (default) or "graph"
  settings: { rateLimit: 10 }, // outgoing messages per minute and account
});
const engine = backends.engine('work'); // IMAP + SMTP or Graph, same contract

const folders = await engine.listFolders(); // each with its role: inbox, sent…
const inbox = folders.find((f) => f.role === 'inbox')!;
const page = await engine.listMessages(inbox.id, { pageSize: 50 });
const more = await engine.listMessages(inbox.id, { page: page.next });

// Synchronisation: store each batch, then its cursor.
let cursor = null; // or the cursor stored last time
for (;;) {
  const batch = await engine.listChanges(inbox.id, cursor);
  // batch.added (raw source included), batch.flagsChanged, batch.removed,
  // batch.reset (resynchronise from null)
  cursor = batch.nextCursor;
  if (batch.complete) break;
}

// Replying: the composer is pre-filled, the user edits, send() sends that.
const reply = await engine.prepareReply(page.items[0].id, { all: true });
await engine.send({ ...reply, text: `OK.
${reply.text}` });

await backends.close();
```

### Bringing your own connections

`createMailBackends` uses the default `ConnectionManager`, which builds IMAP and
SMTP connections from the credentials in each `AccountConfig`. An application
with its own credentials store, host checks or TLS policy implements
`IConnectionManager` (`getAccount`, `getImapClient`, `getSmtpTransport`, …) and
builds the engine with `createImapEngine(account, connections, imap, smtp)`.

### Entry points

- `@pedroskynet/email-core` — the public API: contract, wiring, engines,
  connections, OAuth2, provider presets and the mail domain types.
- `@pedroskynet/email-core/<module>.js` — every internal module, used by the
  email-mcp server. Internal: they may move without notice.

## Development

From the repository root:

```bash
pnpm --filter @pedroskynet/email-core test       # unit tests of the package alone
pnpm --filter @pedroskynet/email-core typecheck
pnpm --filter @pedroskynet/email-core build      # dist/
```

`pnpm test` at the root runs these tests together with the server's.

The engine integration tests run against a real Dovecot 2.4.5 in a container
(Docker required) — GreenMail, used by the server's integration tests,
announces none of the synchronisation extensions (CONDSTORE, QRESYNC):

```bash
pnpm --filter @pedroskynet/email-core test:integration
```

`pnpm test:integration` at the root runs them after the server's.

## License and credits

LGPL-3.0-or-later — see [LICENSE](LICENSE). You may use this package from
software under any license; changes to the package itself must be published
under the LGPL.

Written by [codefuturist](https://github.com/codefuturist) as part of
[email-mcp](https://github.com/codefuturist/email-mcp), with contributions from
[David Young](https://github.com/wgs4); extracted into a package and maintained
by [PedroSkyNetFr](https://github.com/PedroSkyNetFr) in
[the fork](https://github.com/PedroSkyNetFr/email-mcp).
