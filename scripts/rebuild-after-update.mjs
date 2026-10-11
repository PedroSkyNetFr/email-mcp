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
 * Si pnpm-lock.yaml a changé, les dépendances verrouillées sont réinstallées
 * avant la compilation (`pnpm install --frozen-lockfile`).
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

// Bornes de l'opération git : ce qui était là avant, ce qui est là après.
function updateRange() {
  if (hook === 'post-checkout') return [args[0], args[1]];
  // post-merge et rebase : git laisse l'ancienne tête dans ORIG_HEAD.
  return ['ORIG_HEAD', 'HEAD'];
}

function lockfileChanged() {
  const [before, after] = updateRange();
  const diff = spawnSync('git', ['diff', '--quiet', before, after, '--', 'pnpm-lock.yaml'], {
    cwd: root,
  });
  // 1 = différence ; 0 = identique ; autre (révision introuvable) : prudence.
  return diff.status !== 0;
}

// Un pull qui change les dépendances laisse node_modules/ à l'ancienne version :
// le code compilé importe alors des modules absents et le serveur ne démarre
// plus (cas vécu : nodemailer 8 resté installé sous un code écrit pour la 10).
if (existsSync(path.join(root, 'node_modules')) && lockfileChanged()) {
  console.log('pnpm-lock.yaml changed: installing the locked dependencies…');
  // shell : pnpm est un .cmd sous Windows. Le prepare de pnpm réinstalle les hooks.
  // Commande en une seule chaîne fixe : avec shell, Node déconseille les arguments séparés.
  const install = spawnSync('pnpm install --frozen-lockfile', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (install.status !== 0) {
    console.error(
      '\n❌ pnpm install failed: node_modules/ no longer matches pnpm-lock.yaml and the ' +
        'server may not start. Run pnpm install, then pnpm build.',
    );
    process.exit(install.status ?? 1);
  }
}

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
