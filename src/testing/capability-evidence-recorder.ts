import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITY_EVIDENCE_APPLY_OPT_IN,
  applyCapabilityEvidenceManifest,
  parseCapabilityEvidenceManifest,
  previewCapabilityEvidenceManifest,
  requireCapabilityEvidenceApplyOptIn,
} from '../capabilities/evidence-recorder.js';
import { JsonFileStore, emptyDatabase, type NexusDatabase, type NexusStore, type StoreDescription } from '../storage/store.js';

const SHA = 'a'.repeat(64);
const applyEnv = { NEXUS_CAPABILITY_EVIDENCE_APPLY: CAPABILITY_EVIDENCE_APPLY_OPT_IN };

function fullManifest() {
  return {
    schemaVersion: 1,
    capability: {
      id: 'claude:intelligence-foundation-v1',
      kind: 'SKILL',
      description: 'Live Intelligence Foundation readiness evidence.',
      source: 'nexus-intelligence-foundation-v1.0.0.zip',
      version: '1.0.0',
      requiredChecks: ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      readinessPolicy: {
        requireSourceSha256: true,
        requireEvaluationRevision: true,
        requireExactModelIdentity: true,
        requireRuntimeVersion: true,
        requireSafetyRevision: true,
        requireRollbackTarget: true,
        requireRuntimeObservation: true,
      },
    },
    binding: {
      sourceSha256: SHA,
      evaluationRevision: 'intelligence-foundation/eval-2026-08-12',
      evaluatedAt: '2026-08-12T00:00:00Z',
      evaluatedModelIds: ['claude-sonnet-exact-1', 'claude-opus-exact-1'],
      providerResolvedModelIds: ['claude-sonnet-exact-1', 'claude-opus-exact-1'],
      runtimeVersion: 'claude-code-verified-1',
      safetyRevision: 'guardian-watchdog-v18',
      rollbackTarget: 'intelligence-foundation-last-known-good',
    },
    runtimeObservation: {
      observedAt: '2026-08-12T00:05:00Z',
      sourceSha256: SHA,
      providerResolvedModelIds: ['claude-opus-exact-1', 'claude-sonnet-exact-1'],
      runtimeVersion: 'claude-code-verified-1',
      safetyRevision: 'guardian-watchdog-v18',
      note: 'Bounded real-host runtime identity matched evaluated evidence.',
    },
    checks: [
      { check: 'PACKAGED', evidence: 'Pinned package checksum verified.' },
      { check: 'DISCOVERED', evidence: 'All intended skills discovered on real host.' },
      { check: 'ROUTING_VERIFIED', evidence: 'Fresh-session Sonnet/Opus routing evaluation passed.' },
      { check: 'RUNTIME_WIRED', evidence: 'Bounded real runtime path verified.' },
      { check: 'SAFETY_VERIFIED', evidence: 'Guardian/Watchdog/workspace safety verification passed.' },
    ],
    note: 'Owner-reviewed readiness evidence manifest.',
  } as const;
}

class FailingStore implements NexusStore {
  private database: NexusDatabase = emptyDatabase();
  private updateCount = 0;

  async load(): Promise<NexusDatabase> { return structuredClone(this.database); }
  async save(database: NexusDatabase): Promise<void> { this.database = structuredClone(database); }
  async update<T>(mutator: (database: NexusDatabase) => T): Promise<T> {
    this.updateCount += 1;
    if (this.updateCount === 2) throw new Error('simulated durable write failure');
    const working = structuredClone(this.database);
    const result = mutator(working);
    this.database = working;
    return result;
  }
  describe(): StoreDescription { return { driver: 'json', location: 'failing-test-store' }; }
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-evidence-recorder-'));
  try {
    const dbPath = path.join(root, 'nexus.json');
    const backupDir = path.join(root, 'backups');
    const store = new JsonFileStore(dbPath);
    const manifest = fullManifest();

    assert.doesNotThrow(() => requireCapabilityEvidenceApplyOptIn(false, {}));
    assert.throws(() => requireCapabilityEvidenceApplyOptIn(true, {}), /Apply mode is disabled/);
    assert.doesNotThrow(() => requireCapabilityEvidenceApplyOptIn(true, applyEnv));

    assert.throws(
      () => parseCapabilityEvidenceManifest({ ...manifest, note: 'OPENAI_API_KEY=do-not-store-this' }),
      /forbidden named secret assignment/,
    );
    assert.throws(
      () => parseCapabilityEvidenceManifest({ ...manifest, apiKey: 'not-allowed' }),
      /forbidden credential field/,
    );
    assert.throws(
      () => parseCapabilityEvidenceManifest({ ...manifest, harmlessUnknownField: true }),
      /Unrecognized key/,
    );
    assert.throws(
      () => parseCapabilityEvidenceManifest({ ...manifest, note: 'REPLACE_WITH_REAL_HOST_EVIDENCE' }),
      /unresolved REPLACE_WITH placeholder/,
    );
    assert.throws(
      () => parseCapabilityEvidenceManifest({
        ...manifest,
        checks: [manifest.checks[0], manifest.checks[0], manifest.checks[2], manifest.checks[3], manifest.checks[4]],
      }),
      /duplicate check evidence/,
    );

    const preview = await previewCapabilityEvidenceManifest(store, manifest);
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.mutationAttempted, false);
    assert.equal(preview.beforeExists, false);
    assert.equal(preview.after.ready, true);
    assert.equal((await store.load()).capabilities.length, 0, 'Preview must not mutate durable state.');

    const incomplete = {
      ...manifest,
      checks: manifest.checks.filter((item) => item.check !== 'SAFETY_VERIFIED'),
    };
    const incompletePreview = await previewCapabilityEvidenceManifest(store, incomplete);
    assert.equal(incompletePreview.after.ready, false);
    assert.deepEqual(incompletePreview.after.missingChecks, ['SAFETY_VERIFIED']);
    assert.equal((await store.load()).capabilities.length, 0, 'Incomplete preview must remain read-only.');

    const futureEvidence = {
      ...manifest,
      binding: { ...manifest.binding, evaluatedAt: '2099-01-01T00:00:00Z' },
      runtimeObservation: { ...manifest.runtimeObservation, observedAt: '2099-01-01T00:05:00Z' },
    };
    const futurePreview = await previewCapabilityEvidenceManifest(store, futureEvidence);
    assert.equal(futurePreview.after.ready, false);
    assert.match(futurePreview.after.staleReasons.join('\n'), /evaluation timestamp is in the future/);
    assert.match(futurePreview.after.staleReasons.join('\n'), /runtime observation timestamp is in the future/);

    const predatingObservation = {
      ...manifest,
      binding: { ...manifest.binding, evaluatedAt: '2026-08-12T01:00:00Z' },
      runtimeObservation: { ...manifest.runtimeObservation, observedAt: '2026-08-12T00:05:00Z' },
    };
    const predatingPreview = await previewCapabilityEvidenceManifest(store, predatingObservation);
    assert.equal(predatingPreview.after.ready, false);
    assert.match(predatingPreview.after.staleReasons.join('\n'), /runtime observation predates the current evaluation evidence/);

    await assert.rejects(
      () => applyCapabilityEvidenceManifest(store, manifest, { backupDir, env: {} }),
      /Apply mode is disabled/,
    );
    assert.equal((await store.load()).capabilities.length, 0, 'Core apply without opt-in must not mutate durable state.');

    const applied = await applyCapabilityEvidenceManifest(store, manifest, { backupDir, env: applyEnv });
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.mutationAttempted, true);
    assert.equal(applied.after.ready, true);
    assert.ok(applied.backupPath);
    await access(applied.backupPath!);
    const backup = JSON.parse(await readFile(applied.backupPath!, 'utf8')) as NexusDatabase;
    assert.equal(backup.capabilities.length, 0, 'Backup must capture pre-apply state.');
    assert.equal((await store.load()).capabilities.length, 1);

    const appliedAgain = await applyCapabilityEvidenceManifest(store, manifest, { backupDir, env: applyEnv });
    assert.equal(appliedAgain.after.ready, true, 'Reapplying the same manifest should be idempotent for readiness.');

    const existing = await store.load();
    existing.capabilities[0]!.invalidations = ['2026-08-12T00:10:00Z MANUAL_INVALIDATION: SAFETY_VERIFIED — Bearer abcdefghijklmnopqrstuvwxyz'];
    await store.save(existing);
    const sanitizedPreview = await previewCapabilityEvidenceManifest(store, manifest);
    assert.match(sanitizedPreview.before.recentInvalidations[0] ?? '', /^\[REDACTED Bearer credential\]$/);

    const kindConflict = {
      ...manifest,
      capability: { ...manifest.capability, kind: 'RUNTIME' as const },
    };
    await assert.rejects(() => previewCapabilityEvidenceManifest(store, kindConflict), /kind is immutable/);

    const failingStore = new FailingStore();
    await assert.rejects(
      () => applyCapabilityEvidenceManifest(failingStore, manifest, {
        backupDir: path.join(root, 'failure-backups'),
        env: applyEnv,
      }),
      /pre-apply NEXUS state was restored/,
    );
    assert.equal((await failingStore.load()).capabilities.length, 0, 'Unexpected apply failure must restore pre-apply state.');

    console.log('PASS capability evidence recorder: strict secret-free/non-placeholder manifests, preview-only default, core + CLI apply opt-in, temporal evidence ordering, pre-apply backup, READY/not-READY outcomes, sanitized output, kind preflight and automatic rollback verified.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
