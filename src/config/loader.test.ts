import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ACCOUNTS_FILTER_ENV,
  configExists,
  generateTemplate,
  loadConfig,
  saveConfig,
} from './loader.js';

const MINIMAL_TOML = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

const THREE_ACCOUNTS_TOML = `
[[accounts]]
name = "first"
email = "first@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"

[[accounts]]
name = "second"
email = "second@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"

[[accounts]]
name = "third"
email = "third@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

const MCP_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith('MCP_EMAIL_'));

describe('Config Loader', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-test-'));

    // Save and clear all MCP_EMAIL_* env vars
    for (const key of MCP_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Also clear the standard ones we set in tests
    for (const key of [
      'MCP_EMAIL_ADDRESS',
      'MCP_EMAIL_PASSWORD',
      'MCP_EMAIL_IMAP_HOST',
      'MCP_EMAIL_SMTP_HOST',
      'MCP_EMAIL_READ_ONLY',
      'MCP_EMAIL_ACCOUNT_NAME',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });

    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // -------------------------------------------------------------------------
  // loadConfig from TOML file
  // -------------------------------------------------------------------------

  describe('loadConfig from TOML file', () => {
    it('loads a valid TOML config file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].name).toBe('test');
      expect(config.accounts[0].email).toBe('test@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.example.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.example.com');
    });

    it('throws when config file does not exist', async () => {
      const badPath = path.join(tmpDir, 'nonexistent.toml');
      await expect(loadConfig(badPath)).rejects.toThrow('No configuration found');
    });

    it('normalizes snake_case to camelCase', async () => {
      const toml = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"
verify_ssl = false

[accounts.smtp]
host = "smtp.example.com"
verify_ssl = false

[settings]
rate_limit = 5
read_only = true
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, toml, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.accounts[0].imap.verifySsl).toBe(false);
      expect(config.accounts[0].smtp.verifySsl).toBe(false);
      expect(config.settings.rateLimit).toBe(5);
      expect(config.settings.readOnly).toBe(true);
    });

    it('applies default values for optional fields', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      // Account defaults
      expect(config.accounts[0].imap.port).toBe(993);
      expect(config.accounts[0].imap.tls).toBe(true);
      expect(config.accounts[0].imap.verifySsl).toBe(true);
      expect(config.accounts[0].smtp.port).toBe(465);
      expect(config.accounts[0].smtp.pool?.enabled).toBe(true);
      expect(config.accounts[0].smtp.pool?.maxConnections).toBe(1);

      // Settings defaults
      expect(config.settings.rateLimit).toBe(10);
      expect(config.settings.readOnly).toBe(false);
      expect(config.settings.watcher.enabled).toBe(false);
      expect(config.settings.watcher.folders).toEqual(['INBOX']);
      expect(config.settings.hooks.onNewEmail).toBe('notify');
      expect(config.settings.hooks.preset).toBe('priority-focus');
    });
  });

  // -------------------------------------------------------------------------
  // loadConfig from environment variables
  // -------------------------------------------------------------------------

  describe('loadConfig from environment variables', () => {
    it('loads config from env vars when set', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].email).toBe('env@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.env.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.env.com');
    });

    it('reads read_only from MCP_EMAIL_READ_ONLY', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';
      process.env.MCP_EMAIL_READ_ONLY = 'true';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.settings.readOnly).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // saveConfig
  // -------------------------------------------------------------------------

  describe('saveConfig', () => {
    it('saves config as TOML and can be re-read', async () => {
      const configPath = path.join(tmpDir, 'saved.toml');

      // Write minimal TOML first, load it as raw, then save and re-load
      const srcPath = path.join(tmpDir, 'source.toml');
      await fs.writeFile(srcPath, MINIMAL_TOML, 'utf-8');
      await loadConfig(srcPath);

      // Build a RawAppConfig to save
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };

      await saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath);

      const reloaded = await loadConfig(configPath);
      expect(reloaded.accounts[0].name).toBe('saved-test');
      expect(reloaded.accounts[0].email).toBe('saved@example.com');
      expect(reloaded.accounts[0].imap.host).toBe('imap.saved.com');
    });
  });

  // -------------------------------------------------------------------------
  // configExists
  // -------------------------------------------------------------------------

  describe('configExists', () => {
    it('returns true for existing file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      expect(await configExists(configPath)).toBe(true);
    });

    it('returns false for non-existing file', async () => {
      const badPath = path.join(tmpDir, 'nope.toml');

      expect(await configExists(badPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // generateTemplate
  // -------------------------------------------------------------------------

  describe('generateTemplate', () => {
    it('returns valid TOML template string', () => {
      const template = generateTemplate();

      expect(typeof template).toBe('string');
      expect(template).toContain('[[accounts]]');
      expect(template).toContain('[accounts.imap]');
      expect(template).toContain('[accounts.smtp]');
      expect(template).toContain('[settings]');
      expect(template).toContain('rate_limit');
    });
  });

  // -------------------------------------------------------------------------
  // [database] section + EMAIL_MCP_DATABASE_URL precedence (D-Open-Q1 / D20)
  // -------------------------------------------------------------------------

  describe('database config', () => {
    afterEach(() => {
      delete process.env.EMAIL_MCP_DATABASE_URL;
    });

    it('is undefined when neither [database] nor env var is set', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.database).toBeUndefined();
    });

    it('reads [database].url from the TOML file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(
        configPath,
        `${MINIMAL_TOML}\n[database]\nurl = "postgresql://email_mcp:pw@192.168.1.200:5433/email_mcp"\n`,
        'utf-8',
      );

      const config = await loadConfig(configPath);

      expect(config.database?.url).toBe('postgresql://email_mcp:pw@192.168.1.200:5433/email_mcp');
    });

    it('EMAIL_MCP_DATABASE_URL overrides the TOML value', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(
        configPath,
        `${MINIMAL_TOML}\n[database]\nurl = "postgresql://from-toml/db"\n`,
        'utf-8',
      );
      process.env.EMAIL_MCP_DATABASE_URL = 'postgresql://from-env/db';

      const config = await loadConfig(configPath);

      expect(config.database?.url).toBe('postgresql://from-env/db');
    });

    it('EMAIL_MCP_DATABASE_URL applies even with no [database] section', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
      process.env.EMAIL_MCP_DATABASE_URL = 'postgresql://env-only/db';

      const config = await loadConfig(configPath);

      expect(config.database?.url).toBe('postgresql://env-only/db');
    });

    it('rejects an empty [database].url', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, `${MINIMAL_TOML}\n[database]\nurl = ""\n`, 'utf-8');

      await expect(loadConfig(configPath)).rejects.toThrow();
    });
  });

  describe('filtre de comptes (MCP_EMAIL_ACCOUNTS)', () => {
    /**
     * Un client MCP n'a pas d'interrupteur par compte : il active ou coupe un
     * serveur entier. Cette variable permet à un même config.toml d'alimenter
     * plusieurs entrées de connecteur, chacune n'exposant que ses comptes.
     */
    afterEach(() => {
      delete process.env[ACCOUNTS_FILTER_ENV];
    });

    it('expose tous les comptes quand la variable est absente', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, THREE_ACCOUNTS_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.accounts.map((a) => a.name)).toEqual(['first', 'second', 'third']);
    });

    it('ne garde que les comptes nommés', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, THREE_ACCOUNTS_TOML, 'utf-8');
      process.env[ACCOUNTS_FILTER_ENV] = 'first,third';

      const config = await loadConfig(configPath);

      expect(config.accounts.map((a) => a.name)).toEqual(['first', 'third']);
    });

    it('tolère les espaces et les séparateurs vides', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, THREE_ACCOUNTS_TOML, 'utf-8');
      process.env[ACCOUNTS_FILTER_ENV] = ' second , , third ';

      const config = await loadConfig(configPath);

      expect(config.accounts.map((a) => a.name)).toEqual(['second', 'third']);
    });

    it("garde l'ordre du fichier, pas celui de la variable", async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, THREE_ACCOUNTS_TOML, 'utf-8');
      process.env[ACCOUNTS_FILTER_ENV] = 'third,first';

      const config = await loadConfig(configPath);

      // Le premier compte sert de défaut aux recherches enregistrées : il ne
      // doit pas dépendre de la façon dont la liste est saisie.
      expect(config.accounts.map((a) => a.name)).toEqual(['first', 'third']);
    });

    it('ignore une valeur vide', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, THREE_ACCOUNTS_TOML, 'utf-8');
      process.env[ACCOUNTS_FILTER_ENV] = '   ';

      const config = await loadConfig(configPath);

      expect(config.accounts).toHaveLength(3);
    });

    it('refuse un nom inconnu au lieu de servir moins de comptes en silence', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, THREE_ACCOUNTS_TOML, 'utf-8');
      process.env[ACCOUNTS_FILTER_ENV] = 'first,frist';

      // Une faute de frappe dans la config du client réduirait sans bruit ce que
      // l'instance dessert — l'erreur nomme le fautif et les comptes valides.
      await expect(loadConfig(configPath)).rejects.toThrow(/frist/);
      await expect(loadConfig(configPath)).rejects.toThrow(/first, second, third/);
    });

    it("s'applique aussi à une configuration issue des variables d'environnement", async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'secret';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.example.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.example.com';
      process.env.MCP_EMAIL_ACCOUNT_NAME = 'envAccount';
      process.env[ACCOUNTS_FILTER_ENV] = 'envAccount';

      const config = await loadConfig();

      expect(config.accounts.map((a) => a.name)).toEqual(['envAccount']);
    });
  });

  describe('secrets par commande (password_command)', () => {
    /**
     * Le secret n'est plus dans le fichier : une commande l'imprime au
     * chargement. Ces cas vérifient le bout en bout — schéma, filtre de
     * comptes, résolution — pas seulement la résolution isolée.
     */
    afterEach(() => {
      delete process.env[ACCOUNTS_FILTER_ENV];
    });

    /** Écrit un script Node et rend la commande qui l'exécute. */
    async function script(name: string, body: string): Promise<string> {
      const file = path.join(tmpDir, `${name}.cjs`);
      await fs.writeFile(file, body, 'utf-8');
      return `node "${file}"`;
    }

    it('remplace le mot de passe par la sortie de la commande', async () => {
      const command = await script('pw', "process.stdout.write('depuis-le-coffre');");
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(
        configPath,
        `
[[accounts]]
name = "vault"
email = "vault@example.com"
password_command = '${command}'

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`,
        'utf-8',
      );

      const config = await loadConfig(configPath);

      expect(config.accounts[0].password).toBe('depuis-le-coffre');
    });

    it("n'interroge pas le coffre pour un compte écarté par le filtre", async () => {
      // Trois connecteurs pointant sur le même fichier ne doivent pas provoquer
      // trois fois les demandes de déverrouillage : seuls les comptes servis
      // par l'instance sont résolus.
      const failing = await script('locked', 'process.exit(1);');
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(
        configPath,
        `
[[accounts]]
name = "served"
email = "served@example.com"
password = "literal"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"

[[accounts]]
name = "hidden"
email = "hidden@example.com"
password_command = '${failing}'

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`,
        'utf-8',
      );

      // Sans filtre, la commande du second compte s'exécute et échoue.
      await expect(loadConfig(configPath)).rejects.toThrow(/hidden/);

      // Filtrée, elle n'est jamais lancée.
      process.env[ACCOUNTS_FILTER_ENV] = 'served';
      const config = await loadConfig(configPath);
      expect(config.accounts.map((a) => a.name)).toEqual(['served']);
    });

    it('refuse un compte qui donne à la fois password et password_command', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(
        configPath,
        `
[[accounts]]
name = "ambigu"
email = "ambigu@example.com"
password = "literal"
password_command = 'node --version'

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`,
        'utf-8',
      );

      await expect(loadConfig(configPath)).rejects.toThrow();
    });
  });
});
