import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildPowerShellBrokerEnvironment, resolveTrustedGitExecutable } from '../powershell-broker/runner.js';

function main(): void {
  if (process.platform !== 'win32') {
    console.log('SKIP PowerShell Broker trusted-Git regression: Windows-only executable resolution.');
    return;
  }

  const poisoned: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: 'C:\\attacker-controlled-bin',
    COMSPEC: 'C:\\attacker-controlled-bin\\cmd.exe',
    PATHEXT: '.EVIL',
    NPM_CONFIG_SCRIPT_SHELL: 'C:\\attacker-controlled-bin\\evil.exe',
    NPM_CONFIG_USERCONFIG: 'C:\\attacker-controlled-bin\\npmrc',
    OPENAI_API_KEY: 'secret-openai',
    GH_TOKEN: 'secret-github',
    NEXUS_DASHBOARD_TOKEN: 'secret-nexus',
  };

  const trustedGit = resolveTrustedGitExecutable(poisoned);
  assert.ok(trustedGit, 'Trusted Git must resolve from a fixed Program Files location on the Windows verification host.');
  assert.equal(path.win32.isAbsolute(trustedGit), true);
  assert.equal(path.win32.basename(trustedGit).toLowerCase(), 'git.exe');

  const env = buildPowerShellBrokerEnvironment(poisoned);
  assert.equal(env.PATH?.toLowerCase().includes('attacker-controlled-bin'), false);
  assert.equal(env.PATH?.toLowerCase().includes(path.win32.dirname(trustedGit).toLowerCase()), true);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NEXUS_DASHBOARD_TOKEN, undefined);

  const version = execFileSync('git.exe', ['--version'], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.match(version, /^git version\s+/i);
  console.log('PASS PowerShell Broker trusted-Git regression: fixed Program Files Git resolves inside the sanitized environment while ambient PATH and secrets remain excluded.');
}

main();
