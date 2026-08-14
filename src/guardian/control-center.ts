import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NexusDatabase } from '../storage/store.js';
import type { GuardianReport } from './types.js';

interface WatchdogSnapshot {
  checkedAt?: string;
  ok?: boolean;
  consecutiveFailures?: number;
  action?: string;
  details?: string;
}

export interface GuardianControlCenter {
  generatedAt: string;
  health: {
    status: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
    score: number | null;
    summary: string;
    lastGuardianCheck?: string;
    watchdogOk: boolean | null;
    watchdogCheckedAt?: string;
    consecutiveWatchdogFailures: number;
    recoveryAction: string;
  };
  work: {
    totalJobs: number;
    activeJobs: number;
    failedJobs: number;
    pendingApprovals: number;
    staleJobs: number;
    publishFailures: number;
    published: number;
  };
  usage: {
    totalSpendUsd: number;
    spendByProvider: Array<{ provider: string; amountUsd: number }>;
    costEvents: number;
  };
  integrity: {
    duplicatePublishKeys: number;
    orphanArtifacts: number;
    orphanCosts: number;
    warnings: string[];
  };
  incidents: Array<{ kind: string; id: string; message: string; updatedAt?: string }>;
  recommendations: string[];
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export async function buildGuardianControlCenter(db: NexusDatabase): Promise<GuardianControlCenter> {
  const reportDir = process.env.NEXUS_GUARDIAN_REPORT_DIR ?? 'data/guardian';
  const guardian = await readJson<GuardianReport>(path.join(reportDir, 'latest.json'));
  const watchdog = await readJson<WatchdogSnapshot>(path.join(reportDir, 'watchdog.json'));
  const now = Date.now();
  const staleAfterMs = Math.max(60_000, Number(process.env.NEXUS_GUARDIAN_STALE_JOB_MS ?? 86_400_000));
  const terminalStates = new Set(['PUBLISHED', 'FAILED', 'CANCELLED']);
  const activeJobs = db.jobs.filter((j) => !terminalStates.has(j.state));
  const staleJobs = activeJobs.filter((j) => now - new Date(j.updatedAt).getTime() > staleAfterMs);
  const failedJobs = db.jobs.filter((j) => j.state === 'FAILED');
  const publishFailures = db.publishRecords.filter((r) => r.status === 'FAILED');
  const pendingApprovals = db.approvals.filter((a) => a.status === 'PENDING');
  const published = db.publishRecords.filter((r) => r.status === 'PUBLISHED');

  const spend = new Map<string, number>();
  let totalSpendUsd = 0;
  for (const cost of db.costs) {
    const amount = cost.amountUsd ?? 0;
    totalSpendUsd += amount;
    spend.set(cost.provider, (spend.get(cost.provider) ?? 0) + amount);
  }

  const keyCounts = new Map<string, number>();
  for (const record of db.publishRecords) keyCounts.set(record.idempotencyKey, (keyCounts.get(record.idempotencyKey) ?? 0) + 1);
  const duplicatePublishKeys = [...keyCounts.values()].filter((count) => count > 1).length;
  const jobIds = new Set(db.jobs.map((j) => j.id));
  const orphanArtifacts = db.artifacts.filter((a) => !jobIds.has(a.jobId)).length;
  const orphanCosts = db.costs.filter((c) => !jobIds.has(c.jobId)).length;

  const warnings: string[] = [];
  if (duplicatePublishKeys) warnings.push(`${duplicatePublishKeys} duplicate publish idempotency key group(s) detected.`);
  if (orphanArtifacts) warnings.push(`${orphanArtifacts} artifact(s) reference missing jobs.`);
  if (orphanCosts) warnings.push(`${orphanCosts} cost event(s) reference missing jobs.`);
  if (staleJobs.length) warnings.push(`${staleJobs.length} active job(s) have not changed within the configured stale window.`);
  if (watchdog && watchdog.ok === false) warnings.push(`Watchdog reports ${watchdog.consecutiveFailures ?? 0} consecutive failure(s).`);
  if (!process.env.NEXUS_DASHBOARD_TOKEN) warnings.push('Dashboard token is not configured; keep the dashboard bound to localhost only.');

  const incidents: GuardianControlCenter['incidents'] = [
    ...failedJobs.map((j) => ({ kind: 'job-failure', id: j.id, message: `${j.topic ?? j.id} is FAILED.`, updatedAt: j.updatedAt })),
    ...publishFailures.map((r) => ({ kind: 'publish-failure', id: r.id, message: `Publishing failed for job ${r.jobId} on ${r.platform}.`, updatedAt: r.updatedAt })),
    ...staleJobs.map((j) => ({ kind: 'stale-job', id: j.id, message: `${j.topic ?? j.id} appears stalled in ${j.state}.`, updatedAt: j.updatedAt })),
  ].sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()).slice(0, 30);

  const recommendations = [...(guardian?.recommendations ?? [])];
  if (publishFailures.length) recommendations.push(`Review ${publishFailures.length} failed publish record(s) before scheduling more posts to the affected platform(s).`);
  if (staleJobs.length) recommendations.push(`Inspect or pause ${staleJobs.length} stale active job(s) to prevent duplicate or abandoned work.`);
  if (duplicatePublishKeys) recommendations.push('Resolve duplicate publish idempotency keys before enabling unattended publishing.');
  if (!recommendations.length) recommendations.push('No intervention required. Nexus operations are within current Guardian thresholds.');

  return {
    generatedAt: new Date().toISOString(),
    health: {
      status: guardian?.status ?? (watchdog?.ok === false ? 'RED' : 'UNKNOWN'),
      score: guardian?.score ?? null,
      summary: guardian?.summary ?? 'Guardian deep verification has not produced a report yet.',
      lastGuardianCheck: guardian?.generatedAt,
      watchdogOk: typeof watchdog?.ok === 'boolean' ? watchdog.ok : null,
      watchdogCheckedAt: watchdog?.checkedAt,
      consecutiveWatchdogFailures: watchdog?.consecutiveFailures ?? 0,
      recoveryAction: watchdog?.action ?? 'none',
    },
    work: {
      totalJobs: db.jobs.length,
      activeJobs: activeJobs.length,
      failedJobs: failedJobs.length,
      pendingApprovals: pendingApprovals.length,
      staleJobs: staleJobs.length,
      publishFailures: publishFailures.length,
      published: published.length,
    },
    usage: {
      totalSpendUsd,
      spendByProvider: [...spend.entries()].map(([provider, amountUsd]) => ({ provider, amountUsd })).sort((a, b) => b.amountUsd - a.amountUsd),
      costEvents: db.costs.length,
    },
    integrity: { duplicatePublishKeys, orphanArtifacts, orphanCosts, warnings },
    incidents,
    recommendations: [...new Set(recommendations)].slice(0, 12),
  };
}
