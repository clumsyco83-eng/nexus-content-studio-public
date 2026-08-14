import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmergencyStopStore } from '../safety/emergency-stop.js';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-emergency-stop-'));
  try {
    const file = path.join(root, 'state', 'emergency-stop.json');
    const store = new EmergencyStopStore(file);
    assert.equal((await store.getState()).active, false, 'Missing state file means no stop has ever been activated.');

    const activated = await store.activate('owner', 'Safety regression test', new Date('2026-08-13T08:00:00.000Z'));
    assert.equal(activated.active, true);
    assert.equal(await store.isActive(), true);
    assert.equal(activated.activatedBy, 'owner');

    const reloaded = new EmergencyStopStore(file);
    assert.equal((await reloaded.getState()).active, true, 'Emergency stop must persist across process/store reload.');

    const cleared = await reloaded.clear('owner', new Date('2026-08-13T08:01:00.000Z'));
    assert.equal(cleared.active, false);
    assert.equal(cleared.clearedBy, 'owner');
    assert.equal(await reloaded.isActive(), false);

    await writeFile(file, '{not-json', 'utf8');
    const corrupt = await reloaded.getState();
    assert.equal(corrupt.active, true, 'Corrupt emergency-stop state must fail closed.');
    assert.match(corrupt.reason ?? '', /could not be read|malformed/i);

    await writeFile(file, JSON.stringify({ wrong: true }), 'utf8');
    const malformed = await reloaded.getState();
    assert.equal(malformed.active, true, 'Malformed emergency-stop state must fail closed.');
    assert.match(malformed.reason ?? '', /malformed/i);

    const unreadableTarget = path.join(root, 'directory-instead-of-file');
    await mkdir(unreadableTarget);
    const unreadable = await new EmergencyStopStore(unreadableTarget).getState();
    assert.equal(unreadable.active, true, 'Unreadable emergency-stop state must fail closed.');

    await assert.rejects(() => store.activate('', 'reason'), /activatedBy is required/);
    await assert.rejects(() => store.activate('owner', ''), /reason is required/);
    await assert.rejects(() => store.clear(''), /clearedBy is required/);

    console.log('PASS NEXUS emergency stop: durable explicit owner control, missing-is-inactive bootstrap, and malformed/unreadable state fails closed.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
