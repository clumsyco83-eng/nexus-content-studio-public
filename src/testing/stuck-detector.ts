import assert from 'node:assert/strict';
import { detectStuck } from '../goals/stuck-detector.js';

function main() {
  const healthy = detectStuck([
    { attemptNumber: 1, strategyFingerprint: 'strategy-a', failureFingerprint: 'test-1', verificationScore: 0.3, changedPaths: ['src/a.ts'], tokensUsed: 100 },
    { attemptNumber: 2, strategyFingerprint: 'strategy-b', failureFingerprint: 'test-2', verificationScore: 0.6, changedPaths: ['src/b.ts'], tokensUsed: 120 },
    { attemptNumber: 3, strategyFingerprint: 'strategy-c', verificationScore: 0.9, changedPaths: ['src/c.ts'], tokensUsed: 110 },
  ], { maxTokens: 1_000 });
  assert.equal(healthy.stuck, false);

  const repeated = detectStuck([
    { attemptNumber: 1, strategyFingerprint: 'same-strategy', failureFingerprint: 'same-error', verificationScore: 0.4, changedPaths: ['src/x.ts'] },
    { attemptNumber: 2, strategyFingerprint: 'same-strategy', failureFingerprint: 'same-error', verificationScore: 0.4, changedPaths: ['src/x.ts'] },
    { attemptNumber: 3, strategyFingerprint: 'same-strategy', failureFingerprint: 'same-error', verificationScore: 0.4, changedPaths: ['src/x.ts'] },
  ]);
  assert.equal(repeated.stuck, true);
  assert.equal(repeated.shouldReplan, true);
  assert.equal(repeated.shouldStop, false);
  assert.ok(repeated.reasons.some((reason) => reason.includes('same failure')));
  assert.ok(repeated.reasons.some((reason) => reason.includes('verification score')));

  const interruptedFailure = detectStuck([
    { attemptNumber: 1, strategyFingerprint: 'same-strategy', failureFingerprint: 'same-error', changedPaths: ['src/x.ts'] },
    { attemptNumber: 2, strategyFingerprint: 'same-strategy', changedPaths: ['src/x.ts'] },
    { attemptNumber: 3, strategyFingerprint: 'same-strategy', failureFingerprint: 'same-error', changedPaths: ['src/x.ts'] },
    { attemptNumber: 4, strategyFingerprint: 'new-strategy', failureFingerprint: 'same-error', changedPaths: ['src/y.ts'] },
  ]);
  assert.equal(interruptedFailure.reasons.some((reason) => reason.includes('same failure')), false);

  const exhausted = detectStuck([
    { attemptNumber: 1, strategyFingerprint: 'a', tokensUsed: 400, costUsd: 0.25, elapsedMs: 400 },
    { attemptNumber: 2, strategyFingerprint: 'b', tokensUsed: 600, costUsd: 0.25, elapsedMs: 600 },
  ], { maxTokens: 1_000, maxCostUsd: 0.5, maxTimeMs: 1_000 });
  assert.equal(exhausted.stuck, true);
  assert.equal(exhausted.shouldStop, true);
  assert.equal(exhausted.shouldReplan, false);
  assert.equal(exhausted.reasons.length, 3);

  console.log('PASS NEXUS stuck detector: improving work continues, only consecutive repeated failures trigger loop diagnosis, and hard token/cost/time budgets stop safely.');
}

main();
