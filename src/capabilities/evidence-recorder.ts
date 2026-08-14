import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CapabilityRegistry, capabilityReadiness } from './registry.js';
import {
  capabilityCheckSchema,
  capabilityEvidenceBindingSchema,
  capabilityKindSchema,
  capabilityReadinessPolicySchema,
  capabilityRuntimeObservationSchema,
  type CapabilityReadiness,
  type StoredCapability,
} from './schema.js';
import type { NexusDatabase, NexusStore, StoreDescription } from '../storage/store.js';

export const CAPABILITY_EVIDENCE_APPLY_OPT_IN = 'I_ACKNOWLEDGE_CAPABILITY_READINESS_MUTATION';

const evidenceTextSchema = z.string().min(1).max(2_000);

const capabilityManifestSchema = z.object({
  id: z.string().min(1).max(160),
  kind: capabilityKindSchema,
  description: z.string().min(1).max(2_000),
  source: z.string().min(1).max(1_000).optional(),
  version: z.string().min(1).max(160).optional(),
  requiredChecks: z.array(capabilityCheckSchema).min(1).max(5),
  readinessPolicy: capabilityReadinessPolicySchema.optional(),
}).strict();

const checkEvidenceSchema = z.object({
  check: capabilityCheckSchema,
  evidence: evidenceTextSchema,
}).strict();

export const capabilityEvidenceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  capability: capabilityManifestSchema,
  binding: capabilityEvidenceBindingSchema.optional(),
  runtimeObservation: capabilityRuntimeObservationSchema.optional(),
  checks: z.array(checkEvidenceSchema).max(5).default([]),
  note: evidenceTextSchema.optional(),
}).strict();

export type CapabilityEvidenceManifest = z.infer<typeof capabilityEvidenceManifestSchema>;

export interface RecorderReadinessSummary {
  ready: boolean;
  enabled: boolean;
  missingChecks: string[];
  staleReasons: string[];
  recentInvalidations: string[];
}

export interface CapabilityEvidenceRecorderSummary {
  mode: 'preview' | 'apply';
  capabilityId: string;
  storage: StoreDescription;
  backupPath?: string;
  before: RecorderReadinessSummary;
  after: RecorderReadinessSummary;
  beforeExists: boolean;
  afterExists: boolean;
  recordedChecks: string[];
  mutationAttempted: boolean;
}

const secretPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: 'named secret assignment', pattern: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|NEXUS_DASHBOARD_TOKEN|YOUTUBE_CLIENT_SECRET|META_APP_SECRET|TIKTOK_CLIENT_SECRET|TIKTOK_ACCESS_TOKEN|META_ACCESS_TOKEN|YOUTUBE_REFRESH_TOKEN)\s*=/i },
  { label: 'API-style secret', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i },
  { label: 'Bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/i },
  { label: 'private key material', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
];

const placeholderPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: 'REPLACE_WITH placeholder', pattern: /\bREPLACE_WITH[A-Z0-9_:-]*\b/i },
  { label: 'CHANGEME placeholder', pattern: /\bCHANGE(?:_?ME)?\b/i },
  { label: 'TODO placeholder', pattern: /\bTODO\b/i },
  { label: 'angle-bracket placeholder', pattern: /<[^>]{1,120}>/ },
  { label: 'example-only placeholder', pattern: /\bEXAMPLE[_ -]?ONLY\b/i },
];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function unknownReadiness(id: string): CapabilityReadiness {
  return {
    id,
    ready: false,
    enabled: false,
    missingChecks: [],
    staleReasons: ['capability is not registered'],
    evidence: ['MISSING: capability is not registered'],
    invalidations: [],
  };
}

function readinessFor(capability: StoredCapability | undefined, id: string): CapabilityReadiness {
  return capability ? capabilityReadiness(capability) : unknownReadiness(id);
}

function sanitizeOutputText(value: string): string {
  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(value)) return `[REDACTED ${label}]`;
  }
  return value;
}

function readinessSummary(readiness: CapabilityReadiness): RecorderReadinessSummary {
  return {
    ready: readiness.ready,
    enabled: readiness.enabled,
    missingChecks: readiness.missingChecks.slice(),
    staleReasons: readiness.staleReasons.map(sanitizeOutputText),
    recentInvalidations: readiness.invalidations.slice(-10).map(sanitizeOutputText),
  };
}

function assertSafeManifestStrings(value: unknown, pathName = '$'): void {
  if (typeof value === 'string') {
    for (const { label, pattern } of secretPatterns) {
      if (pattern.test(value)) throw new Error(`Capability evidence manifest contains forbidden ${label} at ${pathName}. Do not store credentials in readiness evidence.`);
    }
    for (const { label, pattern } of placeholderPatterns) {
      if (pattern.test(value)) throw new Error(`Capability evidence manifest contains unresolved ${label} at ${pathName}. Replace every template placeholder with verified real-host evidence before preview/apply.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeManifestStrings(entry, `${pathName}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/api.?key|password|credential|access.?token|refresh.?token|client.?secret|auth.?token/i.test(key)) {
        throw new Error(`Capability evidence manifest contains forbidden credential field ${pathName}.${key}.`);
      }
      assertSafeManifestStrings(entry, `${pathName}.${key}`);
    }
  }
}

function validateManifestRelationships(manifest: CapabilityEvidenceManifest): void {
  const required = new Set(manifest.capability.requiredChecks);
  const seen = new Set<string>();
  for (const item of manifest.checks) {
    if (!required.has(item.check)) throw new Error(`Manifest check ${item.check} is not in capability.requiredChecks.`);
    if (seen.has(item.check)) throw new Error(`Manifest contains duplicate check evidence for ${item.check}.`);
    seen.add(item.check);
  }
}

export function parseCapabilityEvidenceManifest(input: unknown): CapabilityEvidenceManifest {
  assertSafeManifestStrings(input);
  const manifest = capabilityEvidenceManifestSchema.parse(input);
  validateManifestRelationships(manifest);
  return manifest;
}

export function requireCapabilityEvidenceApplyOptIn(apply: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (!apply) return;
  if (env.NEXUS_CAPABILITY_EVIDENCE_APPLY !== CAPABILITY_EVIDENCE_APPLY_OPT_IN) {
    throw new Error(
      `Apply mode is disabled. Set NEXUS_CAPABILITY_EVIDENCE_APPLY=${CAPABILITY_EVIDENCE_APPLY_OPT_IN} only for one deliberate local readiness-evidence mutation.`,
    );
  }
}

class MemoryStore implements NexusStore {
  constructor(private database: NexusDatabase, private readonly description: StoreDescription) {}

  async load(): Promise<NexusDatabase> {
    return structuredClone(this.database);
  }

  async save(database: NexusDatabase): Promise<void> {
    this.database = structuredClone(database);
  }

  async update<T>(mutator: (database: NexusDatabase) => T): Promise<T> {
    const working = structuredClone(this.database);
    const result = mutator(working);
    this.database = working;
    return result;
  }

  describe(): StoreDescription {
    return this.description;
  }
}

async function applyManifestToRegistry(registry: CapabilityRegistry, manifest: CapabilityEvidenceManifest): Promise<StoredCapability> {
  await registry.upsert({
    id: manifest.capability.id,
    kind: manifest.capability.kind,
    description: manifest.capability.description,
    source: manifest.capability.source,
    version: manifest.capability.version,
    requiredChecks: manifest.capability.requiredChecks,
    readinessPolicy: manifest.capability.readinessPolicy,
  });

  if (manifest.binding) {
    await registry.bindEvidence(
      manifest.capability.id,
      manifest.binding,
      manifest.note ?? `Manifest v${manifest.schemaVersion} evidence binding recorded.`,
    );
  }

  if (manifest.runtimeObservation) {
    await registry.recordRuntimeObservation(
      manifest.capability.id,
      manifest.runtimeObservation,
      manifest.runtimeObservation.note ?? manifest.note ?? `Manifest v${manifest.schemaVersion} runtime observation recorded.`,
    );
  }

  for (const item of manifest.checks) {
    await registry.recordCheck(manifest.capability.id, item.check, item.evidence);
  }

  const capability = await registry.get(manifest.capability.id);
  if (!capability) throw new Error(`Capability ${manifest.capability.id} disappeared during evidence recording.`);
  return capability;
}

function safeCapabilityFileSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'capability';
}

function backupTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export async function writeCapabilityEvidenceBackup(
  database: NexusDatabase,
  capabilityId: string,
  backupDir = process.env.NEXUS_CAPABILITY_EVIDENCE_BACKUP_DIR ?? 'data/readiness-backups',
): Promise<string> {
  const absoluteDir = path.resolve(backupDir);
  await mkdir(absoluteDir, { recursive: true });
  const filePath = path.join(absoluteDir, `${backupTimestamp()}-${safeCapabilityFileSegment(capabilityId)}-pre-apply.json`);
  await writeFile(filePath, JSON.stringify(database, null, 2), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

export async function previewCapabilityEvidenceManifest(
  store: NexusStore,
  manifestInput: unknown,
): Promise<CapabilityEvidenceRecorderSummary> {
  const manifest = parseCapabilityEvidenceManifest(manifestInput);
  const database = await store.load();
  const existing = database.capabilities.find((item) => item.id === manifest.capability.id);
  const before = readinessFor(existing, manifest.capability.id);
  const memoryStore = new MemoryStore(structuredClone(database), { driver: store.describe().driver, location: 'memory-preview' });
  const projected = await applyManifestToRegistry(new CapabilityRegistry(memoryStore), manifest);

  return {
    mode: 'preview',
    capabilityId: manifest.capability.id,
    storage: store.describe(),
    before: readinessSummary(before),
    after: readinessSummary(capabilityReadiness(projected)),
    beforeExists: Boolean(existing),
    afterExists: true,
    recordedChecks: unique(manifest.checks.map((item) => item.check)),
    mutationAttempted: false,
  };
}

export async function applyCapabilityEvidenceManifest(
  store: NexusStore,
  manifestInput: unknown,
  options: { backupDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CapabilityEvidenceRecorderSummary> {
  requireCapabilityEvidenceApplyOptIn(true, options.env ?? process.env);
  const manifest = parseCapabilityEvidenceManifest(manifestInput);
  const beforeDatabase = await store.load();
  const existing = beforeDatabase.capabilities.find((item) => item.id === manifest.capability.id);
  const before = readinessFor(existing, manifest.capability.id);

  // Prove the entire manifest is internally applicable before mutating durable state.
  const previewStore = new MemoryStore(structuredClone(beforeDatabase), { driver: store.describe().driver, location: 'memory-preflight' });
  await applyManifestToRegistry(new CapabilityRegistry(previewStore), manifest);

  const backupPath = await writeCapabilityEvidenceBackup(beforeDatabase, manifest.capability.id, options.backupDir);
  let applied: StoredCapability;
  try {
    applied = await applyManifestToRegistry(new CapabilityRegistry(store), manifest);
  } catch (error) {
    try {
      await store.save(beforeDatabase);
    } catch (restoreError) {
      throw new Error(
        `Capability evidence apply failed and automatic restore also failed. Backup retained at ${backupPath}. ` +
        `Apply error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}.`,
      );
    }
    throw new Error(
      `Capability evidence apply failed; pre-apply NEXUS state was restored. Backup retained at ${backupPath}. ` +
      `Original error: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  return {
    mode: 'apply',
    capabilityId: manifest.capability.id,
    storage: store.describe(),
    backupPath,
    before: readinessSummary(before),
    after: readinessSummary(capabilityReadiness(applied)),
    beforeExists: Boolean(existing),
    afterExists: true,
    recordedChecks: unique(manifest.checks.map((item) => item.check)),
    mutationAttempted: true,
  };
}
