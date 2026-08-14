import type { AnalyticsSnapshot, BrandConfig, ContentIdea, ContentJob, Platform } from './types.js';

export interface ResearchProvider {
  research(brand: BrandConfig, topic?: string): Promise<ContentIdea[]>;
}

export interface ScriptProvider {
  write(brand: BrandConfig, idea: ContentIdea): Promise<string>;
}

export interface VideoProvider {
  produce(brand: BrandConfig, script: string): Promise<{ assets: string[]; finalVideo?: string }>;
}

export interface PublisherProvider {
  platform: Platform;
  publish(job: ContentJob): Promise<string>;
  analytics(job: ContentJob): Promise<AnalyticsSnapshot>;
}

export interface QualityProvider {
  review(job: ContentJob, brand: BrandConfig): Promise<{ passed: boolean; notes: string[] }>;
}

export interface NexusProviders {
  research: ResearchProvider;
  script: ScriptProvider;
  video: VideoProvider;
  quality: QualityProvider;
  publishers: Partial<Record<Platform, PublisherProvider>>;
}
