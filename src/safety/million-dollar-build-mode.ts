import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredGoalTask } from '../goals/schema.js';

export const MILLION_DOLLAR_BUILD_MODE_SCHEMA = 'nexus.million-dollar-build-mode.v1' as const;
export const MILLION_DOLLAR_BUILD_MODE_TTL_MS = 24 * 60 * 60 * 1_000;

const REMOTE_YELLOW_ALLOWLIST = new Set([
  'nexus.verification.run',
  'nexus.service.start',
  'nexus.service.restart',
  'nexus.intelligence-foundation.complete',
  'nexus.core-specialists.complete',
  'nexus.business-profile.complete',
]);

// Standing Claude authority deliberately excludes every surface that can widen
// execution, approval, model/capability routing, persistence, transport,
// publishing/provider effects, dependency/CI authority, or safety verification.
const CLAUDE_PROTECTED_EXACT = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'tsconfig.json',
  'claude.md',
  'guardian.md',
  'operating_controls.md',
  '.env',
  '.env.example',
  'src/approval.ts',
  'src/index.ts',
  'src/memory.ts',
]);

const CLAUDE_PROTECTED_PREFIXES = [
  '.claude/',
  '.github/',
  'dashboard/',
  'scripts/',
  'src/ai/',
  'src/capabilities/',
  'src/claude/',
  'src/dashboard/',
  'src/goals/',
  'src/guardian/',
  'src/openai/',
  'src/orchestration/',
  'src/powershell-broker/',
  'src/providers/',
  'src/publishing/',
  'src/remote-transport/',
  'src/safety/',
  'src/scheduling/',
  'src/storage/',
  'src/testing/',
  'src/verification/',
];

export interface MillionDollarBuildModeState {
  schema: typeof MILLION_DOLLAR_BUILD_MODE_SCHEMA;
  active: boolean;
  activatedAt?: string;
  activatedBy?: string;
  expiresAt?: string;
  deactivatedAt?: string;
  deactivatedBy?: string;
  reason?: string;
}

export interface MillionDollarBuildModeStatus extends MillionDollarBuildModeState {
  effectiveActive: boolean;
  expired: boolean;
  policy: {
    remoteYellowCapabilities: string[];
    claudeMaxTurns: number;
    claudeMaxRepairs: number;
    claudeMaxTimeMs: number;
    claudeMaxCostUsd: number;
    repoSyncStillRequiresOwnerApproval: true;
    redStillBlocked: true;
  };
}

export interface BuildModeTaskAuthorization {
  authorized: boolean;
  reason: string;
  stateFingerprint?: string;
}

const INACTIVE_STATE: MillionDollarBuildModeState = {
  schema: MILLION_DOLLAR_BUILD_MODE_SCHEMA,
  active: false,
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stateFingerprint(state: MillionDollarBuildModeState): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

function normalizeRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim().toLowerCase();
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//.test(normalized)) return undefined;
  if (normalized.split('/').includes('..')) return undefined;
  return normalized;
}

function protectedClaudePath(value: string): boolean {
  const normalized = normalizeRelativePath(value);
  if (!normalized) return true;
  if (CLAUDE_PROTECTED_EXACT.has(normalized)) return true;
  return CLAUDE_PROTECTED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function taskEligibleForMillionDollarBuildMode(task: StoredGoalTask): boolean {
  if (task.riskClass !== 'YELLOW' || task.approvalRequirement !== 'OWNER') return false;

  if (task.worker === 'TOOL') {
    return task.goalId === 'nexus-remote-control'
      && task.requiredCapabilities.length === 1
      && REMOTE_YELLOW_ALLOWLIST.has(task.requiredCapabilities[0] ?? '');
  }

  if (task.worker !== 'CLAUDE') return false;
  if (task.allowedPaths.length < 1 || task.allowedPaths.length > 20) return false;
  if (task.allowedPaths.some(protectedClaudePath)) return false;
  if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1 || task.maxTurns > 12) return false;
  if (!Number.isInteger(task.maxRepairs) || task.maxRepairs < 0 || task.maxRepairs > 5) return false;
  if (!Number.isInteger(task.timeLimitMs) || task.timeLimitMs < 1_000 || task.timeLimitMs > 30 * 60_000) return false;
  if (task.costBudgetUsd === undefined || !Number.isFinite(task.costBudgetUsd) || task.costBudgetUsd <= 0 || task.costBudgetUsd > 5) return false;
  return true;
}

function statusPolicy() {
  return {
    remoteYellowCapabilities: [...REMOTE_YELLOW_ALLOWLIST].sort(),
    claudeMaxTurns: 12,
    claudeMaxRepairs: 5,
    claudeMaxTimeMs: 30 * 60_000,
    claudeMaxCostUsd: 5,
    repoSyncStillRequiresOwnerApproval: true as const,
    redStillBlocked: true as const,
  };
}

export class MillionDollarBuildModeStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = 'data/million-dollar-build-mode.json') {}

  describe(): string {
    return path.resolve(this.filePath);
  }

  async getStatus(now = new Date()): Promise<MillionDollarBuildModeStatus> {
    if (!Number.isFinite(now.getTime())) throw new Error('Build Mode status time must be valid.');
    const state = await this.readState();
    const expiresAt = state.expiresAt ? Date.parse(state.expiresAt) : Number.NaN;
    const expired = state.active && (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt);
    return {
      ...state,
      effectiveActive: state.active && !expired,
      expired,
      policy: statusPolicy(),
    };
  }

  async authorizeTask(task: StoredGoalTask, now = new Date()): Promise<BuildModeTaskAuthorization> {
    const status = await this.getStatus(now);
    if (!status.effectiveActive) {
      return { authorized: false, reason: status.expired ? 'Million-Dollar Build Mode has expired.' : 'Million-Dollar Build Mode is inactive.' };
    }
    if (!taskEligibleForMillionDollarBuildMode(task)) {
      return { authorized: false, reason: 'Task is outside the fixed Million-Dollar Build Mode standing-authority policy.' };
    }
    const state: MillionDollarBuildModeState = {
      schema: status.schema,
      active: status.active,
      activatedAt: status.activatedAt,
      activatedBy: status.activatedBy,
      expiresAt: status.expiresAt,
      deactivatedAt: status.deactivatedAt,
      deactivatedBy: status.deactivatedBy,
      reason: status.reason,
    };
    return {
      authorized: true,
      reason: 'Owner standing authorization is active for this bounded Million-Dollar Build Mode task.',
      stateFingerprint: stateFingerprint(state),
    };
  }

  async activate(activatedBy: string, now = new Date()): Promise<MillionDollarBuildModeStatus> {
    const actor = activatedBy.trim();
    if (!actor) throw new Error('activatedBy is required to activate Million-Dollar Build Mode.');
    if (!Number.isFinite(now.getTime())) throw new Error('Build Mode activation time must be valid.');
    const state: MillionDollarBuildModeState = {
      schema: MILLION_DOLLAR_BUILD_MODE_SCHEMA,
      active: true,
      activatedAt: now.toISOString(),
      activatedBy: actor,
      expiresAt: new Date(now.getTime() + MILLION_DOLLAR_BUILD_MODE_TTL_MS).toISOString(),
      reason: 'Temporary owner-authorized NEXUS Million-Dollar Project build window.',
    };
    await this.enqueue(async () => this.saveUnlocked(state));
    return this.getStatus(now);
  }

  async deactivate(deactivatedBy: string, now = new Date()): Promise<MillionDollarBuildModeStatus> {
    const actor = deactivatedBy.trim();
    if (!actor) throw new Error('deactivatedBy is required to deactivate Million-Dollar Build Mode.');
    if (!Number.isFinite(now.getTime())) throw new Error('Build Mode deactivation time must be valid.');
    await this.enqueue(async () => {
      const current = await this.readState();
      const state: MillionDollarBuildModeState = {
        ...current,
        schema: MILLION_DOLLAR_BUILD_MODE_SCHEMA,
        active: false,
        deactivatedAt: now.toISOString(),
        deactivatedBy: actor,
        reason: 'Normal per-task owner approvals restored.',
      };
      await this.saveUnlocked(state);
    });
    return this.getStatus(now);
  }

  private async readState(): Promise<MillionDollarBuildModeState> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MillionDollarBuildModeState>;
      if (!parsed || parsed.schema !== MILLION_DOLLAR_BUILD_MODE_SCHEMA || typeof parsed.active !== 'boolean') {
        return { ...INACTIVE_STATE, reason: 'Build Mode state is malformed; standing authority failed closed.' };
      }
      return {
        schema: MILLION_DOLLAR_BUILD_MODE_SCHEMA,
        active: parsed.active,
        activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : undefined,
        activatedBy: typeof parsed.activatedBy === 'string' ? parsed.activatedBy : undefined,
        expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined,
        deactivatedAt: typeof parsed.deactivatedAt === 'string' ? parsed.deactivatedAt : undefined,
        deactivatedBy: typeof parsed.deactivatedBy === 'string' ? parsed.deactivatedBy : undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...INACTIVE_STATE };
      return { ...INACTIVE_STATE, reason: `Build Mode state could not be read; standing authority failed closed (${error instanceof Error ? error.message : String(error)}).` };
    }
  }

  private async saveUnlocked(state: MillionDollarBuildModeState): Promise<void> {
    const absolute = path.resolve(this.filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await rename(temp, absolute);
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
