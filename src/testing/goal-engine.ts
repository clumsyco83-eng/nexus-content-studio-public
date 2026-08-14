import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoalRepository } from '../goals/repository.js';
import { JsonFileStore } from '../storage/store.js';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-goal-engine-'));
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const goals = new GoalRepository(store);

    const goal = await goals.createGoal({
      id: 'million-dollar-phase-a',
      title: 'Million-Dollar Project Phase A',
      objective: 'Build the persistent, verified NEXUS collaboration loop.',
      successCriteria: ['Goal state is durable', 'Queued work is dependency-safe', 'Checkpoints require verification evidence'],
      priority: 1,
      budget: { maxTokens: 100_000, maxCostUsd: 25, maxTimeMs: 3_600_000 },
      nextAction: 'Build Goal DB and queue.',
    });
    assert.equal(goal.state, 'PLANNING');

    await goals.transitionGoal(goal.id, 'WORKING', { nextAction: 'Execute the first bounded task.' });

    const firstInput = {
      id: 'goal-db',
      goalId: goal.id,
      title: 'Persist goal contracts',
      intent: 'Persist the master goal and measurable definition of done.',
      worker: 'CLAUDE' as const,
      acceptanceCriteria: ['Goal survives reload'],
      verificationPlan: ['Reload the database and compare the persisted goal'],
      idempotencyKey: 'million-dollar:goal-db:v1',
      maxTurns: 20,
      maxRepairs: 5,
      timeLimitMs: 60_000,
    };
    const first = await goals.enqueueTask(firstInput);
    assert.equal(first.state, 'READY');

    const duplicate = await goals.enqueueTask(firstInput);
    assert.equal(duplicate.id, first.id);
    await assert.rejects(() => goals.enqueueTask({
      ...firstInput,
      intent: 'A materially changed request must not reuse the old idempotency key.',
    }), /Idempotency conflict/);

    const second = await goals.enqueueTask({
      id: 'job-queue',
      goalId: goal.id,
      title: 'Add dependency-aware queue',
      intent: 'Do not run until the goal database task is verified complete.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['Task remains queued until dependency completes'],
      verificationPlan: ['Complete dependency then inspect ready queue'],
      dependencies: [first.id],
      idempotencyKey: 'million-dollar:job-queue:v1',
    });
    assert.equal(second.state, 'QUEUED');

    let ready = await goals.listReadyTasks();
    assert.deepEqual(ready.map((task) => task.id), [first.id]);

    await goals.transitionTask(first.id, 'WORKING');
    await goals.transitionTask(first.id, 'VERIFYING');
    await assert.rejects(() => goals.checkpoint({
      goalId: goal.id,
      taskId: first.id,
      summary: 'Too early',
      verificationEvidence: ['not-complete'],
    }), /COMPLETED/);
    await goals.transitionTask(first.id, 'COMPLETED');

    ready = await goals.listReadyTasks();
    assert.deepEqual(ready.map((task) => task.id), [second.id]);

    const checkpoint = await goals.checkpoint({
      goalId: goal.id,
      taskId: first.id,
      summary: 'Persistent Goal Contract storage verified.',
      verificationEvidence: ['goal reload matched', 'dependency queue released exactly once'],
      nextAction: 'Execute the queue task.',
    });
    assert.equal(checkpoint.goalId, goal.id);

    const reloaded = await goals.getGoal(goal.id);
    assert.ok(reloaded);
    assert.equal(reloaded.latestCheckpointId, checkpoint.id);
    assert.ok(reloaded.completedTaskIds.includes(first.id));

    await assert.rejects(
      () => goals.transitionGoal(goal.id, 'BLOCKED', { blocker: 'Laptop-only bridge commits are unavailable.' }),
      /resumeCondition/,
    );
    await goals.transitionGoal(goal.id, 'BLOCKED', {
      blocker: 'Laptop-only bridge commits are unavailable.',
      resumeCondition: 'Verified local commits are reconciled into a reviewed branch.',
      nextAction: 'Preserve state and wait for the local reconciliation gate.',
    });

    ready = await goals.listReadyTasks();
    assert.deepEqual(ready, []);
    await assert.rejects(() => goals.transitionTask(second.id, 'WORKING'), /cannot advance/);
    await assert.rejects(() => goals.transitionTask(second.id, 'COMPLETED'), /Invalid task transition/);

    await goals.transitionGoal(goal.id, 'WORKING', { nextAction: 'Resume after the dependency gate is satisfied.' });
    ready = await goals.listReadyTasks();
    assert.deepEqual(ready.map((task) => task.id), [second.id]);

    const repairLimited = await goals.enqueueTask({
      id: 'repair-limited',
      goalId: goal.id,
      title: 'Prove repair limit is enforced',
      intent: 'Allow one repair and reject the next repair attempt.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['Second repair is rejected'],
      verificationPlan: ['Drive the task through one repair cycle'],
      idempotencyKey: 'million-dollar:repair-limit:v1',
      maxRepairs: 1,
    });
    await goals.transitionTask(repairLimited.id, 'WORKING');
    await goals.transitionTask(repairLimited.id, 'REPAIRING', 'first verifier failure');
    await goals.transitionTask(repairLimited.id, 'WORKING');
    await assert.rejects(
      () => goals.transitionTask(repairLimited.id, 'REPAIRING', 'same failure repeated'),
      /Repair limit exhausted/,
    );

    console.log('PASS NEXUS Goal Engine: durable contracts, strict idempotency, dependency queueing, fail-closed blockers, repair limits, and verified checkpoints.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
