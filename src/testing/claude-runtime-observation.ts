import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry, capabilityReadiness } from '../capabilities/registry.js';
import {
  applyClaudeRuntimeObservationRefresh,
  CLAUDE_RUNTIME_OBSERVATION_APPLY_OPT_IN,
  previewClaudeRuntimeObservationRefresh,
  requireClaudeRuntimeObservationApplyOptIn,
} from '../capabilities/claude-runtime-observation.js';
import { JsonFileStore } from '../storage/store.js';

const MODEL = 'claude-sonnet-5';
const VERSION = '2.1.220';
const SHA = 'a'.repeat(64);
const SAFETY = 'secure-bridge-reviewed-v1';
const CWD = 'C:\\NEXUS-WORK\\nexus-content-studio-current-main';
const applyEnv = { NEXUS_CLAUDE_RUNTIME_OBSERVATION_APPLY: CLAUDE_RUNTIME_OBSERVATION_APPLY_OPT_IN };

function isoOffset(hours: number): string { return new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString(); }
function stream(model = MODEL): string {
  const session = 'bounded-live-smoke-test';
  return [
    { type: 'system', subtype: 'init', session_id: session, model, permissionMode: 'plan', cwd: CWD, tools: [], mcp_servers: [] },
    { type: 'result', subtype: 'success', session_id: session, is_error: false, duration_ms: 100, duration_api_ms: 80, num_turns: 1, total_cost_usd: 0.01, result: 'NEXUS_CLAUDE_RUNTIME_SMOKE_OK' },
  ].map((item) => JSON.stringify(item)).join('\n');
}

async function seed(store: JsonFileStore): Promise<void> {
  const registry = new CapabilityRegistry(store);
  await registry.upsert({
    id: 'claude-executor', kind: 'RUNTIME', description: 'Bounded Claude executor test capability',
    requiredChecks: ['DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED'],
    passedChecks: ['DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED'], enabled: true,
    evidence: ['known-good evaluated runtime'],
    evidenceBinding: {
      sourceSha256: SHA, evaluationRevision: 'secure-bridge/test-eval', evaluatedAt: isoOffset(-3),
      evaluatedModelIds: [MODEL], providerResolvedModelIds: [MODEL], runtimeVersion: VERSION,
      safetyRevision: SAFETY, rollbackTarget: 'known-good-test',
    },
    readinessPolicy: {
      requireSourceSha256: false, requireEvaluationRevision: true, requireExactModelIdentity: true,
      requireRuntimeVersion: true, requireSafetyRevision: false, requireRollbackTarget: true,
      requireRuntimeObservation: true, maxRuntimeObservationAgeHours: 1,
    },
    lastRuntimeObservation: {
      observedAt: isoOffset(-2), sourceSha256: SHA, providerResolvedModelIds: [MODEL], runtimeVersion: VERSION,
      safetyRevision: SAFETY, note: 'old matching observation',
    },
  });
}

function input(overrides: Partial<Parameters<typeof previewClaudeRuntimeObservationRefresh>[1]> = {}) {
  return {
    capabilityId: 'claude-executor', streamJson: stream(), expectedResolvedModel: MODEL,
    expectedClaudeCodeVersion: VERSION, actualClaudeCodeVersion: VERSION, expectedCwd: CWD,
    maxCostUsd: 0.1, observedAt: new Date(Date.now() - 1_000).toISOString(), ...overrides,
  };
}

async function main(): Promise<void> {
  assert.doesNotThrow(() => requireClaudeRuntimeObservationApplyOptIn(false, {}));
  assert.throws(() => requireClaudeRuntimeObservationApplyOptIn(true, {}), /Apply mode is disabled/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-claude-runtime-observation-'));
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    await seed(store);
    const beforeDb = await store.load();
    const beforeCap = beforeDb.capabilities[0]!;
    assert.equal(capabilityReadiness(beforeCap).ready, false);
    assert.match(capabilityReadiness(beforeCap).staleReasons.join('\n'), /runtime observation is older than 1 hour/);

    const preview = await previewClaudeRuntimeObservationRefresh(store, input());
    assert.equal(preview.mode, 'preview'); assert.equal(preview.before.ready, false); assert.equal(preview.after.ready, true);
    assert.equal(preview.bindingPreserved, true); assert.equal(preview.passedChecksPreserved, true); assert.equal(preview.invalidationsPreserved, true);
    assert.deepEqual(await store.load(), beforeDb, 'Preview must not mutate durable NEXUS state.');

    await assert.rejects(() => previewClaudeRuntimeObservationRefresh(store, input({ actualClaudeCodeVersion: '2.1.221' })), /version drift/i);
    await assert.rejects(() => previewClaudeRuntimeObservationRefresh(store, input({ streamJson: stream('claude-opus-5') })), /resolved model drift/i);

    const drifted = await store.load();
    drifted.capabilities[0]!.lastRuntimeObservation!.safetyRevision = 'wrong-safety';
    await store.save(drifted);
    await assert.rejects(() => previewClaudeRuntimeObservationRefresh(store, input()), /non-refreshable stale reason/i);
    await store.save(beforeDb);

    const sourceRequired = await store.load();
    sourceRequired.capabilities[0]!.readinessPolicy!.requireSourceSha256 = true;
    await store.save(sourceRequired);
    await assert.rejects(() => previewClaudeRuntimeObservationRefresh(store, input()), /does not independently observe current source\/package SHA-256/i);
    await store.save(beforeDb);

    const safetyRequired = await store.load();
    safetyRequired.capabilities[0]!.readinessPolicy!.requireSafetyRevision = true;
    await store.save(safetyRequired);
    await assert.rejects(() => previewClaudeRuntimeObservationRefresh(store, input()), /does not independently observe the current safety revision/i);
    await store.save(beforeDb);

    const multi = await store.load();
    multi.capabilities[0]!.evidenceBinding!.providerResolvedModelIds = [MODEL, 'claude-opus-5'];
    multi.capabilities[0]!.evidenceBinding!.evaluatedModelIds = [MODEL, 'claude-opus-5'];
    multi.capabilities[0]!.lastRuntimeObservation!.providerResolvedModelIds = [MODEL, 'claude-opus-5'];
    await store.save(multi);
    await assert.rejects(() => previewClaudeRuntimeObservationRefresh(store, input()), /exactly one provider-resolved model/);
    await store.save(beforeDb);

    await assert.rejects(() => applyClaudeRuntimeObservationRefresh(store, input(), { backupDir: path.join(root, 'backups'), env: {} }), /Apply mode is disabled/);
    const applied = await applyClaudeRuntimeObservationRefresh(store, input(), { backupDir: path.join(root, 'backups'), env: applyEnv });
    assert.equal(applied.mode, 'apply'); assert.equal(applied.after.ready, true); assert.ok(applied.backupPath); await access(applied.backupPath!);
    const afterDb = await store.load(); const afterCap = afterDb.capabilities[0]!;
    assert.deepEqual(afterCap.evidenceBinding, beforeCap.evidenceBinding); assert.deepEqual(afterCap.readinessPolicy, beforeCap.readinessPolicy);
    assert.deepEqual(afterCap.requiredChecks, beforeCap.requiredChecks); assert.deepEqual(afterCap.passedChecks, beforeCap.passedChecks);
    assert.deepEqual(afterCap.invalidations ?? [], beforeCap.invalidations ?? []);
    assert.equal(afterCap.lastRuntimeObservation?.runtimeVersion, VERSION);
    assert.deepEqual(afterCap.lastRuntimeObservation?.providerResolvedModelIds, [MODEL]);
    assert.equal(afterCap.lastRuntimeObservation?.sourceSha256, undefined); assert.equal(afterCap.lastRuntimeObservation?.safetyRevision, undefined);
    assert.equal(capabilityReadiness(afterCap).ready, true);

    console.log('PASS Claude runtime-observation refresh: stale-age-only preview, exact model/version/cwd smoke binding, replay-resistant timestamp input, no source/safety freshness laundering, unchanged evaluated binding/policy/checks, backup, opt-in apply and drift-negative gates verified.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
