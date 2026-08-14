export interface BudgetPolicy {
  currency: string;
  allowPaidGeneration: boolean;
  monthlyCap: number;
  monthToDateSpend: number;
  perJobCap?: number;
}

export interface BudgetRequest {
  provider: string;
  estimatedCost: number;
  isPaid: boolean;
  jobId?: string;
}

export interface BudgetDecision {
  allowed: boolean;
  provider: string;
  estimatedCost: number;
  projectedMonthlySpend: number;
  remainingAfterRequest: number;
  blockers: string[];
}

function assertMoney(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number; received ${value}.`);
}

export function budgetPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetPolicy {
  const monthlyRaw = env.NEXUS_MONTHLY_PAID_GENERATION_BUDGET ?? env.NEXUS_MONTHLY_MEDIA_BUDGET_USD ?? '0';
  const spentRaw = env.NEXUS_MONTH_TO_DATE_PAID_GENERATION_SPEND ?? env.NEXUS_MONTH_TO_DATE_MEDIA_SPEND_USD ?? '0';
  const perJobRaw = env.NEXUS_PAID_GENERATION_PER_JOB_CAP ?? env.NEXUS_MEDIA_PER_JOB_CAP_USD;
  const monthlyCap = Number(monthlyRaw);
  const monthToDateSpend = Number(spentRaw);
  const perJobCap = perJobRaw == null || perJobRaw === '' ? undefined : Number(perJobRaw);

  assertMoney('monthly paid-generation/media budget', monthlyCap);
  assertMoney('month-to-date paid-generation/media spend', monthToDateSpend);
  if (perJobCap != null) assertMoney('paid-generation/media per-job cap', perJobCap);

  return {
    currency: env.NEXUS_BUDGET_CURRENCY?.trim() || 'USD',
    allowPaidGeneration: env.NEXUS_ALLOW_PAID_GENERATION === 'true',
    monthlyCap,
    monthToDateSpend,
    perJobCap,
  };
}

export function preflightBudget(policy: BudgetPolicy, request: BudgetRequest): BudgetDecision {
  assertMoney('monthlyCap', policy.monthlyCap);
  assertMoney('monthToDateSpend', policy.monthToDateSpend);
  if (policy.perJobCap != null) assertMoney('perJobCap', policy.perJobCap);
  assertMoney('estimatedCost', request.estimatedCost);

  const blockers: string[] = [];
  const projectedMonthlySpend = policy.monthToDateSpend + request.estimatedCost;

  if (request.isPaid && !policy.allowPaidGeneration) blockers.push('Paid generation is disabled. Set NEXUS_ALLOW_PAID_GENERATION=true only after explicit owner approval and provider readiness checks.');
  if (request.isPaid && policy.monthlyCap <= 0) blockers.push('No positive monthly paid-generation budget is configured.');
  if (request.isPaid && policy.perJobCap != null && request.estimatedCost > policy.perJobCap) blockers.push(`Estimated job cost ${request.estimatedCost} exceeds the per-job cap ${policy.perJobCap}.`);
  if (request.isPaid && projectedMonthlySpend > policy.monthlyCap) blockers.push(`Projected monthly spend ${projectedMonthlySpend} exceeds the cap ${policy.monthlyCap}.`);

  return {
    allowed: !request.isPaid || blockers.length === 0,
    provider: request.provider,
    estimatedCost: request.estimatedCost,
    projectedMonthlySpend,
    remainingAfterRequest: Math.max(0, policy.monthlyCap - projectedMonthlySpend),
    blockers,
  };
}

export function assertBudgetAllowed(policy: BudgetPolicy, request: BudgetRequest): BudgetDecision {
  const decision = preflightBudget(policy, request);
  if (!decision.allowed) throw new Error(`Budget preflight blocked ${request.provider}: ${decision.blockers.join(' ')}`);
  return decision;
}
