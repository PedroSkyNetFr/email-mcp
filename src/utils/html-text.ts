/**
 * Conversion HTML ⇄ texte pour les messages SORTANTS.
 *
 * Sert à deux choses :
 *   1. fabriquer l'alternative text/plain d'un envoi HTML — sans elle, le
 *      message part en text/html seul, ce que les filtres anti-spam pénalisent
 *      et que les clients en mode texte affichent balises comprises ;
 *   2. citer ou transférer un original HTML dans un message texte, au lieu d'y
 *      coller le HTML brut.
 *
 * Le moteur est `html-to-text`, partagé avec la lecture (body-format.ts) :
 * un même HTML donne le même texte qu'on le lise ou qu'on l'envoie.
 */

import type { HtmlToTextOptions } from 'html-to-text';
import { convert } from 'html-to-text';
import { HTML_TO_TEXT_OPTIONS, htmlToPlainText as readingHtmlToPlainText } from './body-format.js';

/** Entités nommées les plus fréquentes dans le courrier (dont les accents français). */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  sect: '§',
  para: '¶',
  shy: '',
  zwnj: '',
  zwj: '',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  auml: 'ä',
  atilde: 'ã',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  ouml: 'ö',
  otilde: 'õ',
  oslash: 'ø',
  oelig: 'œ',
  ugrave: 'ù',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  yuml: 'ÿ',
  szlig: 'ß',
  Agrave: 'À',
  Aacute: 'Á',
  Acirc: 'Â',
  Auml: 'Ä',
  Ccedil: 'Ç',
  Egrave: 'È',
  Eacute: 'É',
  Ecirc: 'Ê',
  Euml: 'Ë',
  Icirc: 'Î',
  Iuml: 'Ï',
  Ocirc: 'Ô',
  Ouml: 'Ö',
  OElig: 'Œ',
  Ugrave: 'Ù',
  Ucirc: 'Û',
  Uuml: 'Ü',
  Ntilde: 'Ñ',
};

/** Décode les entités HTML (nommées courantes et numériques) en une seule passe. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return code === 0xa0 ? ' ' : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Échappe un texte pour l'insérer dans du HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Texte brut → HTML : échappement, sauts de ligne en <br>. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Options de l'envoi : celles de la lecture (`HTML_TO_TEXT_OPTIONS`), sauf
 * les images. La lecture les ignore (le modèle n'en a pas l'usage) ; pour un
 * destinataire humain, une image porteuse de sens laisse son texte
 * alternatif « [Logo] » — une image sans alt disparaît, et sa source n'est
 * jamais écrite (une URI data: ferait des centaines de Ko de texte).
 */
const OUTBOUND_OPTIONS: HtmlToTextOptions = {
  ...HTML_TO_TEXT_OPTIONS,
  formatters: {
    altOnly: (elem, _walk, builder) => {
      const alt = (elem as { attribs?: Record<string, string> }).attribs?.alt?.trim();
      if (alt) builder.addInline(`[${alt}]`);
    },
  },
  selectors: [
    ...(HTML_TO_TEXT_OPTIONS.selectors ?? []).filter((s) => s.selector !== 'img'),
    { selector: 'img', format: 'altOnly' },
  ],
};

/**
 * Convertit du HTML en texte lisible par un humain (alternative text/plain
 * d'un envoi HTML, citation ou transfert d'un original HTML).
 *
 * Même moteur que la lecture (`html-to-text`, voir `body-format.ts`) pour
 * qu'un même HTML donne le même texte des deux côtés : liens conservés,
 * listes, <blockquote> préfixés par « > », <pre> préservé, toutes les
 * entités décodées. Seules les images diffèrent (voir OUTBOUND_OPTIONS). Ne
 * lève jamais : en cas d'échec du moteur, repli sur la conversion de lecture.
 */
export function htmlToPlainText(html: string): string {
  try {
    return convert(html, OUTBOUND_OPTIONS)
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return readingHtmlToPlainText(html);
  }
}
