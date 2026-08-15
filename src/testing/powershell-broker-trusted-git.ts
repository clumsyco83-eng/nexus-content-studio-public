import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildPowerShellBrokerEnvironment, resolveTrustedGitExecutable } from '../powershell-broker/runner.js';

function main(): void {
  if (process.platform !== 'win32') {
    console.log('SKIP PowerShell Broker trusted-Git/npm regression: Windows-only executable resolution.');
    return;
  }

  const poisoned: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: 'C:\\attacker-controlled-bin',
    COMSPEC: 'C:\\attacker-controlled-bin\\cmd.exe',
    PATHEXT: '.EVIL',
    NPM_CONFIG_SCRIPT_SHELL: 'C:\\attacker-controlled-bin\\evil.exe',
    NPM_CONFIG_USERCONFIG: 'C:\\attacker-controlled-bin\\npm-user-rc',
    NPM_CONFIG_GLOBALCONFIG: 'C:\\attacker-controlled-bin\\npm-global-rc',
    OPENAI_API_KEY: 'secret-openai',
    GH_TOKEN: 'secret-github',
    NEXUS_DASHBOARD_TOKEN: 'secret-nexus',
  };

  const trustedGit = resolveTrustedGitExecutable(poisoned);
  assert.ok(trustedGit, 'Trusted Git must resolve from a fixed Program Files location on the Windows verification host.');
  assert.equal(path.win32.isAbsolute(trustedGit), true);
  assert.equal(path.win32.basename(trustedGit).toLowerCase(), 'git.exe');

  const env = buildPowerShellBrokerEnvironment(poisoned);
  assert.equal(env.PATH?.toLowerCase().includes('attacker-controlled-bin'), false, 'Ambient PATH must remain excluded.');
  assert.equal(env.PATH?.toLowerCase().includes(path.win32.dirname(trustedGit).toLowerCase()), true, 'Only the trusted Git directory should be admitted.');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NEXUS_DASHBOARD_TOKEN, undefined);

  assert.ok(env.NPM_CONFIG_USERCONFIG, 'Sanitized npm user config path must be fixed.');
  assert.ok(env.NPM_CONFIG_GLOBALCONFIG, 'Sanitized npm global config path must be fixed.');
  assert.ok(env.COMSPEC, 'Trusted command shell must be fixed.');
  assert.equal(path.win32.isAbsolute(env.NPM_CONFIG_USERCONFIG), true);
  assert.equal(path.win32.isAbsolute(env.NPM_CONFIG_GLOBALCONFIG), true);
  assert.equal(path.win32.basename(env.NPM_CONFIG_USERCONFIG).toUpperCase(), 'NUL');
  assert.equal(path.win32.basename(env.NPM_CONFIG_GLOBALCONFIG).toUpperCase(), 'NUL');
  assert.notEqual(
    env.NPM_CONFIG_USERCONFIG.toLowerCase(),
    env.NPM_CONFIG_GLOBALCONFIG.toLowerCase(),
    'npm 11 must receive distinct user/global config paths to avoid double-loading rejection.',
  );
  assert.equal(env.NPM_CONFIG_USERCONFIG.toLowerCase().includes('attacker-controlled-bin'), false);
  assert.equal(env.NPM_CONFIG_GLOBALCONFIG.toLowerCase().includes('attacker-controlled-bin'), false);

  const version = execFileSync('git.exe', ['--version'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.match(version, /^git version\s+/i);

  const npmVersion = execFileSync(env.COMSPEC, ['/d', '/s', '/c', 'npm.cmd --version'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+/);

  execFileSync(env.COMSPEC, ['/d', '/s', '/c', 'npm.cmd run check'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  console.log('PASS PowerShell Broker trusted-Git/npm regression: fixed Program Files Git and sanitized npm TypeScript execution work through the trusted command shell with distinct absolute null-device config paths while ambient PATH/config/secrets remain excluded.');
}

main();
