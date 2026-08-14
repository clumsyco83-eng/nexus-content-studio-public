import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GuardianCheck, GuardianReport, GuardianStatus } from './types.js';

const reportDir = process.env.NEXUS_GUARDIAN_REPORT_DIR ?? 'data/guardian';

async function runProcess(name: string, command: string, args: string[], severity: GuardianCheck['severity'], timeoutMs = 120_000): Promise<GuardianCheck> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, details: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ name, ok, severity, details: details.trim().slice(-4000) || 'No details.', durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false, `Timed out after ${timeoutMs} ms.`);
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => finish(code === 0, code === 0 ? stdout : stderr || stdout));
    child.on('error', (error) => finish(false, error.message));
  });
}

async function dashboardProbe(): Promise<GuardianCheck> {
  const started = Date.now();
  const url = process.env.NEXUS_GUARDIAN_HEALTH_URL ?? 'http://127.0.0.1:8787/api/health';
  const token = process.env.NEXUS_DASHBOARD_TOKEN ?? '';
  try {
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      name: 'nexus-live-health',
      ok: response.ok,
      severity: 'critical',
      details: response.ok ? `Nexus responded at ${url}. ${text.slice(0, 1000)}` : `HTTP ${response.status}: ${text.slice(0, 1000)}`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      name: 'nexus-live-health',
      ok: false,
      severity: 'critical',
      details: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

async function previousReportCheck(): Promise<GuardianCheck> {
  try {
    const raw = await readFile(path.join(reportDir, 'latest.json'), 'utf8');
    const previous = JSON.parse(raw) as GuardianReport;
    const ageMs = Date.now() - new Date(previous.generatedAt).getTime();
    const maxAgeMs = Number(process.env.NEXUS_GUARDIAN_MAX_REPORT_AGE_MS ?? 86_400_000);
    return {
      name: 'guardian-report-freshness',
      ok: ageMs <= maxAgeMs,
      severity: 'warning',
      details: `Previous report status=${previous.status}, score=${previous.score}, age=${Math.round(ageMs / 60_000)} minutes.`,
    };
  } catch {
    return { name: 'guardian-report-freshness', ok: true, severity: 'info', details: 'No previous Guardian report yet; this is the first run.' };
  }
}

function calculate(checks: GuardianCheck[]): Pick<GuardianReport, 'status' | 'score' | 'summary' | 'counters' | 'recommendations'> {
  const failed = checks.filter((c) => !c.ok);
  const criticalFailures = failed.filter((c) => c.severity === 'critical').length;
  const warningFailures = failed.filter((c) => c.severity === 'warning').length;
  const penalty = checks.reduce((sum, c) => sum + (c.ok ? 0 : c.severity === 'critical' ? 35 : c.severity === 'warning' ? 15 : 5), 0);
  const score = Math.max(0, 100 - penalty);
  const status: GuardianStatus = criticalFailures > 0 || score < 60 ? 'RED' : warningFailures > 0 || score < 90 ? 'YELLOW' : 'GREEN';
  const recommendations = failed.map((c) => `Investigate ${c.name}: ${c.details.split('\n')[0]}`);
  if (!recommendations.length) recommendations.push('No intervention required. Nexus passed Guardian verification.');
  return {
    status,
    score,
    summary: `${checks.length - failed.length}/${checks.length} checks passed; ${criticalFailures} critical and ${warningFailures} warning failures.`,
    counters: { passed: checks.length - failed.length, failed: failed.length, criticalFailures, warningFailures },
    recommendations,
  };
}

export async function runGuardian(): Promise<GuardianReport> {
  const checks: GuardianCheck[] = [];
  checks.push(await dashboardProbe());
  checks.push(await previousReportCheck());
  checks.push(await runProcess(
    'nexus-system-verification',
    process.execPath,
    ['--import', 'tsx', 'src/testing/system-health.ts'],
    'critical',
  ));
  const calculated = calculate(checks);
  const report: GuardianReport = {
    id: `guardian-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    checks,
    ...calculated,
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(path.join(reportDir, `${report.id}.json`), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(path.join(reportDir, 'latest.txt'), [
    `NEXUS GUARDIAN — ${report.status} — ${report.score}/100`,
    report.generatedAt,
    report.summary,
    '',
    ...report.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} [${c.severity.toUpperCase()}] ${c.name}: ${c.details}`),
    '',
    'RECOMMENDATIONS',
    ...report.recommendations.map((r) => `- ${r}`),
  ].join('\n'), 'utf8');
  return report;
}

async function main() {
  const report = await runGuardian();
  console.log(`\nNEXUS GUARDIAN: ${report.status} ${report.score}/100\n${report.summary}`);
  for (const check of report.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} — ${check.details.split('\n')[0]}`);
  if (report.status === 'RED') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
