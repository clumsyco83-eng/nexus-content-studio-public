import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoalAttemptObservationRepository } from '../goals/attempt-observations.js';
import { GoalRepository } from '../goals/repository.js';
import { GoalReplanCoordinator, type StrategyRequester } from '../goals/replan-coordinator.js';
import type { OpenAIStrategyRequest, OpenAIStrategyResponse } from '../openai/strategy-adapter.js';
import { JsonFileStore } from '../storage/store.js';

const ENVELOPE_A = 'a'.repeat(64);
const ENVELOPE_B = 'b'.repeat(64);
const SKILL_SET_A = 'c'.repeat(64);
const SKILL_SET_B = 'd'.repeat(64);

class FakeStrategyRequester implements StrategyRequester {
  readonly calls: OpenAIStrategyRequest[] = [];

  async requestStrategy(input: OpenAIStrategyRequest): Promise<OpenAIStrategyResponse> {
    this.calls.push(input);
    return {
      result: {
        diagnosis: 'The same implementation strategy is repeating without verifier progress.',
        assumptions: [],
        recommendedStrategy: 'Change the implementation path and preserve the existing safety boundary.',
        alternativesConsidered: ['Repeat the same patch', 'Escalate permissions'],
        risks: ['A new path can still fail verification.'],
        requiredEvidence: ['Fresh verifier evidence after the changed strategy.'],
        proposedNextTasks: [{
          title: 'Try a materially different bounded repair',
          intent: 'Use verifier evidence to change the implementation path without widening permissions.',
          acceptanceCriteria: ['Verifier score materially improves or the task fails safe.'],
        }],
        ownerDecisionRequired: false,
        ownerDecisionReason: null,
      },
      audit: {
        clientRequestId: `fake-${this.calls.length}`,
        model: 'fake-strategy-model',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        actualCostUsd: 0.001,
      },
    };
  }
}

async function createTask(goals: GoalRepository, goalId: string, id: string, overrides: Record<string, unknown> = {}) {
  return goals.enqueueTask({
    id,
    goalId,
    title: `Task ${id}`,
    intent: 'Exercise persistent attempt diagnostics and bounded replanning.',
    worker: 'CLAUDE',
    acceptanceCriteria: ['Progress is evidence-based'],
    verificationPlan: ['Inspect the persisted observations and coordinator decision'],
    idempotencyKey: `replan-test:${id}:v1`,
    maxRepairs: 5,
    maxTurns: 20,
    timeLimitMs: 10_000,
    tokenBudget: 1_000,
    costBudgetUsd: 1,
    ...overrides,
  });
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-replan-'));
  try {
    const file = path.join(root, 'nexus.json');
    const store = new JsonFileStore(file);
    const goals = new GoalRepository(store);
    const observations = new GoalAttemptObservationRepository(store);
    const fake = new FakeStrategyRequester();
    const coordinator = new GoalReplanCoordinator(store, fake);

    await goals.createGoal({
      id: 'goal-replan',
      title: 'Replan coordinator test',
      objective: 'Stop blind retries and request a bounded strategy change only when evidence says work is stuck.',
      successCriteria: ['Attempt evidence persists', 'Healthy work continues', 'Stuck work replans once', 'Exhausted work stops'],
      priority: 1,
      budget: { maxTokens: 10_000, maxCostUsd: 10, maxTimeMs: 60_000 },
    });
    await goals.transitionGoal('goal-replan', 'WORKING');

    await createTask(goals, 'goal-replan', 'healthy');
    await observations.record({
      goalId: 'goal-replan', taskId: 'healthy', attemptNumber: 1,
      strategyFingerprint: 'strategy-a', failureFingerprint: 'failure-a', verificationScore: 0.2,
      changedPaths: ['src/a.ts'], tokensUsed: 100, costUsd: 0.05, elapsedMs: 500,
    });
    await observations.record({
      goalId: 'goal-replan', taskId: 'healthy', attemptNumber: 2,
      strategyFingerprint: 'strategy-b', failureFingerprint: 'failure-b', verificationScore: 0.6,
      changedPaths: ['src/b.ts'], tokensUsed: 100, costUsd: 0.05, elapsedMs: 500,
    });
    await observations.record({
      goalId: 'goal-replan', taskId: 'healthy', attemptNumber: 3,
      strategyFingerprint: 'strategy-c', verificationScore: 0.9,
      changedPaths: ['src/c.ts'], tokensUsed: 100, costUsd: 0.05, elapsedMs: 500,
    });
    const healthy = await coordinator.evaluate({ goalId: 'goal-replan', taskId: 'healthy' });
    assert.equal(healthy.action, 'CONTINUE');
    assert.equal(fake.calls.length, 0);

    await createTask(goals, 'goal-replan', 'stuck');
    const stuckInput = {
      goalId: 'goal-replan', taskId: 'stuck', strategyFingerprint: 'same-strategy',
      failureFingerprint: 'same-verifier-failure', verificationScore: 0.4,
      changedPaths: ['src/stuck.ts'], tokensUsed: 100, costUsd: 0.1, elapsedMs: 1_000,
      toolEnvelopeHash: ENVELOPE_A,
      skillSetHash: SKILL_SET_A,
    };
    const first = await observations.record({ ...stuckInput, attemptNumber: 1 });
    const duplicate = await observations.record({ ...stuckInput, attemptNumber: 1 });
    assert.equal(duplicate.id, first.id);
    assert.equal(first.toolEnvelopeHash, ENVELOPE_A);
    assert.equal(first.skillSetHash, SKILL_SET_A);
    await assert.rejects(
      () => observations.record({ ...stuckInput, attemptNumber: 1, failureFingerprint: 'conflicting-failure' }),
      /Attempt observation conflict/,
    );
    await assert.rejects(
      () => observations.record({ ...stuckInput, attemptNumber: 1, toolEnvelopeHash: ENVELOPE_B }),
      /Attempt observation conflict/,
    );
    await assert.rejects(
      () => observations.record({ ...stuckInput, attemptNumber: 1, skillSetHash: SKILL_SET_B }),
      /Attempt observation conflict/,
    );
    await assert.rejects(
      () => observations.record({ ...stuckInput, taskId: 'stuck', attemptNumber: 2, toolEnvelopeHash: 'not-a-hash' }),
      /64-character SHA-256/,
    );
    await assert.rejects(
      () => observations.record({ ...stuckInput, taskId: 'stuck', attemptNumber: 2, skillSetHash: 'not-a-hash' }),
      /64-character SHA-256/,
    );
    await observations.record({ ...stuckInput, attemptNumber: 2 });
    await observations.record({ ...stuckInput, attemptNumber: 3 });

    const persisted = await new GoalAttemptObservationRepository(new JsonFileStore(file)).listForTask('goal-replan', 'stuck');
    assert.deepEqual(persisted.map((item) => item.attemptNumber), [1, 2, 3]);
    assert.deepEqual(persisted.map((item) => item.toolEnvelopeHash), [ENVELOPE_A, ENVELOPE_A, ENVELOPE_A]);
    assert.deepEqual(persisted.map((item) => item.skillSetHash), [SKILL_SET_A, SKILL_SET_A, SKILL_SET_A]);

    const replan = await coordinator.evaluate({
      goalId: 'goal-replan',
      taskId: 'stuck',
      verifiedFacts: ['Guardian and Watchdog remain green.'],
      additionalFailureEvidence: ['Verifier rejected the same output three times.'],
    });
    assert.equal(replan.action, 'REPLAN');
    assert.equal(fake.calls.length, 1);
    assert.ok(replan.strategy?.recommendedStrategy.includes('Change the implementation path'));
    assert.equal(fake.calls[0]?.goalId, 'goal-replan');
    assert.equal(fake.calls[0]?.taskId, 'stuck');
    assert.ok(fake.calls[0]?.failureEvidence?.some((item) => item.includes('same failure')));
    assert.equal(fake.calls[0]?.budgetRemaining?.maxTokens, 700);
    assert.ok(Math.abs((fake.calls[0]?.budgetRemaining?.maxCostUsd ?? 0) - 0.7) < 1e-9);
    assert.equal(fake.calls[0]?.budgetRemaining?.maxTimeMs, 7_000);

    await createTask(goals, 'goal-replan', 'exhausted', { tokenBudget: 300 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await observations.record({
        goalId: 'goal-replan', taskId: 'exhausted', attemptNumber: attempt,
        strategyFingerprint: `strategy-${attempt}`, failureFingerprint: `failure-${attempt}`,
        verificationScore: attempt / 10, changedPaths: [`src/${attempt}.ts`], tokensUsed: 100,
      });
    }
    const exhausted = await coordinator.evaluate({ goalId: 'goal-replan', taskId: 'exhausted' });
    assert.equal(exhausted.action, 'STOP');
    assert.equal(exhausted.diagnosis.shouldStop, true);
    assert.equal(fake.calls.length, 1, 'Hard budget exhaustion must not call the strategy provider.');

    console.log('PASS NEXUS replan coordinator: attempt diagnostics plus Claude tool-envelope and skill-set authority identities persist, conflicting attempt authority fails closed, improving work continues, stuck work triggers one bounded advisory replan, and exhausted budgets stop without a provider call.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
