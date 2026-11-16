/**
 * Provider-agnostic send contract.
 *
 * Mirrors {@link IMailService} for the outbound path. Accounts served by
 * Microsoft Graph cannot use SMTP: Microsoft will not redeem their
 * Graph-consented refresh token for the outlook.office.com scopes SMTP XOAUTH2
 * needs, so an account holds one credential or the other.
 *
 * Derived from the class with `Pick<..., keyof ...>` for the same reason as the
 * mail contract: `keyof` keeps public members only, which is what makes the type
 * structural and therefore satisfiable by a second implementation.
 */

import type SmtpService from './smtp.service.js';

export type ISendService = Pick<SmtpService, keyof SmtpService>;
