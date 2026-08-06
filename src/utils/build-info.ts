/**
 * Identité du code réellement en cours d'exécution.
 *
 * Un serveur MCP en stdio est un processus lancé par le client. Quand le code
 * change, deux choses doivent suivre : la compilation vers `dist/`, puis le
 * redémarrage du client. Tant que l'une des deux manque, le serveur continue de
 * servir l'ancienne version — et rien, côté client, ne le laisse voir.
 *
 * Le symptôme observé est trompeur : un outil ajouté récemment est simplement
 * absent de `tools/list`, ce qui se lit naturellement comme « cette
 * fonctionnalité n'existe pas » alors que le code existe et est correct. Ce
 * module rend le décalage constatable, en exposant depuis où le serveur tourne
 * et de quand date ce fichier.
 *
 * La date vient du `mtime` du module lui-même plutôt que d'une constante
 * injectée à la compilation : aucune étape de build supplémentaire, et la
 * mesure reste juste dans les deux modes d'exécution (fichier compilé sous
 * `dist/`, ou source lu directement par tsx).
 */

import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  /** Version déclarée dans package.json. */
  version: string;
  /**
   * `dist` quand le serveur exécute le code compilé, `src` quand il lit
   * directement les sources (tsx). En mode `dist`, un changement de code exige
   * un `pnpm build` avant d'être visible.
   */
  runningFrom: 'dist' | 'src' | 'unknown';
  /** Date du fichier exécuté, ISO 8601 — soit la date de la compilation. */
  builtAt?: string;
  /** Âge en jours, pour repérer d'un coup d'œil un binaire oublié. */
  ageDays?: number;
  /** Chemin du module, utile quand plusieurs copies du projet coexistent. */
  modulePath: string;
}

/**
 * Décrit le code en cours d'exécution. `now` est injectable pour les tests.
 */
export async function buildInfo(version: string, now: Date = new Date()): Promise<BuildInfo> {
  const modulePath = fileURLToPath(import.meta.url);

  let runningFrom: BuildInfo['runningFrom'] = 'unknown';
  if (modulePath.endsWith('.ts')) runningFrom = 'src';
  else if (modulePath.endsWith('.js')) runningFrom = 'dist';

  const info: BuildInfo = { version, runningFrom, modulePath };

  try {
    const { mtime } = await stat(modulePath);
    info.builtAt = mtime.toISOString();
    info.ageDays = Math.floor((now.getTime() - mtime.getTime()) / 86_400_000);
  } catch {
    // Chemin illisible (bundle, archive) — la version et l'origine suffisent.
  }

  return info;
}
