import assert from 'node:assert/strict';
import {
  isFloatingModelIdentifier,
  validateClaudeRoutingPromotion,
  validateModelPromotion,
  type ModelPromotionEvidence,
} from '../ai/model-promotion.js';

const baseClaude = (overrides: Partial<ModelPromotionEvidence> = {}): ModelPromotionEvidence => ({
  provider: 'CLAUDE',
  role: 'PRIMARY_EXECUTOR',
  configuredIdentifier: 'claude-sonnet-4-20250514',
  evaluatedIdentifier: 'claude-sonnet-4-20250514',
  providerReportedIdentifier: 'claude-sonnet-4-20250514',
  evaluationRevision: 'intelligence-profile-v1.0.0/eval-2026-08-13',
  evaluatedAt: '2026-08-13T07:00:00+10:00',
  snapshotAvailable: true,
  pinnedSnapshot: true,
  replacingExisting: false,
  ...overrides,
});

assert.equal(isFloatingModelIdentifier('CLAUDE', 'sonnet'), true);
assert.equal(isFloatingModelIdentifier('CLAUDE', 'opus'), true);
assert.equal(isFloatingModelIdentifier('OPENAI', 'some-model-latest'), true);
assert.equal(isFloatingModelIdentifier('CLAUDE', 'claude-sonnet-4-20250514'), false);

const exact = validateModelPromotion(baseClaude());
assert.equal(exact.ready, true);
assert.deepEqual(exact.failures, []);

const alias = validateModelPromotion(baseClaude({
  configuredIdentifier: 'sonnet',
  evaluatedIdentifier: 'sonnet',
  providerReportedIdentifier: undefined,
  snapshotAvailable: false,
  pinnedSnapshot: false,
}));
assert.equal(alias.ready, false);
assert.ok(alias.failures.some((failure) => failure.includes('floating CLAUDE model alias')));

const drift = validateModelPromotion(baseClaude({ configuredIdentifier: 'claude-sonnet-next', evaluatedIdentifier: 'claude-sonnet-tested' }));
assert.equal(drift.ready, false);
assert.ok(drift.failures.some((failure) => failure.includes('exactly match')));

const unpinned = validateModelPromotion(baseClaude({ snapshotAvailable: true, pinnedSnapshot: false }));
assert.equal(unpinned.ready, false);
assert.ok(unpinned.failures.some((failure) => failure.includes('not pinned')));

const replacementWithoutRollback = validateModelPromotion(baseClaude({ replacingExisting: true, rollbackIdentifier: undefined }));
assert.equal(replacementWithoutRollback.ready, false);
assert.ok(replacementWithoutRollback.failures.some((failure) => failure.includes('rollbackIdentifier')));

const openAiNoSnapshot = validateModelPromotion({
  provider: 'OPENAI',
  role: 'STRATEGY',
  configuredIdentifier: 'provider-exact-strategy-id',
  evaluatedIdentifier: 'provider-exact-strategy-id',
  providerReportedIdentifier: 'provider-exact-strategy-id',
  evaluationRevision: 'strategy-contract-v1',
  evaluatedAt: '2026-08-13T07:00:00+10:00',
  snapshotAvailable: false,
  pinnedSnapshot: false,
});
assert.equal(openAiNoSnapshot.ready, true);
assert.ok(openAiNoSnapshot.warnings.some((warning) => warning.includes('rerun evaluations')));

const routing = validateClaudeRoutingPromotion({
  primary: baseClaude(),
  escalation: baseClaude({
    role: 'ESCALATION_EXECUTOR',
    configuredIdentifier: 'claude-opus-4-20250514',
    evaluatedIdentifier: 'claude-opus-4-20250514',
    providerReportedIdentifier: 'claude-opus-4-20250514',
    evaluationRevision: 'critical-opus-subset-2026-08-13',
  }),
});
assert.equal(routing.ready, true);

const sameModel = validateClaudeRoutingPromotion({
  primary: baseClaude(),
  escalation: baseClaude({ role: 'ESCALATION_EXECUTOR' }),
});
assert.equal(sameModel.ready, false);
assert.ok(sameModel.failures.some((failure) => failure.includes('must be distinct')));

console.log('PASS model promotion gate: floating aliases, configuration/evaluation drift, unpinned available snapshots and missing rollback evidence fail closed; exact evaluated primary/escalation evidence passes.');
