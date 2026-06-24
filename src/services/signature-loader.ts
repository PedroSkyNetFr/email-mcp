/**
 * Chargeur de signature Outlook → message HTML + images inline (cid).
 *
 * Outlook stocke ses signatures dans %APPDATA%\Microsoft\Signatures\ sous la
 * forme d'un fichier `.htm` (HTML généré par Word) accompagné d'un sous-dossier
 * `<nom>_fichiers\` contenant les images (logo…). Le `.htm` référence ces
 * images par CHEMIN LOCAL RELATIF, ex. :
 *
 *   <img src="CC (contact@pierrecanet.fr)_fichiers/image001.png" ...>
 *
 * Tel quel, ce HTML est inutilisable dans un mail (le destinataire ne voit pas
 * l'image). Ce module convertit chaque référence locale en image inline « cid »
 * (réutilisant la mécanique multipart/related déjà en place) :
 *   1. lit le `.htm` (encodage windows-1252 → UTF-8) ;
 *   2. repère chaque <img src="…fichier local…"> (et la variante VML) ;
 *   3. lit l'image dans le sous-dossier, lui attribue un `cid`, réécrit la
 *      source en `cid:…` ;
 *   4. renvoie { html, attachments } prêt à passer à MailComposer.
 *
 * Le serveur MCP doit avoir accès au chemin de la signature (donc tourner sur
 * la machine où elle est installée).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountConfig } from '../types/index.js';
import type { ResolvedAttachment } from './attachment-resolver.js';

export interface LoadedSignature {
  /** Fragment HTML de la signature, sources d'images réécrites en cid:. */
  html: string;
  /** Images inline (cid) référencées par le HTML ci-dessus. */
  attachments: ResolvedAttachment[];
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

function guessImageMime(filename: string): string {
  return IMAGE_MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Décode les octets bruts en chaîne, en respectant le charset déclaré (défaut windows-1252). */
function decodeHtml(bytes: Buffer): string {
  const head = bytes.subarray(0, 1024).toString('latin1');
  const charset = /charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ?? 'windows-1252';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // charset inconnu de l'environnement → repli latin1 (≈ windows-1252).
    return bytes.toString('latin1');
  }
}

/** true pour une source à NE PAS embarquer (déjà cid, distante, ou data URI). */
function isNonLocalSource(value: string): boolean {
  return /^(cid:|https?:|data:|mailto:|#)/i.test(value.trim());
}

/** Lit le premier candidat existant parmi plusieurs chemins (essais en parallèle). */
async function readFirstExisting(candidates: string[]): Promise<Buffer | null> {
  const results = await Promise.allSettled(candidates.map(async (c) => fs.readFile(c)));
  const ok = results.find((r) => r.status === 'fulfilled');
  return ok ? ok.value : null;
}

/** Extrait le HTML « rendu » : blocs <style> (fidélité Outlook) + contenu de <body>. */
function extractRenderable(html: string): string {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n')
    .trim();
  const bodyInner = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const styleTag = styles ? `<style>${styles}</style>` : '';
  return `${styleTag}${bodyInner}`.trim();
}

/**
 * Charge une signature Outlook `.htm` et renvoie le HTML (images en cid:) avec
 * les pièces inline correspondantes.
 */
export async function loadOutlookSignature(htmPath: string): Promise<LoadedSignature> {
  const absolute = path.resolve(htmPath);
  let raw: Buffer;
  try {
    raw = await fs.readFile(absolute);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Signature introuvable ou illisible : "${absolute}" (${reason})`);
  }

  let html = decodeHtml(raw);
  const baseDir = path.dirname(absolute);

  // CID déjà présents dans la variante VML (o:href="cid:…") : on les réutilise
  // pour rester cohérent entre la balise <img> et le rendu VML d'Outlook.
  const vmlCids = [...html.matchAll(/o:href="cid:([^"]+)"/gi)].map((m) => m[1]);

  // Sources locales uniques, dans l'ordre d'apparition (src= et background=).
  const uniqueSources = [
    ...new Set(
      [...html.matchAll(/(?:src|background)="([^"]+)"/gi)]
        .map((m) => m[1])
        .filter((v) => !isNonLocalSource(v)),
    ),
  ];

  // Lecture des fichiers en parallèle (essai littéral puis décodé : Word encode
  // parfois les %20). Les sources non résolubles sont écartées (laissées telles).
  const loaded = (
    await Promise.all(
      uniqueSources.map(async (source) => {
        const basename = path.basename(decodeURIComponent(source));
        const content = await readFirstExisting([
          path.resolve(baseDir, source),
          path.resolve(baseDir, decodeURIComponent(source)),
        ]);
        return content ? { source, basename, content } : null;
      }),
    )
  ).filter((e): e is { source: string; basename: string; content: Buffer } => e !== null);

  // Attribution des cid (réutilise le cid VML partageant le basename, sinon en
  // génère un stable) et réécriture des sources en cid:.
  const attachments: ResolvedAttachment[] = [];
  loaded.forEach(({ source, basename, content }, i) => {
    const cid = vmlCids.find((c) => c.startsWith(basename)) ?? `sig-${i.toString()}-${basename}`;
    attachments.push({
      filename: basename,
      content,
      contentType: guessImageMime(basename),
      cid,
      contentDisposition: 'inline',
    });
    html = html.split(`"${source}"`).join(`"cid:${cid}"`);
  });

  return { html: extractRenderable(html), attachments };
}

/**
 * Charge la signature configurée pour un compte. Lève une erreur explicite si
 * `append_signature` est demandé alors qu'aucun `signature_path` n'est configuré.
 */
export async function loadAccountSignature(account: AccountConfig): Promise<LoadedSignature> {
  if (!account.signaturePath?.trim()) {
    throw new Error(
      `append_signature demandé mais aucun "signature_path" configuré pour le compte "${account.name}".`,
    );
  }
  return loadOutlookSignature(account.signaturePath);
}

/**
 * Applique la signature d'un compte à un message en composition : ajoute le
 * HTML sous le corps (en forçant le mode HTML) et fusionne les images inline.
 * No-op transparent quand `append` est falsy.
 */
export async function applyAccountSignature(
  account: AccountConfig,
  message: { body: string; html?: boolean; attachments?: ResolvedAttachment[] },
  append: boolean | undefined,
): Promise<{ body: string; html: boolean; attachments: ResolvedAttachment[] }> {
  const attachments = message.attachments ?? [];
  if (!append) {
    return { body: message.body, html: message.html ?? false, attachments };
  }
  const signature = await loadAccountSignature(account);
  return {
    body: `${message.body}<br>${signature.html}`,
    html: true, // une signature HTML impose le mode HTML.
    attachments: [...attachments, ...signature.attachments],
  };
}
