/**
 * Filesystem-path helpers for the direct-to-disk export / save tools.
 *
 * - `sanitizeFilename` — strip path separators and reserved characters so we
 *   never let an attacker's filename break out of the destination directory.
 * - `assertSafeDestination` — guard-rail that rejects any destination outside
 *   the allowed root directories (home, tmp, plus any added through the
 *   `MAIL_ALLOWED_SAVE_DIRS` env var), or accepts any absolute path when
 *   `MAIL_ALLOW_ANY_SAVE_DIR=true`. Normalizes `..` traversal and is
 *   cross-platform (Windows/macOS/Linux).
 * - `resolveUniquePath` — auto-suffix `name.ext` → `name-1.ext`, `name-2.ext`
 *   when the caller doesn't want to overwrite.
 */

import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

/** Async existence check — uses `fs.access`; throws become "does not exist". */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace anything that could make a filename unsafe with `_`. Also strips
 * leading/trailing dots so we don't produce `..` or hidden-file surprises.
 *
 * Safe on all three major platforms (macOS, Linux, Windows).
 */
export function sanitizeFilename(name: string): string {
  // Strip any directory separators first — we only want the leaf.
  const leaf = name.replace(/[\\/]/g, '_');
  // Replace Windows-reserved and other problematic chars with `_`.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in filenames
  const replaced = leaf.replace(/[<>:"|?*\x00-\x1F]/g, '_'); // eslint-disable-line no-control-regex
  // Collapse consecutive underscores introduced by the replace pass.
  const collapsed = replaced.replace(/_+/g, '_');
  // Trim leading dots so we don't produce `.hidden` files accidentally, and
  // trim trailing whitespace or dots (Windows rejects trailing dots anyway).
  const trimmed = collapsed.replace(/^\.+/, '').replace(/[.\s]+$/, '');
  return trimmed.length > 0 ? trimmed : 'unnamed';
}

/** Env var holding extra allowed save roots, separated by ";". */
export const ALLOWED_SAVE_DIRS_ENV = 'MAIL_ALLOWED_SAVE_DIRS';

/**
 * Env var that, when set to "true", disables the directory allow-list entirely
 * (any absolute destination is accepted). An explicit opt-out for trusted,
 * single-user setups — leave it unset to keep the safe default.
 */
export const ALLOW_ANY_SAVE_DIR_ENV = 'MAIL_ALLOW_ANY_SAVE_DIR';

/**
 * Build the whitelist of allowed root directories for direct-to-disk writes:
 * the user's home dir, the OS tmp dir, and any extra paths supplied via the
 * `MAIL_ALLOWED_SAVE_DIRS` environment variable (";"-separated). Every entry is
 * resolved to an absolute, canonical path so containment checks are reliable.
 */
export function allowedSaveRoots(): string[] {
  const extra = (process.env[ALLOWED_SAVE_DIRS_ENV] ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return [homedir(), tmpdir(), ...extra].map((p) => resolve(p));
}

/**
 * true when `child` is the same as, or nested under, `parent`.
 *
 * Uses `path.relative` so the comparison respects the platform separator and
 * (on Windows) case-insensitivity. A relative path that escapes `parent` starts
 * with `..`, and a path on a different Windows drive comes back absolute — both
 * are rejected, so sibling prefixes like `/tmp-evil` vs `/tmp` never match.
 */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Validate that a target path lies under one of the allowed root directories
 * (see {@link allowedSaveRoots}). Throws an Error describing the violation
 * otherwise.
 *
 * `path.resolve` canonicalizes the input, and any literal `..` segment is
 * rejected up front, so `~/Downloads/../../etc/passwd` is caught.
 */
export function assertSafeDestination(absolutePath: string): void {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`Destination must be an absolute path, got: ${absolutePath}`);
  }

  // Full opt-out: the operator has explicitly disabled the allow-list. We still
  // require an absolute path above (downstream writes need one), but skip the
  // containment and `..` checks.
  if (process.env[ALLOW_ANY_SAVE_DIR_ENV] === 'true') {
    return;
  }

  // Reject any literal `..` segment in the input — `resolve` would silently
  // collapse it, and this yields a clearer error than the containment check.
  if (absolutePath.split(/[\\/]/).includes('..')) {
    throw new Error(`Destination path must not contain ".." traversal segments: ${absolutePath}`);
  }

  const resolved = resolve(absolutePath);
  const roots = allowedSaveRoots();

  if (!roots.some((root) => isWithin(resolved, root))) {
    throw new Error(
      `Destination "${resolved}" is not under an allowed directory. ` +
        `Allowed roots: ${roots.join(', ')}. ` +
        `Add directories via the ${ALLOWED_SAVE_DIRS_ENV} environment variable (";"-separated).`,
    );
  }
}

/**
 * Given a desired destination path, return a unique path that does not
 * collide with an existing file. If `filename.ext` already exists, try
 * `filename-1.ext`, `filename-2.ext`, ... up to 9999.
 *
 * When `overwrite=true` this simply returns the input unchanged.
 */
export async function resolveUniquePath(desiredPath: string, overwrite: boolean): Promise<string> {
  if (overwrite) return desiredPath;
  if (!(await pathExists(desiredPath))) return desiredPath;

  const dir = dirname(desiredPath);
  const ext = extname(desiredPath);
  const base = basename(desiredPath, ext);

  /* eslint-disable no-await-in-loop */
  for (let i = 1; i < 10000; i += 1) {
    const candidate = join(dir, `${base}-${i}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  /* eslint-enable no-await-in-loop */

  throw new Error(`Could not find a unique filename after 10000 attempts for "${desiredPath}"`);
}
