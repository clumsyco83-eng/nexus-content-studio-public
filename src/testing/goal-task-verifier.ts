import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StoredGoalTask } from '../goals/schema.js';
import { JsonFileStore } from '../storage/store.js';
import { captureWorkspaceSnapshot, verifyGoalTask } from '../verification/goal-task-verifier.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function task(overrides: Partial<StoredGoalTask> = {}): StoredGoalTask {
  return {
    id: 'verifier-task',
    goalId: 'verifier-goal',
    title: 'Verifier task',
    intent: 'Create exact bounded output.',
    worker: 'CLAUDE',
    state: 'VERIFYING',
    acceptanceCriteria: ['Output exists and contains the exact expected bytes.'],
    verificationPlan: [
      'criterion:1:required-file:src/generated/output.txt',
      'criterion:1:required-file-content:{"path":"src/generated/output.txt","content":"EXACT"}',
    ],
    dependencies: [],
    requiredCapabilities: [],
    allowedPaths: ['src/generated/**'],
    forbiddenPaths: ['.env', 'secrets/**'],
    riskClass: 'YELLOW',
    approvalRequirement: 'OWNER',
    idempotencyKey: 'verifier-task:v1',
    maxTurns: 5,
    maxRepairs: 2,
    timeLimitMs: 30_000,
    tokenBudget: 1_000,
    costBudgetUsd: 0.25,
    attempt: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

async function writeSupervision(root: string): Promise<void> {
  const reportDir = path.join(root, 'guardian');
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'latest.json'), JSON.stringify({
    status: 'GREEN',
    score: 100,
    summary: 'deterministic test guardian healthy',
    generatedAt: '2026-08-13T00:00:00.000Z',
    recommendations: [],
  }), 'utf8');
  await writeFile(path.join(reportDir, 'watchdog.json'), JSON.stringify({
    checkedAt: '2026-08-13T00:00:00.000Z',
    ok: true,
    consecutiveFailures: 0,
    action: 'none',
  }), 'utf8');
  process.env.NEXUS_GUARDIAN_REPORT_DIR = reportDir;
}

async function setupRepository(root: string): Promise<void> {
  git(root, 'init');
  git(root, 'config', 'user.email', 'nexus-ci@example.invalid');
  git(root, 'config', 'user.name', 'NEXUS CI');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), 'baseline\n', 'utf8');
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'settings.json'), '{"safe":true}\n', 'utf8');
  git(root, 'add', '.gitignore', 'README.md', '.claude/settings.json');
  git(root, 'commit', '-m', 'baseline');

  const tscDir = path.join(root, 'node_modules', 'typescript', 'bin');
  await mkdir(tscDir, { recursive: true });
  await writeFile(path.join(tscDir, 'tsc'), 'process.exit(0);\n', 'utf8');
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-verifier-'));
  const previousReportDir = process.env.NEXUS_GUARDIAN_REPORT_DIR;
  try {
    await setupRepository(root);
    await writeSupervision(root);
    const store = new JsonFileStore(path.join(root, 'nexus.json'));

    {
      const baseline = await captureWorkspaceSnapshot(root);
      await mkdir(path.join(root, 'src', 'generated'), { recursive: true });
      await writeFile(path.join(root, 'src', 'generated', 'output.txt'), 'EXACT', 'utf8');
      const result = await verifyGoalTask(task(), baseline, { projectRoot: root, store });
      assert.equal(result.passed, true, result.failure);
      assert.deepEqual(result.changedPaths, ['src/generated/output.txt']);
      assert.ok(result.evidence.every((item) => item.startsWith('PASS ')));
    }

    git(root, 'add', 'src/generated/output.txt');
    git(root, 'commit', '-m', 'accepted output');

    {
      // Strengthened historical behavior: even if a protected file was already
      // dirty at baseline, changing its contents again must be detected.
      await writeFile(path.join(root, '.claude', 'settings.json'), '{"safe":false,"phase":1}\n', 'utf8');
      const baseline = await captureWorkspaceSnapshot(root);
      assert.ok(Object.hasOwn(baseline.fingerprints, '.claude/settings.json'));
      await writeFile(path.join(root, '.claude', 'settings.json'), '{"safe":false,"phase":2}\n', 'utf8');
      const result = await verifyGoalTask(task({
        allowedPaths: ['.claude/**'],
        acceptanceCriteria: ['Protected settings must never be changed by the worker.'],
        verificationPlan: ['criterion:1:required-file:.claude/settings.json'],
      }), baseline, { projectRoot: root, store });
      assert.equal(result.passed, false);
      assert.ok(result.changedPaths.includes('.claude/settings.json'));
      assert.match(result.failure ?? '', /workspace-protected-paths/);
    }

    git(root, 'checkout', '--', '.claude/settings.json');

    {
      const baseline = await captureWorkspaceSnapshot(root);
      await writeFile(path.join(root, 'README.md'), 'worker touched outside allowlist\n', 'utf8');
      const result = await verifyGoalTask(task({
        acceptanceCriteria: ['README must remain unchanged.'],
        verificationPlan: ['criterion:1:required-file:README.md'],
      }), baseline, { projectRoot: root, store });
      assert.equal(result.passed, false);
      assert.match(result.failure ?? '', /workspace-allowed-paths/);
    }

    git(root, 'checkout', '--', 'README.md');

    {
      const baseline = await captureWorkspaceSnapshot(root);
      const result = await verifyGoalTask(task({
        acceptanceCriteria: ['Criterion one', 'Criterion two'],
        verificationPlan: ['criterion:1:required-file:README.md'],
        allowedPaths: [],
      }), baseline, { projectRoot: root, store });
      assert.equal(result.passed, false);
      assert.match(result.failure ?? '', /verification-plan/);
      assert.ok(result.evidence.some((item) => /criterion 2 has no machine-checkable/i.test(item)));
    }

    {
      const baseline = await captureWorkspaceSnapshot(root);
      const result = await verifyGoalTask(task({
        acceptanceCriteria: ['Arbitrary command must not run.'],
        verificationPlan: ['criterion:1:tests:powershell:anything'],
        allowedPaths: [],
      }), baseline, { projectRoot: root, store });
      assert.equal(result.passed, false);
      assert.ok(result.evidence.some((item) => /not in the fixed NEXUS verifier allowlist/i.test(item)));
    }

    {
      const reportDir = process.env.NEXUS_GUARDIAN_REPORT_DIR!;
      await writeFile(path.join(reportDir, 'watchdog.json'), JSON.stringify({ ok: false, consecutiveFailures: 2, action: 'none' }), 'utf8');
      const baseline = await captureWorkspaceSnapshot(root);
      const result = await verifyGoalTask(task({
        acceptanceCriteria: ['Existing output remains present.'],
        verificationPlan: ['criterion:1:required-file:src/generated/output.txt'],
        allowedPaths: [],
      }), baseline, { projectRoot: root, store });
      assert.equal(result.passed, false);
      assert.match(result.failure ?? '', /watchdog/);
    }

    console.log('PASS NEXUS Goal-task Verifier: exact criterion bindings, typecheck, GREEN Guardian/healthy Watchdog, allowed/forbidden/protected-path enforcement, pre-dirty fingerprint detection, exact file checks and fixed test allowlist.');
  } finally {
    if (previousReportDir === undefined) delete process.env.NEXUS_GUARDIAN_REPORT_DIR;
    else process.env.NEXUS_GUARDIAN_REPORT_DIR = previousReportDir;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
