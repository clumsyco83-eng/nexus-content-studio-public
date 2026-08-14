import type { QualityCheck, QualityCheckId, QualityReport } from './types.js';

export const REQUIRED_QUALITY_CHECKS: QualityCheckId[] = [
  'spelling',
  'grammar',
  'text_overflow',
  'clipping',
  'margins',
  'font_size',
  'alignment',
  'line_spacing',
  'image_quality',
  'page_size',
  'blank_pages',
  'duplicate_pages',
  'missing_pages',
  'file_integrity',
  'printability',
  'brand_consistency',
  'content_completeness',
];

const HARD_BLOCKERS = new Set<QualityCheckId>([
  'spelling',
  'text_overflow',
  'clipping',
  'page_size',
  'missing_pages',
  'file_integrity',
  'content_completeness',
]);

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function evaluateQualityGate(checks: QualityCheck[], minimumOverallScore = 95): QualityReport {
  const normalized = checks.map((check) => ({ ...check, score: clampScore(check.score) }));
  const byId = new Map(normalized.map((check) => [check.id, check]));
  const missingChecks = REQUIRED_QUALITY_CHECKS.filter((id) => !byId.has(id));

  const blockingIssues = normalized.filter(
    (check) => (!check.passed && HARD_BLOCKERS.has(check.id)) || check.score < 80,
  );

  const warnings = normalized.filter(
    (check) => !blockingIssues.includes(check) && (!check.passed || check.score < minimumOverallScore),
  );

  const overallScore = normalized.length === 0
    ? 0
    : Number((normalized.reduce((sum, check) => sum + check.score, 0) / normalized.length).toFixed(1));

  const repairFeedback: string[] = [];
  for (const issue of blockingIssues) {
    repairFeedback.push(`${issue.id}: ${issue.details ?? 'Failed mandatory quality requirement.'}`);
  }
  for (const missing of missingChecks) {
    repairFeedback.push(`${missing}: required quality check was not run.`);
  }
  if (overallScore < minimumOverallScore) {
    repairFeedback.push(`overall_score: ${overallScore}/100 is below the required ${minimumOverallScore}/100.`);
  }

  return {
    passed: blockingIssues.length === 0 && missingChecks.length === 0 && overallScore >= minimumOverallScore,
    overallScore,
    blockingIssues,
    warnings,
    missingChecks,
    repairFeedback,
  };
}

export function assertQualityReady(checks: QualityCheck[], minimumOverallScore = 95): QualityReport {
  const report = evaluateQualityGate(checks, minimumOverallScore);
  if (!report.passed) {
    throw new Error(`Commerce quality gate failed: ${report.repairFeedback.join(' | ')}`);
  }
  return report;
}
