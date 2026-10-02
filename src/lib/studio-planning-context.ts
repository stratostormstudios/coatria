import type {StudioReadableProjectDetail,StudioWorkItem} from './studio-protocol';

const stageOrder=['estimate','breakdown','ingest','references','prep','matchmove','layout','animation','fx','lighting','compositing','generation','qc','delivery'];
const previewLimit=8,stageLimit=20;
const clipped=(value:string,max:number)=>{const points=Array.from(value);return {text:points.slice(0,max).join(''),truncated:points.length>max};};

/** Planning facts, not an approval or an assertion of reviewer independence.
 * Project-level planning has no shotId, so its ordinary exact-work shot list
 * cannot establish the scope. Keep this separate from that unchanged list. */
export function studioPlanningContext(detail:StudioReadableProjectDetail,work:StudioWorkItem){
 if(work.execution!=='agent'||!['estimate','breakdown'].includes(work.stage))return undefined;
 const allWork=[...detail.workItems,...('historyWorkItems' in detail?detail.historyWorkItems??[]:[])];
 const byId=new Map(allWork.map(item=>[item.id,item]));
 const stages=[...new Set(detail.workItems.map(item=>item.stage))].sort((a,b)=>{
  const ai=stageOrder.indexOf(a),bi=stageOrder.indexOf(b);
  return (ai<0?stageOrder.length:ai)-(bi<0?stageOrder.length:bi)||a.localeCompare(b);
 });
 const qc=detail.roles.find(role=>role.key==='qc');
 const conflicts=qc?.humanId?detail.roles.filter(role=>role.key!=='qc'&&role.agentId&&role.agentSponsorId===qc.humanId).map(role=>role.key).sort():[];
 const counts={image:0,video:0,audio:0,legacy_frames:0};
 for(const shot of detail.shots)counts['kind' in shot?shot.kind:'legacy_frames']++;
 const previews=detail.shots.slice(0,previewLimit).map(shot=>{
  const description=clipped(shot.description,120);
  return {id:shot.id,code:shot.code,kind:'kind' in shot?shot.kind:'legacy_frames',descriptionPreview:description.text,descriptionTruncated:description.truncated};
 });
 return {
  version:1 as const,
  scope:{deliverableCount:detail.shots.length,counts,previews,previewsTruncated:detail.shots.length>previews.length,details:'Preserve the brief/spec; page studio_get for remaining work.'},
  workflow:{scope:'current_project_work',selectedWorkIsCurrent:detail.workItems.some(item=>item.id===work.id),stages:stages.slice(0,stageLimit).map(stage=>{
   const items=detail.workItems.filter(item=>item.stage===stage);
   const dependencies=[...new Set(items.flatMap(item=>item.dependencies.map(id=>byId.get(id)?.stage).filter((value):value is string=>Boolean(value))))].sort();
   return {stage,workCount:items.length,acceptedCount:items.filter(item=>item.status==='done').length,
    requiresAcceptedStages:dependencies.slice(0,stageLimit),dependenciesTruncated:dependencies.length>stageLimit,unresolvedDependencyCount:items.reduce((sum,item)=>sum+item.dependencies.filter(id=>!byId.has(id)).length,0),
    requiredBusinessGates:['brief',...(['estimate','breakdown'].includes(stage)?[]:['production'])]};
  }),stagesTruncated:stages.length>stageLimit,displayOrderIsNotAuthority:true},
  businessGates:{brief:detail.project.gates.brief?.decision??'not_recorded',estimate:detail.project.gates.estimate?.decision??'not_recorded',production:detail.project.gates.production?.decision??'not_recorded',clientAcceptance:detail.project.gates.client_acceptance?.decision??'not_recorded',aiPolicy:detail.project.aiPolicy,
   productionRequires:['approved brief','approved scope and estimate','resolved AI-use policy'],generationRequiresAiPolicy:'allowed'},
  generation:{approvalsIncluded:false,deliverableCountIsNotGenerationAllowance:true,automaticRetriesAuthorized:false,
   rule:'Brief limits apply; each generation/retry needs exact current credit approval. Never retry uncertain effects.'},
  review:{assignedQcHumanId:qc?.humanId??null,assignment:!qc?.humanId?'unassigned':conflicts.length?'potential_sponsor_conflict':'independence_unverified',conflictingSponsorRoleKeys:conflicts,independenceVerified:false,
   rule:'Verify reviewer independence from producer, sponsors and registrar. Machine planning review is not media, business or client approval.'},
  submissionChecklist:['Scope, assumptions and missing inputs.','All dependency and approval handoffs.','Known generation limits; no invented retries/prices/approvals.','Unverified reviewer eligibility.'],
  grantsAuthority:false,
 };
}

export const studioPlanningInstructions='Read the returned planningContext before estimating or scheduling. Include its full-project deliverable scope and every workflow handoff, including scope/estimate and breakdown acceptance. Separate confirmed facts from assumptions. Preserve explicit brief limits; never add a generation retry allowance or treat a deliverable count as spending approval. A named QC assignee is not evidence of independence: report potential sponsor conflicts and unresolved reviewer eligibility. Do not describe the sponsor as an independent reviewer or simulated client merely because they own the company.';
