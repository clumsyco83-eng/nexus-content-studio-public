export type AnalyticsPlatform = 'instagram' | 'facebook' | 'youtube' | 'tiktok' | 'threads' | 'x' | 'linkedin';
export type AnalyticsFormat = 'carousel' | 'short_video' | 'static_image' | 'text';

export interface PerformanceSnapshot {
  jobId: string;
  brand: string;
  platform: AnalyticsPlatform;
  format: AnalyticsFormat;
  publishedAt: string;
  measuredAt: string;
  views?: number;
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  followsAttributed?: number;
  averageWatchSeconds?: number;
  completionRate?: number;
  clickThroughRate?: number;
  revenueUsd?: number;
  productionCostUsd?: number;
  hookId?: string;
  topicId?: string;
  visualStrategy?: string;
  videoProvider?: string;
  videoModel?: string;
}

export interface Baseline {
  platform: AnalyticsPlatform;
  format: AnalyticsFormat;
  medianViews?: number;
  medianSharesPer1k?: number;
  medianSavesPer1k?: number;
  medianFollowsPer1k?: number;
  medianCompletionRate?: number;
  sampleSize: number;
}

export interface PerformanceFeatures {
  views: number;
  engagementPer1k: number;
  sharesPer1k: number;
  savesPer1k: number;
  followsPer1k: number;
  completionRate?: number;
  costPer1kViews?: number;
  revenuePer1kViews?: number;
}

export interface LearningObservation {
  jobId: string;
  relativeScore: number;
  confidence: 'low' | 'medium' | 'high';
  features: PerformanceFeatures;
  strengths: string[];
  weaknesses: string[];
  hypotheses: string[];
  recommendedNextTests: string[];
}

const safeRatePer1k = (value: number | undefined, denominator: number): number =>
  denominator > 0 ? ((value ?? 0) / denominator) * 1000 : 0;

export function deriveFeatures(snapshot: PerformanceSnapshot): PerformanceFeatures {
  const views = Math.max(snapshot.views ?? snapshot.reach ?? snapshot.impressions ?? 0, 0);
  const likes = snapshot.likes ?? 0;
  const comments = snapshot.comments ?? 0;
  const shares = snapshot.shares ?? 0;
  const saves = snapshot.saves ?? 0;

  return {
    views,
    engagementPer1k: safeRatePer1k(likes + comments + shares + saves, views),
    sharesPer1k: safeRatePer1k(shares, views),
    savesPer1k: safeRatePer1k(saves, views),
    followsPer1k: safeRatePer1k(snapshot.followsAttributed, views),
    completionRate: snapshot.completionRate,
    costPer1kViews:
      snapshot.productionCostUsd != null && views > 0
        ? (snapshot.productionCostUsd / views) * 1000
        : undefined,
    revenuePer1kViews:
      snapshot.revenueUsd != null && views > 0
        ? (snapshot.revenueUsd / views) * 1000
        : undefined,
  };
}

function ratio(value: number | undefined, baseline: number | undefined): number | undefined {
  if (value == null || baseline == null || baseline <= 0) return undefined;
  return value / baseline;
}

export function evaluatePerformance(snapshot: PerformanceSnapshot, baseline?: Baseline): LearningObservation {
  const f = deriveFeatures(snapshot);
  const comparisons = [
    ratio(f.views, baseline?.medianViews),
    ratio(f.sharesPer1k, baseline?.medianSharesPer1k),
    ratio(f.savesPer1k, baseline?.medianSavesPer1k),
    ratio(f.followsPer1k, baseline?.medianFollowsPer1k),
    ratio(f.completionRate, baseline?.medianCompletionRate),
  ].filter((value): value is number => value != null && Number.isFinite(value));

  const relativeScore = comparisons.length
    ? comparisons.reduce((sum, value) => sum + Math.min(value, 3), 0) / comparisons.length
    : 1;

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const hypotheses: string[] = [];
  const recommendedNextTests: string[] = [];

  if (baseline?.medianSharesPer1k && f.sharesPer1k > baseline.medianSharesPer1k * 1.25) {
    strengths.push('Share rate materially exceeded baseline.');
    hypotheses.push('The idea may have strong social currency or identity relevance.');
    recommendedNextTests.push('Test a new hook on the same core insight without copying the winning post.');
  }

  if (baseline?.medianSavesPer1k && f.savesPer1k > baseline.medianSavesPer1k * 1.25) {
    strengths.push('Save rate materially exceeded baseline.');
    hypotheses.push('The content may be perceived as useful, reference-worthy, or worth revisiting.');
    recommendedNextTests.push('Test a deeper practical follow-up using the same educational value proposition.');
  }

  if (baseline?.medianFollowsPer1k && f.followsPer1k < baseline.medianFollowsPer1k * 0.75) {
    weaknesses.push('Follower conversion trailed baseline.');
    hypotheses.push('The post may perform as a standalone idea without clearly reinforcing the brand promise.');
    recommendedNextTests.push('Strengthen brand recall and closing promise without adding generic follow-bait.');
  }

  if (baseline?.medianCompletionRate && f.completionRate != null) {
    if (f.completionRate > baseline.medianCompletionRate * 1.15) {
      strengths.push('Completion/retention exceeded baseline.');
      recommendedNextTests.push('Preserve pacing structure and test a different topic family.');
    } else if (f.completionRate < baseline.medianCompletionRate * 0.80) {
      weaknesses.push('Completion/retention materially underperformed.');
      hypotheses.push('Hook-to-payoff pacing, density, or scene/slide progression may be weak.');
      recommendedNextTests.push('Shorten the setup and move the first payoff earlier.');
    }
  }

  if (f.costPer1kViews != null && f.costPer1kViews > 2 && relativeScore < 1) {
    weaknesses.push('Production cost was high relative to observed performance.');
    hypotheses.push('Premium visual generation may not have earned its incremental cost for this content type.');
    recommendedNextTests.push('Run a lower-cost typography/editorial variant against a comparable idea.');
  }

  const sampleSize = baseline?.sampleSize ?? 0;
  const confidence: LearningObservation['confidence'] = sampleSize >= 20 ? 'high' : sampleSize >= 8 ? 'medium' : 'low';

  if (!recommendedNextTests.length) {
    recommendedNextTests.push('Collect more comparable samples before changing strategy materially.');
  }

  return { jobId: snapshot.jobId, relativeScore, confidence, features: f, strengths, weaknesses, hypotheses, recommendedNextTests };
}

export function shouldPromotePattern(observations: LearningObservation[]): boolean {
  if (observations.length < 3) return false;
  const strong = observations.filter((o) => o.relativeScore >= 1.2).length;
  return strong / observations.length >= 0.67;
}
