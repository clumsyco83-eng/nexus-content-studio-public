import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createNexusStore } from '../storage/factory.js';
import {
  applyCapabilityEvidenceManifest,
  previewCapabilityEvidenceManifest,
  requireCapabilityEvidenceApplyOptIn,
} from './evidence-recorder.js';

interface CliOptions {
  manifestPath: string;
  apply: boolean;
  backupDir?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run capability:evidence -- --manifest <path-to-manifest.json>',
    '  npm run capability:evidence -- --manifest <path-to-manifest.json> --apply [--backup-dir <path>]',
    '',
    'Default mode is preview/read-only.',
    'Apply additionally requires NEXUS_CAPABILITY_EVIDENCE_APPLY=I_ACKNOWLEDGE_CAPABILITY_READINESS_MUTATION.',
    'This command makes no provider call and does not apply Secure Bridge changes.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  let manifestPath = '';
  let apply = false;
  let backupDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--manifest') {
      const value = argv[++index];
      if (!value) throw new Error('--manifest requires a file path.');
      manifestPath = value;
      continue;
    }
    if (arg === '--backup-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--backup-dir requires a directory path.');
      backupDir = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!manifestPath) throw new Error('--manifest is required.');
  return { manifestPath, apply, backupDir };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  requireCapabilityEvidenceApplyOptIn(options.apply, process.env);

  const absoluteManifestPath = path.resolve(options.manifestPath);
  const raw = await readFile(absoluteManifestPath, 'utf8');
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const store = createNexusStore();
  const summary = options.apply
    ? await applyCapabilityEvidenceManifest(store, decoded, { backupDir: options.backupDir })
    : await previewCapabilityEvidenceManifest(store, decoded);

  console.log(JSON.stringify({
    ...summary,
    manifestPath: absoluteManifestPath,
    providerCallsMade: false,
    bridgeChangesApplied: false,
    secretsPrinted: false,
  }, null, 2));

  if (!options.apply) {
    console.log('PREVIEW ONLY — durable NEXUS state was not mutated.');
  } else if (!summary.after.ready) {
    console.log('APPLIED SAFELY — evidence was recorded, but the capability remains NOT READY. Resolve the reported missing/stale requirements before routing work to it.');
  } else {
    console.log('APPLIED — current manifest evidence satisfies the configured capability readiness policy.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
