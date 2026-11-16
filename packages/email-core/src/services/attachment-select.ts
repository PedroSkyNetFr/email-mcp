/**
 * Désignation et présentation des pièces jointes, communes aux backends IMAP
 * et Graph.
 *
 * Une pièce jointe se désigne par son `partId` — numéro de partie MIME issu de
 * BODYSTRUCTURE sur IMAP (« 2 », « 1.2 »), identifiant de pièce jointe sur
 * Graph — ou, pour compatibilité, par son nom de fichier. Le nom n'est pas un
 * identifiant : les signatures Outlook embarquent couramment deux
 * `image001.png`. Un nom qui désigne plusieurs pièces est donc REFUSÉ avec la
 * liste des candidates, au lieu de servir la première en silence (repris de
 * l'idée de codefuturist 1e038c1 / 99435d0, l'erreur d'ambiguïté en plus).
 */

import type { AttachmentMeta } from '../types/index.js';

/** Sélecteur de pièce jointe : `partId` prioritaire, nom de fichier en repli. */
export interface AttachmentSelector {
  partId?: string;
  filename?: string;
}

/** Forme acceptée par les services : un nom seul (historique) ou un sélecteur. */
export type AttachmentRef = string | AttachmentSelector;

/** Normalise la désignation : une chaîne nue est un nom de fichier. */
export function normalizeSelector(ref: AttachmentRef): AttachmentSelector {
  return typeof ref === 'string' ? { filename: ref } : ref;
}

/** Libellé court d'une désignation, pour les messages d'erreur. */
export function selectorLabel(ref: AttachmentRef): string {
  const sel = normalizeSelector(ref);
  if (sel.partId !== undefined) return `partId ${sel.partId}`;
  return `"${sel.filename ?? ''}"`;
}

/** Taille lisible (même rendu que l'ancien affichage de get_email). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Une pièce, rendue pour une réponse d'outil : nom, type, taille, partId, et
 * le marquage inline avec son cid (ce que vise un `<img src="cid:…">`).
 */
export function describeAttachment(a: AttachmentMeta): string {
  const facts = [a.mimeType, formatSize(a.size)];
  if (a.partId !== undefined) facts.push(`partId ${a.partId}`);
  if (a.inline) facts.push(a.contentId ? `inline cid:${a.contentId}` : 'inline');
  return `${a.filename} (${facts.join(', ')})`;
}

export function describeAttachments(attachments: AttachmentMeta[]): string {
  return attachments.map(describeAttachment).join(', ');
}

/**
 * Pièces jointes « réelles » : sans les images inline à Content-ID (logos de
 * signature, images du corps HTML). Ce sont elles que comptent
 * `hasAttachments`, les filtres de recherche (`has_attachment`,
 * `attachment_filename`, `attachment_mimetype`), les sauvegardes en lot et la
 * reprise dans un transfert : les inline n'y figuraient pas avant d'être
 * listées, et leurs résultats ne doivent pas changer.
 */
export function realAttachments<T extends Pick<AttachmentMeta, 'inline'>>(list: T[]): T[] {
  return list.filter((a) => !a.inline);
}

/**
 * Choisit UNE pièce dans `list`.
 *
 * - `partId` donné : correspondance exacte, sinon erreur listant les partId ;
 * - sinon le nom : aucune correspondance → erreur listant les pièces ;
 *   plusieurs → erreur d'ambiguïté listant chaque candidate (nom, taille,
 *   type, partId) pour que l'appelant relance avec le bon `partId`.
 */
export function selectAttachment<T extends AttachmentMeta>(list: T[], ref: AttachmentRef): T {
  const sel = normalizeSelector(ref);
  const available = (): string => (list.length > 0 ? describeAttachments(list) : 'none');

  if (sel.partId !== undefined && sel.partId !== '') {
    const byPart = list.find((a) => a.partId === sel.partId);
    if (!byPart) {
      throw new Error(`No attachment with partId "${sel.partId}". Available: ${available()}`);
    }
    return byPart;
  }

  if (sel.filename === undefined || sel.filename === '') {
    throw new Error('Provide a partId or a filename (see get_email attachment metadata)');
  }

  const matches = list.filter((a) => a.filename === sel.filename);
  if (matches.length === 0) {
    throw new Error(`Attachment "${sel.filename}" not found. Available: ${available()}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous attachment name "${sel.filename}": ${matches.length} attachments carry it — ` +
        `${matches.map((m) => describeAttachment(m)).join('; ')}. ` +
        'Nothing was downloaded: call again with the partId of the one you want.',
    );
  }
  return matches[0];
}

/**
 * Rend les noms de fichiers uniques dans un lot à envoyer ou à enregistrer :
 * le deuxième `image001.png` devient `image001 (2).png`, le troisième
 * `image001 (3).png`. Le destinataire (ou le disque) distingue ainsi des
 * pièces que l'original ne distinguait que par leur numéro de partie.
 *
 * Comparaison insensible à la casse (Windows et la plupart des clients mail
 * confondent `A.PNG` et `a.png`). Les pièces inline à cid gardent leur nom :
 * elles sont référencées par leur cid, pas par leur nom.
 */
export function uniqueAttachmentNames<T extends { filename: string; cid?: string }>(
  list: T[],
): T[] {
  const taken = new Set<string>();
  list.forEach((a) => {
    if (!a.cid) taken.add(a.filename.toLowerCase());
  });
  const seen = new Set<string>();
  return list.map((a) => {
    if (a.cid) return a;
    const key = a.filename.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      return a;
    }
    const dot = a.filename.lastIndexOf('.');
    const stem = dot > 0 ? a.filename.slice(0, dot) : a.filename;
    const ext = dot > 0 ? a.filename.slice(dot) : '';
    let n = 2;
    let candidate = `${stem} (${n})${ext}`;
    while (taken.has(candidate.toLowerCase()) || seen.has(candidate.toLowerCase())) {
      n += 1;
      candidate = `${stem} (${n})${ext}`;
    }
    seen.add(candidate.toLowerCase());
    taken.add(candidate.toLowerCase());
    return { ...a, filename: candidate };
  });
}
