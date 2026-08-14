import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { buildGoalDashboardSnapshot } from '../dashboard/goal-dashboard-service.js';
import { GoalAttemptObservationRepository } from '../goals/attempt-observations.js';
import { GoalRepository } from '../goals/repository.js';
import { GoalReplanCoordinator } from '../goals/replan-coordinator.js';
import {
  OpenAIStrategyAdapter,
  type OpenAIStrategyResult,
  type StrategyTransport,
} from '../openai/strategy-adapter.js';
import { JsonFileStore } from '../storage/store.js';

function responseEnvelope(id: string, result: OpenAIStrategyResult, inputTokens: number, outputTokens: number) {
  return {
    id,
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(result) }],
    }],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-collaboration-e2e-'));
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const goals = new GoalRepository(store);
    const capabilities = new CapabilityRegistry(store);
    const attempts = new GoalAttemptObservationRepository(store);

    for (const capability of [
      { id: 'openai-strategy', kind: 'CONNECTOR' as const },
      { id: 'claude-executor', kind: 'RUNTIME' as const },
      { id: 'nexus-verifier', kind: 'RUNTIME' as const },
    ]) {
      await capabilities.upsert({
        ...capability,
        description: `${capability.id} deterministic acceptance capability.`,
        requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
        passedChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
        evidence: ['RUNTIME_WIRED: deterministic harness', 'SAFETY_VERIFIED: no live side effects'],
      });
    }

    const transportCalls: Array<{ body: unknown }> = [];
    let strategyCall = 0;
    const transport: StrategyTransport = async (request) => {
      transportCalls.push({ body: request.body });
      strategyCall += 1;
      const result: OpenAIStrategyResult = strategyCall === 1 ? {
        diagnosis: 'The goal requires a bounded implementation task after strategy is verified.',
        assumptions: ['The deterministic harness represents provider handoff without live side effects.'],
        recommendedStrategy: 'Implement the smallest bounded change, verify it independently, and preserve a checkpoint.',
        alternativesConsidered: ['Skip deterministic verification'],
        risks: ['Implementation can fail the verifier and require bounded repair.'],
        requiredEvidence: ['Independent verifier result'],
        proposedNextTasks: [{
          title: 'Implement bounded change',
          intent: 'Execute through Claude under the NEXUS task contract.',
          acceptanceCriteria: ['Deterministic verifier passes'],
        }],
        ownerDecisionRequired: false,
        ownerDecisionReason: null,
      } : {
        diagnosis: 'Three attempts repeated the same failure and implementation fingerprint without verification progress.',
        assumptions: ['The verifier evidence accurately represents the repeated failure.'],
        recommendedStrategy: 'Change the implementation strategy materially while keeping the same permissions and acceptance criteria.',
        alternativesConsidered: ['Repeat the same repair', 'Widen permissions'],
        risks: ['The new bounded repair can still fail.'],
        requiredEvidence: ['A different strategy fingerprint', 'Verifier score reaches the acceptance threshold'],
        proposedNextTasks: [{
          title: 'Execute materially different repair',
          intent: 'Change implementation approach without expanding authority.',
          acceptanceCriteria: ['Verifier passes without permission expansion'],
        }],
        ownerDecisionRequired: false,
        ownerDecisionReason: null,
      };
      return {
        status: 200,
        ok: true,
        headers: { 'x-request-id': `server-request-${strategyCall}` },
        json: responseEnvelope(`response-${strategyCall}`, result, strategyCall === 1 ? 220 : 260, strategyCall === 1 ? 120 : 140),
      };
    };

    const strategy = new OpenAIStrategyAdapter({
      endpoint: 'https://example.invalid/v1/responses',
      model: 'test-strategy-model-2026-08-13',
      timeoutMs: 5_000,
      maxOutputTokens: 500,
      maxInputBytes: 64_000,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 10,
    }, transport);
    const replanner = new GoalReplanCoordinator(store, strategy);

    await goals.createGoal({
      id: 'owner-to-verifier-e2e',
      title: 'Owner → NEXUS → OpenAI → Claude → Verifier acceptance',
      objective: 'Prove the collaboration control plane preserves durable state, bounded strategy, repair limits and independent verification.',
      successCriteria: [
        'OpenAI strategy is advisory and budgeted',
        'Claude execution is represented by a bounded task contract',
        'Repeated non-progress triggers a materially different replan',
        'Completion is checkpointed only after deterministic verifier evidence',
      ],
      priority: 1,
      budget: { maxTokens: 10_000, maxCostUsd: 5, maxTimeMs: 120_000 },
      nextAction: 'Request bounded strategy.',
    });
    await goals.transitionGoal('owner-to-verifier-e2e', 'WORKING');

    const strategyTask = await goals.enqueueTask({
      id: 'strategy-step',
      goalId: 'owner-to-verifier-e2e',
      title: 'Create bounded strategy',
      intent: 'Ask OpenAI for advisory strategy only.',
      worker: 'CHATGPT',
      acceptanceCriteria: ['Structured strategy passes NEXUS schema validation'],
      verificationPlan: ['Validate structured output and audit metadata'],
      requiredCapabilities: ['openai-strategy'],
      idempotencyKey: 'collaboration-e2e:strategy:v1',
      tokenBudget: 1_000,
      costBudgetUsd: 0.05,
      timeLimitMs: 10_000,
    });
    assert.deepEqual((await goals.listReadyTasks()).map((task) => task.id), ['strategy-step']);
    await goals.transitionTask(strategyTask.id, 'WORKING');
    const initialStrategy = await strategy.requestStrategy({
      goalId: 'owner-to-verifier-e2e',
      taskId: strategyTask.id,
      objective: 'Choose a bounded implementation path.',
      currentState: 'NEXUS owns state. No implementation has started.',
      verifiedFacts: ['Guardian and Watchdog are outside model authority.'],
      constraints: ['Do not execute, approve, publish, spend, or widen permissions.'],
      availableCapabilities: ['claude-executor', 'nexus-verifier'],
      budgetRemaining: { maxTokens: 500, maxCostUsd: 0.05, maxTimeMs: 5_000 },
      decisionRequested: 'Recommend the next bounded implementation strategy.',
    });
    assert.equal(initialStrategy.audit.model, 'test-strategy-model-2026-08-13');
    assert.equal(initialStrategy.result.ownerDecisionRequired, false);
    const firstBody = transportCalls[0]?.body as { store?: boolean; max_output_tokens?: number };
    assert.equal(firstBody.store, false);
    assert.equal(firstBody.max_output_tokens, 500);
    await attempts.record({
      goalId: 'owner-to-verifier-e2e',
      taskId: strategyTask.id,
      attemptNumber: 1,
      strategyFingerprint: 'openai-advisory-strategy-v1',
      verificationScore: 1,
      tokensUsed: initialStrategy.audit.totalTokens,
      costUsd: initialStrategy.audit.actualCostUsd,
      elapsedMs: 300,
    });
    await goals.transitionTask(strategyTask.id, 'VERIFYING');
    await goals.transitionTask(strategyTask.id, 'COMPLETED');
    await goals.checkpoint({
      goalId: 'owner-to-verifier-e2e',
      taskId: strategyTask.id,
      summary: 'Bounded strategy accepted by NEXUS schema and budget policy.',
      verificationEvidence: ['structured strategy validated', 'store:false enforced', 'provider usage audit captured'],
      nextAction: 'Dispatch bounded Claude implementation task.',
    });

    const implementationTask = await goals.enqueueTask({
      id: 'claude-implementation',
      goalId: 'owner-to-verifier-e2e',
      title: 'Execute bounded implementation',
      intent: 'Represent the real Claude executor contract without granting live machine authority in CI.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['Verifier score reaches 1.0', 'No permissions are widened'],
      verificationPlan: ['Independent deterministic verifier evaluates the output'],
      dependencies: [strategyTask.id],
      requiredCapabilities: ['claude-executor', 'nexus-verifier'],
      allowedPaths: ['src/**'],
      forbiddenPaths: ['.env', '.nexus_security_token'],
      riskClass: 'GREEN',
      approvalRequirement: 'NONE',
      idempotencyKey: 'collaboration-e2e:claude:v1',
      maxTurns: 20,
      maxRepairs: 5,
      tokenBudget: 3_000,
      costBudgetUsd: 1,
      timeLimitMs: 30_000,
    });
    assert.deepEqual((await goals.listReadyTasks()).map((task) => task.id), ['claude-implementation']);

    await goals.transitionTask(implementationTask.id, 'WORKING');
    const repeatedFailure = {
      goalId: 'owner-to-verifier-e2e',
      taskId: implementationTask.id,
      strategyFingerprint: 'same-claude-repair',
      failureFingerprint: 'verifier:acceptance-criterion-not-met',
      verificationScore: 0.4,
      changedPaths: ['src/bounded-change.ts'],
      tokensUsed: 300,
      costUsd: 0.08,
      elapsedMs: 1_000,
    };

    await attempts.record({ ...repeatedFailure, attemptNumber: 1 });
    await goals.transitionTask(implementationTask.id, 'VERIFYING');
    await goals.transitionTask(implementationTask.id, 'REPAIRING', repeatedFailure.failureFingerprint);
    await goals.transitionTask(implementationTask.id, 'WORKING');
    await attempts.record({ ...repeatedFailure, attemptNumber: 2 });
    await goals.transitionTask(implementationTask.id, 'VERIFYING');
    await goals.transitionTask(implementationTask.id, 'REPAIRING', repeatedFailure.failureFingerprint);
    await goals.transitionTask(implementationTask.id, 'WORKING');
    await attempts.record({ ...repeatedFailure, attemptNumber: 3 });

    const replan = await replanner.evaluate({
      goalId: 'owner-to-verifier-e2e',
      taskId: implementationTask.id,
      verifiedFacts: ['The same verifier failure occurred three times.'],
      additionalFailureEvidence: ['No verification improvement occurred across the repeated strategy.'],
    });
    assert.equal(replan.action, 'REPLAN');
    assert.equal(strategyCall, 2);
    assert.ok(replan.strategy?.recommendedStrategy.includes('Change the implementation strategy materially'));
    assert.equal(replan.audit?.model, 'test-strategy-model-2026-08-13');

    await goals.transitionTask(implementationTask.id, 'VERIFYING');
    await goals.transitionTask(implementationTask.id, 'REPAIRING', repeatedFailure.failureFingerprint);
    await goals.transitionTask(implementationTask.id, 'WORKING');
    await attempts.record({
      goalId: 'owner-to-verifier-e2e',
      taskId: implementationTask.id,
      attemptNumber: 4,
      strategyFingerprint: 'materially-different-repair',
      verificationScore: 1,
      changedPaths: ['src/bounded-change.ts'],
      tokensUsed: 360,
      costUsd: 0.1,
      elapsedMs: 1_100,
    });
    await goals.transitionTask(implementationTask.id, 'VERIFYING');
    await goals.transitionTask(implementationTask.id, 'COMPLETED');
    const finalCheckpoint = await goals.checkpoint({
      goalId: 'owner-to-verifier-e2e',
      taskId: implementationTask.id,
      summary: 'Materially different bounded repair passed independent verification.',
      verificationEvidence: ['verifier score 1.0', 'required capability gates READY', 'no authority expansion'],
      nextAction: 'Mark the persistent goal complete.',
    });
    await goals.transitionGoal('owner-to-verifier-e2e', 'COMPLETED', { nextAction: 'Archive verified evidence.' });

    const db = await store.load();
    const dashboard = buildGoalDashboardSnapshot(db);
    assert.equal(dashboard.summary.completed, 1);
    assert.equal(dashboard.goals[0]?.latestCheckpoint?.id, finalCheckpoint.id);
    assert.equal(dashboard.goals[0]?.progress.completedTasks, 2);
    assert.equal(dashboard.goals[0]?.state, 'COMPLETED');
    assert.equal(transportCalls.length, 2);
    assert.ok(db.goalAttemptObservations.length >= 5);

    console.log('PASS NEXUS collaboration acceptance: owner goal → bounded OpenAI strategy → durable NEXUS task state → bounded Claude contract → independent verifier evidence → stuck replan → verified checkpoint → completion. Live provider/bridge proof remains a separate real-host gate.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
