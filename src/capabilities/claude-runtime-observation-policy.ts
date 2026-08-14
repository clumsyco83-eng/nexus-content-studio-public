export const CLAUDE_RUNTIME_SMOKE_SENTINEL = 'NEXUS_CLAUDE_RUNTIME_SMOKE_OK';

export interface RuntimeObservationBinding {
  sourceSha256?: string;
  evaluatedAt?: string;
  providerResolvedModelIds: string[];
  runtimeVersion?: string;
  safetyRevision?: string;
}

export interface RuntimeObservationPolicy {
  requireSourceSha256?: boolean;
  requireExactModelIdentity?: boolean;
  requireRuntimeVersion?: boolean;
  requireSafetyRevision?: boolean;
  requireRuntimeObservation?: boolean;
  maxRuntimeObservationAgeHours?: number;
}

export interface ExistingRuntimeObservation {
  observedAt: string;
  sourceSha256?: string;
  providerResolvedModelIds: string[];
  runtimeVersion?: string;
  safetyRevision?: string;
  note?: string;
}

export interface RuntimeObservationCapabilityView {
  id: string;
  enabled: boolean;
  passedChecks: string[];
  evidenceBinding?: RuntimeObservationBinding;
  readinessPolicy?: RuntimeObservationPolicy;
  lastRuntimeObservation?: ExistingRuntimeObservation;
}

export interface RuntimeObservationReadinessView {
  ready: boolean;
  enabled: boolean;
  missingChecks: string[];
  staleReasons: string[];
}

export interface VerifiedClaudeSmokeView {
  resolvedModel: string;
  permissionMode: string;
  cwd?: string;
  numTurns: number;
  totalCostUsd: number;
  success: boolean;
  resultText?: string;
}

export interface BuildRuntimeObservationInput {
  capability: RuntimeObservationCapabilityView;
  readiness: RuntimeObservationReadinessView;
  smoke: VerifiedClaudeSmokeView;
  expectedResolvedModel: string;
  expectedRuntimeVersion: string;
  actualRuntimeVersion: string;
  expectedCwd: string;
  observedAt: string;
}

export interface BuiltRuntimeObservation {
  observedAt: string;
  sourceSha256?: string;
  providerResolvedModelIds: string[];
  runtimeVersion?: string;
  safetyRevision?: string;
  note: string;
}

function exactStringArray(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x.localeCompare(y));
  const b = [...new Set(right)].sort((x, y) => x.localeCompare(y));
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseTimestamp(value: string, label: string): number {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp.`);
  return parsed;
}

function onlyRefreshableStaleness(reasons: readonly string[]): boolean {
  return reasons.every((reason) => /^runtime observation is older than [0-9.]+ hour\(s\)$/.test(reason));
}

export function buildClaudeRuntimeObservation(input: BuildRuntimeObservationInput): BuiltRuntimeObservation {
  const { capability, readiness, smoke } = input;
  if (!capability.enabled || !readiness.enabled) throw new Error(`Capability ${capability.id} is disabled; runtime observation refresh cannot enable it.`);
  if (readiness.missingChecks.length) {
    throw new Error(`Capability ${capability.id} has missing readiness checks: ${readiness.missingChecks.join(', ')}. Runtime observation refresh may not repair checks.`);
  }
  if (!onlyRefreshableStaleness(readiness.staleReasons)) {
    throw new Error(`Capability ${capability.id} has non-refreshable stale reason(s): ${readiness.staleReasons.join('; ')}.`);
  }

  const binding = capability.evidenceBinding;
  const policy = capability.readinessPolicy;
  if (!binding) throw new Error(`Capability ${capability.id} has no evaluated evidence binding; runtime observation refresh is blocked.`);
  if (!policy?.requireRuntimeObservation || policy.maxRuntimeObservationAgeHours === undefined) {
    throw new Error(`Capability ${capability.id} is not governed by a bounded runtime-observation freshness lease.`);
  }

  if (!input.expectedResolvedModel.trim()) throw new Error('Expected resolved Claude model is required.');
  if (!input.expectedRuntimeVersion.trim() || !input.actualRuntimeVersion.trim()) throw new Error('Expected and actual Claude Code versions are required.');
  if (input.actualRuntimeVersion.trim() !== input.expectedRuntimeVersion.trim()) {
    throw new Error(`Claude Code version drift: actual ${JSON.stringify(input.actualRuntimeVersion.trim())} != expected ${JSON.stringify(input.expectedRuntimeVersion.trim())}.`);
  }
  if (binding.runtimeVersion !== input.expectedRuntimeVersion.trim()) {
    throw new Error(`Evaluated runtime binding ${JSON.stringify(binding.runtimeVersion ?? '')} does not match expected Claude Code version ${JSON.stringify(input.expectedRuntimeVersion.trim())}.`);
  }

  if (binding.providerResolvedModelIds.length !== 1) {
    throw new Error(`Runtime observation refresh requires exactly one provider-resolved model in the current binding; found ${binding.providerResolvedModelIds.length}. Observe multi-route capabilities independently instead of renewing unobserved routes.`);
  }
  if (smoke.resolvedModel !== input.expectedResolvedModel.trim()) {
    throw new Error(`Verified smoke resolved model ${JSON.stringify(smoke.resolvedModel)} does not match expected ${JSON.stringify(input.expectedResolvedModel.trim())}.`);
  }
  if (!exactStringArray(binding.providerResolvedModelIds, [smoke.resolvedModel])) {
    throw new Error(`Verified smoke model ${JSON.stringify(smoke.resolvedModel)} does not match the evaluated provider-resolved model binding.`);
  }
  if (smoke.permissionMode !== 'plan') throw new Error(`Runtime observation refresh requires plan-mode smoke evidence; observed ${JSON.stringify(smoke.permissionMode)}.`);
  if (!smoke.success) throw new Error('Runtime observation refresh requires a successful bounded Claude smoke.');
  if (smoke.numTurns !== 1) throw new Error(`Runtime observation refresh requires exactly one Claude turn; observed ${smoke.numTurns}.`);
  if ((smoke.resultText ?? '').trim() !== CLAUDE_RUNTIME_SMOKE_SENTINEL) {
    throw new Error(`Runtime observation refresh requires exact smoke sentinel ${CLAUDE_RUNTIME_SMOKE_SENTINEL}.`);
  }
  if (smoke.cwd !== input.expectedCwd) {
    throw new Error(`Runtime observation refresh cwd drift: observed ${JSON.stringify(smoke.cwd ?? '')} != expected ${JSON.stringify(input.expectedCwd)}.`);
  }

  const observedAtMs = parseTimestamp(input.observedAt, 'Smoke evidence timestamp');
  if (observedAtMs > Date.now()) throw new Error('Smoke evidence timestamp is in the future.');
  if (binding.evaluatedAt && observedAtMs < parseTimestamp(binding.evaluatedAt, 'Capability evaluation timestamp')) {
    throw new Error('Smoke runtime observation predates the current evaluated evidence binding.');
  }

  if (policy.requireSourceSha256) {
    throw new Error('This bounded Claude smoke does not independently observe current source/package SHA-256, so it may not renew a readiness lease that requires current source SHA evidence. Run the repository-native source/package verification for that capability instead of copying prior observation data forward.');
  }
  if (policy.requireSafetyRevision) {
    throw new Error('This bounded Claude smoke does not independently observe the current safety revision, so it may not renew a readiness lease that requires current safety-revision evidence. Run the repository-native Guardian/Watchdog safety verification for that capability instead of copying prior observation data forward.');
  }

  return {
    observedAt: new Date(observedAtMs).toISOString(),
    providerResolvedModelIds: [smoke.resolvedModel],
    runtimeVersion: input.actualRuntimeVersion.trim(),
    note: 'Fresh bounded Claude smoke verified exact provider-resolved model, Claude Code version, plan-mode workspace identity, one-turn budget and sentinel output; evaluated binding/readiness policy/checks were not modified and unobserved source/safety fields were not renewed.',
  };
}
