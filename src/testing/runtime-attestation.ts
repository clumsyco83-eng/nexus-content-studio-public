import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { attestClaudeRuntime } from '../capabilities/runtime-attestation.js';
import { JsonFileStore } from '../storage/store.js';

const expectedModel = 'claude-sonnet-test-20260813';
const expectedVersion = '2.1.0-test';
const expectedCwd = 'C:\\NEXUS-WORK\\nexus-content-studio';
const allowedTools = ['Read', 'Skill'];
const allowedMcpServers = ['nexus-safe-tools'];
const skillHash = 'b'.repeat(64);
const toolHash = 'a'.repeat(64);

type AttestationExpectation = Parameters<typeof attestClaudeRuntime>[3];

function claudeStream(input: {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  tools?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
  invokedSkill?: string;
  cost?: number;
  turns?: number;
  success?: boolean;
} = {}): string {
  const session = 'runtime-attestation-session';
  const success = input.success ?? true;
  const messages: unknown[] = [
    {
      type: 'system',
      subtype: 'init',
      session_id: session,
      model: input.model ?? expectedModel,
      permissionMode: input.permissionMode ?? 'default',
      cwd: input.cwd ?? expectedCwd,
      tools: input.tools ?? allowedTools,
      mcp_servers: input.mcpServers ?? [{ name: 'nexus-safe-tools', status: 'connected' }],
    },
  ];
  if (input.invokedSkill !== undefined) {
    messages.push({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: input.invokedSkill } }],
      },
    });
  }
  messages.push({
    type: 'result',
    subtype: success ? 'success' : 'error_during_execution',
    session_id: session,
    is_error: !success,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: input.turns ?? 5,
    total_cost_usd: input.cost ?? 0.03,
    result: success ? 'ok' : 'bounded worker failure',
  });
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function expectation(overrides: Partial<AttestationExpectation> = {}): AttestationExpectation {
  return {
    expectedResolvedModel: expectedModel,
    expectedClaudeCodeVersion: expectedVersion,
    actualClaudeCodeVersion: expectedVersion,
    maxTurns: 20,
    maxCostUsd: 0.1,
    expectedCwd,
    expectedRuntimeTools: allowedTools,
    expectedMcpServers: allowedMcpServers,
    expectedToolEnvelopeHash: toolHash,
    expectedSkillSetHash: skillHash,
    admittedSkills: ['memory-intelligence'],
    ...overrides,
  };
}

async function registerRuntime(registry: CapabilityRegistry, id: string, extraChecks: Array<'ROUTING_VERIFIED'> = []): Promise<void> {
  await registry.upsert({
    id,
    kind: 'RUNTIME',
    description: 'Test Claude executor runtime.',
    requiredChecks: [...extraChecks, 'RUNTIME_WIRED', 'SAFETY_VERIFIED'],
    passedChecks: [...extraChecks, 'RUNTIME_WIRED', 'SAFETY_VERIFIED'],
    enabled: true,
    evidence: ['initial known-good runtime'],
  });
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-runtime-attestation-'));
  try {
    const registry = new CapabilityRegistry(new JsonFileStore(path.join(root, 'nexus.json')));
    await registerRuntime(registry, 'claude-executor');

    const valid = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(valid.accepted, true);
    assert.equal(valid.capabilityReady, true);
    assert.equal(valid.runtime?.success, true);
    assert.deepEqual(valid.runtime?.invokedSkills, ['memory-intelligence']);
    await registry.assertReady(['claude-executor']);

    const modelDrift = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ model: 'claude-sonnet-test-20990101', invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(modelDrift.accepted, false);
    assert.deepEqual(new Set(modelDrift.readiness.missingChecks), new Set(['RUNTIME_WIRED', 'SAFETY_VERIFIED']));
    await assert.rejects(() => registry.assertReady(['claude-executor']), /not ready/i);

    const recovered = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(recovered.accepted, true);
    await registry.assertReady(['claude-executor']);

    const versionDrift = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation({ actualClaudeCodeVersion: '2.1.1-test' }),
    );
    assert.equal(versionDrift.accepted, false);
    assert.match(versionDrift.reason ?? '', /version drift/i);

    const versionRecovered = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(versionRecovered.accepted, true);

    const overBudget = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ cost: 0.2, invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(overBudget.accepted, false);
    assert.match(overBudget.reason ?? '', /cost budget/i);

    const budgetRecovered = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(budgetRecovered.accepted, true);

    const bypass = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ permissionMode: 'bypassPermissions', invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(bypass.accepted, false);
    assert.match(bypass.reason ?? '', /bypassPermissions/i);

    const permissionRecovered = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(permissionRecovered.accepted, true);

    const unexpectedTool = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ tools: ['Read', 'Skill', 'Bash'], invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(unexpectedTool.accepted, false);
    assert.match(unexpectedTool.reason ?? '', /tool-envelope drift/i);

    const toolRecovered = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(toolRecovered.accepted, true);

    const unexpectedMcp = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({
        mcpServers: [
          { name: 'nexus-safe-tools', status: 'connected' },
          { name: 'unknown-server', status: 'connected' },
        ],
        invokedSkill: 'memory-intelligence',
      }),
      expectation(),
    );
    assert.equal(unexpectedMcp.accepted, false);
    assert.match(unexpectedMcp.reason ?? '', /MCP-server drift/i);

    const mcpRecovered = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(mcpRecovered.accepted, true);

    const unauthorizedSkill = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'deep-research' }),
      expectation(),
    );
    assert.equal(unauthorizedSkill.accepted, false);
    assert.match(unauthorizedSkill.reason ?? '', /outside the admitted task set/i);

    const skillRecovered = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(skillRecovered.accepted, true);

    // A bounded task implementation failure is not runtime drift. Identity,
    // authority and budgets are healthy, so the Verifier/repair loop receives it.
    const taskFailure = await attestClaudeRuntime(
      registry,
      'claude-executor',
      claudeStream({ success: false, invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(taskFailure.accepted, true);
    assert.equal(taskFailure.runtime?.success, false);
    await registry.assertReady(['claude-executor']);

    // Fresh runtime evidence cannot bypass another missing capability check.
    await registerRuntime(registry, 'claude-not-routed', ['ROUTING_VERIFIED']);
    await registry.invalidateChecks('claude-not-routed', ['ROUTING_VERIFIED'], 'test missing routing proof');
    const validButNotFullyReady = await attestClaudeRuntime(
      registry,
      'claude-not-routed',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(validButNotFullyReady.accepted, false);
    assert.equal(validButNotFullyReady.readiness.missingChecks.includes('ROUTING_VERIFIED'), true);
    assert.equal(validButNotFullyReady.readiness.missingChecks.includes('RUNTIME_WIRED'), false);
    assert.equal(validButNotFullyReady.readiness.missingChecks.includes('SAFETY_VERIFIED'), false);

    // A capability that requires a current runtime observation is not READY
    // until attestation supplies a matching observed model/runtime lease.
    const evaluatedAt = new Date(Date.now() - 60_000).toISOString();
    await registry.upsert({
      id: 'claude-bound-runtime',
      kind: 'RUNTIME',
      description: 'Evidence-bound Claude runtime.',
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      passedChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      enabled: true,
      evidence: ['evaluated fixture'],
      evidenceBinding: {
        evaluationRevision: 'runtime-attestation-eval-v1',
        evaluatedAt,
        evaluatedModelIds: [expectedModel],
        providerResolvedModelIds: [expectedModel],
        runtimeVersion: expectedVersion,
        rollbackTarget: 'claude-runtime-lkg-test',
      },
      readinessPolicy: {
        requireSourceSha256: false,
        requireEvaluationRevision: true,
        requireExactModelIdentity: true,
        requireRuntimeVersion: true,
        requireSafetyRevision: false,
        requireRollbackTarget: true,
        requireRuntimeObservation: true,
        maxRuntimeObservationAgeHours: 1,
      },
    });
    const beforeBoundAttestation = (await registry.readiness(['claude-bound-runtime']))[0]!;
    assert.equal(beforeBoundAttestation.ready, false);
    assert.match(beforeBoundAttestation.staleReasons.join(' | '), /runtime observation/i);

    const boundValid = await attestClaudeRuntime(
      registry,
      'claude-bound-runtime',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(boundValid.accepted, true);
    const boundCapability = await registry.get('claude-bound-runtime');
    assert.deepEqual(boundCapability?.lastRuntimeObservation?.providerResolvedModelIds, [expectedModel]);
    assert.equal(boundCapability?.lastRuntimeObservation?.runtimeVersion, expectedVersion);
    await registry.assertReady(['claude-bound-runtime']);

    const staleCallerExpectation = await attestClaudeRuntime(
      registry,
      'claude-bound-runtime',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation({ expectedResolvedModel: 'claude-sonnet-test-20990101' }),
    );
    assert.equal(staleCallerExpectation.accepted, false);
    assert.match(staleCallerExpectation.reason ?? '', /not in the capability's evaluated provider-resolved model set/i);
    await assert.rejects(() => registry.assertReady(['claude-bound-runtime']), /not ready/i);

    const boundRecovered = await attestClaudeRuntime(
      registry,
      'claude-bound-runtime',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(boundRecovered.accepted, true);
    await registry.assertReady(['claude-bound-runtime']);

    // A runtime capability with an incomplete readiness policy is disabled so a
    // later scheduler cycle cannot route through a misconfigured READY record.
    await registry.upsert({
      id: 'claude-misconfigured',
      kind: 'RUNTIME',
      description: 'Misconfigured runtime.',
      requiredChecks: ['RUNTIME_WIRED'],
      passedChecks: ['RUNTIME_WIRED'],
      enabled: true,
      evidence: ['bad fixture'],
    });
    const misconfigured = await attestClaudeRuntime(
      registry,
      'claude-misconfigured',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(misconfigured.accepted, false);
    assert.equal(misconfigured.readiness.enabled, false);
    assert.match(misconfigured.reason ?? '', /misconfigured/i);
    await assert.rejects(() => registry.assertReady(['claude-misconfigured']), /not ready/i);

    const missingRuntime = await attestClaudeRuntime(
      registry,
      'claude-not-registered',
      claudeStream({ invokedSkill: 'memory-intelligence' }),
      expectation(),
    );
    assert.equal(missingRuntime.accepted, false);
    assert.equal(missingRuntime.readiness.ready, false);
    assert.match(missingRuntime.reason ?? '', /not registered/i);

    console.log('PASS NEXUS runtime attestation: runtime/authority drift revokes readiness, current observations renew the evaluated lease, stale caller configuration fails closed, ordinary task failure remains eligible for deterministic verification and repair, and policy misconfiguration is disabled.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
