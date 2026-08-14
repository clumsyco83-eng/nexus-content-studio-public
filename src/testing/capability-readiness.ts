import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry, capabilityReadiness } from '../capabilities/registry.js';
import { GoalRepository } from '../goals/repository.js';
import { JsonFileStore } from '../storage/store.js';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-capability-'));
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    const registry = new CapabilityRegistry(store);
    const goals = new GoalRepository(store);

    const capability = await registry.upsert({
      id: 'claude:intelligence-foundation-v1',
      kind: 'SKILL',
      description: 'Eight project-local NEXUS Intelligence Foundation skills.',
      source: 'nexus-intelligence-foundation-v1.0.0.zip',
      version: '1.0.0',
      requiredChecks: ['PACKAGED', 'DISCOVERED', 'ROUTING_VERIFIED', 'SAFETY_VERIFIED'],
      passedChecks: ['PACKAGED'],
      evidence: ['PACKAGED: validator 54 passed, 0 warnings, 0 errors'],
    });
    let status = capabilityReadiness(capability);
    assert.equal(status.ready, false);
    assert.deepEqual(status.missingChecks, ['DISCOVERED', 'ROUTING_VERIFIED', 'SAFETY_VERIFIED']);

    const goal = await goals.createGoal({
      id: 'capability-gated-goal',
      title: 'Capability-gated execution',
      objective: 'Do not execute Claude intelligence work until the real host is ready.',
      successCriteria: ['Unready skills block scheduling', 'Ready skills permit scheduling'],
      priority: 1,
    });
    await goals.transitionGoal(goal.id, 'WORKING');

    const task = await goals.enqueueTask({
      id: 'research-with-intelligence',
      goalId: goal.id,
      title: 'Run verified intelligence research',
      intent: 'Use the Intelligence Foundation only after its live-host gate is satisfied.',
      worker: 'CLAUDE',
      acceptanceCriteria: ['Sources are verified'],
      verificationPlan: ['Check source/freshness evidence'],
      requiredCapabilities: [capability.id],
      idempotencyKey: 'capability:research:v1',
    });
    assert.equal(task.state, 'READY');
    assert.deepEqual(await goals.listReadyTasks(), []);
    await assert.rejects(() => goals.transitionTask(task.id, 'WORKING'), /not ready/);

    await registry.recordCheck(capability.id, 'DISCOVERED', 'Claude Code host listed the project skill in a fresh repository session.');
    await registry.recordCheck(capability.id, 'ROUTING_VERIFIED', 'Positive, negative, and edge routing cases passed.');
    await registry.recordCheck(capability.id, 'SAFETY_VERIFIED', 'NEXUS Guardian/Watchdog/workspace verification remained green.');

    status = (await registry.readiness([capability.id]))[0]!;
    assert.equal(status.ready, true);
    assert.deepEqual(status.missingChecks, []);
    assert.deepEqual((await goals.listReadyTasks()).map((item) => item.id), [task.id]);

    await goals.transitionTask(task.id, 'WORKING');
    await registry.setEnabled(capability.id, false, 'Operator disabled the skill profile for rollback testing.');
    await assert.rejects(() => goals.transitionTask(task.id, 'VERIFYING'), /not ready/);

    console.log('PASS NEXUS capability readiness: packaged is not ready, live discovery/routing/safety evidence gates scheduling, and disabling fails closed.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
