import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  buildPowerShellInvocation,
  getPowerShellBrokerCapability,
  validatePowerShellBrokerRequest,
  type PowerShellBrokerRequest,
} from '../powershell-broker/policy.js';
import { parseRemoteCommandBody } from '../remote-transport/schema.js';

const repoRoot = path.resolve(process.cwd());
const now = new Date('2026-08-15T00:00:00.000Z');

function request(capability: PowerShellBrokerRequest['capability'], args: Record<string, string> = {}): PowerShellBrokerRequest {
  return {
    id: `completion-v2-${capability.replace(/[^a-z0-9]+/gi, '-')}`,
    goalId: 'test-goal',
    taskId: 'test-task',
    capability,
    args,
    cwd: repoRoot,
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    timeoutMs: 300_000,
  };
}

function assertCompletionV2Route(capability: PowerShellBrokerRequest['capability']): void {
  const req = request(capability);
  validatePowerShellBrokerRequest(req, repoRoot, now);
  const invocation = buildPowerShellInvocation(req, repoRoot, now);
  assert.equal(path.win32.basename(invocation.file).toLowerCase(), 'powershell.exe');
  assert.equal(path.basename(invocation.args[invocation.args.indexOf('-File') + 1]!).toLowerCase(), 'powershell-broker-completion-v2.ps1');
  assert.equal(invocation.args.includes('-Command'), false);
  assert.equal(invocation.args.includes(capability), true);
}

function main(): void {
  for (const capability of [
    'nexus.verification.run',
    'nexus.intelligence-foundation.complete',
    'nexus.claude.live-readiness',
  ] as const) {
    assertCompletionV2Route(capability);
    assert.equal(getPowerShellBrokerCapability(capability).riskClass, 'YELLOW');
    assert.throws(() => validatePowerShellBrokerRequest(request(capability, { command: 'whoami' }), repoRoot, now), /Expected exactly: \(none\)/);
  }

  const remote = parseRemoteCommandBody(JSON.stringify({
    schema: 'nexus.remote.command.v1',
    id: 'claude-live-readiness-remote-001',
    hostId: 'test-host',
    capability: 'nexus.claude.live-readiness',
    args: {},
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    timeoutMs: 120_000,
  }));
  assert.equal(remote.capability, 'nexus.claude.live-readiness');

  const ordinary = buildPowerShellInvocation(request('nexus.service.status'), repoRoot, now);
  assert.equal(path.basename(ordinary.args[ordinary.args.indexOf('-File') + 1]!).toLowerCase(), 'powershell-broker-v1.ps1');

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = path.join(repoRoot, 'scripts', 'powershell-broker-completion-v2.ps1');
    const parse = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{Write-Error $_.Message};exit 1}`,
    ], { cwd: repoRoot, windowsHide: true, encoding: 'utf8' });
    assert.equal(parse.status, 0, parse.stderr || parse.stdout);
  }

  console.log('PASS staged completion broker v2: fixed YELLOW verification/intelligence/live-Claude routes, zero arbitrary args, original broker retained for ordinary capabilities, strict remote schema, and Windows PowerShell parser gate.');
}

main();
