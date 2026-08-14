import 'dotenv/config';
import path from 'node:path';
import { JsonFileStore } from './store.js';
import { SqliteStore } from './sqlite-store.js';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const source = process.env.NEXUS_SQLITE_DATABASE_FILE ?? 'data/nexus.db';
  const output = process.env.NEXUS_JSON_EXPORT_FILE ?? `data/nexus-db-export-${stamp()}.json`;

  const sqlite = new SqliteStore(source);
  const database = await sqlite.load();
  sqlite.close();

  const json = new JsonFileStore(output);
  await json.save(database);
  const roundTrip = await json.load();

  if (JSON.stringify(roundTrip) !== JSON.stringify(database)) {
    throw new Error('Rollback export verification failed: exported JSON does not match SQLite state.');
  }

  console.log('NEXUS SQLITE EXPORT VERIFIED');
  console.log(`SQLite source: ${path.resolve(source)}`);
  console.log(`JSON export:   ${path.resolve(output)}`);
  console.log(`Jobs exported: ${database.jobs.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
