import type { AnalyticsFormat, AnalyticsPlatform, LearningObservation } from './learning-engine.js';

export interface ExperimentKey {
  brand: string;
  platform: AnalyticsPlatform;
  format: AnalyticsFormat;
  dimension: 'hook' | 'topic' | 'visual_strategy' | 'provider' | 'duration' | 'cta' | 'posting_window';
  variant: string;
}

export interface ExperimentRecord {
  key: ExperimentKey;
  observations: string[];
  averageRelativeScore: number;
  promoted: boolean;
  confidence: 'low' | 'medium' | 'high';
  updatedAt: string;
}

export function buildExperimentRecord(
  key: ExperimentKey,
  observations: LearningObservation[],
): ExperimentRecord {
  const matching = observations.filter((o) => Boolean(o.jobId));
  const averageRelativeScore = matching.length
    ? matching.reduce((sum, item) => sum + item.relativeScore, 0) / matching.length
    : 0;

  const strong = matching.filter((item) => item.relativeScore >= 1.2).length;
  const promoted = matching.length >= 3 && strong / matching.length >= 0.67;
  const confidence: ExperimentRecord['confidence'] = matching.length >= 20 ? 'high' : matching.length >= 8 ? 'medium' : 'low';

  return {
    key,
    observations: matching.map((item) => item.jobId),
    averageRelativeScore,
    promoted,
    confidence,
    updatedAt: new Date().toISOString(),
  };
}

export function compareVariants(records: ExperimentRecord[]): ExperimentRecord[] {
  return [...records].sort((a, b) => b.averageRelativeScore - a.averageRelativeScore);
}
