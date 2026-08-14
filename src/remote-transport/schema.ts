import { z } from 'zod';
import type { PowerShellBrokerCapabilityId } from '../powershell-broker/policy.js';

export const remoteCommandSchema = z.object({
  schema: z.literal('nexus.remote.command.v1'),
  id: z.string().min(8).max(120).regex(/^[A-Za-z0-9._-]+$/),
  hostId: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  capability: z.enum([
    'system.process.inspect',
    'nexus.health.check',
    'nexus.verification.run',
    'nexus.service.status',
    'nexus.service.start',
    'nexus.service.restart',
    'nexus.repo.status',
    'nexus.repo.sync',
    'nexus.intelligence-foundation.complete',
    'nexus.core-specialists.complete',
    'nexus.business-profile.complete',
  ]),
  args: z.record(z.string().max(2_000)).default({}),
  requestedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  timeoutMs: z.number().int().min(1_000).max(30 * 60 * 1_000),
}).strict();

export type RemoteCommand = z.infer<typeof remoteCommandSchema> & {
  capability: PowerShellBrokerCapabilityId;
};

export function parseRemoteCommandBody(body: string): RemoteCommand {
  if (Buffer.byteLength(body, 'utf8') > 32 * 1024) throw new Error('Remote command body exceeds 32 KiB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Remote command issue body must be strict JSON only.');
  }
  return remoteCommandSchema.parse(parsed) as RemoteCommand;
}

export function validateRemoteCommandWindow(command: RemoteCommand, now = new Date()): void {
  if (!Number.isFinite(now.getTime())) throw new Error('Remote command validation time must be valid.');
  const requestedAt = Date.parse(command.requestedAt);
  const expiresAt = Date.parse(command.expiresAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt) || expiresAt <= requestedAt) {
    throw new Error('Remote command timestamps are invalid.');
  }
  if (expiresAt - requestedAt > 15 * 60_000) throw new Error('Remote command TTL may not exceed 15 minutes.');
  if (now.getTime() < requestedAt - 60_000) throw new Error('Remote command is from the future.');
  if (now.getTime() >= expiresAt) throw new Error('Remote command has expired.');
}
