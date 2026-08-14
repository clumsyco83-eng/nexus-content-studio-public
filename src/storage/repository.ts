import { randomUUID } from 'node:crypto';
import type { NexusStore } from './store.js';
import type {
  StoredAnalyticsSnapshot,
  StoredApproval,
  StoredArtifact,
  StoredCostEvent,
  StoredExperiment,
  StoredJob,
  StoredLesson,
  StoredPublishRecord,
} from './schema.js';

export class NexusRepository {
  constructor(private readonly store: NexusStore) {}

  private now(): string { return new Date().toISOString(); }

  async createJob(input: Omit<StoredJob, 'createdAt' | 'updatedAt' | 'revision'> & { revision?: number }): Promise<StoredJob> {
    return this.store.update((db) => {
      if (db.jobs.some((job) => job.id === input.id)) throw new Error(`Job already exists: ${input.id}`);
      const now = this.now();
      const job: StoredJob = { ...input, revision: input.revision ?? 1, createdAt: now, updatedAt: now };
      db.jobs.push(job);
      return job;
    });
  }

  async updateJob(id: string, patch: Partial<Omit<StoredJob, 'id' | 'createdAt'>>): Promise<StoredJob> {
    return this.store.update((db) => {
      const index = db.jobs.findIndex((job) => job.id === id);
      if (index < 0) throw new Error(`Unknown job: ${id}`);
      db.jobs[index] = { ...db.jobs[index]!, ...patch, updatedAt: this.now() };
      return db.jobs[index]!;
    });
  }

  async addArtifact(input: Omit<StoredArtifact, 'id' | 'createdAt'>): Promise<StoredArtifact> {
    return this.store.update((db) => {
      const artifact: StoredArtifact = { ...input, id: randomUUID(), createdAt: this.now() };
      db.artifacts.push(artifact);
      return artifact;
    });
  }

  async requestApproval(jobId: string, revision: number): Promise<StoredApproval> {
    return this.store.update((db) => {
      for (const approval of db.approvals) {
        if (approval.jobId === jobId && approval.status === 'PENDING') approval.status = 'INVALIDATED';
      }
      const approval: StoredApproval = { id: randomUUID(), jobId, revision, status: 'PENDING', createdAt: this.now() };
      db.approvals.push(approval);
      return approval;
    });
  }

  async resolveApproval(id: string, status: 'APPROVED' | 'REJECTED', approvedBy: string, reason?: string): Promise<StoredApproval> {
    return this.store.update((db) => {
      const approval = db.approvals.find((item) => item.id === id);
      if (!approval) throw new Error(`Unknown approval: ${id}`);
      if (approval.status !== 'PENDING') throw new Error(`Approval is not pending: ${id}`);
      approval.status = status;
      approval.approvedBy = approvedBy;
      approval.reason = reason;
      approval.resolvedAt = this.now();
      return approval;
    });
  }

  async resolveCurrentApproval(
    jobId: string,
    status: 'APPROVED' | 'REJECTED',
    approvedBy: string,
    reason?: string,
  ): Promise<{ approval: StoredApproval; job: StoredJob }> {
    return this.store.update((db) => {
      const job = db.jobs.find((item) => item.id === jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      const approval = db.approvals.find(
        (item) => item.jobId === jobId && item.revision === job.revision && item.status === 'PENDING',
      );
      if (!approval) throw new Error(`No pending approval for current revision ${job.revision}.`);

      const now = this.now();
      approval.status = status;
      approval.approvedBy = approvedBy;
      approval.reason = reason;
      approval.resolvedAt = now;
      job.state = status === 'APPROVED' ? 'APPROVED' : 'DRAFT';
      job.approvedAt = status === 'APPROVED' ? now : undefined;
      job.updatedAt = now;
      return { approval, job };
    });
  }

  async regenerateJob(jobId: string): Promise<StoredJob> {
    return this.store.update((db) => {
      const job = db.jobs.find((item) => item.id === jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      for (const approval of db.approvals) {
        if (approval.jobId === jobId && approval.status === 'PENDING') approval.status = 'INVALIDATED';
      }
      job.revision += 1;
      job.state = 'DRAFT';
      job.approvedAt = undefined;
      job.updatedAt = this.now();
      return job;
    });
  }

  async recordPublish(input: Omit<StoredPublishRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoredPublishRecord> {
    return this.store.update((db) => {
      const existing = db.publishRecords.find((record) => record.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
      const now = this.now();
      const record: StoredPublishRecord = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
      db.publishRecords.push(record);
      return record;
    });
  }

  async addAnalytics(input: Omit<StoredAnalyticsSnapshot, 'id'>): Promise<StoredAnalyticsSnapshot> {
    return this.store.update((db) => {
      const snapshot: StoredAnalyticsSnapshot = { ...input, id: randomUUID() };
      db.analytics.push(snapshot);
      return snapshot;
    });
  }

  async addCost(input: Omit<StoredCostEvent, 'id' | 'createdAt'>): Promise<StoredCostEvent> {
    return this.store.update((db) => {
      const event: StoredCostEvent = { ...input, id: randomUUID(), createdAt: this.now() };
      db.costs.push(event);
      return event;
    });
  }

  async upsertExperiment(input: Omit<StoredExperiment, 'createdAt' | 'updatedAt'>): Promise<StoredExperiment> {
    return this.store.update((db) => {
      const existing = db.experiments.find((item) => item.id === input.id);
      const now = this.now();
      if (existing) Object.assign(existing, input, { updatedAt: now });
      else db.experiments.push({ ...input, createdAt: now, updatedAt: now });
      return (existing ?? db.experiments[db.experiments.length - 1])!;
    });
  }

  async upsertLesson(input: Omit<StoredLesson, 'createdAt' | 'updatedAt'>): Promise<StoredLesson> {
    return this.store.update((db) => {
      const existing = db.lessons.find((item) => item.id === input.id);
      const now = this.now();
      if (existing) Object.assign(existing, input, { updatedAt: now });
      else db.lessons.push({ ...input, createdAt: now, updatedAt: now });
      return (existing ?? db.lessons[db.lessons.length - 1])!;
    });
  }
}
