import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface EmergencyStopState {
  active: boolean;
  activatedAt?: string;
  activatedBy?: string;
  reason?: string;
  clearedAt?: string;
  clearedBy?: string;
}

const INACTIVE_STATE: EmergencyStopState = { active: false };

/**
 * NEXUS-wide emergency stop. The state is intentionally outside worker/model
 * ownership. Missing state means no stop has ever been activated; unreadable or
 * malformed state fails closed as ACTIVE until the owner explicitly repairs it.
 */
export class EmergencyStopStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = process.env.NEXUS_EMERGENCY_STOP_FILE ?? 'data/emergency-stop.json') {}

  describe(): string {
    return path.resolve(this.filePath);
  }

  async getState(): Promise<EmergencyStopState> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<EmergencyStopState>;
      if (!parsed || typeof parsed.active !== 'boolean') {
        return this.corruptState('Emergency-stop state file is malformed.');
      }
      return {
        active: parsed.active,
        activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : undefined,
        activatedBy: typeof parsed.activatedBy === 'string' ? parsed.activatedBy : undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        clearedAt: typeof parsed.clearedAt === 'string' ? parsed.clearedAt : undefined,
        clearedBy: typeof parsed.clearedBy === 'string' ? parsed.clearedBy : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...INACTIVE_STATE };
      return this.corruptState(`Emergency-stop state could not be read (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  async isActive(): Promise<boolean> {
    return (await this.getState()).active;
  }

  async activate(activatedBy: string, reason: string, now = new Date()): Promise<EmergencyStopState> {
    const actor = activatedBy.trim();
    const why = reason.trim();
    if (!actor) throw new Error('activatedBy is required to activate the emergency stop.');
    if (!why) throw new Error('reason is required to activate the emergency stop.');
    if (!Number.isFinite(now.getTime())) throw new Error('Emergency-stop activation time must be valid.');
    const state: EmergencyStopState = {
      active: true,
      activatedAt: now.toISOString(),
      activatedBy: actor,
      reason: why.slice(0, 2_000),
    };
    return this.enqueue(async () => {
      await this.saveUnlocked(state);
      return state;
    });
  }

  /**
   * Clearing is deliberately an explicit owner/operator action. Workers and
   * models must never call this as part of repair, retry, or replanning.
   */
  async clear(clearedBy: string, now = new Date()): Promise<EmergencyStopState> {
    const actor = clearedBy.trim();
    if (!actor) throw new Error('clearedBy is required to clear the emergency stop.');
    if (!Number.isFinite(now.getTime())) throw new Error('Emergency-stop clear time must be valid.');
    return this.enqueue(async () => {
      const current = await this.getState();
      const state: EmergencyStopState = {
        ...current,
        active: false,
        clearedAt: now.toISOString(),
        clearedBy: actor,
      };
      await this.saveUnlocked(state);
      return state;
    });
  }

  private corruptState(reason: string): EmergencyStopState {
    return { active: true, reason };
  }

  private async saveUnlocked(state: EmergencyStopState): Promise<void> {
    const absolute = path.resolve(this.filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await rename(temp, absolute);
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
