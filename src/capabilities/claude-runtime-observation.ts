import { parseClaudeStreamJson, assertClaudeCodeVersion } from '../claude/runtime-evidence.js';
import { CapabilityRegistry, capabilityReadiness } from './registry.js';
import { writeCapabilityEvidenceBackup } from './evidence-recorder.js';
import { buildClaudeRuntimeObservation, type BuiltRuntimeObservation } from './claude-runtime-observation-policy.js';
import type { CapabilityReadiness, StoredCapability } from './schema.js';
import type { NexusDatabase, NexusStore, StoreDescription } from '../storage/store.js';

export const CLAUDE_RUNTIME_OBSERVATION_APPLY_OPT_IN = 'I_ACKNOWLEDGE_CLAUDE_RUNTIME_OBSERVATION_MUTATION';
export const CLAUDE_RUNTIME_OBSERVATION_EVIDENCE_MAX_AGE_MS = 10 * 60 * 1_000;

export interface ClaudeRuntimeObservationRefreshInput {
  capabilityId: string;
  streamJson: string;
  expectedResolvedModel: string;
  expectedClaudeCodeVersion: string;
  actualClaudeCodeVersion: string;
  expectedCwd: string;
  maxCostUsd: number;
  observedAt: string;
}

export interface ClaudeRuntimeObservationRefreshSummary {
  mode: 'preview' | 'apply';
  capabilityId: string;
  storage: StoreDescription;
  backupPath?: string;
  before: Pick<CapabilityReadiness, 'ready' | 'enabled' | 'missingChecks' | 'staleReasons'>;
  after: Pick<CapabilityReadiness, 'ready' | 'enabled' | 'missingChecks' | 'staleReasons'>;
  observedAt: string;
  resolvedModel: string;
  runtimeVersion: string;
  bindingPreserved: boolean;
  readinessPolicyPreserved: boolean;
  requiredChecksPreserved: boolean;
  passedChecksPreserved: boolean;
  invalidationsPreserved: boolean;
  mutationAttempted: boolean;
}

interface PreparedRefresh {
  beforeDatabase: NexusDatabase;
  beforeCapability: StoredCapability;
  beforeReadiness: CapabilityReadiness;
  observation: BuiltRuntimeObservation;
  resolvedModel: string;
  runtimeVersion: string;
}

class MemoryStore implements NexusStore {
  constructor(private database: NexusDatabase, private readonly description: StoreDescription) {}
  async load(): Promise<NexusDatabase> { return structuredClone(this.database); }
  async save(database: NexusDatabase): Promise<void> { this.database = structuredClone(database); }
  async update<T>(mutator: (database: NexusDatabase) => T): Promise<T> {
    const working = structuredClone(this.database);
    const result = mutator(working);
    this.database = working;
    return result;
  }
  describe(): StoreDescription { return this.description; }
}

function summaryReadiness(readiness: CapabilityReadiness): ClaudeRuntimeObservationRefreshSummary['before'] {
  return {
    ready: readiness.ready,
    enabled: readiness.enabled,
    missingChecks: readiness.missingChecks.slice(),
    staleReasons: readiness.staleReasons.slice(),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetCapability(database: NexusDatabase, id: string): StoredCapability {
  const capability = database.capabilities.find((item) => item.id === id);
  if (!capability) throw new Error(`Unknown capability: ${id}`);
  return capability;
}

function assertOnlyRuntimeObservationMutation(beforeDatabase: NexusDatabase, afterDatabase: NexusDatabase, capabilityId: string): void {
  const before = targetCapability(beforeDatabase, capabilityId);
  const after = targetCapability(afterDatabase, capabilityId);
  const beforeOthers = { ...beforeDatabase, capabilities: beforeDatabase.capabilities.filter((item) => item.id !== capabilityId) };
  const afterOthers = { ...afterDatabase, capabilities: afterDatabase.capabilities.filter((item) => item.id !== capabilityId) };
  if (!sameJson(beforeOthers, afterOthers)) throw new Error('Runtime observation mutation changed durable state outside the target capability.');

  const stripAllowed = (capability: StoredCapability) => {
    const clone = structuredClone(capability) as StoredCapability;
    delete clone.lastRuntimeObservation;
    clone.updatedAt = '';
    clone.evidence = [];
    return clone;
  };
  if (!sameJson(stripAllowed(before), stripAllowed(after))) {
    throw new Error('Runtime observation mutation changed protected capability fields beyond observation/audit metadata.');
  }
  if (!sameJson(before.evidenceBinding, after.evidenceBinding)) throw new Error('Runtime observation mutation changed the evaluated evidence binding.');
  if (!sameJson(before.readinessPolicy, after.readinessPolicy)) throw new Error('Runtime observation mutation changed the readiness policy.');
  if (!sameJson(before.requiredChecks, after.requiredChecks)) throw new Error('Runtime observation mutation changed required readiness checks.');
  if (!sameJson(before.passedChecks, after.passedChecks)) throw new Error('Runtime observation mutation changed passed readiness checks.');
  if (!sameJson(before.invalidations ?? [], after.invalidations ?? [])) throw new Error('Runtime observation mutation added or changed invalidations.');
  if (!before.evidence.every((line) => after.evidence.includes(line))) throw new Error('Runtime observation mutation removed existing audit evidence.');
  if (after.evidence.length > before.evidence.length + 1) throw new Error('Runtime observation mutation added unexpected audit evidence.');
}

function requireFinitePositiveCost(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 0.5) {
    throw new Error('Claude runtime observation maxCostUsd must be > 0 and <= $0.50.');
  }
}

export function requireClaudeRuntimeObservationApplyOptIn(apply: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (!apply) return;
  if (env.NEXUS_CLAUDE_RUNTIME_OBSERVATION_APPLY !== CLAUDE_RUNTIME_OBSERVATION_APPLY_OPT_IN) {
    throw new Error(
      `Apply mode is disabled. Set NEXUS_CLAUDE_RUNTIME_OBSERVATION_APPLY=${CLAUDE_RUNTIME_OBSERVATION_APPLY_OPT_IN} only for one deliberate fresh-smoke runtime-observation mutation.`,
    );
  }
}

async function prepareRefresh(store: NexusStore, input: ClaudeRuntimeObservationRefreshInput): Promise<PreparedRefresh> {
  requireFinitePositiveCost(input.maxCostUsd);
  assertClaudeCodeVersion(input.actualClaudeCodeVersion, input.expectedClaudeCodeVersion);
  const runtime = parseClaudeStreamJson(input.streamJson, {
    expectedResolvedModel: input.expectedResolvedModel,
    maxTurns: 1,
    maxCostUsd: input.maxCostUsd,
    allowedPermissionModes: ['plan'],
    expectedCwd: input.expectedCwd,
  });

  const beforeDatabase = await store.load();
  const beforeCapability = targetCapability(beforeDatabase, input.capabilityId);
  const beforeReadiness = capabilityReadiness(beforeCapability);
  const observation = buildClaudeRuntimeObservation({
    capability: beforeCapability,
    readiness: beforeReadiness,
    smoke: runtime,
    expectedResolvedModel: input.expectedResolvedModel,
    expectedRuntimeVersion: input.expectedClaudeCodeVersion,
    actualRuntimeVersion: input.actualClaudeCodeVersion,
    expectedCwd: input.expectedCwd,
    observedAt: input.observedAt,
  });
  return {
    beforeDatabase,
    beforeCapability,
    beforeReadiness,
    observation,
    resolvedModel: runtime.resolvedModel,
    runtimeVersion: input.actualClaudeCodeVersion.trim(),
  };
}

async function previewPrepared(store: NexusStore, prepared: PreparedRefresh): Promise<{ afterDatabase: NexusDatabase; afterCapability: StoredCapability; afterReadiness: CapabilityReadiness }> {
  const memoryStore = new MemoryStore(structuredClone(prepared.beforeDatabase), {
    driver: store.describe().driver,
    location: 'memory-runtime-observation-preview',
  });
  const registry = new CapabilityRegistry(memoryStore);
  await registry.recordRuntimeObservation(
    prepared.beforeCapability.id,
    prepared.observation,
    'Fresh bounded Claude smoke matched the existing evaluated runtime/model binding.',
  );
  const afterDatabase = await memoryStore.load();
  const afterCapability = targetCapability(afterDatabase, prepared.beforeCapability.id);
  const afterReadiness = capabilityReadiness(afterCapability);
  assertOnlyRuntimeObservationMutation(prepared.beforeDatabase, afterDatabase, prepared.beforeCapability.id);
  if (!afterReadiness.ready) {
    throw new Error(`Fresh runtime observation would not restore READY: ${afterReadiness.staleReasons.join('; ') || afterReadiness.missingChecks.join(', ') || 'unknown readiness failure'}.`);
  }
  return { afterDatabase, afterCapability, afterReadiness };
}

export async function previewClaudeRuntimeObservationRefresh(
  store: NexusStore,
  input: ClaudeRuntimeObservationRefreshInput,
): Promise<ClaudeRuntimeObservationRefreshSummary> {
  const prepared = await prepareRefresh(store, input);
  const projected = await previewPrepared(store, prepared);
  return {
    mode: 'preview',
    capabilityId: input.capabilityId,
    storage: store.describe(),
    before: summaryReadiness(prepared.beforeReadiness),
    after: summaryReadiness(projected.afterReadiness),
    observedAt: prepared.observation.observedAt,
    resolvedModel: prepared.resolvedModel,
    runtimeVersion: prepared.runtimeVersion,
    bindingPreserved: sameJson(prepared.beforeCapability.evidenceBinding, projected.afterCapability.evidenceBinding),
    readinessPolicyPreserved: sameJson(prepared.beforeCapability.readinessPolicy, projected.afterCapability.readinessPolicy),
    requiredChecksPreserved: sameJson(prepared.beforeCapability.requiredChecks, projected.afterCapability.requiredChecks),
    passedChecksPreserved: sameJson(prepared.beforeCapability.passedChecks, projected.afterCapability.passedChecks),
    invalidationsPreserved: sameJson(prepared.beforeCapability.invalidations ?? [], projected.afterCapability.invalidations ?? []),
    mutationAttempted: false,
  };
}

export async function applyClaudeRuntimeObservationRefresh(
  store: NexusStore,
  input: ClaudeRuntimeObservationRefreshInput,
  options: { backupDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeRuntimeObservationRefreshSummary> {
  requireClaudeRuntimeObservationApplyOptIn(true, options.env ?? process.env);
  const prepared = await prepareRefresh(store, input);
  await previewPrepared(store, prepared);
  const backupPath = await writeCapabilityEvidenceBackup(prepared.beforeDatabase, input.capabilityId, options.backupDir);

  let afterDatabase: NexusDatabase;
  try {
    await new CapabilityRegistry(store).recordRuntimeObservation(
      input.capabilityId,
      prepared.observation,
      'Fresh bounded Claude smoke matched the existing evaluated runtime/model binding.',
    );
    afterDatabase = await store.load();
    assertOnlyRuntimeObservationMutation(prepared.beforeDatabase, afterDatabase, input.capabilityId);
    const afterReadiness = capabilityReadiness(targetCapability(afterDatabase, input.capabilityId));
    if (!afterReadiness.ready) throw new Error(`Applied runtime observation did not restore READY: ${afterReadiness.staleReasons.join('; ') || afterReadiness.missingChecks.join(', ')}.`);
  } catch (error) {
    try {
      await store.save(prepared.beforeDatabase);
    } catch (restoreError) {
      throw new Error(
        `Claude runtime observation apply failed and automatic restore also failed. Backup retained at ${backupPath}. ` +
        `Apply error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}.`,
      );
    }
    throw new Error(
      `Claude runtime observation apply failed; pre-apply NEXUS state was restored. Backup retained at ${backupPath}. ` +
      `Original error: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const afterCapability = targetCapability(afterDatabase, input.capabilityId);
  const afterReadiness = capabilityReadiness(afterCapability);
  return {
    mode: 'apply',
    capabilityId: input.capabilityId,
    storage: store.describe(),
    backupPath,
    before: summaryReadiness(prepared.beforeReadiness),
    after: summaryReadiness(afterReadiness),
    observedAt: prepared.observation.observedAt,
    resolvedModel: prepared.resolvedModel,
    runtimeVersion: prepared.runtimeVersion,
    bindingPreserved: sameJson(prepared.beforeCapability.evidenceBinding, afterCapability.evidenceBinding),
    readinessPolicyPreserved: sameJson(prepared.beforeCapability.readinessPolicy, afterCapability.readinessPolicy),
    requiredChecksPreserved: sameJson(prepared.beforeCapability.requiredChecks, afterCapability.requiredChecks),
    passedChecksPreserved: sameJson(prepared.beforeCapability.passedChecks, afterCapability.passedChecks),
    invalidationsPreserved: sameJson(prepared.beforeCapability.invalidations ?? [], afterCapability.invalidations ?? []),
    mutationAttempted: true,
  };
}
