import {
  assertClaudeCodeVersion,
  parseClaudeStreamJson,
  type ClaudeRuntimeExpectation,
  type ClaudeRuntimeEvidence,
} from '../claude/runtime-evidence.js';
import { CapabilityRegistry } from './registry.js';
import type { CapabilityCheck, CapabilityReadiness, StoredCapability } from './schema.js';

const runtimeChecks: CapabilityCheck[] = ['RUNTIME_WIRED', 'SAFETY_VERIFIED'];

export interface RuntimeAttestationResult {
  accepted: boolean;
  capabilityReady: boolean;
  readiness: CapabilityReadiness;
  reason?: string;
}

export interface ClaudeRuntimeAttestationResult extends RuntimeAttestationResult {
  runtime?: ClaudeRuntimeEvidence;
}

function cleanEvidence(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 1_800);
}

function readinessReason(readiness: CapabilityReadiness): string {
  const reasons: string[] = [];
  if (!readiness.enabled) reasons.push('capability disabled');
  if (readiness.missingChecks.length) reasons.push(`missing checks: ${readiness.missingChecks.join(', ')}`);
  if (readiness.staleReasons.length) reasons.push(`stale/drifted evidence: ${readiness.staleReasons.join(' | ')}`);
  return reasons.join('; ') || 'capability is not READY';
}

async function enforceRuntimeCapabilityContract(
  registry: CapabilityRegistry,
  capabilityId: string,
): Promise<{ ok: true; capability: StoredCapability } | { ok: false; readiness: CapabilityReadiness; reason: string }> {
  const capability = await registry.get(capabilityId);
  if (!capability) {
    return {
      ok: false,
      readiness: (await registry.readiness([capabilityId]))[0]!,
      reason: `Runtime capability ${capabilityId} is not registered.`,
    };
  }

  if (capability.kind !== 'RUNTIME') {
    const reason = `Capability ${capabilityId} has kind ${capability.kind}; Claude runtime attestation requires a RUNTIME capability.`;
    await registry.setEnabled(capabilityId, false, `RUNTIME_ATTESTATION_POLICY_REJECTED: ${reason}`);
    return {
      ok: false,
      readiness: (await registry.readiness([capabilityId]))[0]!,
      reason,
    };
  }

  const missingRequiredChecks = runtimeChecks.filter((check) => !capability.requiredChecks.includes(check));
  if (missingRequiredChecks.length) {
    const reason = `Runtime capability ${capabilityId} is misconfigured; required readiness checks missing from policy: ${missingRequiredChecks.join(', ')}.`;
    await registry.setEnabled(capabilityId, false, `RUNTIME_ATTESTATION_POLICY_REJECTED: ${reason}`);
    return {
      ok: false,
      readiness: (await registry.readiness([capabilityId]))[0]!,
      reason,
    };
  }
  return { ok: true, capability };
}

function assertExpectationMatchesBinding(
  capability: StoredCapability,
  expectation: ClaudeRuntimeExpectation & { expectedClaudeCodeVersion: string },
): void {
  const binding = capability.evidenceBinding;
  if (!binding) return;

  if (binding.providerResolvedModelIds.length > 0 && !binding.providerResolvedModelIds.includes(expectation.expectedResolvedModel)) {
    throw new Error(
      `Runtime expectation model ${expectation.expectedResolvedModel} is not in the capability's evaluated provider-resolved model set [${binding.providerResolvedModelIds.join(', ')}].`,
    );
  }
  if (binding.runtimeVersion && binding.runtimeVersion !== expectation.expectedClaudeCodeVersion.trim()) {
    throw new Error(
      `Runtime expectation Claude Code version ${expectation.expectedClaudeCodeVersion.trim()} does not match capability evaluated runtime version ${binding.runtimeVersion}.`,
    );
  }
}

async function revokeRuntimeReadiness(
  registry: CapabilityRegistry,
  capabilityId: string,
  reason: string,
): Promise<CapabilityReadiness> {
  const cleaned = cleanEvidence(reason) || 'runtime attestation rejected without a usable reason';
  await registry.invalidateChecks(capabilityId, runtimeChecks, `RUNTIME_ATTESTATION_REJECTED: ${cleaned}`);
  return (await registry.readiness([capabilityId]))[0]!;
}

async function recordRuntimeReadiness(
  registry: CapabilityRegistry,
  capabilityId: string,
  runtimeEvidence: string,
  safetyEvidence: string,
): Promise<CapabilityReadiness> {
  const before = (await registry.readiness([capabilityId]))[0]!;
  const partialRuntimeState = runtimeChecks.some((check) => before.missingChecks.includes(check));

  // Clear both before recording a fresh validated pair whenever either side is
  // missing. This prevents a stale partial pair from temporarily becoming READY
  // between two evidence writes.
  if (partialRuntimeState) {
    await registry.invalidateChecks(
      capabilityId,
      runtimeChecks,
      'RUNTIME_ATTESTATION_REFRESH: clearing partial runtime/safety state before recording a fresh validated pair',
    );
  }

  await registry.recordCheck(capabilityId, 'RUNTIME_WIRED', cleanEvidence(runtimeEvidence));
  await registry.recordCheck(capabilityId, 'SAFETY_VERIFIED', cleanEvidence(safetyEvidence));
  return (await registry.readiness([capabilityId]))[0]!;
}

/**
 * Validate real Claude stream-json evidence against the exact evaluated model,
 * Claude Code version and task authority envelope.
 *
 * Runtime attestation deliberately sets requireSuccess=false. A normal task
 * implementation failure with valid identity/permissions/budgets is not runtime
 * drift and must flow to the independent Verifier/repair loop. Format, model,
 * version, permission, workspace, tool/MCP/Skill or budget drift still fails
 * closed and revokes RUNTIME_WIRED + SAFETY_VERIFIED.
 */
export async function attestClaudeRuntime(
  registry: CapabilityRegistry,
  capabilityId: string,
  rawStreamJson: string,
  expectation: ClaudeRuntimeExpectation & {
    expectedClaudeCodeVersion: string;
    actualClaudeCodeVersion: string;
  },
): Promise<ClaudeRuntimeAttestationResult> {
  const contract = await enforceRuntimeCapabilityContract(registry, capabilityId);
  if (!contract.ok) {
    return {
      accepted: false,
      capabilityReady: false,
      readiness: contract.readiness,
      reason: contract.reason,
    };
  }

  try {
    assertExpectationMatchesBinding(contract.capability, expectation);
    const runtime = parseClaudeStreamJson(rawStreamJson, { ...expectation, requireSuccess: false });
    assertClaudeCodeVersion(expectation.actualClaudeCodeVersion, expectation.expectedClaudeCodeVersion);

    const summary = [
      `session=${runtime.sessionId}`,
      `model=${runtime.resolvedModel}`,
      `permission=${runtime.permissionMode}`,
      runtime.cwd ? `cwd=${runtime.cwd}` : undefined,
      `turns=${runtime.numTurns}/${expectation.maxTurns}`,
      `costUsd=${runtime.totalCostUsd.toFixed(6)}/${expectation.maxCostUsd.toFixed(6)}`,
      `workerSuccess=${runtime.success}`,
      `claudeCode=${expectation.actualClaudeCodeVersion.trim()}`,
      runtime.toolEnvelopeHash ? `toolEnvelope=${runtime.toolEnvelopeHash}` : undefined,
      runtime.skillSetHash ? `skillSet=${runtime.skillSetHash}` : undefined,
      runtime.invokedSkills.length ? `skills=${runtime.invokedSkills.join(',')}` : undefined,
    ].filter(Boolean).join(' ');

    // Feed the same validated live identity into the machine-enforced evidence
    // lease. Fields not observable from Claude stream-json are deliberately not
    // copied from evaluated binding data; readiness policy will remain stale if
    // it requires evidence this invocation did not actually observe.
    await registry.recordRuntimeObservation(
      capabilityId,
      {
        observedAt: new Date().toISOString(),
        providerResolvedModelIds: [runtime.resolvedModel],
        runtimeVersion: expectation.actualClaudeCodeVersion.trim(),
        note: cleanEvidence(`Claude runtime attestation: ${summary}`),
      },
      cleanEvidence(`Claude runtime observation accepted: ${summary}`),
    );

    const readiness = await recordRuntimeReadiness(
      registry,
      capabilityId,
      `Claude runtime identity accepted: ${summary}`,
      `Claude permission/workspace/tool/MCP/Skill/turn/cost boundaries accepted: ${summary}`,
    );
    const capabilityReady = readiness.ready;
    return {
      accepted: capabilityReady,
      capabilityReady,
      readiness,
      reason: capabilityReady ? undefined : `Runtime evidence is valid, but capability is not READY: ${readinessReason(readiness)}.`,
      runtime,
    };
  } catch (error) {
    const reason = cleanEvidence(error instanceof Error ? error.message : String(error));
    const readiness = await revokeRuntimeReadiness(registry, capabilityId, reason);
    return {
      accepted: false,
      capabilityReady: false,
      readiness,
      reason,
    };
  }
}
