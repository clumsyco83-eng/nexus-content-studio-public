import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoalRepository } from '../goals/repository.js';
import {
  fingerprintGoalTask,
  GoalTaskApprovalRepository,
  nextGoalTaskExecutionAttempt,
} from '../goals/task-approvals.js';
import { JsonFileStore } from '../storage/store.js';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-goal-approval-'));
  try {
    const file = path.join(root, 'nexus.json');
    const store = new JsonFileStore(file);
    const goals = new GoalRepository(store);
    const approvals = new GoalTaskApprovalRepository(store);

    await goals.createGoal({
      id: 'goal-approval',
      title: 'Approval regression',
      objective: 'Verify per-attempt owner authority remains bound to the exact Goal Contract.',
      successCriteria: ['No stale approval can authorize changed/retried work'],
      priority: 1,
    });
    await goals.transitionGoal('goal-approval', 'WORKING');

    const task = await goals.enqueueTask({
      id: 'yellow-task',
      goalId: 'goal-approval',
      title: 'Bounded YELLOW change',
      intent: 'Create one bounded output.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['required-file:src/generated/a.txt'],
      verificationPlan: ['required-file-content:{"path":"src/generated/a.txt","content":"A"}'],
      requiredCapabilities: [],
      allowedPaths: ['src/generated/**'],
      forbiddenPaths: ['.claude/**', '.env'],
      riskClass: 'YELLOW',
      approvalRequirement: 'NONE',
      idempotencyKey: 'goal-approval:yellow:v1',
      maxTurns: 4,
      maxRepairs: 2,
      timeLimitMs: 30_000,
      tokenBudget: 1_000,
      costBudgetUsd: 0.25,
    });
    assert.equal(nextGoalTaskExecutionAttempt(task), 1);
    assert.match(fingerprintGoalTask(task), /^[a-f0-9]{64}$/);

    const requestedAt = new Date('2026-08-13T08:00:00.000Z');
    const first = await approvals.requestForTask({
      goalId: task.goalId,
      taskId: task.id,
      requestedBy: 'nexus',
      reason: 'YELLOW execution requires exact owner approval.',
      ttlMs: 60_000,
      now: requestedAt,
    });
    assert.equal(first.status, 'PENDING');
    assert.equal(first.executionAttempt, 1);
    assert.equal((await store.load()).goalTasks.find((item) => item.id === task.id)?.state, 'WAITING');

    const pending = await approvals.validateForTask(task.goalId, task.id, new Date('2026-08-13T08:00:30.000Z'));
    assert.equal(pending.approved, false);
    assert.match(pending.reason ?? '', /pending/i);

    const approved = await approvals.resolve({
      approvalId: first.id,
      decision: 'APPROVED',
      resolvedBy: 'owner',
      now: new Date('2026-08-13T08:00:40.000Z'),
    });
    assert.equal(approved.status, 'APPROVED');
    assert.equal((await store.load()).goalTasks.find((item) => item.id === task.id)?.state, 'READY');
    assert.equal((await approvals.validateForTask(task.goalId, task.id, new Date('2026-08-13T08:00:50.000Z'))).approved, true);

    await goals.transitionTask(task.id, 'WORKING');
    await goals.transitionTask(task.id, 'VERIFYING');
    await goals.transitionTask(task.id, 'REPAIRING', 'Verifier rejected attempt 1.');
    const repairingTask = (await store.load()).goalTasks.find((item) => item.id === task.id)!;
    assert.equal(repairingTask.attempt, 2);
    assert.equal(nextGoalTaskExecutionAttempt(repairingTask), 2);
    assert.equal((await approvals.validateForTask(task.goalId, task.id)).approved, false, 'Attempt-1 approval must not authorize attempt 2.');

    const retryApproval = await approvals.requestForTask({
      goalId: task.goalId,
      taskId: task.id,
      requestedBy: 'nexus',
      reason: 'Retry attempt requires a fresh fingerprint-bound approval.',
      ttlMs: 60_000,
      now: new Date('2026-08-13T08:01:00.000Z'),
    });
    assert.equal(retryApproval.executionAttempt, 2);
    assert.notEqual(retryApproval.taskFingerprint, first.taskFingerprint);
    await approvals.resolve({
      approvalId: retryApproval.id,
      decision: 'APPROVED',
      resolvedBy: 'owner',
      now: new Date('2026-08-13T08:01:10.000Z'),
    });
    assert.equal((await approvals.validateForTask(task.goalId, task.id, new Date('2026-08-13T08:01:20.000Z'))).approved, true);

    const changed = await goals.enqueueTask({
      id: 'changed-task',
      goalId: 'goal-approval',
      title: 'Task that changes after request',
      intent: 'Prove changed contracts invalidate approval.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['required-file:src/generated/b.txt'],
      verificationPlan: ['required-file:src/generated/b.txt'],
      riskClass: 'YELLOW',
      approvalRequirement: 'OWNER',
      idempotencyKey: 'goal-approval:changed:v1',
    });
    const stale = await approvals.requestForTask({
      goalId: changed.goalId,
      taskId: changed.id,
      requestedBy: 'nexus',
      reason: 'Initial exact contract.',
      ttlMs: 60_000,
      now: new Date('2026-08-13T09:00:00.000Z'),
    });
    await store.update((db) => {
      const current = db.goalTasks.find((item) => item.id === changed.id)!;
      current.allowedPaths = ['src/changed/**'];
      current.updatedAt = '2026-08-13T09:00:10.000Z';
    });
    await assert.rejects(() => approvals.resolve({
      approvalId: stale.id,
      decision: 'APPROVED',
      resolvedBy: 'owner',
      now: new Date('2026-08-13T09:00:20.000Z'),
    }), /no longer matches/i);
    assert.equal((await approvals.get(stale.id))?.status, 'INVALIDATED');

    const expiring = await goals.enqueueTask({
      id: 'expiring-task',
      goalId: 'goal-approval',
      title: 'Expiring approval',
      intent: 'Prove TTL expiry fails closed.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['required-file:src/generated/c.txt'],
      verificationPlan: ['required-file:src/generated/c.txt'],
      riskClass: 'YELLOW',
      approvalRequirement: 'OWNER',
      idempotencyKey: 'goal-approval:expiry:v1',
    });
    const expiringApproval = await approvals.requestForTask({
      goalId: expiring.goalId,
      taskId: expiring.id,
      requestedBy: 'nexus',
      reason: 'Short-lived test approval.',
      ttlMs: 1_000,
      now: new Date('2026-08-13T10:00:00.000Z'),
    });
    const expired = await approvals.validateForTask(expiring.goalId, expiring.id, new Date('2026-08-13T10:00:02.000Z'));
    assert.equal(expired.approved, false);
    assert.equal((await approvals.get(expiringApproval.id))?.status, 'EXPIRED');

    const red = await goals.enqueueTask({
      id: 'red-task',
      goalId: 'goal-approval',
      title: 'RED task',
      intent: 'Must remain non-executable.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['required-file:src/generated/red.txt'],
      verificationPlan: ['required-file:src/generated/red.txt'],
      riskClass: 'RED',
      approvalRequirement: 'OWNER',
      idempotencyKey: 'goal-approval:red:v1',
    });
    await assert.rejects(() => approvals.requestForTask({
      goalId: red.goalId,
      taskId: red.id,
      requestedBy: 'nexus',
      reason: 'Should be refused.',
      ttlMs: 60_000,
    }), /RED.*non-executable/i);

    const green = await goals.enqueueTask({
      id: 'green-task',
      goalId: 'goal-approval',
      title: 'GREEN task',
      intent: 'No approval required.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['required-file:src/generated/green.txt'],
      verificationPlan: ['required-file:src/generated/green.txt'],
      riskClass: 'GREEN',
      approvalRequirement: 'NONE',
      idempotencyKey: 'goal-approval:green:v1',
    });
    assert.equal((await approvals.validateForTask(green.goalId, green.id)).approved, true);
    await assert.rejects(() => approvals.requestForTask({
      goalId: green.goalId,
      taskId: green.id,
      requestedBy: 'nexus',
      reason: 'Unnecessary.',
      ttlMs: 60_000,
    }), /does not require owner approval/);

    const denied = await goals.enqueueTask({
      id: 'denied-task',
      goalId: 'goal-approval',
      title: 'Denied task',
      intent: 'Owner denial cancels execution.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['required-file:src/generated/denied.txt'],
      verificationPlan: ['required-file:src/generated/denied.txt'],
      riskClass: 'YELLOW',
      approvalRequirement: 'OWNER',
      idempotencyKey: 'goal-approval:denied:v1',
    });
    const denialRequest = await approvals.requestForTask({
      goalId: denied.goalId,
      taskId: denied.id,
      requestedBy: 'nexus',
      reason: 'Owner decision required.',
      ttlMs: 60_000,
    });
    await approvals.resolve({ approvalId: denialRequest.id, decision: 'DENIED', resolvedBy: 'owner' });
    assert.equal((await store.load()).goalTasks.find((item) => item.id === denied.id)?.state, 'CANCELLED');

    const reloaded = new JsonFileStore(file);
    assert.ok((await reloaded.load()).goalTaskApprovals.length >= 5, 'Goal task approvals must survive store reload.');

    console.log('PASS NEXUS Goal-task approvals: SHA-256 contract/attempt binding, YELLOW owner gate, RED non-executable, TTL expiry, changed-contract invalidation, fresh retry approval, denial cancellation and durable persistence.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
