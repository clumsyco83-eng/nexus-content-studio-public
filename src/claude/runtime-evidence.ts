import { z } from 'zod';

const initMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  model: z.string().min(1),
  permissionMode: z.string().min(1),
  cwd: z.string().min(1).optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()).optional(),
}).passthrough();

const resultMessageSchema = z.object({
  type: z.literal('result'), subtype: z.string().min(1), session_id: z.string().min(1), is_error: z.boolean(),
  duration_ms: z.number().nonnegative(), duration_api_ms: z.number().nonnegative(), num_turns: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(), result: z.string().optional(),
}).passthrough();

const floatingClaudeAliases = new Set(['default', 'sonnet', 'opus', 'haiku']);
const sha256Pattern = /^[a-f0-9]{64}$/i;

export interface ClaudeRuntimeExpectation {
  expectedResolvedModel: string;
  maxTurns: number;
  maxCostUsd: number;
  allowedPermissionModes?: readonly string[];
  expectedCwd?: string;
  requireSuccess?: boolean;
  expectedRuntimeTools?: readonly string[];
  expectedMcpServers?: readonly string[];
  expectedToolEnvelopeHash?: string;
  expectedSkillSetHash?: string;
  admittedSkills?: readonly string[];
}

export interface ClaudeRuntimeEvidence {
  sessionId: string;
  resolvedModel: string;
  permissionMode: string;
  cwd?: string;
  numTurns: number;
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  subtype: string;
  success: boolean;
  resultText?: string;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  toolEnvelopeHash?: string;
  skillSetHash?: string;
  invokedSkills: string[];
}

export class ClaudeRuntimeEvidenceError extends Error {
  constructor(message: string, public readonly kind: 'format' | 'identity' | 'permission' | 'budget' | 'execution') {
    super(message); this.name = 'ClaudeRuntimeEvidenceError';
  }
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new ClaudeRuntimeEvidenceError(`${name} must be a finite non-negative number.`, 'format');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function exactStringSetDifference(actualValues: readonly string[], expectedValues: readonly string[]) {
  const actual = uniqueSorted(actualValues);
  const expected = uniqueSorted(expectedValues);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((value) => !actualSet.has(value)),
    unexpected: actual.filter((value) => !expectedSet.has(value)),
  };
}

function assertRuntimeTools(actualTools: readonly string[], expectedTools: readonly string[]): void {
  const normalizedActual = actualTools.filter((tool) => tool !== 'EndConversation' || expectedTools.includes('EndConversation'));
  const difference = exactStringSetDifference(normalizedActual, expectedTools);
  if (difference.missing.length || difference.unexpected.length) {
    throw new ClaudeRuntimeEvidenceError(
      `Claude runtime tool-envelope drift detected. Missing [${difference.missing.join(', ')}]; unexpected [${difference.unexpected.join(', ')}].`,
      'permission',
    );
  }
}

function assertRuntimeMcpServers(actualServers: ReadonlyArray<{ name: string; status: string }>, expectedServerNames: readonly string[]): void {
  const actualNames = actualServers.map((server) => server.name);
  const difference = exactStringSetDifference(actualNames, expectedServerNames);
  if (difference.missing.length || difference.unexpected.length) {
    throw new ClaudeRuntimeEvidenceError(
      `Claude runtime MCP-server drift detected. Missing [${difference.missing.join(', ')}]; unexpected [${difference.unexpected.join(', ')}].`,
      'permission',
    );
  }
  const unhealthy = actualServers.filter((server) => expectedServerNames.includes(server.name) && server.status.toLowerCase() !== 'connected');
  if (unhealthy.length) {
    throw new ClaudeRuntimeEvidenceError(
      `Expected MCP server(s) are not connected: ${unhealthy.map((server) => `${server.name}=${server.status}`).join(', ')}.`,
      'permission',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectInvokedSkills(messages: readonly unknown[]): string[] {
  const invoked: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.type !== 'assistant' || !isRecord(message.message)) continue;
    const content = message.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'Skill') continue;
      if (!isRecord(block.input) || typeof block.input.skill !== 'string' || !block.input.skill.trim()) {
        throw new ClaudeRuntimeEvidenceError('Claude Skill tool invocation is missing a concrete skill name in input.skill.', 'format');
      }
      invoked.push(block.input.skill.trim());
    }
  }
  return uniqueSorted(invoked);
}

function assertInvokedSkills(invokedSkills: readonly string[], admittedSkills: readonly string[]): void {
  const admitted = new Set(admittedSkills);
  const unauthorized = invokedSkills.filter((skill) => !admitted.has(skill));
  if (unauthorized.length) {
    throw new ClaudeRuntimeEvidenceError(
      `Claude invoked skill(s) outside the admitted task set: ${uniqueSorted(unauthorized).join(', ')}.`,
      'permission',
    );
  }
}

export function isFloatingClaudeModelAlias(model: string): boolean { return floatingClaudeAliases.has(model.trim().toLowerCase()); }

export function assertResolvedClaudeModelId(model: string): string {
  const normalized = model.trim();
  if (!normalized) throw new ClaudeRuntimeEvidenceError('Expected resolved Claude model ID is required.', 'identity');
  if (isFloatingClaudeModelAlias(normalized)) throw new ClaudeRuntimeEvidenceError(`Expected resolved Claude model must be an exact evaluated model ID, not floating alias "${normalized}".`, 'identity');
  return normalized;
}

export function assertClaudeCodeVersion(actual: string, expected: string): void {
  const actualVersion = actual.trim(); const expectedVersion = expected.trim();
  if (!actualVersion || !expectedVersion) throw new ClaudeRuntimeEvidenceError('Both actual and expected Claude Code versions are required.', 'identity');
  if (actualVersion !== expectedVersion) throw new ClaudeRuntimeEvidenceError(`Claude Code version drift detected: actual "${actualVersion}" != evaluated "${expectedVersion}". Re-run the runtime/skill evaluation gates before READY.`, 'identity');
}

export function parseClaudeStreamJson(raw: string, expectation: ClaudeRuntimeExpectation): ClaudeRuntimeEvidence {
  const expectedResolvedModel = assertResolvedClaudeModelId(expectation.expectedResolvedModel);
  if (!Number.isInteger(expectation.maxTurns) || expectation.maxTurns < 1 || expectation.maxTurns > 100) throw new ClaudeRuntimeEvidenceError('maxTurns must be an integer from 1 to 100.', 'budget');
  requireFiniteNonNegative(expectation.maxCostUsd, 'maxCostUsd');
  if (expectation.expectedToolEnvelopeHash && !sha256Pattern.test(expectation.expectedToolEnvelopeHash)) {
    throw new ClaudeRuntimeEvidenceError('expectedToolEnvelopeHash must be a 64-character SHA-256 digest.', 'identity');
  }
  if (expectation.expectedSkillSetHash && !sha256Pattern.test(expectation.expectedSkillSetHash)) {
    throw new ClaudeRuntimeEvidenceError('expectedSkillSetHash must be a 64-character SHA-256 digest.', 'identity');
  }

  const messages: unknown[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim(); if (!trimmed) continue;
    try { messages.push(JSON.parse(trimmed)); } catch { throw new ClaudeRuntimeEvidenceError(`Claude stream line ${index + 1} is not valid JSON.`, 'format'); }
  }
  if (!messages.length) throw new ClaudeRuntimeEvidenceError('Claude stream contained no JSON messages.', 'format');
  const init = messages.map((m) => initMessageSchema.safeParse(m)).find((p) => p.success)?.data;
  const results = messages.map((m) => resultMessageSchema.safeParse(m)).filter((p) => p.success);
  const result = results.at(-1)?.data;
  if (!init) throw new ClaudeRuntimeEvidenceError('Claude stream is missing the system/init runtime identity message.', 'format');
  if (!result) throw new ClaudeRuntimeEvidenceError('Claude stream is missing the final result usage message.', 'format');
  if (init.session_id !== result.session_id) throw new ClaudeRuntimeEvidenceError('Claude init/result session IDs do not match.', 'identity');
  if (init.model !== expectedResolvedModel) throw new ClaudeRuntimeEvidenceError(`Claude resolved model drift detected: actual "${init.model}" != evaluated "${expectedResolvedModel}".`, 'identity');
  const allowedPermissionModes = expectation.allowedPermissionModes ?? ['default'];
  if (init.permissionMode === 'bypassPermissions') throw new ClaudeRuntimeEvidenceError('Claude runtime reported bypassPermissions; NEXUS execution must fail closed.', 'permission');
  if (!allowedPermissionModes.includes(init.permissionMode)) throw new ClaudeRuntimeEvidenceError(`Claude permission mode "${init.permissionMode}" is not approved for this task.`, 'permission');
  if (expectation.expectedCwd && init.cwd !== expectation.expectedCwd) throw new ClaudeRuntimeEvidenceError(`Claude working-directory drift detected: actual "${init.cwd ?? ''}" != expected "${expectation.expectedCwd}".`, 'identity');

  const actualTools = uniqueSorted(init.tools ?? []);
  const actualMcpServers = (init.mcp_servers ?? []).map((server) => ({ name: server.name, status: server.status }));
  if (expectation.expectedRuntimeTools !== undefined) assertRuntimeTools(actualTools, expectation.expectedRuntimeTools);
  if (expectation.expectedMcpServers !== undefined) assertRuntimeMcpServers(actualMcpServers, expectation.expectedMcpServers);

  const admittedSkills = uniqueSorted(expectation.admittedSkills ?? []);
  const invokedSkills = collectInvokedSkills(messages);
  assertInvokedSkills(invokedSkills, admittedSkills);
  if (admittedSkills.length === 0 && actualTools.includes('Skill')) {
    throw new ClaudeRuntimeEvidenceError('Claude runtime exposed the Skill tool for a task with no admitted skills.', 'permission');
  }
  if (admittedSkills.length > 0 && !actualTools.includes('Skill')) {
    throw new ClaudeRuntimeEvidenceError('Claude runtime is missing the Skill tool required by the admitted task skill set.', 'permission');
  }

  if (result.num_turns > expectation.maxTurns) throw new ClaudeRuntimeEvidenceError(`Claude exceeded turn budget: ${result.num_turns}/${expectation.maxTurns}.`, 'budget');
  if (result.total_cost_usd > expectation.maxCostUsd) throw new ClaudeRuntimeEvidenceError(`Claude exceeded cost budget: $${result.total_cost_usd.toFixed(6)} > $${expectation.maxCostUsd.toFixed(6)}.`, 'budget');
  const success = !result.is_error && result.subtype === 'success';
  if ((expectation.requireSuccess ?? true) && !success) throw new ClaudeRuntimeEvidenceError(`Claude execution did not complete successfully (subtype=${result.subtype}, is_error=${result.is_error}).`, 'execution');
  return {
    sessionId: result.session_id,
    resolvedModel: init.model,
    permissionMode: init.permissionMode,
    cwd: init.cwd,
    numTurns: result.num_turns,
    totalCostUsd: result.total_cost_usd,
    durationMs: result.duration_ms,
    durationApiMs: result.duration_api_ms,
    subtype: result.subtype,
    success,
    resultText: result.result,
    tools: actualTools,
    mcpServers: actualMcpServers,
    toolEnvelopeHash: expectation.expectedToolEnvelopeHash,
    skillSetHash: expectation.expectedSkillSetHash,
    invokedSkills,
  };
}
