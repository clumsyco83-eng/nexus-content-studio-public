export type CopyPlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'linkedin' | 'threads' | 'x';

export interface CanonicalCopy {
  title: string;
  caption: string;
  hashtags?: string[];
  callToAction?: string;
}

export interface PlatformCopy {
  platform: CopyPlatform;
  title?: string;
  caption: string;
  hashtags: string[];
  notes: string[];
}

interface CopyPolicy {
  titleLimit?: number;
  captionLimit: number;
  hashtagLimit: number;
  styleNote: string;
}

const policies: Record<CopyPlatform, CopyPolicy> = {
  youtube: { titleLimit: 70, captionLimit: 900, hashtagLimit: 3, styleNote: 'Lead with a clear curiosity promise; metadata supports the video rather than carrying it.' },
  tiktok: { captionLimit: 420, hashtagLimit: 5, styleNote: 'Use conversational, search-aware wording that still reads naturally.' },
  instagram: { captionLimit: 700, hashtagLimit: 8, styleNote: 'Emphasize share/save value and keep the first lines useful before truncation.' },
  facebook: { titleLimit: 90, captionLimit: 900, hashtagLimit: 5, styleNote: 'Adapt context for Facebook instead of blindly mirroring Instagram copy.' },
  linkedin: { titleLimit: 90, captionLimit: 900, hashtagLimit: 5, styleNote: 'Use an evidence-led professional takeaway and avoid consumer-social phrasing.' },
  threads: { captionLimit: 450, hashtagLimit: 3, styleNote: 'Prefer a concise thought with a clear point of view.' },
  x: { captionLimit: 260, hashtagLimit: 2, styleNote: 'Compress to one sharp insight and preserve room for links or attribution.' },
};

function cleanHashtag(value: string): string {
  const cleaned = value.trim().replace(/^#+/, '').replace(/\s+/g, '');
  return cleaned ? `#${cleaned}` : '';
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  if (limit <= 1) return trimmed.slice(0, limit);
  const candidate = trimmed.slice(0, limit - 1).replace(/\s+\S*$/, '').trimEnd();
  return `${candidate || trimmed.slice(0, limit - 1)}…`;
}

function composeCaption(base: string, callToAction?: string): string {
  const chunks = [base.trim(), callToAction?.trim()].filter((value): value is string => Boolean(value));
  return chunks.join('\n\n');
}

export function packageCopyForPlatform(platform: CopyPlatform, input: CanonicalCopy): PlatformCopy {
  const policy = policies[platform];
  const hashtags = [...new Set((input.hashtags ?? []).map(cleanHashtag).filter(Boolean))].slice(0, policy.hashtagLimit);
  const rawCaption = composeCaption(input.caption, input.callToAction);

  let caption = rawCaption;
  let title = input.title.trim();
  const notes = [policy.styleNote];

  if (platform === 'linkedin') {
    caption = `${input.title.trim()}\n\n${rawCaption}`.trim();
  } else if (platform === 'x' || platform === 'threads' || platform === 'tiktok') {
    caption = `${input.title.trim()} — ${rawCaption}`.trim();
  }

  if (policy.titleLimit) title = truncate(title, policy.titleLimit);
  else title = '';

  const hashtagSuffix = hashtags.length ? `\n\n${hashtags.join(' ')}` : '';
  const bodyLimit = Math.max(1, policy.captionLimit - hashtagSuffix.length);
  caption = `${truncate(caption, bodyLimit)}${hashtagSuffix}`;

  if (rawCaption.length > bodyLimit) notes.push(`Caption was shortened to the NEXUS ${platform} packaging limit.`);
  if (input.hashtags && input.hashtags.length > policy.hashtagLimit) notes.push(`Hashtags were reduced to ${policy.hashtagLimit}.`);

  return { platform, title: title || undefined, caption, hashtags, notes };
}

export function packageCopyForPlatforms(platforms: CopyPlatform[], input: CanonicalCopy): PlatformCopy[] {
  return platforms.map((platform) => packageCopyForPlatform(platform, input));
}
