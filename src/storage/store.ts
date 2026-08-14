import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredCapability } from '../capabilities/schema.js';
import type { StoredGoalAttemptObservation } from '../goals/attempt-observations.js';
import type { StoredGoal, StoredGoalCheckpoint, StoredGoalTask, StoredGoalTaskApproval } from '../goals/schema.js';
import type {
  StoredAnalyticsSnapshot,
  StoredApproval,
  StoredArtifact,
  StoredCostEvent,
  StoredExperiment,
  StoredJob,
  StoredLesson,
  StoredPublishRecord,
} from './schema.js';

export interface NexusDatabase {
  jobs: StoredJob[];
  artifacts: StoredArtifact[];
  approvals: StoredApproval[];
  publishRecords: StoredPublishRecord[];
  analytics: StoredAnalyticsSnapshot[];
  costs: StoredCostEvent[];
  experiments: StoredExperiment[];
  lessons: StoredLesson[];
  goals: StoredGoal[];
  goalTasks: StoredGoalTask[];
  goalTaskApprovals: StoredGoalTaskApproval[];
  goalCheckpoints: StoredGoalCheckpoint[];
  goalAttemptObservations: StoredGoalAttemptObservation[];
  capabilities: StoredCapability[];
}

export interface StoreDescription {
  driver: 'json' | 'sqlite';
  location: string;
}

export interface NexusStore {
  load(): Promise<NexusDatabase>;
  save(database: NexusDatabase): Promise<void>;
  update<T>(mutator: (database: NexusDatabase) => T): Promise<T>;
  describe(): StoreDescription;
}

export const emptyDatabase = (): NexusDatabase => ({
  jobs: [],
  artifacts: [],
  approvals: [],
  publishRecords: [],
  analytics: [],
  costs: [],
  experiments: [],
  lessons: [],
  goals: [],
  goalTasks: [],
  goalTaskApprovals: [],
  goalCheckpoints: [],
  goalAttemptObservations: [],
  capabilities: [],
});

export class JsonFileStore implements NexusStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = 'data/nexus-db.json') {}

  describe(): StoreDescription {
    return { driver: 'json', location: path.resolve(this.filePath) };
  }

  async load(): Promise<NexusDatabase> {
    return this.loadUnlocked();
  }

  async save(database: NexusDatabase): Promise<void> {
    await this.enqueue(async () => this.saveUnlocked(database));
  }

  async update<T>(mutator: (database: NexusDatabase) => T): Promise<T> {
    return this.enqueue(async () => {
      const database = await this.loadUnlocked();
      const result = mutator(database);
      await this.saveUnlocked(database);
      return result;
    });
  }

  private async loadUnlocked(): Promise<NexusDatabase> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<NexusDatabase>;
      return { ...emptyDatabase(), ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDatabase();
      throw error;
    }
  }

  private async saveUnlocked(database: NexusDatabase): Promise<void> {
    const absolute = path.resolve(this.filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.tmp`;
    await writeFile(temp, JSON.stringify(database, null, 2), 'utf8');
    await rename(temp, absolute);
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
