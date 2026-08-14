import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseClaudeStreamJson } from '../claude/runtime-evidence.js';

const SENTINEL='NEXUS_CLAUDE_RUNTIME_SMOKE_OK'; const HARD_MAX_COST_USD=0.5;
function positiveCost(raw:string|undefined):number { const value=raw?.trim()?Number(raw):0.1; if(!Number.isFinite(value)||value<=0||value>HARD_MAX_COST_USD) throw new Error(`NEXUS_CLAUDE_LIVE_SMOKE_MAX_COST_USD must be > 0 and <= $${HARD_MAX_COST_USD.toFixed(2)}.`); return value; }
async function main():Promise<void>{
  const evidencePath=process.argv[2]; if(!evidencePath) throw new Error('Usage: tsx src/testing/claude-live-smoke-evidence.ts <stream-json-file>');
  const expectedResolvedModel=process.env.NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL?.trim(); if(!expectedResolvedModel) throw new Error('NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL is required and must be the exact evaluated resolved model ID.');
  const raw=await readFile(path.resolve(evidencePath),'utf8'); const evidence=parseClaudeStreamJson(raw,{expectedResolvedModel,maxTurns:1,maxCostUsd:positiveCost(process.env.NEXUS_CLAUDE_LIVE_SMOKE_MAX_COST_USD),allowedPermissionModes:['plan'],expectedCwd:process.cwd()});
  if((evidence.resultText??'').trim()!==SENTINEL) throw new Error(`Claude live smoke returned unexpected result text. Expected exactly ${SENTINEL}.`);
  console.log(JSON.stringify({ok:true,mode:'one-bounded-read-only-claude-smoke',sessionId:evidence.sessionId,resolvedModel:evidence.resolvedModel,permissionMode:evidence.permissionMode,cwd:evidence.cwd,numTurns:evidence.numTurns,totalCostUsd:evidence.totalCostUsd,durationMs:evidence.durationMs,durationApiMs:evidence.durationApiMs,mcpServers:evidence.mcpServers},null,2));
  console.log('PASS NEXUS Claude live smoke evidence: exact resolved model, plan mode, cwd, turn/cost budget and sentinel output verified.');
}
main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
