export type CommerceRiskLevel = 'GREEN' | 'YELLOW' | 'RED';

export type CommerceActionType =
  | 'research_market'
  | 'analyze_competitors'
  | 'generate_design_brief'
  | 'build_product_spec'
  | 'generate_pdf'
  | 'prepare_listing'
  | 'analyze_shop_metrics'
  | 'edit_shop_branding'
  | 'publish_listing'
  | 'edit_live_listing'
  | 'change_price'
  | 'create_discount'
  | 'start_ads'
  | 'change_payment_settings'
  | 'change_security_settings'
  | 'mass_delete_listings'
  | 'uncapped_ad_spend';

export interface CommerceAction {
  type: CommerceActionType;
  description: string;
  target?: string;
  estimatedSpendAud?: number;
}

export interface ProductOpportunityCandidate {
  id: string;
  name: string;
  targetBuyer: string;
  problem: string;
  demand: number;
  competitionOpportunity: number;
  differentiation: number;
  brandFit: number;
  productionEase: number;
  marginPotential: number;
  evidence: string[];
}

export interface ScoredOpportunity extends ProductOpportunityCandidate {
  opportunityScore: number;
  scoreBreakdown: {
    demand: number;
    competitionOpportunity: number;
    differentiation: number;
    brandFit: number;
    productionEase: number;
    marginPotential: number;
  };
}

export interface DesignDirection {
  id: string;
  name: string;
  palette: string[];
  headingStyle: string;
  bodyStyle: string;
  layoutStyle: string;
  buyerFit: number;
  marketFit: number;
  distinctiveness: number;
  readability: number;
  evidence: string[];
}

export interface RankedDesignDirection extends DesignDirection {
  designScore: number;
}

export interface DesignBrief {
  directionId: string;
  directionName: string;
  palette: string[];
  headingStyle: string;
  bodyStyle: string;
  layoutStyle: string;
  rules: string[];
  evidence: string[];
  score: number;
}

export type QualityCheckId =
  | 'spelling'
  | 'grammar'
  | 'text_overflow'
  | 'clipping'
  | 'margins'
  | 'font_size'
  | 'alignment'
  | 'line_spacing'
  | 'image_quality'
  | 'page_size'
  | 'blank_pages'
  | 'duplicate_pages'
  | 'missing_pages'
  | 'file_integrity'
  | 'printability'
  | 'brand_consistency'
  | 'content_completeness';

export interface QualityCheck {
  id: QualityCheckId;
  passed: boolean;
  score: number;
  details?: string;
}

export interface QualityReport {
  passed: boolean;
  overallScore: number;
  blockingIssues: QualityCheck[];
  warnings: QualityCheck[];
  missingChecks: QualityCheckId[];
  repairFeedback: string[];
}

export interface CommerceDecision {
  recommendedProduct: ScoredOpportunity;
  designBrief?: DesignBrief;
  proposedActions: Array<{
    action: CommerceAction;
    risk: CommerceRiskLevel;
    approvalRequired: boolean;
  }>;
}
