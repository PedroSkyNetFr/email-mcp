/**
 * @pedroskynet/email-core — the mail engines behind email-mcp.
 *
 * This entry point is the public face of the package:
 * - the provider-neutral engine contract (MailEngine, MailError), which new
 *   hosts should target: `createMailBackends(config).engine(account)` picks
 *   IMAP + SMTP or Microsoft Graph per account; `createImapEngine` builds one
 *   over a host's own IConnectionManager (its credentials, host checks, TLS);
 * - the contract a host application talks to: IMailService, ISendService and
 *   the mail domain types;
 * - the per-account wiring that picks an engine: createMailBackends and the
 *   mail / send routers;
 * - the engines: IMAP + SMTP (ImapService, SmtpService, label strategies) and
 *   Microsoft Graph (GraphClient, GraphService, GraphSendService);
 * - connections and authentication: IConnectionManager (the seam a host
 *   implements with its own credentials store), ConnectionManager (the default
 *   implementation), OAuthService (XOAUTH2 for Google and Microsoft), provider
 *   presets.
 *
 * Deeper modules stay reachable through subpaths
 * (`@pedroskynet/email-core/services/imap.service.js`, …) for the MCP server,
 * which predates this package; they are internal and may move without notice.
 */

export { default as ConnectionManager } from './connections/manager.js';
export type { IConnectionManager } from './connections/types.js';
export type * from './contract/engine.types.js';
export { MailError, type MailErrorCode } from './contract/errors.js';
export { default as createGraphEngine } from './engines/graph/graph-engine.js';
export { default as createImapEngine } from './engines/imap/imap-engine.js';
export { detectProvider, PROVIDERS } from './providers.js';
export { default as RateLimiter } from './safety/rate-limiter.js';
export { default as GraphClient, GraphError } from './services/graph/graph.client.js';
export { default as GraphService } from './services/graph/graph.service.js';
export { default as GraphSendService } from './services/graph/graph-send.service.js';
export { default as UncertainSendError } from './services/graph/uncertain-send-error.js';
export { default as ImapService, type SearchOptions } from './services/imap.service.js';
export { detectLabelStrategy, type LabelStrategy } from './services/label-strategy.js';
export {
  default as createMailBackends,
  type MailBackends,
  type MailBackendsConfig,
} from './services/mail-backends.js';
export { createMailRouter, createSendRouter } from './services/mail-router.js';
export type { IMailService } from './services/mail-service.types.js';
export { default as OAuthService } from './services/oauth.service.js';
export type { SearchParams } from './services/search-criteria.js';
export { SearchFailedError } from './services/search-status.js';
export type { ISendService } from './services/send-service.types.js';
export { default as SmtpService } from './services/smtp.service.js';
export * from './types/index.js';
export { describeAuthFailure, isAuthFailure } from './utils/auth-error.js';
