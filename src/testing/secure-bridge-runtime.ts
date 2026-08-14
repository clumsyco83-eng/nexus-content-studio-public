import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { GoalAttemptObservationRepository } from '../goals/attempt-observations.js';
import { GoalRepository } from '../goals/repository.js';
import { GoalTaskApprovalRepository } from '../goals/task-approvals.js';
import { runRuntimeCycle } from '../orchestration/runtime-cycle.js';
import { SecureBridgeRuntimePorts, type SecureBridgeRuntimeOptions } from '../orchestration/secure-bridge-runtime.js';
import { EmergencyStopStore } from '../safety/emergency-stop.js';
import { JsonFileStore } from '../storage/store.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

async function writeSupervision(root: string): Promise<string> {
  const dir = path.join(root, 'guardian');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'latest.json'), JSON.stringify({
    status: 'GREEN',
    score: 100,
    summary: 'healthy deterministic test supervision',
    generatedAt: new Date().toISOString(),
    recommendations: [],
  }), 'utf8');
  await writeFile(path.join(dir, 'watchdog.json'), JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    action: 'none',
  }), 'utf8');
  return dir;
}

interface Harness {
  root: string;
  store: JsonFileStore;
  goals: GoalRepository;
  approvals: GoalTaskApprovalRepository;
  attempts: GoalAttemptObservationRepository;
  capabilities: CapabilityRegistry;
  emergencyStop: EmergencyStopStore;
  processCalls: { count: number };
  ports(overrides?: Partial<SecureBridgeRuntimeOptions>): SecureBridgeRuntimePorts;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-secure-bridge-runtime-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'nexus-ci@example.invalid');
  git(root, 'config', 'user.name', 'NEXUS CI');
  await writeFile(path.join(root, 'README.md'), 'baseline\n', 'utf8');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'baseline');

  process.env.NEXUS_GUARDIAN_REPORT_DIR = await writeSupervision(root);
  process.env.NEXUS_CLAUDE_DEFAULT_MODEL = 'sonnet';
  process.env.NEXUS_CLAUDE_ESCALATION_MODEL = 'opus';
  process.env.NEXUS_CLAUDE_REPAIR_ATTEMPTS_BEFORE_ESCALATION = '2';
  process.env.NEXUS_CLAUDE_MAX_REPAIR_ATTEMPTS = '5';
  process.env.NEXUS_CLAUDE_MAX_ESCALATIONS = '1';

  const store = new JsonFileStore(path.join(root, 'nexus.json'));
  const goals = new GoalRepository(store);
  const approvals = new GoalTaskApprovalRepository(store);
  const attempts = new GoalAttemptObservationRepository(store);
  const capabilities = new CapabilityRegistry(store);
  const emergencyStop = new EmergencyStopStore(path.join(root, 'emergency-stop.json'));
  const processCalls = { count: 0 };

  for (const id of ['claude-runtime', 'nexus-verifier']) {
    await capabilities.upsert({
      id,
      kind: 'RUNTIME',
      description: `${id} deterministic READY test capability`,
      requiredChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      passedChecks: ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
      evidence: ['RUNTIME_WIRED: deterministic Secure Bridge test harness', 'SAFETY_VERIFIED: no live provider authority'],
    });
  }

  await goals.createGoal({
    id: 'secure-bridge-goal',
    title: 'Secure Bridge runtime acceptance',
    objective: 'Prove NEXUS owns risk, approval, capability, execution, attestation, verification and checkpoint order.',
    successCriteria: ['No worker bypasses risk, approval, capability or verifier gates'],
    priority: 1,
  });
  await goals.transitionGoal('secure-bridge-goal', 'WORKING');

  const defaultOptions: SecureBridgeRuntimeOptions = {
    store,
    projectRoot: root,
    claudeRuntimeCapabilityId: 'claude-runtime',
    verifierCapabilityId: 'nexus-verifier',
    expectedResolvedModel: 'claude-sonnet-test-20260813',
    expectedClaudeCodeVersion: '2.1.169',
    emergencyStop,
    readClaudeVersion: async () => '2.1.169',
    runClaudeProcess: async () => {
      processCalls.count += 1;
      return {
        exitCode: 0,
        stdout: '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n',
        stderr: '',
        timedOut: false,
        outputLimitExceeded: false,
        durationMs: 50,
      };
    },
    attestRuntime: async (registry, capabilityId) => ({
      accepted: true,
      capabilityReady: true,
      readiness: (await registry.readiness([capabilityId]))[0]!,
    }),
    verifyTask: async () => ({
      passed: true,
      evidence: ['PASS deterministic-test: accepted'],
      checks: [{ name: 'deterministic-test', ok: true, details: 'accepted' }],
      changedPaths: [],
    }),
  };

  return {
    root,
    store,
    goals,
    approvals,
    attempts,
    capabilities,
    emergencyStop,
    processCalls,
    ports(overrides = {}) {
      return new SecureBridgeRuntimePorts({ ...defaultOptions, ...overrides });
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

async function enqueue(h: Harness, input: {
  id: string;
  riskClass?: 'GREEN' | 'YELLOW' | 'RED';
  approvalRequirement?: 'NONE' | 'OWNER';
  requiredCapabilities?: string[];
  allowedPaths?: string[];
  maxRepairs?: number;
  costBudgetUsd?: number;
}) {
  return h.goals.enqueueTask({
    id: input.id,
    goalId: 'secure-bridge-goal',
    title: input.id,
    intent: `Deterministic Secure Bridge test for ${input.id}.`,
    worker: 'CLAUDE',
    acceptanceCriteria: ['Bounded deterministic condition passes.'],
    verificationPlan: ['criterion:1:required-file:README.md'],
    requiredCapabilities: input.requiredCapabilities ?? ['claude-runtime', 'nexus-verifier'],
    allowedPaths: input.allowedPaths ?? [],
    forbiddenPaths: ['.claude/**', '.env'],
    riskClass: input.riskClass ?? 'GREEN',
    approvalRequirement: input.approvalRequirement ?? 'NONE',
    idempotencyKey: `secure-bridge:${input.id}:v1`,
    maxTurns: 5,
    maxRepairs: input.maxRepairs ?? 2,
    timeLimitMs: 30_000,
    costBudgetUsd: input.costBudgetUsd ?? 1,
  });
}

async function main() {
  const originalReportDir = process.env.NEXUS_GUARDIAN_REPORT_DIR;
  const originalDefault = process.env.NEXUS_CLAUDE_DEFAULT_MODEL;
  const originalEscalation = process.env.NEXUS_CLAUDE_ESCALATION_MODEL;
  const originalThreshold = process.env.NEXUS_CLAUDE_REPAIR_ATTEMPTS_BEFORE_ESCALATION;
  const originalMaxRepairs = process.env.NEXUS_CLAUDE_MAX_REPAIR_ATTEMPTS;
  const originalMaxEscalations = process.env.NEXUS_CLAUDE_MAX_ESCALATIONS;

  try {
    {
      const h = await createHarness();
      try {
        const task = await enqueue(h, { id: 'yellow-task', riskClass: 'YELLOW' });
        const ports = h.ports();
        const waiting = await runRuntimeCycle(ports);
        assert.equal(waiting.outcome, 'WAITING_APPROVAL');
        assert.equal(waiting.taskId, task.id);
        assert.equal(h.processCalls.count, 0, 'YELLOW may not call Claude before owner approval.');
        const approval = (await h.approvals.listPending()).find((item) => item.taskId === task.id)!;
        assert.equal(approval.executionAttempt, 1);
        await h.approvals.resolve({ approvalId: approval.id, decision: 'APPROVED', resolvedBy: 'owner' });
        const completed = await runRuntimeCycle(ports);
        assert.equal(completed.outcome, 'CHECKPOINTED');
        assert.equal(h.processCalls.count, 1);
        const db = await h.store.load();
        assert.equal(db.goalTasks.find((item) => item.id === task.id)?.state, 'COMPLETED');
        assert.equal(db.goalCheckpoints.some((item) => item.taskId === task.id), true);
      } finally { await h.cleanup(); }
    }

    {
      const h = await createHarness();
      try {
        const task = await enqueue(h, { id: 'red-task', riskClass: 'RED', approvalRequirement: 'OWNER' });
        const result = await runRuntimeCycle(h.ports());
        assert.equal(result.outcome, 'BLOCKED_RISK');
        assert.equal(h.processCalls.count, 0);
        assert.equal((await h.store.load()).goalTasks.find((item) => item.id === task.id)?.state, 'BLOCKED');
      } finally { await h.cleanup(); }
    }

    {
      const h = await createHarness();
      try {
        const task = await enqueue(h, {
          id: 'capability-task',
          requiredCapabilities: ['claude-runtime', 'nexus-verifier', 'later-capability'],
        });
        const ports = h.ports();
        const blocked = await runRuntimeCycle(ports);
        assert.equal(blocked.outcome, 'BLOCKED_CAPABILITY');
        assert.equal(blocked.taskId, task.id);
        assert.equal(h.processCalls.count, 0);
        await h.capabilities.upsert({
          id: 'later-capability',
          kind: 'RUNTIME',
          description: 'Capability becomes READY later',
          requiredChecks: ['RUNTIME_WIRED'],
          passedChecks: ['RUNTIME_WIRED'],
          evidence: ['RUNTIME_WIRED: deterministic resume test'],
        });
        const resumed = await runRuntimeCycle(ports);
        assert.equal(resumed.outcome, 'CHECKPOINTED');
        assert.ok(resumed.resumedTaskIds.includes(task.id));
        assert.equal(h.processCalls.count, 1);
      } finally { await h.cleanup(); }
    }

    {
      const h = await createHarness();
      try {
        const task = await enqueue(h, {
          id: 'repair-task',
          riskClass: 'YELLOW',
          approvalRequirement: 'OWNER',
          allowedPaths: ['src/generated/**'],
          maxRepairs: 2,
          costBudgetUsd: 2,
        });
        let verifierCalls = 0;
        const ports = h.ports({
          verifyTask: async () => {
            verifierCalls += 1;
            const pass = verifierCalls >= 2;
            return {
              passed: pass,
              evidence: [pass ? 'PASS deterministic-test: accepted' : 'FAIL deterministic-test: repair required'],
              failure: pass ? undefined : 'Deterministic acceptance criterion not met.',
              checks: [{ name: 'deterministic-test', ok: pass, details: pass ? 'accepted' : 'repair required' }],
              changedPaths: [],
            };
          },
        });
        assert.equal((await runRuntimeCycle(ports)).outcome, 'WAITING_APPROVAL');
        const approval1 = (await h.approvals.listPending()).find((item) => item.taskId === task.id)!;
        await h.approvals.resolve({ approvalId: approval1.id, decision: 'APPROVED', resolvedBy: 'owner' });
        assert.equal((await runRuntimeCycle(ports)).outcome, 'REPAIR_REQUIRED');
        assert.equal((await h.store.load()).goalTasks.find((item) => item.id === task.id)?.state, 'REPAIRING');
        assert.equal((await runRuntimeCycle(ports)).outcome, 'WAITING_APPROVAL');
        const approval2 = (await h.approvals.listPending()).find((item) => item.taskId === task.id)!;
        assert.equal(approval2.executionAttempt, 2);
        assert.notEqual(approval2.taskFingerprint, approval1.taskFingerprint);
        await h.approvals.resolve({ approvalId: approval2.id, decision: 'APPROVED', resolvedBy: 'owner' });
        assert.equal((await runRuntimeCycle(ports)).outcome, 'CHECKPOINTED');
      } finally { await h.cleanup(); }
    }

    {
      const h = await createHarness();
      try {
        const task = await enqueue(h, { id: 'interrupted-task' });
        await h.store.update((db) => {
          const current = db.goalTasks.find((item) => item.id === task.id)!;
          current.state = 'WORKING';
          current.attempt = 1;
        });
        const result = await runRuntimeCycle(h.ports());
        assert.equal(result.outcome, 'IDLE');
        assert.equal(h.processCalls.count, 0, 'Interrupted task must not replay provider execution.');
        const stored = (await h.store.load()).goalTasks.find((item) => item.id === task.id)!;
        assert.equal(stored.state, 'FAILED_SAFE');
        assert.match(stored.lastFailure ?? '', /INTERRUPTED_EXECUTION_UNATTESTED/);
      } finally { await h.cleanup(); }
    }

    {
      const h = await createHarness();
      try {
        const task = await enqueue(h, { id: 'unevaluated-escalation-task', maxRepairs: 5, costBudgetUsd: 2 });
        await h.store.update((db) => {
          const current = db.goalTasks.find((item) => item.id === task.id)!;
          current.state = 'REPAIRING';
          current.attempt = 3;
          current.lastFailure = 'Repeated deterministic verifier failure.';
        });
        for (const attemptNumber of [1, 2]) {
          await h.attempts.record({
            goalId: task.goalId,
            taskId: task.id,
            attemptNumber,
            strategyFingerprint: 'same-default-model-strategy',
            failureFingerprint: 'same-verifier-failure',
            verificationScore: 0,
            changedPaths: ['src/generated/x.txt'],
            costUsd: 0.1,
            elapsedMs: 100,
          });
        }
        await assert.rejects(() => runRuntimeCycle(h.ports()), /no exact evaluated resolved-model mapping/i);
        assert.equal(h.processCalls.count, 0, 'Unevaluated escalation must block before provider spend.');
        const stored = (await h.store.load()).goalTasks.find((item) => item.id === task.id)!;
        assert.equal(stored.state, 'BLOCKED');
        assert.match(stored.lastFailure ?? '', /EXECUTION_PREFLIGHT_BLOCKED/);
      } finally { await h.cleanup(); }
    }

    {
      const h = await createHarness();
      try {
        const task = await enqueue(h, { id: 'version-drift-task' });
        const ports = h.ports({
          readClaudeVersion: async () => '2.2.0',
          runClaudeProcess: async () => {
            h.processCalls.count += 1;
            throw new Error('Provider process must not launch after version drift.');
          },
        });
        await assert.rejects(() => runRuntimeCycle(ports), /version drift/i);
        assert.equal(h.processCalls.count, 0, 'Version drift must fail before Claude provider launch.');
        const stored = (await h.store.load()).goalTasks.find((item) => item.id === task.id)!;
        assert.equal(stored.state, 'FAILED_SAFE');
        assert.match(stored.lastFailure ?? '', /EXECUTOR_FAILED_SAFE/);
      } finally { await h.cleanup(); }
    }

    {
      const h = await createHarness();
      try {
        await enqueue(h, { id: 'emergency-stop-task' });
        await h.emergencyStop.activate('owner', 'deterministic test stop');
        const result = await runRuntimeCycle(h.ports());
        assert.equal(result.outcome, 'EMERGENCY_STOPPED');
        assert.equal(h.processCalls.count, 0);
      } finally { await h.cleanup(); }
    }

    console.log('PASS semantic Secure Bridge runtime: valid READY capability fixtures, emergency stop, RED block, YELLOW fingerprint approval, capability block/resume, bounded Claude, fresh retry approval, interrupted no-replay, unmapped escalation pre-spend block, version-drift fail-safe and durable checkpoint order.');
  } finally {
    if (originalReportDir === undefined) delete process.env.NEXUS_GUARDIAN_REPORT_DIR; else process.env.NEXUS_GUARDIAN_REPORT_DIR = originalReportDir;
    if (originalDefault === undefined) delete process.env.NEXUS_CLAUDE_DEFAULT_MODEL; else process.env.NEXUS_CLAUDE_DEFAULT_MODEL = originalDefault;
    if (originalEscalation === undefined) delete process.env.NEXUS_CLAUDE_ESCALATION_MODEL; else process.env.NEXUS_CLAUDE_ESCALATION_MODEL = originalEscalation;
    if (originalThreshold === undefined) delete process.env.NEXUS_CLAUDE_REPAIR_ATTEMPTS_BEFORE_ESCALATION; else process.env.NEXUS_CLAUDE_REPAIR_ATTEMPTS_BEFORE_ESCALATION = originalThreshold;
    if (originalMaxRepairs === undefined) delete process.env.NEXUS_CLAUDE_MAX_REPAIR_ATTEMPTS; else process.env.NEXUS_CLAUDE_MAX_REPAIR_ATTEMPTS = originalMaxRepairs;
    if (originalMaxEscalations === undefined) delete process.env.NEXUS_CLAUDE_MAX_ESCALATIONS; else process.env.NEXUS_CLAUDE_MAX_ESCALATIONS = originalMaxEscalations;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
