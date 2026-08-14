import { z } from 'zod';

export const goalStateSchema = z.enum([
  'PLANNING',
  'WORKING',
  'VERIFYING',
  'REPAIRING',
  'WAITING',
  'BLOCKED',
  'COMPLETED',
  'FAILED_SAFE',
]);

export const goalTaskStateSchema = z.enum([
  'QUEUED',
  'READY',
  'WORKING',
  'VERIFYING',
  'REPAIRING',
  'WAITING',
  'BLOCKED',
  'COMPLETED',
  'FAILED_SAFE',
  'CANCELLED',
]);

export const workerRoleSchema = z.enum(['NEXUS', 'CHATGPT', 'CLAUDE', 'VERIFIER', 'TOOL']);
export const riskClassSchema = z.enum(['GREEN', 'YELLOW', 'RED']);
export const approvalRequirementSchema = z.enum(['NONE', 'OWNER']);
export const goalTaskApprovalStatusSchema = z.enum(['PENDING', 'APPROVED', 'DENIED', 'INVALIDATED', 'EXPIRED']);
export const resumeTargetSchema = z.enum(['PLANNING', 'WORKING']);

export const resumeTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('TIME_REACHED'),
    notBefore: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    kind: z.literal('CAPABILITIES_READY'),
    capabilityIds: z.array(z.string().min(1).max(160)).min(1).max(50),
  }).strict(),
  z.object({
    kind: z.literal('TASKS_COMPLETED'),
    taskIds: z.array(z.string().min(1).max(120)).min(1).max(50),
  }).strict(),
]);

export const goalBudgetSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
  maxTimeMs: z.number().int().positive().optional(),
}).strict();

export const createGoalSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(240),
  objective: z.string().min(1).max(10_000),
  successCriteria: z.array(z.string().min(1).max(2_000)).min(1).max(50),
  milestone: z.string().min(1).max(240).optional(),
  priority: z.number().int().min(1).max(100).default(50),
  budget: goalBudgetSchema.default({}),
  nextAction: z.string().min(1).max(2_000).optional(),
}).strict();

export const enqueueGoalTaskSchema = z.object({
  id: z.string().min(1).max(120),
  goalId: z.string().min(1).max(120),
  title: z.string().min(1).max(240),
  intent: z.string().min(1).max(10_000),
  worker: workerRoleSchema,
  acceptanceCriteria: z.array(z.string().min(1).max(2_000)).min(1).max(50),
  verificationPlan: z.array(z.string().min(1).max(2_000)).min(1).max(50),
  dependencies: z.array(z.string().min(1).max(120)).max(50).default([]),
  requiredCapabilities: z.array(z.string().min(1).max(160)).max(50).default([]),
  allowedPaths: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  forbiddenPaths: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  riskClass: riskClassSchema.default('GREEN'),
  approvalRequirement: approvalRequirementSchema.default('NONE'),
  idempotencyKey: z.string().min(8).max(240),
  maxTurns: z.number().int().min(1).max(40).default(20),
  maxRepairs: z.number().int().min(0).max(10).default(5),
  timeLimitMs: z.number().int().min(1_000).max(86_400_000).default(1_800_000),
  tokenBudget: z.number().int().positive().optional(),
  costBudgetUsd: z.number().nonnegative().optional(),
}).strict();

export type GoalState = z.infer<typeof goalStateSchema>;
export type GoalTaskState = z.infer<typeof goalTaskStateSchema>;
export type WorkerRole = z.infer<typeof workerRoleSchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;
export type ApprovalRequirement = z.infer<typeof approvalRequirementSchema>;
export type GoalTaskApprovalStatus = z.infer<typeof goalTaskApprovalStatusSchema>;
export type ResumeTarget = z.infer<typeof resumeTargetSchema>;
export type ResumeTrigger = z.infer<typeof resumeTriggerSchema>;
export type GoalBudget = z.infer<typeof goalBudgetSchema>;
export type CreateGoalInput = z.input<typeof createGoalSchema>;
export type EnqueueGoalTaskInput = z.input<typeof enqueueGoalTaskSchema>;

export interface StoredGoal {
  id: string;
  title: string;
  objective: string;
  successCriteria: string[];
  milestone?: string;
  priority: number;
  budget: GoalBudget;
  state: GoalState;
  completedTaskIds: string[];
  failedAttempts: number;
  currentTaskId?: string;
  latestCheckpointId?: string;
  nextAction?: string;
  blocker?: string;
  resumeCondition?: string;
  resumeTriggers?: ResumeTrigger[];
  resumeTarget?: ResumeTarget;
  createdAt: string;
  updatedAt: string;
}

export interface StoredGoalTask {
  id: string;
  goalId: string;
  title: string;
  intent: string;
  worker: WorkerRole;
  state: GoalTaskState;
  acceptanceCriteria: string[];
  verificationPlan: string[];
  dependencies: string[];
  requiredCapabilities: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  riskClass: RiskClass;
  approvalRequirement: ApprovalRequirement;
  idempotencyKey: string;
  maxTurns: number;
  maxRepairs: number;
  timeLimitMs: number;
  tokenBudget?: number;
  costBudgetUsd?: number;
  attempt: number;
  lastFailure?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredGoalTaskApproval {
  id: string;
  goalId: string;
  taskId: string;
  executionAttempt: number;
  taskFingerprint: string;
  riskClass: RiskClass;
  status: GoalTaskApprovalStatus;
  requestedBy: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  invalidationReason?: string;
}

export interface StoredGoalCheckpoint {
  id: string;
  goalId: string;
  taskId: string;
  summary: string;
  verificationEvidence: string[];
  nextAction?: string;
  createdAt: string;
}
