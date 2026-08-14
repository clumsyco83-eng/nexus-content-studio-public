export type ClaudeTaskClass = 'routine' | 'complex' | 'critical';
export type ClaudeFailureKind = 'verification' | 'permission' | 'configuration' | 'safety' | 'provider' | 'timeout' | 'unknown';

export interface ClaudeModelPolicy {
  defaultModel: string;
  escalationModel: string;
  maxTurns: number;
  repairAttemptsBeforeEscalation: number;
  maxRepairAttempts: number;
  maxEscalations: number;
}

export interface ClaudeRoutingState {
  taskClass: ClaudeTaskClass;
  attempt: number;
  verifierFailures: number;
  escalationsUsed: number;
  lastFailureKind?: ClaudeFailureKind;
}

export interface ClaudeRoutingDecision {
  model: string;
  action: 'run' | 'retry' | 'escalate' | 'stop';
  reason: string;
  requiresOwnerAction: boolean;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected integer from ${min} to ${max}; received ${raw}.`);
  }
  return value;
}

/**
 * Cost-aware Claude routing policy.
 *
 * The policy deliberately uses configurable model identifiers rather than
 * hard-coding provider SKU names. The default configuration expresses the
 * desired Sonnet-first / Opus-on-hard-failure behavior while remaining easy
 * to update when provider model IDs change.
 */
export function claudeModelPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeModelPolicy {
  return {
    defaultModel: env.NEXUS_CLAUDE_DEFAULT_MODEL?.trim() || 'sonnet',
    escalationModel: env.NEXUS_CLAUDE_ESCALATION_MODEL?.trim() || 'opus',
    maxTurns: boundedInt(env.NEXUS_CLAUDE_MAX_TURNS, 40, 1, 40),
    repairAttemptsBeforeEscalation: boundedInt(env.NEXUS_CLAUDE_REPAIR_ATTEMPTS_BEFORE_ESCALATION, 2, 1, 5),
    maxRepairAttempts: boundedInt(env.NEXUS_CLAUDE_MAX_REPAIR_ATTEMPTS, 5, 1, 10),
    maxEscalations: boundedInt(env.NEXUS_CLAUDE_MAX_ESCALATIONS, 1, 0, 2),
  };
}

export function turnsRemaining(currentTurn: number, policy: ClaudeModelPolicy): number {
  if (!Number.isInteger(currentTurn) || currentTurn < 0) throw new Error('currentTurn must be a non-negative integer.');
  return Math.max(0, policy.maxTurns - currentTurn);
}

export function mayContinueTurns(currentTurn: number, policy: ClaudeModelPolicy): boolean {
  return turnsRemaining(currentTurn, policy) > 0;
}

export function chooseClaudeModel(
  state: ClaudeRoutingState,
  policy: ClaudeModelPolicy,
): ClaudeRoutingDecision {
  if (!Number.isInteger(state.attempt) || state.attempt < 0) throw new Error('attempt must be a non-negative integer.');
  if (!Number.isInteger(state.verifierFailures) || state.verifierFailures < 0) throw new Error('verifierFailures must be a non-negative integer.');
  if (!Number.isInteger(state.escalationsUsed) || state.escalationsUsed < 0) throw new Error('escalationsUsed must be a non-negative integer.');

  if (state.attempt >= policy.maxRepairAttempts) {
    return {
      model: policy.defaultModel,
      action: 'stop',
      reason: `Repair attempt budget exhausted at ${state.attempt}/${policy.maxRepairAttempts}.`,
      requiresOwnerAction: true,
    };
  }

  if (state.lastFailureKind === 'safety') {
    return {
      model: policy.defaultModel,
      action: 'stop',
      reason: 'Safety failures are never repaired by model escalation; the safety control must remain fail-closed.',
      requiresOwnerAction: true,
    };
  }

  if (state.lastFailureKind === 'permission' || state.lastFailureKind === 'configuration') {
    return {
      model: policy.defaultModel,
      action: 'stop',
      reason: `${state.lastFailureKind} failures require a configuration/approval correction, not a more expensive model.`,
      requiresOwnerAction: true,
    };
  }

  const hardVerifierFailure = state.verifierFailures >= policy.repairAttemptsBeforeEscalation;
  const canEscalate = state.escalationsUsed < policy.maxEscalations;

  if (hardVerifierFailure && canEscalate) {
    return {
      model: policy.escalationModel,
      action: 'escalate',
      reason: `${state.verifierFailures} verifier failures reached the escalation threshold; use the advanced model for one bounded repair attempt.`,
      requiresOwnerAction: false,
    };
  }

  if (state.attempt === 0) {
    return {
      model: policy.defaultModel,
      action: 'run',
      reason: `Start with the default cost-efficient model for ${state.taskClass} work.`,
      requiresOwnerAction: false,
    };
  }

  return {
    model: policy.defaultModel,
    action: 'retry',
    reason: 'Retry the default model while the bounded verifier-repair budget remains available.',
    requiresOwnerAction: false,
  };
}
