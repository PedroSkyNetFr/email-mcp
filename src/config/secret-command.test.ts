import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppConfigFileSchema } from './schema.js';
import { resolveSecretCommands, runSecretCommand } from './secret-command.js';

/**
 * Les commandes de test sont de petits scripts Node écrits sur disque plutôt
 * que des `node -e "…"` en ligne : la commande passe par le shell de la
 * plateforme, et les guillemets imbriqués ne survivent pas de la même façon à
 * `cmd.exe` et à `sh`. Un chemin entre guillemets, lui, marche partout.
 */
describe('secret-command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-secret-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Écrit un script et rend la commande qui l'exécute. */
  async function script(name: string, body: string): Promise<string> {
    const file = path.join(tmpDir, `${name}.cjs`);
    await fs.writeFile(file, body, 'utf-8');
    return `node "${file}"`;
  }

  /** Configuration minimale valide, complétée par les défauts du schéma. */
  function configWith(account: Record<string, unknown>) {
    return AppConfigFileSchema.parse({
      accounts: [
        {
          name: 'work',
          email: 'work@example.com',
          imap: { host: 'imap.example.com' },
          smtp: { host: 'smtp.example.com' },
          ...account,
        },
      ],
    });
  }

  describe('runSecretCommand', () => {
    it('rend ce que la commande imprime, sans le saut de ligne final', async () => {
      const cmd = await script('ok', "process.stdout.write('s3cret\\n');");

      await expect(runSecretCommand(cmd, 'test')).resolves.toBe('s3cret');
    });

    it('conserve une espace finale : seuls les sauts de ligne sont retirés', async () => {
      // Un mot de passe peut légitimement finir par une espace. La rogner
      // ferait échouer l'authentification sans rien afficher d'explicite.
      const cmd = await script('space', "process.stdout.write('a b \\n');");

      await expect(runSecretCommand(cmd, 'test')).resolves.toBe('a b ');
    });

    it("signale un échec avec son code de sortie et l'extrait de stderr", async () => {
      const cmd = await script('fail', "process.stderr.write('vault locked\\n');process.exit(3);");

      await expect(runSecretCommand(cmd, 'account "work" password_command')).rejects.toThrow(
        /account "work" password_command failed \(exit 3\)[\s\S]*vault locked/,
      );
    });

    it('refuse une sortie vide au lieu de rendre un secret vide', async () => {
      const cmd = await script('empty', '');

      await expect(runSecretCommand(cmd, 'test')).rejects.toThrow(/printed nothing/);
    });
  });

  describe('resolveSecretCommands', () => {
    it('remplit password depuis password_command', async () => {
      const raw = configWith({
        password_command: await script('pw', "process.stdout.write('p4ss');"),
      });

      const resolved = await resolveSecretCommands(raw);

      expect(resolved.accounts[0].password).toBe('p4ss');
    });

    it("laisse un mot de passe littéral intact et n'exécute rien", async () => {
      const raw = configWith({ password: 'literal' });

      const resolved = await resolveSecretCommands(raw);

      // Rien à résoudre : l'objet d'origine est rendu tel quel.
      expect(resolved).toBe(raw);
      expect(resolved.accounts[0].password).toBe('literal');
    });

    it('résout les deux secrets OAuth2', async () => {
      const raw = configWith({
        oauth2: {
          provider: 'microsoft',
          client_id: 'app-id',
          client_secret_command: await script('cs', "process.stdout.write('shhh');"),
          refresh_token_command: await script('rt', "process.stdout.write('0.AXkA');"),
        },
      });

      const resolved = await resolveSecretCommands(raw);

      expect(resolved.accounts[0].oauth2?.client_secret).toBe('shhh');
      expect(resolved.accounts[0].oauth2?.refresh_token).toBe('0.AXkA');
      // client_id n'est pas un secret : il reste tel quel.
      expect(resolved.accounts[0].oauth2?.client_id).toBe('app-id');
    });

    it('nomme le compte et le champ fautifs', async () => {
      const raw = configWith({
        name: 'gallais_ConducteurTravaux',
        password_command: await script('boom', 'process.exit(1);'),
      });

      await expect(resolveSecretCommands(raw)).rejects.toThrow(
        /account "gallais_ConducteurTravaux" password_command/,
      );
    });
  });
});
