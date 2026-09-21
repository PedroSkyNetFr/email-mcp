/**
 * Hook commit-msg : impose l'en-tête Conventional Commits.
 *
 *   node scripts/verify-commit-msg.mjs <fichier du message de commit>
 *
 * Pourquoi un fichier. Lefthook passe un bloc `run:` sur plusieurs lignes à
 * `sh -c "…"`, et sous Windows cette enveloppe n'échappe pas les guillemets
 * doubles du bloc lui-même. L'ancienne version en ligne était pleine de
 * `echo "…"` : elle n'y était jamais analysée, et chaque commit était rejeté par
 *
 *   -c: line 2: unexpected EOF while looking for matching `"'
 *
 * quel que soit le message, et que cocogitto soit installé ou non. Un fichier
 * ne laisse rien à abîmer à l'enveloppe.
 *
 * cocogitto reste la référence quand il est dans le PATH. Sans lui, l'en-tête
 * est vérifié contre les types déclarés dans cog.toml : un outil absent ne
 * bloque plus tous les commits, et ne laisse pas passer non plus un message mal
 * formé. La CI ne vérifie pas les messages : ce hook est le seul garde-fou.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Reflet de [commit_types] dans cog.toml.
const TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'build',
  'ci',
  'test',
  'style',
  'chore',
  'revert',
];

const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([\\w./-]+\\))?!?: \\S`);

// En-têtes que git écrit lui-même. `git merge` et `git revert` déclenchent aussi
// ce hook, et refuser leur message par défaut bloquerait deux opérations
// courantes.
const GIT_GENERATED = /^(Merge |Revert ")/;

function explain() {
  console.error(
    [
      '',
      '❌ Invalid commit message format',
      '',
      'Expected: <type>(<scope>): <description>',
      'Example:  feat(imap): add thread reconstruction',
      '',
      `Types: ${TYPES.join(', ')}`,
      '',
    ].join('\n'),
  );
}

const file = process.argv[2];
if (!file) {
  console.error('verify-commit-msg: expected the commit message file as argument');
  process.exit(1);
}

const cog = spawnSync('cog', ['verify', '--file', file], { stdio: 'inherit' });
if (!cog.error) {
  if (cog.status !== 0) explain();
  process.exit(cog.status ?? 1);
}

// cocogitto n'est pas installé : on vérifie l'en-tête nous-mêmes. C'est la
// première ligne qui n'est ni vide, ni un commentaire ajouté par git pour
// l'éditeur.
const header =
  readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .find((line) => line.trim() !== '' && !line.startsWith('#')) ?? '';

if (HEADER.test(header) || GIT_GENERATED.test(header)) {
  process.exit(0);
}

console.error(`Header: ${header || '(empty)'}`);
explain();
process.exit(1);
