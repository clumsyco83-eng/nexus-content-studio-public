import type { QueueJob, QueueJobType } from './queue.js';

export interface DailyScheduleConfig {
  brand: string;
  timezone: string;
  contentTargets: {
    shortVideo: number;
    carousel: number;
    lightweight: number;
  };
  prepareHourLocal: number;
  analyticsHourLocal: number;
  approvalRequired: boolean;
}

function id(prefix: string, date: string, suffix: string): string {
  return `${prefix}-${date}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function queueJob(args: {
  brand: string;
  date: string;
  type: QueueJobType;
  suffix: string;
  scheduledFor: string;
  payload: Record<string, unknown>;
  priority?: number;
}): QueueJob {
  const now = new Date().toISOString();
  const jobId = id(args.brand, args.date, args.suffix);
  return {
    id: jobId,
    brand: args.brand,
    type: args.type,
    state: 'queued',
    priority: args.priority ?? 50,
    payload: args.payload,
    scheduledFor: args.scheduledFor,
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: `${args.brand}:${args.date}:${args.type}:${args.suffix}`,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildDailyProductionQueue(
  config: DailyScheduleConfig,
  date: string,
  prepareAtIso: string,
  analyticsAtIso: string,
): QueueJob[] {
  const jobs: QueueJob[] = [];
  const targets = [
    ...Array.from({ length: config.contentTargets.shortVideo }, (_, i) => ({ format: 'short_video', i })),
    ...Array.from({ length: config.contentTargets.carousel }, (_, i) => ({ format: 'carousel', i })),
    ...Array.from({ length: config.contentTargets.lightweight }, (_, i) => ({ format: 'lightweight', i })),
  ];

  for (const target of targets) {
    jobs.push(queueJob({
      brand: config.brand,
      date,
      type: 'content_build',
      suffix: `${target.format}-${target.i + 1}`,
      scheduledFor: prepareAtIso,
      payload: {
        targetDate: date,
        format: target.format,
        approvalRequired: config.approvalRequired,
      },
      priority: target.format === 'short_video' ? 80 : target.format === 'carousel' ? 70 : 50,
    }));
  }

  jobs.push(queueJob({
    brand: config.brand,
    date,
    type: 'analytics',
    suffix: 'daily-analytics',
    scheduledFor: analyticsAtIso,
    payload: { targetDate: date, scope: 'previous-published-content' },
    priority: 40,
  }));

  jobs.push(queueJob({
    brand: config.brand,
    date,
    type: 'learning',
    suffix: 'daily-learning',
    scheduledFor: analyticsAtIso,
    payload: { targetDate: date, dependsOn: 'daily-analytics' },
    priority: 30,
  }));

  return jobs;
}

export const curiousGritDefaultSchedule: DailyScheduleConfig = {
  brand: 'curious-grit',
  timezone: 'Australia/Brisbane',
  contentTargets: { shortVideo: 1, carousel: 1, lightweight: 1 },
  prepareHourLocal: 6,
  analyticsHourLocal: 21,
  approvalRequired: true,
};
