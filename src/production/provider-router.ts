import { preflightBudget, type BudgetPolicy } from './budget.js';

export type ProviderCapability = 'video' | 'image' | 'voice' | 'captions' | 'editing';
export type ProviderQualityTier = 'economy' | 'balanced' | 'premium';

export interface ProviderCandidate {
  id: string;
  enabled: boolean;
  ready: boolean;
  capabilities: ProviderCapability[];
  qualityTier: ProviderQualityTier;
  priority: number;
  estimatedCost: number;
  isPaid: boolean;
}

export interface ProviderRouteRequest {
  capability: ProviderCapability;
  minimumQuality?: ProviderQualityTier;
}

export interface ProviderRejection { provider: string; reasons: string[]; }
export interface ProviderRoutePlan { primary?: ProviderCandidate; fallbacks: ProviderCandidate[]; rejected: ProviderRejection[]; ready: boolean; }

const qualityRank: Record<ProviderQualityTier, number> = { economy: 1, balanced: 2, premium: 3 };

export function routeProvider(request: ProviderRouteRequest, candidates: ProviderCandidate[], budget: BudgetPolicy): ProviderRoutePlan {
  const minimumRank = qualityRank[request.minimumQuality ?? 'economy'];
  const eligible: ProviderCandidate[] = [];
  const rejected: ProviderRejection[] = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];
    if (!candidate.enabled) reasons.push('provider disabled');
    if (!candidate.ready) reasons.push('provider readiness not verified');
    if (!candidate.capabilities.includes(request.capability)) reasons.push(`missing ${request.capability} capability`);
    if (qualityRank[candidate.qualityTier] < minimumRank) reasons.push(`quality tier ${candidate.qualityTier} is below ${request.minimumQuality}`);

    const budgetDecision = preflightBudget(budget, { provider: candidate.id, estimatedCost: candidate.estimatedCost, isPaid: candidate.isPaid });
    reasons.push(...budgetDecision.blockers);

    if (reasons.length) rejected.push({ provider: candidate.id, reasons });
    else eligible.push(candidate);
  }

  eligible.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (qualityRank[a.qualityTier] !== qualityRank[b.qualityTier]) return qualityRank[b.qualityTier] - qualityRank[a.qualityTier];
    return a.estimatedCost - b.estimatedCost;
  });

  return { primary: eligible[0], fallbacks: eligible.slice(1), rejected, ready: eligible.length > 0 };
}

export function assertProviderRoute(plan: ProviderRoutePlan, capability: ProviderCapability): ProviderCandidate {
  if (!plan.primary) {
    const details = plan.rejected.map((item) => `${item.provider}: ${item.reasons.join(', ')}`).join('; ');
    throw new Error(`No safe ${capability} provider is ready. ${details}`.trim());
  }
  return plan.primary;
}
