import type { AnalyticsSnapshot, LearningRecord } from './types.js';

export function analysePerformance(snapshots: AnalyticsSnapshot[]): LearningRecord[] {
  const byJob = new Map<string, AnalyticsSnapshot[]>();
  for (const snapshot of snapshots) {
    const list = byJob.get(snapshot.jobId) ?? [];
    list.push(snapshot);
    byJob.set(snapshot.jobId, list);
  }

  const records: LearningRecord[] = [];
  for (const [jobId, values] of byJob.entries()) {
    const completion = values
      .map((v) => v.completionRate)
      .filter((v): v is number => typeof v === 'number');
    const avgCompletion = completion.length
      ? completion.reduce((a, b) => a + b, 0) / completion.length
      : undefined;

    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const nextExperiments: string[] = [];

    if (avgCompletion !== undefined && avgCompletion >= 0.7) {
      strengths.push('Strong average completion rate');
      nextExperiments.push('Create two hook variations using the same core structure');
    } else if (avgCompletion !== undefined) {
      weaknesses.push('Completion rate needs improvement');
      nextExperiments.push('Test a shorter cut and move the payoff earlier');
    }

    records.push({
      jobId,
      summary: avgCompletion === undefined
        ? 'Not enough retention data yet.'
        : `Average completion rate: ${(avgCompletion * 100).toFixed(1)}%`,
      strengths,
      weaknesses,
      nextExperiments
    });
  }

  return records;
}
