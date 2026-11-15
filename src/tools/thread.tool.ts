/**
 * MCP tool: get_thread
 *
 * Reconstructs an email conversation thread using References / In-Reply-To
 * header chains. Returns messages in chronological order (or newest-first).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { describeAttachments } from '../services/attachment-select.js';
import type { IMailService } from '../services/mail-service.types.js';
import { applyBodyFormat, DEFAULT_MULTI_BODY_MAX } from '../utils/body-format.js';
import { bodyFormatParam, maxLengthParam, resolveMaxLength } from './body-params.js';

export default function registerThreadTools(server: McpServer, imapService: IMailService): void {
  server.registerTool(
    'get_thread',
    {
      description:
        'Reconstruct a full email conversation thread by following References and In-Reply-To headers. ' +
        'Returns all related messages. Does NOT mark emails as seen. ' +
        'Bodies default to format="text" (readable plain text, HTML converted); format="stripped" also ' +
        'removes quoted replies, "full" returns the decoded part as-is, "html" the raw HTML part. ' +
        `Each body is capped at ${DEFAULT_MULTI_BODY_MAX} characters by default (html: uncapped); a cut ` +
        'body ends with a ✂️ marker naming the get_email call that reads the rest. ' +
        'Use newestFirst=true to show the most recent message in full and older messages as header-only summaries. ' +
        'Use get_email first to obtain the message_id.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        message_id: z.string().describe('Message-ID header value (from get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox to search (default: INBOX)'),
        format: bodyFormatParam(),
        maxLength: maxLengthParam(DEFAULT_MULTI_BODY_MAX, 'each body'),
        newestFirst: z
          .boolean()
          .default(false)
          .describe(
            'When true, shows the newest message in full and older messages as header-only summaries. ' +
              'Ideal for AI triage of long threads where only the latest reply matters.',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, message_id: messageId, mailbox, format, maxLength, newestFirst }) => {
      try {
        const thread = await imapService.getThread(account, messageId, mailbox);

        if (thread.messageCount === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No thread found for Message-ID: ${messageId}`,
              },
            ],
          };
        }

        const ordered = newestFirst ? [...thread.messages].reverse() : thread.messages;
        const total = thread.messageCount;

        const parts: string[] = [
          `🧵 Thread: ${total} message${total === 1 ? '' : 's'}`,
          `Thread-ID: ${thread.threadId}`,
          `Participants: ${thread.participants.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')}`,
          '',
        ];

        ordered.forEach((email, idx) => {
          let label: string;
          if (newestFirst) {
            label = idx === 0 ? 'Latest message' : `Message ${total - idx} of ${total} (older)`;
          } else {
            label = `Message ${idx + 1} of ${total}`;
          }

          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;

          parts.push(`--- ${label} ---`);
          parts.push(`From: ${from}`);
          parts.push(`To: ${email.to.map((a) => a.address).join(', ')}`);
          parts.push(`Date: ${email.date}`);
          parts.push(`Subject: ${email.subject}`);

          if (email.attachments.length > 0) {
            parts.push(`📎 ${describeAttachments(email.attachments)}`);
          }

          // In newestFirst mode, only render body for the newest (first) message
          if (newestFirst && idx > 0) {
            parts.push('(body omitted — use get_email to read this message)');
          } else {
            parts.push('');
            parts.push(
              applyBodyFormat(email, format, {
                maxLength: resolveMaxLength(format, maxLength, DEFAULT_MULTI_BODY_MAX),
                continuation: (next) =>
                  `use get_email with emailId=${email.id}, mailbox="${mailbox}" and offset=${next} ` +
                  'for the rest, or maxLength=0',
              }),
            );
          }

          parts.push('');
        });

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get thread: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
