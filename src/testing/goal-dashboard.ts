import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { buildGoalDashboardSnapshot } from '../dashboard/goal-dashboard-service.js';
import { GoalAttemptObservationRepository } from '../goals/attempt-observations.js';
import { GoalRepository } from '../goals/repository.js';
import { JsonFileStore } from '../storage/store.js';

async function verifyPhoneRenderingContract(): Promise<void> {
  const script = await readFile(path.resolve('dashboard/capability-readiness.js'), 'utf8');
  const server = await readFile(path.resolve('src/dashboard/server.ts'), 'utf8');

  assert.match(script, /STALE \/ DRIFTED/);
  assert.match(script, /MISSING CHECKS/);
  assert.match(script, /goalStaleCapabilities/);
  assert.match(script, /Stale\/drift:/);
  assert.match(script, /Recent invalidation:/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /capability\?\.evidence|capability\.evidence/, 'Phone enhancement must not render raw capability evidence.');
  assert.match(server, /\/capability-readiness\.js/);
  assert.match(server, /<script src="\/capability-readiness\.js"><\/script>/);
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-goal-dashboard-'));
  try {
    await verifyPhoneRenderingContract();

    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const goals = new GoalRepository(store);
    const capabilities = new CapabilityRegistry(store);
    const attempts = new GoalAttemptObservationRepository(store);

    await capabilities.upsert({
      id: 'claude-engineering',
      kind: 'SKILL',
      description: 'Engineering execution profile used by the dashboard test.',
      requiredChecks: ['PACKAGED', 'DISCOVERED'],
      passedChecks: ['PACKAGED'],
      evidence: ['PACKAGED: checksum verified'],
    });

    await goals.createGoal({
      id: 'million-dollar-readiness',
      title: 'Million-Dollar readiness',
      objective: 'Prove the phone view can explain persistent goal state without granting new authority.',
      successCriteria: ['Show task state', 'Show blockers', 'Show capability readiness', 'Show cost and verifier checkpoint'],
      milestone: '$1K/month foundation',
      priority: 1,
      budget: { maxTokens: 5_000, maxCostUsd: 5, maxTimeMs: 60_000 },
      nextAction: 'Complete engineering readiness.',
    });
    await goals.transitionGoal('million-dollar-readiness', 'WORKING');

    const build = await goals.enqueueTask({
      id: 'build-core',
      goalId: 'million-dollar-readiness',
      title: 'Build core',
      intent: 'Implement one bounded engineering change.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['Verifier accepts the implementation'],
      verificationPlan: ['Run deterministic checks'],
      requiredCapabilities: ['claude-engineering'],
      approvalRequirement: 'NONE',
      idempotencyKey: 'goal-dashboard:build-core:v1',
      maxTurns: 20,
      maxRepairs: 3,
      tokenBudget: 1_000,
      costBudgetUsd: 1,
    });

    let snapshot = buildGoalDashboardSnapshot(await store.load());
    assert.equal(snapshot.summary.total, 1);
    assert.equal(snapshot.summary.missingCapabilities, 1);
    assert.equal(snapshot.summary.staleCapabilities, 0);
    assert.equal(snapshot.goals[0]?.capabilities[0]?.ready, false);
    assert.deepEqual(snapshot.goals[0]?.capabilities[0]?.missingChecks, ['DISCOVERED']);

    await capabilities.recordCheck('claude-engineering', 'DISCOVERED', 'Fresh Claude host session discovered the profile.');
    await goals.transitionTask(build.id, 'WORKING');
    await attempts.record({
      goalId: 'million-dollar-readiness',
      taskId: build.id,
      attemptNumber: 1,
      strategyFingerprint: 'bounded-build-v1',
      verificationScore: 1,
      changedPaths: ['src/example.ts'],
      tokensUsed: 420,
      costUsd: 0.12,
      elapsedMs: 1_500,
    });
    await goals.transitionTask(build.id, 'VERIFYING');
    await goals.transitionTask(build.id, 'COMPLETED');
    const checkpoint = await goals.checkpoint({
      goalId: 'million-dollar-readiness',
      taskId: build.id,
      summary: 'Core build verified.',
      verificationEvidence: ['typecheck passed', 'deterministic verifier passed'],
      nextAction: 'Await owner approval for the release task.',
    });

    const release = await goals.enqueueTask({
      id: 'release-core',
      goalId: 'million-dollar-readiness',
      title: 'Release core',
      intent: 'Prepare a consequential release but do not perform it without owner approval.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['Owner approval is present before consequential execution'],
      verificationPlan: ['Check approval gate'],
      dependencies: [build.id],
      requiredCapabilities: ['claude-engineering'],
      riskClass: 'YELLOW',
      approvalRequirement: 'OWNER',
      idempotencyKey: 'goal-dashboard:release-core:v1',
    });
    await goals.transitionTask(release.id, 'WAITING');
    await goals.transitionGoal('million-dollar-readiness', 'WAITING', {
      blocker: 'Owner approval is required for the release task.',
      resumeCondition: 'Resume only after explicit owner approval is recorded through the approval path.',
      nextAction: 'Review the release request.',
    });

    snapshot = buildGoalDashboardSnapshot(await store.load());
    let row = snapshot.goals[0]!;
    assert.equal(snapshot.summary.waiting, 1);
    assert.equal(snapshot.summary.ownerApprovalTasks, 1);
    assert.equal(snapshot.summary.missingCapabilities, 0);
    assert.equal(snapshot.summary.staleCapabilities, 0);
    assert.equal(snapshot.summary.trackedAttemptTokens, 420);
    assert.equal(snapshot.summary.trackedAttemptCostUsd, 0.12);
    assert.equal(row.state, 'WAITING');
    assert.equal(row.blocker, 'Owner approval is required for the release task.');
    assert.equal(row.resumeCondition, 'Resume only after explicit owner approval is recorded through the approval path.');
    assert.equal(row.ownerApprovalTasks[0]?.id, release.id);
    assert.equal(row.latestCheckpoint?.id, checkpoint.id);
    assert.deepEqual(row.latestCheckpoint?.verificationEvidence, ['typecheck passed', 'deterministic verifier passed']);
    assert.equal(row.budget.actualTokens, 420);
    assert.equal(row.budget.actualCostUsd, 0.12);

    await capabilities.upsert({
      id: 'claude-engineering',
      kind: 'SKILL',
      description: 'Engineering execution profile used by the dashboard test.',
      requiredChecks: ['PACKAGED', 'DISCOVERED'],
      readinessPolicy: { requireRuntimeObservation: true },
    });
    await capabilities.invalidateChecks(
      'claude-engineering',
      ['DISCOVERED'],
      'Observed route regression while Authorization: Bearer abcdefghijklmnopqrstuvwxyz was present in an imported diagnostic.',
    );

    snapshot = buildGoalDashboardSnapshot(await store.load());
    row = snapshot.goals[0]!;
    const capability = row.capabilities[0]!;
    assert.equal(snapshot.summary.missingCapabilities, 1);
    assert.equal(snapshot.summary.staleCapabilities, 1);
    assert.equal(capability.ready, false);
    assert.match(capability.staleReasons.join('\n'), /runtime observation is missing/);
    assert.ok(capability.invalidations.some((line) => line.includes('[REDACTED]')));
    assert.ok(capability.invalidations.every((line) => !line.includes('abcdefghijklmnopqrstuvwxyz')));
    assert.equal('evidence' in capability, false, 'Phone capability payload must not expose raw free-form evidence.');

    console.log('PASS NEXUS goal dashboard: persistent state, approvals, usage, verifier checkpoints and sanitized READY/MISSING/STALE capability reasons are visible read-only without raw evidence.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
