import { assertPublishAllowed, planPublishing, type PublishRequest } from './publishing-router.js';

export interface YouTubePublishConfig {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  channelId: string;
}

export class YouTubePublisher {
  constructor(private readonly config: YouTubePublishConfig) {}

  readiness(): { ready: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!this.config.clientId) missing.push('YOUTUBE_CLIENT_ID');
    if (!this.config.clientSecret) missing.push('YOUTUBE_CLIENT_SECRET');
    if (!this.config.refreshToken) missing.push('YOUTUBE_REFRESH_TOKEN');
    if (!this.config.channelId) missing.push('YOUTUBE_CHANNEL_ID');
    return { ready: missing.length === 0, missing };
  }

  async publishShort(request: PublishRequest): Promise<{ videoId: string }> {
    const plan = planPublishing({ ...request, platforms: ['youtube'] });
    assertPublishAllowed(plan);
    if (request.asset.kind !== 'short_video') throw new Error('YouTube Shorts publisher requires short_video asset.');
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(`YouTube publisher is not ready: ${readiness.missing.join(', ')}`);

    // OAuth + resumable upload transport is enabled only after local credential setup and
    // a dry-run verifies the exact target channel. Never infer a channel from the login alone.
    throw new Error('YouTube live transport not enabled yet. Complete OAuth/channel verification first.');
  }
}
