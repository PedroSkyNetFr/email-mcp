/**
 * Outil MCP : get_email_headers — en-têtes Internet complets d'un message.
 *
 * `get_email` expose déjà un `headers` aplati (une valeur par nom), suffisant
 * pour lire un `List-Unsubscribe` mais inutilisable pour tracer un message :
 * les en-têtes répétés y sont écrasés, et c'est précisément la SUITE des
 * `Received:` qui dit par où le message est passé.
 *
 * Cet outil rend les trois formes utiles :
 *   - `analysis` — chaîne de transport chronologique et verdicts
 *     SPF / DKIM / DMARC, pour répondre à « ce message est-il légitime » ;
 *   - `headers` — toutes les occurrences, dépliées, dans l'ordre du message ;
 *   - `raw` — le bloc brut, pour qui veut vérifier lui-même.
 *
 * Le FETCH ne rapatrie que le bloc d'en-têtes (BODY.PEEK[HEADER] côté IMAP),
 * donc l'appel reste bon marché même sur un message de plusieurs méga-octets,
 * et ne marque pas le message comme lu.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { IMailService } from '../services/mail-service.types.js';
import type { EmailHeaderDump } from '../types/index.js';
import type { AuthMethodResult, ReceivedHop } from '../utils/headers.js';

/** `120` → `2m 0s`, pour que les temps d'attente d'un relais se lisent d'un œil. */
function formatDuration(seconds: number): string {
  if (Math.abs(seconds) < 60) return `${seconds}s`;
  const minutes = Math.floor(Math.abs(seconds) / 60);
  const rest = Math.abs(seconds) % 60;
  const sign = seconds < 0 ? '-' : '';
  if (minutes < 60) return `${sign}${minutes}m ${rest}s`;
  return `${sign}${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `spf=pass (smtp.mailfrom=a@b.fr)` */
function formatVerdict(verdict: AuthMethodResult): string {
  const properties = Object.entries(verdict.properties)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return `${verdict.method}=${verdict.result}${properties ? ` (${properties})` : ''}`;
}

/** Une ligne par relais : origine → destination, protocole, date, délai. */
function formatHop(hop: ReceivedHop): string {
  const route = `${hop.from ?? '?'} → ${hop.by ?? '?'}`;
  const parts = [`${hop.index + 1}. ${route}`];
  if (hop.with) parts.push(`[${hop.with}]`);
  if (hop.date) parts.push(hop.date);
  if (hop.delaySeconds !== undefined) parts.push(`(+${formatDuration(hop.delaySeconds)})`);
  return parts.join('  ');
}

/** ✅ / ❌ / — selon un booléen éventuellement indéterminé. */
function tick(value: boolean | undefined): string {
  if (value === undefined) return '—';
  return value ? '✅' : '❌';
}

/**
 * Rendu lisible d'un relevé d'en-têtes. Exporté pour être testé sans serveur
 * MCP ni compte de messagerie.
 */
export function formatHeaderDump(
  dump: EmailHeaderDump,
  options: { includeAllHeaders: boolean; includeRaw: boolean },
): string {
  const { analysis, grouped } = dump;
  const parts: string[] = [
    `📨 Internet headers — account "${dump.account}", mailbox ${dump.mailbox}, id ${dump.emailId}`,
  ];

  const summaryFields: [string, string | undefined][] = [
    ['Subject', grouped.subject?.[0]],
    ['From', grouped.from?.[0]],
    ['Return-Path', grouped['return-path']?.[0]],
    ['Message-ID', grouped['message-id']?.[0]],
  ];
  summaryFields.forEach(([label, value]) => {
    if (value) parts.push(`${label}: ${value}`);
  });

  // --- Authentification ---
  const verdicts = Object.values(analysis.authentication.verdicts);
  parts.push('', '--- Authentication ---');
  if (verdicts.length > 0) {
    parts.push(...verdicts.map((verdict) => formatVerdict(verdict)));
  } else {
    parts.push('(no Authentication-Results header)');
  }
  const { alignment } = analysis;
  parts.push(
    `Alignment: From=${alignment.fromDomain ?? '?'} | ` +
      `SPF=${alignment.spfDomain ?? '?'} ${tick(alignment.spfAligned)} | ` +
      `DKIM=${alignment.dkimDomains.join(', ') || '?'} ${tick(alignment.dkimAligned)} | ` +
      `Return-Path ${tick(alignment.returnPathMatchesFrom)}`,
  );
  if (analysis.authentication.dkimSignatures.length > 0) {
    parts.push(
      `DKIM signatures: ${analysis.authentication.dkimSignatures
        .map((sig) => `${sig.domain ?? '?'} (s=${sig.selector ?? '?'}, ${sig.algorithm ?? '?'})`)
        .join('; ')}`,
    );
  }
  parts.push(...analysis.authentication.receivedSpf.map((value) => `Received-SPF: ${value}`));

  // --- Chaîne de transport ---
  const transit =
    analysis.transitSeconds !== undefined
      ? `, transit ${formatDuration(analysis.transitSeconds)}`
      : '';
  parts.push('', `--- Received chain (${analysis.received.length} hops${transit}) ---`);
  if (analysis.received.length > 0) {
    parts.push(...analysis.received.map((hop) => formatHop(hop)));
  } else {
    parts.push('(no Received header)');
  }

  if (analysis.notes.length > 0) {
    parts.push('', '--- Notes ---');
    parts.push(...analysis.notes.map((note) => `• ${note}`));
  }

  if (options.includeAllHeaders) {
    parts.push('', `--- All headers (${dump.entries.length}) ---`);
    parts.push(...dump.entries.map((entry) => `${entry.name}: ${entry.value}`));
  }

  if (options.includeRaw) {
    parts.push(
      '',
      dump.rawReconstructed
        ? '--- Raw header block (REBUILT from the API header list — values are exact, ' +
            'original folding and ordering of continuation lines are not) ---'
        : '--- Raw header block (verbatim) ---',
      dump.raw,
    );
  }

  return parts.join('\n');
}

export default function registerHeaderTools(server: McpServer, imapService: IMailService): void {
  server.tool(
    'get_email_headers',
    'Get the COMPLETE Internet headers of a message — every occurrence, unfolded, in message ' +
      'order — plus a decoded analysis: the full Received chain in chronological order with the ' +
      'delay at each hop, SPF/DKIM/DMARC verdicts from Authentication-Results, DKIM signatures, ' +
      'and From/Return-Path/SPF/DKIM domain alignment. Use this (not get_email) to answer ' +
      '"where did this message really come from", "is this phishing", or "why was it delayed". ' +
      'Only the header block is fetched, so it is cheap even on huge messages, and the message ' +
      'is NOT marked as read.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      format: z
        .enum(['summary', 'json'])
        .default('summary')
        .describe(
          'summary=human/AI-readable report (default). json=full structured dump (headers, ' +
            'grouped values, parsed Received chain, auth verdicts).',
        ),
      include_all_headers: z
        .boolean()
        .default(true)
        .describe('summary only: list every header after the analysis'),
      include_raw: z
        .boolean()
        .default(false)
        .describe('Include the raw header block exactly as received'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox, format, include_all_headers, include_raw }) => {
      try {
        const dump = await imapService.getEmailHeaders(account, emailId, mailbox);

        if (format === 'json') {
          // Le bloc brut n'est joint que sur demande : il double la réponse
          // sans rien apporter que `entries` ne porte déjà.
          const { raw, ...rest } = dump;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(include_raw ? { ...rest, raw } : rest, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: formatHeaderDump(dump, {
                includeAllHeaders: include_all_headers,
                includeRaw: include_raw,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email headers: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
