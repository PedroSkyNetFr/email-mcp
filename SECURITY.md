# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x.x   | ✅ Latest  |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via [GitHub Security Advisories](https://github.com/codefuturist/email-mcp/security/advisories/new).

You should receive a response within 48 hours. If the issue is confirmed, a fix will be released as soon as possible.

## Security Considerations

email-mcp handles sensitive email credentials and message content. The project includes several security measures:

- **No credential storage** — passwords and tokens are read from your local config file or environment variables at runtime
- **Audit logging** — all write operations are logged with automatic redaction of sensitive fields (passwords, email body content)
- **Rate limiting** — configurable rate limits on send operations (default: 10/minute)
- **Read-only mode** — can be configured to disable all write operations
- **Input validation** — all tool inputs are validated with Zod schemas
- **Bounded disk writes** — the tools that write to disk (`save_attachment`, `save_all_attachments_from_search`, `save_email`, `save_emails_from_search`, `export_search`) refuse any destination outside an allow-list of root directories (home + OS temp by default). Literal `..` segments are rejected, filenames derived from message content are sanitised to a single path segment, and the containment check is OS-aware. This matters because the server is driven by an LLM reading untrusted email content — a prompt-injection payload must not be able to steer a write into `~/.ssh` or a startup folder. See `MAIL_ALLOWED_SAVE_DIRS` in the README to widen it, `MAIL_ALLOW_ANY_SAVE_DIR` to opt out deliberately.

## What Lands on Disk

Three features write mailbox data outside the mail server, in clear text:

- **`.eml` export** (`save_email`, `save_emails_from_search`) writes the complete RFC822 source — headers, body and attachments — to the destination folder. These files carry the same sensitivity as the mailbox itself and are not encrypted at rest by this project. Prefer a destination covered by your OS disk encryption, and clean up bulk exports when you are done with them.
- **Attachment save** (`save_attachment`, `save_all_attachments_from_search`) writes attachment payloads unchanged; the file is whatever the sender sent, so treat unsolicited attachments accordingly (this project does not scan them).
- **Search export** (`export_search`) writes metadata — subjects, addresses, labels and, if you ask for the `preview` column, the first characters of each body. Less than a full message, still enough to be worth protecting.

`get_email_headers` only reads. Note that the headers it returns include routing metadata (relay hostnames and IPs, envelope recipients in `Received: … for <…>`), so the same care applies when pasting a header dump into a ticket or a public issue.

## Best Practices for Users

- Use app-specific passwords instead of your main account password
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/email-mcp/audit.jsonl`
- Use `read_only: true` in config if you only need read access
- Keep the save allow-list as narrow as your workflow allows; add specific folders with `MAIL_ALLOWED_SAVE_DIRS` rather than setting `MAIL_ALLOW_ANY_SAVE_DIR=true`
- Treat exported `.eml` files as mailbox copies — same storage and disposal rules
- Keep email-mcp updated to the latest version

## Judging a Suspicious Message

`get_email_headers` reports the SPF/DKIM/DMARC verdicts found in the message and
how the authenticated domains align with the visible `From:`. Two caveats before
acting on it:

- The verdicts are **claims made by relays**, not checks re-run locally. Only the
  topmost `Authentication-Results` (added by your own receiving server) is
  trustworthy; anything below it could have been written by the sender. The tool
  applies that rule and reports the topmost verdict, but a message with *no*
  `Authentication-Results` at all proves nothing either way, and is reported as
  such rather than as a pass.
- Header analysis narrows suspicion; it does not establish safety. A perfectly
  aligned, DKIM-signed message from a compromised account still passes.
