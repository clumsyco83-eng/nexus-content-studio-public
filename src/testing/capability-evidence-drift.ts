import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry, capabilityReadiness } from '../capabilities/registry.js';
import { JsonFileStore } from '../storage/store.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-capability-evidence-'));
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const registry = new CapabilityRegistry(store);

    const legacy = await registry.upsert({
      id: 'legacy:capability',
      kind: 'RUNTIME',
      description: 'Legacy capability with pre-policy free-form readiness evidence.',
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      passedChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      evidence: ['RUNTIME_WIRED: existing evidence', 'SAFETY_VERIFIED: existing safety evidence'],
    });
    const legacyReadiness = capabilityReadiness(legacy, new Date('2026-08-13T00:00:00Z'));
    assert.equal(legacyReadiness.ready, true, 'Legacy records without a readinessPolicy must remain backward-compatible.');
    assert.deepEqual(legacyReadiness.staleReasons, []);

    await registry.setEnabled(legacy.id, false, 'Operator disabled capability for maintenance.');
    const disabledBeforeUpsert = await registry.get(legacy.id);
    assert.equal(disabledBeforeUpsert?.enabled, false);
    const disabledEvidenceBefore = disabledBeforeUpsert!.evidence.slice();
    const disabledChecksBefore = disabledBeforeUpsert!.passedChecks.slice();
    await registry.upsert({
      id: legacy.id,
      kind: 'RUNTIME',
      description: 'Routine metadata refresh must not alter operational state.',
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
    });
    const disabledAfterUpsert = await registry.get(legacy.id);
    assert.equal(disabledAfterUpsert?.enabled, false, 'Partial upsert must not silently re-enable a disabled capability.');
    assert.deepEqual(disabledAfterUpsert?.passedChecks, disabledChecksBefore, 'Partial upsert must preserve existing passed checks.');
    assert.deepEqual(disabledAfterUpsert?.evidence, disabledEvidenceBefore, 'Partial upsert must preserve existing evidence/audit lines.');
    await registry.setEnabled(legacy.id, true, 'Maintenance test complete.');

    await assert.rejects(
      () => registry.upsert({
        id: legacy.id,
        kind: 'SKILL',
        description: 'A capability ID cannot silently change semantic kind.',
        requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      }),
      /kind is immutable/,
    );
    assert.equal((await registry.get(legacy.id))?.kind, 'RUNTIME');

    await registry.upsert({
      id: 'requirements:capability',
      kind: 'RUNTIME',
      description: 'Required-check changes are readiness-policy migrations.',
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      passedChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
    });
    await registry.upsert({
      id: 'requirements:capability',
      kind: 'RUNTIME',
      description: 'Attempt to shrink the required-check set.',
      requiredChecks: ['RUNTIME_WIRED'],
      passedChecks: ['RUNTIME_WIRED'],
    });
    const requirementsChanged = await registry.get('requirements:capability');
    assert.deepEqual(requirementsChanged?.passedChecks, [], 'Changing required checks must clear all prior proof, even if caller supplies a matching passed check.');
    assert.ok(requirementsChanged?.invalidations?.some((line) => line.includes('REQUIRED_CHECKS_CHANGED')));
    assert.equal(capabilityReadiness(requirementsChanged!).ready, false, 'Shrinking the required-check set cannot immediately produce READY.');

    await registry.upsert({
      id: 'policy-change:capability',
      kind: 'RUNTIME',
      description: 'Readiness policy changes must invalidate prior proof.',
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      passedChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      readinessPolicy: { requireRuntimeObservation: false },
    });
    await registry.upsert({
      id: 'policy-change:capability',
      kind: 'RUNTIME',
      description: 'Readiness policy changes must invalidate prior proof.',
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      readinessPolicy: { requireRuntimeObservation: true },
    });
    const policyChanged = await registry.get('policy-change:capability');
    assert.deepEqual(policyChanged?.passedChecks, [], 'Changing the readiness policy must clear prior readiness checks.');
    assert.ok(policyChanged?.invalidations?.some((line) => line.includes('READINESS_POLICY_CHANGED')));

    const initialBinding = {
      sourceSha256: SHA_A,
      evaluationRevision: 'intelligence-v1/eval-2026-08-12',
      evaluatedAt: '2026-08-12T00:00:00Z',
      evaluatedModelIds: ['claude-sonnet-exact-1', 'claude-opus-exact-1'],
      providerResolvedModelIds: ['claude-sonnet-exact-1', 'claude-opus-exact-1'],
      runtimeVersion: 'claude-code-2.1.0',
      safetyRevision: 'guardian-watchdog-v18',
      rollbackTarget: 'intelligence-v1-last-known-good',
    };
    const readinessPolicy = {
      requireSourceSha256: true,
      requireEvaluationRevision: true,
      requireExactModelIdentity: true,
      requireRuntimeVersion: true,
      requireSafetyRevision: true,
      requireRollbackTarget: true,
      requireRuntimeObservation: true,
      maxEvidenceAgeHours: 72,
      maxRuntimeObservationAgeHours: 48,
    };

    const capability = await registry.upsert({
      id: 'claude:intelligence-foundation-v1',
      kind: 'SKILL',
      description: 'Intelligence Foundation bound to exact package/model/runtime evidence.',
      source: 'nexus-intelligence-foundation-v1.0.0.zip',
      version: '1.0.0',
      requiredChecks: ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      passedChecks: ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      evidenceBinding: initialBinding,
      readinessPolicy,
    });

    let readiness = capabilityReadiness(capability, new Date('2026-08-12T01:00:00Z'));
    assert.equal(readiness.ready, false);
    assert.match(readiness.staleReasons.join('\n'), /runtime observation is missing/);

    await registry.recordRuntimeObservation(capability.id, {
      observedAt: '2026-08-12T01:05:00Z',
      sourceSha256: SHA_A,
      providerResolvedModelIds: ['claude-opus-exact-1', 'claude-sonnet-exact-1'],
      runtimeVersion: 'claude-code-2.1.0',
      safetyRevision: 'guardian-watchdog-v18',
      note: 'Real-host observation matched the promoted evaluation identity.',
    }, 'Matching runtime identity observation.');

    readiness = capabilityReadiness((await registry.get(capability.id))!, new Date('2026-08-12T01:06:00Z'));
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.missingChecks, []);
    assert.deepEqual(readiness.staleReasons, []);

    await registry.recordRuntimeObservation(capability.id, {
      observedAt: '2026-08-12T01:10:00Z',
      sourceSha256: SHA_A,
      providerResolvedModelIds: ['claude-sonnet-exact-2', 'claude-opus-exact-1'],
      runtimeVersion: 'claude-code-2.2.0',
      safetyRevision: 'guardian-watchdog-v18',
    }, 'Simulated provider/runtime drift observation.');

    readiness = capabilityReadiness((await registry.get(capability.id))!, new Date('2026-08-12T01:11:00Z'));
    assert.equal(readiness.ready, false);
    assert.match(readiness.staleReasons.join('\n'), /provider-resolved model drift/);
    assert.match(readiness.staleReasons.join('\n'), /runtime version drift/);
    assert.ok(readiness.invalidations.some((line) => line.includes('RUNTIME_DRIFT')));
    const driftedStored = await registry.get(capability.id);
    assert.deepEqual(driftedStored?.passedChecks, ['PACKAGED'], 'Observed model/runtime drift must latch by clearing dependent checks until they are re-verified.');
    await assert.rejects(() => registry.assertReady([capability.id]), /missing checks: DISCOVERED, ROUTING_VERIFIED, RUNTIME_WIRED, SAFETY_VERIFIED/);

    const driftHistory = readiness.invalidations.slice();
    const beforeRoutineUpsert = await registry.get(capability.id);
    assert.ok(beforeRoutineUpsert);
    await registry.upsert({
      id: capability.id,
      kind: 'SKILL',
      description: 'Intelligence Foundation bound to exact package/model/runtime evidence.',
      source: 'nexus-intelligence-foundation-v1.0.0.zip',
      version: '1.0.0',
      requiredChecks: beforeRoutineUpsert!.requiredChecks,
      passedChecks: beforeRoutineUpsert!.passedChecks,
      enabled: beforeRoutineUpsert!.enabled,
      evidence: beforeRoutineUpsert!.evidence,
      evidenceBinding: beforeRoutineUpsert!.evidenceBinding,
      readinessPolicy: beforeRoutineUpsert!.readinessPolicy,
      lastRuntimeObservation: beforeRoutineUpsert!.lastRuntimeObservation,
    });
    const afterRoutineUpsert = await registry.get(capability.id);
    assert.deepEqual(afterRoutineUpsert!.invalidations, driftHistory, 'Routine upsert must preserve prior invalidation/audit history.');

    await registry.bindEvidence(capability.id, {
      sourceSha256: SHA_A,
      evaluationRevision: 'intelligence-v1/eval-2026-08-12-r2',
      evaluatedAt: '2026-08-12T02:00:00Z',
      evaluatedModelIds: ['claude-sonnet-exact-2', 'claude-opus-exact-1'],
      providerResolvedModelIds: ['claude-sonnet-exact-2', 'claude-opus-exact-1'],
      runtimeVersion: 'claude-code-2.2.0',
      safetyRevision: 'guardian-watchdog-v18',
      rollbackTarget: 'intelligence-v1-last-known-good',
    }, 'New model/runtime candidate evaluation identity recorded.');

    let stored = await registry.get(capability.id);
    assert.ok(stored);
    assert.deepEqual(stored!.passedChecks, ['PACKAGED'], 'Model/runtime/evaluation identity changes must leave dependent checks invalidated.');

    await registry.recordRuntimeObservation(capability.id, {
      observedAt: '2026-08-12T02:05:00Z',
      sourceSha256: SHA_A,
      providerResolvedModelIds: ['claude-sonnet-exact-2', 'claude-opus-exact-1'],
      runtimeVersion: 'claude-code-2.2.0',
      safetyRevision: 'guardian-watchdog-v18',
    }, 'Matching observation for new candidate identity.');
    await registry.recordCheck(capability.id, 'DISCOVERED', 'Fresh host discovery rerun passed.');
    await registry.recordCheck(capability.id, 'ROUTING_VERIFIED', 'Fresh Sonnet/Opus routing evaluation rerun passed.');
    await registry.recordCheck(capability.id, 'RUNTIME_WIRED', 'Real runtime wiring verified.');
    await registry.recordCheck(capability.id, 'SAFETY_VERIFIED', 'Guardian/Watchdog/workspace safety rerun passed.');
    assert.equal(capabilityReadiness((await registry.get(capability.id))!, new Date('2026-08-12T02:06:00Z')).ready, true);

    const freshStored = await registry.get(capability.id);
    assert.ok(freshStored);
    const staleObservation = capabilityReadiness(freshStored!, new Date('2026-08-14T03:00:00Z'));
    assert.equal(staleObservation.ready, false);
    assert.match(staleObservation.staleReasons.join('\n'), /runtime observation is older than 48 hour/);
    assert.doesNotMatch(staleObservation.staleReasons.join('\n'), /evaluation evidence is older than 72 hour/);

    await registry.bindEvidence(capability.id, {
      sourceSha256: SHA_B,
      evaluationRevision: 'intelligence-v1/eval-2026-08-12-r3',
      evaluatedAt: '2026-08-12T03:00:00Z',
      expiresAt: '2026-08-13T03:00:00Z',
      evaluatedModelIds: ['claude-sonnet-exact-2', 'claude-opus-exact-1'],
      providerResolvedModelIds: ['claude-sonnet-exact-2', 'claude-opus-exact-1'],
      runtimeVersion: 'claude-code-2.2.0',
      safetyRevision: 'guardian-watchdog-v18',
      rollbackTarget: 'intelligence-v1-last-known-good',
    }, 'Simulated package replacement candidate.');

    stored = await registry.get(capability.id);
    assert.ok(stored);
    assert.deepEqual(stored!.passedChecks, [], 'Package checksum changes must clear every required readiness check.');

    const expiryCandidate = {
      ...stored!,
      passedChecks: stored!.requiredChecks.slice(),
      lastRuntimeObservation: {
        observedAt: '2026-08-12T03:05:00Z',
        sourceSha256: SHA_B,
        providerResolvedModelIds: ['claude-sonnet-exact-2', 'claude-opus-exact-1'],
        runtimeVersion: 'claude-code-2.2.0',
        safetyRevision: 'guardian-watchdog-v18',
      },
    };
    const expired = capabilityReadiness(expiryCandidate, new Date('2026-08-13T03:00:01Z'));
    assert.equal(expired.ready, false);
    assert.match(expired.staleReasons.join('\n'), /evidence expired/);

    await registry.invalidateChecks(capability.id, ['ROUTING_VERIFIED'], 'Operator revoked routing evidence after a collision regression.');
    stored = await registry.get(capability.id);
    assert.ok(stored?.invalidations?.some((line) => line.includes('MANUAL_INVALIDATION')));

    console.log('PASS capability evidence drift: legacy compatibility, immutable capability kind, state-preserving upsert, required-check/policy-change invalidation, typed evidence requirements, latched runtime drift, durable invalidation history, runtime freshness, binding-change invalidation, expiry and manual revocation fail closed.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
