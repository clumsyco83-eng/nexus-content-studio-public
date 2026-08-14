import { createHash } from 'node:crypto';
import path from 'node:path';
import { claudeModelPolicyFromEnv, chooseClaudeModel } from '../ai/model-routing.js';
import { attestClaudeRuntime, type ClaudeRuntimeAttestationResult } from '../capabilities/runtime-attestation.js';
import { capabilityReadiness, CapabilityRegistry } from '../capabilities/registry.js';
import { compileCapabilityBoundClaudeEnvelope, type CapabilityBoundClaudeEnvelope } from '../claude/skill-admission.js';
import {
  executeSecureClaudeTask,
  type ClaudeProcessRunner,
  type ClaudeVersionReader,
  type SecureClaudeExecutionResult,
  type SecureClaudeTaskContract,
} from '../claude/secure-executor.js';
import { buildGuardianControlCenter } from '../guardian/control-center.js';
import { GoalAttemptObservationRepository } from '../goals/attempt-observations.js';
import { GoalRepository } from '../goals/repository.js';
import { GoalResumeManager } from '../goals/resume-manager.js';
import type { StoredGoalTask } from '../goals/schema.js';
import { detectStuck } from '../goals/stuck-detector.js';
import {
  GoalTaskApprovalRepository,
  goalTaskRequiresOwnerApproval,
  nextGoalTaskExecutionAttempt,
} from '../goals/task-approvals.js';
import { EmergencyStopStore } from '../safety/emergency-stop.js';
import type { NexusStore } from '../storage/store.js';
import {
  captureWorkspaceSnapshot,
  verifyGoalTask,
  type GoalTaskVerifierResult,
  type WorkspaceSnapshot,
} from '../verification/goal-task-verifier.js';
import type {
  RuntimeAttestationResult,
  RuntimeCyclePorts,
  RuntimeCycleTask,
  RuntimeExecutionResult,
  RuntimeProgressDecision,
  RuntimeReplanResult,
  RuntimeVerificationResult,
} from './runtime-cycle.js';

export interface SecureBridgeRuntimeOptions {
  store: NexusStore;
  projectRoot: string;
  claudeRuntimeCapabilityId: string;
  verifierCapabilityId: string;
  /** Exact evaluated resolved ID for the configured default requested model. */
  expectedResolvedModel: string;
  /**
   * Optional exact requested-model -> evaluated resolved-model map. Any model
   * different from the configured default is blocked before provider execution
   * unless it appears here.
   */
  expectedResolvedModels?: Readonly<Record<string, string>>;
  expectedClaudeCodeVersion: string;
  emergencyStop?: EmergencyStopStore;
  approvalTtlMs?: number;
  approvalRequestedBy?: string;
  runClaudeProcess?: ClaudeProcessRunner;
  readClaudeVersion?: ClaudeVersionReader;
  /**
   * Optional bounded advisory replanner. When absent, a deterministic stuck
   * diagnosis STOPs safely instead of silently spending or inventing a strategy.
   */
  requestReplan?: (task: StoredGoalTask, reason: string) => Promise<RuntimeReplanResult>;
  /** Test seam only; production defaults to current runtime attestation. */
  attestRuntime?: typeof attestClaudeRuntime;
  /** Test seam only; production defaults to the independent Goal-task Verifier. */
  verifyTask?: typeof verifyGoalTask;
}

interface ExecutionRecord {
  task: StoredGoalTask;
  baseline: WorkspaceSnapshot;
  envelope: CapabilityBoundClaudeEnvelope;
  execution: SecureClaudeExecutionResult;
  expectedResolvedModel: string;
  attestation?: ClaudeRuntimeAttestationResult;
  verification?: GoalTaskVerifierResult;
  strategyFingerprint: string;
}

const ACTIVE_GOAL_STATES = new Set(['WORKING', 'VERIFYING', 'REPAIRING']);

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeAllowedPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized) throw new Error('Secure Bridge allowedPaths may not contain blank entries.');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Secure Bridge allowed path must be project-relative and traversal-free: ${value}`);
  }
  return normalized;
}

function strategyFingerprint(task: StoredGoalTask, requestedModel: string): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    requestedModel,
    intent: task.intent,
    acceptanceCriteria: task.acceptanceCriteria,
    verificationPlan: task.verificationPlan,
    allowedPaths: uniqueSorted(task.allowedPaths),
    forbiddenPaths: uniqueSorted(task.forbiddenPaths),
  })).digest('hex');
}

function failureFingerprint(failure: string | undefined): string | undefined {
  const value = failure?.trim();
  return value ? createHash('sha256').update(value).digest('hex') : undefined;
}

function cleanReason(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 1_800) || 'unknown fail-closed error';
}

function processFailureClass(execution: SecureClaudeExecutionResult): string | undefined {
  if (execution.timedOut) return 'claude-process-timeout';
  if (execution.outputLimitExceeded) return 'claude-process-output-limit';
  if (execution.exitCode !== 0) return `claude-process-exit-${execution.exitCode ?? 'unknown'}`;
  if (!execution.workerSucceeded) return 'claude-worker-non-success';
  return undefined;
}

function runtimeTask(task: StoredGoalTask): RuntimeCycleTask {
  return {
    id: task.id,
    goalId: task.goalId,
    title: task.title,
    riskClass: task.riskClass,
    requiresOwnerApproval: goalTaskRequiresOwnerApproval(task),
    requiredCapabilities: task.requiredCapabilities.slice(),
  };
}

export class SecureBridgeRuntimePorts implements RuntimeCyclePorts {
  private readonly projectRoot: string;
  private readonly registry: CapabilityRegistry;
  private readonly goals: GoalRepository;
  private readonly resumes: GoalResumeManager;
  private readonly approvals: GoalTaskApprovalRepository;
  private readonly attempts: GoalAttemptObservationRepository;
  private readonly emergencyStop: EmergencyStopStore;
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(private readonly options: SecureBridgeRuntimeOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.registry = new CapabilityRegistry(options.store);
    this.goals = new GoalRepository(options.store);
    this.resumes = new GoalResumeManager(options.store);
    this.approvals = new GoalTaskApprovalRepository(options.store);
    this.attempts = new GoalAttemptObservationRepository(options.store);
    this.emergencyStop = options.emergencyStop ?? new EmergencyStopStore();
    if (!options.claudeRuntimeCapabilityId.trim()) throw new Error('claudeRuntimeCapabilityId is required.');
    if (!options.verifierCapabilityId.trim()) throw new Error('verifierCapabilityId is required.');
    if (!options.expectedResolvedModel.trim()) throw new Error('expectedResolvedModel is required.');
    if (!options.expectedClaudeCodeVersion.trim()) throw new Error('expectedClaudeCodeVersion is required.');
    for (const [requested, resolved] of Object.entries(options.expectedResolvedModels ?? {})) {
      if (!requested.trim() || !resolved.trim()) throw new Error('expectedResolvedModels entries require non-empty requested and resolved model IDs.');
    }
  }

  private async storedTask(task: RuntimeCycleTask): Promise<StoredGoalTask> {
    const db = await this.options.store.load();
    const stored = db.goalTasks.find((item) => item.id === task.id && item.goalId === task.goalId);
    if (!stored) throw new Error(`Secure Bridge task disappeared: ${task.goalId}/${task.id}`);
    if (stored.worker !== 'CLAUDE') throw new Error(`Secure Bridge may execute only CLAUDE tasks; ${stored.id} is assigned to ${stored.worker}.`);
    return stored;
  }

  private async supervisionStatus(): Promise<{ ready: boolean; missing: string[] }> {
    try {
      const control = await buildGuardianControlCenter(await this.options.store.load());
      const missing: string[] = [];
      if (control.health.status !== 'GREEN') missing.push(`guardian:${control.health.status}`);
      if (control.health.watchdogOk !== true) missing.push('watchdog:not-healthy');
      return { ready: missing.length === 0, missing };
    } catch {
      return { ready: false, missing: ['guardian:unavailable', 'watchdog:unavailable'] };
    }
  }

  private expectedResolvedModelFor(requestedModel: string, defaultRequestedModel: string): string {
    const mapped = this.options.expectedResolvedModels?.[requestedModel]?.trim();
    if (mapped) return mapped;
    if (requestedModel !== defaultRequestedModel) {
      throw new Error(
        `Claude route ${requestedModel} is not authorized for live Secure Bridge execution because no exact evaluated resolved-model mapping is configured. ` +
        'Evaluate that route first or keep execution on the evaluated default model.',
      );
    }
    return this.options.expectedResolvedModel.trim();
  }

  private async blockBeforeExecution(task: StoredGoalTask, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.options.store.update((db) => {
      const current = db.goalTasks.find((item) => item.id === task.id && item.goalId === task.goalId);
      if (!current) return;
      if (!['READY', 'REPAIRING'].includes(current.state)) return;
      current.state = 'BLOCKED';
      current.lastFailure = `EXECUTION_PREFLIGHT_BLOCKED:${reason}`;
      current.updatedAt = now;
      const goal = db.goals.find((item) => item.id === current.goalId);
      if (goal) goal.updatedAt = now;
    });
  }

  private async failClosedInterruptedTasks(): Promise<void> {
    const activeTaskKeys = new Set([...this.records.values()].map((record) => `${record.task.goalId}\u0000${record.task.id}`));
    const now = new Date().toISOString();
    await this.options.store.update((db) => {
      for (const task of db.goalTasks) {
        if (task.worker !== 'CLAUDE' || !['WORKING', 'VERIFYING'].includes(task.state)) continue;
        if (activeTaskKeys.has(`${task.goalId}\u0000${task.id}`)) continue;
        task.state = 'FAILED_SAFE';
        task.lastFailure = 'INTERRUPTED_EXECUTION_UNATTESTED: previous Secure Bridge process ended before the bounded execution/attestation/verification cycle could durably complete; no automatic replay was attempted.';
        task.updatedAt = now;
        const goal = db.goals.find((item) => item.id === task.goalId);
        if (goal) {
          goal.failedAttempts += 1;
          goal.updatedAt = now;
        }
      }
    });
  }

  async isEmergencyStopped(): Promise<boolean> {
    return this.emergencyStop.isActive();
  }

  async resumeEligibleTasks(): Promise<string[]> {
    await this.failClosedInterruptedTasks();
    const resumedGoals = await this.resumes.resumeEligible();
    const supervision = await this.supervisionStatus();
    const now = new Date().toISOString();
    const resumedTasks = await this.options.store.update((db) => {
      const resumed: string[] = [];
      if (!supervision.ready) return resumed;
      for (const task of db.goalTasks) {
        if (task.worker !== 'CLAUDE' || task.state !== 'BLOCKED' || !task.lastFailure?.startsWith('CAPABILITY_BLOCKED:')) continue;
        const required = uniqueSorted([
          ...task.requiredCapabilities,
          this.options.claudeRuntimeCapabilityId,
          this.options.verifierCapabilityId,
        ]);
        const ready = required.every((id) => {
          const capability = db.capabilities.find((item) => item.id === id);
          return Boolean(capability && capabilityReadiness(capability).ready);
        });
        if (!ready) continue;
        task.state = 'READY';
        task.lastFailure = undefined;
        task.updatedAt = now;
        resumed.push(task.id);
      }
      return resumed;
    });
    return [...resumedTasks, ...resumedGoals.map((item) => `goal:${item.goalId}`)];
  }

  async nextReadyTask(): Promise<RuntimeCycleTask | undefined> {
    const db = await this.options.store.load();
    const candidates = db.goalTasks
      .filter((task) => {
        if (task.worker !== 'CLAUDE' || !['READY', 'REPAIRING'].includes(task.state)) return false;
        const goal = db.goals.find((item) => item.id === task.goalId);
        return Boolean(goal && ACTIVE_GOAL_STATES.has(goal.state));
      })
      .sort((a, b) => {
        const goalA = db.goals.find((goal) => goal.id === a.goalId)?.priority ?? 100;
        const goalB = db.goals.find((goal) => goal.id === b.goalId)?.priority ?? 100;
        return goalA - goalB || a.createdAt.localeCompare(b.createdAt);
      });
    return candidates[0] ? runtimeTask(candidates[0]) : undefined;
  }

  async markRiskBlocked(task: RuntimeCycleTask, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.options.store.update((db) => {
      const stored = db.goalTasks.find((item) => item.id === task.id && item.goalId === task.goalId);
      if (!stored) throw new Error(`Unknown task ${task.id}.`);
      if (!['READY', 'REPAIRING'].includes(stored.state)) throw new Error(`Cannot risk-block task ${stored.id} from ${stored.state}.`);
      stored.state = 'BLOCKED';
      stored.lastFailure = `RISK_BLOCKED:${reason.trim()}`;
      stored.updatedAt = now;
    });
  }

  async approvalStatus(task: RuntimeCycleTask) {
    const stored = await this.storedTask(task);
    if (stored.riskClass === 'RED') return { approved: false, reason: 'RED tasks are non-executable.' };
    return this.approvals.validateForTask(stored.goalId, stored.id);
  }

  async markWaitingApproval(task: RuntimeCycleTask, reason: string): Promise<void> {
    const stored = await this.storedTask(task);
    await this.approvals.requestForTask({
      goalId: stored.goalId,
      taskId: stored.id,
      requestedBy: this.options.approvalRequestedBy?.trim() || 'nexus-runtime',
      reason,
      ttlMs: this.options.approvalTtlMs ?? 30 * 60 * 1_000,
    });
  }

  async capabilitiesReady(task: RuntimeCycleTask): Promise<{ ready: boolean; missing: string[] }> {
    const required = uniqueSorted([
      ...task.requiredCapabilities,
      this.options.claudeRuntimeCapabilityId,
      this.options.verifierCapabilityId,
    ]);
    const statuses = await this.registry.readiness(required);
    const missing = statuses.filter((item) => !item.ready).map((item) => item.id);
    const supervision = await this.supervisionStatus();
    missing.push(...supervision.missing);
    return { ready: missing.length === 0, missing: uniqueSorted(missing) };
  }

  async markCapabilityBlocked(task: RuntimeCycleTask, missing: string[]): Promise<void> {
    const now = new Date().toISOString();
    await this.options.store.update((db) => {
      const stored = db.goalTasks.find((item) => item.id === task.id && item.goalId === task.goalId);
      if (!stored) throw new Error(`Unknown task ${task.id}.`);
      if (!['READY', 'REPAIRING'].includes(stored.state)) throw new Error(`Cannot capability-block task ${stored.id} from ${stored.state}.`);
      stored.state = 'BLOCKED';
      stored.lastFailure = `CAPABILITY_BLOCKED:${uniqueSorted(missing).join(',')}`;
      stored.updatedAt = now;
    });
  }

  private async remainingBudget(task: StoredGoalTask): Promise<{ costUsd: number; timeMs: number }> {
    if (task.costBudgetUsd === undefined || !Number.isFinite(task.costBudgetUsd) || task.costBudgetUsd <= 0) {
      throw new Error(`CLAUDE task ${task.id} requires an explicit positive costBudgetUsd before live execution.`);
    }
    const prior = await this.attempts.listForTask(task.goalId, task.id);
    const spent = prior.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
    const elapsed = prior.reduce((sum, item) => sum + (item.elapsedMs ?? 0), 0);
    const costUsd = task.costBudgetUsd - spent;
    const timeMs = task.timeLimitMs - elapsed;
    if (costUsd <= 0) throw new Error(`CLAUDE task ${task.id} has exhausted its cost budget before execution.`);
    if (timeMs < 1_000) throw new Error(`CLAUDE task ${task.id} has exhausted its time budget before execution.`);
    return { costUsd, timeMs };
  }

  private async compileEnvelope(task: StoredGoalTask, executionAttempt: number, costBudgetUsd: number): Promise<CapabilityBoundClaudeEnvelope> {
    const allowedPaths = uniqueSorted(task.allowedPaths.map(normalizeAllowedPath));
    const mutable = allowedPaths.length > 0;
    return compileCapabilityBoundClaudeEnvelope(
      this.registry,
      this.projectRoot,
      {
        schemaVersion: 1,
        id: `${task.id}:attempt-${executionAttempt}`,
        permissionMode: 'dontAsk',
        // Claude Code Edit requires the target to be readable in the bounded session.
        // Secure Bridge therefore grants Read only to the same exact project paths
        // already admitted for Edit; no ambient/general Read authority is exposed.
        availableBuiltInTools: mutable ? ['Read', 'Edit'] : [],
        expectedMcpServers: [],
        expectedMcpTools: [],
        allowedWithoutPrompt: mutable ? allowedPaths.flatMap((item) => [`Read(/${item})`, `Edit(/${item})`]) : [],
        deniedRules: ['Bash', 'PowerShell', 'Write', 'NotebookEdit'],
        maxTurns: task.maxTurns,
        maxBudgetUsd: costBudgetUsd,
        noSessionPersistence: true,
        strictMcpConfig: true,
        disableChrome: true,
      },
      {
        requestedSkills: [],
        declaredTaskSkills: [],
        bindings: [],
      },
    );
  }

  async execute(task: RuntimeCycleTask): Promise<RuntimeExecutionResult> {
    const storedBefore = await this.storedTask(task);
    if (!['READY', 'REPAIRING'].includes(storedBefore.state)) throw new Error(`Task ${storedBefore.id} is not runnable from ${storedBefore.state}.`);

    let executionAttempt: number;
    let budget: { costUsd: number; timeMs: number };
    let requestedModel: string;
    let expectedResolvedModel: string;
    let envelope: CapabilityBoundClaudeEnvelope;
    let baseline: WorkspaceSnapshot;
    try {
      executionAttempt = nextGoalTaskExecutionAttempt(storedBefore);
      budget = await this.remainingBudget(storedBefore);
      const policy = claudeModelPolicyFromEnv();
      const prior = await this.attempts.listForTask(storedBefore.goalId, storedBefore.id);
      const decision = chooseClaudeModel({
        taskClass: storedBefore.riskClass === 'YELLOW' ? 'complex' : 'routine',
        attempt: Math.max(0, executionAttempt - 1),
        verifierFailures: prior.filter((item) => item.verificationScore !== undefined && item.verificationScore < 1).length,
        escalationsUsed: 0,
        lastFailureKind: storedBefore.lastFailure?.startsWith('CAPABILITY_BLOCKED:') ? 'configuration' : undefined,
      }, policy);
      if (decision.action === 'stop') throw new Error(`Claude routing stopped before provider execution: ${decision.reason}`);
      requestedModel = decision.model;
      expectedResolvedModel = this.expectedResolvedModelFor(requestedModel, policy.defaultModel);
      envelope = await this.compileEnvelope(storedBefore, executionAttempt, budget.costUsd);
      baseline = await captureWorkspaceSnapshot(this.projectRoot);
    } catch (error) {
      const reason = cleanReason(error);
      await this.blockBeforeExecution(storedBefore, reason);
      throw new Error(`Secure Bridge execution preflight blocked before provider call: ${reason}`);
    }

    await this.goals.transitionTask(storedBefore.id, 'WORKING');
    const stored = (await this.options.store.load()).goalTasks.find((item) => item.id === storedBefore.id && item.goalId === storedBefore.goalId)!;
    if (stored.attempt !== executionAttempt) {
      const reason = `Task attempt drift after WORKING transition: expected ${executionAttempt}, got ${stored.attempt}.`;
      await this.goals.transitionTask(stored.id, 'FAILED_SAFE', reason);
      throw new Error(reason);
    }

    const executionTask: SecureClaudeTaskContract = {
      id: stored.id,
      goalId: stored.goalId,
      title: stored.title,
      intent: stored.lastFailure ? `${stored.intent}\n\nPrevious deterministic failure evidence: ${stored.lastFailure}` : stored.intent,
      acceptanceCriteria: stored.acceptanceCriteria,
      verificationPlan: stored.verificationPlan,
      allowedPaths: stored.allowedPaths,
      forbiddenPaths: stored.forbiddenPaths,
      attempt: stored.attempt,
      maxTurns: stored.maxTurns,
      timeLimitMs: budget.timeMs,
      tokenBudget: stored.tokenBudget,
      costBudgetUsd: budget.costUsd,
    };

    let execution: SecureClaudeExecutionResult;
    try {
      execution = await executeSecureClaudeTask({
        task: executionTask,
        envelope,
        projectRoot: this.projectRoot,
        requestedModel,
        expectedClaudeCodeVersion: this.options.expectedClaudeCodeVersion,
      }, {
        runProcess: this.options.runClaudeProcess,
        readVersion: this.options.readClaudeVersion,
      });
    } catch (error) {
      const reason = cleanReason(error);
      try {
        await this.registry.invalidateChecks(
          this.options.claudeRuntimeCapabilityId,
          ['RUNTIME_WIRED', 'SAFETY_VERIFIED'],
          `SECURE_BRIDGE_EXECUTOR_FAILED_SAFE: ${reason}`,
        );
      } catch {
        // Task failure remains authoritative even if capability audit persistence
        // itself is unavailable; never replace the original fail-closed reason.
      }
      await this.goals.transitionTask(stored.id, 'FAILED_SAFE', `EXECUTOR_FAILED_SAFE:${reason}`);
      throw new Error(`Secure Bridge executor failed safely after WORKING transition: ${reason}`);
    }

    this.records.set(execution.attemptId, {
      task: stored,
      baseline,
      envelope,
      execution,
      expectedResolvedModel,
      strategyFingerprint: strategyFingerprint(stored, requestedModel),
    });
    return {
      attemptId: execution.attemptId,
      workerSucceeded: execution.workerSucceeded,
      outputRef: `nexus://claude-attempt/${execution.attemptId}`,
    };
  }

  async attestRuntime(task: RuntimeCycleTask, execution: RuntimeExecutionResult): Promise<RuntimeAttestationResult> {
    const record = this.records.get(execution.attemptId);
    if (!record) return { accepted: false, capabilityReady: false, reason: 'Secure Bridge execution evidence is missing from the current bounded cycle.' };
    const attest = this.options.attestRuntime ?? attestClaudeRuntime;
    const result = await attest(
      this.registry,
      this.options.claudeRuntimeCapabilityId,
      record.execution.rawStreamJson,
      {
        expectedResolvedModel: record.expectedResolvedModel,
        maxTurns: record.envelope.envelope.maxTurns,
        maxCostUsd: record.envelope.envelope.maxBudgetUsd,
        allowedPermissionModes: [record.envelope.envelope.permissionMode],
        expectedCwd: this.projectRoot,
        expectedRuntimeTools: record.envelope.expectedRuntimeTools,
        expectedMcpServers: record.envelope.expectedMcpServers,
        expectedToolEnvelopeHash: record.envelope.envelopeHash,
        expectedSkillSetHash: record.envelope.skillSetHash,
        admittedSkills: record.envelope.admittedSkills,
        expectedClaudeCodeVersion: this.options.expectedClaudeCodeVersion,
        actualClaudeCodeVersion: record.execution.actualClaudeCodeVersion,
      },
    );
    record.attestation = result;
    if (result.accepted && result.capabilityReady) {
      await this.goals.transitionTask(task.id, 'VERIFYING');
      return { accepted: true, capabilityReady: true };
    }
    const processClass = processFailureClass(record.execution);
    const reason = [result.reason, processClass ? `process-class=${processClass}` : undefined].filter(Boolean).join('; ');
    return { accepted: false, capabilityReady: false, reason: reason || 'Runtime attestation rejected execution evidence.' };
  }

  async markRuntimeRejected(task: RuntimeCycleTask, execution: RuntimeExecutionResult, reason: string): Promise<void> {
    const stored = await this.storedTask(task);
    if (stored.state === 'WORKING') await this.goals.transitionTask(stored.id, 'FAILED_SAFE', `RUNTIME_REJECTED:${reason}`);
    this.records.delete(execution.attemptId);
  }

  async verify(task: RuntimeCycleTask, execution: RuntimeExecutionResult): Promise<RuntimeVerificationResult> {
    const record = this.records.get(execution.attemptId);
    if (!record) return { passed: false, evidence: ['FAIL execution-record: Secure Bridge execution record missing.'], failure: 'Secure Bridge execution record missing.' };
    const current = await this.storedTask(task);
    if (current.state !== 'VERIFYING') return { passed: false, evidence: [`FAIL task-state: expected VERIFYING, got ${current.state}.`], failure: `Task state ${current.state} is not eligible for deterministic verification.` };
    const verifier = this.options.verifyTask ?? verifyGoalTask;
    const result = await verifier(current, record.baseline, { projectRoot: this.projectRoot, store: this.options.store });
    record.verification = result;
    return { passed: result.passed, evidence: result.evidence, failure: result.failure };
  }

  async persistAttempt(input: { task: RuntimeCycleTask; execution: RuntimeExecutionResult; verification: RuntimeVerificationResult }): Promise<void> {
    const record = this.records.get(input.execution.attemptId);
    if (!record) throw new Error(`Cannot persist missing Secure Bridge attempt ${input.execution.attemptId}.`);
    const runtime = record.attestation?.runtime;
    const verification = record.verification;
    await this.attempts.record({
      goalId: record.task.goalId,
      taskId: record.task.id,
      attemptNumber: record.task.attempt,
      strategyFingerprint: record.strategyFingerprint,
      failureFingerprint: failureFingerprint(input.verification.failure),
      verificationScore: input.verification.passed ? 1 : 0,
      changedPaths: verification?.changedPaths ?? [],
      costUsd: runtime?.totalCostUsd,
      elapsedMs: runtime?.durationMs ?? record.execution.durationMs,
      toolEnvelopeHash: record.envelope.envelopeHash,
      skillSetHash: record.envelope.skillSetHash,
    });
  }

  async diagnoseProgress(task: RuntimeCycleTask): Promise<RuntimeProgressDecision> {
    const stored = await this.storedTask(task);
    if (stored.attempt >= stored.maxRepairs + 1) {
      return { action: 'STOP', reason: `Repair budget exhausted at attempt ${stored.attempt}/${stored.maxRepairs + 1}.` };
    }
    const observations = await this.attempts.listForTask(stored.goalId, stored.id);
    const diagnosis = detectStuck(observations, {
      maxTokens: stored.tokenBudget,
      maxCostUsd: stored.costBudgetUsd,
      maxTimeMs: stored.timeLimitMs,
    });
    if (diagnosis.shouldStop) return { action: 'STOP', reason: diagnosis.reasons.join('; ') || 'Task budget exhausted.' };
    if (diagnosis.shouldReplan) {
      if (!this.options.requestReplan) return { action: 'STOP', reason: `Deterministic stuck detector requires replan, but no approved replanning adapter is configured: ${diagnosis.reasons.join('; ')}` };
      return { action: 'REPLAN', reason: diagnosis.reasons.join('; ') };
    }
    return { action: 'CONTINUE', reason: 'Verifier failure remains within bounded repair budget.' };
  }

  async requestReplan(task: RuntimeCycleTask, reason: string): Promise<RuntimeReplanResult> {
    if (!this.options.requestReplan) throw new Error('No approved Secure Bridge replanning adapter is configured.');
    return this.options.requestReplan(await this.storedTask(task), reason);
  }

  async markRepairRequired(task: RuntimeCycleTask, reason: string, strategyId?: string): Promise<void> {
    const detail = strategyId ? `${reason} | advisoryStrategy=${strategyId}` : reason;
    await this.goals.transitionTask(task.id, 'REPAIRING', detail);
  }

  async markFailedSafe(task: RuntimeCycleTask, reason: string): Promise<void> {
    const stored = await this.storedTask(task);
    if (stored.state === 'VERIFYING') await this.goals.transitionTask(stored.id, 'FAILED_SAFE', reason);
  }

  async checkpoint(input: { task: RuntimeCycleTask; execution: RuntimeExecutionResult; evidence: string[] }): Promise<void> {
    const record = this.records.get(input.execution.attemptId);
    if (!record) throw new Error(`Cannot checkpoint missing Secure Bridge attempt ${input.execution.attemptId}.`);
    await this.goals.transitionTask(input.task.id, 'COMPLETED');
    await this.goals.checkpoint({
      goalId: input.task.goalId,
      taskId: input.task.id,
      summary: `Secure Bridge attempt ${record.task.attempt} passed runtime attestation and independent deterministic verification.`,
      verificationEvidence: input.evidence,
      nextAction: 'Continue with the next durable NEXUS Goal task.',
    });
    this.records.delete(input.execution.attemptId);
  }
}
