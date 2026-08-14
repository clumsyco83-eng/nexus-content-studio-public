import { z } from 'zod';

export const capabilityKindSchema = z.enum(['SKILL', 'RUNTIME', 'CONNECTOR', 'MODEL']);
export const capabilityCheckSchema = z.enum([
  'PACKAGED',
  'DISCOVERED',
  'ROUTING_VERIFIED',
  'RUNTIME_WIRED',
  'SAFETY_VERIFIED',
]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'sourceSha256 must be a 64-character SHA-256 hex digest.');
const evidenceTimestampSchema = z.string().datetime({ offset: true });
const modelIdSchema = z.string().min(1).max(240);

export const capabilityEvidenceBindingSchema = z.object({
  sourceSha256: sha256Schema.optional(),
  evaluationRevision: z.string().min(1).max(240).optional(),
  evaluatedAt: evidenceTimestampSchema.optional(),
  expiresAt: evidenceTimestampSchema.optional(),
  evaluatedModelIds: z.array(modelIdSchema).max(20).default([]),
  providerResolvedModelIds: z.array(modelIdSchema).max(20).default([]),
  runtimeVersion: z.string().min(1).max(240).optional(),
  safetyRevision: z.string().min(1).max(240).optional(),
  rollbackTarget: z.string().min(1).max(500).optional(),
}).strict();

export const capabilityRuntimeObservationSchema = z.object({
  observedAt: evidenceTimestampSchema,
  sourceSha256: sha256Schema.optional(),
  providerResolvedModelIds: z.array(modelIdSchema).max(20).default([]),
  runtimeVersion: z.string().min(1).max(240).optional(),
  safetyRevision: z.string().min(1).max(240).optional(),
  note: z.string().min(1).max(2_000).optional(),
}).strict();

export const capabilityReadinessPolicySchema = z.object({
  requireSourceSha256: z.boolean().default(false),
  requireEvaluationRevision: z.boolean().default(false),
  requireExactModelIdentity: z.boolean().default(false),
  requireRuntimeVersion: z.boolean().default(false),
  requireSafetyRevision: z.boolean().default(false),
  requireRollbackTarget: z.boolean().default(false),
  requireRuntimeObservation: z.boolean().default(false),
  maxEvidenceAgeHours: z.number().positive().max(24 * 365 * 5).optional(),
  maxRuntimeObservationAgeHours: z.number().positive().max(24 * 365 * 5).optional(),
}).strict();

export const upsertCapabilitySchema = z.object({
  id: z.string().min(1).max(160),
  kind: capabilityKindSchema,
  description: z.string().min(1).max(2_000),
  source: z.string().min(1).max(1_000).optional(),
  version: z.string().min(1).max(160).optional(),
  requiredChecks: z.array(capabilityCheckSchema).min(1).max(5),
  passedChecks: z.array(capabilityCheckSchema).max(5).optional(),
  enabled: z.boolean().optional(),
  evidence: z.array(z.string().min(1).max(2_000)).max(100).optional(),
  evidenceBinding: capabilityEvidenceBindingSchema.optional(),
  readinessPolicy: capabilityReadinessPolicySchema.optional(),
  lastRuntimeObservation: capabilityRuntimeObservationSchema.optional(),
  invalidations: z.array(z.string().min(1).max(2_000)).max(100).optional(),
}).strict();

export type CapabilityKind = z.infer<typeof capabilityKindSchema>;
export type CapabilityCheck = z.infer<typeof capabilityCheckSchema>;
export type CapabilityEvidenceBinding = z.infer<typeof capabilityEvidenceBindingSchema>;
export type CapabilityRuntimeObservation = z.infer<typeof capabilityRuntimeObservationSchema>;
export type CapabilityReadinessPolicy = z.infer<typeof capabilityReadinessPolicySchema>;
export type UpsertCapabilityInput = z.input<typeof upsertCapabilitySchema>;

export interface StoredCapability {
  id: string;
  kind: CapabilityKind;
  description: string;
  source?: string;
  version?: string;
  requiredChecks: CapabilityCheck[];
  passedChecks: CapabilityCheck[];
  enabled: boolean;
  evidence: string[];
  evidenceBinding?: CapabilityEvidenceBinding;
  readinessPolicy?: CapabilityReadinessPolicy;
  lastRuntimeObservation?: CapabilityRuntimeObservation;
  invalidations?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityReadiness {
  id: string;
  ready: boolean;
  enabled: boolean;
  missingChecks: CapabilityCheck[];
  staleReasons: string[];
  evidence: string[];
  invalidations: string[];
}
