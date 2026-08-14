export type ModelProvider = 'CLAUDE' | 'OPENAI';
export type ModelRole = 'PRIMARY_EXECUTOR' | 'ESCALATION_EXECUTOR' | 'STRATEGY';

export interface ModelPromotionEvidence {
  provider: ModelProvider;
  role: ModelRole;
  configuredIdentifier: string;
  evaluatedIdentifier: string;
  providerReportedIdentifier?: string;
  evaluationRevision: string;
  evaluatedAt: string;
  snapshotAvailable?: boolean;
  pinnedSnapshot?: boolean;
  replacingExisting?: boolean;
  rollbackIdentifier?: string;
}

export interface ModelPromotionResult {
  ready: boolean;
  failures: string[];
  warnings: string[];
}

const claudeFloatingAliases = new Set(['sonnet', 'opus', 'haiku', 'default']);

function nonBlank(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function isFloatingModelIdentifier(provider: ModelProvider, identifier: string): boolean {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) return true;
  if (provider === 'CLAUDE' && claudeFloatingAliases.has(normalized)) return true;
  return normalized === 'latest' || normalized.endsWith('-latest');
}

export function validateModelPromotion(evidence: ModelPromotionEvidence): ModelPromotionResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const configured = evidence.configuredIdentifier.trim();
  const evaluated = evidence.evaluatedIdentifier.trim();
  const providerReported = evidence.providerReportedIdentifier?.trim();

  if (!configured) failures.push('configuredIdentifier is required.');
  if (!evaluated) failures.push('evaluatedIdentifier is required.');
  if (!nonBlank(evidence.evaluationRevision)) failures.push('evaluationRevision is required.');
  if (!validTimestamp(evidence.evaluatedAt)) failures.push('evaluatedAt must be a valid timestamp.');

  if (configured && isFloatingModelIdentifier(evidence.provider, configured)) {
    failures.push(`Production promotion cannot use floating ${evidence.provider} model alias: ${configured}.`);
  }
  if (evaluated && isFloatingModelIdentifier(evidence.provider, evaluated)) {
    failures.push(`Evaluation evidence must identify the exact evaluated model, not floating alias: ${evaluated}.`);
  }
  if (configured && evaluated && configured !== evaluated) {
    failures.push('configuredIdentifier must exactly match evaluatedIdentifier for production promotion.');
  }
  if (providerReported && evaluated && providerReported !== evaluated) {
    failures.push('providerReportedIdentifier does not match evaluatedIdentifier.');
  }

  if (evidence.snapshotAvailable === true && evidence.pinnedSnapshot !== true) {
    failures.push('A provider snapshot/version is available but the promoted configuration is not pinned to it.');
  }
  if (evidence.snapshotAvailable !== true && evidence.pinnedSnapshot !== true) {
    warnings.push('No pinned snapshot evidence recorded; rerun evaluations when the provider/model identifier changes.');
  }

  if (evidence.replacingExisting === true) {
    if (!nonBlank(evidence.rollbackIdentifier)) {
      failures.push('rollbackIdentifier is required when replacing an existing production model.');
    } else if (evidence.rollbackIdentifier!.trim() === configured) {
      failures.push('rollbackIdentifier must differ from the newly promoted model.');
    }
  }

  return { ready: failures.length === 0, failures, warnings };
}

export function validateClaudeRoutingPromotion(input: {
  primary: ModelPromotionEvidence;
  escalation: ModelPromotionEvidence;
}): ModelPromotionResult {
  const primary = validateModelPromotion(input.primary);
  const escalation = validateModelPromotion(input.escalation);
  const failures = [...primary.failures.map((failure) => `primary: ${failure}`), ...escalation.failures.map((failure) => `escalation: ${failure}`)];
  const warnings = [...primary.warnings.map((warning) => `primary: ${warning}`), ...escalation.warnings.map((warning) => `escalation: ${warning}`)];

  if (input.primary.provider !== 'CLAUDE' || input.escalation.provider !== 'CLAUDE') {
    failures.push('Claude routing promotion requires CLAUDE evidence for both primary and escalation models.');
  }
  if (input.primary.role !== 'PRIMARY_EXECUTOR') failures.push('Primary Claude evidence must use role PRIMARY_EXECUTOR.');
  if (input.escalation.role !== 'ESCALATION_EXECUTOR') failures.push('Escalation Claude evidence must use role ESCALATION_EXECUTOR.');
  if (input.primary.configuredIdentifier.trim() === input.escalation.configuredIdentifier.trim()) {
    failures.push('Primary and escalation Claude models must be distinct for a meaningful escalation policy.');
  }

  return { ready: failures.length === 0, failures, warnings };
}
