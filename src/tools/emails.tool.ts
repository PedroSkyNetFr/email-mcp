/**
 * MCP tools: list_emails, get_email, get_emails, get_email_status,
 * search_emails, search_all_accounts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type { IMailService } from '../services/mail-service.types.js';
import type {
  Email,
  EmailMeta,
  FacetResult,
  PaginatedResult,
  SearchStatus,
} from '../types/index.js';
import {
  applyBodyFormat,
  DEFAULT_MULTI_BODY_MAX,
  DEFAULT_SINGLE_BODY_MAX,
} from '../utils/body-format.js';
import { classifyFromHeaders, formatClassification } from '../utils/mail-classification.js';
import { bodyFormatParam, maxLengthParam, resolveMaxLength } from './body-params.js';
import { numeric } from './numeric-param.js';
import {
  COVERAGE_NOTE,
  FROM_DESCRIPTION,
  literalFilterOptions,
  literalFilterParams,
  SERVER_MATCH_CAVEAT,
  SUBJECT_DESCRIPTION,
  TO_DESCRIPTION,
} from './search-filter-params.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Rendu d'une ligne de liste. `showPreview` : l'aperçu n'est affiché que si
 * l'appelant l'a demandé (`preview: true`) — Graph le fournit d'office, IMAP
 * seulement sur demande ; masquer par défaut garde la même sortie sur les
 * deux backends.
 */
function formatEmailMeta(email: EmailMeta, showPreview = true): string {
  const flags = [
    email.seen ? '' : '🔵',
    email.flagged ? '⭐' : '',
    email.answered ? '↩️' : '',
    email.hasAttachments ? '📎' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const labelStr = email.labels.length > 0 ? `\n  🏷️ ${email.labels.join(', ')}` : '';

  let attachLine = '';
  if (email.attachments && email.attachments.length > 0) {
    const names = email.attachments.map((a) => a.filename);
    const shown = names.slice(0, 3).join(', ');
    const extra = names.length > 3 ? ` (+${names.length - 3} more)` : '';
    attachLine = `\n  📎 Attachments: ${shown}${extra}`;
  }

  const accountTag = email.account ? `[${email.account}] ` : '';
  const classLine = email.classification ? `\n  ${formatClassification(email.classification)}` : '';
  const previewLine = showPreview && email.preview ? `\n  ${email.preview}` : '';
  return `${accountTag}[${email.id}] ${flags} ${email.subject}\n  From: ${from} | ${email.date}${labelStr}${attachLine}${classLine}${previewLine}`;
}

/**
 * Render a facet result block (sender/year/mailbox) — shared between
 * `search_emails`, `search_all_accounts`, and `run_preset`.
 */
export function formatFacetsBlock(facets: FacetResult | undefined): string {
  if (!facets) return '';
  const lines: string[] = ['', '📊 Facets'];
  if (facets.sender) {
    const top = Object.entries(facets.sender)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');
    lines.push(`  By sender: ${top || '(none)'}`);
  }
  if (facets.year) {
    const all = Object.entries(facets.year)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');
    lines.push(`  By year:   ${all || '(none)'}`);
  }
  if (facets.mailbox) {
    const all = Object.entries(facets.mailbox)
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');
    lines.push(`  By mailbox: ${all || '(none)'}`);
  }
  return `\n${lines.join('\n')}`;
}

/**
 * Format a paginated search result (single- or cross-account) for MCP text
 * output. Used by `search_emails`, `search_all_accounts`, and `run_preset`.
 */
/**
 * R4 (Codex-critical): render a failed search as a first-class, unmissable
 * failure — NEVER the plain "No emails found" empty message. Returns null when
 * the search did not fail (caller proceeds with normal rendering). Shared by
 * `formatSearchResult` and the `list_emails` handler so neither presentation
 * path can regress to a silent zero on a failed search (the bug reproduces at
 * the formatter if this branch is missed).
 */
export function formatSearchFailure(result: {
  searchFailed?: true;
  searchStatus?: SearchStatus;
}): string | null {
  if (!result.searchFailed) return null;
  const s = result.searchStatus;
  const lines = [
    '⚠️ SEARCH FAILED — this is NOT a zero-result. The matching messages may still exist.',
    s?.message ?? 'The IMAP SEARCH did not complete.',
  ];
  if (s?.suggestion) lines.push(`Suggestion: ${s.suggestion}`);
  if (s?.windowed?.applied) {
    lines.push(`(A ${s.windowed.sinceDays}-day windowed retry was applied.)`);
  }
  return lines.join('\n');
}

export function formatSearchResult(
  result: PaginatedResult<EmailMeta> & {
    warnings?: { account: string; error: string }[];
  },
  header: string,
  emptyMessage: string,
  showPreview = false,
): string {
  // R4: a failed search must be flagged BEFORE the zero-items path — otherwise
  // it renders as the indistinguishable "No emails found" silent zero.
  const failure = formatSearchFailure(result);
  if (failure) return failure;

  const warningPrefix = result.warning ? `⚠️ ${result.warning}\n` : '';
  // R8: surface the opened folder's size so callers can judge
  // truncation/timeout risk on huge folders (archives, ticketing mailboxes).
  const folderNote =
    result.folderSize !== undefined ? `📂 folder holds ${result.folderSize} messages\n` : '';

  if (result.items.length === 0) {
    return `${warningPrefix}${folderNote}${emptyMessage}`;
  }

  const emails = result.items.map((m) => formatEmailMeta(m, showPreview)).join('\n\n');
  const facetsBlock = formatFacetsBlock(result.facets);

  let accountWarningsBlock = '';
  if (result.warnings && result.warnings.length > 0) {
    // Split warnings into "informational remaps" (ℹ️-prefixed message) vs
    // hard errors/skips. Both live in the same warnings[] array for backward
    // compat; we classify here purely for rendering.
    const infos = result.warnings.filter((w) => w.error.startsWith('ℹ️'));
    const hard = result.warnings.filter((w) => !w.error.startsWith('ℹ️'));
    const blocks: string[] = [];
    if (hard.length > 0) {
      const lines = [`⚠️ Warnings (${hard.length} account${hard.length === 1 ? '' : 's'})`];
      hard.forEach((w) => {
        lines.push(`  - ${w.account}: ${w.error}`);
      });
      blocks.push(lines.join('\n'));
    }
    if (infos.length > 0) {
      const lines = [`ℹ️ Remapped (${infos.length} account${infos.length === 1 ? '' : 's'})`];
      infos.forEach((w) => {
        // Strip the leading emoji + space since the section header already
        // carries one — avoid double-ℹ️ in rendered output.
        const msg = w.error.replace(/^ℹ️\s*/, '');
        lines.push(`  - ${w.account}: ${msg}`);
      });
      blocks.push(lines.join('\n'));
    }
    if (blocks.length > 0) {
      accountWarningsBlock = `\n\n${blocks.join('\n\n')}`;
    }
  }

  return `${warningPrefix}${folderNote}${header}\n${emails}${facetsBlock}${accountWarningsBlock}`;
}

/**
 * Paramètres de `search_emails` qui ne sont PAS des critères : ils disent où
 * chercher et comment présenter, pas quoi chercher.
 */
const NON_CRITERIA_PARAMS = new Set([
  'account',
  'mailbox',
  'page',
  'pageSize',
  'facets',
  'preview',
]);

/**
 * Vrai si l'appel porte au moins un critère de recherche : `query` non vide
 * ou un filtre renseigné (chaîne non vide, booléen, nombre, tableau non vide,
 * objet `header` non vide). Exporté pour les tests.
 */
export function hasSearchCriterion(params: Record<string, unknown>): boolean {
  return Object.entries(params).some(([key, value]) => {
    if (NON_CRITERIA_PARAMS.has(key) || value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
}

/** Renders the current read/flag/label state as a concise status line. */
function formatEmailStatus(email: Pick<Email, 'seen' | 'flagged' | 'answered' | 'labels'>): string {
  const parts: string[] = [email.seen ? '✓ Read' : '🔵 Unread'];
  if (email.flagged) parts.push('⭐ Flagged');
  if (email.answered) parts.push('↩️ Replied');
  const labelStr = email.labels.length > 0 ? ` · 🏷️ ${email.labels.join(', ')}` : '';
  return `${parts.join(' · ')}${labelStr}`;
}

// ---------------------------------------------------------------------------

export default function registerEmailsTools(
  server: McpServer,
  imapService: IMailService,
  connections: ConnectionManager,
): void {
  // ---------------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------------
  server.tool(
    'list_emails',
    'List emails with optional server-side filters. Supports date ranges (since/before/on, ' +
      'including relative tokens like "7d", "yesterday"), subject/from/to/cc/bcc/body/text search, ' +
      'read/flag/answered state, keywords/labels, header matches, and UID ranges. ' +
      'On Gmail accounts, pass gmail_raw for native Gmail search syntax (dramatically faster). ' +
      'Returns paginated metadata (read/unread 🔵, flagged ⭐, replied ↩️, attachments 📎, labels 🏷️). ' +
      'Use get_email to fetch full body content. ' +
      'ProtonMail note: labels are represented as IMAP folders — use list_labels to discover them, ' +
      'then list_emails with mailbox="Labels/X" to find labeled emails. ' +
      `${COVERAGE_NOTE} ` +
      "If a query of INBOX returns nothing relevant, consider re-running against the account's Archive " +
      'mailbox (use list_mailboxes to find its name); always pair archive queries with a date filter, ' +
      'because archives can hold tens of thousands of messages.',
    {
      account: z.string().describe('Account name from list_accounts'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      page: numeric(z.number().int().min(1).default(1)).describe('Page number'),
      pageSize: numeric(z.number().int().min(1).max(100).default(20)).describe('Results per page'),
      since: z
        .string()
        .optional()
        .describe(
          'Date filter: received on/after. Accepts ISO 8601, YYYY-MM-DD, or relative like "7d" / "yesterday"',
        ),
      before: z.string().optional().describe('Date filter: received strictly before'),
      on: z.string().optional().describe('Date filter: received on specific date'),
      sent_since: z
        .string()
        .optional()
        .describe(
          'Date header: sent on/after (differs from since which uses internal delivery date)',
        ),
      sent_before: z.string().optional().describe('Date header: sent before'),
      from: z.string().optional().describe(FROM_DESCRIPTION),
      subject: z.string().optional().describe(SUBJECT_DESCRIPTION),
      to: z.string().optional().describe(TO_DESCRIPTION),
      ...literalFilterParams,
      cc: z.string().optional().describe(`Filter by Cc. ${SERVER_MATCH_CAVEAT}`),
      bcc: z.string().optional().describe(`Filter by Bcc. ${SERVER_MATCH_CAVEAT}`),
      text: z.string().optional().describe('Any text field (headers + body)'),
      body: z.string().optional().describe('Body only'),
      seen: z.boolean().optional().describe('true = read only; false = unread only'),
      flagged: z.boolean().optional().describe('true = flagged; false = unflagged'),
      has_attachment: z
        .boolean()
        .optional()
        .describe('Filter: true=has attachments, false=no attachments'),
      answered: z.boolean().optional().describe('Filter: true=replied, false=not yet replied'),
      draft: z.boolean().optional(),
      deleted: z.boolean().optional(),
      keyword: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('IMAP keyword/label (AND when array)'),
      not_keyword: z.union([z.string(), z.array(z.string())]).optional(),
      header: z
        .record(z.string(), z.string())
        .optional()
        .describe('Arbitrary header name/value match, e.g. {"X-Custom": "value"}'),
      uids: z
        .union([z.array(numeric(z.number())), z.string()])
        .optional()
        .describe('Specific UID ranges (array of numbers or IMAP sequence string like "1:100")'),
      larger_than: numeric(z.number().optional()).describe('Minimum email size in KB'),
      smaller_than: numeric(z.number().optional()).describe('Maximum email size in KB'),
      attachment_filename: z
        .string()
        .optional()
        .describe(
          'Filter by attachment filename substring (case-insensitive). Example: "lease" matches "signed_lease_v7.pdf".',
        ),
      attachment_mimetype: z
        .string()
        .optional()
        .describe(
          'Filter by MIME type regex (case-insensitive). Examples: "application/pdf", "image/.*".',
        ),
      gmail_raw: z
        .string()
        .optional()
        .describe(
          "Gmail accounts ONLY: pass Gmail search syntax (e.g. 'from:foo has:attachment') for dramatically faster server-side search. Other filters ignored when set.",
        ),
      preview: z
        .boolean()
        .default(false)
        .describe(
          'Include a ~200-character body preview per message (default: false). On IMAP this reads the ' +
            'first 1.5 KB of each message text part (one extra FETCH per page); Microsoft Graph ' +
            'serves it at no extra cost.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const result = await imapService.listEmails(params.account, {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          since: params.since,
          before: params.before,
          on: params.on,
          sentSince: params.sent_since,
          sentBefore: params.sent_before,
          from: params.from,
          subject: params.subject,
          to: params.to,
          cc: params.cc,
          bcc: params.bcc,
          text: params.text,
          body: params.body,
          seen: params.seen,
          flagged: params.flagged,
          hasAttachment: params.has_attachment,
          answered: params.answered,
          draft: params.draft,
          deleted: params.deleted,
          keyword: params.keyword,
          notKeyword: params.not_keyword,
          header: params.header,
          uids: params.uids,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          attachmentFilename: params.attachment_filename,
          attachmentMimetype: params.attachment_mimetype,
          gmailRaw: params.gmail_raw,
          preview: params.preview,
          ...literalFilterOptions(params),
        });

        // R4: list_emails has its OWN inline empty path (it does not use
        // formatSearchResult) — flag a failed search here too, BEFORE the
        // zero-items message, or the silent zero reproduces on this surface.
        const failure = formatSearchFailure(result);
        if (failure) {
          return { content: [{ type: 'text' as const, text: failure }] };
        }

        const warningPrefix = result.warning ? `⚠️ ${result.warning}\n` : '';

        if (result.items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `${warningPrefix}No emails found matching the criteria.`,
              },
            ],
          };
        }

        const totalDisplay = result.totalApprox ? `~${result.total}` : `${result.total}`;
        const header =
          `📬 [${params.mailbox}] ${totalDisplay} emails ` +
          `(page ${result.page}/${Math.ceil(result.total / result.pageSize)})` +
          `${result.hasMore ? ' — more pages available' : ''}\n`;
        const emails = result.items.map((m) => formatEmailMeta(m, params.preview)).join('\n\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `${warningPrefix}${header}\n${emails}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_email
  // ---------------------------------------------------------------------------
  server.tool(
    'get_email',
    'Get the content of a specific email by ID. ' +
      'Does NOT mark the email as seen (uses IMAP BODY.PEEK — non-destructive). ' +
      'format: text (default) = readable plain text (HTML converted, links kept); stripped = text minus ' +
      'quoted replies and signatures; full = the decoded body part as-is; html = the raw HTML part. ' +
      `The body is capped at ${DEFAULT_SINGLE_BODY_MAX} characters by default (html: uncapped): a cut ` +
      'body ends with a ✂️ marker — call again with offset=<shown end> for the next part, or ' +
      'maxLength=0 for the whole body. ' +
      'Set markRead=true only when you want to explicitly mark the email as read.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      format: bodyFormatParam(),
      maxLength: maxLengthParam(DEFAULT_SINGLE_BODY_MAX, 'body'),
      offset: numeric(z.number().int().min(0).default(0)).describe(
        'Character offset to start the body at (default 0) — to read the rest of a truncated body.',
      ),
      markRead: z
        .boolean()
        .default(false)
        .describe(
          'Explicitly mark the email as read after fetching (default: false — reading is non-destructive by default)',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox, format, maxLength, offset, markRead }) => {
      try {
        const email = await imapService.getEmail(account, emailId, mailbox);

        const parts: string[] = [
          `📧 ${email.subject}`,
          `Status: ${formatEmailStatus(email)}`,
          `From:   ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
          `To:     ${email.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`,
        ];

        if (email.cc?.length) {
          parts.push(`CC:     ${email.cc.map((a) => a.address).join(', ')}`);
        }

        parts.push(`Date:   ${email.date}`);
        parts.push(`ID:     ${email.messageId}`);

        if (email.inReplyTo) {
          parts.push(`Reply:  ${email.inReplyTo}`);
        }

        if (email.attachments.length > 0) {
          parts.push(
            `📎 Attachments: ${email.attachments.map((a) => `${a.filename} (${a.mimeType}, ${formatSize(a.size)})`).join(', ')}`,
          );
        }

        // Indice liste / automatique : depuis l'en-tête complet, sur les deux
        // backends (Graph sert `internetMessageHeaders` sur un message seul).
        const classification = email.classification ?? classifyFromHeaders(email.headers);
        if (classification) parts.push(formatClassification(classification, true));

        parts.push('', '--- Body ---', '');
        parts.push(
          applyBodyFormat(email, format, {
            maxLength: resolveMaxLength(format, maxLength, DEFAULT_SINGLE_BODY_MAX),
            offset,
            continuation: (next) =>
              `call get_email again with offset=${next} for the next part, or maxLength=0 for the whole body`,
          }),
        );

        if (markRead) {
          await imapService.setFlags(account, emailId, mailbox, 'read');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_emails  (batch content fetch)
  // ---------------------------------------------------------------------------
  server.tool(
    'get_emails',
    'Fetch the full content of multiple emails in a single call (max 20). ' +
      'More efficient than calling get_email repeatedly when triaging or summarising several emails. ' +
      'Does NOT mark emails as seen. ' +
      'Defaults to format="text" (HTML converted to readable text) for compact, AI-friendly output. ' +
      `Each body is capped at ${DEFAULT_MULTI_BODY_MAX} characters by default (html: uncapped); ` +
      'read a cut body in full with get_email.',
    {
      account: z.string().describe('Account name from list_accounts'),
      ids: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Email IDs to fetch (max 20). Obtain IDs from list_emails or search_emails.'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      format: bodyFormatParam(),
      maxLength: maxLengthParam(DEFAULT_MULTI_BODY_MAX, 'each body'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, ids, mailbox, format, maxLength }) => {
      const results: string[] = [];
      const errors: string[] = [];

      const settled = await Promise.allSettled(
        ids.map(async (emailId) => imapService.getEmail(account, emailId, mailbox)),
      );

      settled.forEach((outcome, i) => {
        const emailId = ids[i];
        if (outcome.status === 'fulfilled') {
          const email = outcome.value;
          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;
          const body = applyBodyFormat(email, format, {
            maxLength: resolveMaxLength(format, maxLength, DEFAULT_MULTI_BODY_MAX),
            continuation: (next) =>
              `use get_email with emailId=${emailId} and offset=${next} for the rest, or maxLength=0`,
          });
          const attachLine =
            email.attachments.length > 0
              ? `📎 ${email.attachments.map((a) => a.filename).join(', ')}`
              : '';

          results.push(
            [
              `━━━ [${emailId}] ${email.subject}`,
              `Status: ${formatEmailStatus(email)}`,
              `From:   ${from}`,
              `Date:   ${email.date}`,
              attachLine,
              '',
              body,
            ]
              .filter((l) => l !== '')
              .join('\n'),
          );
        } else {
          const err = outcome.reason as unknown;
          errors.push(`[${emailId}] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      const errSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : '';
      const summary = `📬 [${mailbox}] ${results.length} email(s) fetched${errSuffix}`;

      const parts: string[] = [summary, '', ...results];
      if (errors.length > 0) {
        parts.push('', '--- Errors ---', ...errors);
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // get_email_status  (lightweight flag/label check — no body fetch)
  // ---------------------------------------------------------------------------
  server.tool(
    'get_email_status',
    'Get the current read/flag/label state of an email without fetching its body. ' +
      'Much cheaper than get_email when you only need to check whether an email is unread, ' +
      'flagged, or which labels it has. ' +
      'Also useful to confirm the result of a mark_email call. ' +
      'Does NOT mark the email as seen.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox }) => {
      try {
        const flags = await imapService.getEmailFlags(account, emailId, mailbox);

        const statusParts: string[] = [flags.seen ? '✓ Read' : '🔵 Unread'];
        if (flags.flagged) statusParts.push('⭐ Flagged');
        if (flags.answered) statusParts.push('↩️ Replied');

        const lines = [
          `📊 Email Status`,
          `ID:      ${emailId} | Mailbox: ${mailbox}`,
          `Subject: ${flags.subject}`,
          `From:    ${flags.from}`,
          `Date:    ${flags.date}`,
          `Status:  ${statusParts.join(' · ')}`,
          `Labels:  ${flags.labels.length > 0 ? flags.labels.join(', ') : '(none)'}`,
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_emails
  // ---------------------------------------------------------------------------
  server.tool(
    'search_emails',
    `Search emails with server-side filters. Omit query (or pass an empty string) to use pure filters. ` +
      `Free-text \`query\` searches subject + from + body (deep by default). On a very large folder whose ` +
      `server has no full-text index, a body scan is expensive: it is run on a bounded connection and, ` +
      `if it cannot complete, returns an explicitly flagged failure (never a silent zero) with a cost ` +
      `warning suggesting you narrow by date (since/before/on) or subject:/from:. ` +
      `Supports date ranges (since/before/on, including "7d" / "yesterday"), subject/from/to/cc/bcc/body/text ` +
      `filters, read/flag/answered state, keywords/labels, header matches, UID ranges, size limits, and attachments. ` +
      `On Gmail accounts, pass gmail_raw (e.g. 'from:foo has:attachment older_than:30d') for a dramatically ` +
      `faster native Gmail search. Results are paginated. ${COVERAGE_NOTE} ` +
      `A failed or timed-out SEARCH is reported explicitly (searchFailed + a warning) and is NEVER returned as a ` +
      `silent zero-result — if you see it, narrow the query and retry; the messages may still exist. ` +
      `Archive folders and other high-volume mailboxes (shared or ticketing inboxes can accumulate tens of ` +
      `thousands of messages) are very large — always include a date filter (since/before/on or relative ` +
      `tokens like "30d") or narrow by subject:/from:, otherwise the search may be slow or truncated. ` +
      `At least one criterion (query or a filter) is required — to browse a folder, use list_emails.`,
    {
      account: z.string().describe('Account name from list_accounts'),
      query: z
        .string()
        .optional()
        .default('')
        .describe(
          'Search keyword across subject + from + body (deep by default; omit to use filters only). ' +
            'On a very large non-indexed folder a body scan is bounded and, if it cannot complete, ' +
            'returns a flagged failure (never a silent zero) — narrow by date or subject:/from: and retry.',
        ),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      page: numeric(z.number().int().min(1).default(1)).describe('Page number'),
      pageSize: numeric(z.number().int().min(1).max(100).default(20)).describe('Results per page'),
      to: z.string().optional().describe(TO_DESCRIPTION),
      from: z.string().optional().describe(FROM_DESCRIPTION),
      subject: z.string().optional().describe(SUBJECT_DESCRIPTION),
      ...literalFilterParams,
      cc: z.string().optional().describe(`Filter by Cc. ${SERVER_MATCH_CAVEAT}`),
      bcc: z.string().optional().describe(`Filter by Bcc. ${SERVER_MATCH_CAVEAT}`),
      text: z.string().optional().describe('Any text field (headers + body)'),
      body: z.string().optional().describe('Body only'),
      since: z
        .string()
        .optional()
        .describe(
          'Date filter: received on/after. Accepts ISO 8601, YYYY-MM-DD, or relative like "7d" / "yesterday"',
        ),
      before: z.string().optional().describe('Date filter: received strictly before'),
      on: z.string().optional().describe('Date filter: received on specific date'),
      sent_since: z
        .string()
        .optional()
        .describe(
          'Date header: sent on/after (differs from since which uses internal delivery date)',
        ),
      sent_before: z.string().optional().describe('Date header: sent before'),
      seen: z.boolean().optional().describe('true = read only; false = unread only'),
      flagged: z.boolean().optional().describe('true = flagged; false = unflagged'),
      has_attachment: z
        .boolean()
        .optional()
        .describe('Filter: true=has attachments, false=no attachments'),
      larger_than: numeric(z.number().optional()).describe('Minimum email size in KB'),
      smaller_than: numeric(z.number().optional()).describe('Maximum email size in KB'),
      answered: z.boolean().optional().describe('Filter: true=replied, false=not replied'),
      draft: z.boolean().optional(),
      deleted: z.boolean().optional(),
      keyword: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('IMAP keyword/label (AND when array)'),
      not_keyword: z.union([z.string(), z.array(z.string())]).optional(),
      header: z
        .record(z.string(), z.string())
        .optional()
        .describe('Arbitrary header name/value match, e.g. {"X-Custom": "value"}'),
      uids: z
        .union([z.array(numeric(z.number())), z.string()])
        .optional()
        .describe('Specific UID ranges (array of numbers or IMAP sequence string like "1:100")'),
      attachment_filename: z
        .string()
        .optional()
        .describe(
          'Filter by attachment filename substring (case-insensitive). Example: "lease" matches "signed_lease_v7.pdf".',
        ),
      attachment_mimetype: z
        .string()
        .optional()
        .describe(
          'Filter by MIME type regex (case-insensitive). Examples: "application/pdf", "image/.*".',
        ),
      facets: z
        .array(z.enum(['sender', 'year', 'mailbox']))
        .optional()
        .describe(
          'Return bucketed counts by sender/year/mailbox alongside the paginated results. ' +
            'Useful for understanding large result sets. Skipped if match set exceeds 10000 UIDs.',
        ),
      gmail_raw: z
        .string()
        .optional()
        .describe(
          "Gmail accounts ONLY: pass Gmail search syntax (e.g. 'from:foo has:attachment') for dramatically faster server-side search. Other filters ignored when set.",
        ),
      preview: z
        .boolean()
        .default(false)
        .describe(
          'Include a ~200-character body preview per message (default: false). On IMAP this reads the ' +
            'first 1.5 KB of each message text part (one extra FETCH per page); Microsoft Graph ' +
            'serves it at no extra cost.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      // Sans aucun critère, le SEARCH IMAP rend TOUT le dossier : la réponse
      // ressemble à une recherche réussie alors qu'un nom de filtre mal
      // orthographié (retiré en silence par le schéma) en est souvent la
      // cause. On refuse explicitement (codefuturist 480df07).
      if (!hasSearchCriterion(params)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                'search_emails needs at least one search criterion: a non-empty query or a filter ' +
                '(from, subject, since, seen, …). Nothing was searched. To browse a folder without ' +
                'criteria, use list_emails; if you did pass a filter, check its name against the ' +
                'tool schema — unknown parameters are dropped.',
            },
          ],
        };
      }
      try {
        const result = await imapService.searchEmails(params.account, params.query ?? '', {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
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
          uids: params.uids,
          attachmentFilename: params.attachment_filename,
          attachmentMimetype: params.attachment_mimetype,
          facets: params.facets,
          gmailRaw: params.gmail_raw,
          preview: params.preview,
          ...literalFilterOptions(params),
        });

        const totalDisplay = result.totalApprox ? `~${result.total}` : `${result.total}`;
        const queryLabel = params.query ? `"${params.query}"` : 'filters';
        const totalPages = result.total > 0 ? Math.ceil(result.total / result.pageSize) : 1;
        const header =
          `🔍 [${params.mailbox}] ${totalDisplay} result(s) for ${queryLabel} ` +
          `(page ${result.page}/${totalPages})\n`;
        const emptyMsg = params.query
          ? `No emails found matching "${params.query}".`
          : 'No emails found matching the specified filters.';

        return {
          content: [
            {
              type: 'text' as const,
              text: formatSearchResult(result, header, emptyMsg, params.preview),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_all_accounts
  // ---------------------------------------------------------------------------
  server.tool(
    'search_all_accounts',
    `Search emails across multiple accounts in parallel. Same filter set as search_emails ` +
      `but fans out across N accounts and merges results sorted by date. Each result is tagged ` +
      `with the account it came from. Partial failures are surfaced as warnings without failing ` +
      `the whole call. Useful for "find X anywhere in my inboxes" queries across your email ecosystem. ` +
      `IMAP and Microsoft Graph accounts can be mixed. ${COVERAGE_NOTE}`,
    {
      query: z
        .string()
        .optional()
        .default('')
        .describe(
          'Search keyword across subject + from + body (deep by default; omit to use filters only). ' +
            'On a very large non-indexed folder a body scan is bounded and, if it cannot complete, ' +
            'returns a flagged failure (never a silent zero) — narrow by date or subject:/from: and retry.',
        ),
      accounts: z
        .array(z.string())
        .optional()
        .describe('Specific accounts to search (default: all accounts from list_accounts)'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      page: numeric(z.number().int().min(1).default(1)).describe(
        'Page number of the merged result set',
      ),
      pageSize: numeric(z.number().int().min(1).max(100).default(20)).describe(
        'Results per page (merged across accounts)',
      ),
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
      larger_than: numeric(z.number().optional()),
      smaller_than: numeric(z.number().optional()),
      answered: z.boolean().optional(),
      draft: z.boolean().optional(),
      deleted: z.boolean().optional(),
      keyword: z.union([z.string(), z.array(z.string())]).optional(),
      not_keyword: z.union([z.string(), z.array(z.string())]).optional(),
      header: z.record(z.string(), z.string()).optional(),
      attachment_filename: z.string().optional(),
      attachment_mimetype: z.string().optional(),
      facets: z.array(z.enum(['sender', 'year', 'mailbox'])).optional(),
      gmail_raw: z
        .string()
        .optional()
        .describe(
          'Gmail accounts ONLY (when targeted accounts include Gmail). Non-Gmail accounts in the ' +
            'fan-out will error individually and appear in warnings.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const accountNames =
          params.accounts && params.accounts.length > 0
            ? params.accounts
            : connections.getAccountNames();

        if (accountNames.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No accounts configured — add at least one account to config.toml.',
              },
            ],
          };
        }

        const result = await imapService.searchAcrossAccounts(accountNames, params.query ?? '', {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
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
          facets: params.facets,
          gmailRaw: params.gmail_raw,
          ...literalFilterOptions(params),
        });

        const totalDisplay = result.totalApprox ? `~${result.total}` : `${result.total}`;
        const queryLabel = params.query ? `"${params.query}"` : 'filters';
        const totalPages = result.total > 0 ? Math.ceil(result.total / result.pageSize) : 1;
        const header =
          `🔍 [${accountNames.length} account(s) · ${params.mailbox}] ` +
          `${totalDisplay} result(s) for ${queryLabel} ` +
          `(page ${result.page}/${totalPages})\n`;
        const emptyMsg = params.query
          ? `No emails found matching "${params.query}" across ${accountNames.length} account(s).`
          : `No emails found matching the specified filters across ${accountNames.length} account(s).`;

        return {
          content: [
            {
              type: 'text' as const,
              text: formatSearchResult(result, header, emptyMsg),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search accounts: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
