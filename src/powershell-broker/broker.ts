import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { NexusStore } from '../storage/store.js';
import { GoalTaskApprovalRepository, fingerprintGoalTask, nextGoalTaskExecutionAttempt } from '../goals/task-approvals.js';
import { EmergencyStopStore } from '../safety/emergency-stop.js';
import { PowerShellBrokerLeaseStore, type PowerShellBrokerLease } from './lease-store.js';
import {
  buildPowerShellInvocation,
  fingerprintPowerShellBrokerRequest,
  validatePowerShellBrokerRequest,
  type PowerShellBrokerRequest,
} from './policy.js';
import { NodePowerShellBrokerRunner, type PowerShellBrokerRunner, type PowerShellRunnerResult } from './runner.js';

export interface PowerShellBrokerExecutionResult extends PowerShellRunnerResult {
  leaseId: string;
  requestId: string;
  transportSucceeded: boolean;
}

export interface PowerShellBrokerOptions {
  repoRoot: string;
  store: NexusStore;
  emergencyStop?: EmergencyStopStore;
  leases?: PowerShellBrokerLeaseStore;
  runner?: PowerShellBrokerRunner;
  auditFile?: string;
}

interface Authorization {
  authorizationFingerprint: string;
  requiresOwnerApproval: boolean;
}

export class PowerShellBroker {
  private readonly approvals: GoalTaskApprovalRepository;
  private readonly emergencyStop: EmergencyStopStore;
  private readonly leases: PowerShellBrokerLeaseStore;
  private readonly runner: PowerShellBrokerRunner;
  private readonly repoRoot: string;
  private readonly auditFile: string;

  constructor(private readonly options: PowerShellBrokerOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.approvals = new GoalTaskApprovalRepository(options.store);
    this.emergencyStop = options.emergencyStop ?? new EmergencyStopStore();
    this.leases = options.leases ?? new PowerShellBrokerLeaseStore();
    this.runner = options.runner ?? new NodePowerShellBrokerRunner();
    this.auditFile = path.resolve(options.auditFile ?? process.env.NEXUS_POWERSHELL_BROKER_AUDIT_FILE ?? 'data/powershell-broker-audit.jsonl');
  }

  async issueLease(request: PowerShellBrokerRequest, now = new Date()): Promise<PowerShellBrokerLease> {
    const authorization = await this.authorize(request, now);
    const requestExpiry = Date.parse(request.expiresAt);
    const expiresAt = new Date(Math.min(requestExpiry, now.getTime() + 5 * 60 * 1_000)).toISOString();
    await this.audit('LEASE_REQUEST_ACCEPTED', request, { requiresOwnerApproval: authorization.requiresOwnerApproval }, now);
    const lease = await this.leases.issue({
      requestId: request.id,
      requestFingerprint: authorization.authorizationFingerprint,
      goalId: request.goalId,
      taskId: request.taskId,
      capability: request.capability,
      issuedAt: now.toISOString(),
      expiresAt,
    });
    await this.audit('LEASE_ISSUED', request, { leaseId: lease.id, expiresAt: lease.expiresAt }, now);
    return lease;
  }

  async execute(request: PowerShellBrokerRequest, leaseId: string, now = new Date()): Promise<PowerShellBrokerExecutionResult> {
    const authorization = await this.authorize(request, now);
    const invocation = buildPowerShellInvocation(request, this.repoRoot, now);
    await this.audit('EXECUTION_START', request, { leaseId, file: invocation.file, argvCount: invocation.args.length }, now);
    await this.leases.consume(leaseId, authorization.authorizationFingerprint, now);

    // Close the most important TOCTOU window: if the owner/Guardian emergency stop
    // becomes active after authorization but before process creation, consume the
    // one-shot lease and fail closed rather than spawning with stale authority.
    if (await this.emergencyStop.isActive()) {
      await this.audit('EXECUTION_BLOCKED', request, { leaseId, reason: 'emergency-stop-before-spawn' }, new Date());
      throw new Error('NEXUS emergency stop became active before PowerShell Broker process launch; execution is blocked.');
    }

    const result = await this.runner.run(invocation);
    const transportSucceeded = !result.timedOut && result.exitCode === 0;
    await this.audit('EXECUTION_FINISH', request, {
      leaseId,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      transportSucceeded,
      stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
    }, new Date());

    if (!transportSucceeded) {
      throw new Error(`PowerShell Broker execution failed safe (exitCode=${result.exitCode}, timedOut=${result.timedOut}).`);
    }
    return { ...result, leaseId, requestId: request.id, transportSucceeded };
  }

  private async authorize(request: PowerShellBrokerRequest, now: Date): Promise<Authorization> {
    const capability = validatePowerShellBrokerRequest(request, this.repoRoot, now);
    if (await this.emergencyStop.isActive()) throw new Error('NEXUS emergency stop is active; PowerShell Broker execution is blocked.');

    const db = await this.options.store.load();
    const task = db.goalTasks.find((item) => item.goalId === request.goalId && item.id === request.taskId);
    if (!task) throw new Error(`Unknown broker goal task ${request.taskId} for goal ${request.goalId}.`);
    if (task.riskClass === 'RED') throw new Error('RED goal tasks are non-executable through the PowerShell Broker.');
    if (!task.requiredCapabilities.includes(request.capability)) {
      throw new Error(`Goal task ${task.id} does not declare required capability ${request.capability}.`);
    }

    const requiresOwnerApproval = capability.riskClass === 'YELLOW' || task.riskClass === 'YELLOW' || task.approvalRequirement === 'OWNER';
    if (capability.riskClass === 'YELLOW' && (task.riskClass !== 'YELLOW' || task.approvalRequirement !== 'OWNER')) {
      throw new Error('YELLOW PowerShell capability requires a YELLOW goal task with OWNER approval requirement.');
    }
    if (requiresOwnerApproval) {
      const approval = await this.approvals.validateForTask(request.goalId, request.taskId, now);
      if (!approval.approved) throw new Error(`Owner approval required: ${approval.reason ?? 'approval unavailable'}`);
    }

    const taskFingerprint = fingerprintGoalTask(task, nextGoalTaskExecutionAttempt(task));
    const requestFingerprint = fingerprintPowerShellBrokerRequest(request);
    const authorizationFingerprint = createHash('sha256').update(`${requestFingerprint}:${taskFingerprint}`).digest('hex');
    return { authorizationFingerprint, requiresOwnerApproval };
  }

  private async audit(event: string, request: PowerShellBrokerRequest, detail: Record<string, unknown>, now: Date): Promise<void> {
    const entry = {
      at: now.toISOString(),
      event,
      requestId: request.id,
      goalId: request.goalId,
      taskId: request.taskId,
      capability: request.capability,
      requestFingerprint: fingerprintPowerShellBrokerRequest(request),
      detail,
    };
    await mkdir(path.dirname(this.auditFile), { recursive: true });
    await appendFile(this.auditFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
