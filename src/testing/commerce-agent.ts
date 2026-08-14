import assert from 'node:assert/strict';
import { prepareCommerceDecision } from '../commerce/commerce-agent.js';
import { COMMERCE_PDF_ROUTING_POLICY, COMMERCE_PDF_TOOLS, getPdfTool } from '../commerce/pdf-tool-registry.js';
import { evaluateQualityGate, REQUIRED_QUALITY_CHECKS } from '../commerce/quality-gate.js';
import { assertCommerceActionAllowed, classifyCommerceAction } from '../commerce/risk-policy.js';
import type { ProductOpportunityCandidate, QualityCheck } from '../commerce/types.js';

const opportunities: ProductOpportunityCandidate[] = [
  {
    id: 'generic-planner',
    name: 'Generic Weekly Planner',
    targetBuyer: 'general planner buyer',
    problem: 'organize a normal week',
    demand: 75,
    competitionOpportunity: 20,
    differentiation: 25,
    brandFit: 45,
    productionEase: 95,
    marginPotential: 70,
    evidence: ['fixture: crowded generic planner market'],
  },
  {
    id: 'shift-money',
    name: 'Shift Worker Money System',
    targetBuyer: 'rotating and irregular shift workers',
    problem: 'turn variable shifts and overtime into a predictable money plan',
    demand: 82,
    competitionOpportunity: 72,
    differentiation: 90,
    brandFit: 92,
    productionEase: 78,
    marginPotential: 88,
    evidence: ['fixture: specialist product with strong Curious Grit fit'],
  },
];

const decision = prepareCommerceDecision({
  opportunities,
  designDirections: [
    {
      id: 'generic-beige',
      name: 'Generic Beige Minimal',
      palette: ['warm beige', 'white'],
      headingStyle: 'light serif',
      bodyStyle: 'neutral sans serif',
      layoutStyle: 'minimal cards',
      buyerFit: 70,
      marketFit: 78,
      distinctiveness: 35,
      readability: 90,
      evidence: ['fixture: common marketplace visual pattern'],
    },
    {
      id: 'clean-performance',
      name: 'Clean Performance',
      palette: ['charcoal', 'warm off-white', 'restrained metallic gold'],
      headingStyle: 'bold condensed sans serif',
      bodyStyle: 'high-readability sans serif',
      layoutStyle: 'structured dashboards with generous spacing',
      buyerFit: 92,
      marketFit: 88,
      distinctiveness: 84,
      readability: 96,
      evidence: ['fixture: Curious Grit brand-aligned specialist direction'],
    },
  ],
  actions: [
    { type: 'research_market', description: 'Research Etsy opportunities.' },
    { type: 'publish_listing', description: 'Publish approved product.' },
    { type: 'change_payment_settings', description: 'Change payout bank.' },
  ],
});

assert.equal(decision.recommendedProduct.id, 'shift-money');
assert.equal(decision.designBrief?.directionId, 'clean-performance');
assert.equal(decision.proposedActions[0].risk, 'GREEN');
assert.equal(decision.proposedActions[1].risk, 'YELLOW');
assert.equal(decision.proposedActions[1].approvalRequired, true);
assert.equal(decision.proposedActions[2].risk, 'RED');

assert.equal(classifyCommerceAction({
  type: 'start_ads',
  description: 'Start a small approved ad test.',
  estimatedSpendAud: 25,
}), 'YELLOW');

assert.equal(classifyCommerceAction({
  type: 'start_ads',
  description: 'Start a large ad campaign.',
  estimatedSpendAud: 250,
}), 'RED');

assert.throws(() => assertCommerceActionAllowed({
  type: 'publish_listing',
  description: 'Publish without approval.',
}), /Approval required/);

assert.doesNotThrow(() => assertCommerceActionAllowed({
  type: 'publish_listing',
  description: 'Publish after approval.',
}, true));

const toolIds = new Set(COMMERCE_PDF_TOOLS.map((tool) => tool.id));
for (const id of [
  'nexus',
  'html_css_templates',
  'weasyprint',
  'local_qa',
  'canva_free',
  'canva_pro',
  'claude',
  'ai_image_generation',
]) {
  assert.equal(toolIds.has(id as never), true, `Missing PDF tool registry entry: ${id}`);
}
assert.equal(COMMERCE_PDF_ROUTING_POLICY.localFirst, true);
assert.equal(COMMERCE_PDF_ROUTING_POLICY.useAiForDeterministicLayout, false);
assert.equal(getPdfTool('weasyprint').costClass, 'free_local');
assert.equal(getPdfTool('claude').costClass, 'usage_paid');

const perfectChecks: QualityCheck[] = REQUIRED_QUALITY_CHECKS.map((id) => ({
  id,
  passed: true,
  score: 100,
  details: 'fixture pass',
}));

const passReport = evaluateQualityGate(perfectChecks);
assert.equal(passReport.passed, true);
assert.equal(passReport.overallScore, 100);

const spellingFailure = perfectChecks.map((check) => check.id === 'spelling'
  ? { ...check, passed: false, score: 92, details: 'Misspelled word detected on page 4.' }
  : check);

const failReport = evaluateQualityGate(spellingFailure);
assert.equal(failReport.passed, false);
assert.equal(failReport.blockingIssues.some((issue) => issue.id === 'spelling'), true);
assert.equal(failReport.repairFeedback.some((item) => item.includes('page 4')), true);

console.log('Curious Grit Commerce Agent V1 verification passed.');
