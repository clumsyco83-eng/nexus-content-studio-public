import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPowerShellBrokerEnvironment, resolveTrustedGitExecutable } from '../powershell-broker/runner.js';

function exerciseProductionGitWrapper(env: NodeJS.ProcessEnv): void {
  const brokerPath = path.resolve('scripts', 'powershell-broker-v1.ps1');
  const brokerSource = readFileSync(brokerPath, 'utf8');
  const match = brokerSource.match(/function Invoke-GitChecked \{[\s\S]*?\n\}\r?\n\r?\nfunction Assert-ExpectedOrigin/);
  assert.ok(match, 'Production Invoke-GitChecked function must remain extractable for the Windows regression.');
  const functionSource = match[0]!.replace(/\r?\n\r?\nfunction Assert-ExpectedOrigin$/, '');

  assert.match(functionSource, /\$ErrorActionPreference\s*=\s*'Continue'/, 'Production Git wrapper must temporarily tolerate native stderr records.');
  assert.match(functionSource, /\$exitCode\s*=\s*\[int\]\$LASTEXITCODE/, 'Production Git wrapper must make the native child exit code authoritative.');

  const temp = mkdtempSync(path.join(os.tmpdir(), 'nexus-broker-git-stderr-'));
  const probePath = path.join(temp, 'probe.ps1');
  const escapedTemp = temp.replace(/'/g, "''");
  const escapedGit = (resolveTrustedGitExecutable(env) ?? '').replace(/'/g, "''");
  const probe = `$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n${functionSource}\n\n$git = '${escapedGit}'\n$root = '${escapedTemp}'\n$source = Join-Path $root 'source'\n$target = Join-Path $root 'target'\nNew-Item -ItemType Directory -Force -Path $source, $target | Out-Null\nInvoke-GitChecked -Git $git -RepoRoot $source -Arguments @('init','--initial-branch=main') | Out-Null\nInvoke-GitChecked -Git $git -RepoRoot $source -Arguments @('config','user.email','nexus-ci@example.invalid') | Out-Null\nInvoke-GitChecked -Git $git -RepoRoot $source -Arguments @('config','user.name','NEXUS CI') | Out-Null\nSet-Content -LiteralPath (Join-Path $source 'probe.txt') -Value 'nexus git stderr regression' -Encoding ascii\nInvoke-GitChecked -Git $git -RepoRoot $source -Arguments @('add','probe.txt') | Out-Null\nInvoke-GitChecked -Git $git -RepoRoot $source -Arguments @('commit','-m','probe') | Out-Null\nInvoke-GitChecked -Git $git -RepoRoot $target -Arguments @('init','--initial-branch=main') | Out-Null\nInvoke-GitChecked -Git $git -RepoRoot $target -Arguments @('remote','add','origin',$source) | Out-Null\n$fetchOutput = @(Invoke-GitChecked -Git $git -RepoRoot $target -Arguments @('fetch','--progress','origin','main'))\nif ($fetchOutput.Count -eq 0) { throw 'Expected git fetch --progress to emit bounded native output for the regression.' }\n$fetchHead = ((Invoke-GitChecked -Git $git -RepoRoot $target -Arguments @('rev-parse','FETCH_HEAD')) | Out-String).Trim()\nif ($fetchHead -notmatch '^[0-9a-f]{40}$') { throw 'FETCH_HEAD was not produced after the successful native-stderr fetch.' }\n$nonZeroRejected = $false\ntry { Invoke-GitChecked -Git $git -RepoRoot $target -Arguments @('rev-parse','refs/heads/definitely-missing') | Out-Null } catch { $nonZeroRejected = $true }\nif (-not $nonZeroRejected) { throw 'Production Git wrapper did not reject a real nonzero Git exit.' }\nWrite-Output 'PASS production Invoke-GitChecked native-stderr regression.'\n`;
  writeFileSync(probePath, probe, 'utf8');

  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probePath], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /PASS production Invoke-GitChecked native-stderr regression\./);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

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

  exerciseProductionGitWrapper(env);

  console.log('PASS PowerShell Broker trusted-Git/npm regression: fixed Program Files Git, production native-stderr-safe Git execution, and sanitized npm TypeScript execution work through the trusted command shell while ambient PATH/config/secrets remain excluded.');
}

main();
