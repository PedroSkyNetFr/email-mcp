/**
 * Provider-agnostic mail service contract.
 *
 * The MCP tool layer used to depend on the concrete {@link ImapService} class,
 * which tied every tool to IMAP semantics. Exchange Online and Outlook.com only
 * expose a legacy subset of a mailbox over IMAP — custom folders can be missing
 * from LIST entirely — so those accounts need Microsoft Graph instead.
 *
 * `IMailService` is the seam that makes a second backend possible: tools depend
 * on this contract, and an account is served either by `ImapService` or by a
 * Graph-backed implementation, chosen per account.
 *
 * The contract is derived from the class rather than hand-written:
 *
 *   Pick<ImapService, keyof ImapService>
 *
 * `keyof` on a class type yields its PUBLIC members only, so the interface stays
 * automatically in sync with `ImapService` — adding a public method there makes
 * it part of the contract, and any alternative backend has to provide it too.
 * Private helpers are excluded, which is what makes the type structural (a class
 * with private fields is otherwise not assignable to another).
 */

import type ImapService from './imap.service.js';

export type IMailService = Pick<ImapService, keyof ImapService>;
