import type { CommerceAction, CommerceRiskLevel } from './types.js';

const GREEN_ACTIONS = new Set([
  'research_market',
  'analyze_competitors',
  'generate_design_brief',
  'build_product_spec',
  'generate_pdf',
  'prepare_listing',
  'analyze_shop_metrics',
]);

const YELLOW_ACTIONS = new Set([
  'edit_shop_branding',
  'publish_listing',
  'edit_live_listing',
  'change_price',
  'create_discount',
  'start_ads',
]);

export function classifyCommerceAction(action: CommerceAction): CommerceRiskLevel {
  if (action.type === 'start_ads' && (action.estimatedSpendAud ?? 0) > 100) return 'RED';
  if (GREEN_ACTIONS.has(action.type)) return 'GREEN';
  if (YELLOW_ACTIONS.has(action.type)) return 'YELLOW';
  return 'RED';
}

export function commerceActionRequiresApproval(action: CommerceAction): boolean {
  return classifyCommerceAction(action) !== 'GREEN';
}

export function assertCommerceActionAllowed(action: CommerceAction, approved = false): void {
  const risk = classifyCommerceAction(action);
  if (risk === 'RED') {
    throw new Error(`Blocked RED commerce action: ${action.type}`);
  }
  if (risk === 'YELLOW' && !approved) {
    throw new Error(`Approval required for YELLOW commerce action: ${action.type}`);
  }
}
