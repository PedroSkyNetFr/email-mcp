/**
 * Envoi dont l'issue est INCONNUE : la requête `/send` a échoué sur une
 * coupure réseau, un 5xx ou un 429 — le serveur a pu envoyer le message avant
 * que la réponse se perde. Renvoyer à l'aveugle risquerait un doublon chez le
 * destinataire : l'appelant (et le planificateur) doivent vérifier Éléments
 * envoyés avant de recommencer.
 */
export default class UncertainSendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UncertainSendError';
  }
}
