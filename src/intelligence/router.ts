export type IntelligenceAgentId =
  | 'memory-intelligence'
  | 'knowledge-intelligence'
  | 'deep-research'
  | 'source-verification'
  | 'freshness-intelligence'
  | 'universal-retrieval'
  | 'contradiction-fact-check';

export type EvidenceDependence = 'none' | 'conversation' | 'project' | 'world' | 'both';
export type TemporalSensitivity = 'none' | 'historical' | 'current' | 'live';
export type IntelligenceRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Contestedness = 'settled' | 'uncertain' | 'disputed' | 'unknown';
export type ActionCoupling = 'informational' | 'decision' | 'action-triggering';
export type IntelligenceProfile = 'NONE' | 'MEMORY' | 'LOOKUP' | 'CURRENT' | 'RESEARCH' | 'HIGH_STAKES';

export interface IntelligenceRouteRequest {
  evidenceDependence: EvidenceDependence;
  temporalSensitivity: TemporalSensitivity;
  risk: IntelligenceRisk;
  contestedness: Contestedness;
  actionCoupling: ActionCoupling;
  priorContextSufficient?: boolean;
  explicitAgents?: IntelligenceAgentId[];
}

export interface IntelligenceRoutePlan {
  profile: IntelligenceProfile;
  agents: IntelligenceAgentId[];
  toolCallBudget: number;
  sourceBudget: number;
  allowDeepResearch: boolean;
  reasons: string[];
}

const riskRank: Record<IntelligenceRisk, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function baseProfile(request: IntelligenceRouteRequest): IntelligenceProfile {
  if (request.explicitAgents?.length) return 'LOOKUP';
  if (request.evidenceDependence === 'none') return 'NONE';
  if (request.priorContextSufficient && request.risk === 'LOW' && request.actionCoupling === 'informational') return 'LOOKUP';
  if (riskRank[request.risk] >= riskRank.HIGH || request.actionCoupling === 'action-triggering') return 'HIGH_STAKES';
  if (request.contestedness === 'disputed' || request.contestedness === 'unknown') return 'RESEARCH';
  if (request.temporalSensitivity === 'current' || request.temporalSensitivity === 'live') return 'CURRENT';
  if (request.evidenceDependence === 'project' || request.evidenceDependence === 'conversation') return 'MEMORY';
  if (request.evidenceDependence === 'both') return 'RESEARCH';
  return 'LOOKUP';
}

function budgets(profile: IntelligenceProfile): Pick<IntelligenceRoutePlan, 'toolCallBudget' | 'sourceBudget' | 'allowDeepResearch'> {
  switch (profile) {
    case 'NONE': return { toolCallBudget: 0, sourceBudget: 0, allowDeepResearch: false };
    case 'MEMORY': return { toolCallBudget: 2, sourceBudget: 0, allowDeepResearch: false };
    case 'LOOKUP': return { toolCallBudget: 3, sourceBudget: 2, allowDeepResearch: false };
    case 'CURRENT': return { toolCallBudget: 5, sourceBudget: 3, allowDeepResearch: false };
    case 'RESEARCH': return { toolCallBudget: 10, sourceBudget: 6, allowDeepResearch: true };
    case 'HIGH_STAKES': return { toolCallBudget: 14, sourceBudget: 8, allowDeepResearch: true };
  }
}

/**
 * Deterministic evidence-routing policy for NEXUS.
 *
 * This function chooses intelligence capabilities only. It never performs
 * retrieval, writes memory, grants permissions, approves actions, or lowers
 * Guardian/workspace/publishing/spend gates.
 */
export function routeIntelligence(request: IntelligenceRouteRequest): IntelligenceRoutePlan {
  const profile = baseProfile(request);
  const reasons: string[] = [];

  if (request.explicitAgents?.length) {
    reasons.push('Owner/caller explicitly selected intelligence agents; preserve that override without adding unrelated agents.');
    return { profile, agents: unique(request.explicitAgents), ...budgets(profile), reasons };
  }

  if (profile === 'NONE') {
    return { profile, agents: [], ...budgets(profile), reasons: ['No external/project evidence is required.'] };
  }

  const agents: IntelligenceAgentId[] = [];
  const needsProject = request.evidenceDependence === 'project' || request.evidenceDependence === 'conversation' || request.evidenceDependence === 'both';
  const needsWorld = request.evidenceDependence === 'world' || request.evidenceDependence === 'both';
  const timeSensitive = request.temporalSensitivity === 'current' || request.temporalSensitivity === 'live';
  const contested = request.contestedness === 'disputed' || request.contestedness === 'unknown';
  const highRisk = riskRank[request.risk] >= riskRank.HIGH;

  if (needsProject) {
    agents.push('memory-intelligence');
    reasons.push('Project/conversation evidence requires durable project context.');
  }

  if (needsWorld) {
    agents.push('knowledge-intelligence');
    if (!request.priorContextSufficient || timeSensitive || contested || request.risk !== 'LOW') {
      agents.push('universal-retrieval');
      reasons.push('World evidence requires retrieval rather than unverified model recall.');
    }
  }

  if (timeSensitive) {
    agents.push('freshness-intelligence');
    reasons.push(`${request.temporalSensitivity} facts require an explicit freshness verdict.`);
  }

  if (needsWorld && (request.risk !== 'LOW' || timeSensitive || contested)) {
    agents.push('source-verification');
    reasons.push('Load-bearing external evidence requires source/claim verification.');
  }

  if (profile === 'RESEARCH' || profile === 'HIGH_STAKES') {
    if (needsWorld || request.evidenceDependence === 'both') agents.push('deep-research');
    reasons.push(`${profile} profile raises the evidence floor and permits multi-source investigation.`);
  }

  if (contested || request.evidenceDependence === 'both') {
    agents.push('contradiction-fact-check');
    reasons.push('Conflicting or mixed project/world evidence must be compared explicitly before supersession.');
  }

  if (highRisk && !agents.includes('source-verification') && needsWorld) agents.push('source-verification');

  return { profile, agents: unique(agents), ...budgets(profile), reasons };
}
