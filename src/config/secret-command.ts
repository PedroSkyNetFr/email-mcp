/**
 * Indirection des secrets — champs de configuration `*_command`.
 *
 * Les identifiants de `config.toml` y sont en clair : mots de passe des boîtes,
 * secret client OAuth2, jeton de rafraîchissement. Chiffrer le fichier sur place
 * n'apporterait pas grand-chose : le serveur doit remettre le secret en clair au
 * fournisseur de messagerie tout seul, au démarrage, sans personne pour
 * déverrouiller quoi que ce soit — la clé qu'il utiliserait serait donc
 * accessible à tout code tournant sous le même utilisateur.
 *
 * Ce qui aide, c'est de ne pas détenir le secret du tout. `password_command`,
 * `client_secret_command` et `refresh_token_command` désignent une commande ;
 * le serveur l'exécute au chargement et lit le secret sur sa sortie standard.
 * Le coffre à l'autre bout est au choix de l'utilisateur — KeePassXC,
 * Bitwarden, 1Password, `pass`, le Gestionnaire d'identifiants Windows — puisque
 * le contrat se résume à « imprimer le secret et sortir avec le code 0 ».
 *
 * La commande passe par le shell de la plateforme (`cmd.exe` sous Windows, `sh`
 * ailleurs) : c'est ce qui fait fonctionner tels quels les one-liners publiés
 * par ces outils. Ce n'est pas une surface d'attaque nouvelle : qui peut écrire
 * dans `config.toml` peut déjà lire les secrets qu'il contient.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { RawAppConfig } from './schema.js';

const execAsync = promisify(exec);

/**
 * Durée maximale d'une commande de secret. Le serveur est lancé par un client
 * MCP sans terminal : un coffre qui déciderait de demander une phrase de passe
 * bloquerait tout le processus, sans rien à l'écran pour l'expliquer.
 */
export const SECRET_COMMAND_TIMEOUT_MS = 30_000;

/** Longueur maximale de l'extrait de stderr repris dans un message d'erreur. */
const STDERR_EXCERPT = 400;

/**
 * Exécute une commande de secret et renvoie ce qu'elle a imprimé.
 *
 * `label` identifie le champ dans chaque erreur — « account "work"
 * password_command » — car un échec ici apparaît au démarrage du serveur, loin
 * du fichier de configuration.
 */
export async function runSecretCommand(command: string, label: string): Promise<string> {
  let stdout: string;
  let stderr: string;

  try {
    ({ stdout, stderr } = await execAsync(command, {
      timeout: SECRET_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf-8',
    }));
  } catch (err) {
    const failure = err as { killed?: boolean; code?: number; stderr?: string };

    if (failure.killed) {
      throw new Error(
        `${label} timed out after ${SECRET_COMMAND_TIMEOUT_MS / 1000}s: ${command}\n` +
          'The command must be non-interactive — the server runs with no terminal, so a ' +
          'vault waiting for a passphrase never gets one.',
      );
    }

    const detail = failure.stderr?.trim().slice(0, STDERR_EXCERPT);
    const exit = failure.code === undefined ? '' : ` (exit ${failure.code})`;
    throw new Error(`${label} failed${exit}: ${command}${detail ? `\n${detail}` : ''}`);
  }

  // Seuls les sauts de ligne finaux sont retirés : un mot de passe peut
  // légitimement finir par une espace, et la rogner en silence ferait échouer
  // l'authentification sans raison visible. Les gestionnaires de mots de passe
  // impriment le secret suivi d'un saut de ligne.
  const secret = stdout.replace(/[\r\n]+$/, '');

  if (secret.length === 0) {
    const detail = stderr.trim().slice(0, STDERR_EXCERPT);
    throw new Error(
      `${label} printed nothing: ${command}${detail ? `\n${detail}` : ''}\n` +
        `The secret is expected on standard output.`,
    );
  }

  return secret;
}

/**
 * Remplace chaque champ `*_command` par le secret qu'imprime sa commande.
 *
 * S'exécute après le filtre de comptes : une instance restreinte par
 * `MCP_EMAIL_ACCOUNTS` n'interroge le coffre que pour les boîtes qu'elle sert
 * réellement — trois instances du serveur ne font pas trois fois les demandes.
 *
 * Les commandes s'exécutent l'une après l'autre plutôt qu'en même temps : un
 * coffre verrouillé qui demande à être ouvert doit le faire une fois, pas dans
 * cinq fenêtres simultanées.
 */
export async function resolveSecretCommands(raw: RawAppConfig): Promise<RawAppConfig> {
  const needsResolution = raw.accounts.some(
    (account) =>
      account.password_command ??
      account.oauth2?.client_secret_command ??
      account.oauth2?.refresh_token_command,
  );

  if (!needsResolution) {
    return raw;
  }

  const accounts = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const account of raw.accounts) {
    const resolved = { ...account };

    if (account.password_command) {
      // eslint-disable-next-line no-await-in-loop
      resolved.password = await runSecretCommand(
        account.password_command,
        `account "${account.name}" password_command`,
      );
    }

    if (account.oauth2?.client_secret_command) {
      resolved.oauth2 = {
        ...account.oauth2,
        // eslint-disable-next-line no-await-in-loop
        client_secret: await runSecretCommand(
          account.oauth2.client_secret_command,
          `account "${account.name}" oauth2.client_secret_command`,
        ),
      };
    }

    if (account.oauth2?.refresh_token_command) {
      resolved.oauth2 = {
        ...(resolved.oauth2 ?? account.oauth2),
        // eslint-disable-next-line no-await-in-loop
        refresh_token: await runSecretCommand(
          account.oauth2.refresh_token_command,
          `account "${account.name}" oauth2.refresh_token_command`,
        ),
      };
    }

    accounts.push(resolved);
  }

  return { ...raw, accounts };
}
