import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CarouselSpec } from '../content/carousel.js';
import type { CarouselRenderResult } from './carousel-files.js';

export interface ApprovalGalleryOptions {
  spec: CarouselSpec;
  renderResult: CarouselRenderResult;
  outputRoot: string;
  publishAllowed: boolean;
  warnings: string[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function rel(from: string, file: string): string {
  return path.relative(from, file).split(path.sep).join('/');
}

export async function writeApprovalGallery(options: ApprovalGalleryOptions): Promise<string> {
  const { spec, renderResult, outputRoot, publishAllowed, warnings } = options;
  const preferredFiles = renderResult.pngFiles.length ? renderResult.pngFiles : renderResult.svgFiles;
  const slides = preferredFiles.map((file, index) => {
    const src = rel(outputRoot, file);
    const slide = spec.slides[index];
    return `
      <article class="slide-card">
        <img src="${escapeHtml(src)}" alt="Curious Grit carousel slide ${index + 1}" loading="lazy" />
        <div class="meta">
          <strong>Slide ${index + 1}</strong>
          <span>${escapeHtml(slide?.role ?? 'slide')}</span>
        </div>
      </article>`;
  }).join('\n');

  const warningItems = warnings.length
    ? warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')
    : '<li>No warnings recorded.</li>';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Curious Grit Approval — ${escapeHtml(spec.id)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #080808; color: #f4f1e8; }
    header { position: sticky; top: 0; z-index: 10; padding: 18px 16px; background: rgba(8,8,8,.94); backdrop-filter: blur(16px); border-bottom: 1px solid #2a2a2a; }
    .brand { letter-spacing: .16em; color: #c9a227; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0 4px; font-size: clamp(20px, 5vw, 34px); }
    .status { display: inline-flex; gap: 8px; align-items: center; margin-top: 10px; padding: 8px 12px; border: 1px solid #4b3d14; border-radius: 999px; color: #e7c95a; background: #171306; font-size: 13px; font-weight: 700; }
    main { width: min(100%, 720px); margin: 0 auto; padding: 18px 14px 72px; }
    .summary { margin-bottom: 18px; padding: 16px; border: 1px solid #242424; border-radius: 16px; background: #101010; }
    .summary p { margin: 6px 0; color: #cfcac0; line-height: 1.5; }
    .slides { display: grid; gap: 18px; }
    .slide-card { overflow: hidden; border: 1px solid #242424; border-radius: 18px; background: #111; box-shadow: 0 14px 40px rgba(0,0,0,.28); }
    .slide-card img { display: block; width: 100%; height: auto; background: #0a0a0a; }
    .meta { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; color: #aaa; font-size: 13px; }
    .meta strong { color: #f4f1e8; }
    .warnings { margin-top: 24px; padding: 16px; border: 1px solid #3a2d12; border-radius: 16px; background: #151108; }
    .warnings h2 { margin-top: 0; font-size: 16px; color: #e7c95a; }
    .warnings li { margin: 8px 0; line-height: 1.45; color: #d3c7a5; }
    footer { margin-top: 28px; color: #777; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <header>
    <div class="brand">CURIOUS GRIT · NEXUS APPROVAL</div>
    <h1>${escapeHtml(spec.topic)}</h1>
    <div class="status">${escapeHtml(spec.approvalStatus)} · publishAllowed=${String(publishAllowed)}</div>
  </header>
  <main>
    <section class="summary">
      <p><strong>Selected hook:</strong> ${escapeHtml(spec.selectedHook)}</p>
      <p><strong>Objective:</strong> ${escapeHtml(spec.objective)}</p>
      <p><strong>Slides:</strong> ${spec.slides.length}</p>
      <p><strong>Safety:</strong> This review gallery never publishes content.</p>
    </section>
    <section class="slides">${slides}</section>
    <section class="warnings">
      <h2>QC / verification notes</h2>
      <ul>${warningItems}</ul>
    </section>
    <footer>Nexus Content Studio · owner approval required before public publishing</footer>
  </main>
</body>
</html>`;

  const galleryPath = path.join(outputRoot, 'approval-gallery.html');
  await writeFile(galleryPath, html, 'utf8');
  return galleryPath;
}
