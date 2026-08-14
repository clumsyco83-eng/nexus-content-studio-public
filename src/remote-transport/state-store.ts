import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RemoteTransportState = 'RECEIVED' | 'AWAITING_APPROVAL' | 'EXECUTING' | 'COMPLETED' | 'FAILED_SAFE';

export interface RemoteTransportRecord {
  requestId: string;
  issueId: number;
  issueNumber: number;
  bodyFingerprint: string;
  state: RemoteTransportState;
  capability: string;
  receivedAt: string;
  updatedAt: string;
  approvalId?: string;
  failureReason?: string;
}

interface RemoteTransportLedger {
  version: 1;
  records: RemoteTransportRecord[];
}

function emptyLedger(): RemoteTransportLedger {
  return { version: 1, records: [] };
}

function validateLedger(value: unknown): RemoteTransportLedger {
  if (!value || typeof value !== 'object') throw new Error('Remote transport ledger is malformed.');
  const candidate = value as Partial<RemoteTransportLedger>;
  if (candidate.version !== 1 || !Array.isArray(candidate.records)) throw new Error('Remote transport ledger version/records are invalid.');
  for (const record of candidate.records) {
    if (!record || typeof record !== 'object') throw new Error('Remote transport ledger contains an invalid record.');
    const item = record as Partial<RemoteTransportRecord>;
    if (typeof item.requestId !== 'string' || !Number.isInteger(item.issueId) || !Number.isInteger(item.issueNumber)) {
      throw new Error('Remote transport ledger record identity is invalid.');
    }
    if (typeof item.bodyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.bodyFingerprint)) {
      throw new Error('Remote transport ledger body fingerprint is invalid.');
    }
    if (!['RECEIVED', 'AWAITING_APPROVAL', 'EXECUTING', 'COMPLETED', 'FAILED_SAFE'].includes(String(item.state))) {
      throw new Error('Remote transport ledger record state is invalid.');
    }
    if (typeof item.capability !== 'string' || typeof item.receivedAt !== 'string' || typeof item.updatedAt !== 'string') {
      throw new Error('Remote transport ledger record metadata is invalid.');
    }
  }
  return candidate as RemoteTransportLedger;
}

export class RemoteTransportStateStore {
  constructor(private readonly filePath = path.resolve(process.env.NEXUS_REMOTE_GITHUB_STATE_FILE ?? 'data/remote-github-state.json')) {}

  async getByRequestId(requestId: string): Promise<RemoteTransportRecord | undefined> {
    const ledger = await this.load();
    return ledger.records.find((record) => record.requestId === requestId);
  }

  async getByIssueId(issueId: number): Promise<RemoteTransportRecord | undefined> {
    const ledger = await this.load();
    return ledger.records.find((record) => record.issueId === issueId);
  }

  async create(record: RemoteTransportRecord): Promise<void> {
    const ledger = await this.load();
    if (ledger.records.some((item) => item.requestId === record.requestId)) throw new Error(`Remote request ${record.requestId} already exists.`);
    if (ledger.records.some((item) => item.issueId === record.issueId)) throw new Error(`Remote issue ${record.issueId} already exists.`);
    ledger.records.push({ ...record });
    await this.save(ledger);
  }

  async transition(requestId: string, state: RemoteTransportState, input: { approvalId?: string; failureReason?: string; now?: Date } = {}): Promise<RemoteTransportRecord> {
    const ledger = await this.load();
    const record = ledger.records.find((item) => item.requestId === requestId);
    if (!record) throw new Error(`Unknown remote request ${requestId}.`);
    record.state = state;
    record.updatedAt = (input.now ?? new Date()).toISOString();
    if (input.approvalId !== undefined) record.approvalId = input.approvalId;
    if (input.failureReason !== undefined) record.failureReason = input.failureReason.slice(0, 2_000);
    await this.save(ledger);
    return { ...record };
  }

  private async load(): Promise<RemoteTransportLedger> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return validateLedger(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
      throw error;
    }
  }

  private async save(ledger: RemoteTransportLedger): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
