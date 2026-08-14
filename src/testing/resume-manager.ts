import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { GoalRepository } from '../goals/repository.js';
import { GoalResumeManager } from '../goals/resume-manager.js';
import { JsonFileStore } from '../storage/store.js';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-resume-'));
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const goals = new GoalRepository(store);
    const capabilities = new CapabilityRegistry(store);
    const resume = new GoalResumeManager(store);

    await goals.createGoal({
      id: 'time-goal',
      title: 'Time gated goal',
      objective: 'Resume only after a deterministic time trigger.',
      successCriteria: ['Does not resume early', 'Resumes at the configured time'],
    });
    await goals.transitionGoal('time-goal', 'WAITING', {
      blocker: 'Scheduled dependency is not due yet.',
      resumeCondition: 'Resume at 2026-08-13T10:00:00+10:00.',
    });
    await resume.configure({
      goalId: 'time-goal',
      triggers: [{ kind: 'TIME_REACHED', notBefore: '2026-08-13T10:00:00+10:00' }],
      target: 'WORKING',
    });
    assert.equal((await resume.evaluate('time-goal', new Date('2026-08-12T23:59:59Z'))).eligible, false);
    assert.deepEqual(await resume.resumeEligible(new Date('2026-08-12T23:59:59Z')), []);
    const timeResumed = await resume.resumeEligible(new Date('2026-08-13T00:00:00Z'));
    assert.deepEqual(timeResumed.map((item) => item.goalId), ['time-goal']);
    const resumedTimeGoal = await goals.getGoal('time-goal');
    assert.equal(resumedTimeGoal?.state, 'WORKING');
    assert.equal(resumedTimeGoal?.resumeTriggers, undefined);

    await capabilities.upsert({
      id: 'claude-business-profile',
      kind: 'SKILL',
      description: 'Selective business profile readiness test.',
      requiredChecks: ['PACKAGED', 'DISCOVERED'],
      passedChecks: ['PACKAGED'],
      evidence: ['PACKAGED: checksum verified'],
    });
    await goals.createGoal({
      id: 'capability-goal',
      title: 'Capability gated goal',
      objective: 'Resume only after a required capability is fully ready.',
      successCriteria: ['Incomplete capability keeps goal blocked', 'Ready capability resumes goal'],
    });
    await goals.transitionGoal('capability-goal', 'BLOCKED', {
      blocker: 'Claude business profile is not fully discovered.',
      resumeCondition: 'Resume after claude-business-profile becomes READY.',
    });
    await resume.configure({
      goalId: 'capability-goal',
      triggers: [{ kind: 'CAPABILITIES_READY', capabilityIds: ['claude-business-profile'] }],
      target: 'PLANNING',
    });
    assert.equal((await resume.evaluate('capability-goal')).eligible, false);
    assert.deepEqual(await resume.resumeEligible(), []);
    await capabilities.recordCheck('claude-business-profile', 'DISCOVERED', 'Fresh Claude session discovered the profile.');
    const capResumed = await resume.resumeEligible();
    assert.deepEqual(capResumed.map((item) => item.goalId), ['capability-goal']);
    assert.equal((await goals.getGoal('capability-goal'))?.state, 'PLANNING');

    await goals.createGoal({
      id: 'dependency-producer',
      title: 'Dependency producer',
      objective: 'Complete a prerequisite task for another goal.',
      successCriteria: ['Prerequisite task completes'],
    });
    await goals.transitionGoal('dependency-producer', 'WORKING');
    const prerequisite = await goals.enqueueTask({
      id: 'external-prerequisite',
      goalId: 'dependency-producer',
      title: 'Complete prerequisite',
      intent: 'Produce deterministic completion evidence.',
      worker: 'VERIFIER',
      acceptanceCriteria: ['Prerequisite is complete'],
      verificationPlan: ['Transition through verification to completed'],
      idempotencyKey: 'resume:external-prerequisite:v1',
    });

    await goals.createGoal({
      id: 'task-waiter',
      title: 'Task dependency waiter',
      objective: 'Resume only after a named prerequisite task completes.',
      successCriteria: ['Incomplete task keeps goal waiting', 'Completed task releases goal'],
    });
    await goals.transitionGoal('task-waiter', 'WAITING', {
      blocker: 'Prerequisite task is incomplete.',
      resumeCondition: 'Resume after external-prerequisite is COMPLETED.',
    });
    await resume.configure({
      goalId: 'task-waiter',
      triggers: [{ kind: 'TASKS_COMPLETED', taskIds: [prerequisite.id] }],
    });
    assert.equal((await resume.evaluate('task-waiter')).eligible, false);
    await goals.transitionTask(prerequisite.id, 'WORKING');
    await goals.transitionTask(prerequisite.id, 'VERIFYING');
    await goals.transitionTask(prerequisite.id, 'COMPLETED');
    const taskResumed = await resume.resumeEligible();
    assert.deepEqual(taskResumed.map((item) => item.goalId), ['task-waiter']);
    assert.equal((await goals.getGoal('task-waiter'))?.state, 'WORKING');

    await goals.createGoal({
      id: 'manual-only',
      title: 'Manual-only waiting goal',
      objective: 'Prove that a waiting goal without deterministic triggers never resumes automatically.',
      successCriteria: ['No automatic resume occurs'],
    });
    await goals.transitionGoal('manual-only', 'WAITING', {
      blocker: 'Owner decision required.',
      resumeCondition: 'Owner explicitly resumes the goal.',
    });
    assert.equal((await resume.evaluate('manual-only')).eligible, false);
    assert.deepEqual(await resume.resumeEligible(), []);
    assert.equal((await goals.getGoal('manual-only'))?.state, 'WAITING');

    await assert.rejects(
      () => resume.configure({
        goalId: 'time-goal',
        triggers: [{ kind: 'TIME_REACHED', notBefore: '2026-08-14T00:00:00Z' }],
      }),
      /must already be WAITING or BLOCKED/,
    );

    console.log('PASS NEXUS resume manager: time, capability and completed-task triggers resume deterministically; manual/owner waits never auto-resume.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
