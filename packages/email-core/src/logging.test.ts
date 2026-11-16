import type { MockInstance } from 'vitest';

import { mcpLog } from './logging.js';

// ---------------------------------------------------------------------------
// mcpLog écrit sur stderr, une ligne horodatée par message, jamais sur stdout.
// ---------------------------------------------------------------------------

describe('mcpLog', () => {
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Les lignes écrites sur stderr pendant le test. */
  function stderrLines(): string[] {
    return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  it('writes one timestamped line with level and logger to stderr', async () => {
    await expect(mcpLog('info', 'server', 'Email MCP server started')).resolves.toBeUndefined();

    const lines = stderrLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO \[server\] Email MCP server started\n$/,
    );
  });

  it('never writes to stdout, which carries the JSON-RPC stream', async () => {
    await mcpLog('error', 'imap', 'boom');
    await mcpLog('debug', 'watcher', { folder: 'INBOX' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('serializes objects as JSON and errors by their message', async () => {
    await mcpLog('warning', 'hooks', { account: 'work', count: 2 });
    await mcpLog('error', 'smtp', new Error('connection refused'));

    const [objectLine, errorLine] = stderrLines();
    expect(objectLine).toContain('WARNING [hooks] {"account":"work","count":2}');
    expect(errorLine).toContain('ERROR [smtp] connection refused');
  });

  it('keeps a multi-line message on a single line', async () => {
    await mcpLog('info', 'server', 'first\nsecond\r\nthird');

    const [line] = stderrLines();
    expect(line).toContain('[server] first\\nsecond\\nthird\n');
    expect(line.split('\n')).toHaveLength(2); // le texte, puis le vide après le \n final
  });

  it('survives unserializable data', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(mcpLog('info', 'test', circular)).resolves.toBeUndefined();
    expect(stderrLines()[0]).toContain('[test] [object Object]');
  });

  it('swallows a failing stderr write', async () => {
    stderrSpy.mockImplementation(() => {
      throw new Error('EPIPE');
    });

    await expect(mcpLog('error', 'test', 'lost')).resolves.toBeUndefined();
  });
});
