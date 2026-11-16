/**
 * Traduction des refus IMAP en messages exploitables.
 */

/**
 * Texte du refus serveur porté par une erreur ImapFlow, ou `undefined` quand
 * l'erreur ne vient pas d'une réponse du serveur.
 */
export function serverRefusal(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { responseText, response } = err as { responseText?: unknown; response?: unknown };

  // `responseText` est déjà débarrassé de l'étiquette et du statut.
  if (typeof responseText === 'string' && responseText.trim().length > 0) {
    return responseText.trim();
  }
  if (typeof response === 'string' && response.length > 0) {
    // Retire l'étiquette de commande (« 6 NO », « a7 BAD ») pour lire de la prose.
    const stripped = response.replace(/^\S+\s+(NO|BAD)\s+/i, '').trim();
    return stripped || response;
  }
  return undefined;
}

/**
 * Exécute une commande IMAP en remplaçant l'échec générique d'ImapFlow par ce
 * que le serveur a réellement répondu.
 *
 * Sur une réponse étiquetée NO/BAD, ImapFlow lève `Error('Command failed')` et
 * range la ligne brute du serveur dans `.response` (et le texte seul dans
 * `.responseText`). Un refus que le serveur expliquait précisément —
 * `NO [CANNOT] Mailbox already exists` — arrivait donc à l'utilisateur sous la
 * forme « Command failed », qui ne dit rien de ce qu'il faut corriger.
 *
 * Les erreurs sans réponse serveur (coupure réseau, délai dépassé) sont
 * relancées telles quelles : les réécrire masquerait leur vraie cause.
 *
 * @param operation ce qui était tenté, formulé pour un humain
 * @param run l'appel ImapFlow
 */
export async function imapCommand<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const detail = serverRefusal(err);
    if (detail === undefined) throw err;
    throw new Error(`${operation} rejected by server: ${detail}`, { cause: err });
  }
}
