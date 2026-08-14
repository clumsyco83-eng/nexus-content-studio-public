import assert from 'node:assert/strict';
import { OpenAIStrategyAdapter, OpenAIStrategyError, openAIStrategyPolicyFromEnv, type StrategyTransport } from '../openai/strategy-adapter.js';

const validResult = {
  diagnosis: 'The current executor is blocked by a local reconciliation dependency.',
  assumptions: ['The supplied verified facts are complete.'],
  recommendedStrategy: 'Preserve state, reconcile the verified local commits, then rerun deterministic verification.',
  alternativesConsidered: ['Recreate the bridge from memory — rejected because it would discard verified local evidence.'],
  risks: ['Conflict resolution could weaken safety boundaries.'],
  requiredEvidence: ['Green Windows verification and unchanged Guardian/Watchdog controls.'],
  proposedNextTasks: [{ title: 'Reconcile verified bridge commits', intent: 'Bring the already verified local bridge into the current repository without guessing.', acceptanceCriteria: ['Verified commit hashes are preserved', 'Windows verification passes'] }],
  ownerDecisionRequired: true,
  ownerDecisionReason: 'The reconciliation changes the laptop runtime and requires the existing owner gate.',
};

function completedResponse(result = validResult, model: string | null = 'test-model-resolved-20260813') {
  return { id: 'resp_test_123', status: 'completed', ...(model !== null ? { model } : {}), output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result), annotations: [] }] }], usage: { input_tokens: 400, output_tokens: 200, total_tokens: 600 } };
}

async function main() {
  assert.throws(() => openAIStrategyPolicyFromEnv({}), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'configuration');
  const env = {
    NEXUS_OPENAI_STRATEGY_MODEL: 'test-model-pinned-by-operator',
    NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL: 'test-model-resolved-20260813',
    NEXUS_OPENAI_TIMEOUT_MS: '2000', NEXUS_OPENAI_MAX_OUTPUT_TOKENS: '1000', NEXUS_OPENAI_MAX_INPUT_BYTES: '16000',
    NEXUS_OPENAI_INPUT_USD_PER_1M: '1', NEXUS_OPENAI_OUTPUT_USD_PER_1M: '2',
  };
  const policy = openAIStrategyPolicyFromEnv(env);
  assert.equal(policy.model, 'test-model-pinned-by-operator'); assert.equal(policy.expectedResolvedModel, 'test-model-resolved-20260813'); assert.equal(policy.maxOutputTokens, 1000);

  let captured: Parameters<StrategyTransport>[0] | undefined;
  const successTransport: StrategyTransport = async (request) => { captured = request; return { status: 200, ok: true, headers: { 'x-request-id': 'req_server_123' }, json: completedResponse() }; };
  const adapter = OpenAIStrategyAdapter.fromEnv(env, successTransport);
  const response = await adapter.requestStrategy({
    goalId: 'million-dollar-project', taskId: 'strategy-test', objective: 'Choose the next safe engineering action.',
    currentState: 'Persistent Goal Engine is merged; laptop bridge reconciliation is still blocked locally.',
    verifiedFacts: ['Guardian and Watchdog must remain active.'], constraints: ['Do not recreate local verified bridge changes from guesses.'],
    availableCapabilities: ['goal-engine', 'capability-registry'], budgetRemaining: { maxTokens: 900, maxCostUsd: 0.01, maxTimeMs: 1500 },
    decisionRequested: 'Recommend the next action and required evidence.',
  });
  assert.equal(response.result.ownerDecisionRequired, true); assert.equal(response.audit.serverRequestId, 'req_server_123'); assert.equal(response.audit.responseId, 'resp_test_123');
  assert.equal(response.audit.model, 'test-model-pinned-by-operator'); assert.equal(response.audit.resolvedModel, 'test-model-resolved-20260813');
  assert.equal(response.audit.inputTokens, 400); assert.equal(response.audit.outputTokens, 200); assert.equal(response.audit.actualCostUsd, 0.0008); assert.ok(captured);
  assert.equal(captured.headers['Authorization'], undefined); assert.match(captured.headers['X-Client-Request-Id'] ?? '', /^nexus-million-dollar-project-/);
  const body = captured.body as Record<string, unknown>; assert.equal(body.model, 'test-model-pinned-by-operator'); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 900);
  const text = body.text as { format?: { type?: string; strict?: boolean } }; assert.equal(text.format?.type, 'json_schema'); assert.equal(text.format?.strict, true);

  const driftAdapter = OpenAIStrategyAdapter.fromEnv(env, async () => ({ status: 200, ok: true, headers: {}, json: completedResponse(validResult, 'unexpected-model-snapshot') }));
  await assert.rejects(() => driftAdapter.requestStrategy({ goalId: 'model-drift', objective: 'Reject provider model drift.', currentState: 'Provider returned a different resolved model.', decisionRequested: 'Fail closed.' }), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'invalid_response' && /resolved model drift/.test(error.message));

  const missingModelAdapter = OpenAIStrategyAdapter.fromEnv(env, async () => ({ status: 200, ok: true, headers: {}, json: completedResponse(validResult, null) }));
  await assert.rejects(() => missingModelAdapter.requestStrategy({ goalId: 'missing-model-evidence', objective: 'Require provider model identity evidence.', currentState: 'Provider omitted response model.', decisionRequested: 'Fail closed.' }), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'invalid_response' && /did not report the resolved model ID/.test(error.message));

  let called = false;
  const neverTransport: StrategyTransport = async () => { called = true; throw new Error('should not be called'); };
  const budgetAdapter = OpenAIStrategyAdapter.fromEnv(env, neverTransport);
  await assert.rejects(() => budgetAdapter.requestStrategy({ goalId: 'budget-block', objective: 'Block before network use.', currentState: 'Budget is intentionally too small.', decisionRequested: 'No call should occur.', budgetRemaining: { maxCostUsd: 0.000001 } }), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'budget' && !error.retryable);
  assert.equal(called, false);

  const missingPricing = OpenAIStrategyAdapter.fromEnv({ NEXUS_OPENAI_STRATEGY_MODEL: 'test-model' }, neverTransport);
  await assert.rejects(() => missingPricing.requestStrategy({ goalId: 'missing-pricing', objective: 'Cost budget requires explicit pricing.', currentState: 'Pricing config is absent.', decisionRequested: 'Fail closed.', budgetRemaining: { maxCostUsd: 1 } }), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'configuration'); assert.equal(called, false);

  const rateAdapter = OpenAIStrategyAdapter.fromEnv({ NEXUS_OPENAI_STRATEGY_MODEL: 'test-model' }, async () => ({ status: 429, ok: false, headers: { 'retry-after': '10' }, json: { error: { message: 'rate limit' } } }));
  await assert.rejects(() => rateAdapter.requestStrategy({ goalId: 'rate-limit', objective: 'Classify provider failure.', currentState: 'Provider returned 429.', decisionRequested: 'Return retryable failure.' }), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'rate_limit' && error.retryable);

  const invalidAdapter = OpenAIStrategyAdapter.fromEnv({ NEXUS_OPENAI_STRATEGY_MODEL: 'test-model' }, async () => ({ status: 200, ok: true, headers: {}, json: completedResponse({ ...validResult, ownerDecisionRequired: 'yes' } as unknown as typeof validResult) }));
  await assert.rejects(() => invalidAdapter.requestStrategy({ goalId: 'invalid-output', objective: 'Reject schema-invalid output.', currentState: 'Provider response is malformed.', decisionRequested: 'Fail closed.' }), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'invalid_response' && !error.retryable);
  assert.throws(() => OpenAIStrategyAdapter.fromEnv({ NEXUS_OPENAI_STRATEGY_MODEL: 'test-model' }), (error: unknown) => error instanceof OpenAIStrategyError && error.kind === 'configuration');
  console.log('PASS NEXUS OpenAI strategy adapter: requested/resolved model identity, strict structured output, store=false, request IDs, bounded tokens/time/cost, and fail-closed provider handling.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
