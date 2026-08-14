import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GoalTaskApprovalRepository } from '../goals/task-approvals.js';
import { createNexusStore } from '../storage/factory.js';
import { NexusRepository } from '../storage/repository.js';
import { buildDashboardSnapshot } from './dashboard-service.js';
import { buildGoalDashboardSnapshot } from './goal-dashboard-service.js';
import { buildGuardianControlCenter } from '../guardian/control-center.js';

const port = Number(process.env.NEXUS_DASHBOARD_PORT ?? 8787);
const host = process.env.NEXUS_DASHBOARD_HOST ?? '127.0.0.1';
const token = process.env.NEXUS_DASHBOARD_TOKEN ?? '';
const store = createNexusStore();
const repo = new NexusRepository(store);
const goalApprovals = new GoalTaskApprovalRepository(store);

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : String(body));
}

function isApi(req: IncomingMessage) { return (req.url ?? '').startsWith('/api/'); }

function authorized(req: IncomingMessage): boolean {
  if (!token) return host === '127.0.0.1' || host === 'localhost';
  return req.headers.authorization === `Bearer ${token}`;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function dashboardData() {
  const db = await store.load();
  return buildDashboardSnapshot({
    async listJobs() {
      return db.jobs.map((job) => ({
        id: job.id,
        title: job.topic ?? job.id,
        format: job.contentKind,
        stage: job.state,
        status: job.state,
        platforms: db.publishRecords.filter((r) => r.jobId === job.id).map((r) => r.platform),
        costUsd: db.costs.filter((c) => c.jobId === job.id).reduce((sum, c) => sum + (c.amountUsd ?? 0), 0),
      }));
    },
    async getRecommendation() {
      const lessons = db.lessons.filter((l) => l.brand.toLowerCase().includes('curious'))
        .sort((a, b) => (b.confidence * b.evidenceCount) - (a.confidence * a.evidenceCount));
      return lessons[0]?.statement;
    },
  });
}

async function goalDashboardData() {
  return buildGoalDashboardSnapshot(await store.load());
}

async function guardianData() {
  return buildGuardianControlCenter(await store.load());
}

async function resolveJobApproval(jobId: string, action: 'approve' | 'reject', actor: string, reason?: string) {
  const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  const result = await repo.resolveCurrentApproval(jobId, status, actor, reason);
  return result.approval;
}

async function regenerate(jobId: string) {
  return repo.regenerateJob(jobId);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (isApi(req) && !authorized(req)) return send(res, 401, { error: 'Unauthorized' });

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        mode: process.env.NEXUS_MODE ?? 'approval',
        host,
        port,
        storage: store.describe(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') return send(res, 200, await dashboardData());
    if (req.method === 'GET' && url.pathname === '/api/goals') return send(res, 200, await goalDashboardData());
    if (req.method === 'GET' && url.pathname === '/api/guardian') return send(res, 200, await guardianData());
    if (req.method === 'GET' && url.pathname === '/api/goal-approvals') {
      return send(res, 200, { approvals: await goalApprovals.listPending() });
    }
    if (req.method === 'POST' && /^\/api\/goal-approvals\/[^/]+\/(approve|deny)$/.test(url.pathname)) {
      const [, , , approvalId, action] = url.pathname.split('/');
      const input = await body(req);
      const note = typeof input.note === 'string' ? input.note : undefined;
      const approval = await goalApprovals.resolve({
        approvalId: approvalId!,
        decision: action === 'approve' ? 'APPROVED' : 'DENIED',
        resolvedBy: 'owner-dashboard',
        note,
      });
      return send(res, 200, approval);
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const db = await store.load();
      return send(res, 200, { jobs: db.jobs, approvals: db.approvals });
    }
    if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/(approve|reject|regenerate|pause)$/.test(url.pathname)) {
      const [, , , jobId, action] = url.pathname.split('/');
      const input = await body(req);
      const actor = typeof input.actor === 'string' ? input.actor : 'owner';
      const reason = typeof input.reason === 'string' ? input.reason : undefined;
      if (action === 'approve' || action === 'reject') return send(res, 200, await resolveJobApproval(jobId!, action, actor, reason));
      if (action === 'regenerate') return send(res, 200, await regenerate(jobId!));
      if (action === 'pause') return send(res, 200, await repo.updateJob(jobId!, { state: 'DRAFT' }));
    }

    if (req.method === 'GET' && url.pathname === '/capability-readiness.js') {
      const script = await readFile(path.resolve('dashboard/capability-readiness.js'), 'utf8');
      return send(res, 200, script, 'application/javascript; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const baseHtml = await readFile(path.resolve('dashboard/index.html'), 'utf8');
      const enhancement = '<script src="/capability-readiness.js"></script>';
      const html = baseHtml.includes(enhancement)
        ? baseHtml
        : baseHtml.replace('</body>', `${enhancement}</body>`);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    send(res, 404, { error: 'Not found' });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  const storage = store.describe();
  console.log(`Nexus dashboard listening on http://${host}:${port}`);
  console.log(`Nexus storage: ${storage.driver} (${storage.location})`);
  if (!token) console.log('Dashboard token is not set. Keep host bound to localhost only.');
});
