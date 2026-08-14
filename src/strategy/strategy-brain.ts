export type StrategyDomain = 'content' | 'business' | 'operations' | 'learning' | 'system';

export interface StrategyCandidate {
  id: string;
  domain: StrategyDomain;
  action: string;
  whyNow: string;
  expectedOutcome: string;
  ownerRequired: boolean;
  canAutomate: boolean;
  impact: number;
  urgency: number;
  evidence: number;
  learningValue: number;
  effort: number;
  cost: number;
  risk: number;
  blocked?: boolean;
  blocker?: string;
}

export interface StrategyDecision extends StrategyCandidate {
  priorityScore: number;
}

export interface DailyMission {
  primaryOutcome: string;
  topMoves: StrategyDecision[];
  automaticWork: StrategyDecision[];
  needsDecision: StrategyDecision[];
  opportunity?: StrategyDecision;
  riskWatch?: StrategyDecision;
  notToday?: StrategyDecision;
  generatedAt: string;
}

const clamp = (n: number) => Math.max(0, Math.min(10, n));

export function scoreCandidate(c: StrategyCandidate): number {
  const positive = clamp(c.impact) * 0.30 + clamp(c.urgency) * 0.18 + clamp(c.evidence) * 0.17 + clamp(c.learningValue) * 0.15;
  const negative = clamp(c.effort) * 0.08 + clamp(c.cost) * 0.06 + clamp(c.risk) * 0.06;
  const blockedPenalty = c.blocked ? 2.5 : 0;
  return Number(Math.max(0, positive - negative - blockedPenalty).toFixed(2));
}

export function rankCandidates(candidates: StrategyCandidate[]): StrategyDecision[] {
  return candidates
    .map(c => ({ ...c, priorityScore: scoreCandidate(c) }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

export function buildDailyMission(candidates: StrategyCandidate[]): DailyMission {
  const ranked = rankCandidates(candidates);
  const actionable = ranked.filter(c => !c.blocked);
  const topMoves = actionable.slice(0, 3);
  const primary = topMoves[0];
  const automaticWork = actionable.filter(c => c.canAutomate && !c.ownerRequired && !topMoves.some(t => t.id === c.id)).slice(0, 4);
  const needsDecision = actionable.filter(c => c.ownerRequired).slice(0, 3);
  const opportunity = actionable.find(c => c.domain === 'business' || c.domain === 'content');
  const riskWatch = ranked.find(c => c.risk >= 7 || c.blocked);
  const notToday = [...ranked].reverse().find(c => !topMoves.some(t => t.id === c.id));

  return {
    primaryOutcome: primary ? primary.expectedOutcome : 'Protect system health and collect better evidence before adding work.',
    topMoves,
    automaticWork,
    needsDecision,
    opportunity,
    riskWatch,
    notToday,
    generatedAt: new Date().toISOString(),
  };
}
