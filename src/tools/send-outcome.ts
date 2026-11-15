/**
 * Mise en forme, pour la réponse d'un outil d'envoi, de ce qui s'est passé
 * APRÈS l'envoi : copie dans Envoyés, sort du brouillon, avertissements.
 *
 * Ces issues étaient avalées (console.warn) : le modèle annonçait « envoyé et
 * classé » alors que la copie avait échoué, ou recevait une erreur après un
 * envoi réussi — et renvoyait alors le message en double.
 */

import type { SendResult } from '../types/index.js';

/**
 * Lignes à ajouter au message de succès. Rien quand tout s'est passé comme
 * prévu et qu'il n'y a rien à dire : une copie omise volontairement
 * (save_to_sent désactivé, Gmail) reste silencieuse.
 */
export default function describeSendOutcome(result: SendResult): string {
  const lines: string[] = [];

  if (result.sentCopy?.kind === 'filed') {
    lines.push('📁 Copy filed in the Sent folder.');
  } else if (result.sentCopy?.kind === 'failed') {
    lines.push(
      `⚠️ The message WAS sent, but filing a copy in the Sent folder failed: ${result.sentCopy.error}. ` +
        'Do not resend it.',
    );
  }

  if (result.draftCleanup?.kind === 'removed') {
    lines.push('🗑️ Draft removed from the Drafts folder.');
  } else if (result.draftCleanup?.kind === 'kept') {
    lines.push(
      `⚠️ Draft kept in the Drafts folder because ${result.draftCleanup.reason}. ` +
        'The message WAS sent — do not send this draft again; delete it once you have checked the Sent folder.',
    );
  } else if (result.draftCleanup?.kind === 'failed') {
    lines.push(
      `⚠️ The message WAS sent, but deleting the draft failed: ${result.draftCleanup.error}. ` +
        'Do not resend; delete the leftover draft manually.',
    );
  }

  (result.warnings ?? []).forEach((warning) => {
    lines.push(`⚠️ ${warning}`);
  });

  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}
