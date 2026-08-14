export type Platform = 'youtube' | 'tiktok' | 'instagram' | 'facebook';
export type JobStage =
  | 'research'
  | 'ideation'
  | 'script'
  | 'production'
  | 'voice'
  | 'edit'
  | 'quality_check'
  | 'awaiting_approval'
  | 'approved'
  | 'publishing'
  | 'published'
  | 'analytics'
  | 'learned'
  | 'failed';

export interface BrandConfig {
  id: string;
  name: string;
  tagline: string;
  active: boolean;
  pillars: string[];
  tone: string[];
  visualStyle: string;
  defaultVoice?: string;
  handles: Partial<Record<Platform, string>>;
}

export interface ContentIdea {
  title: string;
  hook: string;
  angle: string;
  evidenceUrls: string[];
  score: number;
}

export interface ContentJob {
  id: string;
  brandId: string;
  stage: JobStage;
  createdAt: string;
  updatedAt: string;
  topic?: string;
  selectedIdea?: ContentIdea;
  script?: string;
  assets?: string[];
  finalVideo?: string;
  platforms: Platform[];
  approvalRequired: boolean;
  approvedAt?: string;
  publishIds?: Partial<Record<Platform, string>>;
  errors: string[];
}

export interface AnalyticsSnapshot {
  jobId: string;
  platform: Platform;
  capturedAt: string;
  views?: number;
  impressions?: number;
  averageWatchSeconds?: number;
  completionRate?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  followersGained?: number;
  revenue?: number;
}

export interface LearningRecord {
  jobId: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  nextExperiments: string[];
}
