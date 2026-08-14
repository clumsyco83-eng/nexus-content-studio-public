import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createNexusStore } from '../storage/factory.js';
import {
  applyClaudeRuntimeObservationRefresh,
  CLAUDE_RUNTIME_OBSERVATION_EVIDENCE_MAX_AGE_MS,
  previewClaudeRuntimeObservationRefresh,
  requireClaudeRuntimeObservationApplyOptIn,
} from './claude-runtime-observation.js';

interface CliOptions {
  evidencePath: string;
  actualVersion: string;
  capabilityId: string;
  apply: boolean;
  backupDir?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run capability:claude-runtime-observation -- --evidence <stream-json-file> --actual-version <claude-version>',
    '  npm run capability:claude-runtime-observation -- --evidence <stream-json-file> --actual-version <claude-version> --apply [--backup-dir <path>]',
    '',
    'Default mode is preview/read-only. The evidence file must be a fresh verified bounded Claude smoke (<= 10 minutes old).',
    'Apply additionally requires NEXUS_CLAUDE_RUNTIME_OBSERVATION_APPLY=I_ACKNOWLEDGE_CLAUDE_RUNTIME_OBSERVATION_MUTATION.',
    'The command imports dotenv/config before createNexusStore(), matching Secure Bridge live-regression storage selection.',
    'It records only a fresh runtime observation plus its audit line; it never changes the evaluated binding, readiness policy or readiness checks.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  let evidencePath = '';
  let actualVersion = '';
  let capabilityId = process.env.NEXUS_CLAUDE_RUNTIME_CAPABILITY_ID?.trim() || 'claude-executor';
  let apply = false;
  let backupDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--evidence') { const value = argv[++index]; if (!value) throw new Error('--evidence requires a file path.'); evidencePath = value; continue; }
    if (arg === '--actual-version') { const value = argv[++index]; if (!value) throw new Error('--actual-version requires the exact claude --version string.'); actualVersion = value; continue; }
    if (arg === '--capability') { const value = argv[++index]; if (!value) throw new Error('--capability requires an ID.'); capabilityId = value; continue; }
    if (arg === '--backup-dir') { const value = argv[++index]; if (!value) throw new Error('--backup-dir requires a directory path.'); backupDir = value; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!evidencePath) throw new Error('--evidence is required.');
  if (!actualVersion.trim()) throw new Error('--actual-version is required.');
  return { evidencePath, actualVersion, capabilityId, apply, backupDir };
}

function positiveCost(raw: string | undefined): number {
  const value = raw?.trim() ? Number(raw) : 0.1;
  if (!Number.isFinite(value) || value <= 0 || value > 0.5) throw new Error('NEXUS_CLAUDE_LIVE_SMOKE_MAX_COST_USD must be > 0 and <= $0.50.');
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  requireClaudeRuntimeObservationApplyOptIn(options.apply, process.env);
  const expectedResolvedModel = process.env.NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL?.trim();
  const expectedVersion = process.env.NEXUS_CLAUDE_EXPECTED_CODE_VERSION?.trim();
  if (!expectedResolvedModel) throw new Error('NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL is required.');
  if (!expectedVersion) throw new Error('NEXUS_CLAUDE_EXPECTED_CODE_VERSION is required.');

  const absoluteEvidencePath = path.resolve(options.evidencePath);
  const evidenceStat = await stat(absoluteEvidencePath);
  if (!evidenceStat.isFile()) throw new Error('Claude smoke evidence path must be a regular file.');
  const ageMs = Date.now() - evidenceStat.mtimeMs;
  if (ageMs < -5_000) throw new Error('Claude smoke evidence file timestamp is in the future.');
  if (ageMs > CLAUDE_RUNTIME_OBSERVATION_EVIDENCE_MAX_AGE_MS) {
    throw new Error(`Claude smoke evidence is too old (${Math.round(ageMs / 1000)}s). Run a fresh bounded smoke; old evidence may not renew runtime readiness.`);
  }
  const streamJson = await readFile(absoluteEvidencePath, 'utf8');
  const input = {
    capabilityId: options.capabilityId,
    streamJson,
    expectedResolvedModel,
    expectedClaudeCodeVersion: expectedVersion,
    actualClaudeCodeVersion: options.actualVersion,
    expectedCwd: process.cwd(),
    maxCostUsd: positiveCost(process.env.NEXUS_CLAUDE_LIVE_SMOKE_MAX_COST_USD),
    observedAt: evidenceStat.mtime.toISOString(),
  };

  const store = createNexusStore();
  const summary = options.apply
    ? await applyClaudeRuntimeObservationRefresh(store, input, { backupDir: options.backupDir })
    : await previewClaudeRuntimeObservationRefresh(store, input);

  console.log(JSON.stringify({
    ...summary,
    providerCallsMade: false,
    bridgeExecutionApplied: false,
    evidenceFilePersisted: false,
    secretsPrinted: false,
  }, null, 2));
  if (!options.apply) console.log('PREVIEW ONLY — durable NEXUS state was not mutated.');
  else console.log('APPLIED — fresh bounded Claude runtime observation recorded against the unchanged evaluated binding.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
