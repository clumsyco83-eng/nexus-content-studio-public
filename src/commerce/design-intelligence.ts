import type { DesignBrief, DesignDirection, RankedDesignDirection } from './types.js';

const DESIGN_WEIGHTS = {
  buyerFit: 0.35,
  marketFit: 0.30,
  distinctiveness: 0.25,
  readability: 0.10,
} as const;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function scoreDesignDirection(direction: DesignDirection): RankedDesignDirection {
  const buyerFit = clampScore(direction.buyerFit);
  const marketFit = clampScore(direction.marketFit);
  const distinctiveness = clampScore(direction.distinctiveness);
  const readability = clampScore(direction.readability);

  const designScore = Number((
    buyerFit * DESIGN_WEIGHTS.buyerFit +
    marketFit * DESIGN_WEIGHTS.marketFit +
    distinctiveness * DESIGN_WEIGHTS.distinctiveness +
    readability * DESIGN_WEIGHTS.readability
  ).toFixed(1));

  return { ...direction, buyerFit, marketFit, distinctiveness, readability, designScore };
}

export function rankDesignDirections(directions: DesignDirection[]): RankedDesignDirection[] {
  return directions
    .map(scoreDesignDirection)
    .sort((a, b) => b.designScore - a.designScore || a.name.localeCompare(b.name));
}

export function createDesignBrief(directions: DesignDirection[], brandRules: string[]): DesignBrief {
  const ranked = rankDesignDirections(directions);
  if (ranked.length === 0) throw new Error('At least one design direction is required.');

  const best = ranked[0];
  return {
    directionId: best.id,
    directionName: best.name,
    palette: best.palette,
    headingStyle: best.headingStyle,
    bodyStyle: best.bodyStyle,
    layoutStyle: best.layoutStyle,
    rules: [...brandRules],
    evidence: [...best.evidence],
    score: best.designScore,
  };
}
