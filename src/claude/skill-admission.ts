import { createHash } from 'node:crypto';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { CapabilityCheck, StoredCapability } from '../capabilities/schema.js';
import { compileClaudeToolEnvelope, type CompiledClaudeToolEnvelope } from './tool-envelope.js';

export interface ClaudeSkillCapabilityBinding {
  skillName: string;
  capabilityId: string;
}

export interface ClaudeSkillAdmissionRequest {
  requestedSkills: string[];
  declaredTaskSkills: string[];
  bindings: ClaudeSkillCapabilityBinding[];
}

export interface AdmittedClaudeSkill {
  skillName: string;
  capabilityId: string;
  version: string;
  sourceSha256: string;
  evaluationRevision: string;
  evaluatedAt: string;
  evaluatedModelIds: string[];
  providerResolvedModelIds: string[];
  runtimeVersion: string;
  safetyRevision: string;
  rollbackTarget: string;
}

export interface ClaudeSkillAdmission {
  admittedSkills: string[];
  capabilityIds: string[];
  skillAdmissionHash: string;
  evidence: AdmittedClaudeSkill[];
}

export interface CapabilityBoundClaudeEnvelope extends CompiledClaudeToolEnvelope {
  skillAdmission: ClaudeSkillAdmission;
}

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const requiredSkillChecks: CapabilityCheck[] = ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'SAFETY_VERIFIED'];

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertSkillName(name: string): string {
  const value = name.trim();
  if (!skillNamePattern.test(value) || value.length > 64) {
    throw new Error(`Invalid Claude skill name: ${name}`);
  }
  return value;
}

function requiredText(value: string | undefined, label: string, skillName: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Claude skill ${skillName} is missing required production evidence: ${label}.`);
  return normalized;
}

function assertProductionSkillEvidence(skillName: string, capability: StoredCapability): AdmittedClaudeSkill {
  const missingChecks = requiredSkillChecks.filter((check) => !capability.requiredChecks.includes(check));
  if (missingChecks.length) {
    throw new Error(`Claude skill ${skillName} capability does not require the production skill checks: ${missingChecks.join(', ')}.`);
  }

  const binding = capability.evidenceBinding;
  if (!binding) throw new Error(`Claude skill ${skillName} is missing required production evidence binding.`);

  const evaluatedModelIds = uniqueSorted(binding.evaluatedModelIds);
  const providerResolvedModelIds = uniqueSorted(binding.providerResolvedModelIds);
  if (!evaluatedModelIds.length || !providerResolvedModelIds.length) {
    throw new Error(`Claude skill ${skillName} must record exact evaluated and provider-resolved model IDs.`);
  }
  if (!sameStringSet(evaluatedModelIds, providerResolvedModelIds)) {
    throw new Error(`Claude skill ${skillName} evaluated model IDs do not match provider-resolved model IDs.`);
  }

  return {
    skillName,
    capabilityId: capability.id,
    version: requiredText(capability.version, 'version', skillName),
    sourceSha256: requiredText(binding.sourceSha256?.toLowerCase(), 'source/package SHA-256', skillName),
    evaluationRevision: requiredText(binding.evaluationRevision, 'evaluation revision', skillName),
    evaluatedAt: requiredText(binding.evaluatedAt, 'evaluation timestamp', skillName),
    evaluatedModelIds,
    providerResolvedModelIds,
    runtimeVersion: requiredText(binding.runtimeVersion, 'evaluated Claude Code/runtime version', skillName),
    safetyRevision: requiredText(binding.safetyRevision, 'safety revision', skillName),
    rollbackTarget: requiredText(binding.rollbackTarget, 'last-known-good rollback target', skillName),
  };
}

function admissionHash(evidence: AdmittedClaudeSkill[]): string {
  const canonical = evidence
    .slice()
    .sort((a, b) => a.skillName.localeCompare(b.skillName))
    .map((item) => ({
      skillName: item.skillName,
      capabilityId: item.capabilityId,
      version: item.version,
      sourceSha256: item.sourceSha256,
      evaluationRevision: item.evaluationRevision,
      evaluatedAt: item.evaluatedAt,
      evaluatedModelIds: uniqueSorted(item.evaluatedModelIds),
      providerResolvedModelIds: uniqueSorted(item.providerResolvedModelIds),
      runtimeVersion: item.runtimeVersion,
      safetyRevision: item.safetyRevision,
      rollbackTarget: item.rollbackTarget,
    }));
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, skills: canonical })).digest('hex');
}

export async function resolveClaudeSkillAdmission(
  registry: CapabilityRegistry,
  input: ClaudeSkillAdmissionRequest,
): Promise<ClaudeSkillAdmission> {
  const requested = uniqueSorted(input.requestedSkills.map(assertSkillName));
  const declared = new Set(uniqueSorted(input.declaredTaskSkills.map(assertSkillName)));

  for (const skill of requested) {
    if (!declared.has(skill)) {
      throw new Error(`Claude skill ${skill} is not declared by the Goal Contract for this task.`);
    }
  }

  const bindingBySkill = new Map<string, string>();
  const capabilityOwner = new Map<string, string>();
  for (const raw of input.bindings) {
    const skillName = assertSkillName(raw.skillName);
    const capabilityId = raw.capabilityId.trim();
    if (!capabilityId) throw new Error(`Capability ID is required for Claude skill ${skillName}.`);
    const existing = bindingBySkill.get(skillName);
    if (existing && existing !== capabilityId) {
      throw new Error(`Claude skill ${skillName} has conflicting capability bindings.`);
    }
    const existingSkill = capabilityOwner.get(capabilityId);
    if (existingSkill && existingSkill !== skillName) {
      throw new Error(`Capability ${capabilityId} is bound to multiple Claude skill names (${existingSkill}, ${skillName}).`);
    }
    bindingBySkill.set(skillName, capabilityId);
    capabilityOwner.set(capabilityId, skillName);
  }

  const evidence: AdmittedClaudeSkill[] = [];
  for (const skillName of requested) {
    const capabilityId = bindingBySkill.get(skillName);
    if (!capabilityId) throw new Error(`Claude skill ${skillName} has no registered capability binding.`);

    const capability = await registry.get(capabilityId);
    if (!capability) throw new Error(`Claude skill ${skillName} capability is not registered: ${capabilityId}.`);
    if (capability.kind !== 'SKILL') {
      throw new Error(`Claude skill ${skillName} must bind to a SKILL capability; ${capabilityId} is ${capability.kind}.`);
    }

    const [readiness] = await registry.readiness([capabilityId]);
    if (!readiness?.ready) {
      const reasons: string[] = [];
      if (!readiness?.enabled) reasons.push('disabled');
      if (readiness?.missingChecks.length) reasons.push(`missing checks: ${readiness.missingChecks.join(', ')}`);
      if (readiness?.staleReasons.length) reasons.push(`stale/drifted: ${readiness.staleReasons.join(' | ')}`);
      throw new Error(`Claude skill ${skillName} is not READY (${capabilityId}): ${reasons.join('; ') || 'readiness failed'}.`);
    }

    evidence.push(assertProductionSkillEvidence(skillName, capability));
  }

  return {
    admittedSkills: requested,
    capabilityIds: evidence.map((item) => item.capabilityId),
    skillAdmissionHash: admissionHash(evidence),
    evidence,
  };
}

export async function compileCapabilityBoundClaudeEnvelope(
  registry: CapabilityRegistry,
  projectRoot: string,
  rawEnvelope: Record<string, unknown>,
  admissionRequest: ClaudeSkillAdmissionRequest,
): Promise<CapabilityBoundClaudeEnvelope> {
  const rawAdmitted = rawEnvelope.admittedSkills;
  if (Array.isArray(rawAdmitted) && rawAdmitted.length > 0) {
    throw new Error('Callers may not inject admittedSkills directly into a capability-bound Claude envelope. Resolve them from READY capability evidence.');
  }

  const skillAdmission = await resolveClaudeSkillAdmission(registry, admissionRequest);
  const compiled = compileClaudeToolEnvelope({
    ...rawEnvelope,
    admittedSkills: skillAdmission.admittedSkills,
  }, projectRoot);

  return {
    ...compiled,
    skillSetHash: skillAdmission.skillAdmissionHash,
    admittedSkills: skillAdmission.admittedSkills.slice(),
    skillAdmission,
  };
}
