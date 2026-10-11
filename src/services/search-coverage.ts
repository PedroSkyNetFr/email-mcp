/**
 * Couverture d'une recherche filtrée côté client — commune aux backends IMAP
 * et Microsoft Graph.
 *
 * Certains filtres ne peuvent pas être confiés au serveur : présence ou nature
 * des pièces jointes sur IMAP (aucune clé SEARCH standard), et les filtres
 * littéraux `*_contains` sur les deux backends (l'index du serveur fait
 * correspondre des jetons, pas des sous-chaînes). Le serveur renvoie donc un
 * jeu de candidats que l'on examine ici, du plus récent au plus ancien.
 *
 * Cet examen est borné — en temps (le client MCP coupe un appel vers 60 s) et
 * en nombre de messages. Quand une borne l'interrompt, la réponse doit le dire
 * de façon exploitable : combien de messages ont été examinés sur combien, la
 * date du plus ancien examiné, et la valeur de `before` qui permet de
 * reprendre là où l'on s'est arrêté. Relancer avec ce `before` parcourt la
 * tranche suivante ; enchaîner les appels couvre toute la boîte.
 *
 * Le module ne fait aucune entrée-sortie : chaque backend parcourt ses
 * messages à sa façon et ne délègue ici que le bilan et sa formulation, pour
 * qu'un même arrêt se lise de la même manière sur IMAP et sur Graph.
 */

import type { CoverageStop, SearchCoverage } from '../types/index.js';
import { normalizeDate } from '../utils/date.js';

export type { CoverageStop, SearchCoverage } from '../types/index.js';

/**
 * Budget de temps d'un parcours côté client, mesuré depuis l'ENTRÉE dans la
 * méthode de recherche (SEARCH serveur compris).
 *
 * Le client MCP abandonne un appel vers 60 s. Il faut garder de quoi finir le
 * lot en cours (jusqu'à ~5 s pour 200 BODYSTRUCTURE sur un cache Dovecot
 * froid), lire la page servie et répondre : 45 s laisse environ 15 s de marge
 * tout en couvrant le plus possible en un seul appel.
 */
export const SEARCH_SCAN_BUDGET_MS = 45_000;

/**
 * Nombre maximal de messages examinés côté client en un appel. Au-delà, le
 * parcours s'arrête comme pour le budget de temps, avec la même consigne de
 * reprise : la boîte entière reste accessible, par tranches.
 */
export const MAX_SCANNED_MESSAGES = 5000;

/**
 * Granularité de `before` sur le backend.
 *
 *  - `day` : SEARCH IMAP `BEFORE` ne compare que la DATE (RFC 3501, heure et
 *    fuseau ignorés), et le `$search` KQL de Graph est lui aussi au jour.
 *  - `instant` : `$filter receivedDateTime lt …` de Graph compare l'instant
 *    exact (à la seconde).
 */
export type BeforeGranularity = 'day' | 'instant';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Plus grand décalage de fuseau existant (UTC+14) — voir continuationBefore. */
const MAX_TZ_OFFSET_MS = 14 * 60 * 60 * 1000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Valeur de `before` qui reprend un parcours arrêté sur `oldest`.
 *
 * Les messages non examinés sont tous reçus au plus tard à `oldest` (le
 * parcours va du plus récent au plus ancien). Il faut donc une borne STRICTE
 * qui les inclue tous — mieux vaut revoir quelques messages déjà examinés que
 * d'en sauter un.
 *
 *  - `instant` : `oldest` + 1 s. Seuls les messages reçus dans la même seconde
 *    que la borne peuvent réapparaître.
 *  - `day` : le serveur compare la date du message dans SON fuseau. Un
 *    message reçu le 14 à 23 h 30 UTC est daté du 15 sur un serveur à UTC+2 ;
 *    `before: 15` l'exclurait. On prend donc le jour UTC de `oldest` + 14 h
 *    (le pire fuseau), puis le lendemain. Le recouvrement avec l'appel
 *    précédent ne dépasse pas environ un jour et demi.
 */
export function continuationBefore(oldest: Date, granularity: BeforeGranularity): string {
  if (granularity === 'instant') {
    return new Date(oldest.getTime() + 1000).toISOString();
  }
  const shifted = new Date(oldest.getTime() + MAX_TZ_OFFSET_MS);
  const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return isoDay(new Date(dayStart + DAY_MS));
}

function stopLabel(stoppedBy: CoverageStop): string {
  switch (stoppedBy) {
    case 'time_budget':
      return `time budget of ${SEARCH_SCAN_BUDGET_MS / 1000} s reached`;
    case 'message_cap':
      return `scan cap of ${MAX_SCANNED_MESSAGES} messages per call reached`;
    default:
      return 'the server returned no further search results';
  }
}

/**
 * Construit le bilan d'un parcours interrompu.
 *
 * `currentBefore` est le `before` de l'appel en cours : si la reprise
 * calculée ne le précède pas, relancer avec elle renverrait exactement la même
 * tranche — une boucle sans fin. On le dit, et on ne propose pas de reprise.
 */
export function buildCoverage(input: {
  stoppedBy: CoverageStop;
  examined: number;
  candidates: number;
  candidatesApprox?: boolean;
  oldestExamined?: Date;
  granularity: BeforeGranularity;
  currentBefore?: string;
}): SearchCoverage {
  const { stoppedBy, examined, candidates, oldestExamined } = input;
  const validOldest =
    oldestExamined && !Number.isNaN(oldestExamined.getTime()) ? oldestExamined : undefined;

  let continueBefore: string | undefined;
  let stuck = false;
  if (validOldest) {
    continueBefore = continuationBefore(validOldest, input.granularity);
    if (input.currentBefore) {
      const current = normalizeDate(input.currentBefore).getTime();
      if (normalizeDate(continueBefore).getTime() >= current) {
        continueBefore = undefined;
        stuck = true;
      }
    }
  }

  const ofCandidates = `${input.candidatesApprox ? 'at least ' : ''}${candidates}`;
  const parts = [
    `Partial scan: examined the ${examined} most recent of ${ofCandidates} candidate messages ` +
      `(${stopLabel(stoppedBy)}).`,
  ];
  if (validOldest) {
    parts.push(`Oldest message examined: ${validOldest.toISOString()}.`);
  }
  parts.push('Results and total cover only the examined messages.');
  if (continueBefore) {
    parts.push(
      `To continue, re-run the same call with before: "${continueBefore}" ` +
        '(consecutive calls may overlap slightly, so a message can appear twice).',
    );
  } else if (stuck) {
    parts.push(
      'Cannot advance by date: the messages just before the current `before` alone exceed one ' +
        'call — add a server-side filter (from, subject, since, …) to narrow the set.',
    );
  } else {
    parts.push('Add since/before or another server-side filter to narrow the set.');
  }

  return {
    stoppedBy,
    examined,
    candidates,
    ...(input.candidatesApprox ? { candidatesApprox: true } : {}),
    ...(validOldest ? { oldestExamined: validOldest.toISOString() } : {}),
    ...(continueBefore ? { continueBefore } : {}),
    hint: parts.join(' '),
  };
}
