/**
 * Arrêt du serveur stdio.
 *
 * Sous Windows, Claude Desktop ne tue pas le serveur par un signal : il ferme
 * son entrée standard. SIGINT/SIGTERM n'arrivent donc jamais, et le serveur —
 * maintenu en vie par ses connexions IMAP, son pool SMTP et l'intervalle du
 * planificateur — restait orphelin, un processus `node` de plus à chaque
 * redémarrage du client, avec ses sessions IMAP ouvertes.
 *
 * L'arrêt est déclenché par la première de ces causes : fin ou fermeture de
 * stdin, fermeture du transport MCP, SIGINT, SIGTERM. Il est idempotent (les
 * causes arrivent souvent à plusieurs) et borné dans le temps : un LOGOUT IMAP
 * qui ne répond pas ne doit pas empêcher le processus de se terminer.
 */

/** Une étape de l'arrêt : nommée pour le journal, isolée des autres. */
export interface ShutdownStep {
  name: string;
  run: () => unknown;
}

export interface ShutdownOptions {
  /** Délai maximal avant de forcer la sortie. Défaut : 5 s. */
  timeoutMs?: number;
  /** Sortie du processus (injectable pour les tests). Défaut : `process.exit`. */
  exit?: (code: number) => void;
  /** Journal des échecs d'étape (stderr : stdout appartient au protocole MCP). */
  log?: (message: string) => void;
}

export const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Construit la fonction d'arrêt. Le premier appel lance les étapes, dans
 * l'ordre ; chaque appel suivant renvoie la même promesse sans rien relancer.
 * Une étape qui lève ou rejette est journalisée et n'empêche pas les
 * suivantes. Quand toutes ont fini — ou au bout de `timeoutMs` —, le
 * processus sort avec le code 0.
 */
export function createShutdown(
  steps: ShutdownStep[],
  options: ShutdownOptions = {},
): (reason: string) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  // Sortie forcée voulue : c'est précisément ce qui empêche le processus de
  // rester orphelin quand une connexion le maintient en vie.
  // eslint-disable-next-line n/no-process-exit
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log =
    options.log ??
    ((message: string) => {
      process.stderr.write(`[email-mcp] ${message}\n`);
    });

  let pending: Promise<void> | undefined;

  return async (reason: string): Promise<void> => {
    if (pending) return pending;

    pending = (async () => {
      let exited = false;
      const exitOnce = (): void => {
        if (exited) return;
        exited = true;
        exit(0);
      };

      // Filet de sécurité : sortir même si une étape reste bloquée.
      const timer = setTimeout(() => {
        log(`shutdown (${reason}) timed out after ${timeoutMs} ms — exiting anyway`);
        exitOnce();
      }, timeoutMs);
      // Le minuteur ne doit pas, à lui seul, garder le processus en vie.
      timer.unref?.();

      // eslint-disable-next-line no-restricted-syntax -- étapes ordonnées (connexions avant transport)
      for (const step of steps) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await step.run();
        } catch (err) {
          log(
            `shutdown step "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      clearTimeout(timer);
      exitOnce();
    })();

    return pending;
  };
}

/**
 * Branche l'arrêt sur toutes les causes de fin d'un serveur stdio. Renvoie la
 * fonction qui retire ces écouteurs (pour les tests).
 */
export function installShutdownTriggers(
  shutdown: (reason: string) => Promise<unknown>,
  stdin: NodeJS.ReadableStream = process.stdin,
  proc: NodeJS.EventEmitter = process,
): () => void {
  const onStdinEnd = (): void => {
    shutdown('stdin ended').catch(() => {});
  };
  const onStdinClose = (): void => {
    shutdown('stdin closed').catch(() => {});
  };
  const onSigint = (): void => {
    shutdown('SIGINT').catch(() => {});
  };
  const onSigterm = (): void => {
    shutdown('SIGTERM').catch(() => {});
  };

  stdin.on('end', onStdinEnd);
  stdin.on('close', onStdinClose);
  proc.on('SIGINT', onSigint);
  proc.on('SIGTERM', onSigterm);

  return () => {
    stdin.off('end', onStdinEnd);
    stdin.off('close', onStdinClose);
    proc.off('SIGINT', onSigint);
    proc.off('SIGTERM', onSigterm);
  };
}
