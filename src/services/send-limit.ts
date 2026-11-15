/**
 * Limite de taille TOTALE d'un message sortant.
 *
 * Le résolveur de pièces jointes ne plafonne que chaque fichier (25 Mo). Trois
 * fichiers de 15 Mo passaient donc ce contrôle, puis le serveur refusait le
 * message entier avec un « 552 Message size exceeds » opaque — après que les
 * octets aient été lus, encodés et transmis. Ce module contrôle la taille du
 * message ENCODÉ avant l'envoi : c'est ce que reçoit le serveur, et le base64
 * gonfle chaque pièce d'environ 37 % (×4/3, plus les fins de ligne). Un
 * fichier de 20 Mo fait ainsi ~27 Mo sur le fil et dépasse une limite de 25 Mo.
 *
 * Limites par défaut, par backend :
 *   - SMTP : AUCUNE limite locale par défaut. Le serveur annonce la sienne
 *     (extension SIZE, RFC 1870) et nodemailer refuse déjà, avant DATA, un
 *     message qui la dépasse ; une limite locale arbitraire (25 Mo) bloquait à
 *     tort les serveurs plus généreux. Le contrôle local ne s'applique que si
 *     le compte fixe `max_message_mb` ; un refus du serveur pour taille est
 *     traduit en message clair par `explainSmtpSizeRejection` ;
 *   - Graph : 35 Mo, la limite d'envoi par défaut d'une boîte Exchange Online
 *     (MaxSendSize). La session d'upload accepte des pièces jusqu'à 150 Mo,
 *     mais le message reste refusé au-delà de la limite de la boîte, et Graph
 *     n'annonce pas cette limite à l'avance.
 * Réglable par compte avec `max_message_mb` (config.toml).
 */

import type { AccountConfig } from '../types/index.js';

const MB = 1024 * 1024;

export const DEFAULT_GRAPH_MAX_MESSAGE_MB = 35;

/**
 * Limite applicable au compte, en octets ; `undefined` quand aucune limite
 * locale ne s'applique (compte SMTP sans `max_message_mb` : le serveur décide).
 */
export function maxMessageBytes(account: AccountConfig): number | undefined {
  if (typeof account.maxMessageMb === 'number' && account.maxMessageMb > 0) {
    return Math.floor(account.maxMessageMb * MB);
  }
  return account.backend === 'graph' ? DEFAULT_GRAPH_MAX_MESSAGE_MB * MB : undefined;
}

/** Taille base64 d'un contenu de `bytes` octets, fins de ligne MIME (76 + CRLF) comprises. */
export function base64EncodedSize(bytes: number): number {
  const chars = Math.ceil(bytes / 3) * 4;
  return chars + Math.ceil(chars / 76) * 2;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Taille encodée estimée d'un message : corps + pièces en base64. Sert quand
 * le message n'est pas composé localement (Graph) ; en SMTP, la taille exacte
 * du message composé est utilisée.
 */
export function estimateEncodedMessageSize(
  body: string,
  attachments: { content: Buffer }[] = [],
): number {
  const bodyBytes = Buffer.byteLength(body, 'utf-8');
  // Le corps est lui-même encodé (quoted-printable ou base64) : on prend
  // l'hypothèse prudente du base64.
  return (
    base64EncodedSize(bodyBytes) +
    attachments.reduce((sum, a) => sum + base64EncodedSize(a.content.length), 0)
  );
}

/**
 * Refuse, AVANT tout envoi, un message dont la taille encodée dépasse la limite
 * du compte. Le message d'erreur détaille chaque pièce, pour que l'appelant
 * sache quoi retirer.
 */
export function assertMessageSize(
  account: AccountConfig,
  encodedBytes: number,
  attachments: { filename: string; content: Buffer }[] = [],
): void {
  const limit = maxMessageBytes(account);
  if (limit === undefined || encodedBytes <= limit) return;
  const table = attachments
    .map((a) => `  - ${a.filename}: ${formatSize(a.content.length)}`)
    .join('\n');
  const details = table
    ? `
Attachments (decoded size; base64 adds ~37%):
${table}`
    : '';
  throw new Error(
    `Message too large for account "${account.name}": ${formatSize(encodedBytes)} once encoded, ` +
      `limit ${formatSize(limit)}. Nothing was sent.${details}
` +
      'Remove or shrink attachments, or raise max_message_mb for this account if its server ' +
      'accepts more.',
  );
}

/**
 * Refus du serveur SMTP pour cause de taille : soit nodemailer lui-même
 * (« Message size larger than allowed N », code EMESSAGE, levé avant DATA
 * quand le serveur annonce SIZE), soit une réponse 552 / 5.3.4 du serveur.
 */
function isSmtpSizeRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { code?: string; responseCode?: number; response?: string };
  const text = `${e.message} ${e.response ?? ''}`;
  if (e.code === 'EMESSAGE' && /size/i.test(e.message)) return true;
  if (e.responseCode === 552 && /size|too (?:big|large)|exceed/i.test(text)) return true;
  return text.includes('5.3.4');
}

/**
 * Traduit un refus de taille du serveur SMTP en erreur explicite (taille du
 * message, limite annoncée si connue, rien n'a été envoyé, comment réagir) ;
 * toute autre erreur est rendue telle quelle.
 */
export function explainSmtpSizeRejection(
  error: unknown,
  account: AccountConfig,
  encodedBytes: number,
): unknown {
  if (!isSmtpSizeRejection(error)) return error;
  const { message } = error as Error;
  const announced = /larger than allowed (\d+)/i.exec(message);
  const limit = announced ? `, server limit ${formatSize(Number(announced[1]))}` : '';
  return new Error(
    `Message too large for the SMTP server of account "${account.name}": ` +
      `${formatSize(encodedBytes)} once encoded${limit}. Nothing was sent. ` +
      `Remove or shrink attachments (base64 adds ~37%). Server said: ${message}`,
    { cause: error },
  );
}
