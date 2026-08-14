export type RuntimeCycleOutcome =
  | 'EMERGENCY_STOPPED'
  | 'IDLE'
  | 'BLOCKED_RISK'
  | 'WAITING_APPROVAL'
  | 'BLOCKED_CAPABILITY'
  | 'RUNTIME_REJECTED'
  | 'REPAIR_REQUIRED'
  | 'REPLAN_APPLIED'
  | 'FAILED_SAFE'
  | 'CHECKPOINTED';

export interface RuntimeCycleTask {
  id: string;
  goalId: string;
  title: string;
  riskClass: 'GREEN' | 'YELLOW' | 'RED';
  requiresOwnerApproval: boolean;
  requiredCapabilities: string[];
}

export interface RuntimeApprovalStatus {
  approved: boolean;
  reason?: string;
}

export interface RuntimeExecutionResult {
  attemptId: string;
  workerSucceeded: boolean;
  outputRef?: string;
}

export interface RuntimeAttestationResult {
  accepted: boolean;
  capabilityReady: boolean;
  reason?: string;
}

export interface RuntimeVerificationResult {
  passed: boolean;
  evidence: string[];
  failure?: string;
}

export interface RuntimeProgressDecision {
  action: 'CONTINUE' | 'REPLAN' | 'STOP';
  reason: string;
}

export interface RuntimeReplanResult {
  strategyId: string;
  summary: string;
}

export interface RuntimeCycleResult {
  outcome: RuntimeCycleOutcome;
  taskId?: string;
  goalId?: string;
  reason: string;
  resumedTaskIds: string[];
  missingCapabilities?: string[];
  attemptId?: string;
  strategyId?: string;
}

/**
 * Ports owned by NEXUS or bounded adapters. The kernel itself has no provider,
 * filesystem, shell, account, publishing, spending or approval authority.
 */
export interface RuntimeCyclePorts {
  isEmergencyStopped(): Promise<boolean>;

  /**
   * Apply deterministic TIME_REACHED / CAPABILITIES_READY / TASKS_COMPLETED
   * resume rules. Owner/manual waits must never be returned as resumed here.
   */
  resumeEligibleTasks(): Promise<string[]>;

  nextReadyTask(): Promise<RuntimeCycleTask | undefined>;

  /** RED is non-executable in the normal runtime. */
  markRiskBlocked(task: RuntimeCycleTask, reason: string): Promise<void>;

  /**
   * Validate the exact current owner approval state through NEXUS. The real
   * adapter must enforce task/revision/fingerprint binding; the kernel never
   * accepts a worker-provided or unaudited approval boolean.
   */
  approvalStatus(task: RuntimeCycleTask): Promise<RuntimeApprovalStatus>;

  capabilitiesReady(task: RuntimeCycleTask): Promise<{
    ready: boolean;
    missing: string[];
  }>;

  markWaitingApproval(task: RuntimeCycleTask, reason: string): Promise<void>;
  markCapabilityBlocked(task: RuntimeCycleTask, missing: string[]): Promise<void>;

  /** Bounded executor adapter; all job-contract limits remain authoritative. */
  execute(task: RuntimeCycleTask): Promise<RuntimeExecutionResult>;

  /**
   * Validate provider/runtime identity, permissions, workspace, version and
   * usage. If this rejects, execution output is not trusted by the Verifier.
   */
  attestRuntime(task: RuntimeCycleTask, execution: RuntimeExecutionResult): Promise<RuntimeAttestationResult>;

  markRuntimeRejected(task: RuntimeCycleTask, execution: RuntimeExecutionResult, reason: string): Promise<void>;

  /** Independent deterministic verifier; producer does not self-certify. */
  verify(task: RuntimeCycleTask, execution: RuntimeExecutionResult): Promise<RuntimeVerificationResult>;

  persistAttempt(input: {
    task: RuntimeCycleTask;
    execution: RuntimeExecutionResult;
    verification: RuntimeVerificationResult;
  }): Promise<void>;

  diagnoseProgress(task: RuntimeCycleTask): Promise<RuntimeProgressDecision>;

  /** One bounded advisory strategy request; NEXUS keeps authority. */
  requestReplan(task: RuntimeCycleTask, reason: string): Promise<RuntimeReplanResult>;

  markRepairRequired(task: RuntimeCycleTask, reason: string, strategyId?: string): Promise<void>;
  markFailedSafe(task: RuntimeCycleTask, reason: string): Promise<void>;

  checkpoint(input: {
    task: RuntimeCycleTask;
    execution: RuntimeExecutionResult;
    evidence: string[];
  }): Promise<void>;
}

function nonEmptyEvidence(evidence: string[]): boolean {
  return evidence.length > 0 && evidence.every((item) => item.trim().length > 0);
}

/**
 * Execute exactly one bounded NEXUS scheduler cycle.
 *
 * Order is intentionally strict:
 * emergency stop → deterministic resume → ready task → RED risk block →
 * fingerprint-bound owner approval → capability readiness → bounded execution →
 * runtime attestation → independent verifier → attempt persistence →
 * repair/replan/stop OR checkpoint.
 *
 * This kernel never loops internally. The outer scheduler decides when another
 * cycle may run, preserving turn/time/token/cost/retry limits and owner control.
 */
export async function runRuntimeCycle(ports: RuntimeCyclePorts): Promise<RuntimeCycleResult> {
  if (await ports.isEmergencyStopped()) {
    return {
      outcome: 'EMERGENCY_STOPPED',
      reason: 'Emergency stop is active; no resume, routing, provider or worker call was attempted.',
      resumedTaskIds: [],
    };
  }

  const resumedTaskIds = await ports.resumeEligibleTasks();
  const task = await ports.nextReadyTask();
  if (!task) {
    return {
      outcome: 'IDLE',
      reason: resumedTaskIds.length
        ? 'Deterministic resume checks completed; no task is currently READY.'
        : 'No task is currently READY.',
      resumedTaskIds,
    };
  }

  if (task.riskClass === 'RED') {
    const reason = 'RED task is non-executable in the normal NEXUS runtime and requires contract redesign or a separately defined future authority gate.';
    await ports.markRiskBlocked(task, reason);
    return {
      outcome: 'BLOCKED_RISK',
      taskId: task.id,
      goalId: task.goalId,
      reason,
      resumedTaskIds,
    };
  }

  if (task.requiresOwnerApproval || task.riskClass === 'YELLOW') {
    const approval = await ports.approvalStatus(task);
    if (!approval.approved) {
      const reason = approval.reason?.trim() || 'Task requires valid fingerprint-bound owner approval before execution.';
      await ports.markWaitingApproval(task, reason);
      return {
        outcome: 'WAITING_APPROVAL',
        taskId: task.id,
        goalId: task.goalId,
        reason,
        resumedTaskIds,
      };
    }
  }

  const capabilityStatus = await ports.capabilitiesReady(task);
  if (!capabilityStatus.ready || capabilityStatus.missing.length > 0) {
    const missing = [...new Set(capabilityStatus.missing)].sort();
    await ports.markCapabilityBlocked(task, missing);
    return {
      outcome: 'BLOCKED_CAPABILITY',
      taskId: task.id,
      goalId: task.goalId,
      reason: `Required capabilities are not READY: ${missing.join(', ') || 'unknown'}.`,
      resumedTaskIds,
      missingCapabilities: missing,
    };
  }

  const execution = await ports.execute(task);
  if (!execution.attemptId.trim()) throw new Error('Executor returned an empty attemptId.');

  const attestation = await ports.attestRuntime(task, execution);
  if (!attestation.accepted || !attestation.capabilityReady) {
    const reason = attestation.reason?.trim() || 'Runtime attestation rejected the execution evidence.';
    await ports.markRuntimeRejected(task, execution, reason);
    return {
      outcome: 'RUNTIME_REJECTED',
      taskId: task.id,
      goalId: task.goalId,
      attemptId: execution.attemptId,
      reason,
      resumedTaskIds,
    };
  }

  const verification = await ports.verify(task, execution);
  if (!nonEmptyEvidence(verification.evidence)) {
    throw new Error('Verifier must return at least one non-empty evidence item.');
  }

  await ports.persistAttempt({ task, execution, verification });

  if (verification.passed) {
    await ports.checkpoint({ task, execution, evidence: verification.evidence });
    return {
      outcome: 'CHECKPOINTED',
      taskId: task.id,
      goalId: task.goalId,
      attemptId: execution.attemptId,
      reason: 'Independent deterministic verification passed; checkpoint persisted.',
      resumedTaskIds,
    };
  }

  const progress = await ports.diagnoseProgress(task);
  const failure = verification.failure?.trim() || progress.reason.trim() || 'Verifier rejected the attempt.';

  if (progress.action === 'STOP') {
    await ports.markFailedSafe(task, failure);
    return {
      outcome: 'FAILED_SAFE',
      taskId: task.id,
      goalId: task.goalId,
      attemptId: execution.attemptId,
      reason: failure,
      resumedTaskIds,
    };
  }

  if (progress.action === 'REPLAN') {
    const replan = await ports.requestReplan(task, progress.reason);
    if (!replan.strategyId.trim()) throw new Error('Replan adapter returned an empty strategyId.');
    await ports.markRepairRequired(task, failure, replan.strategyId);
    return {
      outcome: 'REPLAN_APPLIED',
      taskId: task.id,
      goalId: task.goalId,
      attemptId: execution.attemptId,
      strategyId: replan.strategyId,
      reason: replan.summary.trim() || progress.reason,
      resumedTaskIds,
    };
  }

  await ports.markRepairRequired(task, failure);
  return {
    outcome: 'REPAIR_REQUIRED',
    taskId: task.id,
    goalId: task.goalId,
    attemptId: execution.attemptId,
    reason: failure,
    resumedTaskIds,
  };
}
