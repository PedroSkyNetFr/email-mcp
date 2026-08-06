# Contributing to email-mcp

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/email-mcp.git
   cd email-mcp
   ```
3. Install dependencies:
   ```bash
   pnpm install
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feat/your-feature
   ```

## Development

### Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** (package manager)

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start in watch mode (auto-reload) |
| `pnpm build` | Build for production |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Run ESLint with auto-fix |
| `pnpm format` | Format code with Biome |
| `pnpm format:check` | Check formatting |
| `pnpm check` | Run both Biome and ESLint |
| `pnpm test` | Run the unit tests |
| `pnpm test:watch` | Unit tests in watch mode |
| `pnpm test:coverage` | Unit tests with coverage report |
| `pnpm test:integration` | Integration tests — **requires a running Docker daemon** (GreenMail is started via testcontainers) |
| `pnpm test:all` | Unit + integration |

### Code Style

- **Formatter:** [Biome](https://biomejs.dev/) — handles formatting and import organization
- **Linter:** [ESLint](https://eslint.org/) with Airbnb Extended + TypeScript strict rules
- Run `pnpm check` before committing to catch issues

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add calendar event parsing
fix: handle null subject in email headers
docs: update configuration guide
refactor: extract connection retry logic
test: add rate limiter unit tests
```

## Project Structure

```
src/
├── main.ts              # CLI entry point
├── server.ts            # MCP server factory
├── logging.ts           # Protocol logging bridge
├── cli/                 # CLI commands (setup, test, config)
├── config/              # Config loading + validation
├── connections/         # IMAP/SMTP connection management
├── services/            # Business logic (IMAP, Graph, SMTP, calendar, etc.)
│   └── graph/           # Microsoft Graph backend (Exchange / Outlook.com)
├── routing/             # Cross-account move logic
├── tools/               # MCP tool definitions
├── resources/           # MCP resource definitions
├── prompts/             # MCP prompt definitions
├── safety/              # Rate limiter + audit logging
├── utils/               # Pure helpers (body formatting, header parsing, dates)
├── types/               # TypeScript type definitions
└── __integration__/     # Integration tests (GreenMail via testcontainers)
```

Two backends serve accounts side by side: `ImapService` by default, `GraphService`
for accounts declared with `backend = "graph"`. `services/mail-router.ts` dispatches
per account. **A change must keep both working** — when you add a method to
`ImapService` it becomes part of the `IMailService` contract, and a Graph account
calling it gets an explicit "not supported yet" error until `GraphService`
implements it too.

## Seeing Your Change in an MCP Client

An MCP server over stdio is a process the client spawns at startup. Two things
therefore stand between an edit and a tool an assistant can call:

1. **The build.** MCP clients are usually configured to run `dist/main.js`, so a
   change under `src/` is invisible until `pnpm build`. The pre-push hook runs
   the build for this reason, but between commits it is on you.
2. **The client restart.** Even with a fresh `dist/`, the already-running server
   process keeps serving the code it started with. Restart the client (or
   reconnect the server) to reload the tool list.

The failure mode is quiet and easy to misread: a newly added tool is simply
absent from `tools/list`, which reads exactly like "that feature does not
exist". `check_health` reports which build is actually running — version,
`src` vs `dist`, and the build date — so check that first when a documented
tool appears to be missing.

To take the build step out of the loop entirely during development, point the
client at the sources instead of the compiled output:

```jsonc
{
  "command": "node",
  "args": [
    "<repo>/node_modules/tsx/dist/cli.mjs",
    "<repo>/src/main.ts",
    "stdio"
  ]
}
```

The client restart is still required, but `dist/` can no longer go stale
underneath you.

## Adding a New MCP Tool

1. Create a new file in `src/tools/` (e.g., `my-feature.tool.ts`)
2. Export a default function that takes the MCP server + services
3. Use `server.tool()` with Zod schemas for input validation
4. Add tool annotations (`readOnlyHint`, `destructiveHint`, etc.)
5. Put the logic in a service method, not in the tool handler — the handler should
   parse input, call the service and format the response, so the behaviour stays
   unit-testable without an MCP server
6. Implement that method on **both** backends (`ImapService` and `GraphService`),
   or accept that Graph accounts will get the router's "not supported yet" error
7. If the method does not take the account name as its first argument, declare its
   shape in `ACCOUNTS_IN_ARGS` (`src/services/mail-router.ts`) — otherwise calls
   for Graph accounts are silently routed to IMAP
8. Register it in `src/tools/register.ts` (read tools are always registered; write
   tools go inside the `if (!readOnly)` block) and add it to the mock list in
   `src/tools/register.test.ts`
9. Add to the tools reference table in `README.md`, and keep the tool counts in the
   section headings in sync

## Pull Request Process

1. Ensure `pnpm check` and `pnpm typecheck` pass
2. Update documentation if your change affects user-facing behavior
3. Write a clear PR description explaining what and why
4. Link any related issues

## Reporting Issues

- Use [GitHub Issues](https://github.com/codefuturist/email-mcp/issues) for bugs and feature requests
- Use [GitHub Discussions](https://github.com/codefuturist/email-mcp/discussions) for questions and ideas

## License

By contributing, you agree that your contributions will be licensed under the [LGPL-3.0-or-later License](LICENSE).
