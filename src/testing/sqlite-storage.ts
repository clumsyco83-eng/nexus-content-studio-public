import { rm } from 'node:fs/promises';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { GoalRepository } from '../goals/repository.js';
import { NexusRepository } from '../storage/repository.js';
import { SqliteStore } from '../storage/sqlite-store.js';

async function main(): Promise<void> {
  const file = `data/sqlite-verification-${Date.now()}.db`;
  const store = new SqliteStore(file);
  const repo = new NexusRepository(store);
  const goals = new GoalRepository(store);
  const capabilities = new CapabilityRegistry(store);

  try {
    const job = await repo.createJob({
      id: 'sqlite-verification-job',
      brand: 'Curious Grit',
      contentKind: 'verification',
      state: 'DRAFT',
    });

    await repo.requestApproval(job.id, job.revision);
    const resolved = await repo.resolveCurrentApproval(job.id, 'APPROVED', 'sqlite-verifier');
    if (resolved.job.state !== 'APPROVED') throw new Error('Atomic approval transition failed.');

    const publishInput = {
      jobId: job.id,
      platform: 'youtube',
      accountId: 'verification-account',
      revision: resolved.job.revision,
      idempotencyKey: 'sqlite-verification-publish',
      status: 'PENDING' as const,
    };
    const firstPublish = await repo.recordPublish(publishInput);
    const duplicatePublish = await repo.recordPublish(publishInput);
    if (firstPublish.id !== duplicatePublish.id) throw new Error('Publish idempotency failed.');

    await repo.addCost({
      jobId: job.id,
      provider: 'verification-provider',
      amountUsd: 0.01,
      eventType: 'other',
    });

    const regenerated = await repo.regenerateJob(job.id);
    if (regenerated.revision !== 2 || regenerated.state !== 'DRAFT') {
      throw new Error('Atomic regeneration transition failed.');
    }

    await capabilities.upsert({
      id: 'sqlite:goal-engine',
      kind: 'RUNTIME',
      description: 'Persistent Goal Engine SQLite verification capability.',
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      passedChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      evidence: ['SQLite test fixture'],
    });

    const masterGoal = await goals.createGoal({
      id: 'sqlite-million-dollar-goal',
      title: 'SQLite Million-Dollar Project goal',
      objective: 'Prove goal contracts survive the durable SQLite lane.',
      successCriteria: ['Goal and task records survive SQLite load'],
      priority: 1,
    });
    await goals.transitionGoal(masterGoal.id, 'WORKING');
    const goalTask = await goals.enqueueTask({
      id: 'sqlite-goal-task',
      goalId: masterGoal.id,
      title: 'SQLite goal task',
      intent: 'Prove required capability gating and goal task persistence.',
      worker: 'NEXUS',
      acceptanceCriteria: ['Task persists'],
      verificationPlan: ['Reload SQLite payload'],
      requiredCapabilities: ['sqlite:goal-engine'],
      idempotencyKey: 'sqlite:goal-task:v1',
    });
    await goals.transitionTask(goalTask.id, 'WORKING');
    await goals.transitionTask(goalTask.id, 'VERIFYING');
    await goals.transitionTask(goalTask.id, 'COMPLETED');
    await goals.checkpoint({
      goalId: masterGoal.id,
      taskId: goalTask.id,
      summary: 'SQLite goal/task round-trip prepared.',
      verificationEvidence: ['task reached COMPLETED under a ready runtime capability'],
    });

    const database = await store.load();
    if (database.jobs.length !== 1) throw new Error(`Expected 1 job, found ${database.jobs.length}.`);
    if (database.publishRecords.length !== 1) {
      throw new Error(`Expected 1 publish record after duplicate attempt, found ${database.publishRecords.length}.`);
    }
    if (database.costs.length !== 1) throw new Error(`Expected 1 cost event, found ${database.costs.length}.`);
    if (database.capabilities.length !== 1 || database.capabilities[0]?.id !== 'sqlite:goal-engine') {
      throw new Error('Capability registry did not survive SQLite round-trip.');
    }
    if (database.goals.length !== 1 || database.goals[0]?.id !== masterGoal.id) {
      throw new Error('Persistent goal did not survive SQLite round-trip.');
    }
    if (database.goalTasks.length !== 1 || database.goalTasks[0]?.state !== 'COMPLETED') {
      throw new Error('Persistent goal task did not survive SQLite round-trip.');
    }
    if (database.goalCheckpoints.length !== 1) {
      throw new Error('Goal checkpoint did not survive SQLite round-trip.');
    }

    console.log('PASS  sqlite-open-and-persist');
    console.log('PASS  atomic-approval-transition');
    console.log('PASS  publish-idempotency');
    console.log('PASS  atomic-regeneration-transition');
    console.log('PASS  capability-registry-round-trip');
    console.log('PASS  persistent-goal-task-checkpoint-round-trip');
    console.log('PASS  sqlite-round-trip');
    console.log('\nNEXUS SQLITE DURABLE CORE VERIFIED');
  } finally {
    store.close();
    await rm(file, { force: true });
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
