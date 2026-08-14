import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { routeVisual, type VisualRequest } from '../content/visual-router.js';
import { rankHooks, type CarouselSpec, markAwaitingApproval } from '../content/carousel.js';
import { renderCarouselFiles, type CarouselRenderResult } from '../rendering/carousel-files.js';
import { writeApprovalGallery } from '../rendering/approval-gallery.js';

interface ProductionTestResult {
  id: string;
  brand: 'Curious Grit';
  mode: 'DRY_RUN';
  selectedHook: string;
  visualRoutes: ReturnType<typeof routeVisual>[];
  estimatedExternalCostClass: 'free' | 'low' | 'medium' | 'high';
  state: string;
  publishAllowed: false;
  renderedAssets: {
    outputDir: string;
    svgCount: number;
    pngCount: number;
    svgFiles: string[];
    pngFiles: string[];
    approvalGallery?: string;
  };
  warnings: string[];
}

const testSpec: CarouselSpec = {
  id: 'curious-grit-first-carousel',
  brand: 'Curious Grit',
  topic: 'Why unfinished tasks can stay on your mind',
  audience: 'Curious adults interested in psychology and human behaviour',
  objective: 'save_share',
  hookCandidates: [
    {
      text: 'Why does your brain keep replaying unfinished things?',
      scores: { curiosity: 9, clarity: 9, specificity: 8, emotionalPull: 8, credibility: 8, brandFit: 10 },
    },
    {
      text: 'The reason unfinished tasks can feel louder than finished ones',
      scores: { curiosity: 9, clarity: 8, specificity: 9, emotionalPull: 8, credibility: 8, brandFit: 10 },
    },
    {
      text: 'Your mind may hold onto unfinished work for a reason',
      scores: { curiosity: 8, clarity: 9, specificity: 7, emotionalPull: 7, credibility: 9, brandFit: 9 },
    },
  ],
  selectedHook: '',
  slides: [
    { index: 1, role: 'hook', headline: 'Why does your brain keep replaying unfinished things?', visualBrief: 'A restrained open-loop motif with strong negative space and premium editorial composition.' },
    { index: 2, role: 'reframe', eyebrow: 'THE OPEN LOOP', headline: 'Unfinished things can keep demanding attention', body: 'Use cautious language until the psychological claim is freshly verified.', visualBrief: 'Simple open-loop diagram with one incomplete ring and exact labels.' },
    { index: 3, role: 'insight', eyebrow: '01', headline: 'Your brain likes closure', body: 'Explain the idea concisely after fresh source verification.', visualBrief: 'Typography-led insight with a small closure icon.' },
    { index: 4, role: 'insight', eyebrow: '02', headline: 'Interrupted work can stay mentally active', body: 'Keep this claim marked pending verification in the dry run.', visualBrief: 'A clean before-versus-after comparison diagram.' },
    { index: 5, role: 'insight', eyebrow: '03', headline: 'A tiny next step can reduce the mental load', body: 'Present as a practical suggestion, not a clinical claim.', visualBrief: 'Minimal action-step graphic with a single arrow and checklist symbol.' },
    { index: 6, role: 'synthesis', headline: 'The goal is not to finish everything at once', body: 'Sometimes the brain just needs a clear next move.', visualBrief: 'Typography-forward synthesis with subtle path motif.' },
    { index: 7, role: 'cta', headline: 'Give the unfinished thing a next step', body: 'Stay curious. Think deeper. Curious Grit.', visualBrief: 'Premium brand close with CG mark and warm gold accent.' },
  ],
  visualSystem: {
    aspectRatio: '4:5',
    palette: ['#0A0A0A', '#F4F1E8', '#C9A227'],
    typographyDirection: 'Bold editorial sans serif with compact hierarchy and high mobile readability.',
    spacingDirection: 'Generous margins, strong negative space, restrained density.',
    brandMarkTreatment: 'Small Curious Grit mark in consistent footer zone.',
    numberingTreatment: 'Warm-gold two-digit numbering for insight slides.',
    imageStyle: 'Editorial psychology, minimal, premium, no generic glowing-AI look.',
  },
  renderInstructions: 'Render text deterministically. No AI-generated typography. Use exact 1080x1350 composition.',
  package: {
    instagramCaption: 'Why do unfinished things sometimes keep circling in your mind? A Curious Grit psychology carousel. Claims require fresh verification before publishing.',
    facebookCaption: 'A short visual exploration of why unfinished tasks can stay mentally active. Dry-run fixture; verify claims before publishing.',
    tiktokPhotoCaption: 'Why unfinished things can stay on your mind. Swipe through. #CuriousGrit',
    hashtags: ['#CuriousGrit', '#Psychology', '#HumanBehaviour', '#Mindset'],
    keywords: ['unfinished tasks', 'psychology', 'human behaviour', 'attention'],
    altText: [],
  },
  qcNotes: ['DRY RUN: psychological claims remain pending fresh verification.'],
  approvalStatus: 'DRAFT',
};

function costRank(cost: ReturnType<typeof routeVisual>['estimatedCostClass']): number {
  return { free: 0, low: 1, medium: 2, high: 3 }[cost];
}

function rankToCost(rank: number): ProductionTestResult['estimatedExternalCostClass'] {
  return ['free', 'low', 'medium', 'high'][Math.min(rank, 3)] as ProductionTestResult['estimatedExternalCostClass'];
}

function relativeAssetList(files: string[], outputDir: string): string[] {
  return files.map((file) => path.relative(outputDir, file));
}

export async function runFirstProductionTest(outputRoot = 'output/production-tests/curious-grit-first-carousel'): Promise<ProductionTestResult> {
  const rankedHooks = rankHooks(testSpec.hookCandidates);
  testSpec.selectedHook = rankedHooks[0]!.text;
  testSpec.slides[0]!.headline = testSpec.selectedHook;

  const requests: VisualRequest[] = testSpec.slides.map((slide) => ({
    slideIndex: slide.index,
    role: slide.role,
    headline: slide.headline,
    body: slide.body,
    visualBrief: slide.visualBrief,
    factualPrecision: slide.index === 2 || slide.index === 4 ? 'high' : 'medium',
    needsExactLabels: slide.index === 2 || slide.index === 4,
    emotionalIntensity: slide.index === 1 ? 8 : 4,
    budgetTier: 'economy',
  }));

  const visualRoutes = requests.map(routeVisual);
  const finalSpec = markAwaitingApproval(testSpec);
  const warnings = [...finalSpec.qcNotes];
  const maxCostRank = Math.max(...visualRoutes.map((route) => costRank(route.estimatedCostClass)));

  await mkdir(outputRoot, { recursive: true });

  let renderResult: CarouselRenderResult = {
    outputDir: path.resolve(outputRoot, 'rendered'),
    svgFiles: [],
    pngFiles: [],
    warnings: [],
  };

  let approvalGallery: string | undefined;

  if (finalSpec.approvalStatus !== 'QC_FAILED') {
    renderResult = await renderCarouselFiles(finalSpec, path.join(outputRoot, 'rendered'));
    warnings.push(...renderResult.warnings);
    approvalGallery = await writeApprovalGallery({
      spec: finalSpec,
      renderResult,
      outputRoot,
      publishAllowed: false,
      warnings,
    });
  } else {
    warnings.push('Rendering skipped because QC failed.');
  }

  const result: ProductionTestResult = {
    id: finalSpec.id,
    brand: 'Curious Grit',
    mode: 'DRY_RUN',
    selectedHook: finalSpec.selectedHook,
    visualRoutes,
    estimatedExternalCostClass: rankToCost(maxCostRank),
    state: finalSpec.approvalStatus,
    publishAllowed: false,
    renderedAssets: {
      outputDir: renderResult.outputDir,
      svgCount: renderResult.svgFiles.length,
      pngCount: renderResult.pngFiles.length,
      svgFiles: relativeAssetList(renderResult.svgFiles, outputRoot),
      pngFiles: relativeAssetList(renderResult.pngFiles, outputRoot),
      approvalGallery: approvalGallery ? path.relative(outputRoot, approvalGallery) : undefined,
    },
    warnings,
  };

  await writeFile(path.join(outputRoot, 'content-package.json'), JSON.stringify(finalSpec, null, 2));
  await writeFile(path.join(outputRoot, 'visual-routes.json'), JSON.stringify(visualRoutes, null, 2));
  await writeFile(path.join(outputRoot, 'qc-report.json'), JSON.stringify({ blockingErrors: finalSpec.approvalStatus === 'QC_FAILED' ? warnings : [], warnings }, null, 2));
  await writeFile(path.join(outputRoot, 'approval.json'), JSON.stringify({ state: finalSpec.approvalStatus, approvedByOwner: false, publishAllowed: false }, null, 2));
  await writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(result, null, 2));

  return result;
}
