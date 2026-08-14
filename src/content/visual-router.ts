export type VisualType = 'typography' | 'icon' | 'diagram' | 'illustration' | 'photo' | 'ai_image';
export type VisualProvider = 'deterministic_svg' | 'adobe' | 'canva' | 'openai_image' | 'fal' | 'manual_asset';

export interface VisualRequest {
  slideIndex: number;
  role: 'hook' | 'reframe' | 'insight' | 'synthesis' | 'cta';
  headline: string;
  body?: string;
  visualBrief: string;
  factualPrecision: 'low' | 'medium' | 'high';
  needsHumanRealism?: boolean;
  needsExactLabels?: boolean;
  emotionalIntensity?: number;
  budgetTier: 'economy' | 'balanced' | 'hero';
}

export interface VisualRoute {
  type: VisualType;
  provider: VisualProvider;
  reason: string;
  prompt?: string;
  estimatedCostClass: 'free' | 'low' | 'medium' | 'high';
  requiresFactCheck: boolean;
  deterministicTextOverlay: boolean;
}

function containsDiagramLanguage(value: string): boolean {
  return /cycle|process|steps|timeline|comparison|versus|vs\.|flow|system|framework|map|before|after/i.test(value);
}

function containsHumanLanguage(value: string): boolean {
  return /person|people|human|face|man|woman|child|crowd|worker|athlete|leader|couple/i.test(value);
}

export function routeVisual(request: VisualRequest): VisualRoute {
  const combined = `${request.headline} ${request.body ?? ''} ${request.visualBrief}`;

  if (request.needsExactLabels || request.factualPrecision === 'high' || containsDiagramLanguage(combined)) {
    return {
      type: 'diagram',
      provider: 'deterministic_svg',
      reason: 'Exact labels or factual structure require deterministic rendering.',
      estimatedCostClass: 'free',
      requiresFactCheck: true,
      deterministicTextOverlay: true,
    };
  }

  if (request.role === 'hook' && request.budgetTier === 'hero') {
    return {
      type: request.needsHumanRealism || containsHumanLanguage(combined) ? 'ai_image' : 'illustration',
      provider: 'openai_image',
      reason: 'Hero hook benefits from a distinctive visual while typography remains deterministic.',
      prompt: `Create an original editorial visual for Curious Grit. Concept: ${request.visualBrief}. Dark premium psychology/editorial mood, black and warm gold accents, strong negative space for headline overlay, no text, no logos, no copied creator style.`,
      estimatedCostClass: 'medium',
      requiresFactCheck: false,
      deterministicTextOverlay: true,
    };
  }

  if (request.needsHumanRealism || containsHumanLanguage(combined)) {
    return {
      type: 'photo',
      provider: request.budgetTier === 'economy' ? 'manual_asset' : 'adobe',
      reason: 'Human subject is better served by a licensed/curated photo or controlled visual source than invented factual imagery.',
      estimatedCostClass: request.budgetTier === 'economy' ? 'free' : 'low',
      requiresFactCheck: false,
      deterministicTextOverlay: true,
    };
  }

  if (request.role === 'insight' && (request.emotionalIntensity ?? 0) < 6) {
    return {
      type: 'typography',
      provider: 'deterministic_svg',
      reason: 'Insight is clear enough to let typography carry the slide and preserve production efficiency.',
      estimatedCostClass: 'free',
      requiresFactCheck: request.factualPrecision !== 'low',
      deterministicTextOverlay: true,
    };
  }

  return {
    type: 'illustration',
    provider: request.budgetTier === 'economy' ? 'deterministic_svg' : 'openai_image',
    reason: 'A supporting conceptual illustration adds visual variety without making the slide dependent on imagery.',
    prompt: request.budgetTier === 'economy' ? undefined : `Original conceptual editorial illustration for Curious Grit: ${request.visualBrief}. Minimal, intelligent, psychologically evocative, dark background, warm gold accent, no text, leave safe negative space for typography.`,
    estimatedCostClass: request.budgetTier === 'economy' ? 'free' : 'medium',
    requiresFactCheck: request.factualPrecision !== 'low',
    deterministicTextOverlay: true,
  };
}

export function routeCarouselVisuals(requests: VisualRequest[]): VisualRoute[] {
  return requests.map(routeVisual);
}
