/**
 * Paramètres et exécution « gardée » des outils d'envoi : idempotence par clé
 * et refus des doublons par empreinte (voir services/send-guard.ts).
 *
 * Partagé par send_email, reply_email, forward_email, send_draft,
 * apply_template (action send) et schedule_email, pour que le refus et le
 * rejeu se comportent et se lisent pareil partout — et pareil sur IMAP et
 * Graph, puisque la garde vit au-dessus du routeur de backends.
 */

import { mcpLog } from '@pedroskynet/email-core/logging.js';
import { z } from 'zod';
import type SendGuard from '../services/send-guard.js';
import type { GuardTicket, SendRecord } from '../services/send-guard.js';
import { formatClock } from '../services/send-guard.js';

/** Champs zod à ajouter au schéma d'un outil d'envoi. */
export const sendGuardParams = {
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Optional caller-chosen key identifying THIS message. Retrying with the same key within the ' +
        'duplicate window returns the result of the first send instead of sending again; reusing a ' +
        'key for a different message is refused.',
    ),
  allow_duplicate: z
    .boolean()
    .default(false)
    .describe(
      'An identical message (same account, recipients, subject, body, attachments — and same ' +
        'original for a reply/forward) sent in the last few minutes (duplicate_send_window_minutes, ' +
        'default 10) is refused as a probable retry. Set true only to send a deliberate second copy.',
    ),
};

/** Réponse d'outil MCP minimale (l'index ouvert est exigé par le SDK). */
interface ToolText {
  [key: string]: unknown;
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

function messageIdText(record: SendRecord, refLabel: string): string {
  return record.messageId
    ? `${refLabel} ${record.messageId}`
    : `${refLabel} not reported by the server`;
}

/** Vocabulaire des messages : ce qui est envoyé, et comment s'appelle sa référence. */
export interface GuardWording {
  /** « email », « reply », « forward », « draft », « scheduled email ». */
  what: string;
  /** Participe passé de l'action : « sent » (défaut), « scheduled ». */
  done?: string;
  /** Référence rendue : « Message-ID » (défaut), « schedule_id ». */
  refLabel?: string;
}

/** Texte de refus / de rejeu, lisible par le modèle comme par l'humain. */
export function describeGuardStop(
  decision: Exclude<Awaited<ReturnType<SendGuard['check']>>, { action: 'send' }>,
  windowMinutes: number,
  wording: GuardWording,
): ToolText {
  const { what } = wording;
  // Article anglais : « an email », « a reply ».
  const aWhat = `${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}`;
  const done = wording.done ?? 'sent';
  const refLabel = wording.refLabel ?? 'Message-ID';
  const at = (record: SendRecord): string => `${formatClock(record.at)} (${record.at})`;

  if (decision.action === 'replay') {
    const { record } = decision;
    const text =
      record.status === 'uncertain'
        ? `↩️ Not sent again: this idempotency_key was used at ${at(record)} for ${aWhat} whose ` +
          'outcome was UNCERTAIN (the server may have sent it). Check the Sent folder before ' +
          'retrying with a new key.'
        : `↩️ Already ${done} — not repeated: this idempotency_key was used at ${at(record)} for ` +
          `this same ${what} (${messageIdText(record, refLabel)}). This is the result of that first call.`;
    return { content: [{ type: 'text', text }] };
  }

  const { record } = decision;
  let text: string;
  if (decision.reason === 'in-flight' || !record) {
    text =
      `Refused: an identical ${what} is being processed right now by another call. Nothing was ` +
      `${done}. Wait for it to finish; pass allow_duplicate: true only for a deliberate second copy.`;
  } else if (decision.reason === 'key-mismatch') {
    text =
      `Refused: this idempotency_key was already used at ${at(record)} for a DIFFERENT message. ` +
      `Nothing was ${done}. Use a new key for a new message.`;
  } else if (record.status === 'uncertain') {
    text =
      `Refused: identical to ${aWhat} attempted at ${at(record)} whose outcome was UNCERTAIN — ` +
      'the server may already have sent it. Nothing was sent. Check the Sent folder first; pass ' +
      'allow_duplicate: true if it really is missing.';
  } else {
    text =
      `Refused: identical to ${aWhat} already ${done} at ${at(record)}, ` +
      `${messageIdText(record, refLabel)}, less than ${windowMinutes} minutes ago — most likely a ` +
      `retried call. Nothing was ${done}. If doing it again is intended, pass allow_duplicate: true.`;
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

/** L'erreur dit-elle que l'envoi a PU partir (Graph : /send sans réponse) ? */
function isUncertain(err: unknown): boolean {
  return err instanceof Error && err.name === 'UncertainSendError';
}

/** Enregistre l'issue ; un échec d'écriture est journalisé, jamais propagé. */
async function safeCommit(
  guard: SendGuard,
  ticket: GuardTicket,
  messageId: string,
  status: 'sent' | 'uncertain',
): Promise<void> {
  try {
    await guard.commit(ticket, messageId, status);
  } catch (err) {
    await mcpLog(
      'warning',
      'send-guard',
      `could not record the send fingerprint (${err instanceof Error ? err.message : String(err)}); ` +
        'duplicate detection will not cover this message',
    );
  }
}

/**
 * Exécute `send` sous la garde.
 *
 * Renvoie `{ stop }` quand la garde refuse ou rejoue (rien n'est envoyé),
 * `{ result }` sinon. L'empreinte est enregistrée après un succès, ou après
 * une issue incertaine (puis l'erreur est relancée) ; un échec net la libère.
 * Un échec d'écriture du fichier d'état ne transforme jamais un envoi réussi
 * en erreur : il est journalisé.
 */
export async function runGuardedSend<T>(
  guard: SendGuard,
  req: {
    account: string;
    tool: string;
    fingerprint: string;
    idempotencyKey?: string;
    allowDuplicate?: boolean;
    /** Vocabulaire des messages de refus / de rejeu. */
    wording: GuardWording;
  },
  send: () => Promise<T>,
  messageIdOf: (result: T) => string,
): Promise<{ stop: ToolText } | { result: T }> {
  const decision = await guard.check(req);
  if (decision.action !== 'send') {
    return { stop: describeGuardStop(decision, guard.windowMinutes, req.wording) };
  }
  const { ticket } = decision;

  let result: T;
  try {
    result = await send();
  } catch (err) {
    if (isUncertain(err)) await safeCommit(guard, ticket, '', 'uncertain');
    else guard.release(ticket);
    throw err;
  }
  await safeCommit(guard, ticket, messageIdOf(result), 'sent');
  return { result };
}
