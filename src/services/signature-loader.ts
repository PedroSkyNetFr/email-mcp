/**
 * Outlook signature loader → HTML message + inline (cid) images.
 *
 * Outlook stores signatures under %APPDATA%\Microsoft\Signatures\ as a `.htm`
 * file (Word-generated HTML) plus a sibling `<name>_fichiers\` folder holding
 * the images (logo…). The `.htm` references those images by RELATIVE LOCAL
 * PATH, e.g.:
 *
 *   <img src="signature_fichiers/image001.png" ...>
 *
 * As-is, that HTML is unusable in an email (the recipient sees no image). This
 * module converts each local reference into an inline "cid" image (reusing the
 * existing multipart/related machinery):
 *   1. read the `.htm` (windows-1252 → UTF-8 decoding);
 *   2. find every <img src="…local file…"> (and the VML variant);
 *   3. read the image from the sibling folder, assign it a `cid`, rewrite the
 *      source to `cid:…`;
 *   4. return { html, attachments } ready to hand to MailComposer.
 *
 * The MCP server must have access to the signature path (so it must run on the
 * machine where the signature is installed).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountConfig } from '../types/index.js';
import type { ResolvedAttachment } from './attachment-resolver.js';

export interface LoadedSignature {
  /** Signature HTML fragment, with image sources rewritten to cid:. */
  html: string;
  /** Inline (cid) images referenced by the HTML above. */
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

// windows-1252 high range 0x80–0x9F → Unicode, indexed by (byte - 0x80).
// Outside this range cp1252 matches latin1 byte-for-byte. A 0 entry means the
// byte is undefined in cp1252 and falls through to its raw value.
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, // 0x80–0x87
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0, // 0x88–0x8F
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, // 0x90–0x97
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178, // 0x98–0x9F
];

/** Manual windows-1252 decoder. Reliable regardless of the Node ICU build. */
function decodeWindows1252(bytes: Buffer): string {
  return Array.from(bytes, (byte) => {
    const mapped = byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : 0;
    return String.fromCodePoint(mapped || byte);
  }).join('');
}

/** Decode raw bytes to a string, honoring the declared charset (default windows-1252). */
function decodeHtml(bytes: Buffer): string {
  const head = bytes.subarray(0, 1024).toString('latin1');
  const charset = /charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ?? 'windows-1252';
  // Word/Outlook signatures default to windows-1252; the WHATWG standard also
  // decodes iso-8859-1/latin1 as windows-1252. Map these ourselves —
  // TextDecoder('windows-1252') is unreliable under a small-ICU Node build and
  // can silently fall back to latin1, dropping characters like "œ" / "’".
  if (/^(windows-1252|cp1252|iso-8859-1|latin1)$/.test(charset)) {
    return decodeWindows1252(bytes);
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

/** true for a source that must NOT be embedded (already cid, remote, or data URI). */
function isNonLocalSource(value: string): boolean {
  return /^(cid:|https?:|data:|mailto:|#)/i.test(value.trim());
}

/** Read the first existing candidate among several paths (attempts run in parallel). */
async function readFirstExisting(candidates: string[]): Promise<Buffer | null> {
  const results = await Promise.allSettled(candidates.map(async (c) => fs.readFile(c)));
  const ok = results.find((r) => r.status === 'fulfilled');
  return ok ? ok.value : null;
}

/** Extract the "rendered" HTML: <style> blocks (Outlook fidelity) + <body> content. */
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
 * Load an Outlook `.htm` signature and return the HTML (images rewritten to
 * cid:) together with the matching inline attachments.
 */
export async function loadOutlookSignature(htmPath: string): Promise<LoadedSignature> {
  const absolute = path.resolve(htmPath);
  let raw: Buffer;
  try {
    raw = await fs.readFile(absolute);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Signature not found or unreadable: "${absolute}" (${reason})`);
  }

  let html = decodeHtml(raw);
  const baseDir = path.dirname(absolute);

  // CIDs already present in the VML variant (o:href="cid:…"): reuse them to stay
  // consistent between the <img> tag and Outlook's VML rendering.
  const vmlCids = [...html.matchAll(/o:href="cid:([^"]+)"/gi)].map((m) => m[1]);

  // Unique local sources, in order of appearance (src= and background=).
  const uniqueSources = [
    ...new Set(
      [...html.matchAll(/(?:src|background)="([^"]+)"/gi)]
        .map((m) => m[1])
        .filter((v) => !isNonLocalSource(v)),
    ),
  ];

  // Read the files in parallel (literal path first, then decoded: Word sometimes
  // percent-encodes spaces). Sources that cannot be resolved are left untouched.
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

  // Assign cids (reuse the VML cid sharing the basename, otherwise generate a
  // stable one) and rewrite the sources to cid:.
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
 * Load the signature configured for an account. Throws an explicit error when
 * `append_signature` is requested but no `signature_path` is configured.
 */
export async function loadAccountSignature(account: AccountConfig): Promise<LoadedSignature> {
  if (!account.signaturePath?.trim()) {
    throw new Error(
      `append_signature was requested but no "signature_path" is configured for account "${account.name}".`,
    );
  }
  return loadOutlookSignature(account.signaturePath);
}

/**
 * Apply an account's signature to a message being composed: append the HTML
 * below the body (forcing HTML mode) and merge the inline images. Transparent
 * no-op when `append` is falsy.
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
    html: true, // An HTML signature forces HTML mode.
    attachments: [...attachments, ...signature.attachments],
  };
}
