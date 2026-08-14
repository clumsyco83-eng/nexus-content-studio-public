import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const intervalMs = Math.max(60_000, Number(process.env.NEXUS_WATCHDOG_INTERVAL_MS ?? 300_000));
const healthUrl = process.env.NEXUS_GUARDIAN_HEALTH_URL ?? 'http://127.0.0.1:8787/api/health';
const reportDir = process.env.NEXUS_GUARDIAN_REPORT_DIR ?? 'data/guardian';
const autoRestart = process.env.NEXUS_WATCHDOG_AUTO_RESTART === 'true';
const once = process.env.NEXUS_WATCHDOG_ONCE === 'true' || process.argv.includes('--once');
const restartCommand = process.env.NEXUS_WATCHDOG_RESTART_COMMAND ?? '';
const maxConsecutiveFailures = Math.max(1, Number(process.env.NEXUS_WATCHDOG_FAILURE_THRESHOLD ?? 2));
let consecutiveFailures = 0;
let restarting = false;

async function probe(): Promise<{ ok: boolean; details: string }> {
  const token = process.env.NEXUS_DASHBOARD_TOKEN ?? '';
  try {
    const response = await fetch(healthUrl, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return { ok: response.ok, details: response.ok ? text.slice(0, 1000) : `HTTP ${response.status}: ${text.slice(0, 1000)}` };
  } catch (error) {
    return { ok: false, details: error instanceof Error ? error.message : String(error) };
  }
}

async function writeHeartbeat(ok: boolean, details: string, action = 'none') {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'watchdog.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    ok,
    consecutiveFailures,
    action,
    details,
  }, null, 2), 'utf8');
}

async function restart(): Promise<string> {
  if (!autoRestart) return 'auto-restart-disabled';
  if (!restartCommand) return 'restart-command-not-configured';
  if (restarting) return 'restart-already-in-progress';
  restarting = true;
  try {
    const child = spawn(restartCommand, {
      detached: true,
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
    });
    child.unref();
    return 'restart-command-launched';
  } catch (error) {
    return `restart-failed:${error instanceof Error ? error.message : String(error)}`;
  } finally {
    setTimeout(() => { restarting = false; }, 30_000).unref();
  }
}

async function tick() {
  const result = await probe();
  if (result.ok) {
    consecutiveFailures = 0;
    await writeHeartbeat(true, result.details);
    console.log(`[WATCHDOG] GREEN ${new Date().toISOString()} Nexus healthy.`);
    return;
  }

  consecutiveFailures += 1;
  let action = 'waiting-for-threshold';
  if (consecutiveFailures >= maxConsecutiveFailures) action = await restart();
  await writeHeartbeat(false, result.details, action);
  console.error(`[WATCHDOG] ${consecutiveFailures >= maxConsecutiveFailures ? 'RED' : 'YELLOW'} ${new Date().toISOString()} ${result.details} action=${action}`);
}

async function main() {
  console.log(`[WATCHDOG] Started. interval=${intervalMs}ms threshold=${maxConsecutiveFailures} autoRestart=${autoRestart} once=${once}`);
  await tick();
  if (once) return;
  setInterval(() => { void tick(); }, intervalMs);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
