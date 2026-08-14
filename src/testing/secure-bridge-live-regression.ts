import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { buildGuardianControlCenter } from '../guardian/control-center.js';
import { GoalRepository } from '../goals/repository.js';
import { GoalTaskApprovalRepository } from '../goals/task-approvals.js';
import { EmergencyStopStore } from '../safety/emergency-stop.js';
import { createNexusStore } from '../storage/factory.js';

interface LiveRegressionManifest {
  schemaVersion: 1;
  projectRoot: string;
  goalId: string;
  taskId: string;
  artifactPath: string;
  createdAt: string;
}

const ARTIFACT_DIR = 'secure-bridge-regression';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/target.txt`;
const INITIAL_CONTENT = 'PENDING';
const EXPECTED_CONTENT = 'VERIFIED';

function command(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function normalizeCase(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function manifestPath(): string {
  const local = process.env.LOCALAPPDATA?.trim();
  if (!local) throw new Error('LOCALAPPDATA is required for the real Windows Secure Bridge regression manifest.');
  return path.join(local, 'NEXUS', 'secure-bridge-live-regression.json');
}

async function readManifest(): Promise<LiveRegressionManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(), 'utf8')) as Partial<LiveRegressionManifest>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.projectRoot !== 'string' ||
      typeof parsed.goalId !== 'string' ||
      typeof parsed.taskId !== 'string' ||
      parsed.artifactPath !== ARTIFACT_PATH ||
      typeof parsed.createdAt !== 'string'
    ) throw new Error('Secure Bridge live-regression manifest is malformed; do not guess its ownership state.');
    return parsed as LiveRegressionManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeManifest(manifest: LiveRegressionManifest): Promise<void> {
  const file = manifestPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

function assertWindowsRepoRoot(): string {
  if (process.platform !== 'win32') throw new Error('The Secure Bridge live regression is intentionally Windows-only.');
  const cwd = path.resolve(process.cwd());
  const root = path.resolve(command(['rev-parse', '--show-toplevel'], cwd));
  if (normalizeCase(cwd) !== normalizeCase(root)) {
    throw new Error(`Run the live regression from the repository root. Current=${cwd}; root=${root}`);
  }
  const remote = command(['remote', 'get-url', 'origin'], root);
  if (!remote.includes('clumsyco83-eng/nexus-content-studio')) throw new Error(`Unexpected origin remote: ${remote}`);
  return root;
}

function assertCleanWorktree(root: string): void {
  const dirty = command(['status', '--porcelain=v1', '--untracked-files=all'], root);
  if (dirty) throw new Error(`Secure Bridge live regression requires a clean worktree before setup.\n${dirty}`);
}

function assertArtifactNotIgnored(root: string): void {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', ARTIFACT_PATH], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
    });
    throw new Error(`${ARTIFACT_PATH} is ignored by Git. The verifier requires visible worktree evidence; choose no substitute path manually.`);
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return;
    if (error instanceof Error && error.message.includes('is ignored by Git')) throw error;
    throw new Error(`git check-ignore failed while validating ${ARTIFACT_PATH}.`);
  }
}

async function assertPreflightReady(root: string, capabilityIds: string[]): Promise<void> {
  const store = createNexusStore();
  const capabilities = new CapabilityRegistry(store);
  const readiness = await capabilities.readiness(capabilityIds);
  const missing = readiness.filter((item) => !item.ready).map((item) => {
    const details = [
      item.enabled ? undefined : 'disabled',
      item.missingChecks.length ? `missing checks: ${item.missingChecks.join(', ')}` : undefined,
      ...item.staleReasons,
    ].filter((value): value is string => Boolean(value));
    return `${item.id}: ${details.join('; ') || 'not READY'}`;
  });
  if (missing.length) throw new Error(`Secure Bridge live regression blocked: required capabilities are not READY:\n${missing.join('\n')}`);

  const control = await buildGuardianControlCenter(await store.load());
  if (control.health.status !== 'GREEN') throw new Error(`Guardian must be GREEN before live regression (current=${control.health.status}).`);
  if (control.health.watchdogOk !== true) throw new Error('Watchdog must be explicitly healthy before live regression.');
  if (await new EmergencyStopStore().isActive()) throw new Error('Emergency stop is active; live regression is blocked.');

  const expectedVersion = process.env.NEXUS_CLAUDE_EXPECTED_CODE_VERSION?.trim();
  const requestedModel = process.env.NEXUS_CLAUDE_LIVE_SMOKE_MODEL?.trim();
  const resolvedModel = process.env.NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL?.trim();
  if (!expectedVersion || !requestedModel || !resolvedModel) {
    throw new Error('Live Claude version/requested-model/resolved-model evidence variables are incomplete. Run the bounded Claude live smoke/evidence gate first; do not guess values.');
  }
  const defaultModel = (process.env.NEXUS_CLAUDE_DEFAULT_MODEL ?? 'sonnet').trim();
  if (defaultModel !== requestedModel) {
    throw new Error(`NEXUS_CLAUDE_DEFAULT_MODEL (${defaultModel}) must match evaluated NEXUS_CLAUDE_LIVE_SMOKE_MODEL (${requestedModel}) for this regression.`);
  }
  if (normalizeCase(root) !== normalizeCase(process.cwd())) throw new Error('Repository root changed unexpectedly during preflight.');
}

async function setup(): Promise<void> {
  const root = assertWindowsRepoRoot();
  assertCleanWorktree(root);
  assertArtifactNotIgnored(root);
  if (await readManifest()) throw new Error(`A Secure Bridge live regression manifest already exists at ${manifestPath()}. Run status/cleanup instead of creating overlapping evidence.`);

  const claudeCapability = process.env.NEXUS_CLAUDE_RUNTIME_CAPABILITY_ID?.trim() || 'claude-executor';
  const verifierCapability = process.env.NEXUS_VERIFIER_CAPABILITY_ID?.trim() || 'nexus-verifier';
  await assertPreflightReady(root, [claudeCapability, verifierCapability]);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const goalId = `secure-bridge-live-${stamp}`;
  const taskId = `${goalId}-task`;
  const artifactAbsolute = path.join(root, ...ARTIFACT_PATH.split('/'));
  await mkdir(path.dirname(artifactAbsolute), { recursive: false });
  await writeFile(artifactAbsolute, INITIAL_CONTENT, { encoding: 'utf8', flag: 'wx' });

  const store = createNexusStore();
  const goals = new GoalRepository(store);
  try {
    await goals.createGoal({
      id: goalId,
      title: 'Secure Bridge real-host acceptance',
      objective: 'Prove owner-approved NEXUS -> bounded Claude -> runtime attestation -> independent Verifier -> checkpoint on the real Windows host.',
      successCriteria: ['Exact bounded artifact becomes VERIFIED and only the deterministic NEXUS Verifier certifies completion.'],
      priority: 1,
      budget: { maxTokens: 4_000, maxCostUsd: 0.5, maxTimeMs: 120_000 },
      nextAction: 'Run one Secure Bridge cycle; it must stop at WAITING_APPROVAL before any Claude provider execution.',
    });
    await goals.transitionGoal(goalId, 'WORKING');
    await goals.enqueueTask({
      id: taskId,
      goalId,
      title: 'Change only the bounded regression artifact',
      intent: `Edit only ${ARTIFACT_PATH}. Replace its exact current content ${JSON.stringify(INITIAL_CONTENT)} with ${JSON.stringify(EXPECTED_CONTENT)}. Do not modify any other file.`,
      worker: 'CLAUDE',
      acceptanceCriteria: [`${ARTIFACT_PATH} contains exactly ${JSON.stringify(EXPECTED_CONTENT)}.`],
      verificationPlan: [`criterion:1:required-file-content:${JSON.stringify({ path: ARTIFACT_PATH, content: EXPECTED_CONTENT })}`],
      requiredCapabilities: [claudeCapability, verifierCapability],
      allowedPaths: [ARTIFACT_PATH],
      forbiddenPaths: [
        '.claude/**', '.github/**', '.env', '.env.*',
        'src/guardian/**', 'src/safety/**', 'src/capabilities/**',
        'src/claude/**', 'src/orchestration/**', 'src/verification/**',
        'scripts/**',
      ],
      riskClass: 'YELLOW',
      approvalRequirement: 'OWNER',
      idempotencyKey: `${goalId}:bounded-artifact:v1`,
      maxTurns: 5,
      maxRepairs: 1,
      timeLimitMs: 60_000,
      tokenBudget: 4_000,
      costBudgetUsd: 0.5,
    });
  } catch (error) {
    try { await unlink(artifactAbsolute); } catch {}
    try { await rmdir(path.dirname(artifactAbsolute)); } catch {}
    try { await goals.transitionGoal(goalId, 'FAILED_SAFE', { nextAction: 'Inspect setup failure; do not reconstruct state manually.' }); } catch {}
    throw error;
  }

  const manifest: LiveRegressionManifest = {
    schemaVersion: 1,
    projectRoot: root,
    goalId,
    taskId,
    artifactPath: ARTIFACT_PATH,
    createdAt: new Date().toISOString(),
  };
  await writeManifest(manifest);
  process.stdout.write(`${JSON.stringify({
    ready: true,
    goalId,
    taskId,
    artifactPath: ARTIFACT_PATH,
    next: 'Run npm run secure-bridge:cycle. Expected outcome: WAITING_APPROVAL and zero Claude execution.',
  }, null, 2)}\n`);
}

async function status(): Promise<void> {
  const root = assertWindowsRepoRoot();
  const manifest = await readManifest();
  if (!manifest) throw new Error(`No active Secure Bridge live regression manifest exists at ${manifestPath()}.`);
  if (normalizeCase(root) !== normalizeCase(manifest.projectRoot)) throw new Error('Live regression manifest belongs to a different repository worktree.');

  const db = await createNexusStore().load();
  const goal = db.goals.find((item) => item.id === manifest.goalId);
  const task = db.goalTasks.find((item) => item.id === manifest.taskId && item.goalId === manifest.goalId);
  const approvals = db.goalTaskApprovals.filter((item) => item.taskId === manifest.taskId && item.goalId === manifest.goalId);
  const checkpoints = db.goalCheckpoints.filter((item) => item.taskId === manifest.taskId && item.goalId === manifest.goalId);
  const attempts = db.goalAttemptObservations.filter((item) => item.taskId === manifest.taskId && item.goalId === manifest.goalId);
  let artifact: { exists: boolean; content?: string; type?: string } = { exists: false };
  try {
    const stat = await lstat(path.join(root, ...ARTIFACT_PATH.split('/')));
    artifact = stat.isFile() && !stat.isSymbolicLink()
      ? { exists: true, content: await readFile(path.join(root, ...ARTIFACT_PATH.split('/')), 'utf8'), type: 'regular-file' }
      : { exists: true, type: stat.isSymbolicLink() ? 'symlink' : 'non-regular' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  process.stdout.write(`${JSON.stringify({ manifest, goal, task, approvals, checkpoints, attempts, artifact }, null, 2)}\n`);
}

async function cleanup(): Promise<void> {
  const root = assertWindowsRepoRoot();
  const manifest = await readManifest();
  if (!manifest) throw new Error(`No active Secure Bridge live regression manifest exists at ${manifestPath()}.`);
  if (normalizeCase(root) !== normalizeCase(manifest.projectRoot)) throw new Error('Live regression manifest belongs to a different repository worktree.');

  const db = await createNexusStore().load();
  const task = db.goalTasks.find((item) => item.id === manifest.taskId && item.goalId === manifest.goalId);
  if (!task) throw new Error('Regression task is missing from durable NEXUS state; do not delete evidence manually.');
  if (['WORKING', 'VERIFYING'].includes(task.state)) throw new Error(`Refusing cleanup while task is ${task.state}. Finish/fail-safe the execution first.`);
  if (!['COMPLETED', 'FAILED_SAFE', 'BLOCKED', 'CANCELLED'].includes(task.state)) {
    throw new Error(`Refusing cleanup while task is ${task.state}; preserve the artifact until the regression reaches a terminal/non-running state.`);
  }

  const artifactAbsolute = path.join(root, ...ARTIFACT_PATH.split('/'));
  try { await unlink(artifactAbsolute); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await rmdir(path.dirname(artifactAbsolute)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
  await unlink(manifestPath());

  process.stdout.write(`${JSON.stringify({
    cleaned: true,
    goalId: manifest.goalId,
    taskId: manifest.taskId,
    retained: 'All durable NEXUS goal/task/approval/attempt/checkpoint/audit records remain in the configured store.',
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const action = process.argv[2]?.trim().toLowerCase();
  if (action === 'setup') return setup();
  if (action === 'status') return status();
  if (action === 'cleanup') return cleanup();
  throw new Error('Usage: secure-bridge-live-regression.ts setup|status|cleanup');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
