import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import {database as applicationDatabase,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {claimAgentRun,finishAgentRun} from '../src/lib/agent-runs';
import {executeAgentTool} from '../src/lib/agent-tools';
import {dispatchStudioGeneratedFollowup,studioGeneratedFollowupSnapshot} from '../src/lib/studio-generated-followups';
import {loadStoredGeneratedArtifact} from '../src/lib/studio-generated-artifacts';
import {openReferenceGenerationDatabase} from './fixtures/reference-generation';
import {confirmedReferenceGenerationFixture} from './fixtures/reference-generation-confirmed';

type Row=Record<string,any>;
const providerTools=[{name:'generate_image',description:'Synthetic reviewed model',inputSchema:{type:'object',properties:{params:{type:'object',properties:{model:{type:'string',const:'fixture-model'},prompt:{type:'string'},medias:{type:'array',minItems:1,maxItems:1,items:{type:'object',properties:{role:{type:'string',enum:['image']},value:{type:'string',format:'uuid'}},required:['role','value'],additionalProperties:false}}},required:['model','medias'],additionalProperties:false}},required:['params'],additionalProperties:false}}];
const insert=async(table:string,row:Row,db:{query:typeof query}={query})=>{
 const keys=Object.keys(row);
 return (await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row))).rows[0];
};
async function successorDispatchFixture(){
 const f=await confirmedReferenceGenerationFixture({generatedContinuations:true,providerTools});assert(f.reference);assert(f.handoff);
 const parent=(await f.api(`companies/${f.company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:f.coordinator.id,prompt:'Coordinate the exact synthetic continuation.'},201)).run;
 const parentLease=await claimAgentRun(f.coordinator as any,{workerId:'archive-lineage-parent',claimId:randomUUID()});assert.equal(parentLease.run!.id,parent.id);
 const dispatchSuccessor=(requestId=randomUUID())=>executeAgentTool(f.coordinator as any,'studio_reference_generation_followup_dispatch',{runId:parent.id,leaseToken:parentLease.leaseToken!,requestId,arguments:{projectId:f.project,projectRevision:f.projectRevision,workItemId:f.work,referenceId:f.reference!.id,policyRevision:f.policy.revision}});
 return {...f,parent,parentLease,dispatchSuccessor};
}

// This fixture proves relational/source authority with synthetic metadata. Its
// phase results and archived media facts are not byte-processing/provider proof.
// Every migration/constraint stays enabled. The actual successor dispatch,
// lease, claim, proposal and completion lead into real archive continuation tools.
async function archivedSuccessor(){
 const f=await successorDispatchFixture();assert(f.reference);const {parent,parentLease}=f;
 const dispatched=(await f.dispatchSuccessor()).result as Row;
 const continued=(await query('SELECT * FROM studio_reference_generation_followups WHERE company_id=$1 AND child_run_id=$2',[f.company,dispatched.continuation.childRunId])).rows[0];
 const producerLease=await claimAgentRun(f.producer as any,{workerId:'actual-generation-successor',claimId:randomUUID()});assert.equal(producerLease.run!.id,continued.child_run_id);
 const advance=(step:'claim'|'proposal')=>executeAgentTool(f.producer as any,'studio_reference_generation_followup_advance',{runId:continued.child_run_id,leaseToken:producerLease.leaseToken!,requestId:randomUUID(),arguments:{projectId:f.project,workItemId:f.work,step,...step==='proposal'?{proposal:{tool:'generate_image',arguments:{params:{model:'fixture-model',prompt:'Original task objective.'}},note:'Exact prepared reference. Human generation credit consent remains separate.'}}:{}}});
 await advance('claim');const proposal=(await advance('proposal')).result as Row;
 assert.equal(proposal.request.status,'proposed');assert.deepEqual(proposal.request.referenceIds,[f.reference.id]);assert.deepEqual(proposal.request.arguments.params.medias,[{role:'image',value:f.mediaId}]);
 const done=await finishAgentRun(f.producer as any,continued.child_run_id,'complete',{clientId:randomUUID(),leaseToken:producerLease.leaseToken!,result:'Saved exact generation proposal '+proposal.request.id+'; no provider request was made.'});assert.equal(done.run.status,'succeeded');
 const requestId=proposal.request.id as string,jobId=randomUUID(),outputId=randomUUID(),providerJobId=randomUUID(),requestHash=proposal.request.requestHash as string,receiptHash=hashToken('receipt:'+requestId),identity=hashToken(outputId),bytes=512,fileHash=hashToken('synthetic-output:'+requestId);
 // Synthetic reviewed output receipts below replace paid generation and byte
 // transfer. They leave the actual request identity and successor lineage intact.
 await query("UPDATE higgsfield_requests SET status='returned',approved_by=$2 WHERE id=$1",[requestId,f.admin]);
 await insert('higgsfield_job_receipts',{company_id:f.company,project_id:f.project,request_id:requestId,connection_id:f.providerId,connection_revision:1,approved_by:f.admin,request_hash:requestHash,contract:'synthetic-reviewed-contract',source_sha256:receiptHash,outcome:'jobs'});
 await insert('higgsfield_jobs',{id:jobId,company_id:f.company,project_id:f.project,request_id:requestId,connection_id:f.providerId,provider_job_id:providerJobId,kind:'image',status:'completed'});
 await insert('higgsfield_job_outputs',{id:outputId,company_id:f.company,project_id:f.project,job_id:jobId,kind:'image',ordinal:0,locator_identity:identity});
 const archiveId=randomUUID(),fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID(),name='generated-output.png';
 await insert('project_storage_files',{id:fileId,company_id:f.company,project_id:f.project,binding_id:f.binding.id,name,name_key:name,created_by:f.owner});
 await insert('project_storage_versions',{id:versionId,company_id:f.company,project_id:f.project,file_id:fileId,version:1,bytes,sha256:fileHash,content_type:'image/png',object_key:`coatria/companies/${f.company}/projects/${f.project}/objects/${versionId}`,created_by:f.owner});
 const source={requestId,requestHash,receiptHash,contract:'synthetic-reviewed-contract',providerConnectionId:f.providerId,requestConnectionRevision:1,providerSponsorId:f.owner,providerJobId,kind:'image',model:null,outputId,ordinal:0,outputIdentity:identity,requestedBy:f.owner,agentId:f.producer.id,runId:continued.child_run_id,agentSponsorId:f.owner,approvedBy:f.admin,workItemId:f.work,roleAgentId:f.producer.id,roleHumanId:null,taskId:f.task,roleKey:'comp'};
 const binding=(await query('SELECT * FROM project_storage_bindings WHERE id=$1',[f.binding.id])).rows[0];
 await transaction(async db=>{
  await insert('higgsfield_output_archives',{id:archiveId,company_id:f.company,project_id:f.project,request_id:requestId,job_id:jobId,output_id:outputId,locator_identity:identity,source_snapshot:JSON.stringify(source),provider_connection_id:f.providerId,provider_connection_revision:1,storage_binding_id:f.binding.id,storage_binding_revision:binding.revision,storage_connection_id:f.connection.id,storage_connection_revision:f.connection.revision,storage_connection_snapshot:JSON.stringify({id:f.connection.id,region:'US-CA-2',volumeId:'synthetic-volume',sponsorId:f.owner,revision:f.connection.revision}),destination_name:name,destination_name_key:name,destination_ancestors:'[]',max_bytes:2048,project_revision:f.projectRevision,request_hash:hashToken(archiveId),proposed_by:f.admin,status:'verified',approved_by:f.admin,approved_at:'2026-01-01T00:00:00Z',expires_at:'2026-01-02T00:00:00Z',approved_project_revision:f.projectRevision,approved_binding_revision:binding.revision,upload_id:uploadId,version_id:versionId},db);
  await insert('project_storage_uploads',{id:uploadId,company_id:f.company,project_id:f.project,version_id:versionId,actor_key:'archive:'+archiveId,actor_user_id:f.admin,archive_id:archiveId,client_id:randomUUID(),request_hash:hashToken(uploadId),status:'ready',part_bytes:67108864,provider_etag:'synthetic-output-etag',expires_at:'2026-01-02T00:00:00Z'},db);
 });
 const media={kind:'image',format:'png',contentType:'image/png',bytes,sha256:fileHash,verification:'full_decode',inspectionVersion:1,width:96,height:64,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}};
 await insert('higgsfield_archive_fetches',{company_id:f.company,project_id:f.project,archive_id:archiveId,locator_identity:identity,bytes,sha256:fileHash,media:JSON.stringify(media)});
 await insert('project_storage_verifications',{company_id:f.company,project_id:f.project,version_id:versionId,bytes,sha256:fileHash,provider_etag:'synthetic-output-etag',gateway_receipt_id:randomUUID()});
 const snapshot=(db:PoolClient)=>studioGeneratedFollowupSnapshot(db,f.company,{projectId:f.project,archiveId});
 const dispatch=async()=>executeAgentTool(f.coordinator as any,'studio_generated_followup_dispatch',{runId:parent.id,leaseToken:parentLease.leaseToken!,requestId:randomUUID(),arguments:{projectId:f.project,projectRevision:(await query('SELECT revision FROM studio_projects WHERE id=$1',[f.project])).rows[0].revision,workItemId:f.work,archiveId,policyRevision:f.policy.revision}});
 return {...f,continued,source,requestId,archiveId,versionId,fileHash,snapshot,dispatch,archiveParentId:parent.id};
}

test('archive continuation accepts only the exact immutable reference-generation producer lineage',{timeout:180000},async t=>{
 const database=await openReferenceGenerationDatabase();
 try{
  const f=await archivedSuccessor();
  await t.test('candidate keeps actual successor attribution and rejects alternate request, reference and claim lineage',async()=>{
   const candidate=(await transaction(f.snapshot)).candidates[0];assert.equal(candidate.eligible,true);assert.equal(candidate.sourceChildRunId,f.continued.child_run_id);assert.notEqual(candidate.sourceChildRunId,f.sourceLease.run!.id);
   const changes:[string,unknown[]][]=[
    ['UPDATE higgsfield_requests SET client_id=$2 WHERE id=$1',[f.requestId,randomUUID()]],
    ['UPDATE higgsfield_requests SET reference_ids=$2,reference_snapshot=NULL,model_snapshot=NULL WHERE id=$1',[f.requestId,[]]],
    ['UPDATE higgsfield_requests SET reference_ids=$2 WHERE id=$1',[f.requestId,[f.reference!.id,randomUUID()]]],
    ['UPDATE higgsfield_requests SET task_revision=task_revision+1 WHERE id=$1',[f.requestId]],
    ["UPDATE higgsfield_requests SET reference_snapshot=jsonb_set(reference_snapshot,'{references,0,mediaId}',to_jsonb($2::text)) WHERE id=$1",[f.requestId,randomUUID()]],
    ['DELETE FROM studio_requests WHERE client_id=$1',[f.continued.claim_request_id]],
    ['UPDATE studio_requests SET request_hash=$2 WHERE client_id=$1',[f.continued.claim_request_id,'0'.repeat(64)]],
    ["UPDATE studio_requests SET response=jsonb_set(response,'{task,agentRunId}',to_jsonb($2::text)) WHERE client_id=$1",[f.continued.claim_request_id,f.sourceLease.run!.id]],
    ['DELETE FROM studio_reference_generation_followup_steps WHERE child_run_id=$1 AND step=$2',[f.continued.child_run_id,'proposal']],
   ];
   for(const [sql,args]of changes)await transaction(async db=>{await db.query('SAVEPOINT changed_lineage');await db.query(sql,args);assert.equal((await f.snapshot(db)).candidates[0].eligible,false,sql);await db.query('ROLLBACK TO SAVEPOINT changed_lineage');});
   assert.equal((await transaction(f.snapshot)).candidates[0].eligible,true);
   assert.equal((await query('SELECT runs_started FROM studio_coordination_policies WHERE company_id=$1',[f.company])).rows[0].runs_started,2);
  });
  await t.test('a generation successor cannot delegate and its active slot counts toward archive concurrency',async()=>{
   const args={projectId:f.project,projectRevision:f.projectRevision,workItemId:f.work,archiveId:f.archiveId,policyRevision:f.policy.revision};
   const source=(await query('SELECT * FROM agent_runs WHERE id=$1',[f.continued.child_run_id])).rows[0];
   await assert.rejects(transaction(db=>dispatchStudioGeneratedFollowup(db,f.producer,source,args)),{code:'COORDINATION_NESTED_DISPATCH'});
   await assert.rejects(transaction(async db=>{
    await db.query("UPDATE agent_runs SET status='queued',finished_at=NULL WHERE id=$1",[f.continued.child_run_id]);
    const parent=(await db.query('SELECT * FROM agent_runs WHERE id=$1',[f.archiveParentId])).rows[0];
    return dispatchStudioGeneratedFollowup(db,f.coordinator,parent,args);
   }),{code:'COORDINATION_CONCURRENCY'});
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[f.continued.child_run_id])).rows[0].status,'succeeded');
  });
  await t.test('one archive child claims, registers and submits without relabeling the actual generation run',async()=>{
   const first=(await f.dispatch()).result as Row,again=(await f.dispatch()).result as Row;assert.equal(again.replayed,true);assert.equal(again.continuation.childRunId,first.continuation.childRunId);assert.equal(first.continuation.sourceChildRunId,f.continued.child_run_id);
   const lease=await claimAgentRun(f.producer as any,{workerId:'archive-registration',claimId:randomUUID()});assert.equal(lease.run!.id,first.continuation.childRunId);
   let artifactId='';
   for(const step of ['claim','register','submit']){
    const advance=()=>executeAgentTool(f.producer as any,'studio_generated_followup_advance',{runId:lease.run!.id,leaseToken:lease.leaseToken!,requestId:randomUUID(),arguments:{projectId:f.project,workItemId:f.work,step}});
    const saved=(await advance()).result as Row,replay=(await advance()).result as Row;assert.equal(replay.replayed,true);if(step==='register')artifactId=saved.artifact.id;
   }
   const stored=await transaction(db=>loadStoredGeneratedArtifact(db,f.company,f.project,artifactId,{requireAvailable:true}));
   assert.equal(stored.sourceSnapshot.runId,f.continued.child_run_id);assert.equal(stored.registeredRunId,lease.run!.id);assert.equal(stored.requestId,f.requestId);assert.equal(stored.fileFacts.sha256,f.fileHash);
   assert.equal((await query('SELECT status FROM tasks WHERE id=$1',[f.task])).rows[0].status,'review');
   assert.equal((await query('SELECT runs_started FROM studio_coordination_policies WHERE company_id=$1',[f.company])).rows[0].runs_started,3);
   assert.equal((await query('SELECT count(*)::int n FROM studio_generated_followups WHERE company_id=$1',[f.company])).rows[0].n,1);
   assert.equal((await query('SELECT count(*)::int n FROM higgsfield_requests WHERE company_id=$1',[f.company])).rows[0].n,1);
   const complete=await finishAgentRun(f.producer as any,lease.run!.id,'complete',{clientId:randomUUID(),leaseToken:lease.leaseToken!,result:'Registered artifact '+artifactId+' and submitted for independent review.'});assert.equal(complete.run.status,'succeeded');
   assert.equal(database.outbound(),0);
  });
  for(const ended of ['paused','expired'] as const)await t.test(`a queued generation successor is cancelled before lease issuance when policy is ${ended}`,async()=>{
   const g=await successorDispatchFixture(),child=((await g.dispatchSuccessor()).result as Row).continuation.childRunId;
   await query(ended==='paused'?"UPDATE studio_coordination_policies SET status='paused' WHERE company_id=$1":"UPDATE studio_coordination_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1",[g.company]);
   const claim=await claimAgentRun(g.producer as any,{workerId:'stale-queued-successor',claimId:randomUUID()});
   assert.equal(claim.run,null);assert.equal('leaseToken' in claim,false);
   const stopped=(await query('SELECT status,attempts,lease_token_hash,lease_expires_at FROM agent_runs WHERE id=$1',[child])).rows[0];
   assert.deepEqual(stopped,{status:'cancelled',attempts:0,lease_token_hash:null,lease_expires_at:null});
   assert.equal((await query('SELECT runs_started FROM studio_coordination_policies WHERE company_id=$1',[g.company])).rows[0].runs_started,2);
   assert.equal((await query('SELECT count(*)::int n FROM higgsfield_requests WHERE run_id=$1',[child])).rows[0].n,0);
   assert.equal((await query('SELECT agent_run_id FROM tasks WHERE id=$1',[g.task])).rows[0].agent_run_id,g.sourceLease.run!.id);
   assert.equal(database.outbound(),0);
  });
  await t.test('native PostgreSQL concurrent transport IDs dispatch one reference-generation child and one budget increment',{skip:!database.native,timeout:30000},async()=>{
   const g=await successorDispatchFixture(),requestIds=[randomUUID(),randomUUID()];
   const lock=await applicationDatabase().connect();let pending:Promise<PromiseSettledResult<Awaited<ReturnType<typeof g.dispatchSuccessor>>>[]>|undefined;
   let outcomes:Awaited<NonNullable<typeof pending>>=[];
   try{
    await lock.query('BEGIN');await lock.query('SELECT id FROM agent_runs WHERE company_id=$1 AND id=$2 FOR UPDATE',[g.company,g.parent.id]);
    pending=Promise.allSettled(requestIds.map(requestId=>g.dispatchSuccessor(requestId)));
    // Both independent connections must reach a database lock wait before the
    // blocker is released. PGlite serialization is explicitly not this proof.
    const until=Date.now()+10000;let waiting=0;
    while(Date.now()<until){waiting=Number((await query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows[0].n);if(waiting>=2)break;await delay(25);}
    assert(waiting>=2,'Both concurrent dispatch transactions must contend before release');
   }finally{
    try{await lock.query('ROLLBACK');}finally{lock.release();if(pending)outcomes=await pending;}
   }
   const results=outcomes.map(result=>{if(result.status==='rejected')throw result.reason;return result.value.result as Row;});
   assert.equal(results.length,2);assert.equal(results[0].continuation.childRunId,results[1].continuation.childRunId);
   assert.deepEqual(results.map(result=>result.replayed).sort(),[false,true]);
   const rows=(await query('SELECT child_run_id FROM studio_reference_generation_followups WHERE company_id=$1 AND handoff_id=$2',[g.company,g.handoff!.id])).rows;
   assert.deepEqual(rows,[{child_run_id:results[0].continuation.childRunId}]);
   assert.equal((await query('SELECT runs_started FROM studio_coordination_policies WHERE company_id=$1',[g.company])).rows[0].runs_started,2);
   assert.equal((await query('SELECT count(*)::int n FROM agent_runs WHERE company_id=$1 AND agent_id=$2 AND id<>$3',[g.company,g.producer.id,g.sourceLease.run!.id])).rows[0].n,1);
   for(const requestId of requestIds)assert.equal(((await g.dispatchSuccessor(requestId)).result as Row).continuation.childRunId,rows[0].child_run_id);
   assert.equal((await query('SELECT count(*)::int n FROM higgsfield_requests WHERE company_id=$1',[g.company])).rows[0].n,0);
   assert.equal(database.outbound(),0);
  });
 }finally{await database.close();}
});
