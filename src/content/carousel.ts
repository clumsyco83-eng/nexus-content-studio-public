export type CarouselObjective =
  | 'educate'
  | 'reframe'
  | 'save_share'
  | 'authority'
  | 'discussion';

export type CarouselApprovalStatus =
  | 'DRAFT'
  | 'READY_FOR_RENDER'
  | 'RENDERED'
  | 'QC_FAILED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'PUBLISHED';

export interface HookCandidate {
  text: string;
  scores: {
    curiosity: number;
    clarity: number;
    specificity: number;
    emotionalPull: number;
    credibility: number;
    brandFit: number;
  };
}

export interface CarouselSlide {
  index: number;
  role: 'hook' | 'reframe' | 'insight' | 'synthesis' | 'cta';
  eyebrow?: string;
  headline: string;
  body?: string;
  emphasis?: string[];
  visualBrief: string;
  sourceNotes?: string[];
}

export interface CarouselVisualSystem {
  aspectRatio: '4:5' | '1:1' | '9:16';
  palette: string[];
  typographyDirection: string;
  spacingDirection: string;
  brandMarkTreatment: string;
  numberingTreatment: string;
  imageStyle?: string;
}

export interface CarouselPackage {
  instagramCaption?: string;
  facebookCaption?: string;
  tiktokPhotoCaption?: string;
  hashtags?: string[];
  keywords?: string[];
  altText?: string[];
}

export interface CarouselSpec {
  id: string;
  brand: string;
  topic: string;
  audience: string;
  objective: CarouselObjective;
  hookCandidates: HookCandidate[];
  selectedHook: string;
  slides: CarouselSlide[];
  visualSystem: CarouselVisualSystem;
  renderInstructions: string;
  package: CarouselPackage;
  qcNotes: string[];
  approvalStatus: CarouselApprovalStatus;
}

export interface CarouselValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function words(value?: string): number {
  return value?.trim() ? value.trim().split(/\s+/).length : 0;
}

export function scoreHook(candidate: HookCandidate): number {
  const values = Object.values(candidate.scores);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rankHooks(candidates: HookCandidate[]): HookCandidate[] {
  return [...candidates].sort((a, b) => scoreHook(b) - scoreHook(a));
}

export function validateCarousel(spec: CarouselSpec): CarouselValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (spec.slides.length < 4) errors.push('Carousel should normally contain at least 4 slides.');
  if (spec.slides.length > 10) warnings.push('More than 10 slides may reduce completion unless the topic strongly supports it.');

  const first = spec.slides[0];
  if (!first || first.role !== 'hook') errors.push('Slide 1 must be the hook slide.');
  if (first && words(first.headline) > 16) warnings.push('Slide 1 headline may be too long for instant mobile comprehension.');

  for (const slide of spec.slides) {
    if (!slide.headline.trim()) errors.push(`Slide ${slide.index} is missing a headline.`);
    if (words(slide.headline) > 22) warnings.push(`Slide ${slide.index} headline is dense.`);
    if (words(slide.body) > 55) warnings.push(`Slide ${slide.index} body copy may be too dense for mobile.`);
    if (!slide.visualBrief.trim()) errors.push(`Slide ${slide.index} is missing a visual brief.`);
  }

  const indexes = spec.slides.map((slide) => slide.index);
  const expected = spec.slides.map((_, index) => index + 1);
  if (indexes.some((value, index) => value !== expected[index])) {
    errors.push('Slide indexes must be sequential starting at 1.');
  }

  if (!spec.hookCandidates.length) errors.push('At least one hook candidate is required.');
  if (!spec.hookCandidates.some((candidate) => candidate.text === spec.selectedHook)) {
    errors.push('Selected hook must match one of the hook candidates.');
  }

  if (!spec.visualSystem.palette.length) errors.push('A brand palette is required.');
  if (!spec.renderInstructions.trim()) errors.push('Provider-neutral render instructions are required.');

  return { ok: errors.length === 0, errors, warnings };
}

export function markAwaitingApproval(spec: CarouselSpec): CarouselSpec {
  const validation = validateCarousel(spec);
  if (!validation.ok) {
    return {
      ...spec,
      qcNotes: [...spec.qcNotes, ...validation.errors, ...validation.warnings],
      approvalStatus: 'QC_FAILED',
    };
  }

  return {
    ...spec,
    qcNotes: [...spec.qcNotes, ...validation.warnings],
    approvalStatus: 'AWAITING_APPROVAL',
  };
}
