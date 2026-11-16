/**
 * Repères persistants du watcher IDLE (« watermarks »).
 *
 * Le watcher ne signale un message qu'une fois, en retenant le plus grand UID
 * déjà vu par compte et dossier. Tant que ce repère ne vivait qu'en mémoire,
 * chaque connexion repartait de UIDNEXT-1 : tout ce qui arrivait pendant un
 * arrêt du processus — ou pendant une reconnexion — n'était jamais notifié.
 *
 * Repris de codefuturist c5b095b (`src/utils/watcher-state.ts`), adapté :
 * - un FICHIER PAR COMPTE+DOSSIER plutôt qu'un fichier commun verrouillé :
 *   plusieurs processus du serveur tournent souvent côte à côte (un connecteur
 *   par sous-ensemble de comptes via MCP_EMAIL_ACCOUNTS) ; un fichier commun
 *   réécrit en entier par chacun perdait les repères des autres ;
 * - écriture atomique (fichier temporaire + rename), comme la file du
 *   scheduler : un arrêt brutal ne laisse jamais un JSON tronqué ;
 * - le repère mémoire n'est retenu que sous la même UIDVALIDITY.
 *
 * Un UID n'a de sens que sous l'UIDVALIDITY où il a été observé : si le serveur
 * renumérote le dossier, l'ancien UID désigne un message sans rapport. Le
 * couple est donc stocké et comparé ensemble.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WATCHER_STATE_DIR } from '../config/xdg.js';

export interface Watermark {
  /** UIDVALIDITY sous laquelle l'UID ci-dessous a été observé (décimal). */
  uidValidity: string;
  lastSeenUid: number;
  updatedAt: string;
}

/**
 * Nom de fichier sûr sur tous les systèmes (Windows refuse `:`, `/`, `*`…),
 * lisible, et sans collision : la partie lisible est assainie, l'empreinte
 * distingue « a/b » de « a_b ».
 */
export function watermarkFileName(account: string, folder: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  const digest = crypto
    .createHash('sha256')
    .update(`${account}\u0000${folder}`)
    .digest('hex')
    .slice(0, 12);
  return `${safe(account)}__${safe(folder)}__${digest}.json`;
}

function watermarkPath(account: string, folder: string, dir: string): string {
  return path.join(dir, watermarkFileName(account, folder));
}

/** Repère enregistré pour ce compte/dossier, ou `undefined` (jamais vu, illisible). */
export async function readWatermark(
  account: string,
  folder: string,
  dir: string = WATCHER_STATE_DIR,
): Promise<Watermark | undefined> {
  try {
    const raw = await fs.readFile(watermarkPath(account, folder, dir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Watermark>;
    if (
      typeof parsed.uidValidity !== 'string' ||
      typeof parsed.lastSeenUid !== 'number' ||
      !Number.isInteger(parsed.lastSeenUid) ||
      parsed.lastSeenUid < 0
    ) {
      return undefined;
    }
    return {
      uidValidity: parsed.uidValidity,
      lastSeenUid: parsed.lastSeenUid,
      updatedAt: parsed.updatedAt ?? '',
    };
  } catch {
    // Absent ou corrompu : on repart de la base UIDNEXT-1, sans planter.
    return undefined;
  }
}

/** Enregistre atomiquement le plus grand UID signalé pour ce compte/dossier. */
export async function writeWatermark(
  account: string,
  folder: string,
  uidValidity: string,
  lastSeenUid: number,
  dir: string = WATCHER_STATE_DIR,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const target = watermarkPath(account, folder, dir);
  // Nom temporaire unique : deux processus qui écrivent en même temps ne se
  // marchent pas dessus ; le rename final remplace la cible d'un seul coup.
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const body: Watermark = { uidValidity, lastSeenUid, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Pourquoi la reprise part de tel UID — sert au journal. */
export type ResumeReason =
  /** Premier passage sur ce dossier : rien de mieux que UIDNEXT-1. */
  | 'first-watch'
  /** Repère valide (fichier ou mémoire) : on reprend après lui. */
  | 'resumed'
  /** L'UIDVALIDITY a changé : l'ancien repère ne veut plus rien dire. */
  | 'uidvalidity-changed'
  /** Repère au-delà de UIDNEXT (impossible) : écarté plutôt que de devenir muet. */
  | 'ahead-of-uidnext';

/**
 * Décide d'où reprend une session IDLE qui vient de se connecter.
 *
 * `uidNext - 1` (« tout ce qui est déjà là est ancien ») n'est la bonne réponse
 * qu'à défaut de mieux : premier passage, ou dossier renuméroté. Sinon on
 * reprend après le plus grand UID déjà signalé, si bien que le trou laissé par
 * un arrêt ou une reconnexion est rattrapé au lieu d'être sauté.
 */
export function resolveBaselineUid(opts: {
  inMemory: { lastSeenUid: number; uidValidity: string };
  stored: Watermark | undefined;
  uidValidity: string;
  uidNext: number;
}): { uid: number; reason: ResumeReason } {
  const { inMemory, stored, uidValidity, uidNext } = opts;
  const freshBaseline = Math.max(0, uidNext - 1);

  const candidates: number[] = [];
  // Écart avec l'amont : le repère mémoire n'est valable que sous la même
  // UIDVALIDITY — après une renumérotation survenue pendant une reconnexion,
  // il désignerait lui aussi un message sans rapport.
  if (inMemory.uidValidity !== '' && inMemory.uidValidity === uidValidity) {
    candidates.push(inMemory.lastSeenUid);
  }
  if (stored?.uidValidity === uidValidity) candidates.push(stored.lastSeenUid);

  if (candidates.length === 0) {
    const renumbered =
      (stored !== undefined && stored.uidValidity !== uidValidity) ||
      (inMemory.uidValidity !== '' && inMemory.uidValidity !== uidValidity);
    return { uid: freshBaseline, reason: renumbered ? 'uidvalidity-changed' : 'first-watch' };
  }

  const resumeFrom = Math.max(...candidates);
  if (resumeFrom > freshBaseline) return { uid: freshBaseline, reason: 'ahead-of-uidnext' };
  return { uid: resumeFrom, reason: 'resumed' };
}

/**
 * Plafond du rattrapage au redémarrage : au plus ce nombre de messages, les
 * plus récents. Après un long arrêt, notifier des centaines de messages d'un
 * coup noierait l'utilisateur (et les hooks) ; le reste est journalisé.
 */
export const CATCH_UP_LIMIT = 50;

/**
 * Sépare les UID manqués en « à signaler » (les `limit` plus récents) et
 * « sautés ». Les UID en entrée peuvent être dans le désordre.
 */
export function selectCatchUp(
  uids: readonly number[],
  limit: number = CATCH_UP_LIMIT,
): { report: number[]; skipped: number } {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  if (sorted.length <= limit) return { report: sorted, skipped: 0 };
  return { report: sorted.slice(-limit), skipped: sorted.length - limit };
}
