import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { assertClaudeCodeVersion } from './runtime-evidence.js';
import type { CompiledClaudeToolEnvelope } from './tool-envelope.js';

export interface SecureClaudeTaskContract {
  id: string;
  goalId: string;
  title: string;
  intent: string;
  acceptanceCriteria: string[];
  verificationPlan: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  attempt: number;
  maxTurns: number;
  timeLimitMs: number;
  tokenBudget?: number;
  costBudgetUsd?: number;
}

export interface ClaudeProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: NodeJS.ProcessEnv;
}

export interface ClaudeProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
}

export type ClaudeProcessRunner = (invocation: ClaudeProcessInvocation) => Promise<ClaudeProcessResult>;
export type ClaudeVersionReader = () => Promise<string>;

export interface SecureClaudeExecutionInput {
  task: SecureClaudeTaskContract;
  envelope: CompiledClaudeToolEnvelope;
  projectRoot: string;
  requestedModel: string;
  expectedClaudeCodeVersion: string;
  maxOutputBytes?: number;
}

export interface SecureClaudeExecutionResult {
  attemptId: string;
  workerSucceeded: boolean;
  rawStreamJson: string;
  stderrTail: string;
  exitCode: number | null;
  durationMs: number;
  actualClaudeCodeVersion: string;
  requestedModel: string;
  toolEnvelopeHash: string;
  skillSetHash: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const HARD_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const SAFE_MODE_MIN_VERSION = [2, 1, 169] as const;
const FORBIDDEN_ARG_FRAGMENTS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
  '--add-dir',
];

/**
 * The bounded worker must not inherit the ambient NEXUS/laptop environment.
 * Keep only variables needed to start Claude Code on the current Windows host,
 * reach its normal user-scoped authentication, and use an explicitly configured
 * Anthropic endpoint/auth method. Other provider, GitHub, NEXUS, cloud, payment,
 * publishing, and unrelated application secrets are intentionally absent.
 */
const SECURE_CLAUDE_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'USERNAME',
  'USERDOMAIN',
  'LANG',
  'LC_ALL',
  'TERM',
  'NO_COLOR',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

export function buildSecureClaudeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sourceByLower = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) sourceByLower.set(key.toLowerCase(), value);
  }

  const env: NodeJS.ProcessEnv = {};
  for (const canonicalKey of SECURE_CLAUDE_ENV_ALLOWLIST) {
    const value = sourceByLower.get(canonicalKey.toLowerCase());
    if (value !== undefined) env[canonicalKey] = value;
  }

  // Fail closed on customizations and background network/update behavior for the
  // bounded worker. SAFE_MODE disables CLAUDE.md, plugins, skills, hooks and MCP.
  env.CLAUDE_CODE_SAFE_MODE = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.DISABLE_BUG_COMMAND = '1';
  return env;
}

function parseClaudeSemver(value: string): [number, number, number] {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+()])/);
  if (!match) throw new Error(`Unable to parse Claude Code semantic version from: ${value.trim() || '(empty)'}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function assertClaudeSafeModeSupported(value: string): void {
  const actual = parseClaudeSemver(value);
  for (let index = 0; index < SAFE_MODE_MIN_VERSION.length; index += 1) {
    if (actual[index]! > SAFE_MODE_MIN_VERSION[index]!) return;
    if (actual[index]! < SAFE_MODE_MIN_VERSION[index]!) {
      throw new Error(
        `Claude Code ${actual.join('.')} is below the Secure Bridge safe-mode minimum ${SAFE_MODE_MIN_VERSION.join('.')}. ` +
        'Upgrade Claude Code and refresh evaluated runtime evidence before live execution.',
      );
    }
  }
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.replace(/\u0000/g, '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds the ${maxLength}-character execution-contract limit.`);
  return normalized;
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function buildSecureClaudePrompt(task: SecureClaudeTaskContract): string {
  const title = boundedText(task.title, 'task.title', 240);
  const intent = boundedText(task.intent, 'task.intent', 10_000);
  const criteria = task.acceptanceCriteria.map((item, index) => boundedText(item, `acceptanceCriteria[${index}]`, 2_000));
  const verification = task.verificationPlan.map((item, index) => boundedText(item, `verificationPlan[${index}]`, 2_000));
  if (!criteria.length) throw new Error('At least one acceptance criterion is required for Claude execution.');
  if (!verification.length) throw new Error('At least one verification-plan item is required for Claude execution.');

  const allowed = uniquePaths(task.allowedPaths);
  const forbidden = uniquePaths(task.forbiddenPaths);
  const pathLines = [
    `Allowed project paths: ${allowed.length ? allowed.join(', ') : '(none; no project mutation authority is granted)'}`,
    `Forbidden project paths: ${forbidden.length ? forbidden.join(', ') : '(none declared by the task; NEXUS security defaults still apply)'}`,
  ];

  return [
    `NEXUS bounded Claude task ${task.id} for goal ${task.goalId}, execution attempt ${task.attempt}.`,
    '',
    `Title: ${title}`,
    '',
    'Intent:',
    intent,
    '',
    'Acceptance criteria:',
    ...criteria.map((item) => `- ${item}`),
    '',
    'Independent verification plan:',
    ...verification.map((item) => `- ${item}`),
    '',
    'NEXUS execution boundaries:',
    ...pathLines.map((item) => `- ${item}`),
    `- Maximum Claude turns: ${task.maxTurns}.`,
    `- Wall-clock execution limit: ${task.timeLimitMs} ms.`,
    task.costBudgetUsd === undefined ? '- Cost budget: governed by the compiled NEXUS envelope.' : `- Task cost budget: USD ${task.costBudgetUsd}.`,
    task.tokenBudget === undefined ? '- Token budget: governed by NEXUS runtime policy.' : `- Task token budget: ${task.tokenBudget}.`,
    '- Stay inside the supplied project working directory. Never use parent traversal or another directory.',
    '- Do not read secrets, credentials, tokens, cookies, recovery codes, or unrelated personal data.',
    '- Do not widen permissions, disable Guardian/Watchdog, change approval state, disable emergency stop, or alter NEXUS safety policy.',
    '- Do not publish, spend, change accounts/security settings, or control the computer unless the exact task contract and NEXUS envelope explicitly authorize that separate capability.',
    '- Your statement that the task is complete is not proof. A separate deterministic NEXUS Verifier will decide acceptance from machine evidence.',
    '- If the contract cannot be satisfied within these bounds, fail safely and report the blocker rather than bypassing a control.',
  ].filter(Boolean).join('\n');
}

function assertExecutionBounds(input: SecureClaudeExecutionInput): void {
  const { task, envelope } = input;
  if (!Number.isInteger(task.attempt) || task.attempt < 1) throw new Error('task.attempt must be a positive execution-attempt number.');
  if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1 || task.maxTurns > 40) throw new Error('task.maxTurns must be an integer from 1 to 40.');
  if (!Number.isInteger(task.timeLimitMs) || task.timeLimitMs < 1_000 || task.timeLimitMs > 86_400_000) {
    throw new Error('task.timeLimitMs must be an integer from 1000 to 86400000.');
  }
  if (envelope.envelope.maxTurns > task.maxTurns) {
    throw new Error(`Claude envelope turn limit ${envelope.envelope.maxTurns} exceeds task limit ${task.maxTurns}.`);
  }
  if (task.costBudgetUsd !== undefined && envelope.envelope.maxBudgetUsd > task.costBudgetUsd) {
    throw new Error(`Claude envelope budget USD ${envelope.envelope.maxBudgetUsd} exceeds task budget USD ${task.costBudgetUsd}.`);
  }
  if (!input.requestedModel.trim()) throw new Error('requestedModel is required.');
  if (!input.expectedClaudeCodeVersion.trim()) throw new Error('expectedClaudeCodeVersion is required.');
  if (!input.projectRoot.trim()) throw new Error('projectRoot is required.');
  const root = path.resolve(input.projectRoot);
  if (!path.isAbsolute(root)) throw new Error('projectRoot must resolve to an absolute path.');
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 64 * 1024 || maxOutputBytes > HARD_MAX_OUTPUT_BYTES) {
    throw new Error(`maxOutputBytes must be an integer from ${64 * 1024} to ${HARD_MAX_OUTPUT_BYTES}.`);
  }
}

export function buildSecureClaudeArgs(
  task: SecureClaudeTaskContract,
  envelope: CompiledClaudeToolEnvelope,
  requestedModel: string,
): string[] {
  const args = [
    '-p',
    buildSecureClaudePrompt(task),
    '--safe-mode',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    requestedModel.trim(),
    ...envelope.cliArgs,
  ];
  const joined = args.join(' ');
  for (const fragment of FORBIDDEN_ARG_FRAGMENTS) {
    if (joined.includes(fragment)) throw new Error(`Secure Claude invocation contains forbidden argument fragment: ${fragment}`);
  }
  return args;
}

export const defaultClaudeVersionReader: ClaudeVersionReader = async () => {
  const result = await defaultClaudeProcessRunner({
    command: 'claude',
    args: ['--version'],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
    env: buildSecureClaudeEnvironment(),
  });
  if (result.timedOut || result.outputLimitExceeded || result.exitCode !== 0) {
    throw new Error(`Unable to read Claude Code version safely (exit=${result.exitCode}, timedOut=${result.timedOut}, outputLimit=${result.outputLimitExceeded}).`);
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (!version) throw new Error('Claude Code version command returned no version text.');
  return version;
};

export const defaultClaudeProcessRunner: ClaudeProcessRunner = async (invocation) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: invocation.env,
  });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let settled = false;
  let timedOut = false;
  let outputLimitExceeded = false;

  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      exitCode,
      stdout,
      stderr,
      timedOut,
      outputLimitExceeded,
      durationMs: Date.now() - started,
    });
  };

  const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
    if (settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    outputBytes += buffer.byteLength;
    if (outputBytes > invocation.maxOutputBytes) {
      outputLimitExceeded = true;
      child.kill();
      finish(null);
      return;
    }
    if (target === 'stdout') stdout += buffer.toString('utf8');
    else stderr += buffer.toString('utf8');
  };

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    finish(null);
  }, invocation.timeoutMs);

  child.stdout?.on('data', (chunk) => append('stdout', chunk));
  child.stderr?.on('data', (chunk) => append('stderr', chunk));
  child.on('error', (error) => {
    stderr += `\nFailed to launch Claude Code: ${error.message}`;
    finish(null);
  });
  child.on('close', (code) => finish(code));
});

export async function executeSecureClaudeTask(
  input: SecureClaudeExecutionInput,
  dependencies: {
    runProcess?: ClaudeProcessRunner;
    readVersion?: ClaudeVersionReader;
  } = {},
): Promise<SecureClaudeExecutionResult> {
  assertExecutionBounds(input);
  const projectRoot = path.resolve(input.projectRoot);
  const runProcess = dependencies.runProcess ?? defaultClaudeProcessRunner;
  const readVersion = dependencies.readVersion ?? defaultClaudeVersionReader;
  const actualClaudeCodeVersion = (await readVersion()).trim();
  assertClaudeCodeVersion(actualClaudeCodeVersion, input.expectedClaudeCodeVersion);
  assertClaudeSafeModeSupported(actualClaudeCodeVersion);

  const args = buildSecureClaudeArgs(input.task, input.envelope, input.requestedModel);
  const processResult = await runProcess({
    command: 'claude',
    args,
    cwd: projectRoot,
    timeoutMs: input.task.timeLimitMs,
    maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    env: buildSecureClaudeEnvironment(),
  });

  return {
    attemptId: randomUUID(),
    workerSucceeded: processResult.exitCode === 0 && !processResult.timedOut && !processResult.outputLimitExceeded,
    rawStreamJson: processResult.stdout,
    stderrTail: processResult.stderr.slice(-4_000),
    exitCode: processResult.exitCode,
    durationMs: processResult.durationMs,
    actualClaudeCodeVersion,
    requestedModel: input.requestedModel.trim(),
    toolEnvelopeHash: input.envelope.envelopeHash,
    skillSetHash: input.envelope.skillSetHash,
    timedOut: processResult.timedOut,
    outputLimitExceeded: processResult.outputLimitExceeded,
  };
}
