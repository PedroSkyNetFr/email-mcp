# email-mcp

[![license](https://img.shields.io/github/license/PedroSkyNetFr/email-mcp.svg?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/PedroSkyNetFr/email-mcp/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/PedroSkyNetFr/email-mcp/actions/workflows/ci.yml)

[English](README.md) · **Français**

Un serveur MCP (Model Context Protocol) qui donne à un assistant IA — Claude
Desktop ou tout autre client MCP — un client de messagerie complet : lire,
rechercher, exporter, rédiger, envoyer, programmer et ranger le courrier de
plusieurs comptes. Les boîtes sont jointes en **IMAP + SMTP**, ou via
**Microsoft Graph** pour les comptes Exchange Online et Outlook.com, dont l'accès
IMAP masque une partie de la boîte.

Le serveur expose **64 outils** (35 en lecture seule), **7 prompts** et
**6 ressources**.

> **À propos de ce fork.** Ce dépôt est un fork maintenu par
> [@PedroSkyNetFr](https://github.com/PedroSkyNetFr). Le paquet npm
> `@codefuturist/email-mcp` et les images Docker
> `ghcr.io/codefuturist/email-mcp` / `codefuturist/email-mcp` sont publiés par le
> projet **d'origine** et ne contiennent **pas** les changements de ce fork
> (backend Microsoft Graph, export `.eml`, commandes de secrets, rapports de
> couverture de recherche, …). Installez ce fork depuis les sources, comme décrit
> ci-dessous.

## Sommaire

- [Points forts](#points-forts)
- [Installation](#installation)
- [Configuration](#configuration)
- [Connecter un client MCP](#connecter-un-client-mcp)
- [Ligne de commande](#ligne-de-commande)
- [Référence des outils](#référence-des-outils)
- [Prompts et ressources](#prompts-et-ressources)
- [Recherche](#recherche)
- [Export et enregistrement sur disque](#export-et-enregistrement-sur-disque)
- [Brouillons, pièces jointes et signatures](#brouillons-pièces-jointes-et-signatures)
- [En-têtes Internet](#en-têtes-internet)
- [Calendrier et rappels](#calendrier-et-rappels)
- [Surveillance, notifications et hooks IA](#surveillance-notifications-et-hooks-ia)
- [Envoi programmé](#envoi-programmé)
- [Gestion de la boîte](#gestion-de-la-boîte)
- [Sécurité](#sécurité)
- [Dépannage](#dépannage)
- [Architecture](#architecture)
- [Développement et contribution](#développement-et-contribution)
- [Mainteneur](#mainteneur)
- [Historique et crédits](#historique-et-crédits)
- [Licence](#licence)

## Points forts

- **Multi-comptes**, comptes IMAP et Microsoft Graph côte à côte ; chaque appel
  d'outil nomme le compte sur lequel il agit.
- **Une recherche qui dit quand elle est incomplète** : filtres côté serveur,
  filtres littéraux `*_contains`, filtres sur les pièces jointes, dates relatives
  (`7d`, `yesterday`), facettes, syntaxe native Gmail, recherche sur tous les
  comptes. Un parcours interrompu par son budget de temps indique ce qu'il a
  couvert et comment reprendre — jamais de résultat partiel silencieux.
- **Export** : résultats de recherche en CSV/NDJSON, messages en `.eml` (source
  exacte), pièces jointes directement sur disque.
- **Rédaction** : envoi, réponse, transfert, brouillons qui gardent leurs pièces
  jointes, modèles, images intégrées (`cid`), signature Outlook automatique avec
  son logo.
- **Analyse** : en-têtes Internet complets avec la chaîne Received, les verdicts
  SPF/DKIM/DMARC et l'alignement des domaines.
- **Rangement** : déplacer, supprimer, marquer, libellés (Gmail, ProtonMail, mots
  clés IMAP, catégories Exchange), dossiers, actions groupées, déplacement entre
  comptes, règles côté serveur et réponse automatique Exchange.
- **Automatisation** : envoi programmé (avec une tâche système sous macOS, Linux
  et Windows), surveillance IMAP IDLE avec règles statiques, tri par IA et
  alertes bureau/webhook, extraction d'événements et de rappels.
- **Sûreté** : mode lecture seule, identifiants lus dans un gestionnaire de mots
  de passe, liste blanche des dossiers d'écriture, limite d'envoi, journal
  d'audit.

## Installation

### Prérequis

- **Node.js ≥ 24** (`engines` dans `package.json`).
- **pnpm** — le dépôt fixe `pnpm@9.15.0` via `packageManager` ;
  `corepack enable` le fournit.
- **git**, pour cloner et recevoir les mises à jour.

### Depuis les sources

```bash
git clone https://github.com/PedroSkyNetFr/email-mcp.git
cd email-mcp
pnpm install      # installe aussi les hooks git (lefthook)
pnpm build        # compile src/ vers dist/ — dist/main.js est ce que lancent les clients
node dist/main.js --help
```

Ensuite, [configurez un compte](#configuration) et
[déclarez le serveur dans votre client MCP](#connecter-un-client-mcp).

### Mise à jour

```bash
git pull
```

`dist/` n'est pas versionné : un pull modifie `src/` mais le client continue
d'exécuter l'ancien code compilé. Les hooks git installés par `pnpm install` s'en
chargent — après un `git pull`, un changement de branche ou un rebase, ils
reconstruisent `dist/`, et réinstallent d'abord les dépendances verrouillées si
`pnpm-lock.yaml` a changé (`scripts/rebuild-after-update.mjs`). Si les hooks
manquent, lancez `pnpm hooks:install`, ou `pnpm install && pnpm build` à la main.

**Puis redémarrez le client MCP.** Un serveur stdio est un processus que le
client lance une fois ; il continue de servir le code avec lequel il a démarré.
`check_health` indique la version réellement en service (version, `dist` ou
`src`, date de compilation) — c'est la première chose à vérifier quand un outil
documenté semble absent.

### Docker (à construire soi-même)

Le dépôt contient un `Dockerfile` (Node 24, multi-étapes) et un
`Dockerfile.alpine`. La CI construit l'image en test de fumée, mais aucune image
de ce fork n'est publiée — construisez la vôtre :

```bash
docker build -t email-mcp-fork .
docker run --rm -i \
  -v ~/.config/email-mcp:/home/node/.config/email-mcp:ro \
  email-mcp-fork
```

Le conteneur exécute `node dist/main.js stdio` et lit sa configuration dans le
dossier monté. Attention : dans un conteneur, les secrets `*_command`,
`signature_path`, les dossiers d'enregistrement et les notifications de bureau
désignent le système de fichiers et les outils du conteneur, pas ceux de l'hôte.

## Configuration

### Emplacement de la configuration

Le fichier de configuration est `config.toml` dans le dossier de configuration
XDG : `$XDG_CONFIG_HOME/email-mcp/config.toml`, par défaut
`~/.config/email-mcp/config.toml` — y compris sous Windows
(`C:\Users\<vous>\.config\email-mcp\config.toml`). `node dist/main.js config path`
l'affiche.

Autres emplacements, également XDG :

| Chemin | Contenu |
|--------|---------|
| `~/.config/email-mcp/templates/` | modèles de message (`*.toml`) |
| `~/.local/state/email-mcp/scheduled/` | file des envois programmés (JSON) |
| `~/.local/state/email-mcp/calendar-processed.json` | messages déjà ajoutés au calendrier |
| `~/.local/share/email-mcp/audit.log` | journal d'audit des opérations d'écriture (JSON Lines) |
| `~/.local/share/email-mcp/calendar-attachments/` | pièces jointes liées aux événements du calendrier |

### Premier compte

```bash
node dist/main.js account add     # assistant interactif (alias : setup)
node dist/main.js test            # teste tous les comptes
```

L'assistant déduit les réglages du serveur du domaine de l'adresse, teste la
connexion et écrit `config.toml`. Il gère les comptes à mot de passe ; les comptes
OAuth2 et Microsoft Graph s'écrivent à la main (voir
[OAuth2 et Microsoft Graph](#oauth2-et-microsoft-graph)).
`config init` écrit plutôt un modèle commenté, et `config.example.toml` dans le
dépôt montre des comptes cPanel, Gmail et iCloud.

Fournisseurs détectés :

| Fournisseur | Domaines |
|-------------|----------|
| Gmail | gmail.com, googlemail.com |
| Outlook / Hotmail | outlook.com, hotmail.com, live.com, outlook.de, outlook.co.uk |
| Yahoo Mail | yahoo.com, yahoo.co.uk, yahoo.de, ymail.com |
| iCloud | icloud.com, me.com, mac.com |
| Fastmail | fastmail.com, fastmail.fm |
| ProtonMail Bridge | proton.me, protonmail.com, protonmail.ch, pm.me |
| Zoho Mail | zoho.com, zohomail.com |
| GMX | gmx.com, gmx.de, gmx.net, gmx.at, gmx.ch |

### Comptes (`[[accounts]]`)

```toml
[[accounts]]
name = "personal"                 # le nom que les outils attendent dans leur paramètre `account`
email = "vous@example.com"
full_name = "Votre Nom"
password_command = 'op read "op://Private/mail/password"'   # ou : password = "..."
signature_path = "C:\\Users\\Vous\\AppData\\Roaming\\Microsoft\\Signatures\\Principale.htm"
signature_default = true

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.example.com"
port = 465
tls = true
```

| Clé | Défaut | Rôle |
|-----|--------|------|
| `name` | *obligatoire* | Nom du compte utilisé par tous les outils. |
| `email` | *obligatoire* | Adresse du compte. |
| `full_name` | — | Nom affiché sur les messages envoyés. |
| `username` | `email` | Identifiant de connexion, s'il diffère de l'adresse. |
| `password` | — | Mot de passe ou mot de passe d'application. |
| `password_command` | — | Commande qui imprime le mot de passe ([secrets](#garder-les-identifiants-hors-du-fichier)). Il faut exactement un de `password`, `password_command` ou un bloc `oauth2`. |
| `oauth2` | — | Bloc OAuth2 (ci-dessous). |
| `backend` | `"imap"` | `"graph"` sert le compte via Microsoft Graph. |
| `sent_folder` | auto | Dossier qui reçoit la copie des messages envoyés (détecté via SPECIAL-USE). |
| `save_to_sent` | `true` | `false` cesse d'ajouter au dossier Envoyés une copie de chaque message envoyé en SMTP. |
| `gmail_auto_save` | `true` | Gmail classe lui-même les messages envoyés, donc l'ajout est omis sur Gmail ; `false` l'ajoute quand même. |
| `signature_path` | — | Signature Outlook `.htm` ajoutée à la demande ([signatures](#signature-outlook)). |
| `signature_default` | `false` | Ajoute la signature à chaque message rédigé, sauf si l'appel dit le contraire. |
| `imap.host` / `smtp.host` | *obligatoire* | Noms des serveurs — exigés par le schéma même pour un compte Graph, qui ne s'en sert pas. |
| `imap.port` | `993` | |
| `smtp.port` | `465` | |
| `imap.tls` / `smtp.tls` | `true` | TLS implicite. |
| `imap.starttls` / `smtp.starttls` | `false` | STARTTLS (pour SMTP sur le port 587 : `tls = false`, `starttls = true`). |
| `imap.verify_ssl` / `smtp.verify_ssl` | `true` | Vérifie le certificat du serveur. |
| `smtp.pool.enabled` | `true` | Réutilise les connexions SMTP. |
| `smtp.pool.max_connections` | `1` | |
| `smtp.pool.max_messages` | `100` | Messages par connexion réutilisée. |

### OAuth2 et Microsoft Graph

```toml
[accounts.oauth2]
provider = "google"               # "google" | "microsoft" | "custom"
client_id = "…"
client_secret_command = "…"       # ou client_secret = "…"
refresh_token_command = "…"       # ou refresh_token = "…"
# provider = "custom" uniquement :
# token_url = "https://…/token"
# auth_url  = "https://…/authorize"
# scopes    = ["…"]
```

Le serveur renouvelle seul le jeton d'accès, mais le premier jeton de
rafraîchissement s'obtient une fois, de façon interactive, avec le script
d'assistance :

```bash
pnpm oauth:setup                  # menu des profils ; demande ce qui manque
pnpm oauth:setup --provider microsoft-graph --client-id <id>
```

Il ouvre la page de consentement du fournisseur, reçoit la redirection sur
`http://localhost:3000/callback` (déclarez exactement cette URI chez le
fournisseur ; `--port` la change) et affiche le jeton de rafraîchissement.
Passez le secret client par `OAUTH_CLIENT_SECRET` (et l'identifiant par
`OAUTH_CLIENT_ID`) pour le garder hors de l'historique du shell ; sinon il est
demandé en saisie masquée. Sous Windows, `scripts/oauth-setup.cmd` se lance d'un
double-clic.

| Profil | Portées | Usage |
|--------|---------|-------|
| `microsoft` | `IMAP.AccessAsUser.All`, `SMTP.Send` | Microsoft en IMAP/SMTP — des dossiers personnalisés peuvent manquer |
| `microsoft-graph` | `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite` | **Comptes Exchange / Outlook.com avec `backend = "graph"`** |
| `microsoft-graph-readonly` | `Mail.Read` | diagnostic uniquement (`pnpm probe:graph`) — jamais dans la configuration |
| `google` | `https://mail.google.com/` | Gmail en IMAP/SMTP |
| `custom` | les vôtres | `--auth-url`, `--token-url`, `--scopes` |

**Pourquoi Graph.** Exchange Online et Outlook.com ne publient en IMAP qu'un
sous-ensemble ancien de la boîte : des dossiers personnalisés peuvent être
totalement absents de `LIST`, et `list_mailboxes` ne les montre donc pas.
`pnpm diagnose:mailboxes` compare les listes IMAP brutes pour le prouver ;
`pnpm probe:graph` vérifie ce que Graph expose. Un compte en
`backend = "graph"` est lu, modifié et envoyé uniquement via Graph — il ne
retombe jamais sur IMAP, qui renverrait des résultats incomplets sans le dire.

Un compte Graph dans `config.toml`, avec les points d'accès et les portées du
profil `microsoft-graph` :

```toml
[[accounts]]
name = "outlook"
email = "vous@outlook.com"
full_name = "Votre Nom"
backend = "graph"

[accounts.oauth2]
provider = "custom"
client_id = "<identifiant d'application>"
client_secret_command = "…"
refresh_token_command = "…"
auth_url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
scopes = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/MailboxSettings.ReadWrite",
  "offline_access",
]

# Exigés par le schéma, inutilisés par un compte Graph.
[accounts.imap]
host = "outlook.office365.com"

[accounts.smtp]
host = "smtp-mail.outlook.com"
```

Déclarez l'application dans Microsoft Entra ID avec des *types de comptes pris
en charge* qui incluent les comptes Microsoft personnels si vous utilisez une
adresse outlook.com, et une plateforme **Web** avec l'URI de redirection
ci-dessus (l'échange du jeton envoie un secret client, le client doit donc être
confidentiel). Préférez `config.toml` pour les comptes Graph : les variables
d'environnement du mode mono-compte n'ont pas d'équivalent de `token_url` /
`auth_url`.

### Garder les identifiants hors du fichier

`config.toml` contient les identifiants en clair. Trois champs permettent à une
commande de les fournir à la place : le secret reste dans un gestionnaire de mots
de passe et le fichier dit seulement où le chercher.

| Champ | Remplace |
|-------|----------|
| `password_command` | `password` |
| `oauth2.client_secret_command` | `oauth2.client_secret` |
| `oauth2.refresh_token_command` | `oauth2.refresh_token` |

```toml
password_command = 'keepassxc-cli show -q -s -a Password --no-password -k "C:\keys\mail.keyx" "C:\keys\mail.kdbx" "mail/vous@example.com"'
```

Les autres commandes d'une ligne fonctionnent telles quelles, car la commande
passe par le shell de la plateforme (`cmd.exe` sous Windows, `sh` ailleurs) :
`bw get password …` (Bitwarden), `op read "op://…"` (1Password), `pass show …`,
`secret-tool lookup …`, `security find-generic-password … -w` (trousseau macOS).

- Donnez le champ littéral **ou** sa variante `_command`, jamais les deux.
- Le secret est lu sur la sortie standard ; seuls les sauts de ligne finaux sont
  retirés. Une sortie vide est une erreur, pas un mot de passe vide.
- La commande doit être **non interactive** : le serveur n'a pas de terminal, un
  coffre qui demanderait une phrase de passe attendrait indéfiniment. Elle est
  interrompue après 30 secondes avec une erreur explicite. Avec KeePassXC, cela
  suppose une base protégée par fichier clé (`--no-password -k`).
- Les commandes s'exécutent l'une après l'autre, seulement pour les comptes que
  l'instance sert (voir
  [`MCP_EMAIL_ACCOUNTS`](#plusieurs-connecteurs-sur-une-même-configuration)).
- `email-mcp account edit` ne réécrit jamais le secret obtenu dans le fichier.

Le secret sort ainsi des sauvegardes et des dossiers synchronisés ; ce n'est pas
une protection contre du code exécuté sous le même utilisateur, qui peut lancer
la même commande.

### Réglages globaux (`[settings]`)

| Clé | Défaut | Rôle |
|-----|--------|------|
| `rate_limit` | `10` | Nombre maximal de messages envoyés par minute et par compte (envois SMTP). |
| `read_only` | `false` | Mode lecture seule : les outils d'écriture ne sont pas enregistrés et la file des envois programmés n'est pas traitée ([détails](#mode-lecture-seule)). |
| `watcher.enabled` | `false` | Surveillance IMAP IDLE. |
| `watcher.folders` | `["INBOX"]` | Dossiers surveillés dans chaque compte. |
| `watcher.idle_timeout` | `1740` | Renouvellement de l'IDLE, en secondes (60–1740). |
| `hooks.*`, `hooks.alerts.*`, `hooks.rules` | | Voir [surveillance et hooks](#surveillance-notifications-et-hooks-ia). |

Sections facultatives : `[[searches]]` ([recherches enregistrées](#recherches-enregistrées))
et `[database]` ([déplacement entre comptes](#déplacement-entre-comptes)).

### Variables d'environnement

**Mode mono-compte.** Quand `MCP_EMAIL_ADDRESS`, `MCP_EMAIL_IMAP_HOST`,
`MCP_EMAIL_SMTP_HOST` et l'une de `MCP_EMAIL_PASSWORD`,
`MCP_EMAIL_PASSWORD_COMMAND` ou `MCP_EMAIL_OAUTH2_PROVIDER` sont toutes définies,
le serveur construit un compte unique à partir de l'environnement et **ne lit pas
du tout `config.toml`** (aucun autre compte, aucune `[[searches]]`).

| Variable | Défaut | Équivalent TOML |
|----------|--------|-----------------|
| `MCP_EMAIL_ADDRESS` | *obligatoire* | `email` |
| `MCP_EMAIL_IMAP_HOST` / `MCP_EMAIL_SMTP_HOST` | *obligatoire* | `imap.host` / `smtp.host` |
| `MCP_EMAIL_PASSWORD` / `MCP_EMAIL_PASSWORD_COMMAND` | | `password` / `password_command` |
| `MCP_EMAIL_OAUTH2_PROVIDER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` | | `oauth2.*` |
| `MCP_EMAIL_ACCOUNT_NAME` | `default` | `name` |
| `MCP_EMAIL_FULL_NAME`, `MCP_EMAIL_USERNAME` | | `full_name`, `username` |
| `MCP_EMAIL_BACKEND` | `imap` | `backend` (`graph`) |
| `MCP_EMAIL_SIGNATURE_PATH`, `MCP_EMAIL_SIGNATURE_DEFAULT` | | `signature_path`, `signature_default` |
| `MCP_EMAIL_IMAP_PORT`, `_TLS`, `_STARTTLS`, `_VERIFY_SSL` | `993`, `true`, `false`, `true` | `imap.*` |
| `MCP_EMAIL_SMTP_PORT`, `_TLS`, `_STARTTLS`, `_VERIFY_SSL` | `465`, `true`, `false`, `true` | `smtp.*` |
| `MCP_EMAIL_SMTP_POOL_ENABLED`, `_MAX_CONNECTIONS`, `_MAX_MESSAGES` | `true`, `1`, `100` | `smtp.pool.*` |
| `MCP_EMAIL_RATE_LIMIT` | `10` | `settings.rate_limit` |
| `MCP_EMAIL_WATCHER_ENABLED`, `_FOLDERS` (séparés par des virgules), `_IDLE_TIMEOUT` | `false`, `INBOX`, `1740` | `settings.watcher.*` |
| `MCP_EMAIL_HOOK_ON_NEW_EMAIL`, `_PRESET`, `_AUTO_LABEL`, `_AUTO_FLAG`, `_BATCH_DELAY`, `_CUSTOM_INSTRUCTIONS` | | `settings.hooks.*` |
| `MCP_EMAIL_HOOK_AUTO_CALENDAR`, `_CALENDAR_NAME`, `_CALENDAR_ALARM_MINUTES`, `_CALENDAR_CONFIRM` | | `settings.hooks.*` |
| `MCP_EMAIL_ALERT_DESKTOP`, `_SOUND`, `_URGENCY_THRESHOLD`, `_WEBHOOK_URL` | | `settings.hooks.alerts.*` |

**Variables qui s'appliquent aussi par-dessus `config.toml` :**

| Variable | Effet |
|----------|-------|
| `MCP_EMAIL_ACCOUNTS` | Noms des comptes, séparés par des virgules, que l'instance expose ([ci-dessous](#plusieurs-connecteurs-sur-une-même-configuration)). |
| `MCP_EMAIL_READ_ONLY` | `true` passe l'instance en lecture seule. Elle ne peut que restreindre : elle ne lève jamais un `read_only = true` posé dans le fichier. |
| `EMAIL_MCP_DATABASE_URL` | URL Postgres pour `cross_account_move` ; prime sur `[database].url`. |
| `MAIL_ALLOWED_SAVE_DIRS` | Dossiers supplémentaires (séparés par `;`) où des fichiers peuvent être écrits ([détails](#où-les-fichiers-peuvent-être-écrits)). |
| `MAIL_ALLOW_ANY_SAVE_DIR` | `true` désactive la liste blanche des dossiers d'écriture. |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | Déplacent les dossiers listés [plus haut](#emplacement-de-la-configuration). |

## Connecter un client MCP

### Claude Desktop

Modifiez le fichier de configuration du client, puis **quittez complètement
Claude Desktop et relancez-le** :

| Système | Fichier |
|---------|---------|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Windows :

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["C:\\chemin\\vers\\email-mcp\\dist\\main.js", "stdio"]
    }
  }
}
```

macOS / Linux :

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/chemin/vers/email-mcp/dist/main.js", "stdio"]
    }
  }
}
```

Si `node` n'est pas dans le `PATH` du client, indiquez son chemin absolu dans
`command`. Les variables d'environnement (`MCP_EMAIL_ACCOUNTS`,
`MAIL_ALLOWED_SAVE_DIRS`, …) se placent dans un objet `"env": { … }` à côté de
`args`.

### Plusieurs connecteurs sur une même configuration

Un client MCP active ou coupe un serveur entier, jamais un compte à l'intérieur.
Pour obtenir un interrupteur par compte, déclarez plusieurs entrées qui pointent
vers le même `dist/main.js` et le même `config.toml`, chacune restreinte par
`MCP_EMAIL_ACCOUNTS` :

```json
{
  "mcpServers": {
    "email-personnel": {
      "command": "node",
      "args": ["C:\\chemin\\vers\\email-mcp\\dist\\main.js", "stdio"],
      "env": { "MCP_EMAIL_ACCOUNTS": "personal" }
    },
    "email-travail": {
      "command": "node",
      "args": ["C:\\chemin\\vers\\email-mcp\\dist\\main.js", "stdio"],
      "env": { "MCP_EMAIL_ACCOUNTS": "work,outlook", "MCP_EMAIL_READ_ONLY": "true" }
    }
  }
}
```

- Absente ou vide : tous les comptes sont exposés.
- Un nom inconnu est **refusé au démarrage**, avec la liste des comptes
  configurés — une faute de frappe réduirait sinon en silence ce que l'instance
  sert.
- L'ordre des comptes vient du fichier, pas de la variable.
- Le filtre ne modifie jamais le fichier ; les commandes de secrets ne
  s'exécutent que pour les comptes servis ; un envoi programmé n'est envoyé que
  par une instance qui sert son compte.

### Enregistrement guidé et autres clients

`node dist/main.js install` détecte Claude Desktop, Cursor (`~/.cursor/mcp.json`)
et Windsurf (`~/.codeium/windsurf/mcp_config.json`) et y écrit une entrée
`email`. **Choisissez « Direct node (current dist/main.js) »** : les options
`npx`, `pnpm dlx` et installation globale lancent le paquet npm d'origine, pas ce
fork. `install status` et `install remove` affichent ou annulent l'enregistrement.

Tout autre client MCP fonctionne de la même façon : un serveur stdio dont la
commande est `node <chemin>/dist/main.js stdio`.

## Ligne de commande

`node dist/main.js <commande>` (ou `email-mcp <commande>` si vous liez le paquet) :

| Commande | Effet |
|----------|-------|
| `stdio` | Lance le serveur MCP sur stdio (par défaut sans commande). |
| `account list` / `add` / `edit [nom]` / `delete [nom]` | Gère les comptes de façon interactive (alias : `ls`, `new`, `rm`, `remove`). |
| `setup` | Alias de `account add`. |
| `test [nom]` | Teste tous les comptes, ou un seul, par le transport qu'il utilise vraiment (Graph pour un compte Graph, IMAP + SMTP sinon). |
| `install` / `install status` / `install remove` | Déclare / affiche / retire le serveur dans les clients MCP. |
| `config show` | Affiche la configuration, mots de passe masqués. |
| `config edit` | Modifie les réglages globaux (limite d'envoi, lecture seule). |
| `config path` | Affiche le chemin du fichier de configuration. |
| `config init` | Écrit un modèle commenté. |
| `scheduler check` | Envoie les messages programmés arrivés à échéance. |
| `scheduler list` | Affiche les envois programmés en attente, envoyés et en échec. |
| `scheduler install` / `uninstall` / `status` | Gère la vérification périodique du système. |
| `notify test` / `notify status` | Envoie une notification de test / diagnostique la prise en charge. |
| `--version`, `help` | |

Scripts de développement (`pnpm <script>`) : `oauth:setup`, `diagnose:mailboxes`,
`probe:graph`, `verify:graph` (test de fumée Graph), `mcp:call` (appelle les
outils du serveur compilé comme le ferait un client), `db:migrate`.

## Référence des outils

**64 outils.** *Backend* indique quels comptes un outil sert : **both** (IMAP et
Graph), **IMAP** seulement (un compte Graph reçoit une erreur explicite « not
supported yet »), **Graph** seulement (l'outil refuse un compte IMAP), ou
**local** (aucune boîte en jeu). *Lecture seule* indique si l'outil reste
enregistré quand le serveur est en [lecture seule](#mode-lecture-seule).

### Lecture

| Outil | Ce qu'il fait | Backend | Lecture seule |
|-------|---------------|---------|---------------|
| `list_accounts` | Comptes configurés — à appeler d'abord pour connaître les noms. | local | ✅ |
| `list_mailboxes` | Dossiers avec le nombre de non-lus et les attributs spéciaux. | both | ✅ |
| `list_emails` | Liste paginée avec filtres. | both | ✅ |
| `get_email` | Un message (`format` : `full`, `text`, `stripped` ; `maxLength`) ; ne le marque pas lu sauf `markRead`. | both | ✅ |
| `get_emails` | Jusqu'à 20 messages en un appel (texte par défaut). | both | ✅ |
| `get_email_status` | État lu / suivi / libellés sans le corps. | both | ✅ |
| `get_thread` | Conversation reconstruite à partir de `References` / `In-Reply-To`. | both | ✅ |
| `get_email_headers` | En-têtes Internet complets et leur analyse ([détails](#en-têtes-internet)). | both | ✅ |
| `find_email_folder` | Dossier(s) réel(s) d'un message vu dans un dossier virtuel (« All Mail » de Gmail). | IMAP | ✅ |
| `extract_contacts` | Correspondants fréquents d'après les en-têtes récents. | IMAP | ✅ |
| `get_email_stats` | Volume, principaux expéditeurs, tendance quotidienne sur un jour / une semaine / un mois. | IMAP | ✅ |
| `check_health` | Version en service, connexion, latence, quota et capacités par compte. | both | ✅ |

### Recherche

| Outil | Ce qu'il fait | Backend | Lecture seule |
|-------|---------------|---------|---------------|
| `search_emails` | Texte libre et filtres, facettes, syntaxe Gmail ([détails](#recherche)). | both | ✅ |
| `search_all_accounts` | Même recherche sur plusieurs comptes, fusionnée par date ; comptes IMAP et Graph mélangeables. | both | ✅ |
| `run_preset` | Exécute une recherche enregistrée de `[[searches]]`. | both | ✅ |
| `list_presets` | Liste les préréglages de tri IA et les recherches enregistrées. | local | ✅ |

### Export et enregistrement sur disque

| Outil | Ce qu'il fait | Backend | Lecture seule |
|-------|---------------|---------|---------------|
| `export_search` | Résultats d'une recherche dans un fichier CSV ou NDJSON. | both (mélangeables) | ✅ |
| `save_email` | Un message en fichier `.eml` (source exacte). | both | ✅ |
| `save_emails_from_search` | Chaque message d'une recherche en fichiers `.eml`. | both (un backend par appel) | ✅ |
| `download_attachment` | Une pièce jointe, renvoyée en base64 (≤ 5 Mo). | both | ✅ |
| `save_attachment` | Une pièce jointe écrite sur disque, sans limite de taille. | both | ✅ |
| `save_all_attachments_from_search` | Toutes les pièces jointes d'une recherche dans un dossier. | IMAP | ✅ |

### Rédaction et envoi

| Outil | Ce qu'il fait | Backend | Lecture seule |
|-------|---------------|---------|---------------|
| `send_email` | Nouveau message : texte ou HTML, cc/cci, pièces jointes, images intégrées, signature. | both | — |
| `reply_email` | Réponse dans le fil (`replyAll`, `includeAttachments`, `appendSignature`). | both | — |
| `forward_email` | Transfert avec l'original cité. | both | — |
| `save_draft` | Enregistre un brouillon (pièces jointes, `in_reply_to`, signature). | both | — |
| `update_draft` | Réécrit un brouillon en gardant ou modifiant ses pièces jointes. | both | — |
| `send_draft` | Envoie un brouillon et le retire des Brouillons. | both | — |
| `list_templates` | Modèles trouvés dans `~/.config/email-mcp/templates/`. | local | ✅ |
| `apply_template` | Remplit un modèle : `preview`, `draft` ou `send`. | both | — |
| `schedule_email` | Met un message en file pour plus tard. | both | — |
| `list_scheduled` | Envois programmés par statut. | local | — |
| `cancel_scheduled` | Annule un envoi programmé et supprime son brouillon miroir. | both | — |

### Rangement

| Outil | Ce qu'il fait | Backend | Lecture seule |
|-------|---------------|---------|---------------|
| `move_email` | Déplace vers un autre dossier du même compte. | both | — |
| `delete_email` | Vers la Corbeille, ou définitivement avec `permanent: true`. | both | — |
| `mark_email` | Lu / non lu / suivi / non suivi. | both | — |
| `bulk_action` | Même action sur jusqu'à 100 messages. | both | — |
| `list_labels` | Libellés du compte. | both | — |
| `add_label` / `remove_label` | Pose / retire un libellé sur un message. | both | — |
| `create_label` / `delete_label` | Crée / supprime un libellé. | both | — |
| `create_mailbox` / `rename_mailbox` / `delete_mailbox` | Gestion des dossiers (`delete_mailbox` supprime aussi le contenu). | both | — |
| `cross_account_move` | Déplace des messages vers un autre compte en gardant en-têtes, indicateurs et date. Exige Postgres. | IMAP | — |
| `list_mail_rules` | Règles de boîte de réception côté serveur. | Graph | — |
| `create_mail_rule` / `delete_mail_rule` | Crée / supprime une règle côté serveur. | Graph | — |
| `get_auto_reply` / `set_auto_reply` | Lit / règle la réponse automatique (absence). | Graph | — |

### Calendrier et rappels

| Outil | Ce qu'il fait | Backend | Lecture seule |
|-------|---------------|---------|---------------|
| `extract_calendar` | Événements (ICS) portés par un message. | IMAP | ✅ |
| `analyze_email_for_scheduling` | Détecte dans un message un événement ou une demande qui mérite un rappel. | IMAP | ✅ |
| `add_to_calendar` | Ajoute l'événement du message au calendrier local. | IMAP | ✅ |
| `create_reminder` | Crée un rappel macOS (Rappels) à partir d'un message. | both | ✅ |
| `list_calendars` / `list_events` | Calendriers et événements locaux (macOS). | local | ✅ |
| `list_reminders` | Rappels (macOS). | local | ✅ |
| `check_calendar_permissions` | Vérifie l'accès au calendrier et explique comment l'accorder. | local | ✅ |

### Surveillance et alertes

| Outil | Ce qu'il fait | Backend | Lecture seule |
|-------|---------------|---------|---------------|
| `get_watcher_status` | Connexions IDLE et activité récente. | IMAP | ✅ |
| `get_hooks_config` | Configuration actuelle des hooks (préréglage, règles, instructions). | local | ✅ |
| `check_notification_setup` | Diagnostique les notifications de bureau sur ce système. | local | ✅ |
| `test_notification` | Envoie une notification de test. | local | ✅ |
| `configure_alerts` | Modifie les réglages d'alerte en cours d'exécution, éventuellement enregistrés dans `config.toml`. | local | — |

### Compatibilité IMAP et Exchange

| Fonction | IMAP | Microsoft Graph |
|----------|:----:|:---------------:|
| Lecture, fils, en-têtes, état | ✅ | ✅ |
| Recherche, liste, export, `.eml`, pièces jointes unitaires | ✅ | ✅ (certains filtres ignorés, [voir plus bas](#sur-les-comptes-microsoft-graph)) |
| Facettes, `gmail_raw` | ✅ (Gmail pour `gmail_raw`) | — |
| Envoi, réponse, transfert, brouillons, modèles, envoi programmé | ✅ | ✅ |
| Déplacement, suppression, indicateurs, actions groupées, dossiers | ✅ | ✅ |
| Libellés | libellés Gmail, dossiers-libellés ProtonMail, mots clés IMAP | catégories Outlook |
| `save_all_attachments_from_search`, `extract_contacts`, `get_email_stats`, `find_email_folder` | ✅ | — |
| Extraction d'événements (`extract_calendar`, `analyze_email_for_scheduling`, `add_to_calendar`) | ✅ | — |
| `cross_account_move` | ✅ | — |
| Surveillance (IMAP IDLE) et ressources par compte (`mailboxes`, `unread`, `stats`) | ✅ | — (elles passent par IMAP) |
| Règles côté serveur, réponse automatique | — | ✅ |

## Prompts et ressources

**Prompts (7)** — des consignes prêtes à l'emploi que le client peut proposer à
l'utilisateur :

| Prompt | Arguments | Objet |
|--------|-----------|-------|
| `triage_inbox` | `account`, `mailbox`, `limit` | Trie les non-lus par urgence, avec des actions suggérées. |
| `summarize_thread` | `account`, `message_id`, `mailbox` | Participants, chronologie, décisions, actions à mener. |
| `compose_reply` | `account`, `email_id`, `mailbox`, `intent`, `tone` | Rédige une réponse avec le fil comme contexte. |
| `draft_from_context` | `account`, `topic`, `to`, `tone` | Rédige un nouveau message en cherchant du contexte dans le courrier passé. |
| `extract_action_items` | `account`, `mailbox`, `limit` | Tâches, échéances et engagements du courrier récent. |
| `summarize_meetings` | `account`, `days` | Vue d'ensemble des réunions d'après les invitations récentes. |
| `cleanup_inbox` | `account`, `older_than_days`, `dry_run` | Propose — ou effectue — archivages et suppressions. |

**Ressources (6)** — des données en lecture que le client peut joindre :

| URI | Contenu |
|-----|---------|
| `email://accounts` | Comptes configurés. |
| `email://scheduled` | Envois programmés en attente. |
| `email://{account}/mailboxes` | Arborescence des dossiers avec le nombre de messages. |
| `email://{account}/unread` | Non-lus par dossier. |
| `email://{account}/stats` | Statistiques du jour et quota. |
| `email://templates/{name}` | Un modèle. |

Les trois ressources par compte interrogent IMAP directement : elles sont faites
pour les comptes IMAP.

## Recherche

`list_emails`, `search_emails`, `search_all_accounts`, `export_search`,
`save_emails_from_search` et `save_all_attachments_from_search` partagent un même
jeu de filtres. Les filtres se combinent en ET. Les résultats sont paginés
(`page`, `pageSize` jusqu'à 100, 20 par défaut).

### Filtres

| Paramètre | Correspond à |
|-----------|--------------|
| `query` | Texte libre dans le sujet, l'expéditeur et le corps (`search_emails` et les outils multi-comptes / d'export). |
| `from`, `to`, `cc`, `bcc`, `subject` | En-tête, **comparé par le serveur de messagerie** (voir plus bas). |
| `from_contains`, `to_contains`, `subject_contains` | Sous-chaîne littérale, sans tenir compte de la casse, de l'en-tête décodé, vérifiée par email-mcp. |
| `body`, `text` | Corps / en-têtes + corps. |
| `since`, `before`, `on` | Date d'arrivée — à partir de, strictement avant, le jour même. |
| `sent_since`, `sent_before` | En-tête `Date:`. |
| `seen`, `flagged`, `answered`, `draft`, `deleted` | `true` / `false`. |
| `keyword`, `not_keyword` | Mot(s) clé(s) IMAP — indicateurs personnalisés, utilisés comme libellés par les serveurs à mots clés. |
| `header` | `{ "X-Header": "valeur" }`. |
| `uids` | Liste ou plage d'UID (`"1:100"`) — `list_emails` et `search_emails`. |
| `larger_than`, `smaller_than` | Taille en Ko. |
| `has_attachment` | Au moins une pièce jointe. |
| `attachment_filename` | Sous-chaîne d'un nom de pièce jointe. |
| `attachment_mimetype` | Expression régulière, sans tenir compte de la casse, sur `type/sous-type` (`"application/pdf"`, `"image/.*"`). |
| `facets` | `["sender", "year", "mailbox"]` — décomptes sur l'ensemble des correspondances (`search_emails`, `search_all_accounts`). |
| `gmail_raw` | Syntaxe de recherche native Gmail (`from:x has:attachment older_than:30d`), comptes Gmail uniquement. |

**Les dates** acceptent l'ISO 8601, `AAAA-MM-JJ`, les jetons relatifs `Nd`, `Nw`,
`Nm` (il y a N jours, semaines, mois) et `today` / `yesterday`, évalués en UTC —
sur tous les outils de recherche et les deux backends.

```jsonc
// search_emails
{ "account": "work", "subject": "facture", "since": "60d", "has_attachment": true }
```

### Filtres comparés par le serveur et `*_contains`

`from`, `to` et `subject` sont confiés au serveur de messagerie, et c'est son
index qui décide. La RFC 3501 prévoit une recherche de sous-chaîne, mais un
serveur doté d'un index plein texte (Dovecot FTS, tel qu'utilisé par OVH par
exemple) compare des **jetons** indexés : `example.com` ne trouve alors pas
`news.example.com`, et un fragment qui commence au milieu d'un mot ne trouve
rien — sans que rien dans la réponse ne le distingue d'une boîte vide. Quand le
résultat doit être exhaustif, utilisez `from_contains`, `to_contains`,
`subject_contains` : ils sont vérifiés ici sur l'en-tête décodé et donnent le
même résultat en IMAP et en Graph. Ils ne restreignent pas la requête au
serveur : associez-les à `since` / `before` ou à un filtre grossier sur un gros
dossier.

### Parcours partiels et reprise

Certains filtres imposent de lire chaque message candidat : `has_attachment` et
`attachment_*` en IMAP, `*_contains` sur les deux backends. Ils sont appliqués
**avant la pagination** — pages et totaux ne comptent que les messages qui
correspondent — du plus récent au plus ancien, dans deux limites par appel :

- un **budget de 45 secondes** (les clients MCP abandonnent un appel au bout
  d'environ 60 s) ;
- **5000 messages examinés**.

Quand une limite arrête le parcours, la réponse le dit — l'avertissement affiche
le total sous la forme `~N`, et un objet `coverage` (présent aussi dans la sortie
JSON des outils d'export, par compte) indique ce qui a été couvert et comment
reprendre :

```jsonc
{
  "stoppedBy": "time_budget",            // ou "message_cap", ou "server_cap" (Graph)
  "examined": 1200,
  "candidates": 2199,
  "oldestExamined": "2025-03-14T22:10:05.000Z",
  "continueBefore": "2025-03-16",
  "hint": "Partial scan: … re-run the same call with before: \"2025-03-16\" …"
}
```

Relancez le même appel avec `before: <continueBefore>` pour parcourir la tranche
suivante ; en répétant, on couvre toute la boîte. Les tranches peuvent se
chevaucher légèrement (un message peut apparaître deux fois) mais ne laissent
jamais de trou. Quand une seule journée contient plus qu'un appel ne peut
examiner, aucune reprise n'est proposée et l'indication demande un autre filtre.

Une recherche que le serveur refuse ou laisse expirer est signalée comme un
échec (`searchFailed` et un avertissement), jamais comme zéro résultat. Sur un
très gros dossier sans index plein texte, une recherche dans le corps passe par
une connexion bornée et s'accompagne d'un avertissement de coût.

### Sur les comptes Microsoft Graph

- Sans texte de recherche, le `$filter` de Graph traite les dates, `seen`,
  `flagged` et `has_attachment` ; les filtres `*_contains` parcourent ensuite le
  dossier page par page, du plus récent au plus ancien, et sont appliqués avant
  la pagination avec le même budget, la même limite et le même `coverage`
  qu'en IMAP.
- Avec un texte de recherche, `subject`, `from` ou `to`, c'est le `$search` de
  Graph qui sert. Il refuse les filtres de date en parallèle : les dates sont donc
  intégrées à la requête et tous les autres critères sont vérifiés sur chaque
  résultat. Graph renvoie au plus 1000 résultats de `$search` ; atteindre ce
  plafond est signalé par `stoppedBy: "server_cap"`.
- Les filtres sans traduction Graph fidèle — `cc`, `bcc`, `text`, `body`,
  `answered`, `draft`, `deleted`, `keyword`, `not_keyword`, `header`, `uids`,
  `larger_than`, `smaller_than`, `attachment_filename`, `attachment_mimetype`,
  `gmail_raw` — sont ignorés, et la réponse les énumère
  (`Not supported on this Microsoft Graph account and IGNORED: …`). Les `facets`
  ne sont pas calculées sur Graph.

### Recherche sur plusieurs comptes

`search_all_accounts` lance la même recherche sur plusieurs comptes en parallèle
(`accounts`, tous les comptes s'il est omis), fusionne par date et préfixe chaque
résultat par son compte. Un compte en échec devient un avertissement au lieu de
faire échouer l'appel. Quand le `mailbox` demandé n'existe pas dans un compte,
son équivalent est trouvé grâce aux attributs SPECIAL-USE du serveur (`\All`,
`\Archive`, `\Sent`, `\Trash`, `\Drafts`, `\Junk`), et la substitution est
signalée. Avec `facets`, la facette `mailbox` est ventilée par compte.

### Recherche native Gmail

Sur un compte dont l'hôte IMAP est `imap.gmail.com`, `gmail_raw` transmet au
serveur la syntaxe de recherche de Gmail (`X-GM-RAW`) — bien plus rapide sur une
grosse boîte. Les autres filtres sont alors ignorés, avec un avertissement ; sur
tout autre compte, c'est une erreur.

### Recherches enregistrées

```toml
[[searches]]
name = "bail-2024"
description = "Documents du bail 2024"
accounts = ["personal", "work"]      # ou account = "…" ; aucun des deux = premier compte
subject = "bail"
since = "2024-01-01"
before = "2025-01-01"
has_attachment = true
attachment_filename = "bail"
facets = ["sender", "year"]
```

Une recherche enregistrée accepte `query`, `mailbox`, les filtres d'en-tête, de
date, d'état, de taille et de pièces jointes, `keyword` / `not_keyword`,
`header`, `facets` et `gmail_raw` (ni `*_contains` ni `uids`). Exécutez-la avec
`run_preset { "name": "bail-2024", "pageSize": 20 }` ; `list_presets` les liste.

## Export et enregistrement sur disque

| Vous voulez | Outil | Écrit |
|-------------|-------|-------|
| Les métadonnées de nombreux messages | `export_search` | un fichier CSV ou NDJSON |
| Les messages eux-mêmes | `save_email`, `save_emails_from_search` | un `.eml` par message |
| Les fichiers joints | `save_attachment`, `save_all_attachments_from_search` | les pièces jointes |

La réponse ne porte qu'un court bilan — chemin, décomptes, `truncated`,
`coverage` — et les données restent sur disque : un gros export ne remplit pas la
conversation.

- **`export_search`** — `format` : `csv` (par défaut) ou `ndjson` ; `max_rows`
  5000 par défaut, 50 000 au plus. Colonnes CSV par défaut : `id`, `account`,
  `date`, `from`, `subject`, `labels`, `attachments`, `has_attachments`, `seen`,
  `flagged` ; `columns` choisit parmi `id`, `account`, `date`, `from`, `to`,
  `subject`, `flags`, `labels`, `attachments`, `preview`, `size`. Le NDJSON écrit
  l'enregistrement complet. Fichier par défaut :
  `~/Downloads/email-export-<horodatage>.csv`.
- **`save_email`** — la source RFC 822 exacte : pièces jointes, mise en forme,
  signatures DKIM et chaîne Received sont conservées, et le fichier se rouvre dans
  n'importe quel client de messagerie. Nom par défaut :
  `~/Downloads/<date>_<sujet>_<id>.eml`.
- **`save_emails_from_search`** — `max_emails` (500 par défaut), `organize_by` :
  `flat`, `date` (`AAAA-MM/`), `sender` (domaine de l'expéditeur) ou `account`. Un
  message en échec est listé dans `errors` et le lot continue. La réponse donne
  `matched` (ce que la recherche a renvoyé) à côté de `files_saved` : un `matched`
  bas met en cause la requête, un écart entre les deux met en cause l'écriture.
- **`save_attachment`** — écrit le fichier sur disque en flux, sans limite de
  taille (contrairement à `download_attachment`, en base64 et limité à 5 Mo).
  `open: true` l'ouvre ensuite (macOS). Un fichier existant reçoit un suffixe
  `-1`, `-2` sauf `overwrite: true`.
- **`save_all_attachments_from_search`** — toutes les pièces jointes des
  correspondances, éventuellement restreintes par `attachment_filename` /
  `attachment_mimetype`, dans `~/Downloads/email-attachments-<horodatage>/`, avec
  les mêmes valeurs de `organize_by` ; `max_emails` 1000 par défaut.

### Où les fichiers peuvent être écrits

Toute destination doit être un chemin absolu sous une racine autorisée : par
défaut le dossier personnel et le dossier temporaire du système. Les segments
`..` littéraux sont refusés et la comparaison tient compte du système (sans
casse sous Windows, si bien que `D:\Exports-pirate` n'est pas dans
`D:\Exports`). Ajoutez des racines avec `MAIL_ALLOWED_SAVE_DIRS` (séparées par
`;`) :

```json
"env": { "MAIL_ALLOWED_SAVE_DIRS": "D:\\Archives;D:\\Exports" }
```

`MAIL_ALLOW_ANY_SAVE_DIR=true` supprime la liste blanche. Elle existe parce que
le serveur est piloté par un modèle qui lit du courrier non fiable : une
injection de prompt ne doit pas pouvoir diriger une écriture vers un dossier de
démarrage.

## Brouillons, pièces jointes et signatures

### Pièces jointes

`send_email`, `save_draft` et `update_draft` acceptent des pièces jointes sous
trois formes :

```jsonc
"attachments": [
  { "path": "C:\\Docs\\devis.pdf" },                                     // fichier local
  { "content_base64": "JVBERi0…", "filename": "note.pdf" },             // octets
  { "source_email_id": "4711", "source_mailbox": "INBOX", "filename": "plan.pdf" } // depuis un message, côté serveur
]
```

La troisième forme recopie une pièce jointe d'un message existant sans que les
octets transitent par la conversation. `reply_email` peut rejoindre les fichiers
de l'original avec `includeAttachments: true`. Sur les comptes Graph, les pièces
jointes de plus de 3 Mo passent par une session de téléversement.

### Images intégrées (`cid`)

Toute pièce jointe qui porte un `cid` devient une image intégrée
(`multipart/related`), référencée depuis le corps HTML :

```jsonc
{
  "account": "work", "to": ["quelquun@example.com"], "subject": "Bonjour",
  "html": true,
  "body": "<p>Bonjour !</p><img src=\"cid:logo\">",
  "attachments": [{ "path": "/abs/logo.png", "cid": "logo" }]
}
```

### Signature Outlook

Avec `signature_path` pointant vers une signature Outlook `.htm` (sous Windows
dans `%APPDATA%\Microsoft\Signatures\`), le serveur lit le fichier, intègre les
images de son dossier voisin en images `cid`, l'ajoute sous le corps et passe le
message en HTML. Le serveur doit tourner sur la machine où ce fichier existe.

| Outil | Paramètre | S'il est omis |
|-------|-----------|---------------|
| `send_email`, `save_draft` | `append_signature` | le `signature_default` du compte |
| `reply_email`, `forward_email` | `appendSignature` | le `signature_default` du compte |
| `update_draft` | `append_signature` | **pas de signature** |

`update_draft` ne signe jamais implicitement, pour qu'une réécriture de
brouillon ne puisse pas empiler une seconde signature : un nouveau `body`
remplace l'ancien tel quel, un `body` omis est conservé tel quel (avec sa
signature et ses images intégrées). Passez `append_signature: true` avec un
nouveau `body` pour le signer ; sans nouveau corps, il est ignoré avec un
avertissement.

### Brouillons

- `save_draft` enregistre dans le dossier Brouillons ; `send_draft` l'envoie et
  le retire, en conservant ses pièces jointes.
- `update_draft` réécrit un brouillon. Les champs omis (sujet, corps,
  destinataires) gardent leur valeur ; `attachments_keep` (toutes par défaut, `[]`
  les retire), `attachments_add` et `attachments_remove` gèrent les fichiers. En
  IMAP, qui n'a pas de modification sur place, la nouvelle copie est ajoutée
  d'abord et l'ancienne supprimée seulement ensuite ; l'outil renvoie le
  **nouvel** identifiant. Les images intégrées référencées par le corps sont
  conservées ; un `cid:` sans image correspondante produit un avertissement.

### Modèles

Un modèle est un fichier TOML dans `~/.config/email-mcp/templates/` :

```toml
name = "relance"
description = "Relance polie"
subject = "Suite à {{sujet}}"
body = "Bonjour {{nom}},\n\nJe reviens vers vous au sujet de {{sujet}}."
variables = ["nom", "sujet"]
```

`apply_template { "account": "work", "template": "relance", "variables": {…},
"action": "preview" | "draft" | "send", "to": […] }`.

## En-têtes Internet

`get_email` expose une table d'en-têtes aplatie — une valeur par nom, assez pour
un `List-Unsubscribe`, inutile pour retracer un message passé par plusieurs
relais. `get_email_headers` renvoie :

- **`analysis`** — la chaîne `Received` dans l'ordre chronologique avec le délai
  à chaque saut, les verdicts SPF / DKIM / DMARC tirés d'`Authentication-Results`
  (le plus haut, ajouté par votre propre serveur, fait foi), les signatures DKIM,
  et l'alignement des domaines From / Return-Path / SPF / DKIM ;
- **`headers`** — chaque occurrence, dépliée, dans l'ordre du message
  (`include_all_headers: false` la retire) ;
- **`raw`** — le bloc d'en-têtes tel que reçu (`include_raw: true`).

`format: "json"` renvoie la structure complète au lieu du rapport lisible. Seul
le bloc d'en-têtes est téléchargé et le message n'est pas marqué lu. Sur les
comptes Graph, la liste vient d'`internetMessageHeaders` et le bloc brut en est
reconstruit (`rawReconstructed: true`). Les verdicts sont des affirmations des
relais, pas des vérifications refaites localement — voir
[SECURITY.md](SECURITY.md).

## Calendrier et rappels

- `extract_calendar` renvoie les événements des parties ICS d'un message
  (`text/calendar` intégré ou pièce jointe `.ics`).
- `analyze_email_for_scheduling` indique au modèle si un message contient un
  événement, une demande qui mérite un rappel, les deux ou rien — la première
  étape avant de créer quoi que ce soit.
- `add_to_calendar` ajoute l'événement au calendrier local avec le lien de
  réunion (Zoom, Teams, Meet), les informations d'appel, les participants, un
  extrait et des liens vers les pièces jointes enregistrées (`calendar_name`,
  `alarm_minutes`, `save_attachments`). Sous **macOS**, il écrit dans Calendrier
  après une boîte de confirmation native (`confirm`) et évite les doublons ; sous
  **Linux**, il ouvre un `.ics` généré avec `xdg-open`. Windows n'a pas
  d'intégration calendrier.
- `create_reminder`, `list_reminders`, `list_calendars`, `list_events` utilisent
  Rappels et Calendrier de macOS. `check_calendar_permissions` explique comment
  accorder l'accès (Réglages Système → Confidentialité et sécurité).

Ces outils restent disponibles en lecture seule : ils écrivent dans le
calendrier local, jamais dans la boîte.

## Surveillance, notifications et hooks IA

Avec `settings.watcher.enabled = true`, le serveur garde une connexion IMAP IDLE
par dossier surveillé (distincte des connexions des outils, qui se reconnecte
avec un délai croissant de 1 s à 60 s). Les nouveaux messages passent par :

1. **Les règles statiques** — motifs sur from / to / subject ; la première règle
   qui correspond applique ses actions et le message échappe au tri IA.
2. **Le tri IA** — quand `on_new_email = "triage"` et que le client prend en
   charge le *sampling* MCP, les messages sont regroupés (`batch_delay`) et
   soumis au modèle avec le préréglage choisi (au plus 10 appels de sampling par
   minute). Sans sampling, on revient à la simple notification.
3. **La notification** — consigne l'arrivée et déclenche une alerte quand la
   priorité atteint le seuil.

```toml
[settings.watcher]
enabled = true
folders = ["INBOX"]

[settings.hooks]
on_new_email = "triage"           # "triage" | "notify" | "none"
preset = "priority-focus"         # "inbox-zero" | "gtd" | "priority-focus" | "notification-only" | "custom"
auto_label = false                # applique les libellés suggérés par l'IA
auto_flag = false                 # marque les messages urgents
batch_delay = 5                   # secondes (1–60)
custom_instructions = "Le courrier de @monentreprise.fr est prioritaire."
# system_prompt = "…"             # prompt complet, avec preset = "custom"
auto_calendar = false             # ajoute au calendrier les événements détectés
calendar_name = ""
calendar_alarm_minutes = 15
calendar_confirm = true

[[settings.hooks.rules]]
name = "GitHub"
match = { from = "*@github.com|*@gitlab.com" }
actions = { labels = ["Dev"], mark_read = true }

[[settings.hooks.rules]]
name = "VIP"
match = { from = "pdg@entreprise.fr" }
actions = { flag = true, alert = true, labels = ["VIP"] }

[settings.hooks.alerts]
desktop = true
sound = false
urgency_threshold = "high"        # "urgent" | "high" | "normal" | "low"
webhook_url = "https://ntfy.sh/mon-courrier"
webhook_events = ["urgent", "high"]
```

- **Motifs** : joker `*`, `|` pour les alternatives, sans tenir compte de la
  casse ; les conditions d'une même règle se combinent en ET.
- **Actions des règles** : `labels`, `flag`, `mark_read`, `alert` (notification
  de bureau quel que soit le seuil), `add_to_calendar`.
- **Préréglages** : `inbox-zero` (catégorisation poussée), `gtd` (`@Action`,
  `@Waiting`, …), `priority-focus` (priorité seule, par défaut),
  `notification-only`, `custom`.
- **Notifications de bureau** : macOS (`osascript`), Linux (`notify-send`, plus
  `paplay` pour le son), Windows (PowerShell). `check_notification_setup`
  diagnostique, `test_notification` ou `email-mcp notify test` vérifie.
- **Webhook** : un POST HTTP de
  `{ "event": "email.urgent", "account", "sender", "subject", "priority", … }`
  pour les priorités listées dans `webhook_events` (Slack, Discord, ntfy.sh, …).
- `configure_alerts` modifie ces réglages d'alerte en cours d'exécution et, avec
  `save: true`, les écrit dans `config.toml`. Il n'est pas enregistré en lecture
  seule, puisqu'il peut définir un webhook et réécrire le fichier.

Quand un nouveau message est traité, le serveur envoie
`notifications/resources/updated` pour les ressources `unread` et `mailboxes` du
compte aux clients abonnés. La surveillance ne fonctionne qu'en IMAP.

## Envoi programmé

`schedule_email` met un message en file (`send_at` en ISO 8601) sous forme de
fichier JSON dans `~/.local/state/email-mcp/scheduled/` et le double d'un
brouillon `[Scheduled: …]`. Il part par le backend de son compte (SMTP ou Graph).
Trois choses peuvent l'envoyer :

1. un serveur MCP en cours d'exécution — au démarrage, puis chaque minute — sauf
   s'il est en lecture seule ;
2. `email-mcp scheduler check`, à la main ;
3. la **vérification périodique du système**, qui envoie même quand aucun client
   n'est ouvert :

```bash
node dist/main.js scheduler install     # launchd sous macOS, crontab sous Linux, Planificateur de tâches sous Windows — chaque minute
node dist/main.js scheduler status
node dist/main.js scheduler list
node dist/main.js scheduler uninstall
```

Sous Windows, la tâche `email-mcp scheduler` s'exécute sans fenêtre. Installée
depuis un terminal administrateur, elle tourne que vous soyez connecté ou non ;
depuis un terminal normal, seulement pendant votre session — `install` dit lequel
des deux, `status` l'affiche avec la dernière exécution. La tâche mémorise les
chemins de `node` et d'email-mcp au moment de l'installation : réinstallez-la
après avoir déplacé le dossier ou changé de version de Node.

Garanties de livraison : plusieurs processus peuvent partager la file, mais
chaque message est réservé (`<id>.claim`) par un seul processus, donc envoyé une
seule fois. Un envoi en échec est retenté jusqu'à **3 fois**, puis marqué
`failed`. Un envoi interrompu en cours de route n'est jamais retenté
automatiquement — le serveur l'a peut-être déjà accepté — et il est marqué
`failed` au bout de 15 minutes (« Interrupted while sending: it may have gone
out ») ; vérifiez le dossier Envoyés avant de le reprogrammer. Une instance
n'envoie que les messages des comptes qu'elle sert. `cancel_scheduled` retire
l'entrée et son brouillon.

## Gestion de la boîte

### Libellés

`list_labels` détecte le système de libellés du compte :

| Fournisseur | Les libellés sont |
|-------------|-------------------|
| Gmail | des libellés Gmail (`X-GM-LABELS`) |
| ProtonMail (Bridge) | des dossiers sous `Labels/` — `add_label` y copie le message |
| Autres serveurs IMAP | des mots clés IMAP (créés au premier usage ; impossibles à supprimer pour tout le serveur) |
| Microsoft Graph | des catégories Outlook |

### Dossiers et dossiers virtuels

`move_email` et `delete_email` ont besoin du dossier réel d'un message. Un message
trouvé dans un dossier virtuel (« All Mail », « Starred » de Gmail) doit d'abord
être localisé avec `find_email_folder`. `delete_mailbox` supprime définitivement
le dossier et son contenu.

### Déplacement entre comptes

`cross_account_move` déplace des messages entre deux comptes IMAP configurés : il
récupère le message brut, l'ajoute à la destination avec ses indicateurs et sa
date d'origine (il paraît livré nativement), consigne le déplacement, puis
déplace la copie source dans la Corbeille du compte source. Un message déjà
présent à la destination est ignoré. Le journal des déplacements vit dans
**PostgreSQL** ; sans base, cet outil refuse et tous les autres fonctionnent
normalement.

```toml
[database]
url = "postgresql://email_mcp:MOT_DE_PASSE@HOTE:5432/email_mcp"   # ou EMAIL_MCP_DATABASE_URL
```

```bash
pnpm db:migrate             # applique les migrations en attente (migrations/*.sql)
pnpm db:migrate --status    # appliquées et en attente, sans rien changer
pnpm db:migrate --dry-run   # liste celles en attente
```

Les migrations vont uniquement vers l'avant et sont consignées dans
`schema_migrations`. Utilisez un rôle dédié qui n'accède qu'à la base
`email_mcp` ; sous PostgreSQL 15+, exécutez aussi
`ALTER SCHEMA public OWNER TO email_mcp;` dans cette base, sans quoi la première
migration échoue avec « permission denied for schema public ».

### Règles et réponse automatique Exchange

Sur les comptes Graph, `create_mail_rule` crée une règle de boîte de réception
côté serveur — conditions `from_addresses`, `subject_contains`, `body_contains` ;
actions `move_to_mailbox` (un chemin de dossier comme `"Clients/Factures"`),
`mark_as_read`, `mark_importance`, `delete_message`, `stop_processing` ;
`sequence`, `enabled`. Les règles s'exécutent dans la boîte, même quand rien
n'est connecté. `set_auto_reply` règle la réponse d'absence : `status`
`disabled`, `alwaysEnabled` ou `scheduled` (avec `start_datetime`,
`end_datetime`, `time_zone`), `internal_message`, `external_message`,
`external_audience` (`none`, `contactsOnly`, `all`).

## Sécurité

### Mode lecture seule

`read_only = true` dans `[settings]`, ou `MCP_EMAIL_READ_ONLY=true` pour une
instance :

- les 29 outils d'écriture **ne sont pas enregistrés** — le modèle ne les voit
  même pas (envoi, brouillons, déplacements, suppressions, indicateurs, libellés,
  dossiers, modèles, envois programmés, règles, réponse automatique,
  `configure_alerts`) ;
- la file des envois programmés n'est pas traitée (le serveur consigne
  `Scheduler disabled`) ;
- les outils qui n'écrivent que localement restent : les outils `save_*` /
  `export_*` (fichiers), `add_to_calendar` et `create_reminder` (calendrier
  local), `test_notification`.

Le mode lecture seule ne couvre **pas** les hooks de la surveillance : règles
statiques et tri IA appliquent toujours leurs libellés, indicateurs et marques de
lecture quand la surveillance est active. Laissez
`settings.watcher.enabled = false` sur une instance qui ne doit pas toucher à la
boîte. `email-mcp scheduler check` envoie aussi quel que soit ce réglage.

### Autres garde-fous

- **Secrets** — les champs `*_command` gardent les identifiants dans un
  gestionnaire de mots de passe ; les jetons OAuth2 sont limités en portée et
  révocables. Les mots de passe ne sont jamais journalisés.
- **Confirmation** — chaque outil porte des annotations MCP (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) dont les clients se
  servent pour demander avant d'agir ; `delete_email` va à la Corbeille sauf
  `permanent: true` ; sous macOS, l'écriture dans le calendrier et les rappels
  affiche une boîte de confirmation native.
- **Limite d'envoi** — `rate_limit` messages par minute et par compte pour les
  envois SMTP.
- **Écritures sur disque** — la [liste blanche](#où-les-fichiers-peuvent-être-écrits)
  ci-dessus.
- **Journal d'audit** — les opérations d'écriture sont ajoutées à
  `~/.local/share/email-mcp/audit.log`, champs sensibles masqués.
- **TLS** — TLS implicite ou STARTTLS, vérification des certificats activée par
  défaut.

Ce qui arrive sur disque (`.eml`, pièces jointes, exports) est aussi sensible que
la boîte elle-même ; voir [SECURITY.md](SECURITY.md).

## Dépannage

| Symptôme | Cause probable et remède |
|----------|--------------------------|
| Un outil documenté manque, ou un correctif semble absent | Le client exécute une ancienne compilation. Lancez `pnpm build` (les hooks git le font après un pull), **redémarrez le client** et vérifiez `server_build` dans `check_health`. |
| Un outil manque complètement | L'instance est en lecture seule (les outils d'écriture ne sont pas enregistrés). |
| Erreur au démarrage citant `MCP_EMAIL_ACCOUNTS` | Un nom de compte de l'entrée du client n'existe pas dans `config.toml`. |
| Erreur au démarrage `… timed out after 30s` / `… printed nothing` | Une commande `*_command` attend une saisie ou échoue ; lancez-la dans un terminal. |
| La recherche renvoie moins de messages que prévu | Comparaison par jetons du serveur sur `from` / `to` / `subject` : utilisez `*_contains`. Ou parcours partiel : lisez `coverage` et reprenez avec `before`. |
| L'appel est abandonné au bout d'une minute environ | Les clients MCP cessent d'attendre vers 60 s. Ajoutez un filtre de date (`since: "90d"`) ou ciblez le dossier ; les parcours côté client s'arrêtent déjà à 45 s et indiquent comment reprendre. |
| Corps vides, ou `the server returned no data for MIME part N` | Un antivirus qui inspecte l'IMAP non chiffré peut vider des parties de messages (constaté avec ESET). Utilisez TLS (`tls = true`, port 993) ou excluez le serveur de messagerie de l'analyse du courrier par l'antivirus. |
| Dossiers manquants sur Exchange / Outlook.com | Leur accès IMAP masque les dossiers personnalisés : utilisez `backend = "graph"`. |
| `… is not supported yet on Graph-backed account` | L'outil est réservé à IMAP ([tableau](#compatibilité-imap-et-exchange)). |
| Copie envoyée dans le mauvais dossier (cPanel, Mail de macOS) | Réglez `sent_folder` — [docs/troubleshooting-sent-folder.md](docs/troubleshooting-sent-folder.md). |
| Processus `email-mcp` orphelins qui gardent des connexions IMAP | [docs/troubleshooting-orphan-processes.md](docs/troubleshooting-orphan-processes.md) et `bin/email-mcp-wrapper.sh` (POSIX). |
| Les notifications de bureau n'apparaissent pas | `check_notification_setup` / `email-mcp notify status`. |
| Les envois programmés ne partent pas | Aucun serveur lancé et pas de `scheduler install` ; ou instance en lecture seule ; `scheduler list` montre l'état et la dernière erreur. |

## Architecture

```
src/
├── main.ts            point d'entrée et commandes CLI
├── server.ts          fabrique du serveur MCP
├── cli/               account, setup, test, install, config, scheduler, notify
├── config/            chargement TOML + environnement, schéma Zod, commandes de secrets, chemins XDG
├── connections/       connexions IMAP / SMTP paresseuses et persistantes (OAuth2 compris)
├── services/          logique métier
│   ├── imap.service.ts, smtp.service.ts      backends IMAP / SMTP
│   ├── graph/                                backend Microsoft Graph et envoi
│   ├── mail-router.ts, mail-backends.ts      routage par compte IMAP ↔ Graph
│   ├── search-*.ts                           critères, couverture, recherches enregistrées
│   ├── watcher, hooks, notifier, presets     surveillance IDLE, tri, alertes
│   └── scheduler, calendar, reminders, templates, signature-loader, …
├── routing/           déplacement entre comptes et son journal Postgres
├── tools/ prompts/ resources/   surface MCP (64 outils, 7 prompts, 6 ressources)
├── safety/            validation, limite d'envoi, journal d'audit
└── utils/             dates, en-têtes, mise en forme du corps, informations de build
```

Les outils appellent un seul contrat de messagerie (`IMailService`,
`ISendService`) ; un routeur envoie chaque appel à IMAP/SMTP ou à Graph selon le
`backend` du compte. Un compte Graph ne retombe jamais sur IMAP, et une opération
que Graph n'implémente pas échoue explicitement plutôt que de renvoyer une
réponse partielle.

## Développement et contribution

```bash
pnpm install
pnpm dev              # mode surveillance (tsx)
pnpm typecheck
pnpm check            # Biome + ESLint
pnpm test             # tests unitaires (Vitest)
pnpm test:integration # tests d'intégration — Docker requis (GreenMail via Testcontainers)
pnpm build
```

Les hooks git (lefthook) s'exécutent automatiquement et ne doivent pas être
contournés (pas de `--no-verify`) : **pre-commit** Biome, ESLint, vérification
des types et `actionlint` ; **commit-msg** Conventional Commits ; **pre-push**
tests, `pnpm check` et compilation ; **post-merge / post-checkout /
post-rewrite** reconstruction de `dist/`.

Chaque changement doit garder **les deux backends** fonctionnels. Un nouvel outil
a besoin de sa méthode dans `ImapService` et `GraphService` (ou accepte l'erreur
explicite « not supported yet » sur Graph), d'un enregistrement dans
`src/tools/register.ts` — dans le bloc `if (!readOnly)` s'il écrit — et d'une
ligne dans les tableaux d'outils de **`README.md` et `README.fr.md`**. Voir
[CONTRIBUTING.md](CONTRIBUTING.md).

Signalements de bogues et de vulnérabilités : voir
[CONTRIBUTING.md](CONTRIBUTING.md) et [SECURITY.md](SECURITY.md).

## Mainteneur

[@PedroSkyNetFr](https://github.com/PedroSkyNetFr) maintient ce fork.

## Historique et crédits

- **Colin ([@codefuturist](https://github.com/codefuturist))** a créé
  [email-mcp](https://github.com/codefuturist/email-mcp) en février 2026 : le
  serveur IMAP/SMTP et sa conception multi-comptes, l'assistant de
  configuration, l'installateur de clients et la CLI, les libellés adaptés au
  fournisseur, la surveillance IMAP IDLE avec tri IA, préréglages, règles
  statiques et alertes, l'intégration calendrier et rappels, les modèles, l'envoi
  programmé, les statistiques, les prompts et ressources, la suite de tests
  d'intégration et la chaîne de publication npm / Docker.
- **David Young ([@wgs4](https://github.com/wgs4))** l'a étendu dans
  [son fork](https://github.com/wgs4/email-mcp) (mars–juin 2026, versions 0.3.0
  et 0.4.0) : copie dans Envoyés après un envoi SMTP, parité des filtres côté
  serveur et voie rapide Gmail, filtres sur les pièces jointes et facettes,
  recherche multi-comptes, recherches enregistrées et correspondance des dossiers
  via SPECIAL-USE, `export_search` et les outils d'enregistrement sur disque,
  recherche profonde bornée avec échecs de recherche explicites, extraction du
  corps tenant compte du MIME, pièces jointes sur `send_email`, les brouillons et
  `update_draft`, `includeAttachments` sur les réponses, et `cross_account_move`
  avec son journal Postgres.
- **Ce fork ([@PedroSkyNetFr](https://github.com/PedroSkyNetFr))**, depuis juin
  2026 : le backend Microsoft Graph (lecture, écriture, envoi, recherche,
  catégories, brouillons, export), les règles et la réponse automatique Exchange,
  l'assistant OAuth2, les images intégrées `cid` et les signatures Outlook,
  l'export `.eml` et les en-têtes Internet complets, la liste blanche des
  dossiers d'enregistrement, `MCP_EMAIL_ACCOUNTS` et les secrets `*_command`, les
  rapports de couverture de recherche avec reprise par `before` et les filtres
  `*_contains`, la fiabilisation de l'envoi programmé et le Planificateur de
  tâches Windows, les corrections du mode lecture seule, la version en service
  dans `check_health`, la mise à niveau vers imapflow 2 / nodemailer 10 et les
  hooks git qui tiennent `dist/` à jour.

## Licence

[LGPL-3.0-or-later](LICENSE).
