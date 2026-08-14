import { OpenAIStrategyAdapter, OpenAIStrategyError } from '../openai/strategy-adapter.js';

const OPT_IN_VALUE = 'I_ACKNOWLEDGE_A_PAID_READ_ONLY_CALL';
const HARD_MAX_COST_USD = 0.05;
const DEFAULT_MAX_COST_USD = 0.02;

function smokeCostLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXUS_OPENAI_LIVE_SMOKE_MAX_COST_USD?.trim();
  const value = raw ? Number(raw) : DEFAULT_MAX_COST_USD;
  if (!Number.isFinite(value) || value <= 0 || value > HARD_MAX_COST_USD) throw new Error(`NEXUS_OPENAI_LIVE_SMOKE_MAX_COST_USD must be > 0 and <= $${HARD_MAX_COST_USD.toFixed(2)}.`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.NEXUS_OPENAI_LIVE_SMOKE !== OPT_IN_VALUE) throw new Error(`Live OpenAI smoke test is disabled. Set NEXUS_OPENAI_LIVE_SMOKE=${OPT_IN_VALUE} only for one deliberate paid, read-only verification call.`);
  const expectedResolvedModel = process.env.NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL?.trim();
  if (!expectedResolvedModel) throw new Error('NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL is required for live READY evidence. Record the exact evaluated provider-reported model ID.');
  const maxCostUsd = smokeCostLimit(process.env);
  const adapter = OpenAIStrategyAdapter.fromEnv(process.env);
  const response = await adapter.requestStrategy({
    goalId: 'openai-live-readiness-smoke',
    objective: 'Validate that the NEXUS OpenAI strategy adapter can make one bounded, read-only strategy request safely.',
    currentState: 'This is a one-call provider readiness smoke test. No files, accounts, publishing, spending actions, external tools, or machine actions are requested.',
    verifiedFacts: ['The deterministic OpenAI adapter contract has passed.','NEXUS Guardian and Watchdog must remain active.','Requested model, expected resolved model and current price rates are explicitly configured.'],
    failedAttempts: [], failureEvidence: [],
    constraints: ['Advisory output only.','Do not execute actions or claim execution authority.','Do not request secrets or credentials.','Do not approve consequential work.','Recommend at most one next validation step.'],
    availableCapabilities: ['NEXUS deterministic verification','Guardian','Watchdog'],
    budgetRemaining: { maxTokens: 300, maxCostUsd, maxTimeMs: 30_000 },
    decisionRequested: 'Return a concise readiness assessment and one safe next validation step. Do not take or propose external side effects.',
  });
  if (response.audit.actualCostUsd === undefined) throw new Error('Live smoke returned no calculable actualCostUsd. Explicit price rates are required before READY status.');
  if (response.audit.actualCostUsd > maxCostUsd) throw new Error(`Live smoke exceeded the hard task budget: $${response.audit.actualCostUsd.toFixed(6)} > $${maxCostUsd.toFixed(6)}.`);
  if (response.audit.model !== process.env.NEXUS_OPENAI_STRATEGY_MODEL?.trim()) throw new Error('Live smoke requested model does not match NEXUS_OPENAI_STRATEGY_MODEL.');
  if (response.audit.resolvedModel !== expectedResolvedModel) throw new Error('Live smoke provider-reported model does not match NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL.');
  console.log(JSON.stringify({ ok: true, mode: 'one-paid-read-only-smoke', requestedModel: response.audit.model, resolvedModel: response.audit.resolvedModel, clientRequestId: response.audit.clientRequestId, serverRequestId: response.audit.serverRequestId, responseId: response.audit.responseId, inputTokens: response.audit.inputTokens, outputTokens: response.audit.outputTokens, totalTokens: response.audit.totalTokens, actualCostUsd: response.audit.actualCostUsd, maxCostUsd, ownerDecisionRequired: response.result.ownerDecisionRequired, alternativesConsidered: response.result.alternativesConsidered.length, risksReported: response.result.risks.length, proposedNextTasks: response.result.proposedNextTasks.length }, null, 2));
  console.log('PASS NEXUS OpenAI live smoke: requested/resolved model identity, strict strategy JSON, usage/cost budget and sanitized metadata verified.');
}

main().catch((error) => {
  if (error instanceof OpenAIStrategyError) console.error(`OpenAI live smoke failed safely [${error.kind}] retryable=${error.retryable}: ${error.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
