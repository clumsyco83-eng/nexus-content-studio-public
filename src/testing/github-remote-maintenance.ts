import assert from 'node:assert/strict';
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
    return { exitCode: 0, stdout: '{"ok":true}', stderr: '', timedOut: false };
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

function commandBody(input: { id: string; capability: string; args?: Record<string, string>; now: Date }): string {
  return JSON.stringify({
    schema: 'nexus.remote.command.v1',
    id: input.id,
    hostId: 'test-host',
    capability: input.capability,
    args: input.args ?? {},
    requestedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 10 * 60_000).toISOString(),
    timeoutMs: 90_000,
  });
}

function issue(number: number, body: string): GitHubRemoteIssue {
  return {
    id: 20_000 + number,
    number,
    title: `maintenance-${number}`,
    body,
    htmlUrl: `https://example.invalid/issues/${number}`,
    authorLogin: 'owner-login',
    labels: ['nexus-remote-command'],
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-remote-maintenance-'));
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

    client.issues = [issue(1, commandBody({ id: 'service-status-001', capability: 'nexus.service.status', now }))];
    let outcome = await transport.pollOnce(now);
    assert.equal(outcome.completed, 1);
    assert.equal(runner.invocations.length, 1);
    assert.equal(runner.invocations[0]?.args.includes('nexus.service.status'), true);

    client.issues = [issue(2, commandBody({ id: 'repo-status-001', capability: 'nexus.repo.status', now }))];
    outcome = await transport.pollOnce(new Date(now.getTime() + 500));
    assert.equal(outcome.completed, 1);
    assert.equal(runner.invocations.length, 2);
    assert.equal(runner.invocations[1]?.args.includes('nexus.repo.status'), true);

    client.issues = [issue(3, commandBody({ id: 'repo-sync-bad-001', capability: 'nexus.repo.sync', args: { expectedHead: 'main' }, now }))];
    outcome = await transport.pollOnce(new Date(now.getTime() + 1_000));
    assert.equal(outcome.awaitingApproval, 1, 'YELLOW request must stop at owner approval before broker validation/execution.');
    const approvals = new GoalTaskApprovalRepository(store);
    let pending = (await approvals.listPending()).find((item) => item.reason.includes('repo-sync-bad-001'));
    assert.ok(pending);
    await approvals.resolve({ approvalId: pending.id, decision: 'APPROVED', resolvedBy: 'test-owner', now: new Date(now.getTime() + 1_500) });
    outcome = await transport.pollOnce(new Date(now.getTime() + 2_000));
    assert.equal(outcome.rejected, 1);
    assert.equal(runner.invocations.length, 2, 'Invalid expectedHead must never reach PowerShell execution.');

    const expectedHead = 'b'.repeat(40);
    const syncIssue = issue(4, commandBody({ id: 'repo-sync-001', capability: 'nexus.repo.sync', args: { expectedHead }, now }));
    client.issues = [syncIssue];
    outcome = await transport.pollOnce(new Date(now.getTime() + 2_500));
    assert.equal(outcome.awaitingApproval, 1);
    pending = (await approvals.listPending()).find((item) => item.reason.includes('repo-sync-001'));
    assert.ok(pending);
    await approvals.resolve({ approvalId: pending.id, decision: 'APPROVED', resolvedBy: 'test-owner', now: new Date(now.getTime() + 3_000) });

    const deferredStatus = issue(40, commandBody({ id: 'repo-status-after-sync-001', capability: 'nexus.repo.status', now }));
    client.issues = [syncIssue, deferredStatus];
    outcome = await transport.pollOnce(new Date(now.getTime() + 3_500));
    assert.equal(outcome.completed, 1);
    assert.equal(outcome.examined, 1, 'A successful repo sync must stop the current batch so later issues wait for a fresh worker process.');
    assert.equal(client.closed.includes(syncIssue.number), true);
    assert.equal(client.closed.includes(deferredStatus.number), false, 'Later commands must remain untouched until the supervisor launches a fresh worker.');
    assert.equal(runner.invocations.length, 3);
    const syncInvocation = runner.invocations[2];
    const headIndex = syncInvocation?.args.indexOf('-ExpectedHead') ?? -1;
    assert.ok(headIndex >= 0);
    assert.equal(syncInvocation?.args[headIndex + 1], expectedHead);

    client.issues = [issue(5, commandBody({ id: 'service-start-001', capability: 'nexus.service.start', now }))];
    outcome = await transport.pollOnce(new Date(now.getTime() + 4_000));
    assert.equal(outcome.awaitingApproval, 1);
    assert.equal(runner.invocations.length, 3, 'Service start must not execute without explicit owner approval.');

    console.log('PASS GitHub remote maintenance v2: GREEN status actions, YELLOW owner-gated service start/repo sync, full-SHA binding, broker-only execution, invalid sync rejection, and repo-sync reload barrier.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
