export type PublishPlatform = 'instagram' | 'facebook' | 'youtube' | 'tiktok' | 'threads' | 'x' | 'linkedin';
export type ContentKind = 'carousel' | 'short_video' | 'static_image' | 'text';

export interface PublishAsset {
  kind: ContentKind;
  files: string[];
  caption: string;
  title?: string;
  hashtags?: string[];
}

export interface PublishRequest {
  jobId: string;
  brand: string;
  platforms: PublishPlatform[];
  asset: PublishAsset;
  approvalStatus: 'DRAFT' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
  claimsVerified: boolean;
  scheduledAt?: string;
  dryRun?: boolean;
}

export interface PublishRoute {
  platform: PublishPlatform;
  adapter: string;
  supported: boolean;
  reason: string;
}

export interface PublishPlan {
  jobId: string;
  allowed: boolean;
  blockers: string[];
  routes: PublishRoute[];
}

const adapterByPlatform: Record<PublishPlatform, string> = {
  instagram: 'meta-graph',
  facebook: 'meta-graph',
  youtube: 'youtube-data-api',
  tiktok: 'tiktok-content-posting',
  threads: 'threads-api',
  x: 'x-api',
  linkedin: 'linkedin-api',
};

export function planPublishing(request: PublishRequest): PublishPlan {
  const blockers: string[] = [];
  if (request.approvalStatus !== 'APPROVED') blockers.push('Owner approval is required before public publishing.');
  if (!request.claimsVerified) blockers.push('Factual claims must be verified before public publishing.');
  if (!request.platforms.length) blockers.push('At least one target platform is required.');

  const routes = request.platforms.map((platform): PublishRoute => {
    if (request.asset.kind === 'carousel' && platform === 'youtube') {
      return { platform, adapter: adapterByPlatform[platform], supported: false, reason: 'Carousel is not routed to YouTube; create a Short/video adaptation instead.' };
    }
    if (request.asset.kind === 'text' && platform === 'youtube') {
      return { platform, adapter: adapterByPlatform[platform], supported: false, reason: 'Text-first post is not a supported YouTube publishing target in Nexus v1.' };
    }
    return { platform, adapter: adapterByPlatform[platform], supported: true, reason: `Route through ${adapterByPlatform[platform]}.` };
  });

  if (routes.some((route) => !route.supported)) blockers.push('One or more requested platform/content combinations are unsupported.');

  return { jobId: request.jobId, allowed: blockers.length === 0 && !request.dryRun, blockers, routes };
}

export function assertPublishAllowed(plan: PublishPlan): void {
  if (!plan.allowed) throw new Error(`Publishing blocked: ${plan.blockers.join(' ') || 'dry-run mode is active.'}`);
}
