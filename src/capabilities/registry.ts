import type { NexusStore } from '../storage/store.js';
import {
  capabilityEvidenceBindingSchema,
  capabilityRuntimeObservationSchema,
  upsertCapabilitySchema,
  type CapabilityCheck,
  type CapabilityEvidenceBinding,
  type CapabilityReadiness,
  type CapabilityReadinessPolicy,
  type CapabilityRuntimeObservation,
  type StoredCapability,
  type UpsertCapabilityInput,
} from './schema.js';

function uniqueChecks(checks: CapabilityCheck[]): CapabilityCheck[] {
  return [...new Set(checks)];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueStrings(left).sort();
  const b = uniqueStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCheckSet(left: readonly CapabilityCheck[], right: readonly CapabilityCheck[]): boolean {
  return sameStringSet(left, right);
}

function validDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

interface RuntimeDrift {
  reasons: string[];
  checks: CapabilityCheck[];
}

function runtimeDrift(capability: StoredCapability): RuntimeDrift {
  const binding = capability.evidenceBinding;
  const observation = capability.lastRuntimeObservation;
  if (!binding || !observation) return { reasons: [], checks: [] };

  const reasons: string[] = [];
  const checks = new Set<CapabilityCheck>();
  const add = (targets: CapabilityCheck[]) => targets.forEach((check) => checks.add(check));

  if (binding.sourceSha256 && observation.sourceSha256 && binding.sourceSha256.toLowerCase() !== observation.sourceSha256.toLowerCase()) {
    reasons.push(`source/package SHA-256 drift: observed ${observation.sourceSha256} != evaluated ${binding.sourceSha256}`);
    add(['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED']);
  }
  if (binding.providerResolvedModelIds.length > 0 && observation.providerResolvedModelIds.length > 0 &&
      !sameStringSet(binding.providerResolvedModelIds, observation.providerResolvedModelIds)) {
    reasons.push(`provider-resolved model drift: observed [${observation.providerResolvedModelIds.join(', ')}] != evaluated [${binding.providerResolvedModelIds.join(', ')}]`);
    add(['DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED']);
  }
  if (binding.runtimeVersion && observation.runtimeVersion && binding.runtimeVersion !== observation.runtimeVersion) {
    reasons.push(`runtime version drift: observed ${observation.runtimeVersion} != evaluated ${binding.runtimeVersion}`);
    add(['DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED']);
  }
  if (binding.safetyRevision && observation.safetyRevision && binding.safetyRevision !== observation.safetyRevision) {
    reasons.push(`safety revision drift: observed ${observation.safetyRevision} != evaluated ${binding.safetyRevision}`);
    add(['SAFETY_VERIFIED']);
  }
  return { reasons: uniqueStrings(reasons), checks: [...checks] };
}

function policyStaleReasons(capability: StoredCapability, now: Date): string[] {
  const policy = capability.readinessPolicy;
  if (!policy) return runtimeDrift(capability).reasons;

  const binding = capability.evidenceBinding;
  const observation = capability.lastRuntimeObservation;
  const reasons: string[] = [];
  const evaluatedAt = validDate(binding?.evaluatedAt);
  const observedAt = validDate(observation?.observedAt);

  if (policy.requireSourceSha256 && !binding?.sourceSha256) reasons.push('required source/package SHA-256 evidence is missing');
  if (policy.requireEvaluationRevision && !binding?.evaluationRevision) reasons.push('required evaluation revision is missing');
  if (policy.requireRuntimeVersion && !binding?.runtimeVersion) reasons.push('required evaluated runtime version is missing');
  if (policy.requireSafetyRevision && !binding?.safetyRevision) reasons.push('required safety revision is missing');
  if (policy.requireRollbackTarget && !binding?.rollbackTarget) reasons.push('required last-known-good rollback target is missing');

  if (policy.requireExactModelIdentity) {
    if (!binding?.evaluatedModelIds.length) reasons.push('required exact evaluated model IDs are missing');
    if (!binding?.providerResolvedModelIds.length) reasons.push('required provider-resolved model IDs are missing');
    if (binding?.evaluatedModelIds.length && binding.providerResolvedModelIds.length &&
        !sameStringSet(binding.evaluatedModelIds, binding.providerResolvedModelIds)) {
      reasons.push('evaluated model IDs do not match provider-resolved model IDs');
    }
  }

  if (binding?.evaluatedAt && !evaluatedAt) reasons.push('evaluation timestamp is invalid');
  if (evaluatedAt && evaluatedAt.getTime() > now.getTime()) reasons.push('evaluation timestamp is in the future');

  if (policy.maxEvidenceAgeHours !== undefined) {
    if (!evaluatedAt) {
      reasons.push('evaluation timestamp required for maxEvidenceAgeHours is missing');
    } else {
      const ageMs = now.getTime() - evaluatedAt.getTime();
      if (ageMs > policy.maxEvidenceAgeHours * 60 * 60 * 1_000) {
        reasons.push(`evaluation evidence is older than ${policy.maxEvidenceAgeHours} hour(s)`);
      }
    }
  }

  const expiresAt = validDate(binding?.expiresAt);
  if (binding?.expiresAt && !expiresAt) reasons.push('evidence expiry timestamp is invalid');
  if (expiresAt && evaluatedAt && expiresAt.getTime() <= evaluatedAt.getTime()) {
    reasons.push('evidence expiry must be after the evaluation timestamp');
  }
  if (expiresAt && now.getTime() >= expiresAt.getTime()) reasons.push(`evidence expired at ${binding!.expiresAt}`);

  if (policy.requireRuntimeObservation && !observation) {
    reasons.push('required current runtime observation is missing');
  }
  if (observation) {
    if (policy.requireSourceSha256 && binding?.sourceSha256 && !observation.sourceSha256) {
      reasons.push('runtime observation did not report source/package SHA-256');
    }
    if (policy.requireExactModelIdentity && binding?.providerResolvedModelIds.length && !observation.providerResolvedModelIds.length) {
      reasons.push('runtime observation did not report provider-resolved model IDs');
    }
    if (policy.requireRuntimeVersion && binding?.runtimeVersion && !observation.runtimeVersion) {
      reasons.push('runtime observation did not report runtime version');
    }
    if (policy.requireSafetyRevision && binding?.safetyRevision && !observation.safetyRevision) {
      reasons.push('runtime observation did not report safety revision');
    }
  }

  if (observation?.observedAt && !observedAt) reasons.push('runtime observation timestamp is invalid');
  if (observedAt && observedAt.getTime() > now.getTime()) reasons.push('runtime observation timestamp is in the future');
  if (policy.requireRuntimeObservation && evaluatedAt && observedAt && observedAt.getTime() < evaluatedAt.getTime()) {
    reasons.push('runtime observation predates the current evaluation evidence');
  }

  if (policy.maxRuntimeObservationAgeHours !== undefined) {
    if (!observedAt) {
      reasons.push('runtime observation timestamp required for maxRuntimeObservationAgeHours is missing');
    } else {
      const ageMs = now.getTime() - observedAt.getTime();
      if (ageMs > policy.maxRuntimeObservationAgeHours * 60 * 60 * 1_000) {
        reasons.push(`runtime observation is older than ${policy.maxRuntimeObservationAgeHours} hour(s)`);
      }
    }
  }

  return uniqueStrings([...reasons, ...runtimeDrift(capability).reasons]);
}

function changedBindingChecks(previous: CapabilityEvidenceBinding | undefined, next: CapabilityEvidenceBinding | undefined): CapabilityCheck[] {
  if (!previous || !next) return [];
  const affected = new Set<CapabilityCheck>();

  if ((previous.sourceSha256 ?? '').toLowerCase() !== (next.sourceSha256 ?? '').toLowerCase()) {
    ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED'].forEach((check) => affected.add(check as CapabilityCheck));
  }
  if (previous.evaluationRevision !== next.evaluationRevision ||
      !sameStringSet(previous.evaluatedModelIds, next.evaluatedModelIds) ||
      !sameStringSet(previous.providerResolvedModelIds, next.providerResolvedModelIds) ||
      previous.runtimeVersion !== next.runtimeVersion) {
    ['DISCOVERED', 'ROUTING_VERIFIED', 'RUNTIME_WIRED', 'SAFETY_VERIFIED'].forEach((check) => affected.add(check as CapabilityCheck));
  }
  if (previous.safetyRevision !== next.safetyRevision) affected.add('SAFETY_VERIFIED');
  return [...affected];
}

function applyBindingChangeInvalidation(capability: StoredCapability, previous: CapabilityEvidenceBinding | undefined, next: CapabilityEvidenceBinding | undefined, at: string): void {
  const affected = changedBindingChecks(previous, next).filter((check) => capability.requiredChecks.includes(check));
  if (!affected.length) return;
  capability.passedChecks = capability.passedChecks.filter((check) => !affected.includes(check));
  capability.invalidations ??= [];
  const line = `${at} EVIDENCE_BINDING_CHANGED: cleared ${affected.join(', ')}`;
  if (!capability.invalidations.includes(line)) capability.invalidations.push(line);
}

function sameReadinessPolicy(left: CapabilityReadinessPolicy | undefined, right: CapabilityReadinessPolicy | undefined): boolean {
  if (!left || !right) return left === right;
  return left.requireSourceSha256 === right.requireSourceSha256 &&
    left.requireEvaluationRevision === right.requireEvaluationRevision &&
    left.requireExactModelIdentity === right.requireExactModelIdentity &&
    left.requireRuntimeVersion === right.requireRuntimeVersion &&
    left.requireSafetyRevision === right.requireSafetyRevision &&
    left.requireRollbackTarget === right.requireRollbackTarget &&
    left.requireRuntimeObservation === right.requireRuntimeObservation &&
    left.maxEvidenceAgeHours === right.maxEvidenceAgeHours &&
    left.maxRuntimeObservationAgeHours === right.maxRuntimeObservationAgeHours;
}

function applyReadinessPolicyChangeInvalidation(capability: StoredCapability, previous: CapabilityReadinessPolicy | undefined, next: CapabilityReadinessPolicy | undefined, at: string): void {
  if (sameReadinessPolicy(previous, next)) return;
  const affected = capability.requiredChecks.slice();
  capability.passedChecks = [];
  capability.invalidations ??= [];
  const line = `${at} READINESS_POLICY_CHANGED: cleared ${affected.join(', ') || 'all readiness evidence'}`;
  if (!capability.invalidations.includes(line)) capability.invalidations.push(line);
}

function applyRequiredChecksChangeInvalidation(capability: StoredCapability, previous: CapabilityCheck[], next: CapabilityCheck[], at: string): void {
  if (sameCheckSet(previous, next)) return;
  capability.passedChecks = [];
  capability.invalidations ??= [];
  const line = `${at} REQUIRED_CHECKS_CHANGED: cleared all readiness evidence (from [${previous.join(', ')}] to [${next.join(', ')}])`;
  if (!capability.invalidations.includes(line)) capability.invalidations.push(line);
}

export function capabilityReadiness(capability: StoredCapability, now: Date = new Date()): CapabilityReadiness {
  const passed = new Set(capability.passedChecks);
  const missingChecks = capability.requiredChecks.filter((check) => !passed.has(check));
  const staleReasons = policyStaleReasons(capability, now);
  return {
    id: capability.id,
    ready: capability.enabled && missingChecks.length === 0 && staleReasons.length === 0,
    enabled: capability.enabled,
    missingChecks,
    staleReasons,
    evidence: capability.evidence.slice(),
    invalidations: (capability.invalidations ?? []).slice(),
  };
}

export class CapabilityRegistry {
  constructor(private readonly store: NexusStore) {}

  private now(): string { return new Date().toISOString(); }

  async upsert(input: UpsertCapabilityInput): Promise<StoredCapability> {
    const parsed = upsertCapabilitySchema.parse(input);
    return this.store.update((db) => {
      const existing = db.capabilities.find((item) => item.id === parsed.id);
      const now = this.now();

      if (existing && existing.kind !== parsed.kind) {
        throw new Error(`Capability ${parsed.id} kind is immutable (${existing.kind}); cannot change it to ${parsed.kind}. Create a new capability ID instead.`);
      }

      const nextRequiredChecks = uniqueChecks(parsed.requiredChecks);
      const requiredChecksChanged = existing ? !sameCheckSet(existing.requiredChecks, nextRequiredChecks) : false;
      const next: Omit<StoredCapability, 'createdAt' | 'updatedAt'> = {
        id: parsed.id,
        kind: parsed.kind,
        description: parsed.description,
        source: parsed.source ?? existing?.source,
        version: parsed.version ?? existing?.version,
        requiredChecks: nextRequiredChecks,
        passedChecks: requiredChecksChanged ? [] : uniqueChecks(parsed.passedChecks ?? existing?.passedChecks ?? []),
        enabled: parsed.enabled ?? existing?.enabled ?? true,
        evidence: uniqueStrings(parsed.evidence ?? existing?.evidence ?? []),
        evidenceBinding: parsed.evidenceBinding ?? existing?.evidenceBinding,
        readinessPolicy: parsed.readinessPolicy ?? existing?.readinessPolicy,
        lastRuntimeObservation: parsed.lastRuntimeObservation ?? existing?.lastRuntimeObservation,
        invalidations: uniqueStrings(parsed.invalidations ?? existing?.invalidations ?? []),
      };
      if (next.passedChecks.some((check) => !next.requiredChecks.includes(check))) {
        throw new Error(`Capability ${parsed.id} contains a passed check that is not required.`);
      }

      if (existing) {
        const previousBinding = existing.evidenceBinding;
        const previousPolicy = existing.readinessPolicy;
        const previousRequiredChecks = existing.requiredChecks.slice();
        Object.assign(existing, next, { updatedAt: now });
        applyRequiredChecksChangeInvalidation(existing, previousRequiredChecks, next.requiredChecks, now);
        applyBindingChangeInvalidation(existing, previousBinding, next.evidenceBinding, now);
        applyReadinessPolicyChangeInvalidation(existing, previousPolicy, next.readinessPolicy, now);
        return existing;
      }

      const capability: StoredCapability = { ...next, createdAt: now, updatedAt: now };
      db.capabilities.push(capability);
      return capability;
    });
  }

  async bindEvidence(id: string, binding: CapabilityEvidenceBinding, evidence: string): Promise<StoredCapability> {
    const parsed = capabilityEvidenceBindingSchema.parse(binding);
    if (!evidence.trim()) throw new Error('Capability binding evidence is required.');
    return this.store.update((db) => {
      const capability = db.capabilities.find((item) => item.id === id);
      if (!capability) throw new Error(`Unknown capability: ${id}`);
      const now = this.now();
      const previousBinding = capability.evidenceBinding;
      capability.evidenceBinding = parsed;
      applyBindingChangeInvalidation(capability, previousBinding, parsed, now);
      const evidenceLine = `BINDING: ${evidence.trim()}`;
      if (!capability.evidence.includes(evidenceLine)) capability.evidence.push(evidenceLine);
      capability.updatedAt = now;
      return capability;
    });
  }

  async recordRuntimeObservation(id: string, observation: CapabilityRuntimeObservation, evidence: string): Promise<StoredCapability> {
    const parsed = capabilityRuntimeObservationSchema.parse(observation);
    if (!evidence.trim()) throw new Error('Runtime observation evidence is required.');
    return this.store.update((db) => {
      const capability = db.capabilities.find((item) => item.id === id);
      if (!capability) throw new Error(`Unknown capability: ${id}`);
      capability.lastRuntimeObservation = parsed;
      const evidenceLine = `RUNTIME_OBSERVED: ${evidence.trim()}`;
      if (!capability.evidence.includes(evidenceLine)) capability.evidence.push(evidenceLine);
      const drift = runtimeDrift(capability);
      if (drift.reasons.length) {
        const affected = drift.checks.filter((check) => capability.requiredChecks.includes(check));
        capability.passedChecks = capability.passedChecks.filter((check) => !affected.includes(check));
        capability.invalidations ??= [];
        for (const reason of drift.reasons) {
          const line = `${parsed.observedAt} RUNTIME_DRIFT: cleared ${affected.join(', ') || 'no required checks'} — ${reason}`;
          if (!capability.invalidations.includes(line)) capability.invalidations.push(line);
        }
      }
      capability.updatedAt = this.now();
      return capability;
    });
  }

  async recordCheck(id: string, check: CapabilityCheck, evidence: string): Promise<StoredCapability> {
    if (!evidence.trim()) throw new Error('Capability evidence is required.');
    return this.store.update((db) => {
      const capability = db.capabilities.find((item) => item.id === id);
      if (!capability) throw new Error(`Unknown capability: ${id}`);
      if (!capability.requiredChecks.includes(check)) {
        throw new Error(`Capability ${id} does not require check ${check}.`);
      }
      if (!capability.passedChecks.includes(check)) capability.passedChecks.push(check);
      const evidenceLine = `${check}: ${evidence.trim()}`;
      if (!capability.evidence.includes(evidenceLine)) capability.evidence.push(evidenceLine);
      capability.updatedAt = this.now();
      return capability;
    });
  }

  async invalidateChecks(id: string, checks: CapabilityCheck[], reason: string): Promise<StoredCapability> {
    if (!reason.trim()) throw new Error('Capability invalidation reason is required.');
    return this.store.update((db) => {
      const capability = db.capabilities.find((item) => item.id === id);
      if (!capability) throw new Error(`Unknown capability: ${id}`);
      const targets = uniqueChecks(checks).filter((check) => capability.requiredChecks.includes(check));
      capability.passedChecks = capability.passedChecks.filter((check) => !targets.includes(check));
      capability.invalidations ??= [];
      const line = `${this.now()} MANUAL_INVALIDATION: ${targets.join(', ') || 'no required checks'} — ${reason.trim()}`;
      if (!capability.invalidations.includes(line)) capability.invalidations.push(line);
      capability.updatedAt = this.now();
      return capability;
    });
  }

  async setEnabled(id: string, enabled: boolean, evidence: string): Promise<StoredCapability> {
    if (!evidence.trim()) throw new Error('Enable/disable evidence is required.');
    return this.store.update((db) => {
      const capability = db.capabilities.find((item) => item.id === id);
      if (!capability) throw new Error(`Unknown capability: ${id}`);
      capability.enabled = enabled;
      const evidenceLine = `${enabled ? 'ENABLED' : 'DISABLED'}: ${evidence.trim()}`;
      if (!capability.evidence.includes(evidenceLine)) capability.evidence.push(evidenceLine);
      capability.updatedAt = this.now();
      return capability;
    });
  }

  async get(id: string): Promise<StoredCapability | undefined> {
    const db = await this.store.load();
    return db.capabilities.find((item) => item.id === id);
  }

  async readiness(ids: string[]): Promise<CapabilityReadiness[]> {
    const db = await this.store.load();
    return ids.map((id) => {
      const capability = db.capabilities.find((item) => item.id === id);
      if (!capability) {
        return {
          id,
          ready: false,
          enabled: false,
          missingChecks: [],
          staleReasons: ['capability is not registered'],
          evidence: ['MISSING: capability is not registered'],
          invalidations: [],
        };
      }
      return capabilityReadiness(capability);
    });
  }

  async assertReady(ids: string[]): Promise<void> {
    const statuses = await this.readiness(ids);
    const blocked = statuses.filter((status) => !status.ready);
    if (!blocked.length) return;
    const detail = blocked.map((status) => {
      const reasons: string[] = [];
      if (!status.enabled) reasons.push('disabled or missing');
      if (status.missingChecks.length) reasons.push(`missing checks: ${status.missingChecks.join(', ')}`);
      if (status.staleReasons.length) reasons.push(`stale/drifted evidence: ${status.staleReasons.join(' | ')}`);
      return `${status.id} (${reasons.join('; ') || 'unknown readiness failure'})`;
    }).join('; ');
    throw new Error(`Required capabilities are not ready: ${detail}`);
  }
}
