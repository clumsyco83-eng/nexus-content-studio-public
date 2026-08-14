import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RiskClass } from '../goals/schema.js';

export type PowerShellBrokerCapabilityId =
  | 'system.process.inspect'
  | 'nexus.health.check'
  | 'nexus.verification.run'
  | 'nexus.service.status'
  | 'nexus.service.start'
  | 'nexus.service.restart'
  | 'nexus.repo.status'
  | 'nexus.repo.sync'
  | 'nexus.intelligence-foundation.complete'
  | 'nexus.core-specialists.complete'
  | 'nexus.business-profile.complete'
  | 'nexus.claude.live-readiness';

export interface PowerShellBrokerRequest {
  id: string;
  goalId: string;
  taskId: string;
  capability: PowerShellBrokerCapabilityId;
  args: Record<string, string>;
  cwd: string;
  requestedAt: string;
  expiresAt: string;
  timeoutMs: number;
}

export interface PowerShellBrokerCapability {
  id: PowerShellBrokerCapabilityId;
  riskClass: Extract<RiskClass, 'GREEN' | 'YELLOW'>;
  description: string;
}

export interface PowerShellInvocation {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

const CAPABILITIES: Record<PowerShellBrokerCapabilityId, PowerShellBrokerCapability> = {
  'system.process.inspect': {
    id: 'system.process.inspect',
    riskClass: 'GREEN',
    description: 'Read-only inspection of one explicitly named Windows process.',
  },
  'nexus.health.check': {
    id: 'nexus.health.check',
    riskClass: 'GREEN',
    description: 'Read-only literal-loopback NEXUS health check.',
  },
  'nexus.verification.run': {
    id: 'nexus.verification.run',
    riskClass: 'YELLOW',
    description: 'Run the one fixed, install-free NEXUS laptop verification sequence in the repository root.',
  },
  'nexus.service.status': {
    id: 'nexus.service.status',
    riskClass: 'GREEN',
    description: 'Read-only status for the fixed NEXUS Assistant Scheduled Task.',
  },
  'nexus.service.start': {
    id: 'nexus.service.start',
    riskClass: 'YELLOW',
    description: 'Start the fixed NEXUS Assistant Scheduled Task and verify the loopback health endpoint.',
  },
  'nexus.service.restart': {
    id: 'nexus.service.restart',
    riskClass: 'YELLOW',
    description: 'Restart only the fixed NEXUS Assistant Scheduled Task and require loopback health recovery.',
  },
  'nexus.repo.status': {
    id: 'nexus.repo.status',
    riskClass: 'GREEN',
    description: 'Read-only status for the configured NEXUS repository and its fixed origin remote.',
  },
  'nexus.repo.sync': {
    id: 'nexus.repo.sync',
    riskClass: 'YELLOW',
    description: 'Fast-forward only the clean NEXUS main worktree to one explicitly approved origin/main commit.',
  },
  'nexus.intelligence-foundation.complete': {
    id: 'nexus.intelligence-foundation.complete',
    riskClass: 'YELLOW',
    description: 'Install and deterministically verify only the pinned NEXUS Intelligence Foundation package through repository-owned completion helpers.',
  },
  'nexus.core-specialists.complete': {
    id: 'nexus.core-specialists.complete',
    riskClass: 'YELLOW',
    description: 'Promote and deterministically verify only the fixed six canonical NEXUS core specialist skills from the fixed local source tree.',
  },
  'nexus.business-profile.complete': {
    id: 'nexus.business-profile.complete',
    riskClass: 'YELLOW',
    description: 'Install and deterministically verify only the pinned seven-skill NEXUS Business Intelligence Profile package.',
  },
  'nexus.claude.live-readiness': {
    id: 'nexus.claude.live-readiness',
    riskClass: 'YELLOW',
    description: 'Run one fixed one-turn no-tool Claude Code live readiness call through the NEXUS Secure Claude Executor using evaluated model/version evidence.',
  },
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertExactKeys(args: Record<string, string>, expected: string[]): void {
  const keys = Object.keys(args).sort();
  const wanted = expected.slice().sort();
  if (keys.length !== wanted.length || keys.some((value, index) => value !== wanted[index])) {
    throw new Error(`Invalid broker arguments. Expected exactly: ${wanted.join(', ') || '(none)'}.`);
  }
}

function normalizedPath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function validateLoopbackHealthUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('nexus.health.check requires a valid URL.');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error('nexus.health.check is restricted to literal loopback HTTP only.');
  }
  if (parsed.pathname !== '/api/health' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('nexus.health.check is restricted to the exact /api/health endpoint without credentials, query, or fragment.');
  }
}

function validateExpectedHead(value: string): void {
  if (!/^[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('nexus.repo.sync expectedHead must be one full 40-character Git commit SHA.');
  }
}

function systemPowerShellPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function brokerScriptPath(repoRoot: string, capability: PowerShellBrokerCapabilityId): string {
  if (
    capability === 'nexus.verification.run'
    || capability === 'nexus.intelligence-foundation.complete'
    || capability === 'nexus.claude.live-readiness'
  ) {
    return path.join(repoRoot, 'scripts', 'powershell-broker-completion-v2.ps1');
  }
  return path.join(repoRoot, 'scripts', 'powershell-broker-v1.ps1');
}

export function getPowerShellBrokerCapability(id: PowerShellBrokerCapabilityId): PowerShellBrokerCapability {
  const capability = CAPABILITIES[id];
  if (!capability) throw new Error(`Unknown PowerShell Broker capability: ${String(id)}`);
  return capability;
}

export function fingerprintPowerShellBrokerRequest(request: PowerShellBrokerRequest): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

export function validatePowerShellBrokerRequest(request: PowerShellBrokerRequest, repoRoot: string, now = new Date()): PowerShellBrokerCapability {
  if (!request.id.trim() || !request.goalId.trim() || !request.taskId.trim()) throw new Error('Broker request id, goalId, and taskId are required.');
  if (!Number.isFinite(now.getTime())) throw new Error('Broker validation time must be valid.');
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 30 * 60 * 1_000) {
    throw new Error('Broker timeoutMs must be an integer from 1000 to 1800000.');
  }
  const requestedAt = Date.parse(request.requestedAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt) || expiresAt <= requestedAt) throw new Error('Broker request timestamps are invalid.');
  if (now.getTime() < requestedAt - 60_000) throw new Error('Broker request is from the future.');
  if (now.getTime() >= expiresAt) throw new Error('Broker request has expired.');
  if (expiresAt - requestedAt > 15 * 60 * 1_000) throw new Error('Broker request TTL may not exceed 15 minutes.');
  if (normalizedPath(request.cwd) !== normalizedPath(repoRoot)) throw new Error('Broker cwd must be exactly the configured NEXUS repository root.');

  const capability = getPowerShellBrokerCapability(request.capability);
  if (capability.id === 'system.process.inspect') {
    assertExactKeys(request.args, ['processName']);
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(request.args.processName ?? '')) throw new Error('processName contains unsafe characters.');
  } else if (capability.id === 'nexus.health.check') {
    assertExactKeys(request.args, ['url']);
    validateLoopbackHealthUrl(request.args.url ?? '');
  } else if (
    capability.id === 'nexus.verification.run'
    || capability.id === 'nexus.service.status'
    || capability.id === 'nexus.service.start'
    || capability.id === 'nexus.service.restart'
    || capability.id === 'nexus.repo.status'
    || capability.id === 'nexus.intelligence-foundation.complete'
    || capability.id === 'nexus.core-specialists.complete'
    || capability.id === 'nexus.business-profile.complete'
    || capability.id === 'nexus.claude.live-readiness'
  ) {
    assertExactKeys(request.args, []);
  } else if (capability.id === 'nexus.repo.sync') {
    assertExactKeys(request.args, ['expectedHead']);
    validateExpectedHead(request.args.expectedHead ?? '');
  }
  return capability;
}

export function buildPowerShellInvocation(request: PowerShellBrokerRequest, repoRoot: string, now = new Date()): PowerShellInvocation {
  validatePowerShellBrokerRequest(request, repoRoot, now);
  const script = brokerScriptPath(repoRoot, request.capability);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script, '-Capability', request.capability];
  if (request.capability === 'system.process.inspect') args.push('-ProcessName', request.args.processName);
  if (request.capability === 'nexus.health.check') args.push('-Url', request.args.url);
  if (request.capability === 'nexus.repo.sync') args.push('-ExpectedHead', request.args.expectedHead);
  return { file: systemPowerShellPath(), args, cwd: path.resolve(repoRoot), timeoutMs: request.timeoutMs };
}
