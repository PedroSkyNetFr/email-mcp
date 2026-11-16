import {
  findUnknownKeys,
  formatValidationReport,
  levenshtein,
  nearestKey,
  safeExcerpt,
  validateConfigContent,
} from './validate.js';

// Configuration minimale valide ; chaque test y ajoute son défaut.
const BASE = `
[[accounts]]
name = "perso"
email = "perso@example.com"
password = "hunter2-secret"

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.example.com"
port = 465
tls = true
`;

const noEnv = { env: {}, fileExists: () => true };

function messages(content: string, opts = noEnv): string[] {
  return validateConfigContent(content, opts).issues.map(
    (i) => `${i.severity}|${i.kind}|${i.path ?? ''}|${i.message}`,
  );
}

describe('validateConfigContent', () => {
  it('accepts a clean config', () => {
    const report = validateConfigContent(BASE, noEnv);
    expect(report.issues).toEqual([]);
    expect(report.errorCount).toBe(0);
  });

  it('reports a TOML syntax error with line and column, without leaking the secret line', () => {
    const broken = BASE.replace('password = "hunter2-secret"', 'password = "hunter2-secret');
    const report = validateConfigContent(broken, noEnv);
    expect(report.syntaxOk).toBe(false);
    expect(report.errorCount).toBe(1);
    const [issue] = report.issues;
    expect(issue.message).toMatch(/line \d+, column \d+/);
    // Le message brut de smol-toml cite le fichier autour de l'erreur.
    expect(issue.message).not.toContain('hunter2');
  });

  it('shows the offending line when it holds no secret', () => {
    const broken = BASE.replace('port = 993', 'port = = 993');
    const [issue] = validateConfigContent(broken, noEnv).issues;
    expect(issue.message).toContain('> port = = 993');
  });

  it('reports schema errors with the field path and the account name', () => {
    const bad = BASE.replace('port = 993', 'port = "993"').replace(
      'name = "perso"',
      'name = "perso"\nreply_language = "de"',
    );
    const report = validateConfigContent(bad, noEnv);
    const schema = report.issues.filter((i) => i.kind === 'schema');
    expect(schema.map((i) => i.path)).toEqual(
      expect.arrayContaining(['accounts[0].imap.port', 'accounts[0].reply_language']),
    );
    expect(schema.every((i) => i.account === 'perso')).toBe(true);
    expect(report.errorCount).toBeGreaterThanOrEqual(2);
  });

  it('rejects a negative sent_retention_days', () => {
    const bad = `[settings.scheduler]\nsent_retention_days = -1\n${BASE}`;
    expect(messages(bad).some((m) => m.includes('settings.scheduler.sent_retention_days'))).toBe(
      true,
    );
  });

  it('flags password and password_command together (schema)', () => {
    const bad = BASE.replace(
      'password = "hunter2-secret"',
      'password = "hunter2-secret"\npassword_command = "pass show mail"',
    );
    const report = validateConfigContent(bad, noEnv);
    expect(report.issues.some((i) => i.message.includes('not both'))).toBe(true);
    // Ni le mot de passe ni la commande ne sont recopiés.
    const text = formatValidationReport(report, 'config.toml').join('\n');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('pass show');
  });

  it('reports unknown keys with a did-you-mean suggestion', () => {
    const bad = BASE.replace(
      'password = "hunter2-secret"',
      'pasword_command = "pass show mail"',
    ).replace('tls = true\n\n[accounts.smtp]', 'tsl = true\n\n[accounts.smtp]');
    const unknown = validateConfigContent(bad, noEnv).issues.filter(
      (i) => i.kind === 'unknown-key',
    );
    expect(unknown.map((i) => i.path)).toEqual(
      expect.arrayContaining(['accounts[0].pasword_command', 'accounts[0].imap.tsl']),
    );
    expect(unknown.find((i) => i.path === 'accounts[0].pasword_command')?.message).toContain(
      '"password_command"',
    );
    expect(unknown.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('flags duplicate account names', () => {
    const dup = `${BASE}\n${BASE}`;
    expect(messages(dup).some((m) => m.startsWith('error|consistency|accounts[1].name'))).toBe(
      true,
    );
  });

  it('flags a Graph account without oauth2, and a Google token on Graph', () => {
    const noOauth = BASE.replace('name = "perso"', 'name = "perso"\nbackend = "graph"');
    expect(messages(noOauth).some((m) => m.includes('needs an [accounts.oauth2] block'))).toBe(
      true,
    );
    const google = noOauth
      .replace('password = "hunter2-secret"', '')
      .concat(
        '\n[accounts.oauth2]\nprovider = "google"\nclient_id = "x"\nclient_secret = "s"\nrefresh_token = "r"\n',
      );
    expect(messages(google).some((m) => m.includes('only accepts Microsoft tokens'))).toBe(true);
  });

  it('warns when tls and starttls are both true, or when the port contradicts tls', () => {
    const both = BASE.replace('port = 993\ntls = true', 'port = 993\ntls = true\nstarttls = true');
    expect(messages(both).some((m) => m.includes('accounts[0].imap|tls and starttls'))).toBe(true);
    const port = BASE.replace('port = 465\ntls = true', 'port = 587\ntls = true');
    expect(messages(port).some((m) => m.includes('accounts[0].smtp.port|port 587'))).toBe(true);
    const plain = BASE.replace('port = 993\ntls = true', 'port = 993\ntls = false');
    expect(messages(plain).some((m) => m.includes('accounts[0].imap.port|port 993'))).toBe(true);
  });

  it('flags signature_default without signature_path, and a missing signature file', () => {
    const noPath = BASE.replace('name = "perso"', 'name = "perso"\nsignature_default = true');
    expect(
      messages(noPath).some((m) => m.startsWith('error|consistency|accounts[0].signature_default')),
    ).toBe(true);
    const missing = BASE.replace(
      'name = "perso"',
      'name = "perso"\nsignature_path = "C:/nope.htm"',
    );
    expect(
      messages(missing, { env: {}, fileExists: () => false }).some((m) =>
        m.includes('accounts[0].signature_path'),
      ),
    ).toBe(true);
  });

  it('flags MCP_EMAIL_ACCOUNTS naming an absent account', () => {
    const report = validateConfigContent(BASE, {
      env: { MCP_EMAIL_ACCOUNTS: 'perso, travail' },
      fileExists: () => true,
    });
    expect(report.errorCount).toBe(1);
    expect(report.issues[0].message).toContain('"travail"');
  });

  it('flags saved searches pointing to an unknown account', () => {
    const withSearch = `${BASE}\n[[searches]]\nname = "s"\naccount = "boulot"\n`;
    expect(messages(withSearch).some((m) => m.includes('unknown account "boulot"'))).toBe(true);
  });

  it('warns about hooks without the watcher only when on_new_email is written', () => {
    expect(messages(BASE)).toEqual([]);
    const hooks = `[settings.hooks]\non_new_email = "triage"\n${BASE}`;
    expect(messages(hooks).some((m) => m.includes('the watcher is off'))).toBe(true);
  });

  it('warns that the watcher has nothing to watch when all accounts are Graph', () => {
    const graph = `[settings.watcher]\nenabled = true\n${BASE.replace(
      'name = "perso"',
      'name = "perso"\nbackend = "graph"',
    )}`;
    expect(messages(graph).some((m) => m.includes('real-time watching is IMAP-only'))).toBe(true);
  });
});

describe('helpers', () => {
  it('computes edit distance and suggests close keys only', () => {
    expect(levenshtein('pasword', 'password')).toBe(1);
    expect(nearestKey('pasword', ['password', 'email'])).toBe('password');
    expect(nearestKey('zzzzzz', ['password', 'email'])).toBeUndefined();
  });

  it('walks nested arrays of tables', () => {
    expect(
      findUnknownKeys({ settings: { hooks: { rules: [{ name: 'r', match: {}, actons: {} }] } } }),
    ).toEqual([{ path: 'settings.hooks.rules[0].actons', suggestion: 'actions' }]);
  });

  it('masks secret lines in excerpts', () => {
    expect(safeExcerpt('client_secret = "abc')).toBe('client_secret = ***');
    expect(safeExcerpt('password_command = "op read x"')).toBe('password_command = ***');
    expect(safeExcerpt('  continuation of a multiline secret')).toBeUndefined();
    expect(safeExcerpt('[accounts.imap]')).toBe('[accounts.imap]');
  });
});
