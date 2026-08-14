import { randomUUID } from 'node:crypto';
import { requireApproval, canPublish } from './approval.js';
import { brands } from './brands.js';
import type { ContentJob, Platform } from './types.js';
import type { NexusProviders } from './providers.js';

export async function createContentJob(
  providers: NexusProviders,
  brandId = 'curious-grit',
  topic?: string,
  platforms: Platform[] = ['youtube', 'tiktok', 'instagram', 'facebook']
): Promise<ContentJob> {
  const brand = brands[brandId];
  if (!brand) throw new Error(`Unknown brand: ${brandId}`);

  const now = new Date().toISOString();
  let job: ContentJob = {
    id: randomUUID(),
    brandId,
    stage: 'research',
    createdAt: now,
    updatedAt: now,
    topic,
    platforms,
    approvalRequired: true,
    errors: []
  };

  const ideas = await providers.research.research(brand, topic);
  if (!ideas.length) throw new Error('Research returned no viable ideas');
  const selectedIdea = [...ideas].sort((a, b) => b.score - a.score)[0];
  job = { ...job, stage: 'script', selectedIdea, updatedAt: new Date().toISOString() };

  const script = await providers.script.write(brand, selectedIdea);
  job = { ...job, script, stage: 'production', updatedAt: new Date().toISOString() };

  const production = await providers.video.produce(brand, script);
  job = { ...job, assets: production.assets, finalVideo: production.finalVideo, stage: 'quality_check', updatedAt: new Date().toISOString() };

  const qc = await providers.quality.review(job, brand);
  if (!qc.passed) return { ...job, stage: 'failed', errors: qc.notes, updatedAt: new Date().toISOString() };
  return requireApproval(job);
}

export async function publishApprovedJob(job: ContentJob, providers: NexusProviders): Promise<ContentJob> {
  if (!canPublish(job)) throw new Error('Publishing blocked: owner approval is required');
  if (!job.finalVideo) throw new Error('Publishing blocked: final video missing');

  const missingPublishers = job.platforms.filter((platform) => !providers.publishers[platform]);
  if (missingPublishers.length) throw new Error(`Publishing blocked: no configured publisher for ${missingPublishers.join(', ')}.`);

  const duplicateTargets = job.platforms.filter((platform) => Boolean(job.publishIds?.[platform]));
  if (duplicateTargets.length) throw new Error(`Publishing blocked: existing publish IDs found for ${duplicateTargets.join(', ')}. Run the duplicate/idempotency review before any retry.`);

  const publishIds: ContentJob['publishIds'] = { ...job.publishIds };
  for (const platform of job.platforms) {
    const publisher = providers.publishers[platform];
    if (!publisher) throw new Error(`Publisher disappeared during preflight for ${platform}.`);
    try {
      publishIds[platform] = await publisher.publish(job);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      return { ...job, publishIds, stage: 'failed', errors: [...job.errors, `Publishing failed on ${platform}: ${details}`], updatedAt: new Date().toISOString() };
    }
  }

  return { ...job, publishIds, stage: 'published', updatedAt: new Date().toISOString() };
}
