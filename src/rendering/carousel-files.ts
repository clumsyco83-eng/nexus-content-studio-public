import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CarouselSpec } from '../content/carousel.js';
import { renderCarouselSvgs } from './carousel-svg.js';

export interface CarouselRenderResult {
  outputDir: string;
  svgFiles: string[];
  pngFiles: string[];
  warnings: string[];
}

export async function renderCarouselFiles(
  spec: CarouselSpec,
  outputRoot = 'output/carousels',
): Promise<CarouselRenderResult> {
  const outputDir = path.resolve(outputRoot, spec.id);
  await mkdir(outputDir, { recursive: true });

  const svgFiles: string[] = [];
  const pngFiles: string[] = [];
  const warnings: string[] = [];

  const slides = renderCarouselSvgs(spec);
  for (const slide of slides) {
    const svgPath = path.join(outputDir, slide.filename);
    await writeFile(svgPath, slide.svg, 'utf8');
    svgFiles.push(svgPath);
  }

  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default;

    for (const svgPath of svgFiles) {
      const pngPath = svgPath.replace(/\.svg$/i, '.png');
      await sharp(svgPath, { density: 144 })
        .resize(1080, 1350, { fit: 'fill' })
        .png({ compressionLevel: 9 })
        .toFile(pngPath);
      pngFiles.push(pngPath);
    }
  } catch (error) {
    warnings.push(
      `PNG export skipped because optional dependency "sharp" is unavailable or failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const manifest = {
    carouselId: spec.id,
    brand: spec.brand,
    topic: spec.topic,
    approvalStatus: spec.approvalStatus,
    dimensions: { width: 1080, height: 1350 },
    svgs: svgFiles.map((file) => path.basename(file)),
    pngs: pngFiles.map((file) => path.basename(file)),
    warnings,
    generatedAt: new Date().toISOString(),
  };

  await writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  return { outputDir, svgFiles, pngFiles, warnings };
}
