/**
 * Per-account backend router.
 *
 * Presents the {@link IMailService} surface to the tool layer and dispatches
 * each call to the backend that serves the account named in its first argument:
 * {@link ImapService} by default, the Graph service for accounts declared with
 * `backend = "graph"`.
 *
 * Implemented as a Proxy rather than ~40 hand-written delegations. That keeps
 * the router automatically complete as `ImapService` grows — a method it does
 * not know about still reaches IMAP — while Graph accounts pick up each new
 * Graph implementation as soon as it exists.
 *
 * A Graph account never falls back to IMAP: their IMAP endpoint hides folders,
 * so answering from it would return quietly wrong results. Anything the Graph
 * backend cannot do yet raises an explicit error instead.
 */

import type { AccountConfig } from '../types/index.js';
import type GraphSendService from './graph/graph-send.service.js';
import type GraphService from './graph/graph.service.js';
import type ImapService from './imap.service.js';
import type { IMailService } from './mail-service.types.js';
import type { ISendService } from './send-service.types.js';
import type SmtpService from './smtp.service.js';

/** Both contracts take the account name as their first argument. */
function accountOf(args: unknown[]): string | undefined {
  return typeof args[0] === 'string' ? args[0] : undefined;
}

/**
 * Build a proxy over `defaultImpl` that hands calls for Graph-backed accounts to
 * `graphImpl` instead. Shared by the mail and send contracts, which differ only
 * in the pair of services involved.
 */
function routeByAccount<T extends object>(
  defaultImpl: T,
  graphImpl: object,
  isGraphAccount: (name: string | undefined) => boolean,
): T {
  return new Proxy(defaultImpl, {
    get(target, property, receiver) {
      const fallback = Reflect.get(target, property, receiver) as unknown;
      if (typeof fallback !== 'function') return fallback;

      const graphMember = (graphImpl as Record<string | symbol, unknown>)[property];

      return (...args: unknown[]) => {
        const account = accountOf(args);
        if (!isGraphAccount(account)) {
          return (fallback as (...a: unknown[]) => unknown).apply(target, args);
        }

        if (typeof graphMember !== 'function') {
          throw new Error(
            `"${String(property)}" is not supported yet on Graph-backed account "${account}". ` +
              'Its mailbox is served by Microsoft Graph because Exchange hides folders over IMAP; ' +
              'this operation still needs a Graph implementation.',
          );
        }
        return (graphMember as (...a: unknown[]) => unknown).apply(graphImpl, args);
      };
    },
  });
}

export function createMailRouter(
  imapService: ImapService,
  graphService: GraphService,
  getAccount: (name: string) => AccountConfig | undefined,
): IMailService {
  const isGraphAccount = (name: string | undefined): boolean =>
    !!name && getAccount(name)?.backend === 'graph';
  return routeByAccount(imapService, graphService, isGraphAccount) as unknown as IMailService;
}

/**
 * Same dispatch for the send path. A Graph account cannot fall back to SMTP:
 * its credentials are consented for Graph, and Microsoft will not redeem them
 * for the scopes SMTP authentication requires.
 */
export function createSendRouter(
  smtpService: SmtpService,
  graphSendService: GraphSendService,
  getAccount: (name: string) => AccountConfig | undefined,
): ISendService {
  const isGraphAccount = (name: string | undefined): boolean =>
    !!name && getAccount(name)?.backend === 'graph';
  return routeByAccount(smtpService, graphSendService, isGraphAccount) as unknown as ISendService;
}
