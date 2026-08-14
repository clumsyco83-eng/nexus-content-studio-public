import { capabilityReadiness } from '../capabilities/registry.js';
import type { StoredCapability } from '../capabilities/schema.js';
import type { GoalState, GoalTaskState, StoredGoal, StoredGoalCheckpoint, StoredGoalTask } from '../goals/schema.js';
import type { StoredGoalAttemptObservation } from '../goals/attempt-observations.js';
import type { NexusDatabase } from '../storage/store.js';

export interface GoalTaskSummary {
  id: string;
  title: string;
  worker: string;
  state: GoalTaskState;
  riskClass: string;
  approvalRequirement: string;
  requiredCapabilities: string[];
  attempt: number;
  maxRepairs: number;
  maxTurns: number;
  tokenBudget?: number;
  costBudgetUsd?: number;
  actualCostUsd: number;
  actualTokens: number;
  lastFailure?: string;
}

export interface GoalCapabilitySummary {
  id: string;
  kind: string;
  ready: boolean;
  missingChecks: string[];
  staleReasons: string[];
  invalidations: string[];
}

export interface GoalCheckpointSummary {
  id: string;
  taskId: string;
  summary: string;
  verificationEvidence: string[];
  nextAction?: string;
  createdAt: string;
}

export interface GoalDashboardRow {
  id: string;
  title: string;
  objective: string;
  state: GoalState;
  milestone?: string;
  priority: number;
  progress: {
    completedTasks: number;
    totalTasks: number;
    failedSafeTasks: number;
    waitingTasks: number;
    blockedTasks: number;
  };
  currentTaskId?: string;
  nextAction?: string;
  blocker?: string;
  resumeCondition?: string;
  resumeTriggers: StoredGoal['resumeTriggers'];
  ownerApprovalTasks: Array<Pick<GoalTaskSummary, 'id' | 'title' | 'state' | 'riskClass' | 'approvalRequirement'>>;
  budget: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxTimeMs?: number;
    actualTokens: number;
    actualCostUsd: number;
  };
  capabilities: GoalCapabilitySummary[];
  tasks: GoalTaskSummary[];
  latestCheckpoint?: GoalCheckpointSummary;
  updatedAt: string;
}

export interface GoalDashboardSnapshot {
  summary: {
    total: number;
    working: number;
    waiting: number;
    blocked: number;
    failedSafe: number;
    completed: number;
    ownerApprovalTasks: number;
    missingCapabilities: number;
    staleCapabilities: number;
    trackedAttemptCostUsd: number;
    trackedAttemptTokens: number;
  };
  goals: GoalDashboardRow[];
  generatedAt: string;
}

const sensitivePatterns: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|NEXUS_DASHBOARD_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)\s*=\s*\S+/gi,
];

function sanitizeOperationalText(value: string): string {
  let sanitized = value;
  for (const pattern of sensitivePatterns) sanitized = sanitized.replace(pattern, '[REDACTED]');
  return sanitized.length > 600 ? `${sanitized.slice(0, 597)}...` : sanitized;
}

function attemptsForTask(attempts: StoredGoalAttemptObservation[], taskId: string): StoredGoalAttemptObservation[] {
  return attempts.filter((attempt) => attempt.taskId === taskId);
}

function summarizeTask(task: StoredGoalTask, attempts: StoredGoalAttemptObservation[]): GoalTaskSummary {
  const taskAttempts = attemptsForTask(attempts, task.id);
  return {
    id: task.id,
    title: task.title,
    worker: task.worker,
    state: task.state,
    riskClass: task.riskClass,
    approvalRequirement: task.approvalRequirement,
    requiredCapabilities: task.requiredCapabilities.slice(),
    attempt: task.attempt,
    maxRepairs: task.maxRepairs,
    maxTurns: task.maxTurns,
    tokenBudget: task.tokenBudget,
    costBudgetUsd: task.costBudgetUsd,
    actualCostUsd: taskAttempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    actualTokens: taskAttempts.reduce((sum, attempt) => sum + (attempt.tokensUsed ?? 0), 0),
    lastFailure: task.lastFailure,
  };
}

function summarizeCapability(capability: StoredCapability | undefined, id: string): GoalCapabilitySummary {
  if (!capability) {
    return {
      id,
      kind: 'UNKNOWN',
      ready: false,
      missingChecks: ['CAPABILITY_NOT_REGISTERED'],
      staleReasons: ['Capability is not registered.'],
      invalidations: [],
    };
  }
  const readiness = capabilityReadiness(capability);
  return {
    id,
    kind: capability.kind,
    ready: readiness.ready,
    missingChecks: readiness.missingChecks.slice(),
    staleReasons: readiness.staleReasons.map(sanitizeOperationalText),
    invalidations: readiness.invalidations.slice(-10).map(sanitizeOperationalText),
  };
}

function latestCheckpointForGoal(checkpoints: StoredGoalCheckpoint[], goalId: string): StoredGoalCheckpoint | undefined {
  return checkpoints
    .filter((checkpoint) => checkpoint.goalId === goalId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function checkpointSummary(checkpoint: StoredGoalCheckpoint | undefined): GoalCheckpointSummary | undefined {
  if (!checkpoint) return undefined;
  return {
    id: checkpoint.id,
    taskId: checkpoint.taskId,
    summary: checkpoint.summary,
    verificationEvidence: checkpoint.verificationEvidence.slice(),
    nextAction: checkpoint.nextAction,
    createdAt: checkpoint.createdAt,
  };
}

function buildGoalRow(db: NexusDatabase, goal: StoredGoal): GoalDashboardRow {
  const tasks = db.goalTasks.filter((task) => task.goalId === goal.id);
  const taskSummaries = tasks.map((task) => summarizeTask(task, db.goalAttemptObservations));
  const requiredCapabilityIds = [...new Set(tasks.flatMap((task) => task.requiredCapabilities))].sort();
  const capabilities = requiredCapabilityIds.map((id) => summarizeCapability(db.capabilities.find((item) => item.id === id), id));
  const latestCheckpoint = checkpointSummary(latestCheckpointForGoal(db.goalCheckpoints, goal.id));
  const actualCostUsd = taskSummaries.reduce((sum, task) => sum + task.actualCostUsd, 0);
  const actualTokens = taskSummaries.reduce((sum, task) => sum + task.actualTokens, 0);

  return {
    id: goal.id,
    title: goal.title,
    objective: goal.objective,
    state: goal.state,
    milestone: goal.milestone,
    priority: goal.priority,
    progress: {
      completedTasks: tasks.filter((task) => task.state === 'COMPLETED').length,
      totalTasks: tasks.length,
      failedSafeTasks: tasks.filter((task) => task.state === 'FAILED_SAFE').length,
      waitingTasks: tasks.filter((task) => task.state === 'WAITING').length,
      blockedTasks: tasks.filter((task) => task.state === 'BLOCKED').length,
    },
    currentTaskId: goal.currentTaskId,
    nextAction: goal.nextAction ?? latestCheckpoint?.nextAction,
    blocker: goal.blocker,
    resumeCondition: goal.resumeCondition,
    resumeTriggers: goal.resumeTriggers?.map((trigger) => ({ ...trigger })),
    ownerApprovalTasks: taskSummaries
      .filter((task) => task.approvalRequirement === 'OWNER' && !['COMPLETED', 'CANCELLED', 'FAILED_SAFE'].includes(task.state))
      .map(({ id, title, state, riskClass, approvalRequirement }) => ({ id, title, state, riskClass, approvalRequirement })),
    budget: {
      maxTokens: goal.budget.maxTokens,
      maxCostUsd: goal.budget.maxCostUsd,
      maxTimeMs: goal.budget.maxTimeMs,
      actualTokens,
      actualCostUsd,
    },
    capabilities,
    tasks: taskSummaries,
    latestCheckpoint,
    updatedAt: goal.updatedAt,
  };
}

export function buildGoalDashboardSnapshot(db: NexusDatabase): GoalDashboardSnapshot {
  const goals = db.goals
    .slice()
    .sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt))
    .map((goal) => buildGoalRow(db, goal));

  const allCapabilities = goals.flatMap((goal) => goal.capabilities);
  return {
    summary: {
      total: goals.length,
      working: goals.filter((goal) => ['PLANNING', 'WORKING', 'VERIFYING', 'REPAIRING'].includes(goal.state)).length,
      waiting: goals.filter((goal) => goal.state === 'WAITING').length,
      blocked: goals.filter((goal) => goal.state === 'BLOCKED').length,
      failedSafe: goals.filter((goal) => goal.state === 'FAILED_SAFE').length,
      completed: goals.filter((goal) => goal.state === 'COMPLETED').length,
      ownerApprovalTasks: goals.reduce((sum, goal) => sum + goal.ownerApprovalTasks.length, 0),
      missingCapabilities: new Set(allCapabilities.filter((capability) => !capability.ready).map((capability) => capability.id)).size,
      staleCapabilities: new Set(allCapabilities.filter((capability) => capability.staleReasons.length > 0).map((capability) => capability.id)).size,
      trackedAttemptCostUsd: goals.reduce((sum, goal) => sum + goal.budget.actualCostUsd, 0),
      trackedAttemptTokens: goals.reduce((sum, goal) => sum + goal.budget.actualTokens, 0),
    },
    goals,
    generatedAt: new Date().toISOString(),
  };
}
