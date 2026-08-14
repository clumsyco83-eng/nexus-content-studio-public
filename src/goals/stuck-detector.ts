export interface AttemptObservation {
  attemptNumber: number;
  strategyFingerprint: string;
  failureFingerprint?: string;
  verificationScore?: number;
  changedPaths?: string[];
  tokensUsed?: number;
  costUsd?: number;
  elapsedMs?: number;
  toolEnvelopeHash?: string;
  skillSetHash?: string;
}

export interface AttemptBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxTimeMs?: number;
}

export interface StuckPolicy {
  repeatedFailureThreshold: number;
  repeatedStrategyThreshold: number;
  noProgressThreshold: number;
  minimumVerificationImprovement: number;
}

export interface StuckDiagnosis {
  stuck: boolean;
  shouldStop: boolean;
  shouldReplan: boolean;
  reasons: string[];
  totals: {
    tokensUsed: number;
    costUsd: number;
    elapsedMs: number;
  };
}

export const defaultStuckPolicy: StuckPolicy = {
  repeatedFailureThreshold: 3,
  repeatedStrategyThreshold: 3,
  noProgressThreshold: 3,
  minimumVerificationImprovement: 0.01,
};

function repeatedTail<T>(values: T[], threshold: number): boolean {
  if (values.length < threshold) return false;
  const tail = values.slice(-threshold);
  return tail.every((value) => value === tail[0]);
}

function repeatedConsecutiveFailureTail(observations: AttemptObservation[], threshold: number): boolean {
  if (observations.length < threshold) return false;
  const tail = observations.slice(-threshold);
  const failure = tail[0]?.failureFingerprint;
  return Boolean(failure) && tail.every((item) => item.failureFingerprint === failure);
}

function changedPathFingerprint(paths: string[] | undefined): string {
  return [...(paths ?? [])].sort().join('|');
}

export function detectStuck(
  observations: AttemptObservation[],
  budget: AttemptBudget = {},
  policy: StuckPolicy = defaultStuckPolicy,
): StuckDiagnosis {
  const ordered = observations.slice().sort((a, b) => a.attemptNumber - b.attemptNumber);
  const totals = ordered.reduce(
    (sum, item) => ({
      tokensUsed: sum.tokensUsed + (item.tokensUsed ?? 0),
      costUsd: sum.costUsd + (item.costUsd ?? 0),
      elapsedMs: sum.elapsedMs + (item.elapsedMs ?? 0),
    }),
    { tokensUsed: 0, costUsd: 0, elapsedMs: 0 },
  );

  const reasons: string[] = [];
  let shouldStop = false;

  if (budget.maxTokens !== undefined && totals.tokensUsed >= budget.maxTokens) {
    reasons.push(`token budget exhausted (${totals.tokensUsed}/${budget.maxTokens})`);
    shouldStop = true;
  }
  if (budget.maxCostUsd !== undefined && totals.costUsd >= budget.maxCostUsd) {
    reasons.push(`cost budget exhausted (${totals.costUsd}/${budget.maxCostUsd})`);
    shouldStop = true;
  }
  if (budget.maxTimeMs !== undefined && totals.elapsedMs >= budget.maxTimeMs) {
    reasons.push(`time budget exhausted (${totals.elapsedMs}/${budget.maxTimeMs} ms)`);
    shouldStop = true;
  }

  const strategies = ordered.map((item) => item.strategyFingerprint);
  const pathFingerprints = ordered.map((item) => changedPathFingerprint(item.changedPaths));

  const repeatedFailure = repeatedConsecutiveFailureTail(ordered, policy.repeatedFailureThreshold);
  const repeatedStrategy = repeatedTail(strategies, policy.repeatedStrategyThreshold);
  const repeatedPaths = pathFingerprints.length > 0 && repeatedTail(pathFingerprints, policy.repeatedStrategyThreshold);

  if (repeatedFailure && repeatedStrategy) {
    reasons.push('same failure repeated consecutively under the same strategy');
  }
  if (repeatedStrategy && repeatedPaths && ordered.length >= policy.repeatedStrategyThreshold) {
    reasons.push('same strategy is repeatedly touching the same path set');
  }

  const scored = ordered.filter((item) => item.verificationScore !== undefined);
  if (scored.length >= policy.noProgressThreshold) {
    const tail = scored.slice(-policy.noProgressThreshold);
    const first = tail[0]!.verificationScore!;
    const bestAfter = Math.max(...tail.slice(1).map((item) => item.verificationScore!));
    if (bestAfter < first + policy.minimumVerificationImprovement) {
      reasons.push('verification score is not materially improving');
    }
  }

  const shouldReplan = !shouldStop && reasons.length > 0;
  return {
    stuck: shouldStop || shouldReplan,
    shouldStop,
    shouldReplan,
    reasons,
    totals,
  };
}
