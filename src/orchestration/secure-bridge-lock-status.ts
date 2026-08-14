import 'dotenv/config';
import { inspectSecureBridgeCycleLock } from './secure-bridge-lock.js';

async function main() {
  const state = await inspectSecureBridgeCycleLock();
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  if (state.present) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
