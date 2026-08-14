import assert from 'node:assert/strict';
import { assertClaudeCodeVersion, ClaudeRuntimeEvidenceError, isFloatingClaudeModelAlias, parseClaudeStreamJson } from '../claude/runtime-evidence.js';

function stream(overrides: { model?:string; permissionMode?:string; cwd?:string; subtype?:string; isError?:boolean; turns?:number; cost?:number; resultSessionId?:string } = {}): string {
  const sessionId='session-verified-1';
  const init={ type:'system', subtype:'init', session_id:sessionId, model:overrides.model??'claude-sonnet-4-20250514', permissionMode:overrides.permissionMode??'default', cwd:overrides.cwd??'C:\\NEXUS-WORK\\nexus-content-studio', tools:['Read','Edit','Bash'], mcp_servers:[{name:'nexus-safe-tools',status:'connected'}] };
  const result={ type:'result', subtype:overrides.subtype??'success', session_id:overrides.resultSessionId??sessionId, is_error:overrides.isError??false, duration_ms:1250, duration_api_ms:900, num_turns:overrides.turns??6, total_cost_usd:overrides.cost??0.03, result:'bounded output' };
  return `${JSON.stringify(init)}\n${JSON.stringify({type:'assistant',session_id:sessionId,message:{}})}\n${JSON.stringify(result)}\n`;
}
function expectFailure(raw:string, expected:RegExp, kind?:ClaudeRuntimeEvidenceError['kind']):void {
  assert.throws(()=>parseClaudeStreamJson(raw,{ expectedResolvedModel:'claude-sonnet-4-20250514', maxTurns:20, maxCostUsd:0.1, expectedCwd:'C:\\NEXUS-WORK\\nexus-content-studio' }), (error:unknown)=>{ assert.ok(error instanceof ClaudeRuntimeEvidenceError); assert.match(error.message,expected); if(kind) assert.equal(error.kind,kind); return true; });
}
function main():void {
  assert.equal(isFloatingClaudeModelAlias('sonnet'),true); assert.equal(isFloatingClaudeModelAlias('OPUS'),true); assert.equal(isFloatingClaudeModelAlias('claude-sonnet-4-20250514'),false);
  const evidence=parseClaudeStreamJson(stream(),{ expectedResolvedModel:'claude-sonnet-4-20250514', maxTurns:20, maxCostUsd:0.1, expectedCwd:'C:\\NEXUS-WORK\\nexus-content-studio' });
  assert.equal(evidence.success,true); assert.equal(evidence.resolvedModel,'claude-sonnet-4-20250514'); assert.equal(evidence.permissionMode,'default'); assert.equal(evidence.numTurns,6); assert.equal(evidence.totalCostUsd,0.03); assert.equal(evidence.resultText,'bounded output'); assert.deepEqual(evidence.mcpServers,[{name:'nexus-safe-tools',status:'connected'}]);
  assert.throws(()=>parseClaudeStreamJson(stream(),{expectedResolvedModel:'sonnet',maxTurns:20,maxCostUsd:0.1}),/exact evaluated model ID/);
  expectFailure(stream({model:'claude-sonnet-4-20990101'}),/resolved model drift/,'identity');
  expectFailure(stream({permissionMode:'bypassPermissions'}),/bypassPermissions/,'permission');
  expectFailure(stream({permissionMode:'acceptEdits'}),/not approved/,'permission');
  expectFailure(stream({cwd:'C:\\Users\\owner'}),/working-directory drift/,'identity');
  expectFailure(stream({turns:21}),/turn budget/,'budget'); expectFailure(stream({cost:0.11}),/cost budget/,'budget');
  expectFailure(stream({subtype:'error_max_turns',isError:true}),/did not complete successfully/,'execution'); expectFailure(stream({resultSessionId:'other-session'}),/session IDs do not match/,'identity'); expectFailure('{bad json}',/not valid JSON/,'format');
  const failed=parseClaudeStreamJson(stream({subtype:'error_during_execution',isError:true}),{expectedResolvedModel:'claude-sonnet-4-20250514',maxTurns:20,maxCostUsd:0.1,expectedCwd:'C:\\NEXUS-WORK\\nexus-content-studio',requireSuccess:false}); assert.equal(failed.success,false);
  assert.doesNotThrow(()=>assertClaudeCodeVersion('2.1.0','2.1.0')); assert.throws(()=>assertClaudeCodeVersion('2.1.1','2.1.0'),/version drift/);
  console.log('PASS Claude runtime evidence: exact resolved model, permission mode, cwd, turn/cost budgets, session identity and Claude Code version drift are fail-closed.');
}
main();
