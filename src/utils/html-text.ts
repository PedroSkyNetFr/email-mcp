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
 * Volontairement local et sans dépendance : `html-to-text` n'est pas une
 * dépendance directe du projet (seulement transitive, via mailparser), et
 * l'import d'une dépendance transitive casse sous pnpm. Le convertisseur de
 * lecture (`stripHtml`, body-format.ts) reste distinct : il vise l'affichage
 * au modèle, celui-ci la lisibilité pour un destinataire humain (liens
 * conservés, citations `>` pour les <blockquote>, listes).
 */

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

// Marqueurs internes (caractères de la zone privée Unicode : absents d'un vrai courrier).
const QUOTE_OPEN = '\uE000';
const QUOTE_CLOSE = '\uE001';
const PRE_MARK = '\uE002';

/** Balises de bloc : un saut de ligne avant et après. */
const BLOCK_TAGS =
  'address|article|aside|center|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|header|main|nav|ol|section|table|tbody|thead|tfoot|tr|ul';

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return undefined;
  return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Convertit du HTML en texte lisible par un humain :
 *   - <br>, paragraphes, titres et blocs deviennent des sauts de ligne ;
 *   - <li> devient « - élément » ;
 *   - un lien garde sa cible : « texte (https://…) » (sauf si le texte EST l'URL) ;
 *   - <img alt="Logo"> devient « [Logo] » ; une image sans alt disparaît ;
 *   - <blockquote> devient des lignes préfixées par « > » (imbrication comprise) ;
 *   - <pre> garde ses espaces et ses retours à la ligne ;
 *   - <style>, <script>, <head> et les commentaires sont supprimés.
 */
export function htmlToPlainText(html: string): string {
  let src = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  // <pre> : mis de côté avant l'écrasement des espaces, restitué à la fin.
  const preBlocks: string[] = [];
  src = src.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_whole, inner: string) => {
    const text = decodeHtmlEntities(stripTags(inner.replace(/<br\s*\/?>/gi, '\n')));
    preBlocks.push(text.replace(/\r\n?/g, '\n'));
    return `\n${PRE_MARK}${preBlocks.length - 1}${PRE_MARK}\n`;
  });

  // Hors <pre>, les blancs HTML (dont les retours à la ligne) valent une espace.
  src = src.replace(/\s+/g, ' ');

  src = src
    // Liens : texte puis cible, quand la cible apporte quelque chose.
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => {
      const text = decodeHtmlEntities(stripTags(inner)).trim();
      const href = attr(`<a ${attrs}>`, 'href')?.trim();
      if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
      const target = href.replace(/^mailto:/i, '');
      if (!text) return target;
      if (
        text === href ||
        text === target ||
        text.replace(/\/$/, '') === target.replace(/\/$/, '')
      ) {
        return text;
      }
      return `${text} (${target})`;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attr(tag, 'alt')?.trim();
      return alt ? `[${alt}]` : '';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n----\n')
    .replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_OPEN}\n`)
    .replace(/<\/blockquote\s*>/gi, `\n${QUOTE_CLOSE}\n`)
    // L'ouverture de <li> suffit à changer de ligne : traiter aussi la
    // fermeture laisserait une ligne vide entre deux éléments.
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(p|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ');

  src = decodeHtmlEntities(stripTags(src));

  // Nettoyage ligne à ligne, puis restitution des <pre>.
  const lines = src
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(
      new RegExp(`${PRE_MARK}(\\d+)${PRE_MARK}`, 'g'),
      (_w, index: string) => preBlocks[Number(index)] ?? '',
    )
    .split('\n');

  // Lignes vides : au plus une à la suite, aucune juste après l'ouverture ou
  // juste avant la fermeture d'une citation (sinon des « > » orphelins).
  const compact: string[] = [];
  lines.forEach((line) => {
    const prev = compact[compact.length - 1];
    if (line === '' && (prev === undefined || prev === '' || prev === QUOTE_OPEN)) return;
    if (line === QUOTE_CLOSE && prev === '') compact.pop();
    compact.push(line);
  });

  // Citations : chaque ligne reçoit autant de « > » que de <blockquote> ouverts.
  let depth = 0;
  const quoted: string[] = [];
  compact.forEach((line) => {
    if (line === QUOTE_OPEN) {
      depth += 1;
      return;
    }
    if (line === QUOTE_CLOSE) {
      depth = Math.max(0, depth - 1);
      quoted.push(''); // une ligne vide sépare la citation de ce qui suit
      return;
    }
    if (depth === 0) {
      quoted.push(line);
      return;
    }
    const prefix = '>'.repeat(depth);
    quoted.push(line ? `${prefix} ${line}` : prefix);
  });

  return quoted
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
