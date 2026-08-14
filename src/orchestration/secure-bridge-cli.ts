import 'dotenv/config';
import path from 'node:path';
import { createNexusStore } from '../storage/factory.js';
import { runRuntimeCycle } from './runtime-cycle.js';
import { SecureBridgeRuntimePorts } from './secure-bridge-runtime.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live Secure Bridge execution. Configure it only from the evaluated real-host route; do not guess.`);
  return value;
}

function optionalEscalationMapping(defaultModel: string): Record<string, string> {
  const escalationModel = process.env.NEXUS_CLAUDE_ESCALATION_MODEL?.trim();
  const resolved = process.env.NEXUS_CLAUDE_ESCALATION_EXPECTED_RESOLVED_MODEL?.trim();
  if (resolved && !escalationModel) {
    throw new Error('NEXUS_CLAUDE_ESCALATION_EXPECTED_RESOLVED_MODEL is set but NEXUS_CLAUDE_ESCALATION_MODEL is missing.');
  }
  if (!escalationModel || escalationModel === defaultModel) return {};
  if (!resolved) return {}; // runtime will block this route before provider spend if selected
  return { [escalationModel]: resolved };
}

async function main() {
  const expectedRequestedModel = requiredEnv('NEXUS_CLAUDE_LIVE_SMOKE_MODEL');
  const configuredDefaultModel = (process.env.NEXUS_CLAUDE_DEFAULT_MODEL ?? 'sonnet').trim();
  if (configuredDefaultModel !== expectedRequestedModel) {
    throw new Error(`NEXUS_CLAUDE_DEFAULT_MODEL (${configuredDefaultModel}) must match the currently evaluated NEXUS_CLAUDE_LIVE_SMOKE_MODEL (${expectedRequestedModel}) before the Secure Bridge live gate.`);
  }

  const approvalTtlMs = Number(process.env.NEXUS_GOAL_APPROVAL_TTL_MS ?? 30 * 60 * 1_000);
  if (!Number.isInteger(approvalTtlMs) || approvalTtlMs < 1_000 || approvalTtlMs > 24 * 60 * 60 * 1_000) {
    throw new Error('NEXUS_GOAL_APPROVAL_TTL_MS must be an integer from 1000 to 86400000.');
  }

  const store = createNexusStore();
  const ports = new SecureBridgeRuntimePorts({
    store,
    projectRoot: path.resolve(process.env.NEXUS_SECURE_BRIDGE_PROJECT_ROOT ?? process.cwd()),
    claudeRuntimeCapabilityId: process.env.NEXUS_CLAUDE_RUNTIME_CAPABILITY_ID?.trim() || 'claude-executor',
    verifierCapabilityId: process.env.NEXUS_VERIFIER_CAPABILITY_ID?.trim() || 'nexus-verifier',
    expectedResolvedModel: requiredEnv('NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL'),
    expectedResolvedModels: optionalEscalationMapping(configuredDefaultModel),
    expectedClaudeCodeVersion: requiredEnv('NEXUS_CLAUDE_EXPECTED_CODE_VERSION'),
    approvalTtlMs,
    approvalRequestedBy: 'nexus-secure-bridge',
  });

  const result = await runRuntimeCycle(ports);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome === 'FAILED_SAFE' || result.outcome === 'RUNTIME_REJECTED' || result.outcome === 'BLOCKED_RISK') {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
