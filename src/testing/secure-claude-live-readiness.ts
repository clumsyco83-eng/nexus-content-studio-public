import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import {
  buildSecureClaudeEnvironment,
  buildSecureClaudePrompt,
  defaultClaudeProcessRunner,
  executeSecureClaudeTask,
  type ClaudeProcessInvocation,
  type ClaudeProcessRunner,
  type ClaudeVersionReader,
  type SecureClaudeTaskContract,
} from '../claude/secure-executor.js';
import { parseClaudeStreamJson } from '../claude/runtime-evidence.js';
import { compileClaudeToolEnvelope } from '../claude/tool-envelope.js';
import { JsonFileStore } from '../storage/store.js';

const RESULT_TOKEN = 'NEXUS_CLAUDE_EXECUTOR_E2E_OK';
const MAX_COST_USD = 0.25;

export const LIVE_READINESS_STAGE = {
  preflightBinding: 91,
  trustedLauncher: 92,
  secureExecution: 93,
  runtimeEvidence: 94,
  exactResult: 95,
  authorityEnvelope: 96,
  unexpected: 97,
} as const;

type LiveReadinessStageCode = (typeof LIVE_READINESS_STAGE)[keyof typeof LIVE_READINESS_STAGE];

class LiveReadinessStageError extends Error {
  constructor(readonly stageCode: LiveReadinessStageCode) {
    super(`Claude live-readiness stage ${stageCode} failed.`);
    this.name = 'LiveReadinessStageError';
  }
}

function failStage(stageCode: LiveReadinessStageCode): never {
  throw new LiveReadinessStageError(stageCode);
}

export function classifyLiveReadinessError(error: unknown): LiveReadinessStageCode {
  return error instanceof LiveReadinessStageError ? error.stageCode : LIVE_READINESS_STAGE.unexpected;
}

interface ClaudeLauncher {
  command: string;
  prefixArgs: string[];
  kind: 'native' | 'npm-global';
}

function regularNonSymlinkFile(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function trustedClaudeLauncherCandidates(source: NodeJS.ProcessEnv = process.env): ClaudeLauncher[] {
  const candidates: ClaudeLauncher[] = [];
  if (source.USERPROFILE) {
    candidates.push({
      command: path.win32.join(source.USERPROFILE, '.local', 'bin', 'claude.exe'),
      prefixArgs: [],
      kind: 'native',
    });
  }
  if (source.APPDATA) {
    for (const entry of ['cli.js', 'cli.mjs']) {
      candidates.push({
        command: process.execPath,
        prefixArgs: [path.win32.join(source.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', entry)],
        kind: 'npm-global',
      });
    }
  }
  return candidates;
}

export function resolveTrustedClaudeLauncher(source: NodeJS.ProcessEnv = process.env): ClaudeLauncher {
  for (const candidate of trustedClaudeLauncherCandidates(source)) {
    if (candidate.kind === 'native' && regularNonSymlinkFile(candidate.command)) return candidate;
    if (candidate.kind === 'npm-global' && regularNonSymlinkFile(candidate.prefixArgs[0]!)) return candidate;
  }
  throw new Error('Trusted Claude Code launcher was not found in the fixed native or global-npm user installation locations.');
}

function fixedTask(): SecureClaudeTaskContract {
  return {
    id: 'nexus-claude-live-readiness',
    goalId: 'nexus-million-dollar-build',
    title: 'Prove bounded NEXUS to Claude Code execution',
    intent: `Return exactly ${RESULT_TOKEN} and nothing else. Do not use tools or access project files.`,
    acceptanceCriteria: [`Claude returns exactly ${RESULT_TOKEN}.`],
    verificationPlan: [`criterion:1:runtime-exact-result:${RESULT_TOKEN}`],
    allowedPaths: [],
    forbiddenPaths: ['.env', '.env.*', 'secrets/**', '.claude/**'],
    attempt: 1,
    maxTurns: 1,
    timeLimitMs: 120_000,
    tokenBudget: 2_000,
    costBudgetUsd: MAX_COST_USD,
  };
}

function fixedEnvelope(projectRoot: string) {
  return compileClaudeToolEnvelope({
    schemaVersion: 1,
    id: 'nexus-claude-live-readiness-v1',
    permissionMode: 'plan',
    availableBuiltInTools: [],
    admittedSkills: [],
    expectedMcpServers: [],
    expectedMcpTools: [],
    allowedWithoutPrompt: [],
    deniedRules: [],
    maxTurns: 1,
    maxBudgetUsd: MAX_COST_USD,
    noSessionPersistence: true,
    strictMcpConfig: true,
    disableChrome: true,
  }, projectRoot);
}

function selfTest(): void {
  const projectRoot = path.resolve('C:\\NEXUS-WORK\\nexus-content-studio-current-main');
  const task = fixedTask();
  const envelope = fixedEnvelope(projectRoot);
  const prompt = buildSecureClaudePrompt(task);
  assert.equal(task.maxTurns, 1);
  assert.equal(task.allowedPaths.length, 0);
  assert.equal(envelope.expectedRuntimeTools.length, 0);
  assert.equal(envelope.expectedMcpServers.length, 0);
  assert.equal(envelope.admittedSkills.length, 0);
  assert.ok(envelope.cliArgs.includes('--no-session-persistence'));
  assert.ok(envelope.cliArgs.includes('--strict-mcp-config'));
  assert.ok(envelope.cliArgs.includes('--no-chrome'));
  assert.match(prompt, /no project mutation authority is granted/i);
  assert.doesNotMatch(envelope.cliArgs.join(' '), /dangerously-skip-permissions|bypassPermissions/i);

  const fake = trustedClaudeLauncherCandidates({ USERPROFILE: 'C:\\Users\\test', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' });
  assert.equal(fake[0]?.command, 'C:\\Users\\test\\.local\\bin\\claude.exe');
  assert.ok(fake.some((item) => item.kind === 'npm-global' && item.prefixArgs[0]?.endsWith('claude-code\\cli.js')));

  const stageCodes = Object.values(LIVE_READINESS_STAGE);
  assert.equal(new Set(stageCodes).size, stageCodes.length);
  assert.deepEqual(stageCodes, [91, 92, 93, 94, 95, 96, 97]);
  assert.equal(classifyLiveReadinessError(new LiveReadinessStageError(91)), 91);
  assert.equal(classifyLiveReadinessError(new Error('unclassified')), 97);

  console.log('PASS Secure Claude live-readiness policy and bounded stage mapping: one turn, no project paths, no tools/skills/MCP, no bypass, fixed launcher locations, bounded cost, safe mode, numeric failure stages 91-97, and no raw live failure detail exposure.');
}

function launcherRunner(launcher: ClaudeLauncher): ClaudeProcessRunner {
  return async (invocation: ClaudeProcessInvocation) => defaultClaudeProcessRunner({
    ...invocation,
    command: launcher.command,
    args: [...launcher.prefixArgs, ...invocation.args],
  });
}

function launcherVersionReader(launcher: ClaudeLauncher): ClaudeVersionReader {
  return async () => {
    const result = await defaultClaudeProcessRunner({
      command: launcher.command,
      args: [...launcher.prefixArgs, '--version'],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
      env: buildSecureClaudeEnvironment(),
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
      throw new Error('Trusted Claude Code version probe failed.');
    }
    const version = result.stdout.trim() || result.stderr.trim();
    if (!version) throw new Error('Trusted Claude Code version probe returned no version text.');
    return version;
  };
}

async function liveProof(): Promise<void> {
  if (process.platform !== 'win32') failStage(LIVE_READINESS_STAGE.preflightBinding);

  const projectRoot = path.resolve(process.cwd());
  let expectedModel = '';
  let expectedVersion = '';

  try {
    const store = new JsonFileStore(path.join(projectRoot, 'data', 'nexus-db.json'));
    const db = await store.load();
    const capability = db.capabilities.find((item) => item.id === 'claude-executor');
    if (!capability?.enabled) failStage(LIVE_READINESS_STAGE.preflightBinding);
    const binding = capability.evidenceBinding;
    if (!binding) failStage(LIVE_READINESS_STAGE.preflightBinding);
    if (binding.providerResolvedModelIds.length !== 1) failStage(LIVE_READINESS_STAGE.preflightBinding);
    expectedModel = binding.providerResolvedModelIds[0]!.trim();
    expectedVersion = binding.runtimeVersion?.trim() ?? '';
    if (!expectedModel || !expectedVersion) failStage(LIVE_READINESS_STAGE.preflightBinding);
  } catch (error) {
    if (error instanceof LiveReadinessStageError) throw error;
    failStage(LIVE_READINESS_STAGE.preflightBinding);
  }

  let launcher: ClaudeLauncher;
  try {
    launcher = resolveTrustedClaudeLauncher();
  } catch {
    failStage(LIVE_READINESS_STAGE.trustedLauncher);
  }

  const task = fixedTask();
  const envelope = fixedEnvelope(projectRoot);
  let result;
  try {
    result = await executeSecureClaudeTask({
      task,
      envelope,
      projectRoot,
      requestedModel: expectedModel,
      expectedClaudeCodeVersion: expectedVersion,
      maxOutputBytes: 2 * 1024 * 1024,
    }, {
      runProcess: launcherRunner(launcher),
      readVersion: launcherVersionReader(launcher),
    });
  } catch {
    failStage(LIVE_READINESS_STAGE.secureExecution);
  }
  if (!result.workerSucceeded) failStage(LIVE_READINESS_STAGE.secureExecution);

  let evidence;
  try {
    evidence = parseClaudeStreamJson(result.rawStreamJson, {
      expectedResolvedModel: expectedModel,
      maxTurns: 1,
      maxCostUsd: MAX_COST_USD,
      allowedPermissionModes: ['plan'],
      expectedCwd: projectRoot,
      requireSuccess: true,
      expectedRuntimeTools: envelope.expectedRuntimeTools,
      expectedMcpServers: envelope.expectedMcpServers,
      expectedToolEnvelopeHash: envelope.envelopeHash,
      expectedSkillSetHash: envelope.skillSetHash,
      admittedSkills: envelope.admittedSkills,
    });
  } catch {
    failStage(LIVE_READINESS_STAGE.runtimeEvidence);
  }

  if (evidence.resultText?.trim() !== RESULT_TOKEN) failStage(LIVE_READINESS_STAGE.exactResult);
  if (evidence.tools.length || evidence.mcpServers.length || evidence.invokedSkills.length) {
    failStage(LIVE_READINESS_STAGE.authorityEnvelope);
  }

  console.log(JSON.stringify({
    ok: true,
    capability: 'nexus.claude.live-readiness',
    resolvedModel: evidence.resolvedModel,
    claudeCodeVersion: result.actualClaudeCodeVersion,
    turns: evidence.numTurns,
    costUsd: evidence.totalCostUsd,
    tools: evidence.tools,
    mcpServers: evidence.mcpServers.map((item) => item.name),
    skills: evidence.invokedSkills,
  }));
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  liveProof().catch((error) => {
    process.exitCode = classifyLiveReadinessError(error);
  });
}
