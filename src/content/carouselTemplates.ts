export type CarouselTemplateId =
  | 'CG-C01'
  | 'CG-C02'
  | 'CG-C03'
  | 'CG-C04'
  | 'CG-C05'
  | 'CG-C06'
  | 'CG-C07';

export interface CarouselTemplateDefinition {
  id: CarouselTemplateId;
  name: string;
  purpose: string;
  maxBodyWords: number;
  supportsVisual: boolean;
  preferredUse: string[];
  requiredRegions: string[];
}

export const curiousGritCarouselTemplates: Record<
  CarouselTemplateId,
  CarouselTemplateDefinition
> = {
  'CG-C01': {
    id: 'CG-C01',
    name: 'Hook / Cover',
    purpose: 'Stop the scroll and create a swipe impulse.',
    maxBodyWords: 14,
    supportsVisual: true,
    preferredUse: ['hook', 'cover', 'information-gap'],
    requiredRegions: ['brandLabel', 'headline', 'accent', 'counter'],
  },
  'CG-C02': {
    id: 'CG-C02',
    name: 'Numbered Insight',
    purpose: 'Deliver one clear insight with an optional example.',
    maxBodyWords: 45,
    supportsVisual: true,
    preferredUse: ['insight', 'list-item', 'education'],
    requiredRegions: ['number', 'title', 'body'],
  },
  'CG-C03': {
    id: 'CG-C03',
    name: 'Statement / Reveal',
    purpose: 'Create a pacing break and emphasize one surprising idea.',
    maxBodyWords: 24,
    supportsVisual: true,
    preferredUse: ['reveal', 'surprise', 'pacing-break'],
    requiredRegions: ['statement', 'accent'],
  },
  'CG-C04': {
    id: 'CG-C04',
    name: 'Split Contrast',
    purpose: 'Compare two opposing behaviours, beliefs, or outcomes.',
    maxBodyWords: 36,
    supportsVisual: false,
    preferredUse: ['contrast', 'comparison', 'myth-vs-reality'],
    requiredRegions: ['heading', 'leftBlock', 'rightBlock'],
  },
  'CG-C05': {
    id: 'CG-C05',
    name: 'Mini Diagram / Framework',
    purpose: 'Explain a compact sequence, loop, or framework.',
    maxBodyWords: 34,
    supportsVisual: true,
    preferredUse: ['framework', 'process', 'loop', 'diagram'],
    requiredRegions: ['heading', 'diagram'],
  },
  'CG-C06': {
    id: 'CG-C06',
    name: 'Practical Action',
    purpose: 'Turn an insight into one concrete action.',
    maxBodyWords: 40,
    supportsVisual: true,
    preferredUse: ['action', 'tip', 'micro-process'],
    requiredRegions: ['actionLabel', 'recommendation'],
  },
  'CG-C07': {
    id: 'CG-C07',
    name: 'Closing / Brand Recall',
    purpose: 'Close with synthesis and reinforce the brand.',
    maxBodyWords: 30,
    supportsVisual: true,
    preferredUse: ['closing', 'summary', 'cta'],
    requiredRegions: ['closingThought', 'brandLockup'],
  },
};

export const defaultSevenSlideSequence: CarouselTemplateId[] = [
  'CG-C01',
  'CG-C02',
  'CG-C02',
  'CG-C03',
  'CG-C02',
  'CG-C06',
  'CG-C07',
];

export interface CarouselTemplateSelectionInput {
  slideIndex: number;
  totalSlides: number;
  role:
    | 'hook'
    | 'insight'
    | 'reveal'
    | 'contrast'
    | 'diagram'
    | 'action'
    | 'closing';
}

export function selectCarouselTemplate(
  input: CarouselTemplateSelectionInput,
): CarouselTemplateDefinition {
  const roleToTemplate: Record<CarouselTemplateSelectionInput['role'], CarouselTemplateId> = {
    hook: 'CG-C01',
    insight: 'CG-C02',
    reveal: 'CG-C03',
    contrast: 'CG-C04',
    diagram: 'CG-C05',
    action: 'CG-C06',
    closing: 'CG-C07',
  };

  if (input.slideIndex === 0) {
    return curiousGritCarouselTemplates['CG-C01'];
  }

  if (input.slideIndex === input.totalSlides - 1) {
    return curiousGritCarouselTemplates['CG-C07'];
  }

  return curiousGritCarouselTemplates[roleToTemplate[input.role]];
}
