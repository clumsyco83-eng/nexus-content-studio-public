export type ContentFormat =
  | 'short_video'
  | 'carousel'
  | 'infographic'
  | 'quote_card'
  | 'story'
  | 'text_post'
  | 'animated_carousel'
  | 'static_explainer';

export type FormatCandidate = {
  format: ContentFormat;
  hookStrength: number;
  informationDensity: number;
  emotionalImpact: number;
  saveSharePotential: number;
  productionCost: number;
  turnaroundSpeed: number;
  platformFit: number;
  brandFit: number;
  motionValue: number;
  recentPerformance: number;
};

export type FormatRoutingMode = 'economy' | 'balanced' | 'hero';

export function scoreFormat(candidate: FormatCandidate, mode: FormatRoutingMode): number {
  const positive =
    candidate.hookStrength * 1.3 +
    candidate.informationDensity * 1.0 +
    candidate.emotionalImpact * 1.1 +
    candidate.saveSharePotential * 1.25 +
    candidate.turnaroundSpeed * (mode === 'economy' ? 1.0 : 0.5) +
    candidate.platformFit * 1.25 +
    candidate.brandFit * 1.4 +
    candidate.motionValue * (candidate.format === 'short_video' || candidate.format === 'animated_carousel' ? 0.9 : 0.25) +
    candidate.recentPerformance * 1.0;

  const costPenalty = candidate.productionCost * (mode === 'economy' ? 1.5 : mode === 'hero' ? 0.35 : 0.8);
  return positive - costPenalty;
}

export function rankFormats(candidates: FormatCandidate[], mode: FormatRoutingMode) {
  return [...candidates]
    .map((candidate) => ({ ...candidate, score: scoreFormat(candidate, mode) }))
    .sort((a, b) => b.score - a.score);
}

export function chooseDailyMix(ranked: ReturnType<typeof rankFormats>, count = 3) {
  const picked: typeof ranked = [];
  const seen = new Set<ContentFormat>();

  for (const item of ranked) {
    if (picked.length >= count) break;
    if (!seen.has(item.format)) {
      picked.push(item);
      seen.add(item.format);
    }
  }

  return picked;
}
