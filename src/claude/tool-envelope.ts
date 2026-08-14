import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

export const CLAUDE_TOOL_ENVELOPE_MAX_BUDGET_USD = 25;
export const CLAUDE_TOOL_ENVELOPE_SETTING_SOURCES = 'project';

const simpleToolNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const permissionRuleSchema = z.string().min(1).max(300);
const mcpServerNameSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const mcpToolNameSchema = z.string().min(1).max(240).regex(/^mcp__[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const skillNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const claudeToolEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  permissionMode: z.enum(['dontAsk', 'plan']).default('dontAsk'),
  availableBuiltInTools: z.array(simpleToolNameSchema).max(40).default([]),
  admittedSkills: z.array(skillNameSchema).max(40).default([]),
  expectedMcpServers: z.array(mcpServerNameSchema).max(20).default([]),
  expectedMcpTools: z.array(mcpToolNameSchema).max(100).default([]),
  allowedWithoutPrompt: z.array(permissionRuleSchema).max(100).default([]),
  deniedRules: z.array(permissionRuleSchema).max(100).default([]),
  mcpConfigPath: z.string().min(1).max(500).optional(),
  maxTurns: z.number().int().min(1).max(40),
  maxBudgetUsd: z.number().positive().max(CLAUDE_TOOL_ENVELOPE_MAX_BUDGET_USD),
  noSessionPersistence: z.literal(true).default(true),
  strictMcpConfig: z.literal(true).default(true),
  disableChrome: z.literal(true).default(true),
}).strict();

export type ClaudeToolEnvelope = z.infer<typeof claudeToolEnvelopeSchema>;

export interface CompiledClaudeToolEnvelope {
  envelope: ClaudeToolEnvelope;
  envelopeHash: string;
  skillSetHash: string;
  admittedSkills: string[];
  cliArgs: string[];
  expectedRuntimeTools: string[];
  expectedMcpServers: string[];
  settingSources: readonly ['project'];
}

const forbiddenFlagFragments = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode bypassPermissions',
  '--permission-mode auto',
  '--permission-mode acceptEdits',
];

const v1ForbiddenDelegationTools = new Set(['agent', 'task']);
const mutationTools = new Set(['bash', 'powershell', 'edit', 'write', 'notebookedit']);
const unsupportedScopedMutationRules = new Set(['write', 'notebookedit']);

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function effectiveBuiltInTools(envelope: ClaudeToolEnvelope): string[] {
  return uniqueSorted([
    ...envelope.availableBuiltInTools,
    ...(envelope.admittedSkills.length > 0 ? ['Skill'] : []),
  ]);
}

function effectiveAllowedRules(envelope: ClaudeToolEnvelope): string[] {
  return uniqueSorted([
    ...envelope.allowedWithoutPrompt,
    ...envelope.admittedSkills.map((skill) => `Skill(${skill})`),
  ]);
}

function effectiveDeniedRules(envelope: ClaudeToolEnvelope): string[] {
  return uniqueSorted([
    ...envelope.deniedRules,
    ...(envelope.expectedMcpServers.length === 0 ? ['mcp__*'] : []),
    ...(envelope.admittedSkills.length === 0 ? ['Skill'] : []),
  ]);
}

function validateBuiltInTools(tools: readonly string[]): void {
  for (const tool of tools) {
    const lower = tool.toLowerCase();
    if (lower === 'default' || tool === '*' || lower.startsWith('mcp__')) {
      throw new Error(`Unsafe built-in tool declaration "${tool}". Use explicit built-in names and the MCP fields separately.`);
    }
    if (lower === 'skill') {
      throw new Error('Skill tool availability is derived from admittedSkills; callers may not expose Skill directly.');
    }
    if (v1ForbiddenDelegationTools.has(lower)) {
      throw new Error(`Claude delegation tool "${tool}" is not admitted by Tool Envelope v1. NEXUS needs nested envelope/budget/runtime evidence before subagent spawning can be enabled.`);
    }
  }
}

function permissionRuleBaseTool(rule: string): string {
  const index = rule.indexOf('(');
  return (index < 0 ? rule : rule.slice(0, index)).trim();
}

function permissionRuleSpecifier(rule: string): string | undefined {
  const start = rule.indexOf('(');
  if (start < 0 || !rule.endsWith(')')) return undefined;
  return rule.slice(start + 1, -1).trim();
}

function validateEditAutoApprovalRule(rule: string): void {
  const specifier = permissionRuleSpecifier(rule);
  if (!specifier) throw new Error(`Edit auto-approval rule "${rule}" must be path-scoped.`);
  const normalized = specifier.replace(/\\/g, '/');
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    throw new Error(`Edit auto-approval rule "${rule}" must use a single-leading-slash project-root path.`);
  }
  if (normalized === '/' || normalized === '/*' || normalized === '/**' || normalized === '/**/*') {
    throw new Error(`Edit auto-approval rule "${rule}" is too broad. Admit the narrow project paths required by the Goal Contract.`);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`Edit auto-approval rule "${rule}" may not contain parent traversal.`);
  }
  if (/^\/(?:\.git|\.claude|secrets?)(?:\/|$)/i.test(normalized) || /(^|\/)\.env(?:\.[^/]*)?(?:$|\/)/i.test(normalized)) {
    throw new Error(`Edit auto-approval rule "${rule}" targets protected/security-sensitive project state.`);
  }
}

function validateShellAutoApprovalRule(rule: string): void {
  const specifier = permissionRuleSpecifier(rule);
  if (!specifier) throw new Error(`Shell auto-approval rule "${rule}" must be command-scoped.`);
  if (specifier === '*' || /^\*\s*$/.test(specifier)) {
    throw new Error(`Broad shell auto-approval rule "${rule}" is forbidden. Scope it to a narrow command prefix.`);
  }
  const blocked = [
    /(^|\s)git\s+push\b/i,
    /(^|\s)git\s+reset\s+--hard\b/i,
    /(^|\s)git\s+clean\b/i,
    /(^|\s)rm\s+-[^\s]*r[^\s]*f\b/i,
    /\bRemove-Item\b.*\b-Recurse\b/i,
    /--dangerously-skip-permissions|--allow-dangerously-skip-permissions|bypassPermissions/i,
    /(^|\s)(?:shutdown|diskpart|format)(?:\.exe|\.com)?\b/i,
    /\b(?:Stop-Computer|Restart-Computer|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i,
    /(^|\s)(?:curl|wget)\b/i,
    /\b(?:Invoke-WebRequest|Invoke-RestMethod)\b/i,
  ];
  if (blocked.some((pattern) => pattern.test(specifier))) {
    throw new Error(`Shell auto-approval rule "${rule}" includes a command class that NEXUS does not pre-authorize.`);
  }
}

function validatePermissionRules(envelope: ClaudeToolEnvelope): void {
  const visible = new Set([...envelope.availableBuiltInTools, ...envelope.expectedMcpTools]);
  for (const rule of envelope.allowedWithoutPrompt) {
    const base = permissionRuleBaseTool(rule);
    if (base === 'Skill') {
      throw new Error(`Skill permission rule "${rule}" is forbidden here; declare exact admittedSkills and let NEXUS compile Skill(name) rules.`);
    }
    if (!visible.has(base)) throw new Error(`allowedWithoutPrompt rule "${rule}" references tool "${base}" that is not in the task envelope.`);

    const lowerBase = base.toLowerCase();
    if (mutationTools.has(lowerBase) && rule === base) {
      throw new Error(`Bare mutation-tool auto-approval rule "${rule}" is forbidden. Scope it to the task's bounded command/path or leave it denied by dontAsk.`);
    }
    if (lowerBase === 'edit') validateEditAutoApprovalRule(rule);
    if (unsupportedScopedMutationRules.has(lowerBase)) {
      throw new Error(`Use a project-root-scoped Edit(...) rule rather than ${base}(...) for file mutation approval.`);
    }
    if (lowerBase === 'bash' || lowerBase === 'powershell') validateShellAutoApprovalRule(rule);
    if (base.startsWith('mcp__') && /\*/.test(rule)) {
      throw new Error(`Wildcard MCP auto-approval rule "${rule}" is forbidden by NEXUS v1; admit exact MCP tools only.`);
    }
  }

  for (const rule of envelope.deniedRules) {
    if (!rule.trim()) throw new Error('Empty denied tool rule is invalid.');
    if (permissionRuleBaseTool(rule) === 'Skill') {
      throw new Error(`Skill deny rule "${rule}" is derived by NEXUS; callers may not define ad-hoc Skill rules.`);
    }
  }

  if (envelope.permissionMode === 'plan') {
    const editTools = envelope.availableBuiltInTools.filter((tool) => ['edit', 'write', 'notebookedit'].includes(tool.toLowerCase()));
    if (editTools.length) throw new Error(`Plan-mode envelope may not expose file mutation tools: ${editTools.join(', ')}.`);
    const mutationAllows = envelope.allowedWithoutPrompt.filter((rule) => mutationTools.has(permissionRuleBaseTool(rule).toLowerCase()));
    if (mutationAllows.length) throw new Error(`Plan-mode envelope may not pre-approve mutation rules: ${mutationAllows.join(', ')}.`);
  }
}

function validateSkills(envelope: ClaudeToolEnvelope): void {
  if (envelope.permissionMode !== 'dontAsk' && envelope.admittedSkills.length > 0) {
    throw new Error('Skill-admitted production envelopes must use dontAsk so non-admitted skills fail closed.');
  }
}

function mcpServerFromTool(tool: string): string | undefined {
  const match = /^mcp__([A-Za-z0-9][A-Za-z0-9_.-]*)__/.exec(tool);
  return match?.[1];
}

function denyRuleBlocksMcp(rule: string, server: string, tool: string): boolean {
  return rule === 'mcp__*' || rule === `mcp__${server}` || rule === `mcp__${server}__*` || rule === tool;
}

function validateMcpRelationships(envelope: ClaudeToolEnvelope): void {
  const servers = new Set(envelope.expectedMcpServers);
  for (const tool of envelope.expectedMcpTools) {
    const server = mcpServerFromTool(tool);
    if (!server || !servers.has(server)) throw new Error(`MCP tool "${tool}" does not belong to an explicitly expected MCP server.`);
    const conflictingDeny = envelope.deniedRules.find((rule) => denyRuleBlocksMcp(rule, server, tool));
    if (conflictingDeny) throw new Error(`MCP deny rule "${conflictingDeny}" conflicts with expected tool "${tool}".`);
  }

  if ((envelope.expectedMcpServers.length > 0 || envelope.expectedMcpTools.length > 0) && !envelope.mcpConfigPath) {
    throw new Error('An explicit project-local MCP config path is required whenever the envelope admits MCP servers/tools.');
  }
  if (envelope.mcpConfigPath && envelope.expectedMcpServers.length === 0) {
    throw new Error('mcpConfigPath was provided but no expectedMcpServers were declared. No-MCP tasks use strict MCP isolation without a config file.');
  }
  if (envelope.expectedMcpServers.length > 0 && envelope.expectedMcpTools.length === 0) {
    throw new Error('Every admitted MCP server must expose at least one explicitly named MCP tool in the task envelope.');
  }

  const autoApproved = new Set(envelope.allowedWithoutPrompt.map(permissionRuleBaseTool));
  const notExplicitlyAllowed = envelope.expectedMcpTools.filter((tool) => !autoApproved.has(tool));
  if (notExplicitlyAllowed.length) {
    throw new Error(`dontAsk MCP tools require exact allowedWithoutPrompt entries. Missing: ${notExplicitlyAllowed.join(', ')}.`);
  }
}

export function assertProjectRelativeMcpConfigPath(configPath: string, projectRoot: string): string {
  const trimmed = configPath.trim();
  if (!trimmed.toLowerCase().endsWith('.json')) throw new Error('MCP config path must point to a JSON file.');
  if (path.isAbsolute(trimmed)) throw new Error('MCP config path must be project-relative, not absolute.');
  const normalized = path.normalize(trimmed);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error('MCP config path may not escape the NEXUS project root.');
  if (/(^|[\\/])(?:\.env|secrets?|credentials?|settings\.local\.json)(?:[\\/]|$)/i.test(normalized)) {
    throw new Error('MCP config path may not point into secret/local-credential locations.');
  }
  const absolute = path.resolve(projectRoot, normalized);
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('MCP config path resolved outside the NEXUS project root.');
  }
  return normalized;
}

function canonicalSkillSet(envelope: ClaudeToolEnvelope): Record<string, unknown> {
  return { schemaVersion: 1, admittedSkills: uniqueSorted(envelope.admittedSkills) };
}

function canonicalEnvelope(envelope: ClaudeToolEnvelope): Record<string, unknown> {
  return {
    schemaVersion: envelope.schemaVersion,
    id: envelope.id,
    permissionMode: envelope.permissionMode,
    settingSources: [CLAUDE_TOOL_ENVELOPE_SETTING_SOURCES],
    availableBuiltInTools: effectiveBuiltInTools(envelope),
    admittedSkills: uniqueSorted(envelope.admittedSkills),
    expectedMcpServers: uniqueSorted(envelope.expectedMcpServers),
    expectedMcpTools: uniqueSorted(envelope.expectedMcpTools),
    allowedWithoutPrompt: effectiveAllowedRules(envelope),
    deniedRules: effectiveDeniedRules(envelope),
    mcpConfigPath: envelope.mcpConfigPath,
    maxTurns: envelope.maxTurns,
    maxBudgetUsd: envelope.maxBudgetUsd,
    noSessionPersistence: envelope.noSessionPersistence,
    strictMcpConfig: envelope.strictMcpConfig,
    disableChrome: envelope.disableChrome,
  };
}

export function claudeSkillSetHash(envelope: ClaudeToolEnvelope): string {
  return createHash('sha256').update(JSON.stringify(canonicalSkillSet(envelope))).digest('hex');
}

export function claudeToolEnvelopeHash(envelope: ClaudeToolEnvelope): string {
  return createHash('sha256').update(JSON.stringify(canonicalEnvelope(envelope))).digest('hex');
}

export function parseClaudeToolEnvelope(input: unknown, projectRoot: string): ClaudeToolEnvelope {
  const parsed = claudeToolEnvelopeSchema.parse(input);
  const envelope: ClaudeToolEnvelope = {
    ...parsed,
    availableBuiltInTools: uniqueSorted(parsed.availableBuiltInTools),
    admittedSkills: uniqueSorted(parsed.admittedSkills),
    expectedMcpServers: uniqueSorted(parsed.expectedMcpServers),
    expectedMcpTools: uniqueSorted(parsed.expectedMcpTools),
    allowedWithoutPrompt: uniqueSorted(parsed.allowedWithoutPrompt),
    deniedRules: uniqueSorted(parsed.deniedRules),
    mcpConfigPath: parsed.mcpConfigPath ? assertProjectRelativeMcpConfigPath(parsed.mcpConfigPath, projectRoot) : undefined,
  };

  validateBuiltInTools(envelope.availableBuiltInTools);
  validatePermissionRules(envelope);
  validateSkills(envelope);
  validateMcpRelationships(envelope);
  return envelope;
}

export function compileClaudeToolEnvelope(input: unknown, projectRoot: string): CompiledClaudeToolEnvelope {
  const envelope = parseClaudeToolEnvelope(input, projectRoot);
  const cliArgs: string[] = [];
  const builtInTools = effectiveBuiltInTools(envelope);
  const allowedRules = effectiveAllowedRules(envelope);
  const deniedRules = effectiveDeniedRules(envelope);

  cliArgs.push('--permission-mode', envelope.permissionMode);
  cliArgs.push('--setting-sources', CLAUDE_TOOL_ENVELOPE_SETTING_SOURCES);
  cliArgs.push('--tools', builtInTools.join(','));
  if (allowedRules.length) cliArgs.push('--allowedTools', ...allowedRules);
  if (deniedRules.length) cliArgs.push('--disallowedTools', ...deniedRules);

  if (envelope.strictMcpConfig) cliArgs.push('--strict-mcp-config');
  if (envelope.mcpConfigPath) cliArgs.push('--mcp-config', envelope.mcpConfigPath);
  if (envelope.noSessionPersistence) cliArgs.push('--no-session-persistence');
  if (envelope.disableChrome) cliArgs.push('--no-chrome');
  cliArgs.push('--max-turns', String(envelope.maxTurns));
  cliArgs.push('--max-budget-usd', envelope.maxBudgetUsd.toString());

  const joined = cliArgs.join(' ');
  for (const forbidden of forbiddenFlagFragments) {
    if (joined.includes(forbidden)) throw new Error(`Compiled Claude envelope unexpectedly contains forbidden flag fragment: ${forbidden}`);
  }

  return {
    envelope,
    envelopeHash: claudeToolEnvelopeHash(envelope),
    skillSetHash: claudeSkillSetHash(envelope),
    admittedSkills: envelope.admittedSkills.slice(),
    cliArgs,
    expectedRuntimeTools: uniqueSorted([...builtInTools, ...envelope.expectedMcpTools]),
    expectedMcpServers: envelope.expectedMcpServers.slice(),
    settingSources: [CLAUDE_TOOL_ENVELOPE_SETTING_SOURCES],
  };
}
