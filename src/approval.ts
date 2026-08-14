import type { ContentJob } from './types.js';

export function requireApproval(job: ContentJob): ContentJob {
  if (!job.approvalRequired) return job;
  return { ...job, stage: 'awaiting_approval', updatedAt: new Date().toISOString() };
}

export function approve(job: ContentJob): ContentJob {
  if (job.stage !== 'awaiting_approval') {
    throw new Error(`Job ${job.id} is not awaiting approval`);
  }
  const now = new Date().toISOString();
  return { ...job, stage: 'approved', approvedAt: now, updatedAt: now };
}

export function canPublish(job: ContentJob): boolean {
  return !job.approvalRequired || job.stage === 'approved' || job.stage === 'publishing' || job.stage === 'published';
}
