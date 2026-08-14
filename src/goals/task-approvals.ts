import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  MillionDollarBuildModeStore,
  taskEligibleForMillionDollarBuildMode,
  type MillionDollarBuildModeStatus,
} from '../safety/million-dollar-build-mode.js';
import type { NexusStore } from '../storage/store.js';
import type { StoredGoalTask, StoredGoalTaskApproval } from './schema.js';

export type GoalTaskApprovalDecision = 'APPROVED' | 'DENIED';

export interface GoalTaskApprovalValidation {
  approved: boolean;
  reason?: string;
  approval?: StoredGoalTaskApproval;
  authorizationSource?: 'NONE' | 'TASK_APPROVAL' | 'MILLION_DOLLAR_BUILD_MODE';
  authorizationFingerprint?: string;
}

const sha256Pattern = /^[a-f0-9]{64}$/i;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function nextGoalTaskExecutionAttempt(task: StoredGoalTask): number {
  if (!Number.isInteger(task.attempt) || task.attempt < 0) throw new Error(`Task ${task.id} has an invalid attempt counter.`);
  return task.attempt === 0 ? 1 : task.attempt;
}

export function goalTaskRequiresOwnerApproval(task: StoredGoalTask): boolean {
  return task.approvalRequirement === 'OWNER' || task.riskClass === 'YELLOW' || task.riskClass === 'RED';
}

export function fingerprintGoalTask(task: StoredGoalTask, executionAttempt = nextGoalTaskExecutionAttempt(task)): string {
  if (!Number.isInteger(executionAttempt) || executionAttempt < 1) throw new Error('executionAttempt must be a positive integer.');
  const contract = {
    id: task.id,
    goalId: task.goalId,
    title: task.title,
    intent: task.intent,
    worker: task.worker,
    acceptanceCriteria: task.acceptanceCriteria,
    verificationPlan: task.verificationPlan,
    dependencies: task.dependencies,
    requiredCapabilities: task.requiredCapabilities,
    allowedPaths: task.allowedPaths,
    forbiddenPaths: task.forbiddenPaths,
    riskClass: task.riskClass,
    approvalRequirement: task.approvalRequirement,
    idempotencyKey: task.idempotencyKey,
    maxTurns: task.maxTurns,
    maxRepairs: task.maxRepairs,
    timeLimitMs: task.timeLimitMs,
    tokenBudget: task.tokenBudget,
    costBudgetUsd: task.costBudgetUsd,
    executionAttempt,
  };
  return createHash('sha256').update(canonicalJson(contract)).digest('hex');
}

function validExpiry(approval: StoredGoalTaskApproval, now: Date): boolean {
  const expiresAt = Date.parse(approval.expiresAt);
  return Number.isFinite(expiresAt) && now.getTime() <= expiresAt;
}

function invalidate(approval: StoredGoalTaskApproval, reason: string, now: Date): void {
  approval.status = 'INVALIDATED';
  approval.invalidationReason = reason.trim().slice(0, 1_000);
  approval.resolvedAt = now.toISOString();
}

export class GoalTaskApprovalRepository {
  private readonly buildMode: MillionDollarBuildModeStore;

  constructor(private readonly store: NexusStore, buildMode?: MillionDollarBuildModeStore) {
    const storageLocation = store.describe().location;
    this.buildMode = buildMode ?? new MillionDollarBuildModeStore(
      path.join(path.dirname(storageLocation), 'million-dollar-build-mode.json'),
    );
  }

  async getMillionDollarBuildModeStatus(now = new Date()): Promise<MillionDollarBuildModeStatus> {
    return this.buildMode.getStatus(now);
  }

  async activateMillionDollarBuildMode(activatedBy: string, now = new Date()): Promise<{ status: MillionDollarBuildModeStatus; releasedTasks: number }> {
    const status = await this.buildMode.activate(activatedBy, now);
    const releasedTasks = await this.releaseWaitingTasksAuthorizedByBuildMode(now);
    return { status, releasedTasks };
  }

  async deactivateMillionDollarBuildMode(deactivatedBy: string, now = new Date()): Promise<MillionDollarBuildModeStatus> {
    return this.buildMode.deactivate(deactivatedBy, now);
  }

  async releaseWaitingTasksAuthorizedByBuildMode(now = new Date()): Promise<number> {
    if (!Number.isFinite(now.getTime())) throw new Error('Build Mode release time must be valid.');
    const status = await this.buildMode.getStatus(now);
    if (!status.effectiveActive) return 0;

    return this.store.update((db) => {
      let released = 0;
      for (const task of db.goalTasks) {
        if (task.state !== 'WAITING' || !taskEligibleForMillionDollarBuildMode(task)) continue;
        const executionAttempt = nextGoalTaskExecutionAttempt(task);
        const taskFingerprint = fingerprintGoalTask(task, executionAttempt);
        const currentPending = db.goalTaskApprovals.filter((approval) =>
          approval.goalId === task.goalId &&
          approval.taskId === task.id &&
          approval.status === 'PENDING' &&
          approval.executionAttempt === executionAttempt &&
          approval.taskFingerprint === taskFingerprint &&
          validExpiry(approval, now),
        );
        if (currentPending.length < 1) continue;

        for (const approval of currentPending) {
          invalidate(approval, 'Superseded by active owner-authorized Million-Dollar Build Mode standing authority.', now);
        }
        task.state = 'READY';
        task.updatedAt = now.toISOString();
        const goal = db.goals.find((item) => item.id === task.goalId);
        if (goal) {
          goal.currentTaskId = task.id;
          goal.updatedAt = now.toISOString();
        }
        released += 1;
      }
      return released;
    });
  }

  async listPending(now = new Date()): Promise<StoredGoalTaskApproval[]> {
    if (!Number.isFinite(now.getTime())) throw new Error('Approval listing time must be valid.');
    return this.store.update((db) => {
      for (const approval of db.goalTaskApprovals) {
        if (approval.status === 'PENDING' && !validExpiry(approval, now)) {
          approval.status = 'EXPIRED';
          approval.resolvedAt = now.toISOString();
          approval.invalidationReason = 'Approval TTL expired before dashboard listing.';
        }
      }
      return db.goalTaskApprovals
        .filter((item) => item.status === 'PENDING')
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  async get(id: string): Promise<StoredGoalTaskApproval | undefined> {
    const db = await this.store.load();
    return db.goalTaskApprovals.find((item) => item.id === id);
  }

  async requestForTask(input: {
    goalId: string;
    taskId: string;
    requestedBy: string;
    reason: string;
    ttlMs: number;
    now?: Date;
  }): Promise<StoredGoalTaskApproval> {
    const requestedBy = input.requestedBy.trim();
    const reason = input.reason.trim();
    if (!requestedBy) throw new Error('requestedBy is required.');
    if (!reason) throw new Error('Approval reason is required.');
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > MAX_APPROVAL_TTL_MS) {
      throw new Error(`Approval ttlMs must be an integer from 1000 to ${MAX_APPROVAL_TTL_MS}.`);
    }
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('Approval request time must be valid.');

    const snapshot = await this.store.load();
    const snapshotTask = snapshot.goalTasks.find((item) => item.id === input.taskId && item.goalId === input.goalId);
    if (snapshotTask && snapshotTask.riskClass !== 'RED' && goalTaskRequiresOwnerApproval(snapshotTask)) {
      const standing = await this.buildMode.authorizeTask(snapshotTask, now);
      if (standing.authorized) {
        throw new Error(`Task ${snapshotTask.id} is already covered by active Million-Dollar Build Mode standing authority; a per-task approval must not be created.`);
      }
    }

    return this.store.update((db) => {
      const goal = db.goals.find((item) => item.id === input.goalId);
      if (!goal) throw new Error(`Unknown goal: ${input.goalId}`);
      const task = db.goalTasks.find((item) => item.id === input.taskId && item.goalId === input.goalId);
      if (!task) throw new Error(`Unknown task ${input.taskId} for goal ${input.goalId}.`);
      if (!goalTaskRequiresOwnerApproval(task)) throw new Error(`Task ${task.id} does not require owner approval.`);
      if (task.riskClass === 'RED') {
        throw new Error(`Task ${task.id} is RED. RED tasks remain non-executable in Secure Bridge v1 and cannot be converted into executable authority by approval.`);
      }
      if (!['READY', 'REPAIRING', 'WAITING'].includes(task.state)) {
        throw new Error(`Task ${task.id} cannot request execution approval from state ${task.state}.`);
      }

      const executionAttempt = nextGoalTaskExecutionAttempt(task);
      const fingerprint = fingerprintGoalTask(task, executionAttempt);
      for (const existing of db.goalTaskApprovals) {
        if (existing.taskId === task.id && existing.goalId === task.goalId && existing.status === 'PENDING') {
          invalidate(existing, 'Superseded by a newer approval request for the same task.', now);
        }
      }

      const approval: StoredGoalTaskApproval = {
        id: randomUUID(),
        goalId: task.goalId,
        taskId: task.id,
        executionAttempt,
        taskFingerprint: fingerprint,
        riskClass: task.riskClass,
        status: 'PENDING',
        requestedBy,
        reason,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      };
      db.goalTaskApprovals.push(approval);
      task.state = 'WAITING';
      task.updatedAt = now.toISOString();
      goal.currentTaskId = task.id;
      goal.updatedAt = now.toISOString();
      return approval;
    });
  }

  async validateForTask(goalId: string, taskId: string, now = new Date()): Promise<GoalTaskApprovalValidation> {
    if (!Number.isFinite(now.getTime())) throw new Error('Approval validation time must be valid.');

    const snapshot = await this.store.load();
    const snapshotTask = snapshot.goalTasks.find((item) => item.id === taskId && item.goalId === goalId);
    if (!snapshotTask) return { approved: false, reason: `Unknown task ${taskId} for goal ${goalId}.` };
    if (snapshotTask.riskClass === 'RED') return { approved: false, reason: 'RED tasks are non-executable.' };
    if (!goalTaskRequiresOwnerApproval(snapshotTask)) {
      return { approved: true, reason: 'Task does not require owner approval.', authorizationSource: 'NONE' };
    }

    const standing = await this.buildMode.authorizeTask(snapshotTask, now);
    if (standing.authorized && standing.stateFingerprint) {
      const executionAttempt = nextGoalTaskExecutionAttempt(snapshotTask);
      const taskFingerprint = fingerprintGoalTask(snapshotTask, executionAttempt);
      const authorizationFingerprint = createHash('sha256')
        .update(`${standing.stateFingerprint}:${taskFingerprint}:${executionAttempt}`)
        .digest('hex');
      return {
        approved: true,
        reason: standing.reason,
        authorizationSource: 'MILLION_DOLLAR_BUILD_MODE',
        authorizationFingerprint,
      };
    }

    return this.store.update((db) => {
      const task = db.goalTasks.find((item) => item.id === taskId && item.goalId === goalId);
      if (!task) return { approved: false, reason: `Unknown task ${taskId} for goal ${goalId}.` };
      if (task.riskClass === 'RED') return { approved: false, reason: 'RED tasks are non-executable.' };
      if (!goalTaskRequiresOwnerApproval(task)) return { approved: true, reason: 'Task does not require owner approval.', authorizationSource: 'NONE' };

      const executionAttempt = nextGoalTaskExecutionAttempt(task);
      const fingerprint = fingerprintGoalTask(task, executionAttempt);
      const candidates = db.goalTaskApprovals
        .filter((item) => item.goalId === goalId && item.taskId === taskId && item.executionAttempt === executionAttempt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      for (const approval of candidates) {
        if (!sha256Pattern.test(approval.taskFingerprint)) {
          if (approval.status === 'PENDING' || approval.status === 'APPROVED') invalidate(approval, 'Malformed approval fingerprint.', now);
          continue;
        }
        if (approval.taskFingerprint !== fingerprint) {
          if (approval.status === 'PENDING' || approval.status === 'APPROVED') invalidate(approval, 'Task contract changed after approval was requested/resolved.', now);
          continue;
        }
        if (!validExpiry(approval, now)) {
          if (approval.status === 'PENDING' || approval.status === 'APPROVED') {
            approval.status = 'EXPIRED';
            approval.resolvedAt = now.toISOString();
            approval.invalidationReason = 'Approval TTL expired.';
          }
          continue;
        }
        if (approval.status === 'APPROVED') {
          return {
            approved: true,
            approval,
            authorizationSource: 'TASK_APPROVAL',
            authorizationFingerprint: createHash('sha256').update(`${approval.id}:${approval.taskFingerprint}:${approval.executionAttempt}`).digest('hex'),
          };
        }
        if (approval.status === 'DENIED') return { approved: false, approval, reason: 'Owner denied this execution attempt.' };
        if (approval.status === 'PENDING') return { approved: false, approval, reason: 'Owner approval is pending.' };
      }
      return { approved: false, reason: `No current fingerprint-bound owner approval exists for execution attempt ${executionAttempt}.` };
    });
  }

  async resolve(input: {
    approvalId: string;
    decision: GoalTaskApprovalDecision;
    resolvedBy: string;
    note?: string;
    now?: Date;
  }): Promise<StoredGoalTaskApproval> {
    const resolvedBy = input.resolvedBy.trim();
    if (!resolvedBy) throw new Error('resolvedBy is required.');
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('Approval resolution time must be valid.');

    const result = await this.store.update((db): { approval?: StoredGoalTaskApproval; error?: string } => {
      const approval = db.goalTaskApprovals.find((item) => item.id === input.approvalId);
      if (!approval) return { error: `Unknown goal task approval: ${input.approvalId}` };
      if (approval.status !== 'PENDING') return { approval, error: `Approval ${approval.id} is not pending (status=${approval.status}).` };
      if (!validExpiry(approval, now)) {
        approval.status = 'EXPIRED';
        approval.resolvedAt = now.toISOString();
        approval.invalidationReason = 'Approval TTL expired before owner resolution.';
        return { approval, error: `Approval ${approval.id} has expired.` };
      }

      const task = db.goalTasks.find((item) => item.id === approval.taskId && item.goalId === approval.goalId);
      if (!task) {
        invalidate(approval, 'Task no longer exists.', now);
        return { approval, error: `Task ${approval.taskId} no longer exists.` };
      }
      if (task.riskClass === 'RED') {
        invalidate(approval, 'Task is RED and non-executable.', now);
        return { approval, error: `Task ${task.id} is RED and cannot be approved for execution.` };
      }
      const expectedAttempt = nextGoalTaskExecutionAttempt(task);
      const expectedFingerprint = fingerprintGoalTask(task, expectedAttempt);
      if (approval.executionAttempt !== expectedAttempt || approval.taskFingerprint !== expectedFingerprint) {
        invalidate(approval, 'Task contract or execution attempt changed before owner resolution.', now);
        return { approval, error: `Approval ${approval.id} no longer matches the current task contract/attempt.` };
      }
      if (task.state !== 'WAITING') {
        invalidate(approval, `Task state changed to ${task.state} before owner resolution.`, now);
        return { approval, error: `Task ${task.id} is ${task.state}, expected WAITING for approval resolution.` };
      }

      approval.status = input.decision;
      approval.resolvedAt = now.toISOString();
      approval.resolvedBy = resolvedBy;
      approval.resolutionNote = input.note?.trim() || undefined;
      task.updatedAt = now.toISOString();
      const goal = db.goals.find((item) => item.id === task.goalId);

      if (input.decision === 'APPROVED') {
        task.state = 'READY';
        if (goal) {
          goal.currentTaskId = task.id;
          goal.updatedAt = now.toISOString();
        }
      } else {
        task.state = 'CANCELLED';
        if (goal) {
          if (goal.currentTaskId === task.id) goal.currentTaskId = undefined;
          goal.updatedAt = now.toISOString();
        }
      }
      return { approval };
    });

    if (result.error) throw new Error(result.error);
    if (!result.approval) throw new Error(`Approval resolution failed without a durable result: ${input.approvalId}`);
    return result.approval;
  }
}
