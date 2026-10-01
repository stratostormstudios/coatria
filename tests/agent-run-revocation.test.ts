import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {database,query,transaction} from '../src/lib/db';
import type {Membership} from '../src/lib/auth';
import {hashToken,secret} from '../src/lib/security';
import {agentRunContext,authorizeRunTool,authorizeStoredAgentRun,authorizeStoredStorageAgentRun,cancelAgentRun,claimAgentRun,createAgentRun,finishAgentRun,getAgentRun,heartbeatAgentRun,listAgentRuns,type AgentRunIdentity} from '../src/lib/agent-runs';
import {executeAgentTool} from '../src/lib/agent-tools';

const emulator=process.env.COATRIA_TEST_EMULATOR==='1',connection=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=Boolean(connection&&['127.0.0.1','localhost'].includes(new URL(connection).hostname));
test('locked agent run authority rejects timestamp-only revocation with retained membership roles',{skip:!emulator&&!local,timeout:120000},async t=>{
 process.env.DATABASE_POOL_MAX=emulator?'1':'5';let stop:(()=>Promise<void>)|undefined;
 if(emulator){const{PGlite}=await import('@electric-sql/pglite');const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const name of(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort())await db.exec(await readFile(resolve('database',name),'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}else process.env.DATABASE_URL=connection!;
 const companyId=randomUUID(),ownerId=randomUUID(),requesterId=randomUUID(),agentId=randomUUID();
 const identity:AgentRunIdentity={id:agentId,company_id:companyId,created_by:ownerId,token_hash:hashToken(secret())};
 const member:Membership={companyId,userId:requesterId,role:'member',user:{id:requesterId,name:'Distinct requester',email:requesterId+'@example.invalid',roleTitle:'',avatarColor:'#5c715e',avatarId:null,emailVerified:false}};
 const create=()=>createAgentRun(member,'commons',{clientId:randomUUID(),agentId,prompt:'Exact retained-role revocation fixture'});
 async function snapshot(){const value:Record<string,unknown>={};for(const table of['agent_runs','agent_run_claims','agent_run_receipts','agent_tool_receipts','messages','conversations','tasks'])value[table]=(await query(`SELECT * FROM ${table} WHERE company_id=$1`,[companyId])).rows.map(row=>JSON.stringify(row)).sort();return value;}
 async function revoke(userId:string){await query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[companyId,userId]);assert.equal((await query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2',[companyId,userId])).rows[0].role,userId===ownerId?'owner':'member');}
 async function reset(){await query('UPDATE memberships SET access_revoked_at=NULL WHERE company_id=$1',[companyId]);await query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE company_id=$1 AND status IN ('queued','running')",[companyId]);}
 try{
  for(const userId of[ownerId,requesterId])await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Revocation fixture',$2,'not-a-login-password')",[userId,userId+'@example.invalid']);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Run revocation fixture',$2,'blank')",[companyId,'run-revocation-'+companyId]);
  for(const[userId,role]of[[ownerId,'owner'],[requesterId,'member']])await query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[companyId,userId,role]);
  await query("INSERT INTO agents(id,company_id,name,harness,created_by,token_hash,invocation_access,capabilities) VALUES($1,$2,'Retained-role worker','custom',$3,$4,'members','[\"workspace.read\",\"tasks.write\"]')",[agentId,companyId,ownerId,identity.token_hash]);
  await t.test('a previously authenticated worker cannot disclose, mutate or finish for a revoked distinct requester',async()=>{
   const{run}=await create(),claim={workerId:'revocation-worker',claimId:randomUUID()},held=await claimAgentRun(identity,claim);assert.equal(held.run?.id,run.id);assert(held.leaseToken);
   await revoke(requesterId);const before=await snapshot(),leaseToken=held.leaseToken;
   const denied=[
    ()=>agentRunContext(identity,run.id,leaseToken),
    ()=>heartbeatAgentRun(identity,run.id,{leaseToken}),
    ()=>transaction(client=>authorizeRunTool(client,identity,run.id,leaseToken)),
    ()=>transaction(client=>authorizeStoredAgentRun(client,identity,run.id,hashToken(leaseToken))),
    ()=>transaction(client=>authorizeStoredStorageAgentRun(client,identity,run.id,hashToken(leaseToken))),
    ()=>executeAgentTool(identity,'tasks_create',{runId:run.id,leaseToken,requestId:randomUUID(),arguments:{title:'Must not be journaled'}}),
    ()=>finishAgentRun(identity,run.id,'complete',{leaseToken,clientId:randomUUID(),result:'Must not be published'}),
    ()=>finishAgentRun(identity,run.id,'fail',{leaseToken,clientId:randomUUID(),error:'Must not change the result',retryable:false}),
    ()=>claimAgentRun(identity,claim),
   ];
   try{for(const action of denied){await assert.rejects(action,{status:403,code:'RUN_REQUESTER_ACCESS'});assert.deepEqual(await snapshot(),before);}
    // A fresh claim retains existing cleanup semantics: cancel invalid work and issue no lease.
    assert.equal((await claimAgentRun(identity,{workerId:'cleanup-worker',claimId:randomUUID()})).run,null);
    const cancelled=(await query('SELECT status,attempts,worker_id,lease_token_hash,lease_expires_at,result,result_message_id,error FROM agent_runs WHERE id=$1',[run.id])).rows[0];
    assert.deepEqual(cancelled,{status:'cancelled',attempts:1,worker_id:null,lease_token_hash:null,lease_expires_at:null,result:'',result_message_id:null,error:'Requester access ended.'});
    const after=await snapshot();for(const key of['agent_run_receipts','agent_tool_receipts','messages','conversations','tasks'])assert.deepEqual(after[key],before[key]);
   }finally{await reset();}
  });
  await t.test('a captured human membership cannot list, read, queue or cancel after timestamp revocation',async()=>{
   const{run}=await create();await revoke(requesterId);const before=await snapshot();
   try{for(const action of[()=>listAgentRuns(member,undefined),()=>getAgentRun(member,run.id),()=>create(),()=>cancelAgentRun(member,run.id)]){await assert.rejects(action,{status:403});assert.deepEqual(await snapshot(),before);}}finally{await reset();}
  });
  await t.test('a retained owner role does not keep stale sponsor authority alive',async()=>{
   const{run}=await create(),held=await claimAgentRun(identity,{workerId:'sponsor-worker',claimId:randomUUID()});assert(held.leaseToken);await revoke(ownerId);const before=await snapshot();
   try{for(const action of[()=>agentRunContext(identity,run.id,held.leaseToken!),()=>heartbeatAgentRun(identity,run.id,{leaseToken:held.leaseToken}),()=>finishAgentRun(identity,run.id,'complete',{leaseToken:held.leaseToken,clientId:randomUUID(),result:'Revoked sponsor result'}),()=>claimAgentRun(identity,{workerId:'late-worker',claimId:randomUUID()})]){await assert.rejects(action,{status:401});assert.deepEqual(await snapshot(),before);}await assert.rejects(create,{status:409,code:'AGENT_UNAVAILABLE'});assert.deepEqual(await snapshot(),before);}finally{await reset();}
  });
  await t.test('revocation committed while completion waits on the membership lock denies every result write',{skip:emulator},async()=>{
   // PGlite cannot establish independent lock-wait evidence; this runs only with the configured local PostgreSQL service.
   const{run}=await create(),held=await claimAgentRun(identity,{workerId:'waiting-worker',claimId:randomUUID()});assert(held.leaseToken);const before=await snapshot(),blocker=await database().connect();
   let committed=false,pending:Promise<unknown>|undefined,settled=false;
   await blocker.query('BEGIN');
   try{
    const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2',[companyId,requesterId]);
    pending=finishAgentRun(identity,run.id,'complete',{leaseToken:held.leaseToken,clientId:randomUUID(),result:'Must not commit after the lock wait'}).then(value=>{settled=true;return value;},error=>{settled=true;return error;});
    let waiting=false;for(let attempt=0;attempt<150;attempt++){if((await query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(waiting,true,'An independent completion transaction must actually wait on the membership row.');assert.equal(settled,false);
    await blocker.query('COMMIT');committed=true;const denied=await pending;assert.equal((denied as{status?:number}).status,403);assert.equal((denied as{code?:string}).code,'RUN_REQUESTER_ACCESS');assert.deepEqual(await snapshot(),before);
    assert.equal((await query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2',[companyId,requesterId])).rows[0].role,'member');
   }finally{if(!committed)await blocker.query('ROLLBACK');blocker.release();await pending;await reset();}
  });
 }finally{await query('DELETE FROM companies WHERE id=$1',[companyId]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,requesterId]]);await database().end();delete(globalThis as any).coatriaPool;if(stop)await stop();}
});
