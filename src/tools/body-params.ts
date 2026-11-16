/**
 * Paramètres de corps partagés par `get_email`, `get_emails` et `get_thread`.
 *
 * Un seul endroit pour la liste des formats, leur description et la règle du
 * plafond par défaut : trois copies avaient déjà divergé (format "html"
 * présent sur un outil seulement, défauts différents d'un outil à l'autre).
 */

import type { BodyFormat } from '@pedroskynet/email-core/utils/body-format.js';
import { z } from 'zod';
import { numeric } from './numeric-param.js';

/** Formats de corps proposés par les trois outils de lecture. */
export const BODY_FORMATS = ['text', 'stripped', 'full', 'html'] as const;

/** Description commune du paramètre `format`. */
export const BODY_FORMAT_DESCRIPTION =
  'Body format: text (default) = readable plain text — the text part, or the HTML part converted ' +
  '(links kept as "label [url]", tables as aligned columns, entities decoded), also used when the ' +
  'text part is only a stub such as "view this email in your browser"; ' +
  'stripped = text without quoted replies or signatures; ' +
  'full = the decoded body part as-is (text part, else raw HTML; on extraction failure a visible ' +
  'marker + capped raw RFC822 source); ' +
  'html = the raw HTML part unmodified (else the text part) — use when the original HTML must be stored.';

/** Schéma du paramètre `format`, défaut `text`. */
export function bodyFormatParam(): z.ZodDefault<
  z.ZodEnum<{ [K in (typeof BODY_FORMATS)[number]]: K }>
> {
  return z.enum(BODY_FORMATS).default('text').describe(BODY_FORMAT_DESCRIPTION);
}

/**
 * Schéma du paramètre `maxLength`. Pas de défaut Zod : le défaut dépend du
 * format (voir {@link resolveMaxLength}), et un défaut fixe dans le schéma
 * empêcherait de distinguer « non précisé » de « précisé ».
 */
export function maxLengthParam(
  defaultCap: number,
  scope: 'body' | 'each body',
): z.ZodPreprocess<z.ZodOptional<z.ZodNumber>> {
  return numeric(z.number().int().min(0).optional()).describe(
    `Truncate ${scope} at this many characters (default ${defaultCap} for text/stripped/full; ` +
      'unlimited for html; 0 = unlimited). A truncated body ends with an explicit ✂️ marker ' +
      'saying how many characters remain and how to read the rest.',
  );
}

/**
 * Plafond effectif : la valeur explicite de l'appelant l'emporte ; sinon
 * `format=html` n'est pas plafonné (on le demande pour CONSERVER le HTML
 * d'origine, et un HTML coupé est inutilisable) ; les autres formats prennent
 * le plafond par défaut de l'outil.
 */
export function resolveMaxLength(
  format: BodyFormat,
  maxLength: number | undefined,
  defaultCap: number,
): number {
  if (maxLength !== undefined) return maxLength;
  return format === 'html' ? 0 : defaultCap;
}
