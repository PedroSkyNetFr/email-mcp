/**
 * commit-msg hook: enforce the Conventional Commits header.
 *
 *   node scripts/verify-commit-msg.mjs <commit message file>
 *
 * Why a script file. Lefthook hands a multi-line `run:` block to
 * `sh -c "…"`, and on Windows that wrapper does not escape the block's own
 * double quotes. The former inline version was full of `echo "…"`, so it never
 * parsed there: every commit was rejected with
 *
 *   -c: line 2: unexpected EOF while looking for matching `"'
 *
 * whatever the message, and whether or not cocogitto was installed. A file
 * leaves nothing for the wrapper to mangle.
 *
 * cocogitto stays the reference when it is on the PATH. Without it, the header
 * is checked against the types declared in cog.toml — so a missing tool no
 * longer blocks every commit, and no longer lets a malformed one through
 * either. CI does not check commit messages; this hook is the only guard.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Mirrors [commit_types] in cog.toml.
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

// Headers git writes itself. `git merge` and `git revert` run this hook too,
// and refusing their default message would block two routine operations.
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

// cocogitto is not installed: check the header ourselves. It is the first line
// that is neither blank nor a comment git added for the editor.
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
