/**
 * Opaque identifiers of the engine contract: building them, and checking them
 * on input.
 *
 *   <kind>.<engine><version>.<payload>      e.g.  m.imap1.WyJJTkJPWCIsMSw0Ml0
 *
 * - kind: `m` message, `f` folder, `p` page token, `c` sync cursor;
 * - engine + version: which engine made it, and in which format, so a format
 *   change is detected instead of misread;
 * - payload: base64url of a JSON array, so any folder name (accents, slashes,
 *   quotes) survives.
 *
 * Hosts never parse these strings. The point of the prefix is the failure
 * mode: a folder id passed where a message id is expected fails here, with a
 * message saying so, instead of reaching the server as a wrong UID.
 */

import { MailError } from './errors.js';

export type IdKind = 'message' | 'folder' | 'page' | 'cursor';

const PREFIX: Record<IdKind, string> = { message: 'm', folder: 'f', page: 'p', cursor: 'c' };

type Part = string | number | null;

export function encodeId(kind: IdKind, engine: string, parts: Part[]): string {
  const payload = Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
  return `${PREFIX[kind]}.${engine}.${payload}`;
}

/**
 * Decodes an id made by `encodeId` for this kind and engine, or throws
 * `MailError('not-found')` saying what was received instead.
 */
export function decodeId(id: unknown, kind: IdKind, engine: string): Part[] {
  const reject = (why: string): never => {
    throw new MailError('not-found', `Not a ${kind} id of this ${engine} engine (${why})`);
  };
  if (typeof id !== 'string') return reject('not a string');
  const [prefix, idEngine, payload, ...rest] = id.split('.');
  if (rest.length > 0 || payload === undefined) return reject('malformed');
  if (prefix !== PREFIX[kind]) {
    const actual = (Object.keys(PREFIX) as IdKind[]).find((k) => PREFIX[k] === prefix);
    return reject(actual ? `got a ${actual} id` : 'malformed');
  }
  if (idEngine !== engine) return reject(`made by "${idEngine}"`);
  try {
    const parts: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      Array.isArray(parts) &&
      parts.every((p) => typeof p === 'string' || typeof p === 'number' || p === null)
    ) {
      return parts as Part[];
    }
  } catch {
    // falls through to the rejection below
  }
  return reject('malformed');
}
