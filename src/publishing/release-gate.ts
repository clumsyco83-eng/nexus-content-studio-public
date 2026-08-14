import type { PublishPlatform } from './publishing-router.js';

export interface ReleaseGateInput {
  jobId: string;
  platform: PublishPlatform;
  assetVersion: string;
  finalAssetReady: boolean;
  claimsVerified: boolean;
  qcPassed: boolean;
  accountConfirmed: boolean;
  duplicateCheckCompleted: boolean;
  duplicateFound: boolean;
  ownerApproved: boolean;
  publishRequested: boolean;
}

export interface ReleaseGateDecision {
  allowed: boolean;
  idempotencyKey: string;
  blockers: string[];
  checks: Array<{ name: string; passed: boolean }>;
}

export function publishIdempotencyKey(jobId: string, platform: PublishPlatform, assetVersion: string): string {
  const clean = (value: string) => value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${clean(jobId)}:${platform}:${clean(assetVersion)}`;
}

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateDecision {
  const checks = [
    { name: 'final-asset-ready', passed: input.finalAssetReady },
    { name: 'claims-verified', passed: input.claimsVerified },
    { name: 'quality-control-passed', passed: input.qcPassed },
    { name: 'destination-account-confirmed', passed: input.accountConfirmed },
    { name: 'duplicate-check-completed', passed: input.duplicateCheckCompleted },
    { name: 'no-duplicate-found', passed: input.duplicateCheckCompleted && !input.duplicateFound },
    { name: 'owner-approved', passed: input.ownerApproved },
    { name: 'explicit-publish-requested', passed: input.publishRequested },
  ];

  const messages: Record<string, string> = {
    'final-asset-ready': 'Final asset is not ready.',
    'claims-verified': 'Factual claims are not fully verified.',
    'quality-control-passed': 'Quality control has not passed.',
    'destination-account-confirmed': 'The destination account has not been confirmed.',
    'duplicate-check-completed': 'Duplicate check has not been completed.',
    'no-duplicate-found': input.duplicateFound ? 'A matching publish record already exists.' : 'Duplicate status is unresolved.',
    'owner-approved': 'Owner approval is required.',
    'explicit-publish-requested': 'Approval is not a publish command; an explicit publish request is still required.',
  };

  const blockers = checks.filter((check) => !check.passed).map((check) => messages[check.name]);
  return { allowed: blockers.length === 0, idempotencyKey: publishIdempotencyKey(input.jobId, input.platform, input.assetVersion), blockers, checks };
}

export function assertReleaseAllowed(input: ReleaseGateInput): ReleaseGateDecision {
  const decision = evaluateReleaseGate(input);
  if (!decision.allowed) throw new Error(`Publishing release gate blocked: ${decision.blockers.join(' ')}`);
  return decision;
}

export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; }

export function retryDelayMs(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Retry attempt must be a positive integer.');
  if (retryAfterMs != null && retryAfterMs >= 0) return Math.min(retryAfterMs, policy.maxDelayMs);
  return Math.min(policy.baseDelayMs * (2 ** (attempt - 1)), policy.maxDelayMs);
}

export function shouldRetryPublish(status: number | undefined, attempt: number, policy: RetryPolicy): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (status == null) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
