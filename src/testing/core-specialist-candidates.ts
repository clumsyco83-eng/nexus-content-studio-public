import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry, capabilityReadiness } from '../capabilities/registry.js';
import {
  applyCoreSpecialistCandidates,
  CORE_SPECIALIST_CAPABILITY_APPLY_OPT_IN,
  CORE_SPECIALIST_NAMES,
  previewCoreSpecialistCandidates,
} from '../capabilities/core-specialist-candidates.js';
import { JsonFileStore } from '../storage/store.js';

const hashes = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => letter.repeat(64));

function manifest() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-13T00:00:00Z',
    sourceRoot: 'C:\\NEXUS-WORK\\nexus-godmode-studio\\plugins\\nexus-godmode-studio\\skills',
    candidates: CORE_SPECIALIST_NAMES.map((name, index) => ({
      name,
      source: `C:\\NEXUS-WORK\\nexus-godmode-studio\\plugins\\nexus-godmode-studio\\skills\\${name}`,
      sourceSha256: hashes[index]!,
      version: `candidate-${hashes[index]!.slice(0, 12)}`,
    })),
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-core-specialist-candidates-'));
  try {
    const file = path.join(root, 'nexus.json');
    const store = new JsonFileStore(file);
    const preview = await previewCoreSpecialistCandidates(store, manifest());
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.items.length, 6);
    assert.ok(preview.items.every((item) => item.action === 'CREATE_NOT_READY' && !item.existingReady));
    const before = await store.load();
    assert.equal(before.capabilities.length, 0, 'Preview must not mutate durable capability state.');

    await assert.rejects(
      () => applyCoreSpecialistCandidates(store, manifest(), { env: {} }),
      /Apply mode is disabled/,
    );

    const applied = await applyCoreSpecialistCandidates(store, manifest(), {
      backupDir: path.join(root, 'backups'),
      env: { NEXUS_CORE_SPECIALIST_CAPABILITY_APPLY: CORE_SPECIALIST_CAPABILITY_APPLY_OPT_IN },
    });
    assert.equal(applied.mode, 'apply');
    assert.ok(applied.backupPath);

    const registry = new CapabilityRegistry(store);
    for (let index = 0; index < CORE_SPECIALIST_NAMES.length; index += 1) {
      const name = CORE_SPECIALIST_NAMES[index]!;
      const capability = await registry.get(`skill:${name}`);
      assert.ok(capability, `Missing registered candidate ${name}`);
      assert.equal(capability?.kind, 'SKILL');
      assert.deepEqual(capability?.passedChecks, ['PACKAGED']);
      assert.equal(capability?.evidenceBinding?.sourceSha256, hashes[index]);
      const readiness = capabilityReadiness(capability!);
      assert.equal(readiness.ready, false, `${name} must not become READY from candidate registration.`);
      assert.ok(readiness.missingChecks.includes('DISCOVERED'));
      assert.ok(readiness.missingChecks.includes('ROUTING_VERIFIED'));
      assert.ok(readiness.missingChecks.includes('SAFETY_VERIFIED'));
      assert.ok(readiness.staleReasons.some((reason) => reason.includes('evaluation revision')));
      assert.ok(readiness.staleReasons.some((reason) => reason.includes('runtime version')));
    }

    const repeatPreview = await previewCoreSpecialistCandidates(store, manifest());
    assert.ok(repeatPreview.items.every((item) => item.action === 'KEEP_EXISTING'));

    const conflict = manifest();
    conflict.candidates[0]!.sourceSha256 = '9'.repeat(64);
    await assert.rejects(() => previewCoreSpecialistCandidates(store, conflict), /source SHA-256 differs/);

    const wrongKindStore = new JsonFileStore(path.join(root, 'wrong-kind.json'));
    const wrongRegistry = new CapabilityRegistry(wrongKindStore);
    await wrongRegistry.upsert({
      id: `skill:${CORE_SPECIALIST_NAMES[0]}`,
      kind: 'RUNTIME',
      description: 'Wrong-kind fixture.',
      version: '1',
      requiredChecks: ['SAFETY_VERIFIED'],
      passedChecks: [],
    });
    await assert.rejects(() => previewCoreSpecialistCandidates(wrongKindStore, manifest()), /expected SKILL/);

    const weakExistingStore = new JsonFileStore(path.join(root, 'weak-existing.json'));
    const weakRegistry = new CapabilityRegistry(weakExistingStore);
    await weakRegistry.upsert({
      id: `skill:${CORE_SPECIALIST_NAMES[0]}`,
      kind: 'SKILL',
      description: 'Existing skill without source evidence.',
      version: 'legacy',
      requiredChecks: ['PACKAGED'],
      passedChecks: ['PACKAGED'],
    });
    await assert.rejects(() => previewCoreSpecialistCandidates(weakExistingStore, manifest()), /has no source SHA-256/);

    const duplicate = manifest();
    duplicate.candidates[5]!.name = duplicate.candidates[0]!.name;
    await assert.rejects(() => previewCoreSpecialistCandidates(new JsonFileStore(path.join(root, 'dup.json')), duplicate), /duplicate|missing/i);

    console.log('PASS core specialist candidate registration: preview is read-only, apply requires explicit opt-in, six exact SKILL capabilities remain NOT READY, existing evidence is preserved, and source/kind/duplicate conflicts fail closed.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
