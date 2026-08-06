/**
 * Descriptions et paramètres partagés par les outils de recherche et d'export.
 *
 * Les schémas Zod de `search_emails`, `export_search`, `save_emails_from_search`
 * et `save_all_attachments_from_search` répètent la même liste de filtres. Les
 * textes qui comptent — ceux qui disent au modèle appelant ce que le filtre fait
 * VRAIMENT — sont regroupés ici pour qu'une correction ne s'applique pas à un
 * outil sur quatre.
 */

import { z } from 'zod';

/**
 * Ce que fait réellement un filtre d'adresse ou de sujet.
 *
 * Ces filtres sont transmis au serveur tels quels ; c'est donc son index qui
 * décide de ce qui correspond. La RFC 3501 définit `SEARCH FROM` comme une
 * recherche de sous-chaîne, mais un serveur doté d'un index plein texte
 * (Dovecot FTS, tel que déployé chez OVH) fait correspondre des JETONS
 * indexés. Constaté en production : `enviropro-salon.fr` ne retrouve pas
 * `contact@news.enviropro-salon.fr`, et `salon.fr` ne retrouve rien — alors que
 * le plus court `enviropro` retrouve les deux.
 *
 * Un appelant qui croit à `contains` obtient donc un sous-ensemble, sans rien
 * qui le signale. D'où cet avertissement dans la description de l'outil, et les
 * variantes `*_contains` ci-dessous pour qui veut un résultat garanti.
 */
export const SERVER_MATCH_CAVEAT =
  'Matching is performed BY THE MAIL SERVER, not here: most servers match indexed tokens, ' +
  'not substrings, so a parent domain does NOT find its subdomains ' +
  '("example.com" misses "news.example.com") and a mid-token fragment finds nothing. ' +
  'Use the *_contains variant when you need a guaranteed literal match.';

export const FROM_DESCRIPTION = `Filter by sender (server-side). ${SERVER_MATCH_CAVEAT}`;
export const TO_DESCRIPTION = `Filter by recipient (server-side). ${SERVER_MATCH_CAVEAT}`;
export const SUBJECT_DESCRIPTION = `Filter by subject (server-side). ${SERVER_MATCH_CAVEAT}`;

const CONTAINS_NOTE =
  'Applied locally on the decoded header, so the result does not depend on the server index. ' +
  'It does not narrow the server-side query: combine it with since/before or a coarse filter ' +
  'on a large mailbox, or the whole folder is scanned.';

/**
 * Les trois filtres littéraux, à étaler dans le schéma d'un outil de recherche
 * ou d'export.
 */
export const literalFilterParams = {
  from_contains: z
    .string()
    .optional()
    .describe(
      `Case-insensitive SUBSTRING match on the From header (name + address). ${CONTAINS_NOTE}`,
    ),
  to_contains: z
    .string()
    .optional()
    .describe(`Case-insensitive SUBSTRING match on any To recipient. ${CONTAINS_NOTE}`),
  subject_contains: z
    .string()
    .optional()
    .describe(`Case-insensitive SUBSTRING match on the decoded subject. ${CONTAINS_NOTE}`),
};

/** Traduit les paramètres snake_case de l'outil vers les options du service. */
export function literalFilterOptions(params: {
  from_contains?: string;
  to_contains?: string;
  subject_contains?: string;
}): { fromContains?: string; toContains?: string; subjectContains?: string } {
  return {
    fromContains: params.from_contains,
    toContains: params.to_contains,
    subjectContains: params.subject_contains,
  };
}
