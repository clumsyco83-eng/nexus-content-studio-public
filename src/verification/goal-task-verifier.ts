import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildGuardianControlCenter } from '../guardian/control-center.js';
import type { StoredGoalTask } from '../goals/schema.js';
import type { NexusStore } from '../storage/store.js';

export interface WorkspaceSnapshot {
  capturedAt: string;
  fingerprints: Record<string, string>;
}

export interface GoalTaskVerifierCheck {
  name: string;
  ok: boolean;
  details: string;
}

export interface GoalTaskVerifierResult {
  passed: boolean;
  evidence: string[];
  failure?: string;
  checks: GoalTaskVerifierCheck[];
  changedPaths: string[];
}

export interface GoalTaskVerifierOptions {
  projectRoot: string;
  store: NexusStore;
  protectedPatterns?: string[];
}

const DEFAULT_PROTECTED_PATTERNS = [
  '.claude/**',
  '.github/**',
  '.env',
  '.env.*',
  'src/guardian/**',
  'src/safety/**',
  'src/capabilities/**',
  'src/claude/**',
  'src/orchestration/**',
  'src/verification/**',
  'src/goals/task-approvals.ts',
  'scripts/reconcile-secure-bridge-v13.ps1',
  'scripts/secure-bridge-semantic-preflight.ps1',
  'scripts/windows-laptop-verify.ps1',
];

const ALLOWLISTED_TESTS: Record<string, string> = {
  'verify:system': 'src/testing/system-health.ts',
  'verify:controls': 'src/testing/operational-controls.ts',
  'verify:runtime-cycle': 'src/testing/runtime-cycle.ts',
  'verify:runtime-attestation': 'src/testing/runtime-attestation.ts',
  'verify:claude-tool-envelope': 'src/testing/claude-tool-envelope.ts',
  'verify:claude-skill-admission': 'src/testing/claude-skill-admission.ts',
  'verify:goals': 'src/testing/goal-engine.ts',
};

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function assertRelativeRule(rule: string): string {
  const normalized = normalizeRepoPath(rule);
  if (!normalized) throw new Error('Path rule cannot be blank.');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) throw new Error(`Absolute path rule is forbidden: ${rule}`);
  if (normalized.split('/').includes('..')) throw new Error(`Parent traversal is forbidden in path rule: ${rule}`);
  return normalized;
}

function regexEscape(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globRegex(rule: string): RegExp {
  const normalized = assertRelativeRule(rule);
  let pattern = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character !== '*') {
      pattern += regexEscape(character);
      continue;
    }
    if (normalized[index + 1] === '*') {
      pattern += '.*';
      index += 1;
    } else {
      pattern += '[^/]*';
    }
  }
  pattern += '$';
  return new RegExp(pattern, 'i');
}

function matchesAny(repoPath: string, rules: readonly string[]): boolean {
  const normalized = normalizeRepoPath(repoPath);
  return rules.some((rule) => globRegex(rule).test(normalized));
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; details: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, details: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, details: details.trim().slice(-4_000) || (ok ? 'passed' : 'failed without details') });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false, `Timed out after ${timeoutMs}ms.`);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => finish(false, error.message));
    child.on('close', (code) => finish(code === 0, code === 0 ? stdout : stderr || stdout));
  });
}

async function gitStatusPaths(projectRoot: string): Promise<string[]> {
  const result = await new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const child = spawn('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk) => out.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => err.push(Buffer.from(chunk)));
    child.on('error', (error) => resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.from(error.message) }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
  });
  if (result.code !== 0) throw new Error(`git status failed closed: ${result.stderr.toString('utf8').trim() || `exit ${result.code}`}`);
  const entries = result.stdout.toString('utf8').split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4) throw new Error('Malformed git porcelain status entry.');
    const status = entry.slice(0, 2);
    const repoPath = normalizeRepoPath(entry.slice(3));
    if (!repoPath) throw new Error('Git reported a blank worktree path.');
    paths.push(repoPath);
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

async function pathFingerprint(projectRoot: string, repoPath: string): Promise<string> {
  const absolute = path.resolve(projectRoot, repoPath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Git path escaped project root: ${repoPath}`);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return `symlink:${await readlink(absolute)}`;
    if (stat.isDirectory()) return 'directory';
    if (!stat.isFile()) return `other:${stat.mode}`;
    const bytes = await readFile(absolute);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

export async function captureWorkspaceSnapshot(projectRootInput: string): Promise<WorkspaceSnapshot> {
  const projectRoot = path.resolve(projectRootInput);
  const paths = await gitStatusPaths(projectRoot);
  const fingerprints: Record<string, string> = {};
  for (const repoPath of paths) fingerprints[repoPath] = await pathFingerprint(projectRoot, repoPath);
  return { capturedAt: new Date().toISOString(), fingerprints };
}

async function changedPathsSince(projectRoot: string, baseline: WorkspaceSnapshot): Promise<string[]> {
  const currentPaths = await gitStatusPaths(projectRoot);
  const candidates = [...new Set([...Object.keys(baseline.fingerprints), ...currentPaths])].sort((a, b) => a.localeCompare(b));
  const changed: string[] = [];
  for (const repoPath of candidates) {
    const before = baseline.fingerprints[repoPath] ?? 'clean';
    const now = currentPaths.includes(repoPath) ? await pathFingerprint(projectRoot, repoPath) : 'clean';
    if (before !== now) changed.push(repoPath);
  }
  return changed;
}

async function safeExistingFile(projectRoot: string, relativePath: string): Promise<string> {
  const normalized = assertRelativeRule(relativePath);
  if (normalized.includes('*')) throw new Error(`Verification file path may not contain wildcards: ${relativePath}`);
  const absolute = path.resolve(projectRoot, normalized);
  const relative = path.relative(projectRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Verification path escapes project root: ${relativePath}`);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Verification path must be a regular non-symlink file: ${relativePath}`);
  const canonicalRoot = await realpath(projectRoot);
  const real = await realpath(absolute);
  const realRelative = path.relative(canonicalRoot, real);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Verification file resolves outside project root: ${relativePath}`);
  }
  return real;
}

async function checkVerificationSpec(projectRoot: string, spec: string): Promise<GoalTaskVerifierCheck> {
  const separator = spec.indexOf(':');
  if (separator < 1) return { name: `unverifiable:${spec}`, ok: false, details: 'Verification plan item lacks a supported machine-checkable prefix.' };
  const kind = spec.slice(0, separator);
  const payload = spec.slice(separator + 1).trim();

  if (kind === 'required-file') {
    try {
      await safeExistingFile(projectRoot, payload);
      return { name: spec, ok: true, details: `${payload} exists as a regular project file.` };
    } catch (error) {
      return { name: spec, ok: false, details: error instanceof Error ? error.message : String(error) };
    }
  }

  if (kind === 'required-file-content') {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (typeof parsed.path !== 'string' || typeof parsed.content !== 'string') throw new Error('Payload must be JSON with string path and content fields.');
      const absolute = await safeExistingFile(projectRoot, parsed.path);
      const actual = await readFile(absolute, 'utf8');
      const ok = actual === parsed.content;
      return {
        name: spec,
        ok,
        details: ok ? `${parsed.path} content matches exactly.` : `${parsed.path} exact content mismatch (expected ${parsed.content.length} chars, got ${actual.length}).`,
      };
    } catch (error) {
      return { name: spec, ok: false, details: error instanceof Error ? error.message : String(error) };
    }
  }

  if (kind === 'tests') {
    const file = ALLOWLISTED_TESTS[payload];
    if (!file) return { name: spec, ok: false, details: `Test ${payload} is not in the fixed NEXUS verifier allowlist.` };
    const result = await runProcess(process.execPath, ['--import', 'tsx', file], projectRoot, 180_000);
    return { name: spec, ok: result.ok, details: result.details };
  }

  return { name: `unverifiable:${spec}`, ok: false, details: `Unsupported verification kind ${kind}. Supported: required-file, required-file-content, tests.` };
}

function parseCriterionVerificationPlan(task: StoredGoalTask): Array<{ criterionIndex: number; spec: string }> {
  const mapped: Array<{ criterionIndex: number; spec: string }> = [];
  for (const item of task.verificationPlan) {
    const match = /^criterion:(\d+):(.*)$/s.exec(item.trim());
    if (!match) throw new Error(`Verification plan item must bind to an acceptance criterion using criterion:<1-based-index>:<machine-check>: ${item}`);
    const criterionIndex = Number(match[1]);
    if (!Number.isInteger(criterionIndex) || criterionIndex < 1 || criterionIndex > task.acceptanceCriteria.length) {
      throw new Error(`Verification plan references invalid acceptance criterion index ${match[1]}.`);
    }
    const spec = match[2]!.trim();
    if (!spec) throw new Error(`Verification plan for criterion ${criterionIndex} is blank.`);
    mapped.push({ criterionIndex, spec });
  }
  for (let index = 1; index <= task.acceptanceCriteria.length; index += 1) {
    if (!mapped.some((item) => item.criterionIndex === index)) throw new Error(`Acceptance criterion ${index} has no machine-checkable verification-plan binding.`);
  }
  return mapped;
}

async function checkTypeScript(projectRoot: string): Promise<GoalTaskVerifierCheck> {
  const tsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = await runProcess(process.execPath, [tsc, '--noEmit'], projectRoot, 180_000);
  return { name: 'typecheck', ok: result.ok, details: result.ok ? 'TypeScript check passed.' : result.details };
}

async function checkSupervision(store: NexusStore): Promise<GoalTaskVerifierCheck[]> {
  const control = await buildGuardianControlCenter(await store.load());
  return [
    {
      name: 'guardian',
      ok: control.health.status === 'GREEN',
      details: `Guardian status=${control.health.status}; ${control.health.summary}`,
    },
    {
      name: 'watchdog',
      ok: control.health.watchdogOk === true,
      details: control.health.watchdogOk === true
        ? `Watchdog healthy at ${control.health.watchdogCheckedAt ?? 'unknown time'}.`
        : `Watchdog is not explicitly healthy (value=${String(control.health.watchdogOk)}).`,
    },
  ];
}

function checkPathAuthority(task: StoredGoalTask, changedPaths: string[], protectedPatterns: string[]): GoalTaskVerifierCheck[] {
  const allowed = task.allowedPaths.map(assertRelativeRule);
  const forbidden = task.forbiddenPaths.map(assertRelativeRule);
  const protectedRules = protectedPatterns.map(assertRelativeRule);
  const outsideAllowed = changedPaths.filter((repoPath) => allowed.length === 0 || !matchesAny(repoPath, allowed));
  const explicitlyForbidden = changedPaths.filter((repoPath) => matchesAny(repoPath, forbidden));
  const protectedTouched = changedPaths.filter((repoPath) => matchesAny(repoPath, protectedRules));
  return [
    {
      name: 'workspace-allowed-paths',
      ok: outsideAllowed.length === 0,
      details: outsideAllowed.length ? `Changed path(s) outside task allowedPaths: ${outsideAllowed.join(', ')}` : 'All changed paths are inside task allowedPaths.',
    },
    {
      name: 'workspace-forbidden-paths',
      ok: explicitlyForbidden.length === 0,
      details: explicitlyForbidden.length ? `Task changed explicitly forbidden path(s): ${explicitlyForbidden.join(', ')}` : 'No task forbiddenPaths were changed.',
    },
    {
      name: 'workspace-protected-paths',
      ok: protectedTouched.length === 0,
      details: protectedTouched.length ? `NEXUS safety/protected path(s) changed: ${protectedTouched.join(', ')}` : 'No NEXUS safety/protected paths were changed.',
    },
  ];
}

export async function verifyGoalTask(
  task: StoredGoalTask,
  baseline: WorkspaceSnapshot,
  options: GoalTaskVerifierOptions,
): Promise<GoalTaskVerifierResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const checks: GoalTaskVerifierCheck[] = [];
  let changedPaths: string[] = [];
  try {
    changedPaths = await changedPathsSince(projectRoot, baseline);
    checks.push(...checkPathAuthority(task, changedPaths, options.protectedPatterns ?? DEFAULT_PROTECTED_PATTERNS));
  } catch (error) {
    checks.push({ name: 'workspace-evidence', ok: false, details: error instanceof Error ? error.message : String(error) });
  }

  try {
    checks.push(await checkTypeScript(projectRoot));
  } catch (error) {
    checks.push({ name: 'typecheck', ok: false, details: error instanceof Error ? error.message : String(error) });
  }

  try {
    checks.push(...await checkSupervision(options.store));
  } catch (error) {
    checks.push({ name: 'supervision', ok: false, details: `Guardian/Watchdog evidence unavailable: ${error instanceof Error ? error.message : String(error)}` });
  }

  try {
    const plan = parseCriterionVerificationPlan(task);
    for (const item of plan) {
      const result = await checkVerificationSpec(projectRoot, item.spec);
      checks.push({
        ...result,
        name: `criterion:${item.criterionIndex}:${result.name}`,
        details: `Acceptance criterion ${item.criterionIndex} (${task.acceptanceCriteria[item.criterionIndex - 1]}): ${result.details}`,
      });
    }
  } catch (error) {
    checks.push({ name: 'verification-plan', ok: false, details: error instanceof Error ? error.message : String(error) });
  }

  const passed = checks.length > 0 && checks.every((check) => check.ok);
  const failed = checks.filter((check) => !check.ok);
  const evidence = checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.details}`);
  return {
    passed,
    evidence,
    failure: passed ? undefined : `${failed.length}/${checks.length} deterministic verification check(s) failed: ${failed.map((item) => item.name).join(', ')}.`,
    checks,
    changedPaths,
  };
}
