import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireSecureBridgeCycleLock, inspectSecureBridgeCycleLock } from '../orchestration/secure-bridge-lock.js';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-secure-bridge-lock-'));
  try {
    const lockFile = path.join(root, 'cycle.lock');
    const projectRoot = path.join(root, 'project');

    const first = await acquireSecureBridgeCycleLock({
      projectRoot,
      lockFile,
      now: new Date('2026-08-13T08:00:00.000Z'),
    });
    const state = await inspectSecureBridgeCycleLock(lockFile);
    assert.equal(state.present, true);
    assert.equal(state.metadata?.nonce, first.metadata.nonce);
    assert.equal(state.metadata?.pid, process.pid);

    await assert.rejects(
      () => acquireSecureBridgeCycleLock({ projectRoot, lockFile }),
      /lock already exists.*Do not start another cycle|lock already exists/i,
    );

    await first.release();
    assert.equal((await inspectSecureBridgeCycleLock(lockFile)).present, false);

    const second = await acquireSecureBridgeCycleLock({ projectRoot, lockFile });
    const stored = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
    stored.nonce = 'another-owner';
    await writeFile(lockFile, JSON.stringify(stored), 'utf8');
    await assert.rejects(() => second.release(), /ownership changed unexpectedly/i);
    assert.equal((await inspectSecureBridgeCycleLock(lockFile)).present, true, 'Ownership mismatch must leave the lock in place.');

    await rm(lockFile, { force: true });
    await writeFile(lockFile, '{malformed', 'utf8');
    await assert.rejects(
      () => acquireSecureBridgeCycleLock({ projectRoot, lockFile }),
      /lock already exists.*malformed|lock already exists.*unreadable/i,
    );
    const malformed = await inspectSecureBridgeCycleLock(lockFile);
    assert.equal(malformed.present, true);
    assert.match(malformed.error ?? '', /malformed/i);

    console.log('PASS Secure Bridge cycle lock: exclusive acquisition, no concurrent cycle, ownership-safe release and malformed/stale lock fail-closed without auto-clear.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
