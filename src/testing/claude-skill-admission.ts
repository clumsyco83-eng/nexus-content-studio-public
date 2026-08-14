import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { compileCapabilityBoundClaudeEnvelope, resolveClaudeSkillAdmission } from '../claude/skill-admission.js';
import { GoalAttemptObservationRepository } from '../goals/attempt-observations.js';
import { GoalRepository } from '../goals/repository.js';
import { JsonFileStore } from '../storage/store.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const projectRoot = path.resolve('C:\\NEXUS-WORK\\nexus-content-studio');
const requiredChecks = ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'SAFETY_VERIFIED'] as const;

function binding(sourceSha256: string, revision: string, evaluatedAt = '2026-08-12T00:00:00Z') {
  return {
    sourceSha256,
    evaluationRevision: revision,
    evaluatedAt,
    evaluatedModelIds: ['claude-opus-exact-1', 'claude-sonnet-exact-1'],
    providerResolvedModelIds: ['claude-sonnet-exact-1', 'claude-opus-exact-1'],
    runtimeVersion: 'claude-code-2.1.0',
    safetyRevision: 'guardian-watchdog-envelope-v1',
    rollbackTarget: 'skills-v1-last-known-good',
  };
}

const readinessPolicy = {
  requireSourceSha256: true,
  requireEvaluationRevision: true,
  requireExactModelIdentity: true,
  requireRuntimeVersion: true,
  requireSafetyRevision: true,
  requireRollbackTarget: true,
  requireRuntimeObservation: false,
};

function baseEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'task:research-with-one-skill',
    permissionMode: 'dontAsk',
    availableBuiltInTools: ['Read'],
    allowedWithoutPrompt: ['Read'],
    deniedRules: [],
    maxTurns: 12,
    maxBudgetUsd: 0.2,
    noSessionPersistence: true,
    strictMcpConfig: true,
    disableChrome: true,
  };
}

async function createReadySkill(
  registry: CapabilityRegistry,
  skillName: string,
  capabilityId: string,
  sourceSha256 = SHA_A,
  revision = 'skill-eval-v1',
): Promise<void> {
  await registry.upsert({
    id: capabilityId,
    kind: 'SKILL',
    description: `${skillName} reviewed Claude project skill.`,
    source: 'validated-skill-pack.zip',
    version: '1.0.0',
    requiredChecks: [...requiredChecks],
    passedChecks: [...requiredChecks],
    evidenceBinding: binding(sourceSha256, revision),
    readinessPolicy,
  });
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-claude-skill-admission-'));
  try {
    const databaseFile = path.join(root, 'nexus.json');
    const store = new JsonFileStore(databaseFile);
    const registry = new CapabilityRegistry(store);
    await createReadySkill(registry, 'deep-research', 'skill:deep-research');
    await createReadySkill(registry, 'source-verification', 'skill:source-verification', SHA_B, 'source-verify-eval-v1');

    const one = await compileCapabilityBoundClaudeEnvelope(registry, projectRoot, baseEnvelope(), {
      requestedSkills: ['deep-research'],
      declaredTaskSkills: ['deep-research'],
      bindings: [{ skillName: 'deep-research', capabilityId: 'skill:deep-research' }],
    });
    assert.deepEqual(one.admittedSkills, ['deep-research']);
    assert.deepEqual(one.skillAdmission.capabilityIds, ['skill:deep-research']);
    assert.equal(one.skillSetHash.length, 64);
    assert.equal(one.skillSetHash, one.skillAdmission.skillAdmissionHash);
    assert.ok(one.expectedRuntimeTools.includes('Skill'));
    assert.ok(one.cliArgs.includes('Skill(deep-research)'));
    assert.equal(one.skillAdmission.evidence[0]?.sourceSha256, SHA_A);
    assert.equal(one.skillAdmission.evidence[0]?.runtimeVersion, 'claude-code-2.1.0');

    const none = await compileCapabilityBoundClaudeEnvelope(registry, projectRoot, { ...baseEnvelope(), id: 'task:no-skill' }, {
      requestedSkills: [], declaredTaskSkills: [], bindings: [],
    });
    assert.deepEqual(none.admittedSkills, []);
    assert.equal(none.expectedRuntimeTools.includes('Skill'), false);
    assert.ok(none.cliArgs.includes('Skill'), 'No-skill task must carry a Skill deny rule.');

    await assert.rejects(
      () => resolveClaudeSkillAdmission(registry, {
        requestedSkills: ['source-verification'],
        declaredTaskSkills: ['deep-research'],
        bindings: [{ skillName: 'source-verification', capabilityId: 'skill:source-verification' }],
      }),
      /not declared by the Goal Contract/,
    );

    await assert.rejects(
      () => resolveClaudeSkillAdmission(registry, {
        requestedSkills: ['deep-research'], declaredTaskSkills: ['deep-research'], bindings: [],
      }),
      /no registered capability binding/,
    );

    await registry.upsert({
      id: 'runtime:not-a-skill',
      kind: 'RUNTIME',
      description: 'Wrong-kind fixture.',
      version: '1.0.0',
      requiredChecks: ['SAFETY_VERIFIED'],
      passedChecks: ['SAFETY_VERIFIED'],
    });
    await assert.rejects(
      () => resolveClaudeSkillAdmission(registry, {
        requestedSkills: ['deep-research'], declaredTaskSkills: ['deep-research'],
        bindings: [{ skillName: 'deep-research', capabilityId: 'runtime:not-a-skill' }],
      }),
      /must bind to a SKILL capability/,
    );

    await registry.upsert({
      id: 'skill:legacy-weak',
      kind: 'SKILL',
      description: 'Legacy green checks without production evidence must not be admitted.',
      version: '1.0.0',
      requiredChecks: [...requiredChecks],
      passedChecks: [...requiredChecks],
    });
    await assert.rejects(
      () => resolveClaudeSkillAdmission(registry, {
        requestedSkills: ['knowledge-intelligence'], declaredTaskSkills: ['knowledge-intelligence'],
        bindings: [{ skillName: 'knowledge-intelligence', capabilityId: 'skill:legacy-weak' }],
      }),
      /missing required production evidence binding/,
    );

    await registry.invalidateChecks('skill:deep-research', ['ROUTING_VERIFIED'], 'Collision regression fixture.');
    await assert.rejects(
      () => resolveClaudeSkillAdmission(registry, {
        requestedSkills: ['deep-research'], declaredTaskSkills: ['deep-research'],
        bindings: [{ skillName: 'deep-research', capabilityId: 'skill:deep-research' }],
      }),
      /not READY.*missing checks: ROUTING_VERIFIED/,
    );
    await registry.recordCheck('skill:deep-research', 'ROUTING_VERIFIED', 'Fresh routing regression passed.');

    const restored = await compileCapabilityBoundClaudeEnvelope(registry, projectRoot, baseEnvelope(), {
      requestedSkills: ['deep-research'], declaredTaskSkills: ['deep-research'],
      bindings: [{ skillName: 'deep-research', capabilityId: 'skill:deep-research' }],
    });
    assert.equal(restored.skillSetHash, one.skillSetHash, 'Re-verifying the same bound evidence should restore the same skill authority identity.');

    await registry.bindEvidence('skill:deep-research', binding(SHA_A, 'skill-eval-v2', '2026-08-12T02:00:00Z'), 'Fresh evaluation revision after routing changes.');
    await registry.recordCheck('skill:deep-research', 'DISCOVERED', 'Fresh discovery passed.');
    await registry.recordCheck('skill:deep-research', 'ROUTING_VERIFIED', 'Fresh routing passed.');
    await registry.recordCheck('skill:deep-research', 'SAFETY_VERIFIED', 'Fresh safety suite passed.');

    const reevaluated = await compileCapabilityBoundClaudeEnvelope(registry, projectRoot, baseEnvelope(), {
      requestedSkills: ['deep-research'], declaredTaskSkills: ['deep-research'],
      bindings: [{ skillName: 'deep-research', capabilityId: 'skill:deep-research' }],
    });
    assert.notEqual(reevaluated.skillSetHash, one.skillSetHash, 'Changed evaluation evidence must change the skill authority identity.');
    assert.equal(reevaluated.skillAdmission.evidence[0]?.evaluationRevision, 'skill-eval-v2');

    const multi = await compileCapabilityBoundClaudeEnvelope(registry, projectRoot, { ...baseEnvelope(), id: 'task:multi-skill' }, {
      requestedSkills: ['source-verification', 'deep-research'],
      declaredTaskSkills: ['deep-research', 'source-verification'],
      bindings: [
        { skillName: 'deep-research', capabilityId: 'skill:deep-research' },
        { skillName: 'source-verification', capabilityId: 'skill:source-verification' },
      ],
    });
    assert.deepEqual(multi.admittedSkills, ['deep-research', 'source-verification']);
    assert.ok(multi.cliArgs.includes('Skill(deep-research)'));
    assert.ok(multi.cliArgs.includes('Skill(source-verification)'));

    await assert.rejects(
      () => compileCapabilityBoundClaudeEnvelope(registry, projectRoot, { ...baseEnvelope(), admittedSkills: ['deep-research'] }, {
        requestedSkills: ['deep-research'], declaredTaskSkills: ['deep-research'],
        bindings: [{ skillName: 'deep-research', capabilityId: 'skill:deep-research' }],
      }),
      /may not inject admittedSkills directly/,
    );

    const goals = new GoalRepository(store);
    await goals.createGoal({
      id: 'goal-skill-authority',
      title: 'Persist Claude skill authority',
      objective: 'Prove exact reviewed skill authority survives restart and cannot be rewritten for the same attempt.',
      successCriteria: ['Skill-set hash persists with the task attempt.'],
      priority: 1,
      budget: { maxTokens: 2_000, maxCostUsd: 2, maxTimeMs: 60_000 },
    });
    await goals.transitionGoal('goal-skill-authority', 'WORKING');
    await goals.enqueueTask({
      id: 'task-skill-authority',
      goalId: 'goal-skill-authority',
      title: 'Bound skill attempt',
      intent: 'Persist execution and skill authority identities.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['Authority hashes are durable and conflict-protected.'],
      verificationPlan: ['Reload persisted attempt evidence.'],
      idempotencyKey: 'skill-authority:persistence:v1',
      maxRepairs: 2,
      maxTurns: 12,
      timeLimitMs: 30_000,
      tokenBudget: 1_000,
      costBudgetUsd: 1,
    });

    const attempts = new GoalAttemptObservationRepository(store);
    const persistedAttempt = await attempts.record({
      goalId: 'goal-skill-authority',
      taskId: 'task-skill-authority',
      attemptNumber: 1,
      strategyFingerprint: 'bounded-skill-strategy-v1',
      verificationScore: 1,
      tokensUsed: 100,
      costUsd: 0.01,
      elapsedMs: 500,
      toolEnvelopeHash: reevaluated.envelopeHash,
      skillSetHash: reevaluated.skillSetHash,
    });
    assert.equal(persistedAttempt.skillSetHash, reevaluated.skillSetHash);

    const duplicate = await attempts.record({
      goalId: 'goal-skill-authority',
      taskId: 'task-skill-authority',
      attemptNumber: 1,
      strategyFingerprint: 'bounded-skill-strategy-v1',
      verificationScore: 1,
      tokensUsed: 100,
      costUsd: 0.01,
      elapsedMs: 500,
      toolEnvelopeHash: reevaluated.envelopeHash,
      skillSetHash: reevaluated.skillSetHash.toUpperCase(),
    });
    assert.equal(duplicate.id, persistedAttempt.id, 'SHA case normalization must preserve idempotency.');

    await assert.rejects(
      () => attempts.record({
        goalId: 'goal-skill-authority', taskId: 'task-skill-authority', attemptNumber: 1,
        strategyFingerprint: 'bounded-skill-strategy-v1', verificationScore: 1,
        tokensUsed: 100, costUsd: 0.01, elapsedMs: 500,
        toolEnvelopeHash: reevaluated.envelopeHash, skillSetHash: 'c'.repeat(64),
      }),
      /Attempt observation conflict/,
    );
    await assert.rejects(
      () => attempts.record({
        goalId: 'goal-skill-authority', taskId: 'task-skill-authority', attemptNumber: 2,
        strategyFingerprint: 'bounded-skill-strategy-v2', skillSetHash: 'not-a-hash',
      }),
      /skillSetHash must be a 64-character SHA-256/,
    );

    const reloaded = await new GoalAttemptObservationRepository(new JsonFileStore(databaseFile))
      .listForTask('goal-skill-authority', 'task-skill-authority');
    assert.equal(reloaded[0]?.skillSetHash, reevaluated.skillSetHash, 'Skill authority identity must survive store reload.');

    console.log('PASS Claude skill admission: Goal Contract declaration, READY SKILL capability binding, production evidence requirements, exact Skill(name) authority, stale-skill blocking, evidence-bound skill-set identity and durable attempt conflict protection all fail closed.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
