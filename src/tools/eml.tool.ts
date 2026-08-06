/**
 * Outils MCP : save_email, save_emails_from_search — écriture de messages sur
 * disque au format `.eml` (RFC822 verbatim).
 *
 * `export_search` produit du CSV/NDJSON, c'est-à-dire des MÉTADONNÉES. Le `.eml`
 * répond à un besoin différent : conserver le message lui-même, octet pour
 * octet, tel que le serveur l'a rendu. Ce qui en découle :
 *
 *   - il se rouvre dans n'importe quel client (Thunderbird, Outlook, Apple
 *     Mail, `mutt -f`) avec ses pièces jointes et sa mise en forme ;
 *   - les signatures DKIM et la chaîne `Received` restent vérifiables, donc le
 *     fichier vaut comme pièce dans un litige ou un signalement ;
 *   - il survit à la suppression du message côté serveur.
 *
 * Comme les autres écritures directes, la destination est bornée par
 * `assertSafeDestination` (home, tmp, plus `MAIL_ALLOWED_SAVE_DIRS`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type { IMailService } from '../services/mail-service.types.js';
import {
  FROM_DESCRIPTION,
  literalFilterOptions,
  literalFilterParams,
  SUBJECT_DESCRIPTION,
  TO_DESCRIPTION,
} from './search-filter-params.js';

export default function registerEmlTools(
  server: McpServer,
  imapService: IMailService,
  connections: ConnectionManager,
): void {
  // ---------------------------------------------------------------------------
  // save_email — un message
  // ---------------------------------------------------------------------------
  server.tool(
    'save_email',
    'Save one email to disk as a .eml file — the exact RFC822 source, so attachments, formatting, ' +
      'DKIM signatures and the full Received chain are preserved and the file reopens in any mail ' +
      'client. Use this to archive a message, keep evidence, or hand a message to another tool. ' +
      '(export_search writes metadata as CSV/NDJSON; this writes the message itself.) ' +
      'Default destination is ~/Downloads/<date>_<subject>_<id>.eml.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      destination: z
        .string()
        .optional()
        .describe(
          'Absolute file path OR absolute directory. If a directory, the filename is derived ' +
            'from the message date, subject and id. Default: ~/Downloads/',
        ),
      overwrite: z
        .boolean()
        .default(false)
        .describe('Allow overwriting an existing file; otherwise auto-suffix (name-1.eml)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox, destination, overwrite }) => {
      try {
        const target = destination ?? join(homedir(), 'Downloads');
        const result = await imapService.saveEmailToDisk(
          account,
          emailId,
          mailbox,
          target,
          overwrite,
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  path: result.path,
                  file_url: result.fileUrl,
                  size: result.size,
                  sizeHuman: `${Math.round(result.size / 1024)}KB`,
                  subject: result.subject,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to save email: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // save_emails_from_search — balayage d'une recherche
  // ---------------------------------------------------------------------------
  server.tool(
    'save_emails_from_search',
    'Run any search and save every matching message as a .eml file into a dated folder under ' +
      '~/Downloads/ (or a caller-supplied folder). Use for mailbox archival, year-end exports, ' +
      'or handing a whole thread/sender history to another tool. Per-message failures are ' +
      'collected and reported, they do not abort the batch. The response reports `matched` (what ' +
      'the SEARCH returned) next to `files_saved` (what was written): when the two differ, or ' +
      'when matched is lower than you expected, the query is the suspect — see the caveat on the ' +
      'from/to/subject filters.',
    {
      account: z.string().optional().describe('Single-account mode'),
      accounts: z
        .array(z.string())
        .optional()
        .describe('Cross-account fan-out; defaults to every configured account'),
      mailbox: z.string().default('INBOX'),
      query: z.string().optional().default(''),
      to: z.string().optional().describe(TO_DESCRIPTION),
      from: z.string().optional().describe(FROM_DESCRIPTION),
      subject: z.string().optional().describe(SUBJECT_DESCRIPTION),
      ...literalFilterParams,
      cc: z.string().optional(),
      bcc: z.string().optional(),
      text: z.string().optional(),
      body: z.string().optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      on: z.string().optional(),
      sent_since: z.string().optional(),
      sent_before: z.string().optional(),
      seen: z.boolean().optional(),
      flagged: z.boolean().optional(),
      has_attachment: z.boolean().optional(),
      larger_than: z.number().optional(),
      smaller_than: z.number().optional(),
      answered: z.boolean().optional(),
      draft: z.boolean().optional(),
      deleted: z.boolean().optional(),
      keyword: z.union([z.string(), z.array(z.string())]).optional(),
      not_keyword: z.union([z.string(), z.array(z.string())]).optional(),
      header: z.record(z.string(), z.string()).optional(),
      attachment_filename: z.string().optional(),
      attachment_mimetype: z.string().optional(),
      gmail_raw: z.string().optional(),
      max_emails: z.number().int().min(1).max(10000).default(500),
      destination: z
        .string()
        .optional()
        .describe('Destination folder. Default: ~/Downloads/email-messages-<ts>/'),
      organize_by: z
        .enum(['flat', 'date', 'sender', 'account'])
        .default('flat')
        .describe('Subfolder structure under destination'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const tsSlug = new Date().toISOString().replace(/[:.]/g, '-');
        const folder =
          params.destination ?? join(homedir(), 'Downloads', `email-messages-${tsSlug}`);

        // Résolution du mode compte — identique à export_search et
        // save_all_attachments_from_search.
        let accountNames: string[] | null = null;
        let accountName: string | null = null;
        if (params.account) {
          accountName = params.account;
        } else if (params.accounts && params.accounts.length > 0) {
          accountNames = params.accounts;
        } else {
          accountNames = connections.getAccountNames();
        }

        const result = await imapService.saveEmailsFromSearch({
          accountNames,
          accountName,
          query: params.query ?? '',
          searchOptions: {
            mailbox: params.mailbox,
            to: params.to,
            from: params.from,
            subject: params.subject,
            cc: params.cc,
            bcc: params.bcc,
            text: params.text,
            body: params.body,
            since: params.since,
            before: params.before,
            on: params.on,
            sentSince: params.sent_since,
            sentBefore: params.sent_before,
            seen: params.seen,
            flagged: params.flagged,
            hasAttachment: params.has_attachment,
            largerThan: params.larger_than,
            smallerThan: params.smaller_than,
            answered: params.answered,
            draft: params.draft,
            deleted: params.deleted,
            keyword: params.keyword,
            notKeyword: params.not_keyword,
            header: params.header,
            attachmentFilename: params.attachment_filename,
            attachmentMimetype: params.attachment_mimetype,
            gmailRaw: params.gmail_raw,
            ...literalFilterOptions(params),
          },
          maxEmails: params.max_emails,
          destinationFolder: folder,
          organizeBy: params.organize_by,
        });

        // `matched` en tête, et un avertissement explicite dès que le lot n'est
        // pas ce que l'appelant attendait : un export incomplet renvoyait
        // jusqu'ici `files_saved: 1, errors: []`, indiscernable d'un dossier
        // vide. Le silence est le pire mode de défaillance pour un outil
        // d'archivage.
        const notes: string[] = [];
        if (result.matched === 0) {
          notes.push(
            'The SEARCH returned no message, so nothing was written. If you expected matches, ' +
              'the filter is the suspect, not the export: from/to/subject are matched by the ' +
              'server on indexed tokens, so a parent domain misses its subdomains. Retry with ' +
              'from_contains for a literal match.',
          );
        }
        if (result.truncated) {
          notes.push(
            `The search hit max_emails (${params.max_emails}); this is a prefix of the matching ` +
              'set, not the whole of it. Raise max_emails or narrow the query.',
          );
        }
        if (result.errors.length > 0) {
          notes.push(
            `${result.errors.length} message(s) matched but could not be written — see errors.`,
          );
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  folder: result.folder,
                  matched: result.matched,
                  files_saved: result.files_saved,
                  truncated: result.truncated,
                  total_size: result.total_size,
                  total_size_human: `${Math.round(result.total_size / 1024 / 1024)}MB`,
                  // Les erreurs sont plafonnées pour ne pas noyer la réponse ;
                  // le compte total reste exact.
                  error_count: result.errors.length,
                  errors: result.errors.slice(0, 20),
                  ...(notes.length > 0 ? { notes } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to save emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
