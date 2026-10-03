import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApiError,fail} from './security';
import {loadStoredGeneratedArtifact} from './studio-generated-artifacts';
import {assertGeneratedWorkCurrent} from './studio-generated-rounds';
import type {StudioMediaRework} from './studio-coordination-protocol';

type Row=Record<string,any>;
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const ended=():never=>fail(409,'The exact rejected media version or its current task changed. Read the current review history.','MEDIA_REWORK_CHANGED');
export const mediaReworkCapabilities=['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'];

/** The public dispatch marker lets restricted services classify ordinary runs
 * without access to the private correction evidence. */
export async function mediaReworkScope(db:PoolClient,companyId:string,runId:string){
 const marker=(await db.query('SELECT media_rework_review_id FROM studio_dispatches WHERE company_id=$1 AND run_id=$2',[companyId,runId])).rows[0];
 if(!marker?.media_rework_review_id)return null;
 const row=(await db.query('SELECT * FROM studio_media_rework_dispatches WHERE company_id=$1 AND child_run_id=$2 AND review_id=$3',[companyId,runId,marker.media_rework_review_id])).rows[0];
 if(!row)ended();return row as Row;
}
async function terminalSource(db:PoolClient,companyId:string,runId:string,agentId:string){
 const row=(await db.query('SELECT id,agent_id,status,attempts,started_at,finished_at FROM agent_runs WHERE company_id=$1 AND id=$2',[companyId,runId])).rows[0];
 if(!row||row.agent_id!==agentId||!['succeeded','failed','cancelled'].includes(row.status)||!row.finished_at)ended();
 return {runId,agentId,status:row.status,attempt:row.attempts,startedAt:row.started_at?new Date(row.started_at).toISOString():null,finishedAt:new Date(row.finished_at).toISOString()};
}
/** Current evidence only. Callers serialize new writes under the existing
 * project/policy locks. No external content or provider request is executed. */
export async function mediaReworkEvidence(db:PoolClient,companyId:string,projectId:string,workItemId:string,reviewId:string,taskRevision:number,own?:Row){
 const r=(await db.query(`SELECT v.*,e.spec_sha256,e.manifest_sha256,e.attestation_version,a.version,a.work_item_id,
  w.task_id,w.role_key,w.stage,w.execution,b.agent_id AS assigned_agent,b.human_id,
  t.status AS task_status,t.revision AS current_task_revision,t.agent_run_id,t.assignee_id,t.title,t.description,
  p.status AS project_status,p.contract_version,p.production_path,p.ai_policy,p.gates
  FROM studio_reviews v JOIN studio_generated_review_evidence e ON e.company_id=v.company_id AND e.project_id=v.project_id AND e.review_id=v.id AND e.artifact_id=v.artifact_id
  JOIN studio_artifacts a ON a.company_id=v.company_id AND a.project_id=v.project_id AND a.id=v.artifact_id
  JOIN studio_work_items w ON w.company_id=a.company_id AND w.project_id=a.project_id AND w.id=a.work_item_id
  JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id
  WHERE v.company_id=$1 AND v.project_id=$2 AND v.id=$3 AND w.id=$4`,[companyId,projectId,reviewId,workItemId])).rows[0];
 if(!r||r.decision!=='changes_requested'||r.attestation_version!==1||r.contract_version!==2||r.production_path!=='higgsfield'||r.stage!=='generation'||r.execution!=='creative'||r.project_status==='delivered'||r.ai_policy!=='allowed'||r.assignee_id||r.human_id||!r.assigned_agent||['brief','estimate','production'].some(g=>r.gates[g]?.decision!=='approved'))ended();
 const latest=(await db.query('SELECT id FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 ORDER BY version DESC LIMIT 1',[companyId,projectId,workItemId])).rows[0];
 const review=(await db.query('SELECT id FROM studio_reviews WHERE company_id=$1 AND project_id=$2 AND artifact_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1',[companyId,projectId,r.artifact_id])).rows[0];
 if(latest?.id!==r.artifact_id||review?.id!==reviewId)ended();
 const {roundId}=await assertGeneratedWorkCurrent(db,companyId,projectId,workItemId);
 const artifact=await loadStoredGeneratedArtifact(db,companyId,projectId,r.artifact_id,{requireAvailable:true}),source=artifact.sourceSnapshot;
 if(r.spec_sha256!==artifact.specSha256||r.manifest_sha256!==artifact.manifestSha256||source.agentId!==r.assigned_agent||!source.runId||source.roleAgentId!==r.assigned_agent||source.roleHumanId!==null||[artifact.artifact.producedBy,source.agentSponsorId,source.providerSponsorId,artifact.registeredBy].includes(r.reviewed_by))ended();
 // A correction is rooted in a real coordinated generation (or another exact
 // correction), never an arbitrary agent request or fabricated review note.
 const lineage=(await db.query(`SELECT child_run_id FROM studio_coordination_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND child_run_id=$4 AND specialist_agent_id=$5
  UNION ALL SELECT m.child_run_id FROM studio_media_rework_dispatches m JOIN studio_dispatches d ON d.company_id=m.company_id AND d.run_id=m.child_run_id AND d.media_rework_review_id=m.review_id
  WHERE m.company_id=$1 AND m.project_id=$2 AND m.work_item_id=$3 AND m.child_run_id=$4 AND m.specialist_agent_id=$5`,[companyId,projectId,workItemId,source.runId,r.assigned_agent])).rows;
 if(lineage.length!==1)ended();
 const sourceRun=await terminalSource(db,companyId,source.runId!,r.assigned_agent);
 const taskSourceRunId=own?.source_snapshot.taskSource.runId??r.agent_run_id;
 if(!taskSourceRunId)ended();
 if(taskSourceRunId!==source.runId&&!(await db.query('SELECT 1 FROM studio_generated_followups WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND child_run_id=$4 AND source_child_run_id=$5 AND archive_id=$6',[companyId,projectId,workItemId,taskSourceRunId,source.runId,artifact.archiveId])).rowCount)ended();
 const taskSource=await terminalSource(db,companyId,taskSourceRunId,r.assigned_agent);
 if((await db.query("SELECT 1 FROM studio_dependencies d JOIN studio_work_items w ON w.company_id=d.company_id AND w.id=d.predecessor_id JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND t.status<>'done' LIMIT 1",[companyId,projectId,workItemId])).rowCount)ended();
 if((await db.query("SELECT 1 FROM studio_dispatches d JOIN agent_runs a ON a.company_id=d.company_id AND a.id=d.run_id WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND a.status IN ('queued','running') AND ($4::uuid IS NULL OR a.id<>$4) LIMIT 1",[companyId,projectId,workItemId,own?.child_run_id??null])).rowCount)ended();
 if((await db.query(`SELECT 1 FROM higgsfield_requests r WHERE r.company_id=$1 AND r.project_id=$2 AND r.work_item_id=$3 AND ($4::uuid IS NULL OR r.run_id IS DISTINCT FROM $4)
  AND (r.status IN ('proposed','dispatching','uncertain') OR EXISTS(SELECT 1 FROM higgsfield_jobs j WHERE j.company_id=r.company_id AND j.request_id=r.id AND j.status NOT IN ('completed','failed','cancelled'))) LIMIT 1`,[companyId,projectId,workItemId,own?.child_run_id??null])).rowCount)ended();
 const candidate:StudioMediaRework={projectId,workItemId,reviewId,taskId:r.task_id,taskRevision,artifactId:r.artifact_id,artifactVersion:r.version,manifestSha256:artifact.manifestSha256,specSha256:artifact.specSha256,roundId,sourceChildRunId:source.runId!,specialistAgentId:r.assigned_agent,reviewedBy:r.reviewed_by,reviewedAt:new Date(r.created_at).toISOString(),reviewNote:r.note};
 const snapshot={...candidate,roleKey:r.role_key,title:r.title,description:r.description,gatesSha256:hash(r.gates),source:sourceRun,taskSource,storageVersionId:artifact.storageVersionId,fileSha256:artifact.fileFacts.sha256};
 if(own){
  if(canonical(own.source_snapshot)!==canonical(snapshot)||own.specialist_agent_id!==r.assigned_agent||own.task_id!==r.task_id||own.task_revision!==taskRevision)ended();
  const initial=r.task_status==='todo'&&r.current_task_revision===taskRevision+1&&!r.agent_run_id;
  const claimed=r.task_status==='doing'&&r.current_task_revision===taskRevision+2&&r.agent_run_id===own.child_run_id;
  if(!initial&&!claimed)ended();
  if(claimed&&!(await db.query("SELECT 1 FROM agent_tool_receipts WHERE company_id=$1 AND run_id=$2 AND tool='tasks_claim' AND response->>'id'=$3 AND (response->>'revision')::integer=$4 LIMIT 1",[companyId,own.child_run_id,r.task_id,taskRevision+2])).rowCount)ended();
 }else if(!['doing','review'].includes(r.task_status)||r.current_task_revision!==taskRevision||r.agent_run_id!==taskSourceRunId)ended();
 return {candidate,sourceSnapshot:snapshot,roleKey:r.role_key};
}
/** Called only by dispatchWork after it has acquired agent then project locks. */
export async function resetMediaReworkTask(db:PoolClient,companyId:string,projectId:string,workItemId:string,reviewId:string,taskRevision:number){
 const exact=await mediaReworkEvidence(db,companyId,projectId,workItemId,reviewId,taskRevision);
 if((await db.query('SELECT 1 FROM studio_media_rework_dispatches WHERE company_id=$1 AND artifact_id=$2',[companyId,exact.candidate.artifactId])).rowCount)ended();
 const updated=await db.query("UPDATE tasks SET status='todo',agent_run_id=NULL,approved_by=NULL,approved_agent_id=NULL,machine_review_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND revision=$3 AND status IN ('doing','review')",[companyId,exact.candidate.taskId,taskRevision]);
 if(updated.rowCount!==1)ended();return exact;
}
export async function availableMediaReworks(db:PoolClient,companyId:string,projectId:string){
 const rows=(await db.query(`SELECT v.id,a.work_item_id,t.revision FROM studio_reviews v JOIN studio_artifacts a ON a.company_id=v.company_id AND a.project_id=v.project_id AND a.id=v.artifact_id
  JOIN studio_work_items w ON w.company_id=a.company_id AND w.id=a.work_item_id JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  WHERE v.company_id=$1 AND v.project_id=$2 AND a.contract_version=2 AND v.decision='changes_requested' AND t.status IN ('doing','review')
  AND NOT EXISTS(SELECT 1 FROM studio_media_rework_dispatches m WHERE m.company_id=v.company_id AND m.artifact_id=v.artifact_id)
  ORDER BY v.created_at DESC,v.id DESC LIMIT 100`,[companyId,projectId])).rows;
 const candidates:StudioMediaRework[]=[];
 for(const r of rows)try{candidates.push((await mediaReworkEvidence(db,companyId,projectId,r.work_item_id,r.id,r.revision)).candidate);}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;}
 return candidates;
}
export async function mediaReworkFeedback(db:PoolClient,companyId:string,runId:string){
 const scope=await mediaReworkScope(db,companyId,runId);if(!scope)return null;
 await mediaReworkEvidence(db,companyId,scope.project_id,scope.work_item_id,scope.review_id,scope.task_revision,scope);
 return {...scope.source_snapshot,feedbackIsUntrusted:true,allowsProviderExecution:false,requiresNewHumanCreditConsent:true};
}
