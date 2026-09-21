/**
 * Tests for the Windows Task Scheduler definition. Registering the task needs
 * Windows itself; what can go wrong silently — the command line and the
 * settings the task is created with — is checked here on the XML.
 */

import { describe, expect, it } from 'vitest';

import { buildTaskXml, quoteWindowsArg } from './windows-task.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const MAIN = 'D:\\Dev & Co\\email-mcp\\dist\\main.js';
const COMMAND_LINE = [NODE, MAIN, 'scheduler', 'check'];

function field(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
}

describe('quoteWindowsArg', () => {
  it('leaves a plain argument as it is', () => {
    expect(quoteWindowsArg('scheduler')).toBe('scheduler');
    expect(quoteWindowsArg('C:\\nodejs\\node.exe')).toBe('C:\\nodejs\\node.exe');
  });

  it('quotes an argument with spaces, and an empty one', () => {
    expect(quoteWindowsArg(NODE)).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(quoteWindowsArg('')).toBe('""');
  });

  it('escapes quotes and doubles the backslashes that precede them', () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('C:\\my dir\\')).toBe('"C:\\my dir\\\\"');
  });
});

describe('buildTaskXml', () => {
  const base = {
    userId: 'PC\\Pierre',
    commandLine: COMMAND_LINE,
    start: new Date(2026, 8, 22, 9, 5, 0),
  };

  it('runs the check through a windowless console while signed in', () => {
    const xml = buildTaskXml({ ...base, logonType: 'InteractiveToken' });

    expect(field(xml, 'LogonType')).toBe('InteractiveToken');
    expect(field(xml, 'Command')).toMatch(/\\System32\\conhost\.exe$/);
    expect(field(xml, 'Arguments')).toBe(
      '--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; ' +
        '&quot;D:\\Dev &amp; Co\\email-mcp\\dist\\main.js&quot; scheduler check',
    );
  });

  it('runs node directly in the background (S4U), where no window can appear', () => {
    const xml = buildTaskXml({ ...base, logonType: 'S4U' });

    expect(field(xml, 'LogonType')).toBe('S4U');
    expect(field(xml, 'Command')).toBe(NODE);
    expect(field(xml, 'Arguments')).toBe(
      '&quot;D:\\Dev &amp; Co\\email-mcp\\dist\\main.js&quot; scheduler check',
    );
  });

  it('repeats every minute from now, never running two checks at once', () => {
    const xml = buildTaskXml({ ...base, logonType: 'InteractiveToken' });

    expect(field(xml, 'StartBoundary')).toBe('2026-09-22T09:05:00');
    expect(field(xml, 'Interval')).toBe('PT1M');
    expect(xml).not.toContain('<Duration>');
    expect(field(xml, 'MultipleInstancesPolicy')).toBe('IgnoreNew');
    expect(field(xml, 'DisallowStartIfOnBatteries')).toBe('false');
    expect(field(xml, 'UserId')).toBe('PC\\Pierre');
  });
});
