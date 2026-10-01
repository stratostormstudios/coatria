import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {studioGeneratedFollowupAdvanceInput,studioGeneratedFollowupDispatchInput,studioGeneratedFollowupGetInput} from '../src/lib/studio-generated-followup-protocol';

test('external harness contract exposes bounded source continuation without accepting replacement evidence',()=>{
 const spec:any=agentRuntimeOpenApi,base='/api/agent/tools/';
 for(const[name,input]of[['studio_generated_followups_get',studioGeneratedFollowupGetInput],['studio_generated_followup_dispatch',studioGeneratedFollowupDispatchInput],['studio_generated_followup_advance',studioGeneratedFollowupAdvanceInput]] as const){
  const operation=spec.paths[base+name].post,envelope=operation.requestBody.content['application/json'].schema;
  assert.deepEqual(envelope.properties.arguments,z.toJSONSchema(input,{io:'input',unrepresentable:'any'}));assert.deepEqual(envelope.required,['runId','leaseToken','requestId','arguments']);assert.deepEqual(operation.security,[{agentBearer:[]}]);assert.equal(envelope.additionalProperties,false);
  assert.notDeepEqual(operation.responses['200'].content['application/json'].schema.properties.result,{},'Continuation output must be discoverable without guessing fields');
 }
 const advance=spec.paths[base+'studio_generated_followup_advance'].post;assert.equal(advance['x-coatria-approval-authority'],false);assert.deepEqual(advance['x-coatria-required-capabilities'],['studio.write','studio.read','tasks.write','creative.read','creative.write','storage.read']);
 const route=spec.paths['/api/companies/{companyId}/studio/projects/{projectId}/generated-followups'];assert.deepEqual(Object.keys(route),['get']);assert.deepEqual(route.get.security,[{sessionCookie:[]}]);assert.deepEqual(route.get.parameters.filter((p:any)=>p.in==='query').map((p:any)=>p.name),['archiveId','after','historyAfter','limit']);
 const schemas=spec.components.schemas;assert.equal(schemas.StudioGeneratedFollowupContext.properties.serverOwnsOperationIds.const,true);for(const flag of['canGenerate','canTransfer','canApprove','contentInspected'])assert.equal(schemas.StudioGeneratedFollowupContext.properties[flag].const,false);
 assert.equal(schemas.AgentRunContext.required.includes('generatedFollowup'),false,'Ordinary run context remains compatible');assert.equal(schemas.StudioGeneratedFollowupSnapshot.properties.history.maxItems,50);assert(schemas.StudioGeneratedFollowupSnapshot.required.includes('historyNextAfter'));
});
