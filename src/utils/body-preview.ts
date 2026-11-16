/**
 * Aperçu du corps pour les listes IMAP (`preview: true`).
 *
 * L'ancien aperçu lisait les 256 premiers octets de la SOURCE du message :
 * c'est presque toujours le début des en-têtes (un en-tête `Received` dépasse
 * à lui seul 256 octets), donc aucun aperçu, ou au mieux une bouillie de
 * base64 / de MIME. Ici, on choisit la partie texte d'après la BODYSTRUCTURE,
 * on n'en lit que les `PREVIEW_PART_BYTES` premiers octets, et on la décode.
 *
 * Toutes les étapes tolèrent une entrée coupée en plein milieu (la lecture
 * s'arrête à un nombre d'octets, pas à une frontière d'encodage) : groupe
 * base64 incomplet, échappement quoted-printable coupé, caractère UTF-8
 * tranché, balise HTML ou bloc `<style>` non refermé. Inspiré de codefuturist
 * dbea7ec + ec5330a (garde contre l'entité forgée qui faisait échouer toute la
 * page de liste).
 */

import { htmlToPlainText } from './body-format.js';

/**
 * Octets lus par message. Mesuré par codefuturist sur 80 messages réels : le
 * texte brut est exploitable dès 600 octets, mais un HTML dépense son premier
 * kilo-octet en en-tête `<head>` ; 1 500 octets donnent un aperçu utilisable
 * pour 25 messages HTML sur 27, et rien de plus au-delà.
 */
export const PREVIEW_PART_BYTES = 1500;

/** Caractères conservés dans l'aperçu final. */
export const PREVIEW_LENGTH = 200;

/** Profondeur maximale explorée dans la BODYSTRUCTURE (structures forgées). */
const MAX_DEPTH = 8;

/** Balisage dans une partie déclarée text/plain (fréquent chez les envois en masse). */
const LOOKS_LIKE_MARKUP = /<(?:html|body|div|table|style|head|meta|span|p|br)\b/i;

/** En dessous, un aperçu issu de HTML est un résidu de balisage, pas du contenu. */
const MIN_MARKUP_PREVIEW = 20;

/** La partie dont on tire l'aperçu. */
export interface PreviewPart {
  /** Numéro de section IMAP à lire (« 1 », « 1.1 », « 2 »…). */
  key: string;
  /** Type MIME complet, en minuscules (`text/plain` ou `text/html`). */
  type: string;
  encoding?: string;
  charset?: string;
}

interface StructureNode {
  part?: string;
  type?: string;
  encoding?: string;
  disposition?: string;
  parameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

/**
 * Choisit la partie de l'aperçu : la première `text/plain` qui n'est pas une
 * pièce jointe, sinon la première `text/html`. On ne descend pas dans un
 * `message/rfc822` (ce serait l'aperçu du message transféré, pas du message).
 *
 * Un message non multipart a son corps en section « 1 » (RFC 3501 §6.4.5).
 */
export function findPreviewPart(bodyStructure: unknown): PreviewPart | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') return undefined;
  let plain: PreviewPart | undefined;
  let html: PreviewPart | undefined;

  const visit = (node: StructureNode, key: string, depth: number): void => {
    if (plain || depth > MAX_DEPTH) return;
    const type = (node.type ?? '').toLowerCase();
    if (type.startsWith('multipart/') || Array.isArray(node.childNodes)) {
      if (type === 'message/rfc822') return;
      (node.childNodes ?? []).forEach((child, i) => {
        visit(child, child.part ?? (key ? `${key}.${i + 1}` : String(i + 1)), depth + 1);
      });
      return;
    }
    if ((node.disposition ?? '').toLowerCase() === 'attachment') return;
    const part: PreviewPart = {
      key: key || '1',
      type,
      encoding: node.encoding,
      charset: node.parameters?.charset,
    };
    if (type === 'text/plain') plain ??= part;
    else if (type === 'text/html') html ??= part;
  };

  const root = bodyStructure as StructureNode;
  visit(root, root.part ?? '', 0);
  return plain ?? html;
}

/** Décode du quoted-printable, en jetant un échappement coupé par la lecture. */
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw
    .toString('latin1')
    .replace(/=\r?\n/g, '')
    .replace(/=[0-9A-Fa-f]?$/, '');
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      // latin1 : chaque caractère est déjà un octet (0–255).
      out.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(out);
}

/** Décode du base64 en ignorant le groupe final incomplet. */
function decodeBase64(raw: Buffer): Buffer {
  const cleaned = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
  return Buffer.from(cleaned.slice(0, cleaned.length - (cleaned.length % 4)), 'base64');
}

/** Défait le Content-Transfer-Encoding de la partie. */
export function decodeTransferEncoding(raw: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').toLowerCase()) {
    case 'quoted-printable':
      return decodeQuotedPrintable(raw);
    case 'base64':
      return decodeBase64(raw);
    default:
      return raw;
  }
}

/**
 * Décode des octets selon un jeu de caractères déclaré. Non strict (`fatal:
 * false`) : une lecture coupée en plein caractère ne doit pas lever. Étiquette
 * inconnue ou absente → UTF-8, le repli le moins faux.
 */
export function decodeCharset(buffer: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

/**
 * Transforme les octets lus d'une partie en aperçu d'une ligne, ou `undefined`
 * s'il n'en reste rien d'utile (mieux vaut pas d'aperçu qu'un aperçu
 * trompeur). Ne lève jamais : un aperçu est un confort, il ne doit pas faire
 * échouer la liste qui le porte.
 *
 * @param binary vrai si le serveur a déjà défait l'encodage de transfert
 *               (réponse FETCH BINARY).
 */
export function buildPreview(raw: Buffer, part: PreviewPart, binary = false): string | undefined {
  try {
    const bytes = binary ? raw : decodeTransferEncoding(raw, part.encoding);
    const decoded = decodeCharset(bytes, part.charset);
    // On se fie au contenu plutôt qu'au type déclaré : une partie text/plain
    // remplie de HTML mettrait sinon du CSS dans l'aperçu.
    const isMarkup = part.type === 'text/html' || LOOKS_LIKE_MARKUP.test(decoded);
    const plain = isMarkup ? htmlToPlainText(decoded) : decoded;
    const text = plain
      // Remplissage invisible des « preheaders » de newsletter.
      .replace(/\u200b|\u200c|\u200d|\u00ad|\ufeff|\u034f/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      // Caractère tranché par la lecture partielle : dommage de troncature.
      .replace(/\ufffd+$/, '')
      .trimEnd();
    if (text.length < (isMarkup ? MIN_MARKUP_PREVIEW : 1)) return undefined;
    return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text;
  } catch {
    return undefined;
  }
}
