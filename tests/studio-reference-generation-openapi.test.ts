import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {studioReferenceGenerationFollowupGetInput,studioReferenceGenerationFollowupDispatchInput,studioReferenceGenerationFollowupAdvanceInput} from '../src/lib/studio-reference-generation-followup-protocol';
test('external harness schemas expose exact reference continuation without replacement identities or consent',()=>{
 const spec:any=agentRuntimeOpenApi;
 for(const [name,input]of[['studio_reference_generation_followups_get',studioReferenceGenerationFollowupGetInput],['studio_reference_generation_followup_dispatch',studioReferenceGenerationFollowupDispatchInput],['studio_reference_generation_followup_advance',studioReferenceGenerationFollowupAdvanceInput]]as const){
  const operation=spec.paths['/api/agent/tools/'+name].post,envelope=operation.requestBody.content['application/json'].schema;
  assert.deepEqual(envelope.properties.arguments,{...z.toJSONSchema(input,{io:'input',unrepresentable:'any'}),type:'object'});assert.deepEqual(operation.security,[{agentBearer:[]}]);assert.equal(envelope.additionalProperties,false);
  assert.notDeepEqual(operation.responses['200'].content['application/json'].schema.properties.result,{});if(!name.endsWith('_get'))assert.equal(operation['x-coatria-approval-authority'],false);
 }
 const route=spec.paths['/api/companies/{companyId}/studio/projects/{projectId}/reference-generation-followups'];assert.deepEqual(Object.keys(route),['get']);assert.deepEqual(route.get.security,[{sessionCookie:[]}]);
 const context=spec.components.schemas.StudioReferenceGenerationFollowupContext;assert.deepEqual(context.properties.nextStep.enum,['claim','proposal','proposed']);assert.equal(spec.components.schemas.AgentRunContext.required.includes('referenceGenerationFollowup'),false);
 for(const flag of['canGenerate','canApprove','canTransfer','contentInspected'])assert.equal(context.properties[flag].const,false);
 const good={projectId:randomUUID(),workItemId:randomUUID(),step:'proposal',proposal:{tool:'generate_image',arguments:{params:{model:'fixture'}},note:'Keep exact reference'}};
 assert.equal(studioReferenceGenerationFollowupAdvanceInput.safeParse(good).success,true);
 for(const injected of[{referenceIds:[randomUUID()]},{clientId:randomUUID()},{projectRevision:2},{creditConsent:true}])assert.equal(studioReferenceGenerationFollowupAdvanceInput.safeParse({...good,proposal:{...good.proposal,...injected}}).success,false);
 assert.equal(studioReferenceGenerationFollowupAdvanceInput.safeParse({...good,step:'claim'}).success,false);
});
