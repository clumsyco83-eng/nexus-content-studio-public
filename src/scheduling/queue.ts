export type QueueJobType = 'research' | 'content_build' | 'render' | 'publish' | 'analytics' | 'learning';
export type QueueJobState = 'queued' | 'running' | 'waiting_approval' | 'retry_scheduled' | 'completed' | 'failed' | 'cancelled';

export interface QueueJob {
  id: string;
  brand: string;
  type: QueueJobType;
  state: QueueJobState;
  priority: number;
  payload: Record<string, unknown>;
  scheduledFor: string;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  checkpoint?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QueueClaim {
  workerId: string;
  claimedAt: string;
  leaseUntil: string;
}

export interface QueueEnvelope {
  job: QueueJob;
  claim?: QueueClaim;
}

export function canRun(job: QueueJob, now = new Date()): boolean {
  if (!['queued', 'retry_scheduled'].includes(job.state)) return false;
  return new Date(job.scheduledFor).getTime() <= now.getTime();
}

export function nextRetryAt(attempt: number, now = new Date()): string {
  const baseSeconds = 30;
  const delay = Math.min(60 * 60, baseSeconds * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(30, Math.max(1, delay * 0.1)));
  return new Date(now.getTime() + (delay + jitter) * 1000).toISOString();
}

export function markRetry(job: QueueJob, error: unknown): QueueJob {
  const attempt = job.attempt + 1;
  const exhausted = attempt >= job.maxAttempts;
  return {
    ...job,
    attempt,
    state: exhausted ? 'failed' : 'retry_scheduled',
    scheduledFor: exhausted ? job.scheduledFor : nextRetryAt(attempt),
    lastError: error instanceof Error ? error.message : String(error),
    updatedAt: new Date().toISOString(),
  };
}

export function checkpoint(job: QueueJob, value: string): QueueJob {
  return { ...job, checkpoint: value, updatedAt: new Date().toISOString() };
}
