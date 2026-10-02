import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {studioAgentProject} from '../src/lib/agent-tools';
import {studioPlanningContext} from '../src/lib/studio-planning-context';

function fixture(){
 const sponsor=randomUUID(),producer=randomUUID();
 const work=(stage:string,dependencies:string[]=[])=>({id:randomUUID(),taskId:randomUUID(),title:stage,stage,roleKey:'producer',shotId:null,dependencies,status:'todo',readiness:'ready',blockedReason:null,revision:1,execution:'agent',agentId:producer,humanId:null});
 const estimate=work('estimate'),breakdown=work('breakdown',[estimate.id]),references=work('references',[breakdown.id]),generation={...work('generation',[references.id]),execution:'creative'},qc={...work('qc',[generation.id]),execution:'human'},delivery={...work('delivery',[qc.id]),execution:'human'};
 const detail:any={project:{id:randomUUID(),contractVersion:2,name:'Bounded pilot',brief:'One generation only. No retries are authorized.',spec:{kind:'image',format:'png',width:16,height:16},aiPolicy:'unknown',revision:1,gates:{brief:{decision:'approved'},production:{decision:'changes_requested'}}},shots:[{id:randomUUID(),kind:'image',code:'GEN001',description:'A synthetic still.'}],workItems:[estimate,breakdown,references,generation,qc,delivery],roles:[{key:'producer',agentId:producer,humanId:null,agentSponsorId:sponsor},{key:'qc',agentId:null,humanId:sponsor,agentSponsorId:null}],skills:[],artifacts:[],reviews:[],deliveries:[]};
 return {detail,estimate,breakdown,references,generation,sponsor};
}

test('exact project-level planning includes complete scope, actual handoffs and unresolved reviewer independence',()=>{
 const {detail,estimate}=fixture(),before=JSON.stringify(detail),response:any=studioAgentProject(detail,{workItemId:estimate.id}),context=response.planningContext;
 assert.deepEqual(response.shots,[]);assert.equal(context.scope.deliverableCount,1);assert.equal(context.scope.counts.image,1);
 assert.deepEqual(context.workflow.stages.map((stage:any)=>[stage.stage,stage.requiresAcceptedStages]),[['estimate',[]],['breakdown',['estimate']],['references',['breakdown']],['generation',['references']],['qc',['generation']],['delivery',['qc']]]);
 assert.deepEqual(context.workflow.stages[0].requiredBusinessGates,['brief']);assert.deepEqual(context.workflow.stages[3].requiredBusinessGates,['brief','production']);
 assert.equal(context.businessGates.estimate,'not_recorded');assert.equal(context.businessGates.production,'changes_requested');assert.equal(context.businessGates.aiPolicy,'unknown');
 assert.equal(context.review.assignment,'potential_sponsor_conflict');assert.deepEqual(context.review.conflictingSponsorRoleKeys,['producer']);assert.equal(context.review.independenceVerified,false);
 assert.equal(context.generation.approvalsIncluded,false);assert.equal(context.generation.deliverableCountIsNotGenerationAllowance,true);assert.equal(context.generation.automaticRetriesAuthorized,false);assert.equal(context.grantsAuthority,false);
 assert.equal(response.project.brief,detail.project.brief);assert.equal(JSON.stringify(detail),before);
});

test('QC absence or a different assignee never becomes proof of reviewer eligibility',()=>{
 const {detail,estimate}=fixture();detail.roles[1].humanId=null;
 assert.equal(studioPlanningContext(detail,estimate as any)?.review.assignment,'unassigned');
 detail.roles[1].humanId=randomUUID();const context=studioPlanningContext(detail,estimate as any)!;
 assert.equal(context.review.assignment,'independence_unverified');assert.equal(context.review.independenceVerified,false);assert.deepEqual(context.review.conflictingSponsorRoleKeys,[]);
});

test('large planning context bounds previews without losing total scope or accepted-stage counts',()=>{
 const {detail,estimate,breakdown,references}=fixture();
 detail.project.brief='b'.repeat(12000);detail.shots=Array.from({length:100},(_,index)=>({id:randomUUID(),kind:'image',code:'GEN'+index,description:'🎬'.repeat(2000)}));
 detail.workItems=[estimate,breakdown,...Array.from({length:900},(_,index)=>({...references,id:randomUUID(),status:index<320?'done':'todo'}))];
 const exact:any=studioAgentProject(detail,{workItemId:estimate.id}),context=exact.planningContext;
 assert.equal(context.scope.deliverableCount,100);assert.equal(context.scope.previews.length,8);assert.equal(context.scope.previewsTruncated,true);assert.equal(Array.from(context.scope.previews[0].descriptionPreview).length,120);assert.equal(context.scope.previews[0].descriptionTruncated,true);
 assert.equal(context.workflow.stages.find((stage:any)=>stage.stage==='references').workCount,900);assert.equal(context.workflow.stages.find((stage:any)=>stage.stage==='references').acceptedCount,320);assert(Buffer.byteLength(JSON.stringify(exact))<96*1024);
});

test('historical work is labelled against the current workflow and missing or capped handoffs are explicit',()=>{
 const {detail,estimate,generation}=fixture();detail.historyWorkItems=[estimate];detail.workItems=[generation];
 detail.generatedRound={roundId:randomUUID(),number:1,planSha256:'a'.repeat(64),workItemIds:[generation.id],finals:[]};
 const exact:any=studioAgentProject(detail,{workItemId:estimate.id});assert.equal(exact.historicalWork,true);assert.equal(exact.planningContext.workflow.selectedWorkIsCurrent,false);assert.equal(exact.planningContext.workflow.scope,'current_project_work');assert.deepEqual(exact.planningContext.workflow.stages.map((s:any)=>s.stage),['generation']);assert.equal(exact.planningContext.workflow.stages[0].unresolvedDependencyCount,1);
 detail.workItems=Array.from({length:25},(_,i)=>({...estimate,id:randomUUID(),stage:'synthetic_'+i}));detail.workItems.push({...estimate,dependencies:detail.workItems.map((item:any)=>item.id)});
 const bounded=studioPlanningContext(detail,estimate as any)!;assert.equal(bounded.workflow.stages.length,20);assert.equal(bounded.workflow.stagesTruncated,true);assert.equal(bounded.workflow.stages[0].requiresAcceptedStages.length,20);assert.equal(bounded.workflow.stages[0].dependenciesTruncated,true);
});

test('legacy planning receives frame scope while creative and human work preserve ordinary exact responses',()=>{
 const {detail,estimate,generation}=fixture();delete detail.project.contractVersion;detail.shots=detail.shots.map(({kind,...shot}:any)=>({...shot,frameStart:1001,frameEnd:1002}));
 assert.equal(studioPlanningContext(detail,estimate as any)?.scope.counts.legacy_frames,1);
 for(const item of[generation,{...estimate,execution:'human'},{...estimate,stage:'references'}])assert.equal(studioPlanningContext(detail,item as any),undefined);
 assert.equal('planningContext' in (studioAgentProject(detail,{workItemId:generation.id}) as any),false);
});
