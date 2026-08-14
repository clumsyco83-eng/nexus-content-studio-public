import 'dotenv/config';
import path from 'node:path';
import { createNexusStore } from '../storage/factory.js';
import { GitHubIssueRemoteClient } from './github-client.js';
import { GitHubIssueRemoteTransport } from './service.js';
import { RemoteTransportWorkerLock } from './cycle-lock.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for NEXUS remote GitHub transport.`);
  return value;
}

function pollIntervalMs(): number {
  const raw = Number(process.env.NEXUS_REMOTE_GITHUB_POLL_MS ?? 60_000);
  if (!Number.isInteger(raw) || raw < 30_000 || raw > 5 * 60_000) {
    throw new Error('NEXUS_REMOTE_GITHUB_POLL_MS must be from 30000 to 300000 ms.');
  }
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedBackoff(baseMs: number, consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 3);
  return Math.min(5 * 60_000, baseMs * (2 ** exponent));
}

async function main(): Promise<void> {
  if (process.env.NEXUS_REMOTE_GITHUB_ENABLED !== 'true') {
    throw new Error('Remote GitHub transport is disabled. Set NEXUS_REMOTE_GITHUB_ENABLED=true only after laptop activation/verification.');
  }

  const repository = required('NEXUS_REMOTE_GITHUB_REPOSITORY');
  const expectedIssueAuthor = required('NEXUS_REMOTE_GITHUB_OWNER');
  const hostId = required('NEXUS_REMOTE_HOST_ID');
  const token = required('NEXUS_REMOTE_GITHUB_TOKEN');
  const label = process.env.NEXUS_REMOTE_GITHUB_LABEL?.trim() || 'nexus-remote-command';
  const repositoryRoot = path.resolve(process.env.NEXUS_REPOSITORY_ROOT ?? process.cwd());
  const once = process.argv.includes('--once');
  const interval = pollIntervalMs();

  const client = new GitHubIssueRemoteClient({ repository, token, label });
  delete process.env.NEXUS_REMOTE_GITHUB_TOKEN;
  const transport = new GitHubIssueRemoteTransport({
    repositoryRoot,
    hostId,
    expectedIssueAuthor,
    commandLabel: label,
    store: createNexusStore(),
    client,
  });
  const lock = new RemoteTransportWorkerLock();
  await lock.acquire();

  let stopping = false;
  let consecutiveFailures = 0;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    do {
      try {
        const result = await transport.pollOnce();
        consecutiveFailures = 0;
        if (result.examined > 0) {
          console.log(`NEXUS remote GitHub poll: examined=${result.examined} completed=${result.completed} awaitingApproval=${result.awaitingApproval} rejected=${result.rejected}`);
        }
      } catch (error) {
        if (once) throw error;
        consecutiveFailures += 1;
        const retryMs = boundedBackoff(interval, consecutiveFailures);
        console.error(`NEXUS remote GitHub poll failed safe; retrying in ${retryMs} ms: ${error instanceof Error ? error.message : 'unknown transport error'}`);
        if (!stopping) await sleep(retryMs);
        continue;
      }

      if (once || stopping) break;
      await sleep(interval);
    } while (!stopping);
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
