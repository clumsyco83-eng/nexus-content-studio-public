import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { emptyDatabase, type NexusDatabase, type NexusStore, type StoreDescription } from './store.js';

type StatementSyncLike = {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
};

type DatabaseSyncLike = {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
};

type DatabaseSyncConstructor = new (location: string) => DatabaseSyncLike;

const require = createRequire(import.meta.url);

function loadDatabaseSync(): DatabaseSyncConstructor {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync?: DatabaseSyncConstructor };
    if (!sqlite.DatabaseSync) throw new Error('DatabaseSync export is unavailable');
    return sqlite.DatabaseSync;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite mode requires a Node.js runtime with node:sqlite available (Node 22.13+ recommended). ` +
      `Current runtime: ${process.version}. Original error: ${detail}`,
    );
  }
}

function normalizeDatabase(value: unknown): NexusDatabase {
  if (!value || typeof value !== 'object') return emptyDatabase();
  return { ...emptyDatabase(), ...(value as Partial<NexusDatabase>) };
}

export class SqliteStore implements NexusStore {
  private readonly databasePath: string;
  private readonly db: DatabaseSyncLike;

  constructor(filePath = 'data/nexus.db') {
    this.databasePath = path.resolve(filePath);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });

    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nexus_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db
      .prepare('INSERT OR IGNORE INTO nexus_state (id, payload, updated_at) VALUES (1, ?, ?)')
      .run(JSON.stringify(emptyDatabase()), new Date().toISOString());
  }

  describe(): StoreDescription {
    return { driver: 'sqlite', location: this.databasePath };
  }

  async load(): Promise<NexusDatabase> {
    return this.readCurrent();
  }

  async save(database: NexusDatabase): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.writeCurrent(database);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.rollbackQuietly();
      throw error;
    }
  }

  async update<T>(mutator: (database: NexusDatabase) => T): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const database = this.readCurrent();
      const result = mutator(database);
      this.writeCurrent(database);
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.rollbackQuietly();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private readCurrent(): NexusDatabase {
    const row = this.db.prepare('SELECT payload FROM nexus_state WHERE id = 1').get();
    if (!row || typeof row.payload !== 'string') return emptyDatabase();
    return normalizeDatabase(JSON.parse(row.payload));
  }

  private writeCurrent(database: NexusDatabase): void {
    this.db
      .prepare('UPDATE nexus_state SET payload = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(database), new Date().toISOString());
  }

  private rollbackQuietly(): void {
    try {
      this.db.exec('ROLLBACK;');
    } catch {
      // Preserve the original error if rollback itself is unnecessary or fails.
    }
  }
}
