/**
 * Drive the built MCP server over stdio, the way a real MCP client does.
 *
 * Typechecking proves the wiring, not the behaviour: several defects survived a
 * green build and only surfaced when the tools were actually called against a
 * live mailbox — Graph rejecting `$skip` with `$search`, a draft id schema that
 * refused Graph's opaque string ids, health probing a transport the account
 * does not use. This harness exists to catch that class of thing.
 *
 *   pnpm mcp:call <serverName> <callsJsonFile>
 *
 * `serverName` is an entry under "mcpServers" in the MCP client config; its env
 * block is applied to the spawned server, so no credential is retyped. The calls
 * file is a list of tool invocations:
 *
 *   [ { "name": "list_mailboxes", "args": { "account": "work" } } ]
 *
 * Whatever the calls do, the server does: point it at a test folder before
 * running anything that writes.
 *
 * Options:
 *   --config <path>   MCP client config (default: %APPDATA%\Claude\claude_desktop_config.json)
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--config');
const configPath =
  flagIndex >= 0
    ? args[flagIndex + 1]
    : path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
// Drop the --config pair only when it is actually present: with flagIndex at -1
// the "flagIndex + 1" test would silently swallow the first positional argument.
const positional =
  flagIndex >= 0 ? args.filter((_, i) => i !== flagIndex && i !== flagIndex + 1) : args;
const [serverName, callsFile] = positional;

if (!serverName || !callsFile) {
  console.error('Usage: pnpm mcp:call <serverName> <callsJsonFile> [--config <path>]');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const entry = config.mcpServers?.[serverName];
if (!entry) {
  console.error(
    `No server "${serverName}". Available: ${Object.keys(config.mcpServers ?? {}).join(', ')}`,
  );
  process.exit(1);
}

const calls = JSON.parse(readFileSync(callsFile, 'utf8'));

const child = spawn('node', ['dist/main.js', 'stdio'], {
  env: { ...process.env, ...entry.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// The server speaks newline-delimited JSON-RPC on stdout.
let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        // Not a JSON-RPC frame — ignore.
      }
    }
    index = buffer.indexOf('\n');
  }
});
child.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));

let nextId = 1;
function rpc(method, params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const timer = setTimeout(() => {
  console.error('TIMEOUT — the server did not answer within 120s');
  child.kill();
  process.exit(1);
}, 120_000);

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'mcp-call', version: '1' },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

let failures = 0;
for (const call of calls) {
  // eslint-disable-next-line no-await-in-loop -- calls are ordered on purpose
  const response = await rpc('tools/call', { name: call.name, arguments: call.args ?? {} });
  const body =
    response.result?.content?.map((c) => c.text).join('\n') ??
    JSON.stringify(response.error ?? response);
  const failed = Boolean(response.result?.isError || response.error);
  if (failed) failures += 1;
  console.log(`\n=== ${call.name} [${failed ? 'ERROR' : 'OK'}] ===`);
  console.log(body.length > 1500 ? `${body.slice(0, 1500)}\n…(truncated)` : body);
}

clearTimeout(timer);
child.kill();
console.log(`\n${calls.length - failures}/${calls.length} calls succeeded.`);
process.exit(failures > 0 ? 1 : 0);
