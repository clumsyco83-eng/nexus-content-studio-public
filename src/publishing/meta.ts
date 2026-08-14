import { assertPublishAllowed, planPublishing, type PublishRequest } from './publishing-router.js';

export interface MetaPublishConfig {
  accessToken: string;
  instagramAccountId?: string;
  facebookPageId?: string;
  graphVersion?: string;
}

export interface MetaPublishResult {
  platform: 'instagram' | 'facebook';
  remoteId: string;
  raw: unknown;
}

export class MetaPublisher {
  constructor(private readonly config: MetaPublishConfig) {}

  readiness(): { ready: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!this.config.accessToken) missing.push('META_ACCESS_TOKEN');
    if (!this.config.instagramAccountId && !this.config.facebookPageId) missing.push('META_INSTAGRAM_ACCOUNT_ID or META_FACEBOOK_PAGE_ID');
    return { ready: missing.length === 0, missing };
  }

  async publish(request: PublishRequest, platform: 'instagram' | 'facebook'): Promise<MetaPublishResult> {
    const plan = planPublishing({ ...request, platforms: [platform] });
    assertPublishAllowed(plan);
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(`Meta publisher is not ready: ${readiness.missing.join(', ')}`);

    // Live Graph API calls are intentionally not guessed here. Claude Code must validate the
    // current Meta endpoint/permissions for the requested media type during provider setup.
    // This adapter is the safety boundary and account mapping layer.
    throw new Error('Meta live transport not enabled yet. Validate current Graph API media publishing flow before enabling.');
  }
}
