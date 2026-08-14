import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const strategyRequestSchema = z.object({
  goalId: z.string().min(1).max(120),
  taskId: z.string().min(1).max(120).optional(),
  objective: z.string().min(1).max(20_000),
  currentState: z.string().min(1).max(8_000),
  verifiedFacts: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  failedAttempts: z.array(z.string().min(1).max(4_000)).max(50).default([]),
  failureEvidence: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  constraints: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  availableCapabilities: z.array(z.string().min(1).max(240)).max(100).default([]),
  budgetRemaining: z.object({
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    maxTimeMs: z.number().int().positive().optional(),
  }).strict().default({}),
  decisionRequested: z.string().min(1).max(8_000),
}).strict();

const strategyResultSchema = z.object({
  diagnosis: z.string().min(1).max(12_000),
  assumptions: z.array(z.string().min(1).max(4_000)).max(50),
  recommendedStrategy: z.string().min(1).max(12_000),
  alternativesConsidered: z.array(z.string().min(1).max(6_000)).max(20),
  risks: z.array(z.string().min(1).max(4_000)).max(50),
  requiredEvidence: z.array(z.string().min(1).max(4_000)).max(50),
  proposedNextTasks: z.array(z.object({
    title: z.string().min(1).max(240),
    intent: z.string().min(1).max(6_000),
    acceptanceCriteria: z.array(z.string().min(1).max(2_000)).min(1).max(20),
  }).strict()).max(20),
  ownerDecisionRequired: z.boolean(),
  ownerDecisionReason: z.string().max(4_000).nullable(),
}).strict();

export type OpenAIStrategyRequest = z.input<typeof strategyRequestSchema>;
export type OpenAIStrategyResult = z.infer<typeof strategyResultSchema>;

export interface OpenAIStrategyPolicy {
  endpoint: string;
  model: string;
  expectedResolvedModel?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxInputBytes: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}

export interface OpenAIStrategyAudit {
  clientRequestId: string;
  serverRequestId?: string;
  responseId?: string;
  model: string;
  resolvedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedMaxCostUsd?: number;
  actualCostUsd?: number;
}

export interface OpenAIStrategyResponse {
  result: OpenAIStrategyResult;
  audit: OpenAIStrategyAudit;
}

export interface StrategyTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
}

export interface StrategyTransportResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string | undefined>;
  json: unknown;
}

export type StrategyTransport = (request: StrategyTransportRequest) => Promise<StrategyTransportResponse>;

export class OpenAIStrategyError extends Error {
  constructor(
    message: string,
    public readonly kind: 'configuration' | 'budget' | 'timeout' | 'authentication' | 'rate_limit' | 'provider' | 'invalid_response',
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OpenAIStrategyError';
  }
}

const resultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis','assumptions','recommendedStrategy','alternativesConsidered','risks','requiredEvidence','proposedNextTasks','ownerDecisionRequired','ownerDecisionReason'],
  properties: {
    diagnosis: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    recommendedStrategy: { type: 'string' },
    alternativesConsidered: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    requiredEvidence: { type: 'array', items: { type: 'string' } },
    proposedNextTasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title','intent','acceptanceCriteria'], properties: { title: { type: 'string' }, intent: { type: 'string' }, acceptanceCriteria: { type: 'array', minItems: 1, items: { type: 'string' } } } } },
    ownerDecisionRequired: { type: 'boolean' },
    ownerDecisionReason: { type: ['string','null'] },
  },
} as const;

function finiteNonNegative(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new OpenAIStrategyError(`${name} must be a finite non-negative number.`, 'configuration', false);
  return value;
}

function positiveInteger(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new OpenAIStrategyError(`${name} must be an integer from 1 to ${max}; received ${raw}.`, 'configuration', false);
  return value;
}

export function openAIStrategyPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIStrategyPolicy {
  const model = env.NEXUS_OPENAI_STRATEGY_MODEL?.trim();
  if (!model) throw new OpenAIStrategyError('NEXUS_OPENAI_STRATEGY_MODEL is required. Do not silently assume a model.', 'configuration', false);
  return {
    endpoint: env.NEXUS_OPENAI_RESPONSES_URL?.trim() || 'https://api.openai.com/v1/responses',
    model,
    expectedResolvedModel: env.NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL?.trim() || undefined,
    timeoutMs: positiveInteger('NEXUS_OPENAI_TIMEOUT_MS', env.NEXUS_OPENAI_TIMEOUT_MS, 60_000, 300_000),
    maxOutputTokens: positiveInteger('NEXUS_OPENAI_MAX_OUTPUT_TOKENS', env.NEXUS_OPENAI_MAX_OUTPUT_TOKENS, 2_000, 32_000),
    maxInputBytes: positiveInteger('NEXUS_OPENAI_MAX_INPUT_BYTES', env.NEXUS_OPENAI_MAX_INPUT_BYTES, 64_000, 1_000_000),
    inputUsdPerMillionTokens: finiteNonNegative('NEXUS_OPENAI_INPUT_USD_PER_1M', env.NEXUS_OPENAI_INPUT_USD_PER_1M),
    outputUsdPerMillionTokens: finiteNonNegative('NEXUS_OPENAI_OUTPUT_USD_PER_1M', env.NEXUS_OPENAI_OUTPUT_USD_PER_1M),
  };
}

function extractOutputText(response: unknown): string {
  const parsed = z.object({ output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() }).passthrough()).optional() }).passthrough()).optional() }).passthrough().safeParse(response);
  if (!parsed.success) throw new OpenAIStrategyError('OpenAI returned an unrecognized response envelope.', 'invalid_response', false);
  for (const item of parsed.data.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type === 'refusal' && content.refusal) throw new OpenAIStrategyError(`OpenAI refused the strategy request: ${content.refusal}`, 'provider', false);
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  throw new OpenAIStrategyError('OpenAI response contained no output_text content.', 'invalid_response', false);
}

function metadataFromResponse(response: unknown): { inputTokens?: number; outputTokens?: number; totalTokens?: number; responseId?: string; resolvedModel?: string } {
  const parsed = z.object({ id: z.string().optional(), model: z.string().optional(), usage: z.object({ input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional(), total_tokens: z.number().int().nonnegative().optional() }).nullable().optional() }).passthrough().safeParse(response);
  if (!parsed.success) return {};
  return { responseId: parsed.data.id, resolvedModel: parsed.data.model, inputTokens: parsed.data.usage?.input_tokens, outputTokens: parsed.data.usage?.output_tokens, totalTokens: parsed.data.usage?.total_tokens };
}

function calculateCostUsd(inputTokens: number, outputTokens: number, policy: OpenAIStrategyPolicy): number | undefined {
  if (policy.inputUsdPerMillionTokens === undefined || policy.outputUsdPerMillionTokens === undefined) return undefined;
  return (inputTokens / 1_000_000) * policy.inputUsdPerMillionTokens + (outputTokens / 1_000_000) * policy.outputUsdPerMillionTokens;
}
function conservativeMaxCost(inputBytes: number, policy: OpenAIStrategyPolicy): number | undefined { return calculateCostUsd(inputBytes, policy.maxOutputTokens, policy); }

export function defaultStrategyTransport(apiKey: string): StrategyTransport {
  return async ({ url, headers, body, signal }) => {
    const response = await fetch(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal });
    let json: unknown;
    try { json = await response.json(); } catch { json = undefined; }
    return { status: response.status, ok: response.ok, headers: { 'x-request-id': response.headers.get('x-request-id') ?? undefined, 'retry-after': response.headers.get('retry-after') ?? undefined }, json };
  };
}

export class OpenAIStrategyAdapter {
  constructor(private readonly policy: OpenAIStrategyPolicy, private readonly transport: StrategyTransport) {}
  static fromEnv(env: NodeJS.ProcessEnv = process.env, transport?: StrategyTransport): OpenAIStrategyAdapter {
    const policy = openAIStrategyPolicyFromEnv(env);
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!transport && !apiKey) throw new OpenAIStrategyError('OPENAI_API_KEY is required at runtime and must not be committed.', 'configuration', false);
    return new OpenAIStrategyAdapter(policy, transport ?? defaultStrategyTransport(apiKey!));
  }

  async requestStrategy(input: OpenAIStrategyRequest): Promise<OpenAIStrategyResponse> {
    const request = strategyRequestSchema.parse(input);
    const normalizedPayload = JSON.stringify(request);
    const inputBytes = Buffer.byteLength(normalizedPayload, 'utf8');
    if (inputBytes > this.policy.maxInputBytes) throw new OpenAIStrategyError(`Strategy input exceeds byte budget (${inputBytes}/${this.policy.maxInputBytes}).`, 'budget', false);
    const requestMaxCost = request.budgetRemaining.maxCostUsd;
    const estimatedMaxCostUsd = conservativeMaxCost(inputBytes, this.policy);
    if (requestMaxCost !== undefined) {
      if (estimatedMaxCostUsd === undefined) throw new OpenAIStrategyError('A maxCostUsd budget was supplied but OpenAI input/output price rates are not configured. Set NEXUS_OPENAI_INPUT_USD_PER_1M and NEXUS_OPENAI_OUTPUT_USD_PER_1M.', 'configuration', false);
      if (estimatedMaxCostUsd > requestMaxCost) throw new OpenAIStrategyError(`OpenAI strategy preflight exceeds cost budget (estimated maximum $${estimatedMaxCostUsd.toFixed(6)} > $${requestMaxCost.toFixed(6)}).`, 'budget', false);
    }
    const clientRequestId = `nexus-${request.goalId}-${randomUUID()}`.replace(/[^\x20-\x7E]/g, '').slice(0, 512);
    const timeoutMs = Math.min(this.policy.timeoutMs, request.budgetRemaining.maxTimeMs ?? this.policy.timeoutMs);
    const maxOutputTokens = Math.min(this.policy.maxOutputTokens, request.budgetRemaining.maxTokens ?? this.policy.maxOutputTokens);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = {
      model: this.policy.model, store: false, max_output_tokens: maxOutputTokens,
      instructions: ['You are the bounded strategic advisory layer for NEXUS.','Use only the supplied facts and clearly label assumptions.','Do not claim execution, approval, verification, account access, machine access, or spending authority.','Recommend owner review whenever the decision is consequential, irreversible, credential-related, publishing-related, financial, or expands permissions.'].join(' '),
      input: [{ role: 'user', content: [{ type: 'input_text', text: normalizedPayload }] }],
      text: { format: { type: 'json_schema', name: 'nexus_strategy_response', strict: true, schema: resultJsonSchema } },
    };
    try {
      const response = await this.transport({ url: this.policy.endpoint, headers: { 'Content-Type': 'application/json', 'X-Client-Request-Id': clientRequestId }, body, signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new OpenAIStrategyError(`OpenAI authentication/authorization failed with HTTP ${response.status}.`, 'authentication', false);
        if (response.status === 429) throw new OpenAIStrategyError('OpenAI rate limit or quota prevented the strategy request.', 'rate_limit', true);
        if (response.status >= 500) throw new OpenAIStrategyError(`OpenAI provider error HTTP ${response.status}.`, 'provider', true);
        throw new OpenAIStrategyError(`OpenAI request failed with HTTP ${response.status}.`, 'provider', false);
      }
      const metadata = metadataFromResponse(response.json);
      if (this.policy.expectedResolvedModel) {
        if (!metadata.resolvedModel) throw new OpenAIStrategyError('OpenAI response did not report the resolved model ID required by NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL.', 'invalid_response', false);
        if (metadata.resolvedModel !== this.policy.expectedResolvedModel) throw new OpenAIStrategyError(`OpenAI resolved model drift detected: actual "${metadata.resolvedModel}" != evaluated "${this.policy.expectedResolvedModel}". Re-run the strategy evaluation gate before READY.`, 'invalid_response', false);
      }
      const outputText = extractOutputText(response.json);
      let decoded: unknown;
      try { decoded = JSON.parse(outputText); } catch { throw new OpenAIStrategyError('OpenAI structured output was not valid JSON.', 'invalid_response', false); }
      const result = strategyResultSchema.safeParse(decoded);
      if (!result.success) throw new OpenAIStrategyError(`OpenAI structured output failed NEXUS validation: ${result.error.message}`, 'invalid_response', false);
      const actualCostUsd = metadata.inputTokens !== undefined && metadata.outputTokens !== undefined ? calculateCostUsd(metadata.inputTokens, metadata.outputTokens, this.policy) : undefined;
      if (requestMaxCost !== undefined && actualCostUsd !== undefined && actualCostUsd > requestMaxCost) throw new OpenAIStrategyError(`OpenAI reported actual usage above the task cost budget ($${actualCostUsd.toFixed(6)} > $${requestMaxCost.toFixed(6)}). Stop further strategy calls and require owner review.`, 'budget', false);
      return { result: result.data, audit: { clientRequestId, serverRequestId: response.headers['x-request-id'], responseId: metadata.responseId, model: this.policy.model, resolvedModel: metadata.resolvedModel, inputTokens: metadata.inputTokens, outputTokens: metadata.outputTokens, totalTokens: metadata.totalTokens, estimatedMaxCostUsd, actualCostUsd } };
    } catch (error) {
      if (error instanceof OpenAIStrategyError) throw error;
      if (controller.signal.aborted) throw new OpenAIStrategyError(`OpenAI strategy request exceeded timeout budget (${timeoutMs} ms).`, 'timeout', true);
      throw new OpenAIStrategyError(`OpenAI strategy transport failed: ${error instanceof Error ? error.message : String(error)}`, 'provider', true);
    } finally { clearTimeout(timer); }
  }
}
