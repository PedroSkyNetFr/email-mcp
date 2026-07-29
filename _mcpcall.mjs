/**
 * Drive the built MCP server over stdio, the way an MCP client does.
 *
 * Usage: node _mcpcall.mjs <serverName> <callsJsonFile>
 * The calls file is [{ "name": "list_mailboxes", "args": { ... } }, ...]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [serverName, callsFile] = process.argv.slice(2);
const cfgPath = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const entry = cfg.mcpServers[serverName];
if (!entry) throw new Error(`No server "${serverName}"`);

const calls = JSON.parse(readFileSync(callsFile, 'utf8'));

const child = spawn('node', ['dist/main.js', 'stdio'], {
  env: { ...process.env, ...entry.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const timeout = setTimeout(() => {
  console.log('TIMEOUT — no answer within 90s');
  child.kill();
  process.exit(1);
}, 90_000);

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '1' },
});
notify('notifications/initialized');

for (const call of calls) {
  const res = await rpc('tools/call', { name: call.name, arguments: call.args ?? {} });
  const text = res.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(res.error ?? res);
  const flag = res.result?.isError ? 'ERROR' : 'OK';
  console.log(`\n=== ${call.name} [${flag}] ===`);
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}\n…(tronqué)` : text);
}

clearTimeout(timeout);
child.kill();
process.exit(0);
