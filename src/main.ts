#!/usr/bin/env node
/**
 * Email MCP Server — Main entry point.
 *
 * Subcommands:
 *   stdio     Run as MCP server over stdio (default)
 *   setup     Interactive account setup wizard
 *   test      Test IMAP/SMTP connections
 *   config    Config management (show, path, init, validate)
 *   scheduler Email scheduling management
 */

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config/loader.js';
import { mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import createServer, { PKG_VERSION } from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import createMailBackends from './services/mail-backends.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService from './services/scheduler.service.js';
import {
  DEFAULT_SENT_RETENTION_DAYS,
  startSentHistoryPruning,
} from './services/scheduler-retention.js';
import { SearchPresetRegistry } from './services/search-presets.js';
import TemplateService from './services/template.service.js';
import WatcherService from './services/watcher.service.js';
import { createShutdown, installShutdownTriggers } from './shutdown.js';
import registerAllTools from './tools/register.js';

const HELP = `
email-mcp — Email MCP Server (IMAP + SMTP)

Usage:
  email-mcp [command]

Commands:
  stdio       Run as MCP server over stdio (default)
  account     Account management (list, add, edit, delete)
  setup       Alias for 'account add'
  test        Test connections for all or a specific account
  install     Register/unregister with MCP clients (Claude, Cursor, …)
  config      Config management (show, edit, path, init, validate)
  scheduler   Email scheduling management (check, list, install, uninstall, status)
  notify      Test and diagnose desktop notifications
  help        Show this help message

Examples:
  email-mcp                         # Start MCP server
  email-mcp account list             # List configured accounts
  email-mcp account add              # Add a new email account
  email-mcp account edit personal    # Edit an account
  email-mcp account delete work      # Delete an account
  email-mcp setup                    # Alias for account add
  email-mcp test                     # Test all accounts
  email-mcp test personal            # Test specific account
  email-mcp install                  # Register with detected MCP clients
  email-mcp install status           # Show client registration status
  email-mcp install remove           # Unregister from MCP clients
  email-mcp config show              # Show config (passwords masked)
  email-mcp config edit              # Edit global settings
  email-mcp config path              # Print config file path
  email-mcp config init              # Create template config
  email-mcp config validate          # Check syntax, schema, typos, consistency (no connection)
  email-mcp scheduler check          # Send overdue scheduled emails
  email-mcp scheduler install        # Install OS periodic check
  email-mcp notify test              # Send a test notification
  email-mcp notify status            # Check notification platform support
`.trim();

async function runServer(): Promise<void> {
  const config = await loadConfig();

  // IMAP/SMTP or Microsoft Graph, per account — the same wiring as the CLI.
  const { connections, imapService, graphService, mailService, sendService, oauthService } =
    createMailBackends(config);
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(
    sendService,
    mailService,
    config.accounts.map((account) => account.name),
  );
  // La veille IDLE reçoit le service de jetons du serveur : un compte OAuth2 s'y
  // authentifie avec un vrai jeton d'accès. Elle écarte d'elle-même les comptes
  // Graph, qui n'ont pas de session IMAP.
  const watcherService = new WatcherService(config.settings.watcher, config.accounts, oauthService);
  // Les hooks ne reçoivent d'événements que de la veille IDLE, donc de comptes
  // IMAP : ils gardent le service IMAP. En lecture seule, leurs actions sur la
  // boîte (libellés, drapeaux, marquer lu) sont désactivées dès la construction.
  const hooksService = new HooksService(config.settings.hooks, imapService, {
    readOnly: config.settings.readOnly,
  });
  const searchPresetRegistry = new SearchPresetRegistry(config.searches);

  const server = createServer();

  registerAllTools(
    server,
    connections,
    mailService,
    sendService,
    config,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
    searchPresetRegistry,
    graphService,
  );
  // Les ressources passent par le routeur, comme les outils : `stats`,
  // `unread` et `mailboxes` d'un compte Graph partaient sur IMAP — un compte
  // dont la session IMAP n'existe pas — et échouaient.
  registerAllResources(server, connections, mailService, templateService, schedulerService);
  registerAllPrompts(server);

  // Transport stdio branché à la main (SDK v2) plutôt que `serveStdio()` : la
  // connexion reste une session 2025 classique (`initialize` puis
  // `notifications/initialized`), la seule que parle Claude Desktop. Les
  // révisions 2024-10-07 à 2025-11-25 restent négociées. `serveStdio()`
  // ajouterait l'ère 2026-07-28, mais sans poignée de main — donc sans
  // `oninitialized` pour lancer les services ci-dessous — et sans
  // `createMessage` poussé du serveur, dont dépend le tri des hooks.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // --- Post-handshake initialization ----------------------------------------
  // Everything below is deferred until the client completes the MCP
  // `initialize` / `initialized` handshake.  This prevents notifications
  // from being written to stdout before the client is ready, which would
  // crash clients like Vibe, and ensures `getClientCapabilities()` returns
  // the real capabilities (including `sampling` support).
  // --------------------------------------------------------------------------

  const lowLevelServer = server.server;

  // Arrêt de la purge d'historique, remplacé quand elle démarre.
  let stopSentPruning: () => void = () => {};

  lowLevelServer.oninitialized = () => {
    // eslint-disable-next-line no-void
    void (async () => {
      try {
        const clientCaps = lowLevelServer.getClientCapabilities?.() ?? {};
        hooksService.start(lowLevelServer, { sampling: clientCaps.sampling != null });

        await watcherService.start();

        await mcpLog('info', 'server', 'Email MCP server started');

        // Sends overdue scheduled emails now and every minute — unless the
        // server is read-only, in which case it logs why and does nothing.
        await schedulerService.start({ readOnly: config.settings.readOnly });

        // Historique des envois programmés borné dans le temps (même règle
        // que le planificateur : rien en lecture seule).
        if (!config.settings.readOnly) {
          stopSentPruning = startSentHistoryPruning(
            config.settings.sentRetentionDays ?? DEFAULT_SENT_RETENTION_DAYS,
          );
        }
      } catch (err) {
        // Écriture directe sur stderr : ne dépend d'aucun module qui aurait pu échouer.
        process.stderr.write(
          `[email-mcp] post-init error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    })();
  };

  // Arrêt propre, idempotent et borné à 5 s (voir shutdown.ts). Sous Windows,
  // Claude Desktop ferme stdin au lieu d'envoyer un signal : sans les
  // déclencheurs stdin/transport, le processus restait orphelin, connexions
  // IMAP ouvertes.
  const shutdown = createShutdown([
    { name: 'scheduler', run: () => schedulerService.stop() },
    { name: 'sent-history pruning', run: () => stopSentPruning() },
    { name: 'hooks', run: () => hooksService.stop() },
    { name: 'watcher', run: async () => watcherService.stop() },
    { name: 'connections', run: async () => connections.closeAll() },
    { name: 'transport', run: async () => server.close() },
  ]);

  installShutdownTriggers(shutdown);
  // Fermeture du transport MCP (le client a raccroché) : même arrêt.
  lowLevelServer.onclose = () => {
    shutdown('transport closed').catch(() => {});
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stdio';

  switch (command) {
    case 'stdio':
      await runServer();
      break;

    case 'setup': {
      const { default: runSetup } = await import('./cli/setup.js');
      await runSetup();
      break;
    }

    case 'account': {
      const { default: runAccountCommand } = await import('./cli/account-commands.js');
      await runAccountCommand(process.argv[3], process.argv[4]);
      break;
    }

    case 'test': {
      const { default: runTest } = await import('./cli/test.js');
      await runTest(process.argv[3]);
      break;
    }

    case 'config': {
      const { default: runConfigCommand } = await import('./cli/config-commands.js');
      await runConfigCommand(process.argv[3]);
      break;
    }

    case 'install': {
      const { default: runInstallCommand } = await import('./cli/install-commands.js');
      await runInstallCommand(process.argv[3]);
      break;
    }

    case 'scheduler': {
      const { default: runSchedulerCommand } = await import('./cli/scheduler.js');
      await runSchedulerCommand(process.argv[3]);
      break;
    }

    case 'notify': {
      const { default: runNotifyCommand } = await import('./cli/notify.js');
      await runNotifyCommand(process.argv[3]);
      break;
    }

    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
