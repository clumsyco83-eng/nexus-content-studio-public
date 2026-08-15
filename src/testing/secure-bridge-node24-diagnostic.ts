import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildPowerShellBrokerEnvironment } from '../powershell-broker/runner.js';

const env = buildPowerShellBrokerEnvironment();
const root = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = path.join(process.cwd(), 'scripts', 'windows-secure-bridge-verify.ps1');

const result = spawnSync(
  powershell,
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
  {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  },
);

console.log(`diagnostic-node=${process.version}`);
console.log(`diagnostic-status=${String(result.status)}`);
console.log(`npm-user-config=${env.NPM_CONFIG_USERCONFIG}`);
console.log(`npm-global-config=${env.NPM_CONFIG_GLOBALCONFIG}`);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);

if (result.status !== 0) process.exit(result.status ?? 1);
console.log('PASS sanitized Secure Bridge Windows addendum under Node 24.18.');
