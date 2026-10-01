import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,transaction} from '../src/lib/db';
import {claimAgentRun,agentRunContext,finishAgentRun,heartbeatAgentRun} from '../src/lib/agent-runs';
import {executeAgentTool} from '../src/lib/agent-tools';
import {referenceGenerationFollowupRunAuthority} from '../src/lib/studio-reference-generation-followups';
import {openReferenceGenerationDatabase} from './fixtures/reference-generation';
import {confirmedReferenceGenerationFixture} from './fixtures/reference-generation-confirmed';

const providerTools=[{name:'generate_image',description:'Synthetic reviewed model',inputSchema:{type:'object',properties:{params:{type:'object',properties:{model:{type:'string',const:'fixture-model'},prompt:{type:'string'},medias:{type:'array',minItems:1,maxItems:1,items:{type:'object',properties:{role:{type:'string',enum:['image']},value:{type:'string',format:'uuid'}},required:['role','value'],additionalProperties:false}}},required:['model','medias'],additionalProperties:false}},required:['params'],additionalProperties:false}}];
const proposal={tool:'generate_image',arguments:{params:{model:'fixture-model',prompt:'Original task objective.'}},note:'Exact reference; separate human generation credit approval required.'};
async function fixture(){
 const f=await confirmedReferenceGenerationFixture({providerTools});
 const parent=(await f.api(`companies/${f.company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:f.coordinator.id,prompt:'Continue the reviewed reference-generation handoff.'},201)).run;
 const parentLease=await claimAgentRun(f.coordinator as any,{workerId:'next-coordinator',claimId:randomUUID()});assert.equal(parentLease.run!.id,parent.id);
 const dispatchArgs={projectId:f.project,workItemId:f.work,referenceId:f.reference!.id,projectRevision:f.projectRevision,policyRevision:f.policy.revision};
 const dispatch=(requestId=randomUUID())=>executeAgentTool(f.coordinator as any,'studio_reference_generation_followup_dispatch',{runId:parent.id,leaseToken:parentLease.leaseToken!,requestId,arguments:dispatchArgs});
 const result=await dispatch(),child=(result.result as any).continuation;
 const lease=await claimAgentRun(f.producer as any,{workerId:'fresh-specialist',claimId:randomUUID()});assert.equal(lease.run?.id,child.childRunId);
 const advance=(step:'claim'|'proposal',override:Record<string,any>={},requestId=randomUUID())=>executeAgentTool(f.producer as any,'studio_reference_generation_followup_advance',{runId:child.childRunId,leaseToken:lease.leaseToken!,requestId,arguments:{projectId:f.project,workItemId:f.work,step,...step==='proposal'?{proposal}:{},...override}});
 return {...f,parent,parentLease,dispatch,dispatchArgs,child,lease,advance};
}
test('actual reference continuation API keeps exact source, separate approvals and idempotent actions',{timeout:180000},async t=>{
 const db=await openReferenceGenerationDatabase();
 try{
  const f=await fixture();
  await t.test('fresh run and history share finite policy without reviving original worker',async()=>{
   assert.notEqual(f.child.childRunId,f.sourceLease.run!.id);
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[f.sourceLease.run!.id])).rows[0].status,'succeeded');
   assert.equal((await query('SELECT runs_started FROM studio_coordination_policies WHERE company_id=$1',[f.company])).rows[0].runs_started,2);
   const again=(await f.dispatch()).result as any;assert.equal(again.replayed,true);assert.equal(again.continuation.childRunId,f.child.childRunId);
   const page=await f.api(`companies/${f.company}/studio/projects/${f.project}/reference-generation-followups?referenceId=${f.reference!.id}`);
   assert.equal(page.history.length,1);assert.equal(page.candidates[0].eligible,false);
   const context=await agentRunContext(f.producer as any,f.child.childRunId,f.lease.leaseToken!);assert.deepEqual(context.messages,[]);assert.equal(context.referenceGenerationFollowup?.nextStep,'claim');
   await assert.rejects(finishAgentRun(f.producer as any,f.child.childRunId,'complete',{leaseToken:f.lease.leaseToken!,clientId:randomUUID(),result:'Not yet proposed.'}),{code:'REFERENCE_GENERATION_FOLLOWUP_INCOMPLETE'});
  });
  await t.test('one claim survives new transport IDs and cannot broaden task, reference or delegation',async()=>{
   const first=(await f.advance('claim')).result as any,again=(await f.advance('claim')).result as any;
   assert.equal(first.task.revision,3);assert.equal(again.replayed,true);assert.equal(again.task.revision,3);
   for(const [name,args]of [['tasks_claim',{taskId:f.task,revision:3}],['higgsfield_generation_propose',{...proposal,projectId:f.project,projectRevision:f.projectRevision,workItemId:f.work}],['studio_reference_generation_followup_dispatch',f.dispatchArgs],['storage_file_access',{projectId:f.project,versionId:f.version}] ] as const){
    await assert.rejects(executeAgentTool(f.producer as any,name,{runId:f.child.childRunId,leaseToken:f.lease.leaseToken!,requestId:randomUUID(),arguments:args}),{code:'REFERENCE_GENERATION_FOLLOWUP_SCOPE'});
   }
   const context=await agentRunContext(f.producer as any,f.child.childRunId,f.lease.leaseToken!);assert.equal(context.referenceGenerationFollowup?.nextStep,'proposal');
  });
  await t.test('current source and exact task changes fence the live worker',async()=>{
   const mutations:[string,unknown[]][]=[
    ["UPDATE studio_coordination_policies SET status='paused' WHERE company_id=$1",[f.company]],
    ["UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1",[f.company]],
    ['UPDATE agents SET token_hash=$2 WHERE id=$1',[f.producer.id,'0'.repeat(64)]],
    ['UPDATE tasks SET revision=revision+1 WHERE id=$1',[f.task]],
    ["UPDATE tasks SET title='Different objective' WHERE id=$1",[f.task]],
    ['UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[f.project]],
    ['DELETE FROM studio_requests WHERE client_id=(SELECT claim_request_id FROM studio_reference_generation_followups WHERE child_run_id=$1)',[f.child.childRunId]],
    ["UPDATE memberships SET access_revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2",[f.company,f.admin]],
   ];
   for(const [sql,args]of mutations)await transaction(async client=>{
    await client.query('SAVEPOINT drift');await client.query(sql,args);
    const run=(await client.query('SELECT * FROM agent_runs WHERE id=$1',[f.child.childRunId])).rows[0];
    assert.equal(await referenceGenerationFollowupRunAuthority(client,f.company,run),false,sql);await client.query('ROLLBACK TO SAVEPOINT drift');
   });
   assert.equal((await agentRunContext(f.producer as any,f.child.childRunId,f.lease.leaseToken!)).referenceGenerationFollowup?.nextStep,'proposal');
  });
  await t.test('proposal uses only server-pinned media, retries exactly, and spends nothing',async()=>{
   const first=(await f.advance('proposal')).result as any,again=(await f.advance('proposal')).result as any;
   assert.equal(again.replayed,true);assert.equal(first.request.id,again.request.id);assert.deepEqual(first.request.referenceIds,[f.reference!.id]);
   assert.deepEqual(first.request.arguments.params.medias,[{role:'image',value:f.mediaId}]);assert.equal(first.request.status,'proposed');
   await assert.rejects(f.advance('proposal',{proposal:{...proposal,note:'Changed retry'}}),{code:'IDEMPOTENCY_CONFLICT'});
   assert.equal((await query('SELECT count(*)::int AS n FROM higgsfield_requests WHERE run_id=$1',[f.child.childRunId])).rows[0].n,1);
   assert.equal((await query('SELECT revision FROM studio_projects WHERE id=$1',[f.project])).rows[0].revision,f.projectRevision);
   const completion={leaseToken:f.lease.leaseToken!,clientId:randomUUID(),result:'Saved exact generation proposal '+first.request.id+'; awaiting independent credit consent.'};
   const done=await finishAgentRun(f.producer as any,f.child.childRunId,'complete',completion);assert.equal(done.run.status,'succeeded');
   assert.equal((await finishAgentRun(f.producer as any,f.child.childRunId,'complete',completion)).replayed,true);
  });
  await t.test('policy pause denies context, heartbeat, cached tool and completion',async()=>{
   const g=await fixture();const claimId=randomUUID();await g.advance('claim',{},claimId);
   await query("UPDATE studio_coordination_policies SET status='paused' WHERE company_id=$1",[g.company]);
   for(const operation of [()=>agentRunContext(g.producer as any,g.child.childRunId,g.lease.leaseToken!),()=>heartbeatAgentRun(g.producer as any,g.child.childRunId,{leaseToken:g.lease.leaseToken!}),()=>g.advance('claim',{},claimId),()=>finishAgentRun(g.producer as any,g.child.childRunId,'complete',{leaseToken:g.lease.leaseToken!,clientId:randomUUID(),result:'Stale authority.'})])await assert.rejects(operation,{code:'REFERENCE_GENERATION_FOLLOWUP_AUTHORITY_ENDED'});
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[g.child.childRunId])).rows[0].status,'running');
   assert.equal((await query('SELECT count(*)::int AS n FROM higgsfield_requests WHERE run_id=$1',[g.child.childRunId])).rows[0].n,0);
  });
 }finally{await db.close();}
});
