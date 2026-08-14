import { JsonFileStore, type NexusStore } from './store.js';
import { SqliteStore } from './sqlite-store.js';

export type NexusStorageDriver = 'json' | 'sqlite';

export function selectedStorageDriver(env: NodeJS.ProcessEnv = process.env): NexusStorageDriver {
  const raw = (env.NEXUS_STORAGE_DRIVER ?? 'json').trim().toLowerCase();
  if (raw === 'json' || raw === 'sqlite') return raw;
  throw new Error(`Unsupported NEXUS_STORAGE_DRIVER: ${raw}. Expected "json" or "sqlite".`);
}

export function createNexusStore(env: NodeJS.ProcessEnv = process.env): NexusStore {
  const driver = selectedStorageDriver(env);
  if (driver === 'sqlite') {
    return new SqliteStore(env.NEXUS_SQLITE_DATABASE_FILE ?? 'data/nexus.db');
  }

  return new JsonFileStore(
    env.NEXUS_JSON_DATABASE_FILE ?? env.NEXUS_DATABASE_FILE ?? 'data/nexus-db.json',
  );
}
