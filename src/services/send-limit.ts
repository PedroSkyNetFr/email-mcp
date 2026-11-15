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
 *   - SMTP : 25 Mo, la limite la plus répandue (Gmail, Yahoo, la plupart des
 *     hébergeurs ; Outlook.com et iCloud sont à 20 Mo) ;
 *   - Graph : 35 Mo, la limite d'envoi par défaut d'une boîte Exchange Online
 *     (MaxSendSize). La session d'upload accepte des pièces jusqu'à 150 Mo,
 *     mais le message reste refusé au-delà de la limite de la boîte.
 * Réglable par compte avec `max_message_mb` (config.toml).
 */

import type { AccountConfig } from '../types/index.js';

const MB = 1024 * 1024;

export const DEFAULT_SMTP_MAX_MESSAGE_MB = 25;
export const DEFAULT_GRAPH_MAX_MESSAGE_MB = 35;

/** Limite applicable au compte, en octets. */
export function maxMessageBytes(account: AccountConfig): number {
  const fallback =
    account.backend === 'graph' ? DEFAULT_GRAPH_MAX_MESSAGE_MB : DEFAULT_SMTP_MAX_MESSAGE_MB;
  const mb =
    typeof account.maxMessageMb === 'number' && account.maxMessageMb > 0
      ? account.maxMessageMb
      : fallback;
  return Math.floor(mb * MB);
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
  if (encodedBytes <= limit) return;
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
