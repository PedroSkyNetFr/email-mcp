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
  /** The request itself is wrong (empty folder name, no recipient): fix it, do not retry. */
  | 'invalid'
  /** Transient (network, throttling): retrying later may work. */
  | 'transient'
  /**
   * A send whose outcome is unknown: the server may have sent it before
   * failing (a 5xx after the request, a cut connection). Check the sent
   * folder before sending again — never retry blindly.
   */
  | 'uncertain';

export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(code: MailErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailError';
    this.code = code;
  }
}
