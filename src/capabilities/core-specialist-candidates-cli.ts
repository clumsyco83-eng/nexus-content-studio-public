import path from 'node:path';
import { createNexusStore } from '../storage/factory.js';
import {
  applyCoreSpecialistCandidates,
  CORE_SPECIALIST_CAPABILITY_APPLY_OPT_IN,
  previewCoreSpecialistCandidates,
  readCoreSpecialistCandidateManifest,
} from './core-specialist-candidates.js';

interface Options {
  manifestPath: string;
  apply: boolean;
  backupDir?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run core-specialists:capabilities -- --manifest <manifest.json>',
    '  npm run core-specialists:capabilities -- --manifest <manifest.json> --apply [--backup-dir <dir>]',
    '',
    'Default mode is preview/read-only.',
    `Apply requires NEXUS_CORE_SPECIALIST_CAPABILITY_APPLY=${CORE_SPECIALIST_CAPABILITY_APPLY_OPT_IN}.`,
    'Existing capability evidence is never overwritten by this candidate registrar.',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  let manifestPath = '';
  let apply = false;
  let backupDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--manifest') {
      const value = argv[++index];
      if (!value) throw new Error('--manifest requires a path.');
      manifestPath = value;
      continue;
    }
    if (arg === '--backup-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--backup-dir requires a path.');
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
  const manifestPath = path.resolve(options.manifestPath);
  const input = await readCoreSpecialistCandidateManifest(manifestPath);
  const store = createNexusStore();
  const plan = options.apply
    ? await applyCoreSpecialistCandidates(store, input, { backupDir: options.backupDir })
    : await previewCoreSpecialistCandidates(store, input);

  console.log(JSON.stringify({
    ...plan,
    manifestPath,
    providerCallsMade: false,
    skillsMarkedReadyAutomatically: false,
  }, null, 2));
  if (!options.apply) console.log('PREVIEW ONLY — NEXUS durable state was not mutated.');
  else console.log('APPLIED — missing specialist capabilities were registered as candidates only. Live readiness evidence is still required.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
