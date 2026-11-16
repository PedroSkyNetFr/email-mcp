/**
 * Folder roles of an IMAP account: which folder is the inbox, the sent folder,
 * the trash…, what decided it, and which other folders could hold the role.
 *
 * imapflow already resolves a role per folder, and says how
 * (`specialUseSource`): `user` from the hints we pass (the account config),
 * `extension` from the server (SPECIAL-USE, XLIST), `name` from a list of
 * localised names. This module maps that onto the contract and adds what
 * imapflow does not: the disagreement. A server can flag a folder the account
 * does not use — on an OVH mailbox used with Outlook the server flags "Sent"
 * (5 messages) while Outlook files sent mail in "Éléments envoyés" (560) — so
 * a folder whose name matches the role and that holds more mail is reported
 * as a candidate instead of being ignored.
 */

import type { FolderRole, FolderRoleSource } from '../../contract/engine.types.js';

const SPECIAL_USE_ROLE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
};

/** Usual names of each role, compared without case nor accents. */
const ROLE_NAMES: Partial<Record<FolderRole, string[]>> = {
  sent: [
    'sent',
    'sent items',
    'sent messages',
    'sent mail',
    'elements envoyes',
    'messages envoyes',
    'envoyes',
    'gesendet',
    'gesendete elemente',
    'enviados',
    'posta inviata',
  ],
  drafts: ['drafts', 'brouillons', 'entwurfe', 'borradores', 'bozze'],
  trash: [
    'trash',
    'deleted items',
    'deleted messages',
    'elements supprimes',
    'corbeille',
    'papierkorb',
    'papelera',
    'cestino',
  ],
  junk: ['junk', 'spam', 'junk e-mail', 'courrier indesirable', 'pourriel'],
  archive: ['archive', 'archives'],
};

const normalise = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** The role a folder name usually means, if any. */
export function roleFromName(name: string): FolderRole | undefined {
  const n = normalise(name);
  return (Object.keys(ROLE_NAMES) as FolderRole[]).find((role) => ROLE_NAMES[role]?.includes(n));
}

export interface RoleInput {
  path: string;
  name: string;
  specialUse?: string;
  specialUseSource?: 'user' | 'extension' | 'name';
  total?: number;
}

export interface RoleOutput {
  role?: FolderRole;
  roleSource?: FolderRoleSource;
  /** Paths of the other folders that could hold this role. */
  candidatePaths?: string[];
}

const SOURCE: Record<'user' | 'extension' | 'name', FolderRoleSource> = {
  user: 'config',
  extension: 'server',
  name: 'name',
};

/**
 * Resolves the role of every folder (same order as `folders`). A role chosen
 * by the config is final: no candidates, the user decided. Otherwise, folders
 * whose name means the same role and that hold strictly more messages are
 * listed as candidates.
 */
export function resolveRoles(folders: RoleInput[]): RoleOutput[] {
  return folders.map((folder) => {
    const role = folder.specialUse ? SPECIAL_USE_ROLE[folder.specialUse] : undefined;
    if (!role) return {};
    const roleSource = SOURCE[folder.specialUseSource ?? 'extension'];
    if (roleSource === 'config' || role === 'inbox') return { role, roleSource };

    const mine = folder.total ?? 0;
    const candidatePaths = folders
      .filter(
        (other) =>
          other.path !== folder.path &&
          roleFromName(other.name) === role &&
          (other.total ?? 0) > mine,
      )
      .map((other) => other.path);
    return candidatePaths.length > 0 ? { role, roleSource, candidatePaths } : { role, roleSource };
  });
}
