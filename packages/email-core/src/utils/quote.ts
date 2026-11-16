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
 *
 * Langue : la ligne d'introduction de la citation et l'en-tête de transfert
 * sont en français par défaut (`reply_language`, réglable globalement et par
 * compte), en anglais sur demande. La date y est formatée selon la langue,
 * dans le fuseau horaire local.
 */

import type { Email, EmailAddress, ReplyLanguage } from '../types/index.js';
import { bestPlainText } from './body-format.js';
import { escapeHtml } from './html-text.js';

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
 * Texte lisible de l'original, choisi comme pour la lecture (`bestPlainText`) :
 * sa partie text/plain, sauf si c'est un « bouchon » face au HTML (« Votre
 * client ne lit pas le HTML… »), auquel cas le HTML converti — jamais le HTML
 * brut. Avant, la partie texte gagnait toujours : une réponse citait le
 * bouchon d'une ligne au lieu du vrai message.
 */
export function originalAsPlainText(original: Pick<Email, 'bodyText' | 'bodyHtml'>): string {
  return (bestPlainText(original) ?? '').replace(LINE_BREAK_RE, '\n');
}

/** Langue par défaut des citations et en-têtes de transfert. */
export const DEFAULT_REPLY_LANGUAGE: ReplyLanguage = 'fr';

const LOCALES: Record<ReplyLanguage, string> = { fr: 'fr-FR', en: 'en-US' };

/**
 * Date de l'original lisible dans la langue, fuseau horaire local :
 * « 15 nov. 2026 à 14:32 » (fr) ou « Nov 15, 2026, 2:32 PM » (en). Une date
 * illisible est rendue telle quelle. Le résultat est ramené sur une ligne,
 * comme toute valeur interpolée.
 */
export function formatQuoteDate(
  value: string,
  lang: ReplyLanguage = DEFAULT_REPLY_LANGUAGE,
): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return oneLine(value);
  if (lang === 'en') {
    return oneLine(
      new Intl.DateTimeFormat(LOCALES.en, { dateStyle: 'medium', timeStyle: 'short' }).format(date),
    );
  }
  const day = new Intl.DateTimeFormat(LOCALES.fr, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat(LOCALES.fr, { hour: '2-digit', minute: '2-digit' }).format(
    date,
  );
  return oneLine(`${day} à ${time}`);
}

/** Ligne qui introduit la citation : « Le …, X a écrit : » / « On …, X wrote: ». */
export function attribution(
  original: Pick<Email, 'date' | 'from'>,
  lang: ReplyLanguage = DEFAULT_REPLY_LANGUAGE,
): string {
  const when = formatQuoteDate(original.date, lang);
  const who = formatAddress(original.from);
  return lang === 'en' ? `On ${when}, ${who} wrote:` : `Le ${when}, ${who} a écrit :`;
}

/**
 * Bloc cité, version texte (style Thunderbird / Mutt) :
 *
 *     Le <date>, <expéditeur> a écrit :
 *     > ligne 1
 *     > ligne 2
 */
export function quoteOriginalAsText(
  original: Email,
  lang: ReplyLanguage = DEFAULT_REPLY_LANGUAGE,
): string {
  const quoted = originalAsPlainText(original)
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `\n\n${attribution(original, lang)}\n${quoted}`;
}

/**
 * Bloc cité, version HTML : `<blockquote type="cite">` (reconnu comme
 * citation par les clients), contenant l'original en texte échappé.
 */
export function quoteOriginalAsHtml(
  original: Email,
  lang: ReplyLanguage = DEFAULT_REPLY_LANGUAGE,
): string {
  const plain = originalAsPlainText(original);
  const inner = plain
    ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(plain)}</pre>`
    : '';
  return (
    `<br><br><div>${escapeHtml(attribution(original, lang))}</div>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
  );
}

/** Libellés de l'en-tête de transfert, par langue. */
const FORWARD_LABELS: Record<
  ReplyLanguage,
  { title: string; from: string; date: string; subject: string; to: string; cc: string }
> = {
  fr: {
    title: '---------- Message transféré ----------',
    from: 'De :',
    date: 'Date :',
    subject: 'Objet :',
    to: 'À :',
    cc: 'Cc :',
  },
  en: {
    title: '---------- Forwarded message ----------',
    from: 'From:',
    date: 'Date:',
    subject: 'Subject:',
    to: 'To:',
    cc: 'Cc:',
  },
};

/** Lignes d'en-tête du bloc « Message transféré » (valeurs ramenées sur une ligne). */
export function forwardHeaderLines(
  original: Email,
  lang: ReplyLanguage = DEFAULT_REPLY_LANGUAGE,
): string[] {
  const labels = FORWARD_LABELS[lang];
  const cc = original.cc ?? [];
  return [
    labels.title,
    `${labels.from} ${formatAddress(original.from)}`,
    `${labels.date} ${formatQuoteDate(original.date, lang)}`,
    `${labels.subject} ${oneLine(original.subject)}`,
    `${labels.to} ${original.to.map(formatAddress).join(', ')}`,
    ...(cc.length > 0 ? [`${labels.cc} ${cc.map(formatAddress).join(', ')}`] : []),
  ];
}

/**
 * Corps texte d'un transfert : la note de l'utilisateur, l'en-tête du message
 * transféré, puis l'original en texte (HTML converti, pas collé brut).
 */
export function forwardAsText(
  note: string | undefined,
  original: Email,
  lang: ReplyLanguage = DEFAULT_REPLY_LANGUAGE,
): string {
  const header = forwardHeaderLines(original, lang).join('\n');
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
  lang: ReplyLanguage = DEFAULT_REPLY_LANGUAGE,
): string {
  let noteHtml = '';
  if (nonEmpty(note)) {
    noteHtml = noteIsHtml
      ? `<div>${note}</div>`
      : `<div>${escapeHtml(note).replace(/\n/g, '<br>')}</div>`;
  }
  const header = forwardHeaderLines(original, lang).map(escapeHtml).join('<br>');
  const originalHtml = nonEmpty(original.bodyHtml)
    ? renderableHtml(original.bodyHtml)
    : `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(originalAsPlainText(original))}</pre>`;
  return `${noteHtml}<br><div>${header}</div><br><div>${originalHtml}</div>`;
}
