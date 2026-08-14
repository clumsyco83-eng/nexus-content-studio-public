import { assertPublishAllowed, planPublishing, type PublishRequest } from './publishing-router.js';

export interface LinkedInPublishConfig {
  accessToken: string;
  authorUrn: string;
}

export interface LinkedInPublishResult {
  platform: 'linkedin';
  remoteId: string;
  raw: unknown;
}

/**
 * Safety boundary for LinkedIn publishing.
 *
 * NEXUS can plan and validate LinkedIn content now, but live transport remains
 * deliberately disabled until the current LinkedIn API product, permissions,
 * author identity and media-upload flow have been validated with the user's
 * real account. This mirrors the existing Meta safety boundary instead of
 * guessing a live endpoint or silently spending/publishing.
 */
export class LinkedInPublisher {
  constructor(private readonly config: LinkedInPublishConfig) {}

  readiness(): { ready: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!this.config.accessToken) missing.push('LINKEDIN_ACCESS_TOKEN');
    if (!this.config.authorUrn) missing.push('LINKEDIN_AUTHOR_URN');
    return { ready: missing.length === 0, missing };
  }

  async publish(request: PublishRequest): Promise<LinkedInPublishResult> {
    const plan = planPublishing({ ...request, platforms: ['linkedin'] });
    assertPublishAllowed(plan);
    const readiness = this.readiness();
    if (!readiness.ready) {
      throw new Error(`LinkedIn publisher is not ready: ${readiness.missing.join(', ')}`);
    }

    throw new Error('LinkedIn live transport not enabled yet. Validate the current LinkedIn publishing and media-upload flow before enabling.');
  }
}
