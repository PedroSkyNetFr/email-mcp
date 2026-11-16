/**
 * Indice « courrier de liste / message automatique » tiré des en-têtes.
 *
 * Sert au tri d'une boîte sans lire les corps : une newsletter ou une
 * notification automatique se repère à des en-têtes normalisés que pose
 * l'EXPÉDITEUR lui-même :
 *
 * | En-tête                        | Norme     | Indice                         |
 * |--------------------------------|-----------|--------------------------------|
 * | `List-Id`, `List-Unsubscribe`  | RFC 2919, RFC 2369 | liste de diffusion    |
 * | `Precedence: list`             | usage     | liste de diffusion             |
 * | `Precedence: bulk` / `junk`    | usage     | envoi en masse / automatique   |
 * | `Auto-Submitted` ≠ `no`        | RFC 3834  | message automatique            |
 * | `X-Auto-Response-Suppress`     | Microsoft | message automatique (Exchange) |
 *
 * C'est un INDICE, jamais une garantie : n'importe quel expéditeur — y compris
 * un hameçonneur — peut poser ou omettre ces en-têtes librement. Leur présence
 * ne prouve pas qu'un message est sans enjeu, leur absence ne prouve pas qu'il
 * est personnel. Le texte rendu au modèle le dit explicitement
 * (codefuturist b23ec35 : ne jamais présenter ce marqueur comme sûr).
 */

/** Champs d'en-tête à demander au serveur pour classer un message. */
export const CLASSIFICATION_HEADERS = [
  'list-id',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'precedence',
  'auto-submitted',
  'x-auto-response-suppress',
] as const;

export interface MailClassification {
  /** `list` : liste de diffusion / newsletter ; `automated` : message automatique. */
  kind: 'list' | 'automated';
  /** En-têtes qui ont déclenché l'indice, sous la forme `Nom: valeur` abrégée. */
  signals: string[];
  /** URI de désabonnement annoncée (https préféré à mailto), si présente. */
  unsubscribe?: string;
  /** Vrai si l'expéditeur annonce le désabonnement en un clic (RFC 8058). */
  oneClickUnsubscribe?: boolean;
}

/** Valeur d'en-tête sans casse sur le nom ; `undefined` si absente ou vide. */
function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key]?.trim();
  return value === '' ? undefined : value;
}

/** Abrège une valeur d'en-tête pour l'affichage d'un indice. */
function short(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** Extrait l'URI de désabonnement : https d'abord, sinon mailto. */
function pickUnsubscribe(value: string): string | undefined {
  const uris = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  return uris.find((u) => /^https:/i.test(u)) ?? uris.find((u) => /^http:/i.test(u)) ?? uris[0];
}

/**
 * Classe un message d'après ses en-têtes. `undefined` quand aucun indice
 * n'est présent — ce qui ne veut PAS dire que le message est personnel.
 */
export function classifyFromHeaders(
  headers: Record<string, string> | undefined,
): MailClassification | undefined {
  if (!headers) return undefined;
  const listSignals: string[] = [];
  const autoSignals: string[] = [];

  const listId = header(headers, 'list-id');
  const listUnsub = header(headers, 'list-unsubscribe');
  const unsubPost = header(headers, 'list-unsubscribe-post');
  const precedence = header(headers, 'precedence')?.toLowerCase();
  const autoSubmitted = header(headers, 'auto-submitted')?.toLowerCase();
  const suppress = header(headers, 'x-auto-response-suppress');

  if (listId) listSignals.push(`List-Id: ${short(listId)}`);
  if (listUnsub) listSignals.push('List-Unsubscribe');
  if (precedence === 'list') listSignals.push('Precedence: list');
  if (precedence === 'bulk' || precedence === 'junk') autoSignals.push(`Precedence: ${precedence}`);
  // RFC 3834 : « no » est la seule valeur qui signifie « écrit par un humain ».
  if (autoSubmitted && autoSubmitted !== 'no') {
    autoSignals.push(`Auto-Submitted: ${short(autoSubmitted)}`);
  }
  if (suppress) autoSignals.push(`X-Auto-Response-Suppress: ${short(suppress)}`);

  if (listSignals.length === 0 && autoSignals.length === 0) return undefined;

  // Une newsletter porte souvent aussi `Precedence: bulk` : la liste l'emporte,
  // c'est l'information la plus utile (on peut s'en désabonner).
  const kind = listSignals.length > 0 ? 'list' : 'automated';
  const unsubscribe = listUnsub ? pickUnsubscribe(listUnsub) : undefined;
  return {
    kind,
    signals: [...listSignals, ...autoSignals],
    ...(unsubscribe ? { unsubscribe } : {}),
    ...(unsubscribe && /one-click/i.test(unsubPost ?? '') ? { oneClickUnsubscribe: true } : {}),
  };
}

/**
 * Ligne d'affichage de l'indice. Le libellé « hint » et la mention « set by
 * the sender » sont voulus : le modèle ne doit pas s'y fier comme à un fait.
 */
export function formatClassification(c: MailClassification, verbose = false): string {
  const label = c.kind === 'list' ? '📰 mailing-list hint' : '🤖 automated-mail hint';
  const base = `${label} (sender-set headers, not verified: ${c.signals.join(', ')})`;
  if (!verbose || !c.unsubscribe) return base;
  return `${base}\n  Unsubscribe: ${c.unsubscribe}${c.oneClickUnsubscribe ? ' (RFC 8058 one-click)' : ''}`;
}
