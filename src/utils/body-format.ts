/**
 * Shared email-body presentation helpers.
 *
 * Single source of truth for `applyBodyFormat` + the HTML/quote strippers.
 * Previously these were copy-pasted into `emails.tool.ts` (used by
 * `get_email` AND `get_emails`) and `thread.tool.ts` — three call sites, two
 * divergent copies, one shared bug class (the empty-string `??` defect that
 * made multipart bodies render blank). Consolidating here kills the
 * duplicate-bug class: fix once, every tool benefits.
 *
 * Decision flow (applyBodyFormat):
 *
 *   bodyText / bodyHtml (trimmed-non-empty?)
 *        │
 *        ├─ have text or html ──► choix de la source (pickBodySource) :
 *        │                        texte « bouchon » ou nettement plus pauvre
 *        │                        que le HTML → le HTML l'emporte
 *        │                        format=full     → source brute (texte ou HTML)
 *        │                        format=html     → html ?? text (raw HTML part)
 *        │                        format=text     → texte, ou HTML converti
 *        │                                          (htmlToPlainText)
 *        │                        format=stripped → stripReplyChain(above)
 *        │
 *        └─ nothing decodable ──► ALWAYS a visible "⚠️ body extraction
 *                                 failed: <reason>" marker (never silent)
 *                                   • format=full → marker + capped raw
 *                                     source (the operator escape hatch)
 *                                   • text/stripped/html → marker only
 *        │
 *        ▼
 *   optional caller offset + maxLength window (ergonomic shaping, applied
 *   last, with an explicit continuation hint)
 *
 * Empty/whitespace-only `bodyText`/`bodyHtml` count as "missing" (trim
 * check, NOT `??`) — `??` only falls through on null/undefined, so a
 * stage that produced `""` used to win over a real HTML alternative.
 */

import type { HtmlToTextOptions } from 'html-to-text';
import { convert } from 'html-to-text';

export type BodyFormat = 'full' | 'text' | 'stripped' | 'html';

/**
 * Plafond par défaut du corps pour la lecture d'UN message (`get_email`).
 * 10 000 caractères couvrent un courriel ordinaire en entier ; au-delà, ce sont
 * des newsletters, des fils cités ou des journaux collés, qui coûtent cher en
 * contexte au modèle pour un intérêt souvent faible.
 */
export const DEFAULT_SINGLE_BODY_MAX = 10_000;

/**
 * Plafond par défaut PAR MESSAGE pour les lectures multiples (`get_emails`,
 * `get_thread`) : jusqu'à 20 messages par appel, il faut un plafond plus serré
 * pour que la réponse reste lisible.
 */
export const DEFAULT_MULTI_BODY_MAX = 5_000;

/**
 * Hard safety cap (bytes/chars) on the raw RFC822 fallback. A multipart
 * message can carry megabytes of base64 attachment in its source; without
 * this cap `format=full` on an undecodable message would dump the whole
 * blob into the tool response. Applied BEFORE the caller's optional
 * `maxLength` because `maxLength` is ergonomic output shaping, not a
 * safety boundary (a caller can pass a huge maxLength).
 */
export const RAW_CAP = 256 * 1024;

/**
 * Réglages de `html-to-text`, choisis pour un lecteur qui est un modèle :
 * - pas de retour à la ligne forcé (le texte garde ses paragraphes, sans
 *   césures arbitraires à 80 colonnes) ;
 * - liens conservés sous la forme `libellé [url]`, l'URL masquée quand elle
 *   répète le libellé ;
 * - images ignorées (pixels de suivi, logos : aucun contenu lisible) ;
 * - tableaux rendus en colonnes alignées (`dataTable`) au lieu de cellules
 *   collées bout à bout ;
 * - titres et en-têtes de tableau laissés dans leur casse d'origine.
 */
const HTML_TO_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true, linkBrackets: ['[', ']'] } },
    { selector: 'img', format: 'skip' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
    {
      selector: 'table',
      format: 'dataTable',
      options: { uppercaseHeaderCells: false, maxColumnWidth: 60 },
    },
    { selector: 'ul', options: { itemPrefix: ' • ' } },
  ],
};

/** Repli minimal, utilisé seulement si `html-to-text` lève une exception. */
function crudeStrip(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convertit un corps HTML en texte lisible.
 *
 * Fonction réutilisable (lecture, et lot envoi pour générer l'alternative
 * texte d'un message HTML) : liens conservés, tableaux en colonnes, toutes
 * les entités HTML décodées (nommées, décimales, hexadécimales — une entité
 * hors plage Unicode devient U+FFFD au lieu de lever une exception), blocs
 * séparés par une ligne vide. Ne lève jamais : un HTML pathologique retombe
 * sur un nettoyage grossier plutôt que de faire échouer la lecture.
 */
export function htmlToPlainText(html: string): string {
  try {
    return convert(html, HTML_TO_TEXT_OPTIONS)
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return crudeStrip(html);
  }
}

/**
 * Ancien nom, conservé pour les appelants existants : délègue désormais à
 * {@link htmlToPlainText} (l'implémentation à 6 regex et 5 entités ne
 * décodait ni `&eacute;` ni `&#233;` et collait les cellules de tableau).
 */
export function stripHtml(html: string): string {
  return htmlToPlainText(html);
}

/** Removes quoted reply chains and signatures from plain text. */
export function stripReplyChain(text: string): string {
  const lines = text.split('\n');
  const stopIdx = lines.findIndex((l) => /^--\s*$/.test(l) || /^_{3,}\s*$/.test(l));
  const relevant = stopIdx === -1 ? lines : lines.slice(0, stopIdx);
  return relevant
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Treats whitespace-only / non-string as "missing". Exported so
 * `messageToEmail` normalizes parsed `text`/`html` with the EXACT same
 * definition of "empty" the formatter uses — otherwise a value one side
 * considers present and the other considers blank reopens the fallback bug.
 */
export function nonEmpty(s: string | undefined | null): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.trim().length > 0 ? s : undefined;
}

// ---------------------------------------------------------------------------
// Partie texte « bouchon » d'un multipart/alternative
// ---------------------------------------------------------------------------

/**
 * Heuristique du texte « bouchon » (issue codefuturist #66).
 *
 * Beaucoup d'expéditeurs en masse livrent un multipart/alternative dont la
 * partie text/plain n'est qu'un renvoi (« View this email in your browser »,
 * « Votre client ne lit pas le HTML ») alors que le vrai contenu est dans la
 * partie HTML. Préférer aveuglément le texte rendait alors un corps vide de
 * sens.
 *
 * On compare des MOTS (suites d'au moins deux lettres ou chiffres), URL
 * retirées : la conversion du HTML ajoute les adresses des liens entre
 * crochets, et une partie texte de newsletter en contient aussi — compter des
 * caractères ferait gagner la version la plus chargée en liens, pas la plus
 * riche en contenu. Le HTML l'emporte quand les DEUX conditions tiennent :
 *
 * - il porte au moins `STUB_RATIO` fois plus de mots que le texte ;
 * - et au moins `STUB_MIN_EXTRA_WORDS` mots de plus (un message de trois mots
 *   contre neuf n'est pas un bouchon, juste un message court).
 *
 * Un ratio de 3 laisse passer les écarts ordinaires entre les deux
 * alternatives (pied de page, mentions légales, aperçu caché ajoutés au seul
 * HTML) tout en attrapant le bouchon d'une ligne et le texte tronqué.
 */
export const STUB_RATIO = 3;
export const STUB_MIN_EXTRA_WORDS = 25;

/** Nombre de mots d'un texte, URL et adresses mailto exclues. */
export function countWords(text: string): number {
  const withoutUrls = text.replace(/\b(?:https?:\/\/|mailto:|www\.)\S+/gi, ' ');
  return withoutUrls.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0;
}

/**
 * Vrai quand la partie texte doit céder la place au HTML converti (voir
 * {@link STUB_RATIO}). `htmlAsText` est le HTML déjà converti, pour ne pas
 * convertir deux fois.
 */
export function isStubText(text: string, htmlAsText: string): boolean {
  const textWords = countWords(text);
  const htmlWords = countWords(htmlAsText);
  return htmlWords >= STUB_RATIO * textWords && htmlWords - textWords >= STUB_MIN_EXTRA_WORDS;
}

/**
 * The subset of an `Email` that drives body presentation. Passing the
 * object (not 4 positional args) keeps the three call sites from drifting.
 */
export interface BodySource {
  bodyText?: string;
  bodyHtml?: string;
  /**
   * Capped raw RFC822 source. Set by `messageToEmail` ONLY when no
   * decodable text/html part was recovered — the `format=full` escape
   * hatch. Undefined on the normal path so threads stay memory-bounded.
   */
  raw?: string;
  /**
   * One-line reason body extraction yielded nothing (oversized source,
   * MIME parse error, or no decodable part). Drives the visible marker so
   * a failure is never presented as a clean empty body.
   */
  bodyWarning?: string;
}

/**
 * Texte lisible d'un message, le meilleur des deux alternatives : la partie
 * texte, sauf si elle est un bouchon face au HTML (voir {@link isStubText}),
 * auquel cas le HTML converti. `undefined` quand le message n'a ni l'une ni
 * l'autre. Exporté pour les autres lecteurs de corps (analyse calendrier,
 * extraits de crochets) qui lisent encore `bodyText ?? bodyHtml` en brut.
 */
export function bestPlainText(src: Pick<BodySource, 'bodyText' | 'bodyHtml'>): string | undefined {
  const text = nonEmpty(src.bodyText);
  const html = nonEmpty(src.bodyHtml);
  if (!html) return text;
  const htmlAsText = htmlToPlainText(html);
  if (!text) return htmlAsText;
  return isStubText(text, htmlAsText) ? htmlAsText : text;
}

function capRaw(raw: string): string {
  if (raw.length <= RAW_CAP) return raw;
  return `${raw.slice(0, RAW_CAP)}\n\n… (raw source truncated at ${RAW_CAP} bytes — extraction failed; this is the undecoded RFC822 source)`;
}

/** Réglage de la fenêtre de lecture appliquée au corps formaté. */
export interface BodyWindow {
  /** Nombre maximal de caractères rendus ; 0 ou absent = illimité. */
  maxLength?: number;
  /** Premier caractère rendu (défaut 0) — pour lire la suite d'un corps tronqué. */
  offset?: number;
  /**
   * Phrase qui dit comment lire la suite, selon l'outil appelant (par ex.
   * « call get_email again with offset=10000 »). Reçoit le décalage du premier
   * caractère non rendu. Par défaut : conseil générique sur `maxLength`.
   */
  continuation?: (nextOffset: number) => string;
}

function defaultContinuation(): string {
  return 'increase maxLength (0 = unlimited) to read the full body';
}

/**
 * Applique la fenêtre `offset` / `maxLength` et annonce explicitement toute
 * coupe : combien de caractères sont montrés, sur combien, et comment obtenir
 * la suite. Une coupe silencieuse ferait prendre un extrait pour le message.
 */
function applyWindow(body: string, window: BodyWindow): string {
  const total = body.length;
  const offset = Math.max(0, window.offset ?? 0);
  const maxLength = window.maxLength ?? 0;
  if (offset === 0 && (maxLength <= 0 || total <= maxLength)) return body;

  if (offset >= total) {
    return `… (offset ${offset} is past the end of the body — it has ${total} characters)`;
  }
  const end = maxLength > 0 ? Math.min(total, offset + maxLength) : total;
  const prefix = offset > 0 ? `… (characters ${offset}–${end} of ${total})\n\n` : '';
  const slice = body.slice(offset, end);
  if (end >= total) return `${prefix}${slice}`;
  const remaining = total - end;
  const hint = (window.continuation ?? defaultContinuation)(end);
  return `${prefix}${slice}\n\n✂️ … truncated: ${remaining} more characters (showing ${offset}–${end} of ${total}) — ${hint}`;
}

/**
 * Applies the requested body format and optional reading window.
 *
 * - full:     full decoded body (text preferred, else HTML — the HTML part
 *             also wins over a stub text part). When nothing is decodable, a
 *             visible failure marker followed by the capped raw RFC822 source
 *             — never a silent empty string.
 * - text:     readable plain text (text part, or HTML converted by
 *             {@link htmlToPlainText} when there is no text part or it is a stub).
 * - stripped: like text, but also removes quoted reply chains/signatures.
 * - html:     the raw HTML part, unmodified (else the text part). For callers
 *             that must store the original HTML.
 *
 * `window` accepte aussi un nombre (ancien paramètre `maxLength`).
 */
export function applyBodyFormat(
  src: BodySource,
  format: BodyFormat,
  window: number | BodyWindow = {},
): string {
  const text = nonEmpty(src.bodyText);
  const html = nonEmpty(src.bodyHtml);

  let body: string;
  if (text || html) {
    if (format === 'html') {
      body = html ?? text ?? '';
    } else {
      // Le HTML converti n'est calculé que s'il existe ET qu'il peut servir.
      const htmlAsText = html ? htmlToPlainText(html) : undefined;
      const htmlWins = !text || (htmlAsText !== undefined && isStubText(text, htmlAsText));
      if (format === 'full') {
        body = htmlWins ? (html ?? '') : (text ?? '');
      } else {
        const base = htmlWins ? (htmlAsText ?? '') : (text ?? '');
        body = format === 'stripped' ? stripReplyChain(base) : base;
      }
    }
  } else {
    // Nothing decodable. Never silent: always emit a visible marker.
    const reason = nonEmpty(src.bodyWarning) ?? 'no decodable text or HTML part';
    const marker = `⚠️ body extraction failed: ${reason}`;
    const raw = nonEmpty(src.raw);
    body = format === 'full' && raw ? `${marker}\n\n--- Raw source ---\n${capRaw(raw)}` : marker;
  }

  return applyWindow(body, typeof window === 'number' ? { maxLength: window } : window);
}
