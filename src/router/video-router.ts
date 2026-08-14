export type RoutingMode = 'economy' | 'balanced' | 'hero';

export type SceneType =
  | 'editorial_motion_graphics'
  | 'cinematic_human'
  | 'cinematic_environment'
  | 'abstract_concept'
  | 'product_or_object'
  | 'character_consistency'
  | 'action_complex'
  | 'dialogue_or_native_audio'
  | 'transition_or_extension'
  | 'image_animation'
  | 'typography_or_diagram';

export interface VideoSceneRequest {
  jobId: string;
  sceneId: string;
  sceneType: SceneType;
  durationSeconds: number;
  aspectRatio: '9:16' | '16:9' | '1:1' | string;
  requiresAudio?: boolean;
  requiresReferenceConsistency?: boolean;
  estimatedImportance?: number; // 0..1
  budgetCredits?: number;
}

export interface RouteHealth {
  enabled: boolean;
  healthy: boolean;
  creditsRemaining?: number;
  estimatedLatencySeconds?: number;
}

export interface VideoRouteCandidate {
  provider: string;
  model: string;
  sceneTypes: SceneType[];
  supportsAudio?: boolean;
  supportsReferences?: boolean;
  estimatedCostCredits?: number;
  expectedQuality?: number; // normalized 0..1; calibration source must be documented
  historicalAcceptanceRate?: number;
  health: RouteHealth;
}

export interface RoutingDecision {
  provider: string;
  model: string;
  score: number;
  reason: string[];
  alternatives: Array<{ provider: string; model: string; score: number }>;
  estimatedCostCredits?: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function affordabilityScore(cost: number | undefined, budget: number | undefined): number {
  if (cost == null || budget == null || budget <= 0) return 0.5;
  return clamp01(1 - cost / Math.max(budget, cost));
}

export function routeVideoScene(
  request: VideoSceneRequest,
  candidates: VideoRouteCandidate[],
  mode: RoutingMode = 'balanced',
): RoutingDecision {
  const eligible = candidates.filter((candidate) => {
    if (!candidate.health.enabled || !candidate.health.healthy) return false;
    if (!candidate.sceneTypes.includes(request.sceneType)) return false;
    if (request.requiresAudio && !candidate.supportsAudio) return false;
    if (request.requiresReferenceConsistency && !candidate.supportsReferences) return false;
    if (
      request.budgetCredits != null &&
      candidate.estimatedCostCredits != null &&
      candidate.estimatedCostCredits > request.budgetCredits
    ) return false;
    if (
      candidate.health.creditsRemaining != null &&
      candidate.estimatedCostCredits != null &&
      candidate.estimatedCostCredits > candidate.health.creditsRemaining
    ) return false;
    return true;
  });

  if (!eligible.length) {
    throw new Error(`No eligible video route for scene ${request.sceneId}`);
  }

  const weights = mode === 'economy'
    ? { quality: 0.20, acceptance: 0.20, affordability: 0.45, latency: 0.15 }
    : mode === 'hero'
      ? { quality: 0.55, acceptance: 0.25, affordability: 0.10, latency: 0.10 }
      : { quality: 0.35, acceptance: 0.30, affordability: 0.25, latency: 0.10 };

  const ranked = eligible.map((candidate) => {
    const quality = candidate.expectedQuality ?? 0.5;
    const acceptance = candidate.historicalAcceptanceRate ?? 0.5;
    const affordability = affordabilityScore(candidate.estimatedCostCredits, request.budgetCredits);
    const latency = candidate.health.estimatedLatencySeconds == null
      ? 0.5
      : clamp01(1 - candidate.health.estimatedLatencySeconds / 300);

    const score =
      quality * weights.quality +
      acceptance * weights.acceptance +
      affordability * weights.affordability +
      latency * weights.latency;

    return {
      candidate,
      score,
      reason: [
        `scene=${request.sceneType}`,
        `mode=${mode}`,
        `quality=${quality.toFixed(2)}`,
        `acceptance=${acceptance.toFixed(2)}`,
        `affordability=${affordability.toFixed(2)}`,
        `latency=${latency.toFixed(2)}`,
      ],
    };
  }).sort((a, b) => b.score - a.score);

  const winner = ranked[0];
  return {
    provider: winner.candidate.provider,
    model: winner.candidate.model,
    score: winner.score,
    reason: winner.reason,
    alternatives: ranked.slice(1, 4).map((entry) => ({
      provider: entry.candidate.provider,
      model: entry.candidate.model,
      score: entry.score,
    })),
    estimatedCostCredits: winner.candidate.estimatedCostCredits,
  };
}
