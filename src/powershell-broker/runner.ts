import { spawn } from 'node:child_process';
import path from 'node:path';
import type { PowerShellInvocation } from './policy.js';

export interface PowerShellRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface PowerShellBrokerRunner {
  run(invocation: PowerShellInvocation): Promise<PowerShellRunnerResult>;
}

const ENV_ALLOWLIST = [
  'SystemRoot',
  'WINDIR',
  'OS',
  'TEMP',
  'TMP',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
  'ProgramFiles',
  'ProgramFiles(x86)',
] as const;

function windowsRoot(source: NodeJS.ProcessEnv = process.env): string {
  return source.SystemRoot ?? source.WINDIR ?? 'C:\\Windows';
}

function trustedCommandShell(source: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(windowsRoot(source), 'System32', 'cmd.exe');
}

export function buildPowerShellBrokerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }

  const root = windowsRoot(source);
  const commandShell = trustedCommandShell(source);
  const trustedPathEntries = [
    path.dirname(process.execPath),
    path.win32.join(root, 'System32'),
    path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    root,
  ];

  env.OS = source.OS ?? (process.platform === 'win32' ? 'Windows_NT' : env.OS);
  env.COMSPEC = commandShell;
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  env.PATH = [...new Set(trustedPathEntries.filter(Boolean))].join(path.delimiter);

  // Fixed verification capabilities invoke only repository-owned npm scripts.
  // Do not let ambient user/global npm configuration redirect their script shell,
  // inject a custom config, or add unrelated network/update behavior.
  env.NPM_CONFIG_SCRIPT_SHELL = commandShell;
  env.NPM_CONFIG_USERCONFIG = 'NUL';
  env.NPM_CONFIG_GLOBALCONFIG = 'NUL';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  env.NPM_CONFIG_FUND = 'false';
  env.NPM_CONFIG_AUDIT = 'false';

  return env;
}

function appendBounded(current: string, chunk: Buffer, limit: number): string {
  if (current.length >= limit) return current;
  return (current + chunk.toString('utf8')).slice(0, limit);
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const taskkill = path.win32.join(windowsRoot(), 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      env: buildPowerShellBrokerEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process may have exited between timeout and kill; close handler remains authoritative.
  }
}

export class NodePowerShellBrokerRunner implements PowerShellBrokerRunner {
  constructor(private readonly outputLimitBytes = 256 * 1024) {}

  async run(invocation: PowerShellInvocation): Promise<PowerShellRunnerResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.file, invocation.args, {
        cwd: invocation.cwd,
        env: buildPowerShellBrokerEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child.pid);
      }, invocation.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, this.outputLimitBytes); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, this.outputLimitBytes); });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: typeof code === 'number' ? code : -1, stdout, stderr, timedOut });
      });
    });
  }
}
