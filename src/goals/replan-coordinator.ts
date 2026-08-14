import { capabilityReadiness } from '../capabilities/registry.js';
import type {
  OpenAIStrategyAudit,
  OpenAIStrategyRequest,
  OpenAIStrategyResponse,
  OpenAIStrategyResult,
} from '../openai/strategy-adapter.js';
import type { NexusStore } from '../storage/store.js';
import { detectStuck, type AttemptBudget, type StuckDiagnosis } from './stuck-detector.js';

export interface StrategyRequester {
  requestStrategy(input: OpenAIStrategyRequest): Promise<OpenAIStrategyResponse>;
}

export interface ReplanEvaluationInput {
  goalId: string;
  taskId: string;
  verifiedFacts?: string[];
  additionalFailureEvidence?: string[];
  constraints?: string[];
  decisionRequested?: string;
}

export interface ReplanEvaluation {
  action: 'CONTINUE' | 'STOP' | 'REPLAN';
  diagnosis: StuckDiagnosis;
  strategy?: OpenAIStrategyResult;
  audit?: OpenAIStrategyAudit;
}

function remainingPositive(limit: number | undefined, used: number): number | undefined {
  if (limit === undefined) return undefined;
  return Math.max(0, limit - used);
}

export class GoalReplanCoordinator {
  constructor(
    private readonly store: NexusStore,
    private readonly strategyRequester: StrategyRequester,
  ) {}

  async evaluate(input: ReplanEvaluationInput): Promise<ReplanEvaluation> {
    const db = await this.store.load();
    const goal = db.goals.find((item) => item.id === input.goalId);
    if (!goal) throw new Error(`Unknown goal: ${input.goalId}`);
    const task = db.goalTasks.find((item) => item.id === input.taskId && item.goalId === input.goalId);
    if (!task) throw new Error(`Unknown task for goal ${input.goalId}: ${input.taskId}`);

    const observations = db.goalAttemptObservations
      .filter((item) => item.goalId === input.goalId && item.taskId === input.taskId)
      .slice()
      .sort((a, b) => a.attemptNumber - b.attemptNumber || a.createdAt.localeCompare(b.createdAt));

    const budget: AttemptBudget = {
      maxTokens: task.tokenBudget,
      maxCostUsd: task.costBudgetUsd,
      maxTimeMs: task.timeLimitMs,
    };
    const diagnosis = detectStuck(observations, budget);

    if (diagnosis.shouldStop) {
      return { action: 'STOP', diagnosis };
    }
    if (!diagnosis.shouldReplan) {
      return { action: 'CONTINUE', diagnosis };
    }

    const maxTokens = remainingPositive(task.tokenBudget, diagnosis.totals.tokensUsed);
    const maxCostUsd = remainingPositive(task.costBudgetUsd, diagnosis.totals.costUsd);
    const maxTimeMs = remainingPositive(task.timeLimitMs, diagnosis.totals.elapsedMs);

    if (maxTokens === 0 || maxCostUsd === 0 || maxTimeMs === 0) {
      return {
        action: 'STOP',
        diagnosis: {
          ...diagnosis,
          shouldStop: true,
          shouldReplan: false,
          reasons: [...diagnosis.reasons, 'remaining task budget is insufficient for a bounded replan'],
        },
      };
    }

    const readyCapabilities = db.capabilities
      .filter((capability) => capabilityReadiness(capability).ready)
      .map((capability) => capability.id)
      .sort();

    const failedAttempts = observations
      .filter((observation) => observation.failureFingerprint)
      .map((observation) => `attempt ${observation.attemptNumber}: ${observation.failureFingerprint}`);

    const failureEvidence = [
      ...diagnosis.reasons.map((reason) => `stuck detector: ${reason}`),
      ...(task.lastFailure ? [`latest task failure: ${task.lastFailure}`] : []),
      ...(input.additionalFailureEvidence ?? []),
    ];

    const constraints = [
      `Task risk class: ${task.riskClass}.`,
      `Task approval requirement: ${task.approvalRequirement}.`,
      `Maximum Claude turns: ${task.maxTurns}.`,
      `Maximum repairs: ${task.maxRepairs}.`,
      ...(task.allowedPaths.length ? [`Allowed paths: ${task.allowedPaths.join(', ')}`] : []),
      ...(task.forbiddenPaths.length ? [`Forbidden paths: ${task.forbiddenPaths.join(', ')}`] : []),
      'OpenAI is advisory only. NEXUS retains approvals, execution authority, budgets, capability gates, and deterministic verification.',
      ...(input.constraints ?? []),
    ];

    const budgetRemaining: OpenAIStrategyRequest['budgetRemaining'] = {};
    if (maxTokens !== undefined) budgetRemaining.maxTokens = Math.floor(maxTokens);
    if (maxCostUsd !== undefined) budgetRemaining.maxCostUsd = maxCostUsd;
    if (maxTimeMs !== undefined) budgetRemaining.maxTimeMs = Math.floor(maxTimeMs);

    const response = await this.strategyRequester.requestStrategy({
      goalId: goal.id,
      taskId: task.id,
      objective: goal.objective,
      currentState: JSON.stringify({
        goalState: goal.state,
        taskState: task.state,
        taskTitle: task.title,
        taskIntent: task.intent,
        attempt: task.attempt,
        nextAction: goal.nextAction,
      }),
      verifiedFacts: input.verifiedFacts ?? [],
      failedAttempts,
      failureEvidence,
      constraints,
      availableCapabilities: readyCapabilities,
      budgetRemaining,
      decisionRequested: input.decisionRequested ?? 'Diagnose why progress stalled and propose a materially different bounded next strategy. Do not execute it.',
    });

    return {
      action: 'REPLAN',
      diagnosis,
      strategy: response.result,
      audit: response.audit,
    };
  }
}
