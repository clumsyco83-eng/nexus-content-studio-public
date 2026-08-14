import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PowerShellBrokerCapabilityId } from './policy.js';

export interface PowerShellBrokerLease {
  id: string;
  requestId: string;
  requestFingerprint: string;
  goalId: string;
  taskId: string;
  capability: PowerShellBrokerCapabilityId;
  issuedAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
}

interface LeaseDatabase {
  leases: PowerShellBrokerLease[];
}

export class PowerShellBrokerLeaseStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = process.env.NEXUS_POWERSHELL_BROKER_LEASE_FILE ?? 'data/powershell-broker-leases.json') {}

  describe(): string {
    return path.resolve(this.filePath);
  }

  async issue(input: Omit<PowerShellBrokerLease, 'id' | 'usedAt' | 'revokedAt' | 'revocationReason'>): Promise<PowerShellBrokerLease> {
    return this.update((db) => {
      for (const lease of db.leases) {
        if (lease.requestId === input.requestId && !lease.usedAt && !lease.revokedAt) {
          lease.revokedAt = input.issuedAt;
          lease.revocationReason = 'Superseded by a newer lease for the same request.';
        }
      }
      const lease: PowerShellBrokerLease = { id: randomUUID(), ...input };
      db.leases.push(lease);
      return lease;
    });
  }

  async consume(leaseId: string, requestFingerprint: string, now = new Date()): Promise<PowerShellBrokerLease> {
    if (!Number.isFinite(now.getTime())) throw new Error('Lease consumption time must be valid.');
    return this.update((db) => {
      const lease = db.leases.find((item) => item.id === leaseId);
      if (!lease) throw new Error(`Unknown PowerShell Broker lease: ${leaseId}`);
      if (lease.revokedAt) throw new Error(`PowerShell Broker lease ${lease.id} is revoked.`);
      if (lease.usedAt) throw new Error(`PowerShell Broker lease ${lease.id} has already been consumed.`);
      if (lease.requestFingerprint !== requestFingerprint) throw new Error('PowerShell Broker lease fingerprint mismatch.');
      const expiresAt = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) throw new Error(`PowerShell Broker lease ${lease.id} has expired.`);
      lease.usedAt = now.toISOString();
      return { ...lease };
    });
  }

  async revoke(leaseId: string, reason: string, now = new Date()): Promise<PowerShellBrokerLease> {
    const why = reason.trim();
    if (!why) throw new Error('Lease revocation reason is required.');
    return this.update((db) => {
      const lease = db.leases.find((item) => item.id === leaseId);
      if (!lease) throw new Error(`Unknown PowerShell Broker lease: ${leaseId}`);
      if (!lease.usedAt && !lease.revokedAt) {
        lease.revokedAt = now.toISOString();
        lease.revocationReason = why.slice(0, 1_000);
      }
      return { ...lease };
    });
  }

  private async loadUnlocked(): Promise<LeaseDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<LeaseDatabase>;
      return { leases: Array.isArray(parsed.leases) ? parsed.leases : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { leases: [] };
      throw error;
    }
  }

  private async saveUnlocked(database: LeaseDatabase): Promise<void> {
    const absolute = path.resolve(this.filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.tmp`;
    await writeFile(temp, JSON.stringify(database, null, 2), 'utf8');
    await rename(temp, absolute);
  }

  private async update<T>(mutator: (database: LeaseDatabase) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      const database = await this.loadUnlocked();
      const result = mutator(database);
      await this.saveUnlocked(database);
      return result;
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
