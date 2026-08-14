import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const taskStatus = z.enum(['DONE', 'READY', 'PREPARED', 'BLOCKED_LOCAL', 'BLOCKED_EXTERNAL']);

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: taskStatus,
  notes: z.string().optional(),
  requires: z.array(z.string()).default([]),
});

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  priority: z.number().int().min(1),
  repository: z.string().optional(),
  tasks: z.array(taskSchema),
});

const ledgerSchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.string().min(1),
  projects: z.array(projectSchema),
});

export type ProjectTaskStatus = z.infer<typeof taskStatus>;
export type ProjectTask = z.infer<typeof taskSchema>;
export type NexusProject = z.infer<typeof projectSchema>;
export type ProjectLedger = z.infer<typeof ledgerSchema>;

export async function loadProjectLedger(file = 'projects/master-projects.json'): Promise<ProjectLedger> {
  const raw = await readFile(path.resolve(file), 'utf8');
  return ledgerSchema.parse(JSON.parse(raw));
}

export interface ProjectQueueSummary {
  total: number;
  done: number;
  ready: number;
  prepared: number;
  blockedLocal: number;
  blockedExternal: number;
}

export function summarizeProjectQueue(ledger: ProjectLedger): ProjectQueueSummary {
  const tasks = ledger.projects.flatMap((project) => project.tasks);
  return {
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'DONE').length,
    ready: tasks.filter((task) => task.status === 'READY').length,
    prepared: tasks.filter((task) => task.status === 'PREPARED').length,
    blockedLocal: tasks.filter((task) => task.status === 'BLOCKED_LOCAL').length,
    blockedExternal: tasks.filter((task) => task.status === 'BLOCKED_EXTERNAL').length,
  };
}

export function nextExecutableTasks(ledger: ProjectLedger): Array<{ project: NexusProject; task: ProjectTask }> {
  return ledger.projects
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .flatMap((project) => project.tasks
      .filter((task) => task.status === 'READY')
      .map((task) => ({ project, task })));
}

async function main() {
  const ledger = await loadProjectLedger(process.argv[2]);
  const summary = summarizeProjectQueue(ledger);
  console.log('\nNEXUS MASTER PROJECT CONTROL\n');
  console.log(`Projects: ${ledger.projects.length}`);
  console.log(`Tasks: ${summary.total} | done=${summary.done} ready=${summary.ready} prepared=${summary.prepared} blocked-local=${summary.blockedLocal} blocked-external=${summary.blockedExternal}`);

  for (const project of ledger.projects.slice().sort((a, b) => a.priority - b.priority)) {
    console.log(`\n${project.priority}. ${project.name}${project.repository ? ` (${project.repository})` : ''}`);
    for (const task of project.tasks) {
      console.log(`  [${task.status}] ${task.title}`);
      if (task.notes) console.log(`    ${task.notes}`);
    }
  }

  const next = nextExecutableTasks(ledger);
  console.log('\nNEXT SAFE EXECUTABLE TASKS');
  if (!next.length) console.log('  None currently marked READY.');
  for (const item of next) console.log(`  ${item.project.name}: ${item.task.title}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
