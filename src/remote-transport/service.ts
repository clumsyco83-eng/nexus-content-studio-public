import { createHash } from 'node:crypto';
import path from 'node:path';
import type { NexusStore } from '../storage/store.js';
import type { StoredGoalTask } from '../goals/schema.js';
import { GoalTaskApprovalRepository, fingerprintGoalTask } from '../goals/task-approvals.js';
import { EmergencyStopStore } from '../safety/emergency-stop.js';
import { PowerShellBroker } from '../powershell-broker/broker.js';
import { getPowerShellBrokerCapability, type PowerShellBrokerRequest } from '../powershell-broker/policy.js';
import type { GitHubRemoteClient, GitHubRemoteIssue } from './github-client.js';
import { parseRemoteCommandBody, validateRemoteCommandWindow, type RemoteCommand } from './schema.js';
import { RemoteTransportStateStore } from './state-store.js';

const REMOTE_GOAL_ID = 'nexus-remote-control';

type RemoteIssueOutcome = 'COMPLETED' | 'COMPLETED_RELOAD' | 'AWAITING_APPROVAL' | 'REJECTED' | 'IGNORED';

export interface GitHubRemoteTransportOptions {
  repositoryRoot: string;
  hostId: string;
  expectedIssueAuthor: string;
  commandLabel: string;
  store: NexusStore;
  client: GitHubRemoteClient;
  state?: RemoteTransportStateStore;
  emergencyStop?: EmergencyStopStore;
  broker?: PowerShellBroker;
}

function taskIdFor(commandId: string): string {
  return `remote-${createHash('sha256').update(commandId).digest('hex').slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function expectedTask(command: RemoteCommand, now: Date): StoredGoalTask {
  const capability = getPowerShellBrokerCapability(command.capability);
  const taskId = taskIdFor(command.id);
  return {
    id: taskId,
    goalId: REMOTE_GOAL_ID,
    title: `Remote ${command.capability}`,
    intent: `Execute exact remote request ${command.id} through the capability-scoped PowerShell Broker.`,
    worker: 'TOOL',
    state: 'READY',
    acceptanceCriteria: [`Broker and capability-specific deterministic checks succeed for remote request ${command.id}.`],
    verificationPlan: ['PowerShell Broker policy, one-shot lease, audit, and capability-specific deterministic checks remain authoritative.'],
    dependencies: [],
    requiredCapabilities: [command.capability],
    allowedPaths: [],
    forbiddenPaths: [],
    riskClass: capability.riskClass,
    approvalRequirement: capability.riskClass === 'YELLOW' ? 'OWNER' : 'NONE',
    idempotencyKey: `remote-${createHash('sha256').update(`v1:${command.id}`).digest('hex').slice(0, 40)}`,
    maxTurns: 1,
    maxRepairs: 0,
    timeLimitMs: command.timeoutMs,
    attempt: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function sameTaskContract(actual: StoredGoalTask, expected: StoredGoalTask): boolean {
  return fingerprintGoalTask(actual) === fingerprintGoalTask(expected);
}

function safeTail(value: string, limit = 8_000): string {
  const tail = value.slice(-limit);
  return tail
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, '[REDACTED_API_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, '$1[REDACTED]');
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function resultComment(command: RemoteCommand, result: { exitCode: number; timedOut: boolean; stdout: string; stderr: string }): string {
  const suppressOutput = command.capability === 'nexus.verification.run';
  const payload = {
    schema: 'nexus.remote.result.v1',
    requestId: command.id,
    hostId: command.hostId,
    capability: command.capability,
    status: 'COMPLETED',
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputSuppressed: suppressOutput,
    stdoutTail: suppressOutput ? '' : safeTail(result.stdout),
    stderrTail: suppressOutput ? '' : safeTail(result.stderr),
  };
  return `NEXUS_REMOTE_RESULT\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

export class GitHubIssueRemoteTransport {
  private readonly repoRoot: string;
  private readonly approvals: GoalTaskApprovalRepository;
  private readonly state: RemoteTransportStateStore;
  private readonly emergencyStop: EmergencyStopStore;
  private readonly broker: PowerShellBroker;

  constructor(private readonly options: GitHubRemoteTransportOptions) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(options.hostId)) throw new Error('Remote hostId is invalid.');
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(options.expectedIssueAuthor)) throw new Error('Expected GitHub issue author is invalid.');
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.commandLabel)) throw new Error('Remote command label is invalid.');
    this.repoRoot = path.resolve(options.repositoryRoot);
    this.approvals = new GoalTaskApprovalRepository(options.store);
    this.state = options.state ?? new RemoteTransportStateStore();
    this.emergencyStop = options.emergencyStop ?? new EmergencyStopStore();
    this.broker = options.broker ?? new PowerShellBroker({ repoRoot: this.repoRoot, store: options.store, emergencyStop: this.emergencyStop });
  }

  async pollOnce(now = new Date()): Promise<{ examined: number; completed: number; awaitingApproval: number; rejected: number }> {
    const issues = await this.options.client.listOpenCommandIssues();
    let examined = 0;
    let completed = 0;
    let awaitingApproval = 0;
    let rejected = 0;
    for (const issue of issues) {
      examined += 1;
      const outcome = await this.processIssue(issue, now);
      if (outcome === 'COMPLETED' || outcome === 'COMPLETED_RELOAD') completed += 1;
      else if (outcome === 'AWAITING_APPROVAL') awaitingApproval += 1;
      else if (outcome === 'REJECTED') rejected += 1;

      // A repository sync changes the executable code underneath this process.
      // Stop the current batch immediately so the supervisor can launch a fresh
      // one-shot worker before any later command is interpreted or executed.
      if (outcome === 'COMPLETED_RELOAD') break;
    }
    return { examined, completed, awaitingApproval, rejected };
  }

  private async processIssue(issue: GitHubRemoteIssue, now: Date): Promise<RemoteIssueOutcome> {
    if (!issue.labels.includes(this.options.commandLabel)) {
      await this.rejectIssue(issue, 'Issue does not carry the configured NEXUS remote-command label.');
      return 'REJECTED';
    }
    if (issue.authorLogin !== this.options.expectedIssueAuthor) {
      await this.rejectIssue(issue, 'Issue author is not the configured NEXUS owner.');
      return 'REJECTED';
    }
    if (!issue.body) {
      await this.rejectIssue(issue, 'Remote command body is missing.');
      return 'REJECTED';
    }

    const bodyFingerprint = sha256(issue.body);
    let command: RemoteCommand;
    try {
      command = parseRemoteCommandBody(issue.body);
      validateRemoteCommandWindow(command, now);
      if (command.hostId !== this.options.hostId) throw new Error('Remote command targets a different host.');
    } catch (error) {
      await this.rejectIssue(issue, errorMessage(error, 'Remote command validation failed.'));
      return 'REJECTED';
    }

    const byIssue = await this.state.getByIssueId(issue.id);
    const byRequest = await this.state.getByRequestId(command.id);
    if ((byIssue && byIssue.requestId !== command.id) || (byRequest && byRequest.issueId !== issue.id)) {
      await this.rejectIssue(issue, 'Remote request/issue identity was reused or changed.');
      return 'REJECTED';
    }

    let record = byRequest;
    if (!record) {
      record = {
        requestId: command.id,
        issueId: issue.id,
        issueNumber: issue.number,
        bodyFingerprint,
        state: 'RECEIVED',
        capability: command.capability,
        receivedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.state.create(record);
    }

    if (record.bodyFingerprint !== bodyFingerprint) {
      await this.failSafe(issue, command.id, 'Remote issue body changed after first receipt; approval/execution is invalidated.', now);
      return 'REJECTED';
    }
    if (record.capability !== command.capability) {
      await this.failSafe(issue, command.id, 'Capability changed after request receipt.', now);
      return 'REJECTED';
    }
    if (record.state === 'COMPLETED' || record.state === 'FAILED_SAFE') {
      await this.options.client.close(issue.number);
      return 'IGNORED';
    }
    if (record.state === 'EXECUTING') {
      await this.failSafe(issue, command.id, 'Worker restarted while request was EXECUTING; automatic replay is blocked.', now);
      return 'REJECTED';
    }

    if (await this.emergencyStop.isActive()) {
      await this.failSafe(issue, command.id, 'NEXUS emergency stop is active.', now);
      return 'REJECTED';
    }

    let task: StoredGoalTask;
    try {
      task = await this.ensureRequestTask(command, now);
    } catch (error) {
      await this.failSafe(issue, command.id, `Remote Goal-task contract rejected: ${errorMessage(error, 'unknown contract error')}`, now);
      return 'REJECTED';
    }

    const brokerRequest: PowerShellBrokerRequest = {
      id: command.id,
      goalId: REMOTE_GOAL_ID,
      taskId: task.id,
      capability: command.capability,
      args: command.args,
      cwd: this.repoRoot,
      requestedAt: command.requestedAt,
      expiresAt: command.expiresAt,
      timeoutMs: command.timeoutMs,
    };

    if (task.riskClass === 'YELLOW') {
      try {
        const approval = await this.approvals.validateForTask(task.goalId, task.id, now);
        if (!approval.approved) {
          if (approval.approval?.status === 'DENIED') {
            await this.failSafe(issue, command.id, 'Owner denied the YELLOW remote request.', now);
            return 'REJECTED';
          }
          if (approval.approval?.status === 'PENDING') {
            if (record.state !== 'AWAITING_APPROVAL') await this.state.transition(command.id, 'AWAITING_APPROVAL', { approvalId: approval.approval.id, now });
            return 'AWAITING_APPROVAL';
          }
          const remainingMs = Math.max(1_000, Math.min(15 * 60_000, Date.parse(command.expiresAt) - now.getTime()));
          const created = await this.approvals.requestForTask({
            goalId: task.goalId,
            taskId: task.id,
            requestedBy: 'github-remote-transport',
            reason: `Remote request ${command.id} asks to run ${command.capability}.`,
            ttlMs: remainingMs,
            now,
          });
          await this.state.transition(command.id, 'AWAITING_APPROVAL', { approvalId: created.id, now });
          await this.options.client.comment(issue.number, `NEXUS_REMOTE_AWAITING_OWNER_APPROVAL\n\nrequestId=${command.id}\napprovalId=${created.id}\ncapability=${command.capability}`);
          return 'AWAITING_APPROVAL';
        }
      } catch (error) {
        await this.failSafe(issue, command.id, `YELLOW approval validation failed safe: ${errorMessage(error, 'unknown approval error')}`, now);
        return 'REJECTED';
      }
    }

    let lease;
    try {
      lease = await this.broker.issueLease(brokerRequest, now);
    } catch (error) {
      await this.markTaskFailedSafe(task.id, errorMessage(error, 'Broker policy rejected remote request.'), now);
      await this.failSafe(issue, command.id, `PowerShell Broker policy rejected request: ${errorMessage(error, 'unknown broker policy error')}`, now);
      return 'REJECTED';
    }

    await this.state.transition(command.id, 'EXECUTING', { now });
    try {
      const result = await this.broker.execute(brokerRequest, lease.id, now);
      await this.markTaskCompleted(task.id, now);
      await this.state.transition(command.id, 'COMPLETED', { now });
      await this.options.client.comment(issue.number, resultComment(command, result));
      await this.options.client.close(issue.number);
      return command.capability === 'nexus.repo.sync' ? 'COMPLETED_RELOAD' : 'COMPLETED';
    } catch (error) {
      await this.markTaskFailedSafe(task.id, errorMessage(error, 'Broker execution failed safe.'), now);
      await this.failSafe(issue, command.id, errorMessage(error, 'Broker execution failed safe.'), now);
      return 'REJECTED';
    }
  }

  private async ensureRequestTask(command: RemoteCommand, now: Date): Promise<StoredGoalTask> {
    const expected = expectedTask(command, now);
    return this.options.store.update((db) => {
      let goal = db.goals.find((item) => item.id === REMOTE_GOAL_ID);
      if (!goal) {
        goal = {
          id: REMOTE_GOAL_ID,
          title: 'NEXUS Remote Control',
          objective: 'Accept authenticated, short-lived remote requests and route them only through capability-scoped NEXUS controls.',
          successCriteria: ['No remote request bypasses capability validation, owner approval, emergency stop, audit, or deterministic capability checks.'],
          priority: 100,
          budget: {},
          state: 'WORKING',
          completedTaskIds: [],
          failedAttempts: 0,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        db.goals.push(goal);
      }
      const existing = db.goalTasks.find((item) => item.id === expected.id);
      if (existing) {
        if (!sameTaskContract(existing, expected)) throw new Error(`Remote task ${existing.id} contract mismatch; refusing authority.`);
        return existing;
      }
      db.goalTasks.push(expected);
      goal.currentTaskId = expected.id;
      goal.updatedAt = now.toISOString();
      return expected;
    });
  }

  private async markTaskCompleted(taskId: string, now: Date): Promise<void> {
    await this.options.store.update((db) => {
      const task = db.goalTasks.find((item) => item.id === taskId && item.goalId === REMOTE_GOAL_ID);
      if (task) {
        task.state = 'COMPLETED';
        task.updatedAt = now.toISOString();
      }
      const goal = db.goals.find((item) => item.id === REMOTE_GOAL_ID);
      if (goal && !goal.completedTaskIds.includes(taskId)) {
        goal.completedTaskIds.push(taskId);
        goal.updatedAt = now.toISOString();
      }
    });
  }

  private async markTaskFailedSafe(taskId: string, reason: string, now: Date): Promise<void> {
    await this.options.store.update((db) => {
      const task = db.goalTasks.find((item) => item.id === taskId && item.goalId === REMOTE_GOAL_ID);
      if (task) {
        task.state = 'FAILED_SAFE';
        task.lastFailure = reason.slice(0, 2_000);
        task.updatedAt = now.toISOString();
      }
    });
  }

  private async rejectIssue(issue: GitHubRemoteIssue, reason: string): Promise<void> {
    await this.options.client.comment(issue.number, `NEXUS_REMOTE_REJECTED\n\n${safeTail(reason, 2_000)}`);
    await this.options.client.close(issue.number);
  }

  private async failSafe(issue: GitHubRemoteIssue, requestId: string, reason: string, now: Date): Promise<void> {
    const existing = await this.state.getByRequestId(requestId);
    if (existing) await this.state.transition(requestId, 'FAILED_SAFE', { failureReason: reason, now });
    await this.options.client.comment(issue.number, `NEXUS_REMOTE_FAILED_SAFE\n\nrequestId=${requestId}\nreason=${safeTail(reason, 2_000)}`);
    await this.options.client.close(issue.number);
  }
}
