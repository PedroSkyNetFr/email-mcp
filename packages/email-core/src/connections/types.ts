import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { AccountConfig } from '../types/index.js';

export interface EphemeralImapOptions {
  /**
   * Enable QRESYNC (RFC 7162) on this connection when the server offers it,
   * so a CHANGEDSINCE fetch also reports the expunged UIDs. Used by the sync
   * engine on its own connection only: it changes how the server announces
   * every expunge of the session. An implementation may ignore it; the engine
   * then reports removals as not tracked (fidelity "none").
   */
  qresync?: boolean;
}

export interface IConnectionManager {
  getAccount: (name: string) => AccountConfig;
  getAccountNames: () => string[];
  getImapClient: (accountName: string) => Promise<ImapFlow>;
  /** D3/R3: a throwaway, UNCACHED IMAP connection for a bounded deep search. */
  createEphemeralImapClient: (
    accountName: string,
    options?: EphemeralImapOptions,
  ) => Promise<ImapFlow>;
  getSmtpTransport: (accountName: string, options?: { verify?: boolean }) => Promise<Transporter>;
  closeAll: () => Promise<void>;
}
