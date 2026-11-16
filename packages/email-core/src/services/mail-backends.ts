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
import type { MailEngine } from '../contract/engine.types.js';
import createGraphEngine from '../engines/graph/graph-engine.js';
import createImapEngine from '../engines/imap/imap-engine.js';
import RateLimiter from '../safety/rate-limiter.js';
import type { AccountConfig } from '../types/index.js';
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
  /**
   * Service de jetons OAuth2 partagé : la veille IDLE doit s'en servir aussi,
   * pour qu'un seul rafraîchissement serve toutes les connexions d'un compte.
   */
  oauthService: OAuthService;
  /**
   * The provider-neutral engine of an account (MailEngine contract): IMAP +
   * SMTP or Microsoft Graph, as the account's `backend` says. One instance per
   * account, created on first use. The host only ever talks to this.
   */
  engine: (accountName: string) => MailEngine;
  /** Closes the engines' own connections (sync, watch), then every connection. */
  close: () => Promise<void>;
}

/**
 * What the engines need from an application configuration. Kept structural so
 * that a host application passes its own config object as is (the MCP server
 * passes its AppConfig) without this package knowing the rest of it.
 */
export interface MailBackendsConfig {
  accounts: AccountConfig[];
  settings: {
    /** Outgoing messages allowed per minute and per account (see RateLimiter). */
    rateLimit: number;
  };
}

export default function createMailBackends(config: MailBackendsConfig): MailBackends {
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

  const engines = new Map<string, MailEngine>();
  const engine = (accountName: string): MailEngine => {
    const existing = engines.get(accountName);
    if (existing) return existing;
    const account = requireAccount(accountName);
    const client = graphClients.get(accountName);
    const created =
      account.backend === 'graph' && client
        ? createGraphEngine(accountName, client, graphService, graphSendService, () =>
            requireAccount(accountName),
          )
        : createImapEngine(accountName, connections, imapService, smtpService);
    engines.set(accountName, created);
    return created;
  };
  const close = async (): Promise<void> => {
    await Promise.all([...engines.values()].map(async (e) => e.close()));
    engines.clear();
    await connections.closeAll();
  };

  return {
    connections,
    imapService,
    graphService,
    mailService,
    sendService,
    oauthService,
    engine,
    close,
  };
}
