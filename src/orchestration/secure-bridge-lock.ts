import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SecureBridgeCycleLockMetadata {
  schemaVersion: 1;
  nonce: string;
  pid: number;
  projectRoot: string;
  acquiredAt: string;
}

export interface SecureBridgeCycleLock {
  filePath: string;
  metadata: SecureBridgeCycleLockMetadata;
  release(): Promise<void>;
}

function defaultLockFile(): string {
  const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), '.nexus');
  return path.join(base, 'NEXUS', 'secure-bridge-cycle.lock');
}

function normalizedProjectRoot(value: string): string {
  const root = path.resolve(value.trim());
  if (!value.trim() || !path.isAbsolute(root)) throw new Error('Secure Bridge cycle lock requires an absolute project root.');
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

async function readExisting(filePath: string): Promise<SecureBridgeCycleLockMetadata | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let parsed: Partial<SecureBridgeCycleLockMetadata>;
  try {
    parsed = JSON.parse(raw) as Partial<SecureBridgeCycleLockMetadata>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Existing Secure Bridge cycle lock is malformed/unreadable: ${detail}`);
  }

  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.nonce !== 'string' || !parsed.nonce.trim() ||
    !Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0 ||
    typeof parsed.projectRoot !== 'string' || !parsed.projectRoot.trim() ||
    typeof parsed.acquiredAt !== 'string' || !Number.isFinite(Date.parse(parsed.acquiredAt))
  ) {
    throw new Error('Existing Secure Bridge cycle lock is malformed/unreadable: required metadata is missing or invalid.');
  }
  return parsed as SecureBridgeCycleLockMetadata;
}

async function writeMetadata(handle: FileHandle, metadata: SecureBridgeCycleLockMetadata): Promise<void> {
  await writeFile(handle, JSON.stringify(metadata, null, 2), { encoding: 'utf8' });
  await handle.sync();
}

/**
 * Acquire one cross-process Secure Bridge scheduler/provider lease.
 *
 * An existing lock always fails closed. It is deliberately NOT auto-cleared
 * based on PID age/liveness because a crashed parent can leave a Claude child
 * process running. Recovery therefore requires explicit operator inspection.
 */
export async function acquireSecureBridgeCycleLock(input: {
  projectRoot: string;
  lockFile?: string;
  now?: Date;
}): Promise<SecureBridgeCycleLock> {
  const projectRoot = normalizedProjectRoot(input.projectRoot);
  const filePath = path.resolve(input.lockFile?.trim() || defaultLockFile());
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Secure Bridge cycle lock time must be valid.');
  await mkdir(path.dirname(filePath), { recursive: true });

  let handle: FileHandle;
  try {
    handle = await open(filePath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let details = 'metadata unavailable';
    try {
      const existing = await readExisting(filePath);
      if (existing) details = `pid=${existing.pid}, acquiredAt=${existing.acquiredAt}, projectRoot=${existing.projectRoot}`;
    } catch (metadataError) {
      details = `malformed/unreadable metadata (${metadataError instanceof Error ? metadataError.message : String(metadataError)})`;
    }
    throw new Error(
      `Secure Bridge cycle lock already exists at ${filePath} (${details}). ` +
      'Do not start another cycle or delete the lock while a Claude child might still be running. Inspect the existing process/task evidence first; stale-lock recovery is an explicit operator action.',
    );
  }

  const metadata: SecureBridgeCycleLockMetadata = {
    schemaVersion: 1,
    nonce: randomUUID(),
    pid: process.pid,
    projectRoot,
    acquiredAt: now.toISOString(),
  };

  try {
    await writeMetadata(handle, metadata);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(filePath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    filePath,
    metadata,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      const current = await readExisting(filePath);
      if (!current) return;
      if (current.nonce !== metadata.nonce || current.pid !== metadata.pid || current.projectRoot !== metadata.projectRoot) {
        throw new Error('Secure Bridge cycle lock ownership changed unexpectedly; refusing to delete another owner lock.');
      }
      await unlink(filePath);
    },
  };
}

export async function inspectSecureBridgeCycleLock(lockFile?: string): Promise<{
  filePath: string;
  present: boolean;
  metadata?: SecureBridgeCycleLockMetadata;
  error?: string;
}> {
  const filePath = path.resolve(lockFile?.trim() || defaultLockFile());
  try {
    const metadata = await readExisting(filePath);
    return metadata ? { filePath, present: true, metadata } : { filePath, present: false };
  } catch (error) {
    return { filePath, present: true, error: error instanceof Error ? error.message : String(error) };
  }
}
