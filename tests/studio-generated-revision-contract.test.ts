import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AGENT_TOOLS,studioAgentProject,studioAgentRevision} from '../src/lib/agent-tools';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';

test('external agents may draft selective creative revisions but cannot apply, alter the contract or invent source evidence',()=>{
 const tool=AGENT_TOOLS.studio_generated_revision_draft,unitId=randomUUID(),args={projectId:randomUUID(),projectRevision:5,shareId:randomUUID(),receiptId:randomUUID(),packageSha256:'a'.repeat(64),summary:'Replace the opening composition.',items:[{unitId,action:'regenerate',instructions:'Use the approved reference with more space around the subject.'}]};
 assert(tool.schema.safeParse(args).success);assert.equal(tool.capability,'studio.write');assert.deepEqual(tool.additionalCapabilities,['studio.read']);
 for(const fields of[{clientId:randomUUID()},{approvedBy:randomUUID()},{spec:{width:4096}},{costApproved:true},{items:[{unitId,action:'carry'}]},{items:[...args.items,...args.items]},{items:[{unitId,action:'carry',artifactId:randomUUID()}]}])assert.equal(tool.schema.safeParse({...args,...fields}).success,false);
 for(const name of['studio_generated_revision_apply','studio_generated_revision_approve'])assert.equal(AGENT_TOOLS[name],undefined);
 const spec:any=agentRuntimeOpenApi,apply=spec.paths['/api/companies/{companyId}/studio/projects/{projectId}/generated-revisions/{planId}/apply'].post;
 assert.deepEqual(apply.security,[{sessionCookie:[]}]);assert.deepEqual(apply.requestBody.content['application/json'].schema.required,['clientId','projectRevision','planSha256']);
 const route=spec.paths['/api/agent/tools/studio_generated_revision_draft'].post;assert.equal(route['x-coatria-approval-authority'],false);assert.deepEqual(route['x-coatria-required-capabilities'],['studio.write','studio.read']);
});

test('agent project pages show current revision work while exact historical reads remain explicitly historical',()=>{
 const unitId=randomUUID(),oldId=randomUUID(),newId=randomUUID(),roundId=randomUUID();
 const old={id:oldId,taskId:randomUUID(),shotId:unitId,title:'Original output',description:'Original brief',dependencies:[],status:'done',readiness:'accepted',revision:4};
 const current={id:newId,taskId:randomUUID(),shotId:unitId,title:'Revision output',description:'Immutable approved correction for the new round',dependencies:[],status:'todo',readiness:'blocked',revision:1};
 const detail:any={project:{id:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:'Creative revision',revision:6,spec:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}}},shots:[{id:unitId,kind:'image',code:'IMAGE01',description:'One image'}],workItems:[current],historyWorkItems:[old],generatedRound:{roundId,number:1,planSha256:'b'.repeat(64),workItemIds:[newId],finals:[]},artifacts:[],reviews:[],deliveries:[],roles:[],skills:[]};
 const original=JSON.stringify(detail),page:any=studioAgentProject(detail),exact:any=studioAgentProject(detail,{workItemId:oldId}),active:any=studioAgentProject(detail,{workItemId:newId});
 assert.deepEqual(page.workItems,[current]);assert.equal(page.historyWorkCount,1);assert.equal(page.generatedRound.roundId,roundId);assert.equal(exact.historicalWork,true);assert.equal(exact.workItem.status,'done');assert.equal(active.historicalWork,false);assert.equal(active.workItem.description,current.description);assert.equal(JSON.stringify(detail),original);
});

test('large source plans page every exact unit once within the agent byte budget',()=>{
 const units=Array.from({length:100},()=>({unitId:randomUUID(),code:'IMAGE',description:'界'.repeat(2000),mediaKind:'image',base:{artifactId:randomUUID(),reviewId:randomUUID(),storageVersionId:randomUUID(),manifestSha256:'a'.repeat(64),fileSha256:'b'.repeat(64),generationWorkItemId:randomUUID(),qcWorkItemId:randomUUID()}}));
 const snapshot:any={projectRevision:7,currentRound:null,source:{source:{shareId:randomUUID(),receiptId:randomUUID(),deliveryId:randomUUID(),packageSha256:'a'.repeat(64),sourceManifestSha256:'b'.repeat(64),clientUserId:randomUUID(),note:'Client correction',roundId:null},items:units},sourceBlockedReason:null,plan:null,plans:[],page:{hasMore:false,nextAfter:null,limit:20}};
 const before=JSON.stringify(snapshot),seen:string[]= [];let itemAfter:string|undefined;
 do{const page:any=studioAgentRevision(snapshot,{itemAfter,itemLimit:20});assert(Buffer.byteLength(JSON.stringify(page))<=96*1024);assert(page.source.items.length>0);assert.equal(page.canApply,false);seen.push(...page.source.items.map((item:any)=>item.unitId));itemAfter=page.itemPage.nextAfter??undefined;}while(itemAfter);
 assert.equal(seen.length,100);assert.equal(new Set(seen).size,100);assert.deepEqual(seen.slice().sort(),units.map(item=>item.unitId).sort());assert.equal(JSON.stringify(snapshot),before);
 assert.throws(()=>studioAgentRevision(snapshot,{itemAfter:randomUUID()}),{status:404});
});
