import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {database,query} from '../src/lib/db';
import type {Membership} from '../src/lib/auth';
import {hashToken,secret} from '../src/lib/security';
import {createAgentRun,claimAgentRun,heartbeatAgentRun,agentRunContext,finishAgentRun,type AgentRunIdentity} from '../src/lib/agent-runs';
import {executeAgentTool} from '../src/lib/agent-tools';

// Only real PostgreSQL can establish independent transaction/row-lock evidence.
// This fixture never imports environment files or borrows the local UI database.
const connection=process.env.COATRIA_INTEGRATION_DATABASE_URL;
let local=false;try{local=Boolean(connection&&['localhost','127.0.0.1'].includes(new URL(connection).hostname));}catch{}
type Result<T>={value:T;error?:never}|{error:unknown;value?:never};
function track<T>(promise:Promise<T>){let settled=false;const result=promise.then(value=>({value}as Result<T>),error=>({error}as Result<T>)).then(value=>{settled=true;return value;});return{result,get settled(){return settled;}};}
async function waitBlocked(client:PoolClient){const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;for(let i=0;i<150;i++){if((await query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount)return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected an independent transaction to wait on the controlled row lock.');}

test('agent leases and tools recheck authority after real PostgreSQL lock contention',{skip:!local||process.env.COATRIA_TEST_EMULATOR==='1',timeout:120000},async t=>{
 process.env.DATABASE_URL=connection!;process.env.DATABASE_POOL_MAX='10';
 const companyId=randomUUID(),ownerId=randomUUID(),requesterId=randomUUID(),agentId=randomUUID();
 const identity:AgentRunIdentity={id:agentId,company_id:companyId,created_by:ownerId,token_hash:hashToken(secret())};
 const member:Membership={companyId,userId:requesterId,role:'member',user:{id:requesterId,name:'Run requester',email:requesterId+'@example.invalid',roleTitle:'',avatarColor:'#5c715e',avatarId:null,emailVerified:false}};
 async function reset(){await query("UPDATE memberships SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'member' END WHERE company_id=$1",[companyId,ownerId]);await query("UPDATE agents SET status='active',invocation_access='members',capabilities='[\"workspace.read\",\"tasks.write\"]',token_hash=$3 WHERE company_id=$1 AND id=$2",[companyId,agentId,identity.token_hash]);await query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE company_id=$1 AND status IN ('queued','running')",[companyId]);}
 async function leased(){await reset();const{run}=await createAgentRun(member,'commons',{clientId:randomUUID(),agentId,prompt:'Concurrency-controlled request'});const held=await claimAgentRun(identity,{workerId:'race-worker',claimId:randomUUID()});assert.equal(held.run?.id,run.id);assert(held.leaseToken);return{run,leaseToken:held.leaseToken};}
 async function blockedMutation(write:(client:PoolClient)=>Promise<unknown>,request:()=>Promise<unknown>,check:(result:Result<unknown>)=>void){const blocker=await database().connect();await blocker.query('BEGIN');let finished=false;let pending:ReturnType<typeof track<unknown>>|undefined;try{await write(blocker);pending=track(request());await waitBlocked(blocker);assert.equal(pending.settled,false);await blocker.query('COMMIT');finished=true;check(await pending.result);}finally{if(!finished)await blocker.query('ROLLBACK');blocker.release();await pending?.result;}}
 try{
  for(const userId of[ownerId,requesterId])await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Run concurrency test',$2,'not-a-login-password')",[userId,userId+'@example.invalid']);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Run concurrency fixture',$2,'blank')",[companyId,'agent-concurrency-'+companyId]);
  for(const[userId,role]of[[ownerId,'owner'],[requesterId,'member']])await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[companyId,userId,role]);
  await query("INSERT INTO agents(id,company_id,name,harness,created_by,token_hash,invocation_access,capabilities) VALUES($1,$2,'Concurrency agent','custom',$3,$4,'members','[\"workspace.read\",\"tasks.write\"]')",[agentId,companyId,ownerId,identity.token_hash]);
  await t.test('eight concurrent worker claims issue exactly one active lease',async()=>{
   const{run}=await createAgentRun(member,'commons',{clientId:randomUUID(),agentId,prompt:'One worker owns this request'});
   const claims=await Promise.all(Array.from({length:8},(_,index)=>claimAgentRun(identity,{workerId:'worker-'+index,claimId:randomUUID()})));
   assert.equal(claims.filter(claim=>claim.run).length,1);assert.equal(claims.find(claim=>claim.run)?.run?.id,run.id);
   assert.equal((await query("SELECT count(*)::int AS count FROM agent_runs WHERE company_id=$1 AND status='running'",[companyId])).rows[0].count,1);
  });
  await t.test('token rotation committed during an authority wait invalidates a stale authenticated identity',async()=>{
   const{run,leaseToken}=await leased();await blockedMutation(client=>client.query('UPDATE agents SET token_hash=$3 WHERE company_id=$1 AND id=$2',[companyId,agentId,hashToken(secret())]),()=>heartbeatAgentRun(identity,run.id,{leaseToken}),result=>assert.equal((result.error as {status:number})?.status,401));
  });
  await t.test('requester removal committed during company-lock wait prevents context disclosure',async()=>{
   const{run,leaseToken}=await leased();await blockedMutation(async client=>{await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);await client.query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[companyId,requesterId]);},()=>agentRunContext(identity,run.id,leaseToken),result=>assert.equal((result.error as {code:string})?.code,'RUN_REQUESTER_ACCESS'));
  });
  await t.test('grant downgrade is checked after the agent lock, before any tool mutation',async()=>{
   const{run,leaseToken}=await leased();await blockedMutation(client=>client.query("UPDATE agents SET capabilities='[]' WHERE company_id=$1 AND id=$2",[companyId,agentId]),()=>executeAgentTool(identity,'tasks_create',{runId:run.id,leaseToken,requestId:randomUUID(),arguments:{title:'Must not be created'}}),result=>assert.equal((result.error as {code:string})?.code,'AGENT_CAPABILITY_REQUIRED'));
   assert.equal((await query('SELECT count(*)::int AS count FROM tasks WHERE company_id=$1',[companyId])).rows[0].count,0);
  });
  await t.test('a cancellation committed while a tool waits on the run lock fences the mutation',async()=>{
   const{run,leaseToken}=await leased();await blockedMutation(client=>client.query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE company_id=$1 AND id=$2",[companyId,run.id]),()=>executeAgentTool(identity,'tasks_create',{runId:run.id,leaseToken,requestId:randomUUID(),arguments:{title:'Late mutation'}}),result=>assert.equal((result.error as {code:string})?.code,'RUN_CANCELLED'));
   assert.equal((await query('SELECT count(*)::int AS count FROM agent_tool_receipts WHERE company_id=$1',[companyId])).rows[0].count,0);
  });
  await t.test('concurrent completion retries commit one reply and one receipt',async()=>{
   const{run,leaseToken}=await leased(),body={leaseToken,clientId:randomUUID(),result:'Exactly one committed result'};
   const results=await Promise.all(Array.from({length:4},()=>finishAgentRun(identity,run.id,'complete',body)));
   assert.equal(results.filter(result=>!result.replayed).length,1);assert.equal(new Set(results.map(result=>result.run.resultMessageId)).size,1);
   assert.equal((await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1 AND body=$2',[companyId,body.result])).rows[0].count,1);
   assert.equal((await query('SELECT count(*)::int AS count FROM agent_run_receipts WHERE company_id=$1 AND run_id=$2',[companyId,run.id])).rows[0].count,1);
  });
 }finally{await query('DELETE FROM companies WHERE id=$1',[companyId]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,requesterId]]);await database().end();delete(globalThis as any).coatriaPool;}
});
