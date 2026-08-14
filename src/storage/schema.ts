export type JobState =
  | 'DRAFT'
  | 'RESEARCHING'
  | 'SCRIPTING'
  | 'PRODUCING'
  | 'QC'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'FAILED'
  | 'CANCELLED';

export interface StoredJob {
  id: string;
  brand: string;
  contentKind: string;
  topic?: string;
  state: JobState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  scheduledAt?: string;
  approvedAt?: string;
  publishedAt?: string;
}

export interface StoredArtifact {
  id: string;
  jobId: string;
  kind: 'script' | 'image' | 'video' | 'audio' | 'carousel' | 'thumbnail' | 'caption' | 'manifest' | 'other';
  pathOrUrl: string;
  provider?: string;
  model?: string;
  revision: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface StoredApproval {
  id: string;
  jobId: string;
  revision: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'INVALIDATED';
  approvedBy?: string;
  reason?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface StoredPublishRecord {
  id: string;
  jobId: string;
  platform: string;
  accountId: string;
  revision: number;
  idempotencyKey: string;
  remoteId?: string;
  url?: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  createdAt: string;
  updatedAt: string;
}

export interface StoredAnalyticsSnapshot {
  id: string;
  publishRecordId: string;
  capturedAt: string;
  metrics: Record<string, number | null>;
}

export interface StoredCostEvent {
  id: string;
  jobId: string;
  provider: string;
  model?: string;
  amountUsd?: number;
  credits?: number;
  eventType: 'generation' | 'render' | 'publish' | 'storage' | 'other';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface StoredExperiment {
  id: string;
  brand: string;
  hypothesis: string;
  variable: string;
  status: 'ACTIVE' | 'PROMOTED' | 'REJECTED' | 'INCONCLUSIVE';
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredLesson {
  id: string;
  brand: string;
  scope: 'topic' | 'hook' | 'format' | 'visual' | 'provider' | 'platform' | 'general';
  statement: string;
  confidence: number;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}
