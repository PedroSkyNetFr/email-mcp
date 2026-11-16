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

> **Status: 0.1.0, not published.** The package was extracted from the email-mcp
> server without changing its behaviour. Its contract is still *derived* from
> the IMAP class (`Pick<ImapService, keyof ImapService>`), so a new engine has
> to mimic IMAP; an explicit, provider-neutral contract is being designed.
> Until then, expect breaking changes between minor versions.

## Usage

```ts
import { createMailBackends } from '@pedroskynet/email-core';

const { mailService, sendService, connections } = createMailBackends({
  accounts: [myAccount], // AccountConfig[]
  settings: { rateLimit: 10 }, // outgoing messages per minute and account
});

const page = await mailService.listEmails('work', { mailbox: 'INBOX', pageSize: 20 });
await sendService.sendEmail('work', { to: ['someone@example.org'], subject: 'Hi', body: 'Hello' });

await connections.closeAll();
```

### Bringing your own connections

`createMailBackends` uses the default `ConnectionManager`, which builds IMAP and
SMTP connections from the credentials in each `AccountConfig`. An application
with its own credentials store, host checks or TLS policy implements
`IConnectionManager` (`getAccount`, `getImapClient`, `getSmtpTransport`, …) and
passes it to `ImapService` and `SmtpService` directly.

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

## License and credits

LGPL-3.0-or-later — see [LICENSE](LICENSE). You may use this package from
software under any license; changes to the package itself must be published
under the LGPL.

Written by [codefuturist](https://github.com/codefuturist) as part of
[email-mcp](https://github.com/codefuturist/email-mcp), with contributions from
[David Young](https://github.com/wgs4); extracted into a package and maintained
by [PedroSkyNetFr](https://github.com/PedroSkyNetFr) in
[the fork](https://github.com/PedroSkyNetFr/email-mcp).
