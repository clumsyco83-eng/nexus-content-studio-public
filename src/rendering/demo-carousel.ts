import type { CarouselSpec } from '../content/carousel.js';
import { markAwaitingApproval } from '../content/carousel.js';
import { renderCarouselFiles } from './carousel-files.js';

const draft: CarouselSpec = {
  id: 'curious-grit-demo-psychology',
  brand: 'Curious Grit',
  topic: 'Common ways the mind distorts everyday judgment',
  audience: 'Curious adults interested in psychology and human behaviour',
  objective: 'save_share',
  hookCandidates: [
    {
      text: '5 ways your brain quietly bends reality',
      scores: {
        curiosity: 9,
        clarity: 9,
        specificity: 8,
        emotionalPull: 8,
        credibility: 8,
        brandFit: 10,
      },
    },
  ],
  selectedHook: '5 ways your brain quietly bends reality',
  slides: [
    {
      index: 1,
      role: 'hook',
      eyebrow: 'PSYCHOLOGY',
      headline: '5 ways your brain quietly bends reality',
      emphasis: ['Swipe to spot them.'],
      visualBrief: 'Minimal editorial brain/eye motif with strong black, white and gold contrast.',
    },
    {
      index: 2,
      role: 'insight',
      eyebrow: '01 · NEGATIVITY BIAS',
      headline: 'One bad moment can outweigh several good ones',
      body: 'Negative information often gets more attention and can influence judgment more strongly than equally intense positive information.',
      emphasis: ['Notice what your attention keeps returning to.'],
      visualBrief: 'Simple weighted-scale metaphor; one dark block versus several light blocks.',
    },
    {
      index: 3,
      role: 'insight',
      eyebrow: '02 · CONFIRMATION BIAS',
      headline: 'We search for evidence that agrees with us',
      body: 'Once we lean toward a belief, we can become more likely to notice supporting evidence and discount information that challenges it.',
      emphasis: ['Ask: what evidence would change my mind?'],
      visualBrief: 'Two-column evidence motif with one side highlighted in gold.',
    },
    {
      index: 4,
      role: 'insight',
      eyebrow: '03 · SPOTLIGHT EFFECT',
      headline: 'Other people notice you less than you think',
      body: 'We often overestimate how much other people are paying attention to our appearance, mistakes or awkward moments.',
      emphasis: ['Most people are busy thinking about themselves.'],
      visualBrief: 'Single spotlight fading into a large dark audience field.',
    },
    {
      index: 5,
      role: 'insight',
      eyebrow: '04 · SUNK COST',
      headline: 'Past effort can trap future decisions',
      body: 'Time, money or effort already spent can make it harder to walk away—even when continuing is no longer the best option.',
      emphasis: ['Decide from today forward, not from yesterday backward.'],
      visualBrief: 'Path splitting at a decision point with the old route dimmed.',
    },
    {
      index: 6,
      role: 'synthesis',
      eyebrow: '05 · FRAMING',
      headline: 'The same fact can feel different depending on how it is presented',
      body: 'Wording and context can change how people interpret equivalent information, especially when risk or reward is involved.',
      emphasis: ['Change the frame. Re-check the decision.'],
      visualBrief: 'Two frames around the same central object with different labels.',
    },
    {
      index: 7,
      role: 'cta',
      eyebrow: 'CURIOUS GRIT',
      headline: 'Your mind is powerful. It is not always neutral.',
      body: 'Stay curious enough to question your first interpretation.',
      emphasis: ['Understand more. Think deeper.'],
      visualBrief: 'Centered CG brand recall slide with restrained gold geometry.',
    },
  ],
  visualSystem: {
    aspectRatio: '4:5',
    palette: ['#0A0A0A', '#F5F5F2', '#D5A928', '#AAA9A3'],
    typographyDirection: 'Bold editorial sans-serif; high contrast; large mobile-first headlines.',
    spacingDirection: 'Generous margins, strong whitespace, limited copy per slide.',
    brandMarkTreatment: 'CURIOUS GRIT wordmark/footer on every slide; stronger brand recall on closing slide.',
    numberingTreatment: 'Two-digit slide count in lower-right footer.',
    imageStyle: 'Editorial psychology motifs, subtle grain, minimal diagrams; no stock-template appearance.',
  },
  renderInstructions: 'Render deterministic 1080x1350 slides. Keep final typography as real rendered text, not AI-generated lettering. Verify factual claims before publication.',
  package: {
    instagramCaption: 'Your brain is brilliant—but it takes shortcuts. Which one catches you most often?',
    facebookCaption: 'Five common thinking patterns can quietly shape everyday judgment. Which one do you notice most?',
    tiktokPhotoCaption: '5 ways your brain quietly bends reality 🧠',
    hashtags: ['#Psychology', '#HumanBehaviour', '#CuriousGrit', '#Mindset'],
  },
  qcNotes: ['Demo content: fact-check and source each claim before live publication.'],
  approvalStatus: 'DRAFT',
};

const ready = markAwaitingApproval(draft);
const result = await renderCarouselFiles(ready);

console.log(JSON.stringify(result, null, 2));
