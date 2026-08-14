import { randomUUID } from 'node:crypto';
import { capabilityReadiness } from '../capabilities/registry.js';
import type { NexusDatabase, NexusStore } from '../storage/store.js';
import {
  createGoalSchema,
  enqueueGoalTaskSchema,
  type CreateGoalInput,
  type EnqueueGoalTaskInput,
  type GoalState,
  type GoalTaskState,
  type StoredGoal,
  type StoredGoalCheckpoint,
  type StoredGoalTask,
} from './schema.js';

const allowedGoalTransitions: Record<GoalState, readonly GoalState[]> = {
  PLANNING: ['WORKING', 'WAITING', 'BLOCKED', 'FAILED_SAFE'],
  WORKING: ['VERIFYING', 'REPAIRING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED_SAFE'],
  VERIFYING: ['WORKING', 'REPAIRING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED_SAFE'],
  REPAIRING: ['WORKING', 'VERIFYING', 'WAITING', 'BLOCKED', 'FAILED_SAFE'],
  WAITING: ['PLANNING', 'WORKING', 'BLOCKED', 'FAILED_SAFE'],
  BLOCKED: ['PLANNING', 'WORKING', 'WAITING', 'FAILED_SAFE'],
  COMPLETED: [],
  FAILED_SAFE: ['PLANNING'],
};

const allowedTaskTransitions: Record<GoalTaskState, readonly GoalTaskState[]> = {
  QUEUED: ['READY', 'WAITING', 'BLOCKED', 'CANCELLED'],
  READY: ['WORKING', 'WAITING', 'BLOCKED', 'CANCELLED'],
  WORKING: ['VERIFYING', 'REPAIRING', 'WAITING', 'BLOCKED', 'FAILED_SAFE', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'REPAIRING', 'WAITING', 'BLOCKED', 'FAILED_SAFE'],
  REPAIRING: ['WORKING', 'VERIFYING', 'WAITING', 'BLOCKED', 'FAILED_SAFE', 'CANCELLED'],
  WAITING: ['READY', 'WORKING', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['READY', 'WORKING', 'WAITING', 'FAILED_SAFE', 'CANCELLED'],
  COMPLETED: [],
  FAILED_SAFE: ['READY'],
  CANCELLED: [],
};

const activeGoalStates = new Set<GoalState>(['WORKING', 'VERIFYING', 'REPAIRING']);
const executionTaskStates = new Set<GoalTaskState>(['WORKING', 'VERIFYING', 'REPAIRING', 'COMPLETED']);

type GoalTaskContract = Omit<
  StoredGoalTask,
  'state' | 'attempt' | 'lastFailure' | 'createdAt' | 'updatedAt'
>;

function taskContractFingerprint(task: GoalTaskContract): string {
  return JSON.stringify({
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
  });
}

function unreadyCapabilities(db: NexusDatabase, ids: string[]): string[] {
  return ids.filter((id) => {
    const capability = db.capabilities.find((item) => item.id === id);
    return !capability || !capabilityReadiness(capability).ready;
  });
}

export class GoalRepository {
  constructor(private readonly store: NexusStore) {}

  private now(): string { return new Date().toISOString(); }

  async createGoal(input: CreateGoalInput): Promise<StoredGoal> {
    const parsed = createGoalSchema.parse(input);
    return this.store.update((db) => {
      if (db.goals.some((goal) => goal.id === parsed.id)) throw new Error(`Goal already exists: ${parsed.id}`);
      const now = this.now();
      const goal: StoredGoal = {
        ...parsed,
        state: 'PLANNING',
        completedTaskIds: [],
        failedAttempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      db.goals.push(goal);
      return goal;
    });
  }

  async getGoal(id: string): Promise<StoredGoal | undefined> {
    const db = await this.store.load();
    return db.goals.find((goal) => goal.id === id);
  }

  async listGoals(): Promise<StoredGoal[]> {
    const db = await this.store.load();
    return db.goals.slice().sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  }

  async transitionGoal(
    id: string,
    next: GoalState,
    context: { blocker?: string; resumeCondition?: string; nextAction?: string } = {},
  ): Promise<StoredGoal> {
    return this.store.update((db) => {
      const goal = db.goals.find((item) => item.id === id);
      if (!goal) throw new Error(`Unknown goal: ${id}`);
      if (goal.state !== next && !allowedGoalTransitions[goal.state].includes(next)) {
        throw new Error(`Invalid goal transition ${goal.state} -> ${next}`);
      }
      if ((next === 'WAITING' || next === 'BLOCKED') && (!context.blocker || !context.resumeCondition)) {
        throw new Error(`${next} requires blocker and resumeCondition.`);
      }
      goal.state = next;
      goal.blocker = context.blocker;
      goal.resumeCondition = context.resumeCondition;
      if (context.nextAction !== undefined) goal.nextAction = context.nextAction;
      goal.updatedAt = this.now();
      return goal;
    });
  }

  async enqueueTask(input: EnqueueGoalTaskInput): Promise<StoredGoalTask> {
    const parsed = enqueueGoalTaskSchema.parse(input);
    return this.store.update((db) => {
      const goal = db.goals.find((item) => item.id === parsed.goalId);
      if (!goal) throw new Error(`Unknown goal: ${parsed.goalId}`);

      const duplicate = db.goalTasks.find((task) => task.idempotencyKey === parsed.idempotencyKey);
      if (duplicate) {
        if (taskContractFingerprint(duplicate) !== taskContractFingerprint(parsed)) {
          throw new Error(`Idempotency conflict: key ${parsed.idempotencyKey} was reused with a different task contract.`);
        }
        return duplicate;
      }
      if (db.goalTasks.some((task) => task.id === parsed.id)) throw new Error(`Task already exists: ${parsed.id}`);

      for (const dependencyId of parsed.dependencies) {
        const dependency = db.goalTasks.find((task) => task.id === dependencyId && task.goalId === parsed.goalId);
        if (!dependency) throw new Error(`Unknown dependency for goal ${parsed.goalId}: ${dependencyId}`);
      }

      const now = this.now();
      const dependenciesComplete = parsed.dependencies.every((dependencyId) =>
        db.goalTasks.some((task) => task.id === dependencyId && task.state === 'COMPLETED'),
      );
      const task: StoredGoalTask = {
        ...parsed,
        state: dependenciesComplete ? 'READY' : 'QUEUED',
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      };
      db.goalTasks.push(task);
      if (!goal.currentTaskId && task.state === 'READY' && unreadyCapabilities(db, task.requiredCapabilities).length === 0) {
        goal.currentTaskId = task.id;
      }
      goal.updatedAt = now;
      return task;
    });
  }

  async listReadyTasks(limit = 20): Promise<StoredGoalTask[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100.');
    const db = await this.store.load();
    return db.goalTasks
      .filter((task) => {
        if (task.state !== 'READY') return false;
        const goal = db.goals.find((item) => item.id === task.goalId);
        if (!goal || !activeGoalStates.has(goal.state)) return false;
        return unreadyCapabilities(db, task.requiredCapabilities).length === 0;
      })
      .sort((a, b) => {
        const goalA = db.goals.find((goal) => goal.id === a.goalId)?.priority ?? 100;
        const goalB = db.goals.find((goal) => goal.id === b.goalId)?.priority ?? 100;
        return goalA - goalB || a.createdAt.localeCompare(b.createdAt);
      })
      .slice(0, limit);
  }

  async transitionTask(taskId: string, next: GoalTaskState, failure?: string): Promise<StoredGoalTask> {
    return this.store.update((db) => {
      const task = db.goalTasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Unknown goal task: ${taskId}`);
      if (task.state !== next && !allowedTaskTransitions[task.state].includes(next)) {
        throw new Error(`Invalid task transition ${task.state} -> ${next}`);
      }

      const goal = db.goals.find((item) => item.id === task.goalId);
      if (!goal) throw new Error(`Goal missing for task ${taskId}: ${task.goalId}`);
      if (executionTaskStates.has(next) && !activeGoalStates.has(goal.state)) {
        throw new Error(`Goal ${goal.id} is ${goal.state}; task execution/verification cannot advance to ${next}.`);
      }
      if (executionTaskStates.has(next)) {
        const missing = unreadyCapabilities(db, task.requiredCapabilities);
        if (missing.length) throw new Error(`Task ${task.id} requires capabilities that are not ready: ${missing.join(', ')}.`);
      }
      if ((next === 'REPAIRING' || next === 'FAILED_SAFE') && !failure) {
        throw new Error(`${next} requires failure evidence.`);
      }
      if (next === 'REPAIRING') {
        const repairsUsed = Math.max(0, task.attempt - 1);
        if (repairsUsed >= task.maxRepairs) {
          throw new Error(`Repair limit exhausted for task ${task.id}: ${task.maxRepairs}.`);
        }
      }

      const now = this.now();
      task.state = next;
      task.updatedAt = now;

      if (next === 'WORKING' && task.attempt === 0) task.attempt = 1;
      if (next === 'REPAIRING') task.attempt += 1;
      if (next === 'REPAIRING' || next === 'FAILED_SAFE') {
        task.lastFailure = failure;
        goal.failedAttempts += 1;
      }

      if (next === 'COMPLETED') {
        if (!goal.completedTaskIds.includes(task.id)) goal.completedTaskIds.push(task.id);
        this.refreshDependentTasks(db.goalTasks, task.goalId, now);
        const nextReady = db.goalTasks.find((candidate) =>
          candidate.goalId === task.goalId &&
          candidate.state === 'READY' &&
          unreadyCapabilities(db, candidate.requiredCapabilities).length === 0,
        );
        goal.currentTaskId = nextReady?.id;
      } else if (['WORKING', 'VERIFYING', 'REPAIRING'].includes(next)) {
        goal.currentTaskId = task.id;
      }

      goal.updatedAt = now;
      return task;
    });
  }

  async checkpoint(input: {
    goalId: string;
    taskId: string;
    summary: string;
    verificationEvidence: string[];
    nextAction?: string;
  }): Promise<StoredGoalCheckpoint> {
    if (!input.summary.trim()) throw new Error('Checkpoint summary is required.');
    if (input.verificationEvidence.length < 1 || input.verificationEvidence.some((item) => !item.trim())) {
      throw new Error('Checkpoint requires non-empty verification evidence.');
    }
    return this.store.update((db) => {
      const goal = db.goals.find((item) => item.id === input.goalId);
      if (!goal) throw new Error(`Unknown goal: ${input.goalId}`);
      const task = db.goalTasks.find((item) => item.id === input.taskId && item.goalId === input.goalId);
      if (!task) throw new Error(`Unknown task for goal ${input.goalId}: ${input.taskId}`);
      if (task.state !== 'COMPLETED') throw new Error('Checkpoint task must be COMPLETED.');

      const checkpoint: StoredGoalCheckpoint = {
        id: randomUUID(),
        goalId: input.goalId,
        taskId: input.taskId,
        summary: input.summary.trim(),
        verificationEvidence: input.verificationEvidence.map((item) => item.trim()),
        nextAction: input.nextAction,
        createdAt: this.now(),
      };
      db.goalCheckpoints.push(checkpoint);
      goal.latestCheckpointId = checkpoint.id;
      if (input.nextAction !== undefined) goal.nextAction = input.nextAction;
      goal.updatedAt = checkpoint.createdAt;
      return checkpoint;
    });
  }

  private refreshDependentTasks(tasks: StoredGoalTask[], goalId: string, now: string): void {
    for (const candidate of tasks) {
      if (candidate.goalId !== goalId || candidate.state !== 'QUEUED') continue;
      const ready = candidate.dependencies.every((dependencyId) =>
        tasks.some((dependency) => dependency.id === dependencyId && dependency.goalId === goalId && dependency.state === 'COMPLETED'),
      );
      if (ready) {
        candidate.state = 'READY';
        candidate.updatedAt = now;
      }
    }
  }
}
