/**
 * Composition MIME des messages sortants et re-pliage des en-têtes à paramètres.
 *
 * Repris de wgs4 (9657895), avec deux corrections :
 *   - le parcours est linéaire (tableau alimenté par push) : la version
 *     d'origine recopiait le tableau de sortie à chaque ligne, coût quadratique
 *     qui figeait le processus sur une pièce jointe de quelques Mo (25 Mo en
 *     base64 ≈ 340 000 lignes) ;
 *   - un début de partie n'est reconnu que sur un vrai délimiteur
 *     `--<boundary>` déclaré par un Content-Type multipart, et non sur toute
 *     ligne commençant par `--` (la ligne « -- » d'une signature texte aurait
 *     fait traiter la suite du corps comme des en-têtes).
 *
 * Défaut corrigé (toujours présent dans nodemailer 10.5, vérifié) : nodemailer
 * plie les en-têtes longs sur l'espace le plus proche, y compris À L'INTÉRIEUR
 * d'une valeur entre guillemets :
 *
 *   Content-Disposition: attachment; filename="Relevé Farmpedals
 *    08-07-2026.pdf"
 *
 * C'est un pliage RFC 5322 légal, mais iOS Mail refuse alors la pièce (« Une ou
 * plusieurs pièces jointes n'ont pas pu être chargées ») : elle disparaît du
 * message. {@link refoldParamHeaders} déplie Content-Type / Content-Disposition
 * et ne les replie qu'aux `;` de premier niveau, comme Apple Mail.
 */

import MailComposer from 'nodemailer/lib/mail-composer';

/** En-têtes dont les paramètres peuvent porter un nom de fichier entre guillemets. */
const PARAM_HEADER = /^(content-type|content-disposition):/i;

/** Longueur de ligne visée (RFC 5322 recommande ≤ 78, CRLF compris). */
const MAX_LINE = 76;

/**
 * Découpe un en-tête déplié en segments séparés par `;`, en ignorant les `;`
 * situés entre guillemets (`filename="a;b.pdf"` forme UN segment). Chaque
 * segment sauf le dernier garde son `;` final.
 */
function splitParams(logical: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  // eslint-disable-next-line no-restricted-syntax -- parcours caractère par caractère
  for (const ch of logical) {
    current += ch;
    if (escaped) {
      escaped = false;
    } else if (ch === '\\' && inQuotes) {
      escaped = true;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ';' && !inQuotes) {
      segments.push(current);
      current = '';
    }
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Replie un en-tête déplié aux frontières de paramètres. Un segment plus long
 * que la cible reste seul sur sa ligne (longue) plutôt que d'être coupé : une
 * ligne longue est acceptée partout, un pli entre guillemets non.
 */
function foldParams(logical: string, eol: string): string {
  if (logical.length <= MAX_LINE) return logical;
  const [head, ...rest] = splitParams(logical);
  if (head === undefined || rest.length === 0) return logical;

  const lines: string[] = [];
  let current = head;
  rest.forEach((segment) => {
    if (current.length + 1 + segment.length <= MAX_LINE) {
      current = `${current} ${segment}`;
    } else {
      lines.push(current);
      current = ` ${segment}`; // une ligne de continuation commence par une espace
    }
  });
  lines.push(current);
  return lines.join(eol);
}

/** Paramètre boundary d'un Content-Type multipart déplié, s'il y en a un. */
function boundaryOf(logicalHeader: string): string | undefined {
  if (!/^content-type:\s*multipart\//i.test(logicalHeader)) return undefined;
  const match = /\bboundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(logicalHeader);
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * Réécrit un message composé pour qu'aucun pli de Content-Type /
 * Content-Disposition ne tombe dans une valeur entre guillemets.
 *
 * Seuls les blocs d'en-têtes sont touchés : celui du message, puis celui de
 * chaque partie (la ligne qui suit un délimiteur `--boundary` déclaré). Les
 * corps — base64 des pièces comprises — passent octet pour octet. Le message
 * est traité en binaire (latin1) pour que ces octets survivent à l'aller-retour.
 */
export function refoldParamHeaders(raw: Buffer): Buffer {
  const text = raw.toString('binary');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);

  const out: string[] = [];
  const boundaries = new Set<string>();
  let inHeaders = true;
  let pending: string | null = null;
  let changed = false;

  const flush = (): void => {
    if (pending === null) return;
    const boundary = boundaryOf(pending);
    if (boundary) boundaries.add(boundary);
    out.push(foldParams(pending, eol));
    pending = null;
  };

  lines.forEach((line) => {
    // Dépliage RFC 5322 : on retire le CRLF et on garde l'espace de tête, ce
    // qui reconstitue exactement un nom de fichier contenant des espaces.
    if (pending !== null && /^[ \t]/.test(line)) {
      pending += line;
      changed = true;
      return;
    }
    flush();

    if (!inHeaders) {
      out.push(line);
      // Un délimiteur déclaré ouvre le bloc d'en-têtes de la partie suivante
      // (le délimiteur final `--boundary--` non : il clôt le multipart).
      if (line.startsWith('--')) {
        const marker = line.slice(2).trimEnd();
        if (boundaries.has(marker)) inHeaders = true;
      }
      return;
    }
    if (line === '') {
      out.push(line);
      inHeaders = false;
      return;
    }
    if (PARAM_HEADER.test(line)) {
      pending = line;
      return;
    }
    out.push(line);
  });
  flush();

  const rebuilt = out.join(eol);
  if (!changed && rebuilt === text) return raw;
  return Buffer.from(rebuilt, 'binary');
}

/** Options acceptées par MailComposer (constructeur), telles que nodemailer les type. */
export type ComposeOptions = ConstructorParameters<typeof MailComposer>[0];

/**
 * Compose un message en octets bruts, en-têtes à paramètres re-pliés.
 *
 * `keepBcc` : MimeNode retire l'en-tête Bcc par défaut, à raison pour un ENVOI
 * (les destinataires cachés voyagent dans l'enveloppe SMTP). Un BROUILLON n'a
 * pas encore d'enveloppe : sans l'en-tête, la liste Bcc est perdue en silence
 * et le message partira sans eux. L'option se pose sur le MimeNode compilé —
 * la passer à MailComposer ne fait rien (les transports stream/sendmail de
 * nodemailer procèdent de même). Au moment de l'envoi, sendDraft relit ces
 * adresses pour l'enveloppe et retire l'en-tête (stripBccHeader).
 */
export async function composeMessage(
  options: ComposeOptions,
  { keepBcc = false }: { keepBcc?: boolean } = {},
): Promise<Buffer> {
  const composed = await new Promise<Buffer>((resolve, reject) => {
    const node = new MailComposer(options).compile();
    if (keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true;
    node.build((err: Error | null, buf: Buffer) => {
      if (err) reject(err);
      else resolve(buf);
    });
  });
  return refoldParamHeaders(composed);
}

/**
 * Valeur de l'en-tête References d'un message rattaché à un fil.
 *
 * In-Reply-To seul ne suffit pas : plusieurs clients (Gmail en tête) regroupent
 * les fils sur References. La chaîne fournie est reprise, complétée par
 * `inReplyTo` s'il n'y figure pas déjà (il doit en être le dernier maillon) ;
 * sans chaîne, `inReplyTo` seul forme une chaîne valide (RFC 5322 §3.6.4).
 */
export function buildReferences(
  inReplyTo: string | undefined,
  references: string[] | string | undefined,
): string | undefined {
  const chain = (Array.isArray(references) ? references : (references ?? '').split(/\s+/))
    .map((ref) => ref.trim())
    .filter(Boolean);
  if (inReplyTo?.trim() && !chain.includes(inReplyTo.trim())) chain.push(inReplyTo.trim());
  return chain.length > 0 ? chain.join(' ') : undefined;
}
