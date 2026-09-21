/**
 * Mail backends — the per-account wiring shared by the server and the CLI.
 *
 * Accounts declared with backend = "graph" are served by Microsoft Graph
 * instead of IMAP and SMTP; the routers dispatch per account so callers see a
 * single IMailService and ISendService either way.
 *
 * Built in one place so that `email-mcp scheduler check` sends exactly as the
 * server does. Its former copy of this wiring had neither the OAuth service
 * nor the Graph route, so OAuth2 and Graph accounts could not send from it.
 */

import ConnectionManager from '../connections/manager.js';
import RateLimiter from '../safety/rate-limiter.js';
import type { AccountConfig, AppConfig } from '../types/index.js';
import GraphClient from './graph/graph.client.js';
import GraphService from './graph/graph.service.js';
import GraphSendService from './graph/graph-send.service.js';
import ImapService from './imap.service.js';
import { createMailRouter, createSendRouter } from './mail-router.js';
import type { IMailService } from './mail-service.types.js';
import OAuthService from './oauth.service.js';
import type { ISendService } from './send-service.types.js';
import SmtpService from './smtp.service.js';

export interface MailBackends {
  connections: ConnectionManager;
  /** IMAP only — for the features that exist on IMAP alone */
  imapService: ImapService;
  graphService: GraphService;
  /** Reading and mailbox changes, routed to IMAP or Graph per account */
  mailService: IMailService;
  /** Sending, routed to SMTP or Graph per account */
  sendService: ISendService;
}

export default function createMailBackends(config: AppConfig): MailBackends {
  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);

  const graphClients = new Map(
    config.accounts
      .filter((account) => account.backend === 'graph')
      .map((account) => [account.name, new GraphClient(account, oauthService)]),
  );
  const findAccount = (name: string): AccountConfig | undefined =>
    config.accounts.find((account) => account.name === name);
  const requireAccount = (name: string): AccountConfig => {
    const account = findAccount(name);
    if (!account) throw new Error(`Unknown account "${name}"`);
    return account;
  };

  const graphService = new GraphService(graphClients, requireAccount);
  const mailService = createMailRouter(imapService, graphService, findAccount);

  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  const graphSendService = new GraphSendService(graphClients, requireAccount);
  const sendService = createSendRouter(smtpService, graphSendService, findAccount);

  return { connections, imapService, graphService, mailService, sendService };
}
