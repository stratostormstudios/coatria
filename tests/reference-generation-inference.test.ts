/** Real control-plane fixture; prepared/stored byte receipts are synthetic.
 * No provider inference, transfer or native decode is performed by this test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {agentRunContext,claimAgentRun,authorizeRunTool,authorizeStoredAgentRun,authorizeStoredStorageAgentRun} from '../src/lib/agent-runs';
import {executeAgentTool} from '../src/lib/agent-tools';
import {buildStudioInferenceRequest} from '../src/lib/studio-inference';
import {referenceGenerationFollowupToolNames} from '../src/lib/studio-reference-generation-followups';
import {openReferenceGenerationDatabase} from './fixtures/reference-generation';
import {confirmedReferenceGenerationFixture} from './fixtures/reference-generation-confirmed';

test('actual confirmed-reference child produces the bounded broker catalog and cannot become a storage principal',{timeout:90000},async()=>{
 const db=await openReferenceGenerationDatabase();try{
  const f=await confirmedReferenceGenerationFixture();
  const parent=(await f.api(`companies/${f.company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:f.coordinator.id,prompt:'Continue exact confirmed reference.'},201)).run;
  const coordinator=await claimAgentRun(f.coordinator as any,{workerId:'inference-coordinator',claimId:randomUUID()});assert.equal(coordinator.run?.id,parent.id);
  const queued=(await executeAgentTool(f.coordinator as any,'studio_reference_generation_followup_dispatch',{runId:parent.id,leaseToken:coordinator.leaseToken!,requestId:randomUUID(),arguments:{projectId:f.project,workItemId:f.work,referenceId:f.reference!.id,projectRevision:f.projectRevision,policyRevision:f.policy.revision}})).result as any;
  const worker=await claimAgentRun(f.producer as any,{workerId:'inference-specialist',claimId:randomUUID()});assert.equal(worker.run?.id,queued.continuation.childRunId);
  const runId=worker.run!.id,expected=(await agentRunContext(f.producer as any,runId,worker.leaseToken!)).referenceGenerationFollowup;
  const state=async()=>({runs:(await query('SELECT id,status,attempts FROM agent_runs WHERE company_id=$1 ORDER BY id',[f.company])).rows,requests:(await query('SELECT id FROM higgsfield_requests WHERE company_id=$1 ORDER BY id',[f.company])).rows,tools:(await query('SELECT request_id FROM agent_tool_receipts WHERE company_id=$1 ORDER BY request_id',[f.company])).rows});
  const before=await state(),reads:string[]=[];
  const request=await transaction(async client=>{
   const access=await authorizeRunTool(client,f.producer as any,runId,worker.leaseToken!);
   const assemblyClient={query:async(sql:string,values:any[])=>{reads.push(sql);return client.query(sql,values);}} as any;
   return buildStudioInferenceRequest(assemblyClient,{...access,installation:{runtimeConfig:{modelId:'synthetic-model-only'}}});
  });
  assert(reads.some(sql=>sql.includes('studio_reference_generation_followups')));
  assert(!reads.some(sql=>sql.includes('FROM messages')||sql.includes('FROM conversations')),'Scoped model assembly does not load nearby chat.');
  assert.equal(request.messages.length,2);assert.equal(request.model,'synthetic-model-only');
  const prompt=JSON.parse(request.messages[1].content);assert.deepEqual(prompt.referenceGenerationFollowup,expected);assert.deepEqual(prompt.untrustedConversationContext,{messages:[]});
  assert.deepEqual(request.tools?.map(tool=>tool.function.name).sort(),[...referenceGenerationFollowupToolNames].sort());
  assert(Buffer.byteLength(JSON.stringify(request.tools))<7000);assert(Buffer.byteLength(JSON.stringify(expected))<4096);
  assert(!/secret_envelope|token_hash|object_key|uploadUrl|claim_request_id|proposal_request_id|leaseToken/.test(request.messages[1].content));
  assert.deepEqual(await state(),before);assert.equal(db.outbound(),0);
  await transaction(client=>authorizeStoredAgentRun(client,f.producer as any,runId,hashToken(worker.leaseToken!)));
  await assert.rejects(()=>transaction(client=>authorizeStoredStorageAgentRun(client,f.producer as any,runId,hashToken(worker.leaseToken!))),{code:'REFERENCE_GENERATION_FOLLOWUP_SCOPE'});
 }finally{await db.close();}
});
