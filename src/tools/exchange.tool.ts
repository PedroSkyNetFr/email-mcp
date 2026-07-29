/**
 * MCP tools: Exchange / Outlook.com capabilities with no IMAP equivalent.
 *
 * Server-side inbox rules and the automatic reply live in the mailbox itself,
 * not in the client: they keep working when nothing of ours is running. IMAP
 * cannot express either, so these tools are only available on accounts served by
 * Microsoft Graph and say so plainly on any other.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import audit from '../safety/audit.js';
import type GraphService from '../services/graph/graph.service.js';
import type { AppConfig } from '../types/index.js';

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export default function registerExchangeTools(
  server: McpServer,
  graphService: GraphService,
  config: AppConfig,
): void {
  /** These operations exist only on a Graph-backed mailbox. */
  const assertGraph = (account: string): string | null => {
    const cfg = config.accounts.find((entry) => entry.name === account);
    if (!cfg) return `Unknown account "${account}"`;
    if (cfg.backend !== 'graph') {
      return (
        `Account "${account}" is served over IMAP, which has no server-side rules or ` +
        'automatic reply. This tool needs an Exchange or Outlook.com account configured with ' +
        'backend = "graph".'
      );
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // Inbox rules
  // ---------------------------------------------------------------------------

  server.tool(
    'list_mail_rules',
    'List the server-side inbox rules of an Exchange / Outlook.com account. These run in the ' +
      'mailbox itself, so they sort mail even when no client is connected.',
    { account: z.string().describe('Account name (must be a Graph-backed account)') },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account }) => {
      const problem = assertGraph(account);
      if (problem) return errorResult(problem);
      try {
        const rules = await graphService.listMessageRules(account);
        return jsonResult({ count: rules.length, rules });
      } catch (err) {
        return errorResult(
          `Failed to list rules: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    'create_mail_rule',
    'Create a server-side inbox rule. Needs at least one condition and one action. The ' +
      'destination is given as a mailbox path (e.g. "NISSAN/Reçu nissan"), not an internal id.',
    {
      account: z.string().describe('Account name (must be a Graph-backed account)'),
      name: z.string().describe('Rule name as it appears in Outlook'),
      from_addresses: z
        .array(z.string())
        .optional()
        .describe('Condition: sender contains any of these strings'),
      subject_contains: z.array(z.string()).optional().describe('Condition: subject contains'),
      body_contains: z.array(z.string()).optional().describe('Condition: body contains'),
      move_to_mailbox: z.string().optional().describe('Action: move the message to this folder'),
      mark_as_read: z.boolean().optional().describe('Action: mark the message read'),
      mark_importance: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe('Action: set importance'),
      delete_message: z.boolean().optional().describe('Action: move the message to Deleted Items'),
      stop_processing: z
        .boolean()
        .optional()
        .describe('Stop evaluating later rules when this one matches'),
      sequence: z.number().int().optional().describe('Evaluation order (lower runs first)'),
      enabled: z.boolean().optional().describe('Create the rule disabled by passing false'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const problem = assertGraph(params.account);
      if (problem) return errorResult(problem);
      try {
        const rule = await graphService.createMessageRule(params.account, {
          displayName: params.name,
          sequence: params.sequence,
          isEnabled: params.enabled,
          fromAddresses: params.from_addresses,
          subjectContains: params.subject_contains,
          bodyContains: params.body_contains,
          moveToMailbox: params.move_to_mailbox,
          markAsRead: params.mark_as_read,
          markImportance: params.mark_importance,
          delete: params.delete_message,
          stopProcessingRules: params.stop_processing,
        });
        await audit.log('create_mail_rule', params.account, { name: params.name }, 'ok');
        return jsonResult({ created: rule });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await audit.log('create_mail_rule', params.account, { name: params.name }, 'error', message);
        return errorResult(`Failed to create the rule: ${message}`);
      }
    },
  );

  server.tool(
    'delete_mail_rule',
    'Delete a server-side inbox rule by id (get ids from list_mail_rules).',
    {
      account: z.string().describe('Account name (must be a Graph-backed account)'),
      rule_id: z.string().describe('Rule id from list_mail_rules'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ account, rule_id: ruleId }) => {
      const problem = assertGraph(account);
      if (problem) return errorResult(problem);
      try {
        await graphService.deleteMessageRule(account, ruleId);
        await audit.log('delete_mail_rule', account, { ruleId }, 'ok');
        return { content: [{ type: 'text' as const, text: `Rule ${ruleId} deleted.` }] };
      } catch (err) {
        return errorResult(
          `Failed to delete the rule: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Automatic reply
  // ---------------------------------------------------------------------------

  server.tool(
    'get_auto_reply',
    'Read the automatic reply (out of office) setting of an Exchange / Outlook.com account.',
    { account: z.string().describe('Account name (must be a Graph-backed account)') },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account }) => {
      const problem = assertGraph(account);
      if (problem) return errorResult(problem);
      try {
        return jsonResult(await graphService.getAutomaticReplies(account));
      } catch (err) {
        return errorResult(
          `Failed to read the automatic reply: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    'set_auto_reply',
    'Turn the automatic reply (out of office) on or off. Use status "scheduled" with a start and ' +
      'end, "alwaysEnabled" until turned off, or "disabled".',
    {
      account: z.string().describe('Account name (must be a Graph-backed account)'),
      status: z.enum(['disabled', 'alwaysEnabled', 'scheduled']),
      internal_message: z
        .string()
        .optional()
        .describe('HTML reply sent to people inside the organisation'),
      external_message: z.string().optional().describe('HTML reply sent to outside senders'),
      external_audience: z
        .enum(['none', 'contactsOnly', 'all'])
        .optional()
        .describe('Who outside gets a reply (default: all)'),
      start_datetime: z
        .string()
        .optional()
        .describe('ISO date-time, required when status is "scheduled"'),
      end_datetime: z
        .string()
        .optional()
        .describe('ISO date-time, required when status is "scheduled"'),
      time_zone: z.string().optional().describe('Time zone for the dates (default: UTC)'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const problem = assertGraph(params.account);
      if (problem) return errorResult(problem);
      try {
        await graphService.setAutomaticReplies(params.account, {
          status: params.status,
          internalReplyMessage: params.internal_message,
          externalReplyMessage: params.external_message,
          externalAudience: params.external_audience,
          startDateTime: params.start_datetime,
          endDateTime: params.end_datetime,
          timeZone: params.time_zone,
        });
        await audit.log('set_auto_reply', params.account, { status: params.status }, 'ok');
        return {
          content: [
            { type: 'text' as const, text: `Automatic reply is now "${params.status}".` },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await audit.log('set_auto_reply', params.account, { status: params.status }, 'error', message);
        return errorResult(`Failed to set the automatic reply: ${message}`);
      }
    },
  );
}
