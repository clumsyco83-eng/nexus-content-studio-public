import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore, emptyDatabase } from '../storage/store.js';
import type { StoredGoal, StoredGoalTask, StoredGoalTaskApproval } from '../goals/schema.js';
import { fingerprintGoalTask } from '../goals/task-approvals.js';
import { EmergencyStopStore } from '../safety/emergency-stop.js';
import { PowerShellBroker } from '../powershell-broker/broker.js';
import { PowerShellBrokerLeaseStore } from '../powershell-broker/lease-store.js';
import type { PowerShellBrokerRequest, PowerShellInvocation } from '../powershell-broker/policy.js';
import { buildPowerShellBrokerEnvironment } from '../powershell-broker/runner.js';
import type { PowerShellBrokerRunner, PowerShellRunnerResult } from '../powershell-broker/runner.js';

class MockRunner implements PowerShellBrokerRunner {
  invocations: PowerShellInvocation[] = [];
  async run(invocation: PowerShellInvocation): Promise<PowerShellRunnerResult> {
    this.invocations.push(invocation);
    return { exitCode: 0, stdout: '{"ok":true}', stderr: '', timedOut: false };
  }
}

function goal(now: string): StoredGoal {
  return {
    id: 'goal-broker', title: 'Broker test goal', objective: 'Verify broker boundaries.', successCriteria: ['Broker stays bounded.'],
    priority: 100, budget: {}, state: 'WORKING', completedTaskIds: [], failedAttempts: 0, createdAt: now, updatedAt: now,
  };
}

function task(input: { id: string; risk: 'GREEN' | 'YELLOW'; approval: 'NONE' | 'OWNER'; capability: string; now: string }): StoredGoalTask {
  return {
    id: input.id, goalId: 'goal-broker', title: input.id, intent: 'Regression test only.', worker: 'TOOL', state: 'READY',
    acceptanceCriteria: ['Expected capability result is returned.'], verificationPlan: ['Independent regression assertion.'], dependencies: [],
    requiredCapabilities: [input.capability], allowedPaths: [], forbiddenPaths: [], riskClass: input.risk, approvalRequirement: input.approval,
    idempotencyKey: `broker-${input.id}-0001`, maxTurns: 1, maxRepairs: 0, timeLimitMs: 60_000, attempt: 0,
    createdAt: input.now, updatedAt: input.now,
  };
}

function request(input: { id: string; taskId: string; capability: PowerShellBrokerRequest['capability']; args: Record<string, string>; cwd: string; now: Date }): PowerShellBrokerRequest {
  return {
    id: input.id,
    goalId: 'goal-broker',
    taskId: input.taskId,
    capability: input.capability,
    args: input.args,
    cwd: input.cwd,
    requestedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 10 * 60_000).toISOString(),
    timeoutMs: 30_000,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-powershell-broker-'));
  const repoRoot = path.join(root, 'repo');
  const now = new Date('2026-08-14T03:00:00Z');
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const emergency = new EmergencyStopStore(path.join(root, 'emergency-stop.json'));
    const leases = new PowerShellBrokerLeaseStore(path.join(root, 'leases.json'));
    const runner = new MockRunner();

    const greenTask = task({ id: 'green-process', risk: 'GREEN', approval: 'NONE', capability: 'system.process.inspect', now: now.toISOString() });
    const yellowTask = task({ id: 'yellow-verify', risk: 'YELLOW', approval: 'OWNER', capability: 'nexus.verification.run', now: now.toISOString() });
    const approval: StoredGoalTaskApproval = {
      id: 'approval-yellow', goalId: 'goal-broker', taskId: yellowTask.id, executionAttempt: 1,
      taskFingerprint: fingerprintGoalTask(yellowTask), riskClass: 'YELLOW', status: 'APPROVED', requestedBy: 'test', reason: 'Regression approval.',
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(), resolvedAt: now.toISOString(), resolvedBy: 'owner',
    };
    const db = emptyDatabase();
    db.goals.push(goal(now.toISOString()));
    db.goalTasks.push(greenTask, yellowTask);
    db.goalTaskApprovals.push(approval);
    await store.save(db);

    const broker = new PowerShellBroker({
      repoRoot,
      store,
      emergencyStop: emergency,
      leases,
      runner,
      auditFile: path.join(root, 'audit.jsonl'),
    });

    const green = request({ id: 'req-green', taskId: greenTask.id, capability: 'system.process.inspect', args: { processName: 'node' }, cwd: repoRoot, now });
    const greenLease = await broker.issueLease(green, now);
    const result = await broker.execute(green, greenLease.id, new Date(now.getTime() + 1_000));
    assert.equal(result.transportSucceeded, true);
    assert.equal('verified' in result, false, 'Broker transport must not self-certify deterministic Goal completion.');
    assert.equal(runner.invocations.length, 1);
    assert.equal(path.win32.basename(runner.invocations[0]?.file ?? ''), 'powershell.exe');
    assert.equal(path.win32.isAbsolute(runner.invocations[0]?.file ?? ''), true, 'Broker must pin the Windows system PowerShell executable instead of PATH lookup.');
    assert.equal(runner.invocations[0]?.args.includes('-Command'), false, 'Broker must use -File, never arbitrary -Command strings.');
    await assert.rejects(() => broker.execute(green, greenLease.id, new Date(now.getTime() + 2_000)), /already been consumed/);

    const injected = request({ id: 'req-injection', taskId: greenTask.id, capability: 'system.process.inspect', args: { processName: 'node;whoami' }, cwd: repoRoot, now });
    await assert.rejects(() => broker.issueLease(injected, now), /unsafe characters/);

    const wrongCwd = { ...green, id: 'req-wrong-cwd', cwd: path.join(repoRoot, 'subdir') };
    await assert.rejects(() => broker.issueLease(wrongCwd, now), /exactly the configured NEXUS repository root/);

    const remoteHealth = request({ id: 'req-remote-health', taskId: greenTask.id, capability: 'nexus.health.check', args: { url: 'https://example.com/api/health' }, cwd: repoRoot, now });
    await assert.rejects(() => broker.issueLease(remoteHealth, now), /literal loopback HTTP only/);

    const hostnameHealth = request({ id: 'req-hostname-health', taskId: greenTask.id, capability: 'nexus.health.check', args: { url: 'http://localhost/api/health' }, cwd: repoRoot, now });
    await assert.rejects(() => broker.issueLease(hostnameHealth, now), /literal loopback HTTP only/);

    const expired = { ...green, id: 'req-expired', expiresAt: new Date(now.getTime() - 1_000).toISOString() };
    await assert.rejects(() => broker.issueLease(expired, now), /timestamps are invalid|expired/);

    if (process.platform === 'win32') {
      const realRepoRoot = path.resolve(process.cwd());
      const realBroker = new PowerShellBroker({
        repoRoot: realRepoRoot,
        store,
        emergencyStop: emergency,
        leases: new PowerShellBrokerLeaseStore(path.join(root, 'windows-leases.json')),
        auditFile: path.join(root, 'windows-audit.jsonl'),
      });
      const realGreen = request({
        id: 'req-green-windows', taskId: greenTask.id, capability: 'system.process.inspect', args: { processName: 'node' }, cwd: realRepoRoot, now,
      });
      realGreen.timeoutMs = 90_000;
      const realLease = await realBroker.issueLease(realGreen, now);
      const realResult = await realBroker.execute(realGreen, realLease.id, new Date(now.getTime() + 1_000));
      assert.equal(realResult.transportSucceeded, true);
      const payload = JSON.parse(realResult.stdout.trim()) as { ok?: boolean; capability?: string };
      assert.equal(payload.ok, true);
      assert.equal(payload.capability, 'system.process.inspect');
    }

    const selectableYellow = request({ id: 'req-yellow-selectable', taskId: yellowTask.id, capability: 'nexus.verification.run', args: { suite: 'laptop' }, cwd: repoRoot, now });
    await assert.rejects(() => broker.issueLease(selectableYellow, now), /Expected exactly: \(none\)/);

    const yellow = request({ id: 'req-yellow', taskId: yellowTask.id, capability: 'nexus.verification.run', args: {}, cwd: repoRoot, now });
    const yellowLease = await broker.issueLease(yellow, now);
    assert.equal(yellowLease.capability, 'nexus.verification.run');
    const yellowResult = await broker.execute(yellow, yellowLease.id, new Date(now.getTime() + 3_000));
    assert.equal(yellowResult.transportSucceeded, true);
    assert.equal(runner.invocations.length, 2);
    assert.equal(runner.invocations[1]?.args.includes('-Suite'), false, 'YELLOW verification must be one fixed action with no post-approval suite selector.');

    const dbWithoutApproval = await store.load();
    dbWithoutApproval.goalTaskApprovals = [];
    await store.save(dbWithoutApproval);
    const yellowNoApproval = { ...yellow, id: 'req-yellow-no-approval' };
    await assert.rejects(() => broker.issueLease(yellowNoApproval, now), /Owner approval required/);

    await emergency.activate('test-owner', 'Regression emergency stop.', now);
    const stopped = { ...green, id: 'req-stopped' };
    await assert.rejects(() => broker.issueLease(stopped, now), /emergency stop is active/);

    const env = buildPowerShellBrokerEnvironment({
      PATH: 'C:\\attacker-controlled-bin',
      SystemRoot: 'C:\\Windows',
      OS: 'Windows_NT',
      COMSPEC: 'C:\\attacker-controlled-bin\\cmd.exe',
      PATHEXT: '.EVIL',
      NPM_CONFIG_SCRIPT_SHELL: 'C:\\attacker-controlled-bin\\evil.exe',
      NPM_CONFIG_USERCONFIG: 'C:\\attacker-controlled-bin\\npm-user-rc',
      NPM_CONFIG_GLOBALCONFIG: 'C:\\attacker-controlled-bin\\npm-global-rc',
      OPENAI_API_KEY: 'secret-openai',
      GH_TOKEN: 'secret-github',
      NEXUS_DASHBOARD_TOKEN: 'secret-nexus',
    });
    assert.equal(env.OS, 'Windows_NT');
    assert.equal(env.PATH?.includes('attacker-controlled-bin'), false, 'Parent PATH must not flow into the broker subprocess.');
    assert.equal(env.PATH?.includes('System32'), true);
    assert.equal(env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
    assert.equal(env.NPM_CONFIG_SCRIPT_SHELL, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(env.NPM_CONFIG_USERCONFIG, 'C:\\NUL');
    assert.equal(env.NPM_CONFIG_GLOBALCONFIG, 'C:\\Windows\\NUL');
    assert.notEqual(env.NPM_CONFIG_USERCONFIG.toLowerCase(), env.NPM_CONFIG_GLOBALCONFIG.toLowerCase());
    assert.equal(env.NPM_CONFIG_USERCONFIG.toLowerCase().includes('attacker-controlled-bin'), false);
    assert.equal(env.NPM_CONFIG_GLOBALCONFIG.toLowerCase().includes('attacker-controlled-bin'), false);
    assert.equal(env.NPM_CONFIG_UPDATE_NOTIFIER, 'false');
    assert.equal(env.NPM_CONFIG_FUND, 'false');
    assert.equal(env.NPM_CONFIG_AUDIT, 'false');
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.NEXUS_DASHBOARD_TOKEN, undefined);

    console.log('PASS PowerShell Broker v1: fixed capability registry, exact cwd/args, literal-loopback health, injection rejection, one-shot leases, one fixed owner-approved YELLOW action, emergency stop, absolute system PowerShell, sanitized PATH/COMSPEC/npm configuration with npm-11-safe distinct null configs, direct argv -File execution, Windows real-process smoke, and secret-isolated environment without self-certification.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
