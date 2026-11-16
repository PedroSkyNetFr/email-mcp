/**
 * Journalisation structurée du serveur, sur stderr.
 *
 * Le canal MCP `notifications/message` et la capacité `logging` sont
 * dépréciés depuis la révision 2026-07-28 du protocole (SEP-2577). Pour un
 * serveur stdio, la sortie sûre est stderr : elle ne touche jamais le flux
 * JSON-RPC de stdout, n'a pas besoin d'attendre la poignée de main
 * `initialize` / `initialized`, et les clients MCP (Claude Desktop, Cursor…)
 * la recueillent dans les journaux du serveur.
 *
 * Format : une ligne par message —
 *   2026-11-15T10:00:00.000Z INFO [server] Email MCP server started
 *
 * `mcpLog()` garde sa signature `Promise<void>` d'origine : les appels
 * existants (`await mcpLog(…)` et `mcpLog(…).catch(…)`) restent inchangés.
 * Rien n'est jamais écrit sur stdout.
 */

export type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

/** Rend une donnée de journal en texte, sans jamais lever. */
function formatData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Error) return data.message;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    // Structure circulaire ou non sérialisable.
    return String(data);
  }
}

/**
 * Écrit une ligne de journal horodatée sur stderr.
 *
 * Utilisable n'importe où, à tout moment. Les retours à la ligne du message
 * sont échappés pour qu'un message reste une ligne. Un échec d'écriture
 * (stderr fermé) est avalé : la journalisation ne doit jamais casser un outil.
 */
/**
 * Where log lines go when the host routes them itself (ONYX sends them to its
 * NestJS logger). Unset: stderr, as the MCP server needs.
 */
export type LogSink = (level: LogLevel, logger: string, message: string) => void;

let sink: LogSink | undefined;

/** Routes the package's log lines to `next`; `undefined` restores stderr. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

export async function mcpLog(level: LogLevel, logger: string, data: unknown): Promise<void> {
  const message = formatData(data).replace(/\r?\n/g, '\\n');
  if (sink) {
    try {
      sink(level, logger, message);
    } catch {
      // A failing host logger must not break a mail operation either.
    }
    return;
  }
  try {
    process.stderr.write(
      `${new Date().toISOString()} ${level.toUpperCase()} [${logger}] ${message}\n`,
    );
  } catch {
    // stderr indisponible : on renonce à ce message.
  }
}
