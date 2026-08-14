import { createDesignBrief } from './design-intelligence.js';
import { selectBestOpportunity } from './opportunity-scorer.js';
import { classifyCommerceAction, commerceActionRequiresApproval } from './risk-policy.js';
import type {
  CommerceAction,
  CommerceDecision,
  DesignDirection,
  ProductOpportunityCandidate,
} from './types.js';

export const CURIOUS_GRIT_COMMERCE_BRAND_RULES = [
  'Use the active Curious Grit brand identity; do not invent a separate Etsy-only brand.',
  'Prioritize readability, practical usefulness, strong hierarchy, and generous spacing.',
  'Design for both A4 and US Letter when the product is printable.',
  'Do not copy competitor artwork, wording, or layouts; research is for pattern recognition only.',
  'Keep body text comfortably printable and avoid decorative typography for instructions or data entry.',
  'Every product must pass the commerce quality gate before it can be proposed for publishing.',
];

export interface PrepareCommerceDecisionInput {
  opportunities: ProductOpportunityCandidate[];
  designDirections?: DesignDirection[];
  actions?: CommerceAction[];
}

export function prepareCommerceDecision(input: PrepareCommerceDecisionInput): CommerceDecision {
  const recommendedProduct = selectBestOpportunity(input.opportunities);
  const designBrief = input.designDirections?.length
    ? createDesignBrief(input.designDirections, CURIOUS_GRIT_COMMERCE_BRAND_RULES)
    : undefined;

  const proposedActions = (input.actions ?? []).map((action) => ({
    action,
    risk: classifyCommerceAction(action),
    approvalRequired: commerceActionRequiresApproval(action),
  }));

  return {
    recommendedProduct,
    designBrief,
    proposedActions,
  };
}
