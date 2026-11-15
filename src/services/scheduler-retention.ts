/**
 * Rétention de l'historique des envois programmés (`scheduled/sent/`).
 *
 * Rien ne supprimait jamais rien de ce dossier : chaque e-mail programmé puis
 * envoyé y laissait un fichier JSON, pour toujours. Sans gravité à petit
 * volume, mais sans borne — et `scheduler list --status sent` relit tout.
 *
 * Module séparé de `scheduler.service.ts` à dessein : il ne dépend que du
 * dossier et du champ `status` de chaque entrée, et s'appelle depuis le
 * serveur comme depuis `email-mcp scheduler check`.
 *
 * La rétention est fondée sur l'âge, pas sur un nombre d'entrées : la question
 * qu'on se pose est « jusqu'où puis-je remonter ? », jamais « combien en
 * garder ? ». Elle se règle par `[settings.scheduler] sent_retention_days`
 * (90 par défaut, 0 pour tout garder).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { SCHEDULED_SENT_DIR } from '../config/xdg.js';

/** Environ un trimestre d'historique. */
export const DEFAULT_SENT_RETENTION_DAYS = 90;

/** Intervalle minimal entre deux purges dans un même processus de longue durée. */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;

/**
 * Supprime les entrées envoyées plus anciennes que la fenêtre de rétention.
 *
 * Une entrée n'est supprimée que si SON PROPRE champ `status` vaut `sent`.
 * C'est redondant avec l'invariant « ce dossier ne contient que des envois
 * faits », et c'est voulu : se fier au dossier plutôt qu'au champ, ici, ferait
 * disparaître un e-mail programmé avant même son envoi si l'invariant venait à
 * être rompu. Une entrée illisible est laissée en place plutôt que devinée.
 */
export async function pruneSentHistory(options: {
  retentionDays: number;
  dir?: string;
  now?: number;
}): Promise<{ deleted: number; kept: number }> {
  const { retentionDays, dir = SCHEDULED_SENT_DIR, now = Date.now() } = options;
  if (!(retentionDays > 0)) return { deleted: 0, kept: 0 };

  const cutoff = now - retentionDays * DAY_MS;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    // Pas encore de dossier : rien à purger.
    return { deleted: 0, kept: 0 };
  }

  let deleted = 0;
  let kept = 0;
  // eslint-disable-next-line no-restricted-syntax -- séquentiel : pas de rafale d'E/S
  for (const file of files) {
    // eslint-disable-next-line no-continue
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    try {
      // eslint-disable-next-line no-await-in-loop
      const entry = JSON.parse(await fs.readFile(filePath, 'utf-8')) as {
        status?: string;
        sentAt?: string;
        createdAt?: string;
      };
      // `sentAt` est écrit à l'envoi ; `createdAt` sert de repli pour un
      // historique antérieur à ce champ.
      const stamp = Date.parse(entry.sentAt ?? entry.createdAt ?? '');
      if (entry.status !== 'sent' || !Number.isFinite(stamp) || stamp >= cutoff) {
        kept += 1;
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await fs.unlink(filePath);
      deleted += 1;
    } catch {
      kept += 1;
    }
  }
  return { deleted, kept };
}

/**
 * Purge maintenant puis toutes les {@link PRUNE_INTERVAL_MS} dans un processus
 * de longue durée (le serveur). Le minuteur est `unref` : il ne retient jamais
 * le processus en vie. Renvoie la fonction d'arrêt.
 */
export function startSentHistoryPruning(
  retentionDays: number,
  onResult?: (result: { deleted: number; kept: number }) => void,
): () => void {
  if (!(retentionDays > 0)) return () => {};

  const run = (): void => {
    pruneSentHistory({ retentionDays })
      .then((result) => onResult?.(result))
      // La rétention est du ménage : elle ne doit jamais faire échouer rien d'autre.
      .catch(() => {});
  };

  run();
  const timer = setInterval(run, PRUNE_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
