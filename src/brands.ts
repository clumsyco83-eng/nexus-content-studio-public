import type { BrandConfig } from './types.js';

export const brands: Record<string, BrandConfig> = {
  'curious-grit': {
    id: 'curious-grit',
    name: 'Curious Grit',
    tagline: 'Understand More. Become More.',
    active: true,
    pillars: ['psychology', 'human behaviour', 'curiosity', 'discipline', 'resilience', 'extraordinary stories'],
    tone: ['intelligent', 'cinematic', 'intriguing', 'grounded', 'slightly mysterious'],
    visualStyle: 'Editorial Motion Graphics — charcoal, warm off-white, restrained metallic gold, premium documentary/editorial motion design',
    defaultVoice: 'Helena',
    handles: {
      youtube: '@CuriousGrit',
      instagram: '@curiousgrithq',
      facebook: '@CuriousGrit',
      tiktok: '@stayaboveaverage'
    }
  }
};

export function getActiveBrand(): BrandConfig {
  const brand = Object.values(brands).find((item) => item.active);
  if (!brand) throw new Error('No active brand configured');
  return brand;
}
