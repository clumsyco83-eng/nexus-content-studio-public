import assert from 'node:assert/strict';
import path from 'node:path';
import { compileClaudeToolEnvelope, parseClaudeToolEnvelope } from '../claude/tool-envelope.js';
import { parseClaudeStreamJson } from '../claude/runtime-evidence.js';

const projectRoot = path.resolve('C:\\NEXUS-WORK\\nexus-content-studio');

function safeEnvelope() {
  return {
    schemaVersion: 1,
    id: 'task:bounded-engineering-v1',
    permissionMode: 'dontAsk',
    availableBuiltInTools: ['Read', 'Edit', 'Write', 'Bash'],
    admittedSkills: [],
    allowedWithoutPrompt: ['Read', 'Edit(/src/**)', 'Bash(npm test *)'],
    deniedRules: ['Bash(git push *)', 'Bash(git reset --hard *)'],
    maxTurns: 20,
    maxBudgetUsd: 0.25,
    noSessionPersistence: true,
    strictMcpConfig: true,
    disableChrome: true,
  } as const;
}

function runtimeStream(overrides: {
  tools?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
  permissionMode?: string;
  invokedSkills?: string[];
  malformedSkillInvocation?: boolean;
} = {}): string {
  const sessionId = 'session-tool-envelope-1';
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-sonnet-4-20250514',
    permissionMode: overrides.permissionMode ?? 'dontAsk',
    cwd: projectRoot,
    tools: overrides.tools ?? ['Read', 'Edit', 'Write', 'Bash', 'EndConversation'],
    mcp_servers: overrides.mcpServers ?? [],
  };
  const messages: unknown[] = [init];
  for (const skill of overrides.invokedSkills ?? []) {
    messages.push({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'tool_use', id: `tool-${skill}`, name: 'Skill', input: { skill } }] },
    });
  }
  if (overrides.malformedSkillInvocation) {
    messages.push({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-bad', name: 'Skill', input: {} }] } });
  }
  messages.push({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 900,
    num_turns: 5,
    total_cost_usd: 0.04,
    result: 'bounded result',
  });
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

function valuesBetween(args: string[], startFlag: string, nextFlag: string): string[] {
  const start = args.indexOf(startFlag);
  if (start < 0) return [];
  const next = args.indexOf(nextFlag, start + 1);
  return args.slice(start + 1, next < 0 ? args.length : next);
}

function main(): void {
  const compiled = compileClaudeToolEnvelope(safeEnvelope(), projectRoot);
  assert.equal(compiled.envelope.permissionMode, 'dontAsk');
  assert.equal(compiled.envelopeHash.length, 64);
  assert.equal(compiled.skillSetHash.length, 64);
  assert.deepEqual(compiled.admittedSkills, []);
  assert.deepEqual(compiled.expectedRuntimeTools, ['Bash', 'Edit', 'Read', 'Write']);
  assert.deepEqual(compiled.expectedMcpServers, []);
  assert.deepEqual(compiled.settingSources, ['project']);
  assert.deepEqual(compiled.cliArgs.slice(0, 6), ['--permission-mode', 'dontAsk', '--setting-sources', 'project', '--tools', 'Bash,Edit,Read,Write']);
  assert.ok(compiled.cliArgs.includes('--strict-mcp-config'));
  assert.equal(compiled.cliArgs.includes('--mcp-config'), false);
  assert.ok(compiled.cliArgs.includes('--no-session-persistence'));
  assert.ok(compiled.cliArgs.includes('--no-chrome'));
  assert.ok(compiled.cliArgs.includes('--max-budget-usd'));
  assert.ok(compiled.cliArgs.includes('--max-turns'));
  assert.equal(compiled.cliArgs.some((arg) => arg.includes('dangerously-skip-permissions')), false);

  assert.deepEqual(
    valuesBetween(compiled.cliArgs, '--allowedTools', '--disallowedTools'),
    ['Bash(npm test *)', 'Edit(/src/**)', 'Read'],
  );
  const noMcpDenies = valuesBetween(compiled.cliArgs, '--disallowedTools', '--strict-mcp-config');
  assert.ok(noMcpDenies.includes('mcp__*'));
  assert.ok(noMcpDenies.includes('Skill'), 'Tasks without admitted skills must explicitly deny Skill as defense in depth.');

  const skillEnvelope = compileClaudeToolEnvelope({
    ...safeEnvelope(),
    id: 'task:deep-research-v1',
    admittedSkills: ['deep-research'],
  }, projectRoot);
  assert.deepEqual(skillEnvelope.admittedSkills, ['deep-research']);
  assert.deepEqual(skillEnvelope.expectedRuntimeTools, ['Bash', 'Edit', 'Read', 'Skill', 'Write']);
  assert.ok(valuesBetween(skillEnvelope.cliArgs, '--allowedTools', '--disallowedTools').includes('Skill(deep-research)'));
  assert.equal(valuesBetween(skillEnvelope.cliArgs, '--disallowedTools', '--strict-mcp-config').includes('Skill'), false);
  assert.notEqual(skillEnvelope.skillSetHash, compiled.skillSetHash);
  assert.notEqual(skillEnvelope.envelopeHash, compiled.envelopeHash);

  const reorderedSkills = compileClaudeToolEnvelope({
    ...safeEnvelope(),
    id: 'task:multi-skill-v1',
    admittedSkills: ['source-verification', 'deep-research'],
  }, projectRoot);
  const reorderedSkillsAgain = compileClaudeToolEnvelope({
    ...safeEnvelope(),
    id: 'task:multi-skill-v1',
    admittedSkills: ['deep-research', 'source-verification'],
  }, projectRoot);
  assert.equal(reorderedSkills.skillSetHash, reorderedSkillsAgain.skillSetHash, 'Skill-set identity must be order-independent.');
  assert.equal(reorderedSkills.envelopeHash, reorderedSkillsAgain.envelopeHash);

  const changedSkill = compileClaudeToolEnvelope({ ...safeEnvelope(), id: 'task:deep-research-v1', admittedSkills: ['knowledge-intelligence'] }, projectRoot);
  assert.notEqual(changedSkill.skillSetHash, skillEnvelope.skillSetHash, 'Changing admitted skills must change skill authority identity.');
  assert.notEqual(changedSkill.envelopeHash, skillEnvelope.envelopeHash);

  const reordered = compileClaudeToolEnvelope({
    ...safeEnvelope(),
    availableBuiltInTools: ['Bash', 'Write', 'Read', 'Edit'],
    allowedWithoutPrompt: ['Bash(npm test *)', 'Read', 'Edit(/src/**)'],
    deniedRules: ['Bash(git reset --hard *)', 'Bash(git push *)'],
  }, projectRoot);
  assert.equal(reordered.envelopeHash, compiled.envelopeHash);

  const changedAuthority = compileClaudeToolEnvelope({ ...safeEnvelope(), availableBuiltInTools: ['Read', 'Edit', 'Write', 'Bash', 'WebFetch'] }, projectRoot);
  assert.notEqual(changedAuthority.envelopeHash, compiled.envelopeHash);

  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), permissionMode: 'default' }, projectRoot));
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), availableBuiltInTools: ['default'] }, projectRoot), /Unsafe built-in tool declaration/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), availableBuiltInTools: ['*'] }, projectRoot));
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), availableBuiltInTools: ['Read', 'Skill'] }, projectRoot), /derived from admittedSkills/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), allowedWithoutPrompt: ['Skill(deep-research)'] }, projectRoot), /declare exact admittedSkills/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), deniedRules: ['Skill'] }, projectRoot), /derived by NEXUS/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), admittedSkills: ['Deep Research'] }, projectRoot));
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), availableBuiltInTools: ['Read', 'Agent'] }, projectRoot), /delegation tool/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), availableBuiltInTools: ['Read', 'Task'] }, projectRoot), /delegation tool/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), allowedWithoutPrompt: ['Bash'] }, projectRoot), /Bare mutation-tool auto-approval/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), allowedWithoutPrompt: ['Edit'] }, projectRoot), /Bare mutation-tool auto-approval/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), allowedWithoutPrompt: ['Edit(/**)'] }, projectRoot), /too broad/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), allowedWithoutPrompt: ['Write(/src/**)'] }, projectRoot), /Use a project-root-scoped Edit/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), allowedWithoutPrompt: ['Bash(git push *)'] }, projectRoot), /does not pre-authorize/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), maxTurns: 41 }, projectRoot), /less than or equal to 40/);
  assert.throws(() => parseClaudeToolEnvelope({ ...safeEnvelope(), maxBudgetUsd: 25.01 }, projectRoot), /less than or equal to 25/);

  assert.doesNotThrow(() => parseClaudeToolEnvelope({
    ...safeEnvelope(), permissionMode: 'plan', availableBuiltInTools: ['Read', 'Bash'], allowedWithoutPrompt: ['Read'],
  }, projectRoot));
  assert.throws(() => parseClaudeToolEnvelope({
    ...safeEnvelope(), permissionMode: 'plan', availableBuiltInTools: ['Read'], allowedWithoutPrompt: ['Read'], admittedSkills: ['deep-research'],
  }, projectRoot), /must use dontAsk/);

  const mcpEnvelope = compileClaudeToolEnvelope({
    schemaVersion: 1,
    id: 'task:readonly-mcp-v1',
    permissionMode: 'dontAsk',
    availableBuiltInTools: ['Read'],
    admittedSkills: [],
    expectedMcpServers: ['nexus-readonly'],
    expectedMcpTools: ['mcp__nexus-readonly__read', 'mcp__nexus-readonly__search'],
    allowedWithoutPrompt: ['Read', 'mcp__nexus-readonly__read', 'mcp__nexus-readonly__search'],
    deniedRules: [],
    mcpConfigPath: '.claude/mcp/nexus-readonly.json',
    maxTurns: 12,
    maxBudgetUsd: 0.1,
  }, projectRoot);
  assert.ok(mcpEnvelope.cliArgs.includes('--strict-mcp-config'));
  assert.ok(mcpEnvelope.cliArgs.includes('--mcp-config'));
  assert.deepEqual(mcpEnvelope.expectedMcpServers, ['nexus-readonly']);
  assert.deepEqual(mcpEnvelope.expectedRuntimeTools, ['mcp__nexus-readonly__read', 'mcp__nexus-readonly__search', 'Read']);
  assert.throws(() => parseClaudeToolEnvelope({ ...mcpEnvelope.envelope, deniedRules: ['mcp__*'] }, projectRoot), /conflicts with expected tool/);

  const evidence = parseClaudeStreamJson(runtimeStream(), {
    expectedResolvedModel: 'claude-sonnet-4-20250514', expectedCwd: projectRoot, maxTurns: 20, maxCostUsd: 0.25,
    allowedPermissionModes: ['dontAsk'], expectedRuntimeTools: compiled.expectedRuntimeTools, expectedMcpServers: [],
    expectedToolEnvelopeHash: compiled.envelopeHash, expectedSkillSetHash: compiled.skillSetHash, admittedSkills: compiled.admittedSkills,
  });
  assert.deepEqual(evidence.invokedSkills, []);
  assert.equal(evidence.skillSetHash, compiled.skillSetHash);

  const skillEvidence = parseClaudeStreamJson(runtimeStream({
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Skill'], invokedSkills: ['deep-research'],
  }), {
    expectedResolvedModel: 'claude-sonnet-4-20250514', expectedCwd: projectRoot, maxTurns: 20, maxCostUsd: 0.25,
    allowedPermissionModes: ['dontAsk'], expectedRuntimeTools: skillEnvelope.expectedRuntimeTools, expectedMcpServers: [],
    expectedToolEnvelopeHash: skillEnvelope.envelopeHash, expectedSkillSetHash: skillEnvelope.skillSetHash, admittedSkills: skillEnvelope.admittedSkills,
  });
  assert.deepEqual(skillEvidence.invokedSkills, ['deep-research']);
  assert.equal(skillEvidence.skillSetHash, skillEnvelope.skillSetHash);

  assert.throws(() => parseClaudeStreamJson(runtimeStream({
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Skill'], invokedSkills: ['knowledge-intelligence'],
  }), {
    expectedResolvedModel: 'claude-sonnet-4-20250514', expectedCwd: projectRoot, maxTurns: 20, maxCostUsd: 0.25,
    allowedPermissionModes: ['dontAsk'], expectedRuntimeTools: skillEnvelope.expectedRuntimeTools, expectedMcpServers: [],
    expectedToolEnvelopeHash: skillEnvelope.envelopeHash, expectedSkillSetHash: skillEnvelope.skillSetHash, admittedSkills: skillEnvelope.admittedSkills,
  }), /outside the admitted task set/);

  assert.throws(() => parseClaudeStreamJson(runtimeStream({
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Skill'], malformedSkillInvocation: true,
  }), {
    expectedResolvedModel: 'claude-sonnet-4-20250514', expectedCwd: projectRoot, maxTurns: 20, maxCostUsd: 0.25,
    allowedPermissionModes: ['dontAsk'], expectedRuntimeTools: skillEnvelope.expectedRuntimeTools, expectedMcpServers: [],
    expectedToolEnvelopeHash: skillEnvelope.envelopeHash, expectedSkillSetHash: skillEnvelope.skillSetHash, admittedSkills: skillEnvelope.admittedSkills,
  }), /missing a concrete skill name/);

  assert.throws(() => parseClaudeStreamJson(runtimeStream({ tools: ['Read', 'Edit', 'Write', 'Bash', 'Skill'] }), {
    expectedResolvedModel: 'claude-sonnet-4-20250514', expectedCwd: projectRoot, maxTurns: 20, maxCostUsd: 0.25,
    allowedPermissionModes: ['dontAsk'], expectedRuntimeTools: compiled.expectedRuntimeTools, expectedMcpServers: [],
    expectedToolEnvelopeHash: compiled.envelopeHash, expectedSkillSetHash: compiled.skillSetHash, admittedSkills: [],
  }), /unexpected \[Skill\]|no admitted skills/);

  assert.throws(() => parseClaudeStreamJson(runtimeStream({ permissionMode: 'default' }), {
    expectedResolvedModel: 'claude-sonnet-4-20250514', expectedCwd: projectRoot, maxTurns: 20, maxCostUsd: 0.25,
    allowedPermissionModes: ['dontAsk'], expectedRuntimeTools: compiled.expectedRuntimeTools, expectedMcpServers: [], admittedSkills: [],
  }), /permission mode/);

  console.log('PASS Claude task execution envelope: exact per-task Skill admission, skill-set identity, runtime skill invocation evidence, dontAsk/project-only isolation, scoped mutation controls, strict MCP semantics and authority drift rejection verified.');
}

main();
