import 'dotenv/config';
import { access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { JsonFileStore, type NexusDatabase } from './store.js';
import { SqliteStore } from './sqlite-store.js';

function hasData(database: NexusDatabase): boolean {
  return Object.values(database).some((value) => Array.isArray(value) && value.length > 0);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const source = process.env.NEXUS_JSON_DATABASE_FILE ?? process.env.NEXUS_DATABASE_FILE ?? 'data/nexus-db.json';
  const destination = process.env.NEXUS_SQLITE_DATABASE_FILE ?? 'data/nexus.db';
  const force = process.argv.includes('--force');

  await access(source).catch(() => {
    throw new Error(`JSON source does not exist: ${path.resolve(source)}`);
  });

  const backup = `${source}.backup-${stamp()}`;
  await copyFile(source, backup);

  const sourceStore = new JsonFileStore(source);
  const destinationStore = new SqliteStore(destination);
  const sourceDatabase = await sourceStore.load();
  const existingDestination = await destinationStore.load();

  if (hasData(existingDestination) && !force) {
    destinationStore.close();
    throw new Error(
      `SQLite destination already contains Nexus data: ${path.resolve(destination)}. ` +
      `Nothing was overwritten. Use --force only after making a separate backup.`,
    );
  }

  await destinationStore.save(sourceDatabase);
  const roundTrip = await destinationStore.load();
  destinationStore.close();

  if (JSON.stringify(roundTrip) !== JSON.stringify(sourceDatabase)) {
    throw new Error('Migration verification failed: SQLite round-trip does not match the JSON source.');
  }

  console.log('NEXUS STORAGE MIGRATION VERIFIED');
  console.log(`Source JSON: ${path.resolve(source)}`);
  console.log(`Backup JSON: ${path.resolve(backup)}`);
  console.log(`SQLite DB:   ${path.resolve(destination)}`);
  console.log(`Jobs copied: ${sourceDatabase.jobs.length}`);
  console.log('The original JSON file was not deleted. Rollback is still available by selecting the JSON driver.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
