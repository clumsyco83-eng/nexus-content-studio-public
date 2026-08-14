export interface DashboardJob { id:string; title:string; format:string; stage:string; status:string; platforms:string[]; costUsd:number; }
export interface DashboardSnapshot { prepared:number; ready:number; approval:number; cost:string; jobs:DashboardJob[]; recommendation:string; generatedAt:string; }

export interface DashboardDataSource {
  listJobs(): Promise<Array<{id:string; title?:string; format?:string; stage?:string; status?:string; platforms?:string[]; costUsd?:number}>>;
  getRecommendation?(): Promise<string | undefined>;
}

export async function buildDashboardSnapshot(source: DashboardDataSource): Promise<DashboardSnapshot> {
  const rows = await source.listJobs();
  const jobs: DashboardJob[] = rows.map((j)=>({
    id:j.id,
    title:j.title ?? 'Untitled content job',
    format:j.format ?? 'unknown',
    stage:j.stage ?? 'unknown',
    status:j.status ?? 'unknown',
    platforms:j.platforms ?? [],
    costUsd:j.costUsd ?? 0,
  }));
  const prepared = jobs.filter(j=>!['published','failed','cancelled'].includes(j.stage)).length;
  const approval = jobs.filter(j=>j.stage==='AWAITING_APPROVAL'||j.status==='AWAITING_APPROVAL').length;
  const ready = jobs.filter(j=>['QC_PASSED','CLAIMS_VERIFIED','APPROVED','READY'].includes(j.stage)||['READY','APPROVED'].includes(j.status)).length;
  const spend = jobs.reduce((n,j)=>n+j.costUsd,0);
  return {
    prepared,
    ready,
    approval,
    cost:`$${spend.toFixed(2)}`,
    jobs,
    recommendation:(await source.getRecommendation?.()) ?? 'Collect more performance evidence before changing the content strategy.',
    generatedAt:new Date().toISOString(),
  };
}

export function assertDashboardAction(action:string): asserts action is 'approve'|'reject'|'regenerate'|'pause' {
  if(!['approve','reject','regenerate','pause'].includes(action)) throw new Error(`Unsupported dashboard action: ${action}`);
}
