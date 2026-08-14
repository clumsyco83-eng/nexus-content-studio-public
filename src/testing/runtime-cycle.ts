import assert from 'node:assert/strict';
import { runRuntimeCycle, type RuntimeCyclePorts, type RuntimeCycleTask } from '../orchestration/runtime-cycle.js';

const task: RuntimeCycleTask = {
  id: 'task-1',
  goalId: 'goal-1',
  title: 'Implement bounded change',
  riskClass: 'GREEN',
  requiresOwnerApproval: false,
  requiredCapabilities: ['claude-executor', 'nexus-verifier'],
};

type Mode =
  | 'pass'
  | 'emergency'
  | 'idle'
  | 'red'
  | 'approval'
  | 'yellow'
  | 'capability-block'
  | 'runtime-reject'
  | 'repair'
  | 'replan'
  | 'stop'
  | 'task-worker-failed';

function harness(mode: Mode): { ports: RuntimeCyclePorts; calls: string[] } {
  const calls: string[] = [];
  const selected: RuntimeCycleTask | undefined = mode === 'idle'
    ? undefined
    : mode === 'approval'
      ? { ...task, requiresOwnerApproval: true }
      : mode === 'yellow'
        ? { ...task, riskClass: 'YELLOW' }
        : mode === 'red'
          ? { ...task, riskClass: 'RED', requiresOwnerApproval: true }
          : task;

  const ports: RuntimeCyclePorts = {
    async isEmergencyStopped() {
      calls.push('emergency');
      return mode === 'emergency';
    },
    async resumeEligibleTasks() {
      calls.push('resume');
      return ['resumed-1'];
    },
    async nextReadyTask() {
      calls.push('next');
      return selected;
    },
    async markRiskBlocked(_task, reason) { calls.push(`risk-blocked:${reason}`); },
    async approvalStatus() {
      calls.push('approval-status');
      return mode === 'approval' || mode === 'yellow'
        ? { approved: false, reason: 'Current task/revision approval fingerprint is missing or stale.' }
        : { approved: true };
    },
    async capabilitiesReady() {
      calls.push('capabilities');
      return mode === 'capability-block'
        ? { ready: false, missing: ['openai-strategy', 'claude-executor', 'claude-executor'] }
        : { ready: true, missing: [] };
    },
    async markWaitingApproval(_task, reason) { calls.push(`wait-approval:${reason}`); },
    async markCapabilityBlocked(_task, missing) {
      calls.push(`blocked:${missing.join('|')}`);
    },
    async execute() {
      calls.push('execute');
      return {
        attemptId: 'attempt-1',
        workerSucceeded: mode !== 'task-worker-failed',
        outputRef: 'artifact://attempt-1',
      };
    },
    async attestRuntime() {
      calls.push('attest');
      return mode === 'runtime-reject'
        ? { accepted: false, capabilityReady: false, reason: 'Runtime identity drift.' }
        : { accepted: true, capabilityReady: true };
    },
    async markRuntimeRejected() { calls.push('runtime-rejected'); },
    async verify(_task, execution) {
      calls.push('verify');
      if (mode === 'pass') return { passed: true, evidence: ['typecheck green', 'deterministic verifier pass'] };
      return {
        passed: false,
        evidence: ['verifier failure evidence'],
        failure: execution.workerSucceeded ? 'Acceptance criterion not met.' : 'Worker execution failed safely.',
      };
    },
    async persistAttempt() { calls.push('persist-attempt'); },
    async diagnoseProgress() {
      calls.push('diagnose');
      if (mode === 'replan') return { action: 'REPLAN', reason: 'Repeated non-progress.' };
      if (mode === 'stop') return { action: 'STOP', reason: 'Budget exhausted.' };
      return { action: 'CONTINUE', reason: 'Verifier feedback is actionable.' };
    },
    async requestReplan() {
      calls.push('replan');
      return { strategyId: 'strategy-2', summary: 'Use a materially different bounded repair strategy.' };
    },
    async markRepairRequired(_task, _reason, strategyId) {
      calls.push(strategyId ? `repair:${strategyId}` : 'repair');
    },
    async markFailedSafe() { calls.push('failed-safe'); },
    async checkpoint() { calls.push('checkpoint'); },
  };
  return { ports, calls };
}

async function main(): Promise<void> {
  {
    const { ports, calls } = harness('emergency');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'EMERGENCY_STOPPED');
    assert.deepEqual(calls, ['emergency']);
  }

  {
    const { ports, calls } = harness('idle');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'IDLE');
    assert.deepEqual(calls, ['emergency', 'resume', 'next']);
    assert.deepEqual(result.resumedTaskIds, ['resumed-1']);
  }

  {
    const { ports, calls } = harness('red');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'BLOCKED_RISK');
    assert.match(result.reason, /RED task is non-executable/i);
    assert.deepEqual(calls.slice(0, 3), ['emergency', 'resume', 'next']);
    assert.equal(calls.some((call) => call.startsWith('risk-blocked:')), true);
    assert.equal(calls.includes('approval-status'), false);
    assert.equal(calls.includes('execute'), false);
  }

  for (const mode of ['approval', 'yellow'] as const) {
    const { ports, calls } = harness(mode);
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'WAITING_APPROVAL');
    assert.match(result.reason, /fingerprint/i);
    assert.deepEqual(calls, [
      'emergency',
      'resume',
      'next',
      'approval-status',
      'wait-approval:Current task/revision approval fingerprint is missing or stale.',
    ]);
    assert.equal(calls.includes('capabilities'), false);
    assert.equal(calls.includes('execute'), false);
  }

  {
    const { ports, calls } = harness('capability-block');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'BLOCKED_CAPABILITY');
    assert.deepEqual(result.missingCapabilities, ['claude-executor', 'openai-strategy']);
    assert.deepEqual(calls, ['emergency', 'resume', 'next', 'capabilities', 'blocked:claude-executor|openai-strategy']);
    assert.equal(calls.includes('execute'), false);
  }

  {
    const { ports, calls } = harness('runtime-reject');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'RUNTIME_REJECTED');
    assert.deepEqual(calls, ['emergency', 'resume', 'next', 'capabilities', 'execute', 'attest', 'runtime-rejected']);
    assert.equal(calls.includes('verify'), false, 'Untrusted runtime output must never reach the Verifier as valid execution evidence.');
  }

  {
    const { ports, calls } = harness('pass');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'CHECKPOINTED');
    assert.deepEqual(calls, ['emergency', 'resume', 'next', 'capabilities', 'execute', 'attest', 'verify', 'persist-attempt', 'checkpoint']);
  }

  {
    const { ports, calls } = harness('repair');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'REPAIR_REQUIRED');
    assert.deepEqual(calls, ['emergency', 'resume', 'next', 'capabilities', 'execute', 'attest', 'verify', 'persist-attempt', 'diagnose', 'repair']);
    assert.equal(calls.includes('replan'), false);
  }

  {
    const { ports, calls } = harness('task-worker-failed');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'REPAIR_REQUIRED');
    assert.match(result.reason, /Worker execution failed safely/);
    assert.deepEqual(calls, ['emergency', 'resume', 'next', 'capabilities', 'execute', 'attest', 'verify', 'persist-attempt', 'diagnose', 'repair']);
  }

  {
    const { ports, calls } = harness('replan');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'REPLAN_APPLIED');
    assert.equal(result.strategyId, 'strategy-2');
    assert.deepEqual(calls, ['emergency', 'resume', 'next', 'capabilities', 'execute', 'attest', 'verify', 'persist-attempt', 'diagnose', 'replan', 'repair:strategy-2']);
  }

  {
    const { ports, calls } = harness('stop');
    const result = await runRuntimeCycle(ports);
    assert.equal(result.outcome, 'FAILED_SAFE');
    assert.deepEqual(calls, ['emergency', 'resume', 'next', 'capabilities', 'execute', 'attest', 'verify', 'persist-attempt', 'diagnose', 'failed-safe']);
    assert.equal(calls.includes('replan'), false, 'STOP must not spend on a strategy call.');
  }

  {
    const { ports } = harness('pass');
    ports.execute = async () => ({ attemptId: '   ', workerSucceeded: true });
    await assert.rejects(() => runRuntimeCycle(ports), /empty attemptId/);
  }

  {
    const { ports } = harness('pass');
    ports.verify = async () => ({ passed: true, evidence: [] });
    await assert.rejects(() => runRuntimeCycle(ports), /at least one non-empty evidence/);
  }

  console.log('PASS NEXUS runtime cycle kernel: emergency/RED-risk/fingerprint approval/capability/runtime gates precede execution/verification; YELLOW always requires approval; pass checkpoints; failure repairs/replans/stops without internal looping.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
