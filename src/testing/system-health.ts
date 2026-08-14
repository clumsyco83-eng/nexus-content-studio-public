import 'dotenv/config';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNexusStore } from '../storage/factory.js';
import { NexusRepository } from '../storage/repository.js';

interface CheckResult { name:string; ok:boolean; details:string; }

async function runCommand(name:string, command:string, args:string[]):Promise<CheckResult>{
  return new Promise((resolve)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],shell:process.platform==='win32'});
    let out=''; let err='';
    child.stdout?.on('data',(d)=>out+=String(d));
    child.stderr?.on('data',(d)=>err+=String(d));
    child.on('close',(code)=>resolve({name,ok:code===0,details:(code===0?out:err||out).trim().slice(-2000)}));
    child.on('error',(e)=>resolve({name,ok:false,details:e.message}));
  });
}

async function checkStorage():Promise<CheckResult>{
  try{
    const suffix=Date.now();
    const store=createNexusStore({ ...process.env, NEXUS_JSON_DATABASE_FILE:`data/healthcheck-db-${suffix}.json`, NEXUS_SQLITE_DATABASE_FILE:`data/healthcheck-db-${suffix}.db` });
    const repo=new NexusRepository(store);
    const id=`health-${suffix}`;
    await repo.createJob({id,brand:'Curious Grit',contentKind:'healthcheck',state:'DRAFT'});
    const db=await store.load();
    const found=db.jobs.some(j=>j.id===id);
    const description=store.describe();
    return { name:'persistent-storage', ok:found, details:found?`${description.driver} store atomic write/read passed at ${description.location}.`:'Created job was not persisted.' };
  }catch(e){return {name:'persistent-storage',ok:false,details:e instanceof Error?e.message:String(e)}}
}

async function checkDashboard():Promise<CheckResult>{
  const token=`health-${Math.random().toString(36).slice(2)}`;
  const env={...process.env,NEXUS_DASHBOARD_TOKEN:token,NEXUS_DASHBOARD_HOST:'127.0.0.1',NEXUS_DASHBOARD_PORT:'8788'};
  const child=spawn(process.execPath,['--import','tsx','src/dashboard/server.ts'],{env,stdio:['ignore','pipe','pipe']});
  let logs=''; child.stdout?.on('data',(d)=>logs+=String(d)); child.stderr?.on('data',(d)=>logs+=String(d));
  try{
    for(let i=0;i<20;i++){
      await sleep(250);
      try{
        const r=await fetch('http://127.0.0.1:8788/api/dashboard',{headers:{authorization:`Bearer ${token}`}});
        if(r.ok){ child.kill(); return {name:'dashboard-api',ok:true,details:'Authenticated /api/dashboard responded successfully.'}; }
      }catch{}
    }
    child.kill();
    return {name:'dashboard-api',ok:false,details:`Dashboard did not become healthy. ${logs.slice(-1500)}`};
  }catch(e){child.kill();return {name:'dashboard-api',ok:false,details:e instanceof Error?e.message:String(e)}}
}

async function main(){
  const results:CheckResult[]=[];
  results.push(await runCommand('typescript-check',process.platform==='win32'?'npx.cmd':'npx',['tsc','--noEmit']));
  results.push(await checkStorage());
  results.push(await runCommand('project-control',process.platform==='win32'?'npx.cmd':'npx',['tsx','src/projects/project-control.ts']));
  results.push(await runCommand('operational-controls',process.platform==='win32'?'npx.cmd':'npx',['tsx','src/testing/operational-controls.ts']));
  results.push(await runCommand('claude-model-routing',process.platform==='win32'?'npx.cmd':'npx',['tsx','src/testing/model-routing.ts']));
  results.push(await runCommand('intelligence-routing',process.platform==='win32'?'npx.cmd':'npx',['tsx','src/testing/intelligence-routing.ts']));
  results.push(await runCommand('provider-readiness',process.platform==='win32'?'npx.cmd':'npx',['tsx','src/testing/provider-readiness.ts']));
  results.push(await runCommand('first-production-dry-run',process.platform==='win32'?'npx.cmd':'npx',['tsx','src/testing/run-first-production-test.ts']));
  results.push(await checkDashboard());

  const passed=results.filter(r=>r.ok).length;
  console.log('\nNEXUS SYSTEM HEALTH\n');
  for(const r of results) console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}\n${r.details||'No details.'}\n`);
  console.log(`${passed}/${results.length} checks passed.`);
  if(passed!==results.length) process.exitCode=1;
}

main().catch((e)=>{console.error(e);process.exitCode=1});
