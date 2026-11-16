/**
 * Errors of the mail engine contract. Every engine throws these, so a host
 * reacts to the situation (re-find a message, ask for a new password) without
 * knowing which provider is behind the account.
 */

export type MailErrorCode =
  /** The message or folder no longer exists. */
  | 'not-found'
  /** The id was made void by a renumbering (IMAP UIDVALIDITY): resynchronise. */
  | 'stale-id'
  /** This server cannot do it; `EngineCapabilities` says so up front. */
  | 'unsupported'
  /** Credentials refused or expired: the user has to act. */
  | 'auth'
  /** Message larger than the server accepts. */
  | 'too-large'
  /** Mailbox full. */
  | 'quota'
  /** Transient (network, throttling): retrying later may work. */
  | 'transient';

export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(code: MailErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailError';
    this.code = code;
  }
}
