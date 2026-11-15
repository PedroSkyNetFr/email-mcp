/**
 * Citation du message d'origine dans une réponse ou un transfert.
 *
 * Inspiré de codefuturist (d2bdf40 + 44a0364) : une réponse sans citation
 * arrive chez le destinataire sans contexte, alors que tout client de bureau
 * (Thunderbird, Outlook, Apple Mail) et Graph `/reply` citent l'original.
 *
 * Deux garde-fous repris de 44a0364 :
 *   - en réponse HTML, l'original est cité en TEXTE échappé (dans un <pre>),
 *     jamais en HTML brut : ce HTML vient de l'expéditeur, et une balise
 *     déséquilibrée (un `</blockquote>` égaré) sortirait de la citation et
 *     s'afficherait comme si c'était notre propre texte ;
 *   - les champs d'en-tête interpolés (nom, date, objet) sont ramenés sur une
 *     ligne, tous sauts de ligne Unicode compris (NEL, U+2028, U+2029) : un nom
 *     d'expéditeur piégé ne peut pas fabriquer une seconde ligne « On … wrote: ».
 */

import type { Email, EmailAddress } from '../types/index.js';
import { escapeHtml, htmlToPlainText } from './html-text.js';

/** Tous les sauts de ligne qu'un moteur de rendu peut interpréter comme tels. */
const LINE_BREAK_RE = /\r\n|[\r\n\u0085\u2028\u2029]/g;

/** Ramène une valeur sur une seule ligne (anti-injection dans les en-têtes cités). */
export function oneLine(value: string): string {
  return value.replace(LINE_BREAK_RE, ' ').trim();
}

export function formatAddress(addr: EmailAddress): string {
  return addr.name ? `${oneLine(addr.name)} <${oneLine(addr.address)}>` : oneLine(addr.address);
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Texte lisible de l'original : sa partie text/plain si elle existe, sinon son
 * HTML converti — jamais le HTML brut.
 */
export function originalAsPlainText(original: Pick<Email, 'bodyText' | 'bodyHtml'>): string {
  if (nonEmpty(original.bodyText)) return original.bodyText.replace(LINE_BREAK_RE, '\n');
  if (nonEmpty(original.bodyHtml)) return htmlToPlainText(original.bodyHtml);
  return '';
}

function attribution(original: Pick<Email, 'date' | 'from'>): string {
  return `On ${oneLine(original.date)}, ${formatAddress(original.from)} wrote:`;
}

/**
 * Bloc cité, version texte (style Thunderbird / Mutt) :
 *
 *     On <date>, <expéditeur> wrote:
 *     > ligne 1
 *     > ligne 2
 */
export function quoteOriginalAsText(original: Email): string {
  const quoted = originalAsPlainText(original)
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `\n\n${attribution(original)}\n${quoted}`;
}

/**
 * Bloc cité, version HTML : `<blockquote type="cite">` (reconnu comme
 * citation par les clients), contenant l'original en texte échappé.
 */
export function quoteOriginalAsHtml(original: Email): string {
  const plain = originalAsPlainText(original);
  const inner = plain
    ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(plain)}</pre>`
    : '';
  return (
    `<br><br><div>${escapeHtml(attribution(original))}</div>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
  );
}

/** Lignes d'en-tête du bloc « Forwarded message » (valeurs ramenées sur une ligne). */
export function forwardHeaderLines(original: Email): string[] {
  const cc = original.cc ?? [];
  return [
    '---------- Forwarded message ----------',
    `From: ${formatAddress(original.from)}`,
    `Date: ${oneLine(original.date)}`,
    `Subject: ${oneLine(original.subject)}`,
    `To: ${original.to.map(formatAddress).join(', ')}`,
    ...(cc.length > 0 ? [`Cc: ${cc.map(formatAddress).join(', ')}`] : []),
  ];
}

/**
 * Corps texte d'un transfert : la note de l'utilisateur, l'en-tête du message
 * transféré, puis l'original en texte (HTML converti, pas collé brut).
 */
export function forwardAsText(note: string | undefined, original: Email): string {
  const header = forwardHeaderLines(original).join('\n');
  const prefix = nonEmpty(note) ? `${note}\n\n` : '';
  return `${prefix}${header}\n\n${originalAsPlainText(original)}`;
}

/**
 * Isole le contenu affichable d'un document HTML complet : le contenu de
 * <body> (ou le document entier s'il n'en a pas), sans <script> ni
 * commentaires conditionnels de tête. Les <style> sont gardés : la mise en
 * forme de l'original en dépend.
 */
function renderableHtml(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(html);
  const inner = body ? body[1] : html.replace(/<\/?(html|head)\b[^>]*>/gi, '');
  return inner.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

/**
 * Corps HTML d'un transfert : note échappée (si `noteIsHtml` est faux), en-tête
 * du message transféré, puis l'original.
 *
 * Contrairement à la citation d'une réponse, le HTML de l'original est repris
 * (scripts retirés) : un transfert transmet le message tel qu'il a été reçu,
 * mise en forme comprise — c'est ce que font Outlook, Gmail et Graph
 * `/forward`. Il est placé EN DERNIER, dans un <div> : une balise déséquilibrée
 * ne peut donc rien faire passer pour notre texte, qui le précède.
 */
export function forwardAsHtml(
  note: string | undefined,
  original: Email,
  noteIsHtml = false,
): string {
  let noteHtml = '';
  if (nonEmpty(note)) {
    noteHtml = noteIsHtml
      ? `<div>${note}</div>`
      : `<div>${escapeHtml(note).replace(/\n/g, '<br>')}</div>`;
  }
  const header = forwardHeaderLines(original).map(escapeHtml).join('<br>');
  const originalHtml = nonEmpty(original.bodyHtml)
    ? renderableHtml(original.bodyHtml)
    : `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(originalAsPlainText(original))}</pre>`;
  return `${noteHtml}<br><div>${header}</div><br><div>${originalHtml}</div>`;
}
