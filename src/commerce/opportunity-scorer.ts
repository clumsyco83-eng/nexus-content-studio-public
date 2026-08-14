import type { ProductOpportunityCandidate, ScoredOpportunity } from './types.js';

const WEIGHTS = {
  demand: 0.24,
  competitionOpportunity: 0.18,
  differentiation: 0.18,
  brandFit: 0.18,
  productionEase: 0.12,
  marginPotential: 0.10,
} as const;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function scoreOpportunity(candidate: ProductOpportunityCandidate): ScoredOpportunity {
  const scoreBreakdown = {
    demand: clampScore(candidate.demand),
    competitionOpportunity: clampScore(candidate.competitionOpportunity),
    differentiation: clampScore(candidate.differentiation),
    brandFit: clampScore(candidate.brandFit),
    productionEase: clampScore(candidate.productionEase),
    marginPotential: clampScore(candidate.marginPotential),
  };

  const opportunityScore = Number((
    scoreBreakdown.demand * WEIGHTS.demand +
    scoreBreakdown.competitionOpportunity * WEIGHTS.competitionOpportunity +
    scoreBreakdown.differentiation * WEIGHTS.differentiation +
    scoreBreakdown.brandFit * WEIGHTS.brandFit +
    scoreBreakdown.productionEase * WEIGHTS.productionEase +
    scoreBreakdown.marginPotential * WEIGHTS.marginPotential
  ).toFixed(1));

  return {
    ...candidate,
    opportunityScore,
    scoreBreakdown,
  };
}

export function rankOpportunities(candidates: ProductOpportunityCandidate[]): ScoredOpportunity[] {
  return candidates
    .map(scoreOpportunity)
    .sort((a, b) => b.opportunityScore - a.opportunityScore || a.name.localeCompare(b.name));
}

export function selectBestOpportunity(candidates: ProductOpportunityCandidate[]): ScoredOpportunity {
  const ranked = rankOpportunities(candidates);
  if (ranked.length === 0) throw new Error('At least one commerce opportunity candidate is required.');
  return ranked[0];
}
