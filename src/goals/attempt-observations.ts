import { randomUUID } from 'node:crypto';
import type { NexusStore } from '../storage/store.js';
import type { AttemptObservation } from './stuck-detector.js';

const sha256Pattern = /^[a-f0-9]{64}$/i;

export interface StoredGoalAttemptObservation extends AttemptObservation {
  id: string;
  goalId: string;
  taskId: string;
  createdAt: string;
}

export interface RecordGoalAttemptObservation extends AttemptObservation {
  goalId: string;
  taskId: string;
}

function assertFiniteNonNegative(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number.`);
}

function canonicalObservation(input: RecordGoalAttemptObservation): string {
  return JSON.stringify({
    goalId: input.goalId,
    taskId: input.taskId,
    attemptNumber: input.attemptNumber,
    strategyFingerprint: input.strategyFingerprint,
    failureFingerprint: input.failureFingerprint,
    verificationScore: input.verificationScore,
    changedPaths: [...(input.changedPaths ?? [])].sort(),
    tokensUsed: input.tokensUsed,
    costUsd: input.costUsd,
    elapsedMs: input.elapsedMs,
    toolEnvelopeHash: input.toolEnvelopeHash?.toLowerCase(),
    skillSetHash: input.skillSetHash?.toLowerCase(),
  });
}

export class GoalAttemptObservationRepository {
  constructor(private readonly store: NexusStore) {}

  async record(input: RecordGoalAttemptObservation): Promise<StoredGoalAttemptObservation> {
    if (!input.goalId.trim()) throw new Error('goalId is required.');
    if (!input.taskId.trim()) throw new Error('taskId is required.');
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) throw new Error('attemptNumber must be a positive integer.');
    if (!input.strategyFingerprint.trim()) throw new Error('strategyFingerprint is required.');
    if (input.failureFingerprint !== undefined && !input.failureFingerprint.trim()) throw new Error('failureFingerprint cannot be blank.');
    if (input.verificationScore !== undefined && (!Number.isFinite(input.verificationScore) || input.verificationScore < 0 || input.verificationScore > 1)) {
      throw new Error('verificationScore must be between 0 and 1.');
    }
    if (input.toolEnvelopeHash !== undefined && !sha256Pattern.test(input.toolEnvelopeHash)) {
      throw new Error('toolEnvelopeHash must be a 64-character SHA-256 digest when present.');
    }
    if (input.skillSetHash !== undefined && !sha256Pattern.test(input.skillSetHash)) {
      throw new Error('skillSetHash must be a 64-character SHA-256 digest when present.');
    }
    assertFiniteNonNegative('tokensUsed', input.tokensUsed);
    assertFiniteNonNegative('costUsd', input.costUsd);
    assertFiniteNonNegative('elapsedMs', input.elapsedMs);

    const normalizedInput: RecordGoalAttemptObservation = {
      ...input,
      toolEnvelopeHash: input.toolEnvelopeHash?.toLowerCase(),
      skillSetHash: input.skillSetHash?.toLowerCase(),
    };

    return this.store.update((db) => {
      const goal = db.goals.find((item) => item.id === normalizedInput.goalId);
      if (!goal) throw new Error(`Unknown goal: ${normalizedInput.goalId}`);
      const task = db.goalTasks.find((item) => item.id === normalizedInput.taskId && item.goalId === normalizedInput.goalId);
      if (!task) throw new Error(`Unknown task for goal ${normalizedInput.goalId}: ${normalizedInput.taskId}`);
      if (normalizedInput.attemptNumber > task.maxRepairs + 1) {
        throw new Error(`Attempt ${normalizedInput.attemptNumber} exceeds task repair contract (${task.maxRepairs + 1} total attempts).`);
      }

      const existing = db.goalAttemptObservations.find((item) =>
        item.goalId === normalizedInput.goalId && item.taskId === normalizedInput.taskId && item.attemptNumber === normalizedInput.attemptNumber,
      );
      if (existing) {
        const existingCanonical = canonicalObservation(existing);
        const nextCanonical = canonicalObservation(normalizedInput);
        if (existingCanonical !== nextCanonical) {
          throw new Error(`Attempt observation conflict for ${normalizedInput.taskId} attempt ${normalizedInput.attemptNumber}.`);
        }
        return existing;
      }

      const observation: StoredGoalAttemptObservation = {
        ...normalizedInput,
        changedPaths: normalizedInput.changedPaths?.slice(),
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      db.goalAttemptObservations.push(observation);
      return observation;
    });
  }

  async listForTask(goalId: string, taskId: string): Promise<StoredGoalAttemptObservation[]> {
    const db = await this.store.load();
    return db.goalAttemptObservations
      .filter((item) => item.goalId === goalId && item.taskId === taskId)
      .slice()
      .sort((a, b) => a.attemptNumber - b.attemptNumber || a.createdAt.localeCompare(b.createdAt));
  }
}
