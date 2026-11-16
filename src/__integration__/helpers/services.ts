import ConnectionManager from '@pedroskynet/email-core/connections/manager.js';
import RateLimiter from '@pedroskynet/email-core/safety/rate-limiter.js';
import ImapService from '@pedroskynet/email-core/services/imap.service.js';
import SmtpService from '@pedroskynet/email-core/services/smtp.service.js';
import type { AccountConfig } from '../../types/index.js';

export interface TestServices {
  connections: ConnectionManager;
  imapService: ImapService;
  smtpService: SmtpService;
}

export function createTestServices(...accounts: AccountConfig[]): TestServices {
  const connections = new ConnectionManager(accounts);
  const imapService = new ImapService(connections);
  const rateLimiter = new RateLimiter(100);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  return { connections, imapService, smtpService };
}
