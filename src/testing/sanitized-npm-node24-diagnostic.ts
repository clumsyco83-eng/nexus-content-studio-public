import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildPowerShellBrokerEnvironment } from '../powershell-broker/runner.js';

const env = buildPowerShellBrokerEnvironment();
const root = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
const volumeRoot = path.win32.parse(root).root || 'C:\\';
const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// npm 11 rejects identical user/global config paths. Keep both isolated from
// ambient configuration while giving npm two distinct Windows null-device paths.
env.NPM_CONFIG_USERCONFIG = path.win32.join(volumeRoot, 'NUL');
env.NPM_CONFIG_GLOBALCONFIG = path.win32.join(root, 'NUL');

const result = spawnSync(
  powershell,
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '& npm.cmd run check; exit $LASTEXITCODE',
  ],
  {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    windowsHide: true,
  },
);

console.log(`diagnostic-node=${process.version}`);
console.log(`diagnostic-status=${String(result.status)}`);
console.log(`diagnostic-userconfig=${String(env.NPM_CONFIG_USERCONFIG)}`);
console.log(`diagnostic-globalconfig=${String(env.NPM_CONFIG_GLOBALCONFIG)}`);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);

if (result.status !== 0) process.exit(result.status ?? 1);
console.log('PASS sanitized npm TypeScript check under Node 24.18 with distinct null-device configs.');
