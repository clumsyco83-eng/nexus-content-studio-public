import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CapabilityRegistry, capabilityReadiness } from './registry.js';
import type { NexusDatabase, NexusStore } from '../storage/store.js';

export const CORE_SPECIALIST_CAPABILITY_APPLY_OPT_IN = 'I_ACKNOWLEDGE_CORE_SPECIALIST_CAPABILITY_REGISTRATION';

export const CORE_SPECIALIST_NAMES = [
  'technology-research-scout',
  'principal-architecture',
  'engineering-intelligence',
  'backend-data-engineer',
  'platform-sre-engineer',
  'nexus-qa-testing-director',
] as const;

const coreSpecialistNameSchema = z.enum(CORE_SPECIALIST_NAMES);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

export const coreSpecialistCandidateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  sourceRoot: z.string().min(1).max(1_000),
  candidates: z.array(z.object({
    name: coreSpecialistNameSchema,
    source: z.string().min(1).max(1_000),
    sourceSha256: sha256Schema,
    version: z.string().min(1).max(160),
  }).strict()).length(CORE_SPECIALIST_NAMES.length),
}).strict();

export type CoreSpecialistCandidateManifest = z.infer<typeof coreSpecialistCandidateManifestSchema>;

export interface CoreSpecialistCandidatePlanItem {
  name: (typeof CORE_SPECIALIST_NAMES)[number];
  capabilityId: string;
  action: 'CREATE_NOT_READY' | 'KEEP_EXISTING';
  existingReady: boolean;
  sourceSha256: string;
}

export interface CoreSpecialistCandidatePlan {
  mode: 'preview' | 'apply';
  backupPath?: string;
  items: CoreSpecialistCandidatePlanItem[];
}

function parseManifest(input: unknown): CoreSpecialistCandidateManifest {
  const manifest = coreSpecialistCandidateManifestSchema.parse(input);
  const names = manifest.candidates.map((item) => item.name);
  const unique = new Set(names);
  if (unique.size !== CORE_SPECIALIST_NAMES.length) throw new Error('Core specialist manifest contains duplicate candidates.');
  for (const expected of CORE_SPECIALIST_NAMES) {
    if (!unique.has(expected)) throw new Error(`Core specialist manifest is missing ${expected}.`);
  }
  return {
    ...manifest,
    candidates: manifest.candidates.map((item) => ({ ...item, sourceSha256: item.sourceSha256.toLowerCase() })),
  };
}

function capabilityId(name: string): string {
  return `skill:${name}`;
}

function requireApplyOptIn(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NEXUS_CORE_SPECIALIST_CAPABILITY_APPLY !== CORE_SPECIALIST_CAPABILITY_APPLY_OPT_IN) {
    throw new Error(`Apply mode is disabled. Set NEXUS_CORE_SPECIALIST_CAPABILITY_APPLY=${CORE_SPECIALIST_CAPABILITY_APPLY_OPT_IN} only for a deliberate local candidate registration.`);
  }
}

async function makePlan(store: NexusStore, manifest: CoreSpecialistCandidateManifest): Promise<CoreSpecialistCandidatePlanItem[]> {
  const db = await store.load();
  return manifest.candidates
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((candidate) => {
      const id = capabilityId(candidate.name);
      const existing = db.capabilities.find((item) => item.id === id);
      if (!existing) {
        return { name: candidate.name, capabilityId: id, action: 'CREATE_NOT_READY' as const, existingReady: false, sourceSha256: candidate.sourceSha256 };
      }
      if (existing.kind !== 'SKILL') throw new Error(`Existing capability ${id} is ${existing.kind}, expected SKILL.`);
      const existingHash = existing.evidenceBinding?.sourceSha256?.toLowerCase();
      if (!existingHash) {
        throw new Error(`Existing capability ${id} has no source SHA-256. Refusing to attach candidate evidence implicitly; review it through the normal evidence lifecycle.`);
      }
      if (existingHash !== candidate.sourceSha256) {
        throw new Error(`Existing capability ${id} source SHA-256 differs from the promoted candidate. Refusing to overwrite evaluated evidence.`);
      }
      return {
        name: candidate.name,
        capabilityId: id,
        action: 'KEEP_EXISTING' as const,
        existingReady: capabilityReadiness(existing).ready,
        sourceSha256: candidate.sourceSha256,
      };
    });
}

function timestamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

async function writeBackup(database: NexusDatabase, backupDir: string): Promise<string> {
  const absolute = path.resolve(backupDir);
  await mkdir(absolute, { recursive: true });
  const backupPath = path.join(absolute, `${timestamp()}-core-specialist-capabilities-pre-apply.json`);
  await writeFile(backupPath, JSON.stringify(database, null, 2), { encoding: 'utf8', mode: 0o600 });
  return backupPath;
}

export async function previewCoreSpecialistCandidates(store: NexusStore, input: unknown): Promise<CoreSpecialistCandidatePlan> {
  const manifest = parseManifest(input);
  return { mode: 'preview', items: await makePlan(store, manifest) };
}

export async function applyCoreSpecialistCandidates(
  store: NexusStore,
  input: unknown,
  options: { backupDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CoreSpecialistCandidatePlan> {
  requireApplyOptIn(options.env ?? process.env);
  const manifest = parseManifest(input);
  const items = await makePlan(store, manifest);
  const before = await store.load();
  const backupPath = await writeBackup(before, options.backupDir ?? 'data/readiness-backups');
  const registry = new CapabilityRegistry(store);

  try {
    for (const item of items) {
      if (item.action === 'KEEP_EXISTING') continue;
      const candidate = manifest.candidates.find((entry) => entry.name === item.name)!;
      await registry.upsert({
        id: item.capabilityId,
        kind: 'SKILL',
        description: `${item.name} project-local NEXUS core specialist candidate. Live discovery/routing/model/runtime/safety evidence is required before READY.`,
        source: candidate.source,
        version: candidate.version,
        requiredChecks: ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'SAFETY_VERIFIED'],
        passedChecks: ['PACKAGED'],
        enabled: true,
        evidence: [`PACKAGED: exact project-local candidate source manifest SHA-256 ${candidate.sourceSha256}.`],
        evidenceBinding: { sourceSha256: candidate.sourceSha256 },
        readinessPolicy: {
          requireSourceSha256: true,
          requireEvaluationRevision: true,
          requireExactModelIdentity: true,
          requireRuntimeVersion: true,
          requireSafetyRevision: true,
          requireRollbackTarget: true,
          requireRuntimeObservation: true,
        },
      });
    }
  } catch (error) {
    await store.save(before);
    throw new Error(`Core specialist capability registration failed; pre-apply NEXUS state was restored. Backup retained at ${backupPath}. Original error: ${error instanceof Error ? error.message : String(error)}`);
  }

  const afterItems = await makePlan(store, manifest);
  for (const item of afterItems) {
    const capability = await registry.get(item.capabilityId);
    if (!capability) throw new Error(`Capability disappeared after registration: ${item.capabilityId}`);
    if (capabilityReadiness(capability).ready && !items.find((beforeItem) => beforeItem.capabilityId === item.capabilityId)?.existingReady) {
      await store.save(before);
      throw new Error(`Candidate registration unexpectedly made ${item.capabilityId} READY. State was restored; live evaluation must promote it deliberately.`);
    }
  }

  return { mode: 'apply', backupPath, items: afterItems };
}

export async function readCoreSpecialistCandidateManifest(filePath: string): Promise<unknown> {
  const raw = await readFile(path.resolve(filePath), 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}
