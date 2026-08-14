import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore, emptyDatabase } from '../storage/store.js';
import { GoalTaskApprovalRepository } from '../goals/task-approvals.js';
import { EmergencyStopStore } from '../safety/emergency-stop.js';
import { PowerShellBroker } from '../powershell-broker/broker.js';
import { PowerShellBrokerLeaseStore } from '../powershell-broker/lease-store.js';
import type { PowerShellBrokerRunner, PowerShellRunnerResult } from '../powershell-broker/runner.js';
import type { PowerShellInvocation } from '../powershell-broker/policy.js';
import type { GitHubRemoteClient, GitHubRemoteIssue } from '../remote-transport/github-client.js';
import { GitHubIssueRemoteTransport } from '../remote-transport/service.js';
import { RemoteTransportStateStore } from '../remote-transport/state-store.js';

class MockRunner implements PowerShellBrokerRunner {
  invocations: PowerShellInvocation[] = [];
  async run(invocation: PowerShellInvocation): Promise<PowerShellRunnerResult> {
    this.invocations.push(invocation);
    return { exitCode: 0, stdout: '{"ok":true,"token":"never-a-real-secret"}', stderr: '', timedOut: false };
  }
}

class MockGitHubClient implements GitHubRemoteClient {
  issues: GitHubRemoteIssue[] = [];
  comments: Array<{ issueNumber: number; body: string }> = [];
  closed: number[] = [];
  async listOpenCommandIssues(): Promise<GitHubRemoteIssue[]> { return this.issues.filter((issue) => !this.closed.includes(issue.number)); }
  async comment(issueNumber: number, body: string): Promise<void> { this.comments.push({ issueNumber, body }); }
  async close(issueNumber: number): Promise<void> { if (!this.closed.includes(issueNumber)) this.closed.push(issueNumber); }
}

function commandBody(input: { id: string; hostId?: string; capability: string; args?: Record<string, string>; now: Date }): string {
  return JSON.stringify({
    schema: 'nexus.remote.command.v1',
    id: input.id,
    hostId: input.hostId ?? 'test-host',
    capability: input.capability,
    args: input.args ?? {},
    requestedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 10 * 60_000).toISOString(),
    timeoutMs: 30_000,
  });
}

function bodyFingerprint(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function issue(number: number, authorLogin: string, body: string, labels = ['nexus-remote-command']): GitHubRemoteIssue {
  return { id: 10_000 + number, number, title: `remote-${number}`, body, htmlUrl: `https://example.invalid/issues/${number}`, authorLogin, labels };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-remote-transport-'));
  const repoRoot = path.join(root, 'repo');
  const now = new Date();
  try {
    const store = new JsonFileStore(path.join(root, 'nexus.json'));
    await store.save(emptyDatabase());
    const emergency = new EmergencyStopStore(path.join(root, 'emergency.json'));
    const runner = new MockRunner();
    const broker = new PowerShellBroker({
      repoRoot,
      store,
      emergencyStop: emergency,
      leases: new PowerShellBrokerLeaseStore(path.join(root, 'leases.json')),
      runner,
      auditFile: path.join(root, 'broker-audit.jsonl'),
    });
    const client = new MockGitHubClient();
    const state = new RemoteTransportStateStore(path.join(root, 'remote-state.json'));
    const transport = new GitHubIssueRemoteTransport({
      repositoryRoot: repoRoot,
      hostId: 'test-host',
      expectedIssueAuthor: 'owner-login',
      commandLabel: 'nexus-remote-command',
      store,
      client,
      state,
      emergencyStop: emergency,
      broker,
    });

    client.issues = [issue(1, 'owner-login', commandBody({ id: 'green-request-001', capability: 'system.process.inspect', args: { processName: 'node' }, now }))];
    let outcome = await transport.pollOnce(now);
    assert.equal(outcome.completed, 1);
    assert.equal(runner.invocations.length, 1);
    assert.equal(client.closed.includes(1), true);
    assert.match(client.comments.find((item) => item.issueNumber === 1)?.body ?? '', /NEXUS_REMOTE_RESULT/);
    assert.equal((await state.getByRequestId('green-request-001'))?.state, 'COMPLETED');

    client.issues = [issue(2, 'attacker-login', commandBody({ id: 'unauthorized-001', capability: 'system.process.inspect', args: { processName: 'node' }, now }))];
    outcome = await transport.pollOnce(now);
    assert.equal(outcome.rejected, 1);
    assert.equal(runner.invocations.length, 1, 'Unauthorized GitHub author must never reach broker execution.');

    client.issues = [issue(3, 'owner-login', commandBody({ id: 'wrong-host-001', hostId: 'other-host', capability: 'nexus.health.check', args: { url: 'http://127.0.0.1:8787/api/health' }, now }))];
    outcome = await transport.pollOnce(now);
    assert.equal(outcome.rejected, 1);
    assert.equal(runner.invocations.length, 1);

    client.issues = [issue(4, 'owner-login', commandBody({ id: 'missing-label-001', capability: 'system.process.inspect', args: { processName: 'node' }, now }), [])];
    outcome = await transport.pollOnce(now);
    assert.equal(outcome.rejected, 1);
    assert.equal(runner.invocations.length, 1, 'An issue without the configured command label must not execute.');

    const mutableYellowBody = commandBody({ id: 'yellow-mutation-001', capability: 'nexus.verification.run', now });
    client.issues = [issue(5, 'owner-login', mutableYellowBody)];
    outcome = await transport.pollOnce(now);
    assert.equal(outcome.awaitingApproval, 1);
    const approvals = new GoalTaskApprovalRepository(store);
    let pending = (await approvals.listPending()).find((item) => item.reason.includes('yellow-mutation-001'));
    assert.ok(pending, 'YELLOW request must create a durable owner approval request.');
    await approvals.resolve({ approvalId: pending.id, decision: 'APPROVED', resolvedBy: 'test-owner', now: new Date(now.getTime() + 1_000) });
    client.issues[0] = issue(5, 'owner-login', `${mutableYellowBody} `);
    outcome = await transport.pollOnce(new Date(now.getTime() + 2_000));
    assert.equal(outcome.rejected, 1);
    assert.equal(runner.invocations.length, 1, 'Editing an issue body after approval request must invalidate execution.');
    assert.equal((await state.getByRequestId('yellow-mutation-001'))?.state, 'FAILED_SAFE');

    client.issues = [issue(6, 'owner-login', commandBody({ id: 'yellow-request-001', capability: 'nexus.verification.run', now }))];
    outcome = await transport.pollOnce(now);
    assert.equal(outcome.awaitingApproval, 1);
    assert.equal(runner.invocations.length, 1, 'YELLOW request must stop before execution without owner approval.');
    pending = (await approvals.listPending()).find((item) => item.reason.includes('yellow-request-001'));
    assert.ok(pending, 'YELLOW remote request must create a durable owner approval request.');
    await approvals.resolve({ approvalId: pending.id, decision: 'APPROVED', resolvedBy: 'test-owner', now: new Date(now.getTime() + 1_000) });
    outcome = await transport.pollOnce(new Date(now.getTime() + 2_000));
    assert.equal(outcome.completed, 1);
    assert.equal(runner.invocations.length, 2);
    assert.equal(client.closed.includes(6), true);
    const yellowResult = client.comments.find((item) => item.issueNumber === 6 && item.body.includes('NEXUS_REMOTE_RESULT'))?.body ?? '';
    assert.match(yellowResult, /"outputSuppressed": true/);
    assert.doesNotMatch(yellowResult, /never-a-real-secret/);

    const recoveryBody = commandBody({ id: 'recovery-block-001', capability: 'system.process.inspect', args: { processName: 'node' }, now });
    client.issues = [issue(7, 'owner-login', recoveryBody)];
    await state.create({
      requestId: 'recovery-block-001', issueId: 10_007, issueNumber: 7, bodyFingerprint: bodyFingerprint(recoveryBody), state: 'EXECUTING', capability: 'system.process.inspect', receivedAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    outcome = await transport.pollOnce(new Date(now.getTime() + 3_000));
    assert.equal(outcome.rejected, 1);
    assert.equal(runner.invocations.length, 2, 'Uncertain prior EXECUTING state must fail closed instead of replaying.');
    assert.equal((await state.getByRequestId('recovery-block-001'))?.state, 'FAILED_SAFE');

    await emergency.activate('test-owner', 'remote transport emergency-stop regression', now);
    client.issues = [issue(8, 'owner-login', commandBody({ id: 'stopped-request-001', capability: 'system.process.inspect', args: { processName: 'node' }, now }))];
    outcome = await transport.pollOnce(new Date(now.getTime() + 4_000));
    assert.equal(outcome.rejected, 1);
    assert.equal(runner.invocations.length, 2, 'Emergency stop must block remote execution.');

    console.log('PASS GitHub remote transport v1: owner+label binding, strict host/TTL schema, immutable issue body, full task fingerprint binding, broker-only execution, YELLOW owner approval with output suppression, durable at-most-once fail-safe recovery, emergency stop, and no unauthorized replay.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
