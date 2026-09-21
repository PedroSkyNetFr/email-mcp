/**
 * Hooks post-merge, post-checkout et post-rewrite : reconstruit dist/ quand git
 * apporte du code nouveau.
 *
 *   node scripts/rebuild-after-update.mjs post-merge
 *   node scripts/rebuild-after-update.mjs post-checkout <avant> <après> <drapeau>
 *   node scripts/rebuild-after-update.mjs post-rewrite <amend|rebase>
 *
 * Pourquoi. Les clients MCP lancent dist/main.js, et dist/ n'est pas versionné :
 * un `git pull` met à jour src/ et laisse tourner l'ancienne version compilée.
 * Un correctif fusionné semble alors en service sans l'être, et rien ne le
 * signale. Le hook pre-push reconstruit bien dist/, mais seulement dans le
 * dossier d'où l'on pousse, pas dans celui qui se contente de tirer.
 *
 * Ce qui déclenche une reconstruction :
 * - post-merge : un `git pull` ou un `git merge` qui a apporté des commits ;
 * - post-checkout : un changement de branche ou de commit (drapeau 1, commits
 *   différents), pas la restauration d'un fichier ni un `checkout -b` sur place ;
 * - post-rewrite : un rebase (`git pull --rebase`), pas un `commit --amend`.
 *
 * Un hook post-* ne peut pas annuler l'opération git. En cas d'échec, le
 * message le dit, et le code de sortie non nul le fait apparaître chez lefthook.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const [hook, ...args] = process.argv.slice(2);

function shouldRebuild() {
  if (hook === 'post-merge') return true;
  if (hook === 'post-checkout') {
    const [previous, next, branchCheckout] = args;
    return branchCheckout === '1' && previous !== next;
  }
  if (hook === 'post-rewrite') return args[0] === 'rebase';
  return false;
}

if (!shouldRebuild()) process.exit(0);

// Un worktree tout juste créé n'a pas encore ses dépendances : rien à compiler.
if (!existsSync(tsc)) {
  console.log('dist/ not rebuilt: dependencies are missing (run pnpm install, then pnpm build).');
  process.exit(0);
}

const started = Date.now();
// tsc directement, sans passer par pnpm : le hook ne dépend pas du PATH.
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (result.status !== 0) {
  // Sans noEmitOnError, tsc écrit dist/ malgré les erreurs de type : dist/ a
  // bien changé, mais ne correspond pas forcément à ce que src/ décrit.
  console.error(
    `\n❌ dist/ rebuilt with TypeScript errors (${seconds} s): fix them, then run pnpm build.`,
  );
  process.exit(result.status ?? 1);
}

console.log(
  `✅ dist/ rebuilt (${seconds} s). Restart your MCP clients to load it: ` +
    'a running server keeps the code it started with.',
);
