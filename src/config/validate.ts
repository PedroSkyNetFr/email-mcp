/**
 * Validation statique du fichier de configuration — `email-mcp config validate`.
 *
 * Reprise de codefuturist bf09dcc (`src/config/validate.ts`) : le parcours de
 * l'arbre zod pour trouver les clés inconnues (aucune liste de clés tenue à la
 * main : un nouveau champ du schéma est couvert d'office) et la distance
 * d'édition pour suggérer la clé voulue sont repris tels quels. Le reste est
 * réécrit pour notre base :
 * - les contrôles de cohérence portent sur NOS champs (backend Graph,
 *   `*_command`, `signature_*`, TLS/STARTTLS, `MCP_EMAIL_ACCOUNTS`, recherches
 *   enregistrées…) — ceux de l'amont visaient des sections que nous n'avons pas
 *   (verification, server) ;
 * - ils tournent sur le TOML brut, même quand le schéma échoue, pour que tous
 *   les problèmes sortent en un seul passage ;
 * - aucune valeur n'est jamais recopiée dans le rapport : seuls des chemins de
 *   champs et des messages. L'extrait d'une erreur de syntaxe masque toute
 *   ligne qui pourrait porter un secret (le message brut de smol-toml cite le
 *   fichier autour de l'erreur, mot de passe compris).
 *
 * Pourquoi ce contrôle : les schémas ne sont pas stricts — une clé inconnue
 * est ignorée au chargement —, si bien qu'une faute de frappe
 * (`pasword_command = …`) disparaissait sans un mot, et le compte échouait
 * plus tard pour une raison obscure.
 */

import fs from 'node:fs';

import { parse as parseTOML } from 'smol-toml';
import { z } from 'zod';

import { AppConfigFileSchema } from './schema.js';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  kind: 'syntax' | 'schema' | 'unknown-key' | 'consistency';
  /** Chemin du champ, ex. `accounts[1].imap.port`. */
  path?: string;
  /** Nom du compte concerné, quand il y en a un. */
  account?: string;
  message: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  /** Faux si le TOML est illisible : rien d'autre n'a pu être contrôlé. */
  syntaxOk: boolean;
  /** Vrai si le schéma zod accepte le fichier. */
  schemaOk: boolean;
}

export interface ValidateOptions {
  /** Environnement à considérer (défaut : `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Test d'existence d'un fichier (injectable pour les tests). */
  fileExists?: (filePath: string) => boolean;
}

// ---------------------------------------------------------------------------
// Secrets — ne jamais les afficher
// ---------------------------------------------------------------------------

/**
 * Clés dont la valeur ne doit jamais apparaître : mots de passe, secrets OAuth,
 * jetons, et toute `*_command` (la commande peut contenir un mot de passe
 * maître ou le chemin d'un coffre). Comparé au nom de clé seul.
 */
const SECRET_KEY = /(password|secret|token|_command$|^url$)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * Ligne citée dans une erreur de syntaxe, ou `undefined` si elle risque de
 * contenir un secret : une ligne `clé = valeur` dont la clé est sensible, ou
 * toute ligne qui n'est ni un en-tête `[section]`, ni un commentaire, ni une
 * affectation (le milieu d'une chaîne multiligne, par exemple).
 */
export function safeExcerpt(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('[') || trimmed.startsWith('#')) return trimmed;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return undefined;
  const key = trimmed
    .slice(0, eq)
    .trim()
    .replace(/^["']|["']$/g, '');
  const lastSegment = key.split('.').pop() ?? key;
  if (isSecretKey(lastSegment)) return `${trimmed.slice(0, eq).trim()} = ***`;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Clés inconnues — parcours de l'arbre zod (repris de l'amont)
// ---------------------------------------------------------------------------

/** Déballe ZodDefault/ZodOptional/ZodNullable… jusqu'au schéma concret. */
function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  while (
    current &&
    typeof (current as { unwrap?: unknown }).unwrap === 'function' &&
    // S'arrêter aux conteneurs concrets : ZodArray.unwrap() sauterait au type
    // d'élément et le parcours manquerait le niveau tableau.
    !(current instanceof z.ZodObject) &&
    !(current instanceof z.ZodArray)
  ) {
    current = (current as { unwrap: () => unknown }).unwrap();
  }
  return current;
}

export function levenshtein(a: string, b: string): number {
  const cols = b.length + 1;
  const d: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[cols - 1];
}

/** Clé connue la plus proche, seulement pour une faute plausible (distance ≤ 2). */
export function nearestKey(key: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  candidates.forEach((candidate) => {
    const distance = levenshtein(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  });
  return best;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Nom d'un compte à l'index donné, pour un chemin lisible. */
function accountNameAt(raw: unknown, index: number): string | undefined {
  const accounts = isPlainObject(raw) ? raw.accounts : undefined;
  if (!Array.isArray(accounts)) return undefined;
  const name = isPlainObject(accounts[index]) ? accounts[index].name : undefined;
  return typeof name === 'string' ? name : undefined;
}

function walk(
  value: unknown,
  schema: unknown,
  pathSoFar: string,
  out: { path: string; suggestion?: string }[],
): void {
  const concrete = unwrapSchema(schema);

  if (concrete instanceof z.ZodObject && isPlainObject(value)) {
    const shape = concrete.shape as Record<string, unknown>;
    const known = Object.keys(shape);
    Object.entries(value).forEach(([key, child]) => {
      const childPath = pathSoFar ? `${pathSoFar}.${key}` : key;
      if (key in shape) {
        walk(child, shape[key], childPath, out);
      } else {
        out.push({ path: childPath, suggestion: nearestKey(key, known) });
      }
    });
    return;
  }

  if (concrete instanceof z.ZodArray && Array.isArray(value)) {
    const { element } = concrete;
    value.forEach((item, index) => {
      walk(item, element, `${pathSoFar}[${index}]`, out);
    });
  }
}

/** Clés présentes dans le TOML qu'aucun schéma ne connaît. */
export function findUnknownKeys(raw: unknown): { path: string; suggestion?: string }[] {
  const out: { path: string; suggestion?: string }[] = [];
  walk(raw, AppConfigFileSchema, '', out);
  return out;
}

/** `accounts[1].imap.prot` → nom du compte d'index 1. */
function accountOfPath(raw: unknown, dottedPath: string): string | undefined {
  const match = /^accounts\[(\d+)\]/.exec(dottedPath);
  return match ? accountNameAt(raw, Number(match[1])) : undefined;
}

// ---------------------------------------------------------------------------
// Cohérence — ce qu'un schéma champ par champ ne voit pas
// ---------------------------------------------------------------------------

/** Ports usuels : TLS implicite d'un côté, clair/STARTTLS de l'autre. */
const IMPLICIT_TLS_PORTS = { imap: 993, smtp: 465 } as const;
const PLAIN_PORTS = { imap: [143], smtp: [25, 587] } as const;

function get(obj: unknown, key: string): unknown {
  return isPlainObject(obj) ? obj[key] : undefined;
}

function checkTransport(
  account: Record<string, unknown>,
  proto: 'imap' | 'smtp',
  where: string,
  name: string | undefined,
  push: (issue: Omit<ValidationIssue, 'kind'>) => void,
): void {
  const block = account[proto];
  if (!isPlainObject(block)) return;
  // Valeurs par défaut du schéma quand la clé est absente.
  const tls = typeof block.tls === 'boolean' ? block.tls : true;
  const starttls = typeof block.starttls === 'boolean' ? block.starttls : false;
  const port = typeof block.port === 'number' ? block.port : IMPLICIT_TLS_PORTS[proto];
  const p = `${where}.${proto}`;

  if (tls && starttls) {
    push({
      severity: 'warning',
      path: p,
      account: name,
      message:
        'tls and starttls are both true: the connection uses implicit TLS and starttls is ignored — keep only the one your server expects',
    });
  }
  if (tls && (PLAIN_PORTS[proto] as readonly number[]).includes(port)) {
    push({
      severity: 'warning',
      path: `${p}.port`,
      account: name,
      message: `port ${port} usually speaks plain/STARTTLS, but tls = true (implicit TLS) — the TLS handshake will likely fail; use tls = false + starttls = true, or port ${IMPLICIT_TLS_PORTS[proto]}`,
    });
  }
  if (!tls && port === IMPLICIT_TLS_PORTS[proto]) {
    push({
      severity: 'warning',
      path: `${p}.port`,
      account: name,
      message: `port ${port} usually expects implicit TLS, but tls = false — the connection will likely hang or fail; set tls = true`,
    });
  }
}

/** Contrôles croisés sur le TOML brut (tolère un fichier que le schéma refuse). */
export function findConsistencyIssues(
  raw: unknown,
  opts: ValidateOptions = {},
): Omit<ValidationIssue, 'kind'>[] {
  const env = opts.env ?? process.env;
  // Synchrone à dessein : contrôle CLI ponctuel, une poignée de chemins au plus.
  // eslint-disable-next-line n/no-sync
  const fileExists = opts.fileExists ?? ((p: string) => fs.existsSync(p));
  const issues: Omit<ValidationIssue, 'kind'>[] = [];
  const push = (issue: Omit<ValidationIssue, 'kind'>): void => {
    issues.push(issue);
  };

  const accountsRaw = get(raw, 'accounts');
  const accounts = Array.isArray(accountsRaw) ? accountsRaw : [];
  const names: string[] = [];

  accounts.forEach((acc, index) => {
    if (!isPlainObject(acc)) return;
    const where = `accounts[${index}]`;
    const name = typeof acc.name === 'string' ? acc.name : undefined;

    if (name !== undefined) {
      if (names.includes(name)) {
        push({
          severity: 'error',
          path: `${where}.name`,
          account: name,
          message: `duplicate account name "${name}" — every tool addresses accounts by name, the second one is unreachable`,
        });
      }
      names.push(name);
    }

    const backend = acc.backend ?? 'imap';
    const { oauth2 } = acc;
    if (backend === 'graph') {
      if (!isPlainObject(oauth2)) {
        push({
          severity: 'error',
          path: `${where}.backend`,
          account: name,
          message:
            'backend = "graph" needs an [accounts.oauth2] block (Microsoft refresh token consented for Graph scopes): every call would fail',
        });
      } else if (oauth2.provider === 'google') {
        push({
          severity: 'error',
          path: `${where}.oauth2.provider`,
          account: name,
          message:
            'backend = "graph" with oauth2.provider = "google": Microsoft Graph only accepts Microsoft tokens',
        });
      }
      if (acc.password !== undefined || acc.password_command !== undefined) {
        push({
          severity: 'warning',
          path: where,
          account: name,
          message:
            'password/password_command is unused on a Graph account (Graph authenticates with oauth2 only)',
        });
      }
    } else if (
      isPlainObject(oauth2) &&
      (acc.password !== undefined || acc.password_command !== undefined)
    ) {
      push({
        severity: 'warning',
        path: where,
        account: name,
        message:
          'both oauth2 and password/password_command are set: IMAP and SMTP authenticate with oauth2, the password is ignored',
      });
    }

    checkTransport(acc, 'imap', where, name, push);
    checkTransport(acc, 'smtp', where, name, push);

    const sigPath = typeof acc.signature_path === 'string' ? acc.signature_path.trim() : '';
    if (acc.signature_default === true && sigPath === '') {
      push({
        severity: 'error',
        path: `${where}.signature_default`,
        account: name,
        message:
          'signature_default = true without signature_path: every send/reply/draft that does not pass append_signature:false would fail',
      });
    }
    if (sigPath !== '' && !fileExists(sigPath)) {
      push({
        severity: 'warning',
        path: `${where}.signature_path`,
        account: name,
        message: 'signature_path does not point to an existing file (checked from this machine)',
      });
    }
  });

  // Recherches enregistrées qui citent un compte absent.
  const searches = get(raw, 'searches');
  if (Array.isArray(searches)) {
    searches.forEach((preset, index) => {
      const many = get(preset, 'accounts');
      const refs: unknown[] = [get(preset, 'account'), ...(Array.isArray(many) ? many : [])];
      refs
        .filter((ref): ref is string => typeof ref === 'string')
        .filter((ref) => !names.includes(ref))
        .forEach((ref) => {
          push({
            severity: 'warning',
            path: `searches[${index}]`,
            message: `saved search references unknown account "${ref}"`,
          });
        });
    });
  }

  // Watcher : rien à surveiller.
  const settings = get(raw, 'settings');
  const watcher = get(settings, 'watcher');
  if (get(watcher, 'enabled') === true) {
    const folders = get(watcher, 'folders');
    if (Array.isArray(folders) && folders.length === 0) {
      push({
        severity: 'warning',
        path: 'settings.watcher.folders',
        message: 'the watcher is enabled with an empty folders list: nothing is watched',
      });
    }
    const imapAccounts = accounts.filter((acc) => get(acc, 'backend') !== 'graph');
    if (accounts.length > 0 && imapAccounts.length === 0) {
      push({
        severity: 'warning',
        path: 'settings.watcher.enabled',
        message:
          'the watcher is enabled but every account uses backend = "graph": real-time watching is IMAP-only, nothing is watched',
      });
    }
  } else {
    // Seulement si l'utilisateur a écrit la clé : le défaut (« notify ») ne
    // doit pas produire un avertissement sur chaque configuration.
    const onNew = get(get(settings, 'hooks'), 'on_new_email');
    if (typeof onNew === 'string' && onNew !== 'none') {
      push({
        severity: 'warning',
        path: 'settings.hooks.on_new_email',
        message: `on_new_email = "${onNew}" but the watcher is off: hooks never receive new-mail events`,
      });
    }
  }

  // MCP_EMAIL_ACCOUNTS : un nom inconnu fait refuser le démarrage au serveur.
  const filter = (env.MCP_EMAIL_ACCOUNTS ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  filter
    .filter((n) => !names.includes(n))
    .forEach((n) => {
      push({
        severity: 'error',
        path: 'MCP_EMAIL_ACCOUNTS',
        message: `MCP_EMAIL_ACCOUNTS (environment) names unknown account "${n}": the server refuses to start`,
      });
    });

  // Configuration par variables d'environnement : le fichier est alors ignoré.
  if (env.MCP_EMAIL_ADDRESS && env.MCP_EMAIL_IMAP_HOST && env.MCP_EMAIL_SMTP_HOST) {
    push({
      severity: 'warning',
      path: 'MCP_EMAIL_ADDRESS',
      message:
        'MCP_EMAIL_ADDRESS / MCP_EMAIL_IMAP_HOST / MCP_EMAIL_SMTP_HOST are set: when a password or oauth2 variable is also set, the server uses the environment and ignores this file',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

/** Chemin zod (`['accounts', 1, 'imap', 'port']`) → `accounts[1].imap.port`. */
function formatZodPath(issuePath: readonly PropertyKey[]): string {
  return issuePath.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`;
    return acc ? `${acc}.${String(seg)}` : String(seg);
  }, '');
}

function count(issues: ValidationIssue[]): Pick<ValidationReport, 'errorCount' | 'warningCount'> {
  return {
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** Valide le contenu d'un config.toml, sans rien résoudre ni se connecter. */
export function validateConfigContent(
  content: string,
  opts: ValidateOptions = {},
): ValidationReport {
  let parsed: unknown;
  try {
    parsed = parseTOML(content);
  } catch (err) {
    const { line, column } = err as { line?: unknown; column?: unknown };
    // Première ligne seulement : la suite du message de smol-toml recopie le
    // fichier autour de l'erreur, secrets compris.
    const reason = (err instanceof Error ? err.message : String(err))
      .split('\n')[0]
      .replace(/^Invalid TOML document:\s*/, '');
    let message = `TOML syntax error: ${reason}`;
    if (typeof line === 'number') {
      message += ` (line ${line}${typeof column === 'number' ? `, column ${column}` : ''})`;
      const excerpt = safeExcerpt(content.split(/\r?\n/)[line - 1] ?? '');
      message +=
        excerpt === undefined ? ' — line not shown (may hold a secret)' : `\n  > ${excerpt}`;
    }
    const issues: ValidationIssue[] = [{ severity: 'error', kind: 'syntax', message }];
    return { issues, ...count(issues), syntaxOk: false, schemaOk: false };
  }

  const issues: ValidationIssue[] = [];

  const result = AppConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    result.error.issues.forEach((issue) => {
      const p = formatZodPath(issue.path);
      issues.push({
        severity: 'error',
        kind: 'schema',
        path: p || '(root)',
        account: accountOfPath(parsed, p),
        message: issue.message,
      });
    });
  }

  findUnknownKeys(parsed).forEach((u) => {
    issues.push({
      severity: 'warning',
      kind: 'unknown-key',
      path: u.path,
      account: accountOfPath(parsed, u.path),
      message: u.suggestion
        ? `unknown key, ignored by the server — did you mean "${u.suggestion}"?`
        : 'unknown key, ignored by the server',
    });
  });

  findConsistencyIssues(parsed, opts).forEach((issue) => {
    issues.push({ ...issue, kind: 'consistency' });
  });

  return { issues, ...count(issues), syntaxOk: true, schemaOk: result.success };
}

const KIND_TITLE: Record<ValidationIssue['kind'], string> = {
  syntax: 'TOML syntax',
  schema: 'Schema',
  'unknown-key': 'Unknown keys',
  consistency: 'Consistency',
};

/** Rapport lisible, ligne par ligne (aucune valeur de champ n'y figure). */
export function formatValidationReport(report: ValidationReport, file: string): string[] {
  const lines = [`Validating ${file}`, ''];
  const kinds: ValidationIssue['kind'][] = ['syntax', 'schema', 'unknown-key', 'consistency'];
  kinds.forEach((kind) => {
    if (kind !== 'syntax' && !report.syntaxOk) return;
    const ofKind = report.issues.filter((i) => i.kind === kind);
    if (ofKind.length === 0) {
      lines.push(`OK    ${KIND_TITLE[kind]}`);
      return;
    }
    lines.push(
      `${ofKind.some((i) => i.severity === 'error') ? 'FAIL' : 'WARN'}  ${KIND_TITLE[kind]}`,
    );
    ofKind.forEach((i) => {
      const tag = i.severity === 'error' ? 'error  ' : 'warning';
      const where = i.path ? `${i.path}${i.account ? ` (account "${i.account}")` : ''}: ` : '';
      lines.push(`      ${tag} ${where}${i.message}`);
    });
  });
  lines.push('');
  if (report.errorCount > 0) {
    lines.push(
      `Config invalid — ${report.errorCount} error(s), ${report.warningCount} warning(s).`,
    );
  } else {
    lines.push(`Config valid — ${report.warningCount} warning(s).`);
    lines.push('Secrets and connections were not checked: run `email-mcp test` for that.');
  }
  return lines;
}
