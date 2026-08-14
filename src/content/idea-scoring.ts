import type { ContentIdea } from '../types.js';

export type IdeaScoreDimension = 'novelty' | 'demand' | 'visualPotential' | 'brandFit' | 'evidenceQuality';

export interface IdeaScoreInput {
  novelty: number;
  demand: number;
  visualPotential: number;
  brandFit: number;
  evidenceQuality: number;
}

export interface IdeaScoreThresholds {
  minTotal: number;
  minEvidenceQuality: number;
  minBrandFit: number;
}

export interface IdeaScorecard {
  total: number;
  dimensions: IdeaScoreInput;
  qualified: boolean;
  blockers: string[];
}

export interface ScoredContentIdea extends ContentIdea {
  scorecard: IdeaScorecard;
}

const weights: Record<IdeaScoreDimension, number> = {
  novelty: 0.15,
  demand: 0.20,
  visualPotential: 0.15,
  brandFit: 0.25,
  evidenceQuality: 0.25,
};

const defaultThresholds: IdeaScoreThresholds = {
  minTotal: 65,
  minEvidenceQuality: 6,
  minBrandFit: 6,
};

function assertDimension(name: IdeaScoreDimension, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error(`Idea score ${name} must be a finite number from 0 to 10; received ${value}.`);
  }
}

export function scoreIdeaDimensions(
  dimensions: IdeaScoreInput,
  thresholds: Partial<IdeaScoreThresholds> = {},
): IdeaScorecard {
  for (const [name, value] of Object.entries(dimensions) as Array<[IdeaScoreDimension, number]>) {
    assertDimension(name, value);
  }

  const policy = { ...defaultThresholds, ...thresholds };
  const weighted = (Object.entries(weights) as Array<[IdeaScoreDimension, number]>)
    .reduce((sum, [name, weight]) => sum + dimensions[name] * weight, 0);
  const total = Math.round(weighted * 100) / 10;
  const blockers: string[] = [];

  if (total < policy.minTotal) blockers.push(`Total idea score ${total} is below ${policy.minTotal}.`);
  if (dimensions.evidenceQuality < policy.minEvidenceQuality) {
    blockers.push(`Evidence quality ${dimensions.evidenceQuality} is below ${policy.minEvidenceQuality}.`);
  }
  if (dimensions.brandFit < policy.minBrandFit) {
    blockers.push(`Brand fit ${dimensions.brandFit} is below ${policy.minBrandFit}.`);
  }

  return { total, dimensions, qualified: blockers.length === 0, blockers };
}

export function scoreContentIdea(
  idea: Omit<ContentIdea, 'score'>,
  dimensions: IdeaScoreInput,
  thresholds: Partial<IdeaScoreThresholds> = {},
): ScoredContentIdea {
  const scorecard = scoreIdeaDimensions(dimensions, thresholds);
  return { ...idea, score: scorecard.total, scorecard };
}

export function rankQualifiedIdeas(ideas: ScoredContentIdea[]): ScoredContentIdea[] {
  return ideas
    .filter((idea) => idea.scorecard.qualified)
    .slice()
    .sort((a, b) => b.score - a.score);
}
