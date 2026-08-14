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
    id: 'goal-maintenance-v2',
    title: 'Maintenance broker v2/v3 regression',
    objective: 'Verify maintenance and roadmap authority stay capability-scoped and fail-closed.',
    successCriteria: ['Only fixed maintenance and roadmap actions execute.'],
    priority: 100,
    budget: {},
    state: 'WORKING',
    completedTaskIds: [],
    failedAttempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function task(input: { id: string; risk: 'GREEN' | 'YELLOW'; approval: 'NONE' | 'OWNER'; capability: string; now: string }): StoredGoalTask {
  return {
    id: input.id,
    goalId: 'goal-maintenance-v2',
    title: input.id,
    intent: 'Regression test only.',
    worker: 'TOOL',
    state: 'READY',
    acceptanceCriteria: ['Expected bounded maintenance result is returned.'],
    verificationPlan: ['Broker policy and invocation remain exact.'],
    dependencies: [],
    requiredCapabilities: [input.capability],
    allowedPaths: [],
    forbiddenPaths: [],
    riskClass: input.risk,
    approvalRequirement: input.approval,
    idempotencyKey: `maintenance-${input.id}-0001`,
    maxTurns: 1,
    maxRepairs: 0,
    timeLimitMs: 120_000,
    attempt: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function approvalFor(input: { id: string; task: StoredGoalTask; now: Date }): StoredGoalTaskApproval {
  return {
    id: input.id,
    goalId: input.task.goalId,
    taskId: input.task.id,
    executionAttempt: 1,
    taskFingerprint: fingerprintGoalTask(input.task),
    riskClass: 'YELLOW',
    status: 'APPROVED',
    requestedBy: 'test',
    reason: 'Maintenance/roadmap regression approval.',
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 60 * 60_000).toISOString(),
    resolvedAt: input.now.toISOString(),
    resolvedBy: 'owner',
  };
}

function request(input: {
  id: string;
  taskId: string;
  capability: PowerShellBrokerRequest['capability'];
  args: Record<string, string>;
  cwd: string;
  now: Date;
}): PowerShellBrokerRequest {
  return {
    id: input.id,
    goalId: 'goal-maintenance-v2',
    taskId: input.taskId,
    capability: input.capability,
    args: input.args,
    cwd: input.cwd,
    requestedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 10 * 60_000).toISOString(),
    timeoutMs: 90_000,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-maintenance-broker-v2-'));
  const repoRoot = path.join(root, 'repo');
  const now = new Date();
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const emergency = new EmergencyStopStore(path.join(root, 'emergency.json'));
    const leases = new PowerShellBrokerLeaseStore(path.join(root, 'leases.json'));
    const runner = new MockRunner();

    const serviceStatusTask = task({ id: 'service-status', risk: 'GREEN', approval: 'NONE', capability: 'nexus.service.status', now: now.toISOString() });
    const repoStatusTask = task({ id: 'repo-status', risk: 'GREEN', approval: 'NONE', capability: 'nexus.repo.status', now: now.toISOString() });
    const serviceStartTask = task({ id: 'service-start', risk: 'YELLOW', approval: 'OWNER', capability: 'nexus.service.start', now: now.toISOString() });
    const serviceRestartTask = task({ id: 'service-restart', risk: 'YELLOW', approval: 'OWNER', capability: 'nexus.service.restart', now: now.toISOString() });
    const repoSyncTask = task({ id: 'repo-sync', risk: 'YELLOW', approval: 'OWNER', capability: 'nexus.repo.sync', now: now.toISOString() });
    const intelligenceTask = task({ id: 'intelligence-complete', risk: 'YELLOW', approval: 'OWNER', capability: 'nexus.intelligence-foundation.complete', now: now.toISOString() });
    const coreTask = task({ id: 'core-complete', risk: 'YELLOW', approval: 'OWNER', capability: 'nexus.core-specialists.complete', now: now.toISOString() });
    const businessTask = task({ id: 'business-complete', risk: 'YELLOW', approval: 'OWNER', capability: 'nexus.business-profile.complete', now: now.toISOString() });

    const db = emptyDatabase();
    db.goals.push(goal(now.toISOString()));
    db.goalTasks.push(serviceStatusTask, repoStatusTask, serviceStartTask, serviceRestartTask, repoSyncTask, intelligenceTask, coreTask, businessTask);
    db.goalTaskApprovals.push(
      approvalFor({ id: 'approval-service-start', task: serviceStartTask, now }),
      approvalFor({ id: 'approval-service-restart', task: serviceRestartTask, now }),
      approvalFor({ id: 'approval-repo-sync', task: repoSyncTask, now }),
      approvalFor({ id: 'approval-intelligence', task: intelligenceTask, now }),
      approvalFor({ id: 'approval-core', task: coreTask, now }),
      approvalFor({ id: 'approval-business', task: businessTask, now }),
    );
    await store.save(db);

    const broker = new PowerShellBroker({
      repoRoot,
      store,
      emergencyStop: emergency,
      leases,
      runner,
      auditFile: path.join(root, 'audit.jsonl'),
    });

    const serviceStatus = request({ id: 'req-service-status', taskId: serviceStatusTask.id, capability: 'nexus.service.status', args: {}, cwd: repoRoot, now });
    const serviceStatusLease = await broker.issueLease(serviceStatus, now);
    await broker.execute(serviceStatus, serviceStatusLease.id, new Date(now.getTime() + 1_000));
    assert.equal(runner.invocations[0]?.args.includes('-Capability'), true);
    assert.equal(runner.invocations[0]?.args.includes('nexus.service.status'), true);

    const repoStatus = request({ id: 'req-repo-status', taskId: repoStatusTask.id, capability: 'nexus.repo.status', args: {}, cwd: repoRoot, now });
    const repoStatusLease = await broker.issueLease(repoStatus, now);
    await broker.execute(repoStatus, repoStatusLease.id, new Date(now.getTime() + 1_500));
    assert.equal(runner.invocations[1]?.args.includes('nexus.repo.status'), true);

    const badHead = request({ id: 'req-bad-head', taskId: repoSyncTask.id, capability: 'nexus.repo.sync', args: { expectedHead: 'main' }, cwd: repoRoot, now });
    await assert.rejects(() => broker.issueLease(badHead, now), /40-character Git commit SHA/);

    const injectedSync = request({
      id: 'req-sync-injected',
      taskId: repoSyncTask.id,
      capability: 'nexus.repo.sync',
      args: { expectedHead: 'a'.repeat(40), extra: 'origin/evil' },
      cwd: repoRoot,
      now,
    });
    await assert.rejects(() => broker.issueLease(injectedSync, now), /Expected exactly: expectedHead/);

    const repoSync = request({ id: 'req-repo-sync', taskId: repoSyncTask.id, capability: 'nexus.repo.sync', args: { expectedHead: 'a'.repeat(40) }, cwd: repoRoot, now });
    const repoSyncLease = await broker.issueLease(repoSync, now);
    await broker.execute(repoSync, repoSyncLease.id, new Date(now.getTime() + 2_000));
    const syncInvocation = runner.invocations[2];
    assert.equal(syncInvocation?.args.includes('nexus.repo.sync'), true);
    const expectedIndex = syncInvocation?.args.indexOf('-ExpectedHead') ?? -1;
    assert.ok(expectedIndex >= 0);
    assert.equal(syncInvocation?.args[expectedIndex + 1], 'a'.repeat(40));
    assert.equal(syncInvocation?.args.includes('-Command'), false, 'Maintenance sync must remain -File/argv based, never arbitrary -Command.');

    const serviceStart = request({ id: 'req-service-start', taskId: serviceStartTask.id, capability: 'nexus.service.start', args: {}, cwd: repoRoot, now });
    const serviceStartLease = await broker.issueLease(serviceStart, now);
    await broker.execute(serviceStart, serviceStartLease.id, new Date(now.getTime() + 2_500));
    assert.equal(runner.invocations[3]?.args.includes('nexus.service.start'), true);

    const roadmapCases: Array<{ capability: PowerShellBrokerRequest['capability']; task: StoredGoalTask; id: string }> = [
      { capability: 'nexus.service.restart', task: serviceRestartTask, id: 'req-service-restart' },
      { capability: 'nexus.intelligence-foundation.complete', task: intelligenceTask, id: 'req-intelligence' },
      { capability: 'nexus.core-specialists.complete', task: coreTask, id: 'req-core' },
      { capability: 'nexus.business-profile.complete', task: businessTask, id: 'req-business' },
    ];

    for (const item of roadmapCases) {
      const exact = request({ id: item.id, taskId: item.task.id, capability: item.capability, args: {}, cwd: repoRoot, now });
      const lease = await broker.issueLease(exact, now);
      await broker.execute(exact, lease.id, new Date(now.getTime() + 3_000 + runner.invocations.length));
      const invocation = runner.invocations.at(-1);
      assert.equal(invocation?.args.includes(item.capability), true);
      assert.equal(invocation?.args.includes('-Command'), false, `${item.capability} must never use arbitrary -Command.`);
      assert.equal(invocation?.args.filter((arg) => arg === '-Capability').length, 1);

      const injected = request({ id: `${item.id}-injected`, taskId: item.task.id, capability: item.capability, args: { script: 'whoami' }, cwd: repoRoot, now });
      await assert.rejects(() => broker.issueLease(injected, now), /Expected exactly: \(none\)/);
    }

    const dbNoApprovals = await store.load();
    dbNoApprovals.goalTaskApprovals = [];
    await store.save(dbNoApprovals);
    for (const item of [
      { request: repoSync, label: 'repo sync' },
      { request: serviceStart, label: 'service start' },
      ...roadmapCases.map((item) => ({
        request: request({ id: `${item.id}-no-approval`, taskId: item.task.id, capability: item.capability, args: {}, cwd: repoRoot, now }),
        label: item.capability,
      })),
    ]) {
      await assert.rejects(() => broker.issueLease(item.request, now), /Owner approval required/, `${item.label} must remain owner-gated.`);
    }

    if (process.platform === 'win32') {
      const realRepoRoot = path.resolve(process.cwd());
      const realStore = new JsonFileStore(path.join(root, 'real-nexus.json'));
      const realDb = emptyDatabase();
      realDb.goals.push(goal(now.toISOString()));
      realDb.goalTasks.push(serviceStatusTask);
      await realStore.save(realDb);
      const realBroker = new PowerShellBroker({
        repoRoot: realRepoRoot,
        store: realStore,
        emergencyStop: new EmergencyStopStore(path.join(root, 'real-emergency.json')),
        leases: new PowerShellBrokerLeaseStore(path.join(root, 'real-leases.json')),
        auditFile: path.join(root, 'real-audit.jsonl'),
      });
      const realStatus = request({ id: 'req-service-status-windows', taskId: serviceStatusTask.id, capability: 'nexus.service.status', args: {}, cwd: realRepoRoot, now });
      const realLease = await realBroker.issueLease(realStatus, now);
      const realResult = await realBroker.execute(realStatus, realLease.id, new Date(now.getTime() + 1_000));
      assert.equal(realResult.transportSucceeded, true);
      const payload = JSON.parse(realResult.stdout.trim()) as { ok?: boolean; capability?: string; service?: { exists?: boolean } };
      assert.equal(payload.ok, true);
      assert.equal(payload.capability, 'nexus.service.status');
      assert.equal(typeof payload.service?.exists, 'boolean');
    }

    console.log('PASS PowerShell Broker v3 roadmap expansion: fixed service/repository actions plus four zero-argument owner-gated roadmap capabilities, exact args, full-SHA binding, no arbitrary shell, and Windows real-process service-status smoke.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
