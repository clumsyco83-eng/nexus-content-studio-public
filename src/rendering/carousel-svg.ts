import type { CarouselSlide, CarouselSpec } from '../content/carousel.js';

export const CAROUSEL_WIDTH = 1080;
export const CAROUSEL_HEIGHT = 1350;

const COLORS = {
  black: '#0A0A0A',
  charcoal: '#141414',
  white: '#F5F5F2',
  gold: '#D5A928',
  muted: '#AAA9A3',
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function textLines(
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  weight = 800,
  fill = COLORS.white,
  family = 'Arial, Helvetica, sans-serif',
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" font-family="${family}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`,
    )
    .join('\n');
}

function eyebrow(slide: CarouselSlide): string {
  if (!slide.eyebrow) return '';
  return `<text x="84" y="245" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" letter-spacing="7" fill="${COLORS.gold}">${escapeXml(slide.eyebrow.toUpperCase())}</text>`;
}

function footer(slide: CarouselSlide, total: number): string {
  return `
    <line x1="84" y1="1200" x2="996" y2="1200" stroke="${COLORS.gold}" stroke-width="2" opacity="0.55"/>
    <text x="84" y="1256" font-family="Arial, Helvetica, sans-serif" font-size="27" font-weight="700" fill="${COLORS.muted}" letter-spacing="3">CURIOUS GRIT</text>
    <text x="996" y="1256" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" fill="${COLORS.muted}">${String(slide.index).padStart(2, '0')} / ${String(total).padStart(2, '0')}</text>
  `;
}

function visualMotif(slide: CarouselSlide): string {
  if (slide.role === 'hook') {
    return `
      <circle cx="870" cy="190" r="120" fill="none" stroke="${COLORS.gold}" stroke-width="2" opacity="0.35"/>
      <circle cx="870" cy="190" r="78" fill="none" stroke="${COLORS.white}" stroke-width="2" opacity="0.18"/>
      <path d="M820 190 C835 145, 900 145, 920 190 C902 235, 840 240, 820 190 Z" fill="none" stroke="${COLORS.gold}" stroke-width="4" opacity="0.65"/>
      <circle cx="870" cy="190" r="17" fill="${COLORS.gold}" opacity="0.85"/>
    `;
  }

  if (slide.role === 'cta') {
    return `
      <circle cx="540" cy="850" r="150" fill="none" stroke="${COLORS.gold}" stroke-width="3" opacity="0.35"/>
      <text x="540" y="880" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="126" font-weight="900" fill="${COLORS.white}">CG</text>
    `;
  }

  return `
    <rect x="790" y="165" width="165" height="165" rx="28" fill="none" stroke="${COLORS.gold}" stroke-width="2" opacity="0.38"/>
    <text x="872" y="275" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="84" font-weight="900" fill="${COLORS.gold}">${String(slide.index).padStart(2, '0')}</text>
  `;
}

export function renderCarouselSlideSvg(slide: CarouselSlide, spec: CarouselSpec): string {
  const total = spec.slides.length;
  const headlineLines = wrapText(slide.headline, slide.role === 'hook' ? 22 : 26).slice(0, 6);
  const headlineSize = slide.role === 'hook' ? 94 : 76;
  const headlineLineHeight = slide.role === 'hook' ? 104 : 87;
  const headlineY = slide.eyebrow ? 390 : 310;
  const bodyY = headlineY + headlineLines.length * headlineLineHeight + 72;
  const bodyLines = slide.body ? wrapText(slide.body, 48).slice(0, 8) : [];

  const accent = slide.emphasis?.[0];
  const accentBlock = accent
    ? `<text x="84" y="${Math.min(bodyY + bodyLines.length * 52 + 95, 1085)}" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="800" fill="${COLORS.gold}">${escapeXml(accent)}</text>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CAROUSEL_WIDTH}" height="${CAROUSEL_HEIGHT}" viewBox="0 0 ${CAROUSEL_WIDTH} ${CAROUSEL_HEIGHT}">
  <defs>
    <radialGradient id="glow" cx="75%" cy="15%" r="80%">
      <stop offset="0%" stop-color="#3A2D07" stop-opacity="0.65"/>
      <stop offset="45%" stop-color="#16120A" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grain" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="3" r="1" fill="#FFFFFF" opacity="0.025"/>
      <circle cx="18" cy="11" r="1" fill="#FFFFFF" opacity="0.018"/>
      <circle cx="9" cy="22" r="1" fill="#D5A928" opacity="0.025"/>
    </pattern>
  </defs>

  <rect width="1080" height="1350" fill="${COLORS.black}"/>
  <rect width="1080" height="1350" fill="url(#glow)"/>
  <rect width="1080" height="1350" fill="url(#grain)"/>
  <rect x="52" y="52" width="976" height="1246" rx="6" fill="none" stroke="${COLORS.white}" stroke-width="1" opacity="0.08"/>

  <text x="84" y="116" font-family="Arial, Helvetica, sans-serif" font-size="27" font-weight="800" fill="${COLORS.white}" letter-spacing="4">CURIOUS GRIT</text>
  <text x="996" y="116" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700" fill="${COLORS.gold}" letter-spacing="3">UNDERSTAND MORE</text>

  ${visualMotif(slide)}
  ${eyebrow(slide)}
  ${textLines(headlineLines, 84, headlineY, headlineSize, headlineLineHeight, 900, COLORS.white)}
  ${bodyLines.length ? textLines(bodyLines, 84, bodyY, 38, 52, 500, COLORS.muted) : ''}
  ${accentBlock}
  ${footer(slide, total)}
</svg>`;
}

export function renderCarouselSvgs(spec: CarouselSpec): Array<{ filename: string; svg: string }> {
  return spec.slides.map((slide) => ({
    filename: `${spec.id}-${String(slide.index).padStart(2, '0')}.svg`,
    svg: renderCarouselSlideSvg(slide, spec),
  }));
}
