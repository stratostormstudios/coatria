import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {database,query,transaction} from '../src/lib/db';
import {claimAgentRun,finishAgentRun} from '../src/lib/agent-runs';
import {executeAgentTool} from '../src/lib/agent-tools';
import {referenceGenerationFollowupCommitAuthority,referenceGenerationFollowupRunAuthority} from '../src/lib/studio-reference-generation-followups';
import {openReferenceGenerationDatabase} from './fixtures/reference-generation';
import {confirmedReferenceGenerationFixture} from './fixtures/reference-generation-confirmed';

async function fixture(){
 const f=await confirmedReferenceGenerationFixture(),initialParent=f.parent;
 const parent=(await f.api(`companies/${f.company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:f.coordinator.id,prompt:'Continue only the exact approved synthetic reference.'},201)).run;
 const parentLease=await claimAgentRun(f.coordinator as any,{workerId:'commit-coordinator',claimId:randomUUID()});assert.equal(parentLease.run!.id,parent.id);
 const dispatched=await executeAgentTool(f.coordinator as any,'studio_reference_generation_followup_dispatch',{runId:parent.id,leaseToken:parentLease.leaseToken!,requestId:randomUUID(),arguments:{projectId:f.project,projectRevision:f.projectRevision,workItemId:f.work,referenceId:f.reference!.id,policyRevision:f.policy.revision}});
 const child=(dispatched.result as any).continuation,lease=await claimAgentRun(f.producer as any,{workerId:'commit-specialist',claimId:randomUUID()});assert.equal(lease.run!.id,child.childRunId);
 const run=(await query('SELECT * FROM agent_runs WHERE id=$1',[child.childRunId])).rows[0];
 return {...f,initialParent,parent,parentLease,child,lease,run};
}
async function assertBlocked(waiter:number,blocker:number){
 const until=Date.now()+5000;while(Date.now()<until){if((await query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[blocker,waiter])).rows[0].blocked)return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Expected the actual PostgreSQL lock overlap');
}

test('reference generation final source authority is stable and lock contention stays retryable',{timeout:180000},async t=>{
 const db=await openReferenceGenerationDatabase();
 try{
  await t.test('actual final guard accepts current metadata and rejects changed source',async()=>{
   const f=await fixture();await transaction(c=>referenceGenerationFollowupCommitAuthority(c,f.company,f.run));
   await transaction(async c=>{await c.query('SAVEPOINT source_change');try{await c.query("UPDATE studio_projects SET brief='Different objective' WHERE id=$1",[f.project]);await assert.rejects(referenceGenerationFollowupCommitAuthority(c,f.company,f.run),{code:'REFERENCE_GENERATION_FOLLOWUP_AUTHORITY_ENDED'});}finally{await c.query('ROLLBACK TO SAVEPOINT source_change');}});
  });
  for(const boundary of ['reference sharing','running dispatch parent'] as const)await t.test(`final database clock rejects late ${boundary} expiry and rolls back pending work`,async()=>{
   const f=await fixture();
   if(boundary==='reference sharing')await finishAgentRun(f.coordinator as any,f.parent.id,'complete',{clientId:randomUUID(),leaseToken:f.parentLease.leaseToken!,result:'Dispatched the exact reference continuation; no generation performed.'});
   const referenceExpiry=(await query('SELECT expires_at FROM higgsfield_references WHERE id=$1',[f.reference!.id])).rows[0].expires_at;
   const parent=(await query('SELECT lease_expires_at,started_at FROM agent_runs WHERE id=$1',[f.parent.id])).rows[0];
   const expected=new Date(boundary==='reference sharing'?referenceExpiry:Math.min(+new Date(parent.lease_expires_at),+new Date(parent.started_at)+1800000)).toISOString();
   const marker=randomUUID();let finalChecks=0;
   await assert.rejects(transaction(async c=>{
    await c.query("INSERT INTO activity(company_id,kind,description) VALUES($1,'test.pending',$2)",[f.company,marker]);
    const wrapped=new Proxy(c,{get(target,key){if(key==='query')return (sql:string,values:unknown[])=>{
     if(typeof sql==='string'&&sql.startsWith('WITH moment AS MATERIALIZED')&&new Date(values[0] as string).toISOString()===expected){
      finalChecks++;return target.query(sql.replace('clock_timestamp()','$2::timestamptz'),[...values,new Date(+new Date(expected)+1).toISOString()]);
     }return target.query(sql,values);
    };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as PoolClient;
    await referenceGenerationFollowupCommitAuthority(wrapped,f.company,f.run);
   }),{code:'REFERENCE_GENERATION_FOLLOWUP_AUTHORITY_ENDED'});
   assert.equal(finalChecks,1,'The final deadline must include the earlier bound, after the source checks');
   assert.equal((await query('SELECT count(*)::int n FROM activity WHERE company_id=$1 AND description=$2',[f.company,marker])).rows[0].n,0);
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[f.run.id])).rows[0].status,'running');
  });
  await t.test('native source update waits until the final commit releases its locks',{skip:!db.native},async()=>{
   const f=await fixture(),a=await database().connect(),b=await database().connect();let pending:Promise<unknown>|undefined;
   try{
    await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL statement_timeout='10s'");const apid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,bpid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await a.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[f.run.id]);await referenceGenerationFollowupCommitAuthority(a,f.company,f.run);
    pending=b.query("UPDATE studio_projects SET brief='Concurrent change' WHERE id=$1",[f.project]);
    await assertBlocked(bpid,apid);await a.query('COMMIT');await pending;await b.query('ROLLBACK');
   }finally{await a.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await b.query('ROLLBACK').catch(()=>{});a.release();b.release();}
  });
  await t.test('native current-parent/policy inversion rolls back busy without cancelling the child',{skip:!db.native},async()=>{
   const f=await fixture(),parent=await database().connect(),child=await database().connect();let pending:Promise<unknown>|undefined;
   try{
    await parent.query('BEGIN');await child.query('BEGIN');await parent.query("SET LOCAL statement_timeout='10s'");const ppid=(await parent.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,cpid=(await child.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await parent.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[f.parent.id]);await child.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[f.run.id]);
    assert.equal(await referenceGenerationFollowupRunAuthority(child,f.company,f.run),true,'Initial lifecycle reads do not lock the new dispatch parent');
    pending=parent.query('UPDATE studio_coordination_policies SET revision=revision+1 WHERE project_id=$1',[f.project]);await assertBlocked(ppid,cpid);
    await assert.rejects(referenceGenerationFollowupCommitAuthority(child,f.company,f.run),{code:'REFERENCE_GENERATION_AUTHORITY_BUSY'});
    await child.query('ROLLBACK');await pending;await parent.query('ROLLBACK');
    assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[f.run.id])).rows[0].status,'running');
    await transaction(c=>referenceGenerationFollowupCommitAuthority(c,f.company,f.run));
   }finally{await child.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await parent.query('ROLLBACK').catch(()=>{});parent.release();child.release();}
  });
  await t.test('native dependency task update waits for the final commit boundary',{skip:!db.native},async()=>{
   const f=await fixture();
   await query("UPDATE tasks SET status='done' WHERE id=$1",[f.referenceTask]);
   await query('INSERT INTO studio_dependencies(company_id,project_id,work_item_id,predecessor_id) VALUES($1,$2,$3,$4)',[f.company,f.project,f.work,f.referenceWork]);
   const a=await database().connect(),b=await database().connect();let pending:Promise<unknown>|undefined;
   try{
    await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL statement_timeout='10s'");
    const apid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,bpid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await a.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[f.run.id]);await referenceGenerationFollowupCommitAuthority(a,f.company,f.run);
    pending=b.query("UPDATE tasks SET status='todo' WHERE id=$1",[f.referenceTask]);await assertBlocked(bpid,apid);await a.query('COMMIT');await pending;await b.query('ROLLBACK');
   }finally{await a.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await b.query('ROLLBACK').catch(()=>{});a.release();b.release();}
  });
  await t.test('native busy initial parent is propagated before policy locks, never converted to authority loss',{skip:!db.native},async()=>{
   const f=await fixture(),parent=await database().connect(),child=await database().connect();
   try{await parent.query('BEGIN');await child.query('BEGIN');await parent.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[f.initialParent.id]);await assert.rejects(referenceGenerationFollowupRunAuthority(child,f.company,f.run),{code:'REFERENCE_GENERATION_AUTHORITY_BUSY'});await child.query('ROLLBACK');await parent.query('ROLLBACK');assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[f.run.id])).rows[0].status,'running');}
   finally{await child.query('ROLLBACK').catch(()=>{});await parent.query('ROLLBACK').catch(()=>{});parent.release();child.release();}
  });
 }finally{await db.close();}
});
