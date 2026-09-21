/**
 * Windows Task Scheduler support for `email-mcp scheduler install`.
 *
 * The task runs `email-mcp scheduler check` every minute, registered from an
 * XML definition through schtasks.exe (built into Windows, no dependency).
 *
 * Two ways to run it without a console window popping up every minute:
 *
 * - S4U ("run whether the user is signed in or not", no password stored):
 *   in the background, even signed out. Windows lets only an administrator
 *   register it.
 * - Otherwise, a task that runs while the user is signed in, started through
 *   `conhost.exe --headless`, which hosts the console program without a
 *   window. Launched directly, node.exe would open one on every run.
 */

/* eslint-disable n/no-sync -- short CLI calls to schtasks.exe and PowerShell */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const WINDOWS_TASK_NAME = 'email-mcp scheduler';

export type WindowsLogonType = 'S4U' | 'InteractiveToken';

/** SCHED_S_TASK_HAS_NOT_RUN: the task is registered but has not run yet */
const TASK_HAS_NOT_RUN = 0x41303;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Quote one argument for a Windows command line, following the rules the C
 * runtime uses to split it back: backslashes only need doubling before a quote.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/** Local date-time without zone, as Task Scheduler reads StartBoundary */
function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * The task definition. `commandLine` is the program and its arguments, run
 * every minute from `start`, never twice at once.
 */
export function buildTaskXml(options: {
  userId: string;
  logonType: WindowsLogonType;
  commandLine: string[];
  start: Date;
}): string {
  const [program, ...args] = options.commandLine;
  const conhost = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');
  const [command, commandArgs] =
    options.logonType === 'InteractiveToken'
      ? [conhost, ['--headless', program, ...args]]
      : [program, args];

  // IgnoreNew: a check still running is never joined by a second one.
  // ExecutionTimeLimit ends a check stuck far beyond any send's own timeouts.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sends overdue scheduled emails: email-mcp scheduler check, every minute.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localTimestamp(options.start)}</StartBoundary>
      <Repetition>
        <Interval>PT1M</Interval>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(options.userId)}</UserId>
      <LogonType>${options.logonType}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(commandArgs.map(quoteWindowsArg).join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function commandError(err: unknown): string {
  // schtasks explains itself on stderr; an empty one falls back to the message
  const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
  if (stderr) return stderr;
  return err instanceof Error ? err.message : String(err);
}

async function registerTask(xml: string): Promise<void> {
  const file = path.join(os.tmpdir(), `email-mcp-task-${process.pid}.xml`);
  // schtasks reads the definition in the encoding its XML declares: UTF-16
  await fs.writeFile(file, `\uFEFF${xml}`, 'utf16le');
  try {
    execFileSync('schtasks.exe', ['/Create', '/XML', file, '/TN', WINDOWS_TASK_NAME, '/F'], {
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(commandError(err));
  } finally {
    await fs.rm(file, { force: true });
  }
}

/**
 * Register the task: S4U when allowed, otherwise while signed in.
 * Returns the mode it was registered with.
 */
export async function installWindowsTask(commandLine: string[]): Promise<WindowsLogonType> {
  const userId = `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`;
  const start = new Date();
  try {
    await registerTask(buildTaskXml({ userId, logonType: 'S4U', commandLine, start }));
    return 'S4U';
  } catch {
    // Most often "access denied": S4U needs an administrator
    await registerTask(buildTaskXml({ userId, logonType: 'InteractiveToken', commandLine, start }));
    return 'InteractiveToken';
  }
}

/** Remove the task; false when there was none. */
export function removeWindowsTask(): boolean {
  try {
    execFileSync('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface WindowsTaskStatus {
  state: string;
  logonType: string;
  /** null when the task has not run yet */
  lastRun: string | null;
  /** 0 on success; the process exit code or scheduler error otherwise */
  lastResult: number | null;
  nextRun: string | null;
}

/**
 * The task's state and last run, or null when it is not installed. Read
 * through PowerShell: schtasks prints translated labels, this does not.
 */
export function windowsTaskStatus(): WindowsTaskStatus | null {
  const script =
    `$t = Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction Stop; ` +
    '$i = $t | Get-ScheduledTaskInfo; ' +
    '[pscustomobject]@{ state = "$($t.State)"; logonType = "$($t.Principal.LogonType)"; ' +
    "lastRun = $i.LastRunTime.ToString('o'); lastResult = $i.LastTaskResult; " +
    "nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null } } | ConvertTo-Json";
  let output: string;
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const raw = JSON.parse(output) as {
    state: string;
    logonType: string;
    lastRun: string;
    lastResult: number;
    nextRun: string | null;
  };
  const neverRan = raw.lastResult === TASK_HAS_NOT_RUN;
  return {
    state: raw.state,
    logonType: raw.logonType,
    lastRun: neverRan ? null : raw.lastRun,
    lastResult: neverRan ? null : raw.lastResult,
    nextRun: raw.nextRun,
  };
}
