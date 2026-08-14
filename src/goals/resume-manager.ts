import { capabilityReadiness } from '../capabilities/registry.js';
import type { NexusDatabase, NexusStore } from '../storage/store.js';
import {
  resumeTargetSchema,
  resumeTriggerSchema,
  type ResumeTarget,
  type ResumeTrigger,
} from './schema.js';

export interface ResumeEvaluation {
  goalId: string;
  eligible: boolean;
  target: ResumeTarget;
  reasons: string[];
}

function triggerSatisfied(db: NexusDatabase, trigger: ResumeTrigger, nowMs: number): { satisfied: boolean; reason: string } {
  switch (trigger.kind) {
    case 'TIME_REACHED': {
      const targetMs = Date.parse(trigger.notBefore);
      const satisfied = Number.isFinite(targetMs) && nowMs >= targetMs;
      return {
        satisfied,
        reason: satisfied ? `time reached: ${trigger.notBefore}` : `waiting until ${trigger.notBefore}`,
      };
    }
    case 'CAPABILITIES_READY': {
      const missing = trigger.capabilityIds.filter((id) => {
        const capability = db.capabilities.find((item) => item.id === id);
        return !capability || !capabilityReadiness(capability).ready;
      });
      return {
        satisfied: missing.length === 0,
        reason: missing.length === 0
          ? `capabilities ready: ${trigger.capabilityIds.join(', ')}`
          : `capabilities not ready: ${missing.join(', ')}`,
      };
    }
    case 'TASKS_COMPLETED': {
      const incomplete = trigger.taskIds.filter((id) => !db.goalTasks.some((task) => task.id === id && task.state === 'COMPLETED'));
      return {
        satisfied: incomplete.length === 0,
        reason: incomplete.length === 0
          ? `tasks completed: ${trigger.taskIds.join(', ')}`
          : `tasks incomplete: ${incomplete.join(', ')}`,
      };
    }
  }
}

function evaluateGoal(db: NexusDatabase, goalId: string, nowMs: number): ResumeEvaluation {
  const goal = db.goals.find((item) => item.id === goalId);
  if (!goal) throw new Error(`Unknown goal: ${goalId}`);
  const target = goal.resumeTarget ?? 'WORKING';
  if (goal.state !== 'WAITING' && goal.state !== 'BLOCKED') {
    return { goalId, eligible: false, target, reasons: [`goal state is ${goal.state}, not WAITING/BLOCKED`] };
  }
  const triggers = goal.resumeTriggers ?? [];
  if (triggers.length === 0) {
    return { goalId, eligible: false, target, reasons: ['no deterministic resume triggers configured'] };
  }
  const results = triggers.map((trigger) => triggerSatisfied(db, trigger, nowMs));
  return {
    goalId,
    eligible: results.every((result) => result.satisfied),
    target,
    reasons: results.map((result) => result.reason),
  };
}

export class GoalResumeManager {
  constructor(private readonly store: NexusStore) {}

  async configure(input: {
    goalId: string;
    triggers: ResumeTrigger[];
    target?: ResumeTarget;
  }): Promise<void> {
    const triggers = resumeTriggerSchema.array().min(1).max(20).parse(input.triggers);
    const target = resumeTargetSchema.parse(input.target ?? 'WORKING');
    await this.store.update((db) => {
      const goal = db.goals.find((item) => item.id === input.goalId);
      if (!goal) throw new Error(`Unknown goal: ${input.goalId}`);
      if (goal.state !== 'WAITING' && goal.state !== 'BLOCKED') {
        throw new Error(`Goal ${goal.id} must already be WAITING or BLOCKED before automatic resume is configured.`);
      }
      if (!goal.blocker || !goal.resumeCondition) {
        throw new Error(`Goal ${goal.id} is missing the human-readable blocker/resume condition required for safe waiting.`);
      }
      goal.resumeTriggers = triggers;
      goal.resumeTarget = target;
      goal.updatedAt = new Date().toISOString();
    });
  }

  async evaluate(goalId: string, now = new Date()): Promise<ResumeEvaluation> {
    if (!Number.isFinite(now.getTime())) throw new Error('Resume evaluation time must be valid.');
    const db = await this.store.load();
    return evaluateGoal(db, goalId, now.getTime());
  }

  async resumeEligible(now = new Date()): Promise<ResumeEvaluation[]> {
    if (!Number.isFinite(now.getTime())) throw new Error('Resume evaluation time must be valid.');
    const nowMs = now.getTime();
    return this.store.update((db) => {
      const evaluations = db.goals
        .filter((goal) => goal.state === 'WAITING' || goal.state === 'BLOCKED')
        .map((goal) => evaluateGoal(db, goal.id, nowMs));

      const resumed: ResumeEvaluation[] = [];
      for (const evaluation of evaluations) {
        if (!evaluation.eligible) continue;
        const goal = db.goals.find((item) => item.id === evaluation.goalId)!;
        goal.state = evaluation.target;
        goal.blocker = undefined;
        goal.resumeCondition = undefined;
        goal.resumeTriggers = undefined;
        goal.resumeTarget = undefined;
        goal.updatedAt = now.toISOString();
        resumed.push(evaluation);
      }
      return resumed;
    });
  }
}
