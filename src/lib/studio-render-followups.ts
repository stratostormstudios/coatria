import type {PoolClient} from 'pg';
import {ApiError,fail,hashToken} from './security';
type Row=Record<string,any>;
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
/** Immutable media evidence plus current project/task ownership. Does not take
 * project locks: callers keep the existing agent/run -> policy -> project order.
 */
export async function renderFollowupEvidence(client:PoolClient,companyId:string,projectId:string,workItemId:string,executionJobId:string,followupRunId?:string){
 const row=(await client.query(`SELECT j.*,m.manifest,m.manifest_hash,d.child_run_id AS source_child_run_id,d.specialist_agent_id,
   source.status AS source_status,w.task_id,w.role_key,w.execution,b.agent_id AS assigned_agent_id,
   t.status AS task_status,t.agent_run_id AS task_run_id,t.assignee_id,
   p.status AS project_status,p.ai_policy,p.gates,p.spec AS project_spec,
   promoted.artifact_id,promoted.manifest_text,promoted.manifest_sha256,
   a.sha256 AS artifact_sha256,a.metadata AS artifact_metadata,a.produced_agent_id,a.run_id AS artifact_run_id,
   (SELECT latest.id FROM studio_artifacts latest WHERE latest.company_id=w.company_id AND latest.work_item_id=w.id ORDER BY latest.version DESC LIMIT 1) AS latest_artifact_id,
   (SELECT latest.run_id FROM studio_dispatches latest WHERE latest.company_id=w.company_id AND latest.work_item_id=w.id ORDER BY latest.created_at DESC,latest.run_id DESC LIMIT 1) AS latest_run_id,
   EXISTS(SELECT 1 FROM studio_execution_jobs pending WHERE pending.company_id=w.company_id AND pending.work_item_id=w.id AND pending.status IN ('awaiting_approval','queued','running')) AS execution_pending,
   EXISTS(SELECT 1 FROM studio_dependencies dep JOIN studio_work_items predecessor ON predecessor.company_id=dep.company_id AND predecessor.id=dep.predecessor_id JOIN tasks predecessor_task ON predecessor_task.company_id=predecessor.company_id AND predecessor_task.id=predecessor.task_id WHERE dep.company_id=w.company_id AND dep.work_item_id=w.id AND predecessor_task.status<>'done') AS dependencies_pending
  FROM studio_execution_jobs j JOIN studio_execution_manifests m ON m.company_id=j.company_id AND m.job_id=j.id
  JOIN studio_coordination_dispatches d ON d.company_id=j.company_id AND d.project_id=j.project_id AND d.work_item_id=j.work_item_id
  JOIN agent_runs source ON source.company_id=d.company_id AND source.id=d.child_run_id
  JOIN studio_work_items w ON w.company_id=j.company_id AND w.project_id=j.project_id AND w.id=j.work_item_id
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN studio_projects p ON p.company_id=j.company_id AND p.id=j.project_id
  JOIN studio_media_promotions promoted ON promoted.company_id=j.company_id AND promoted.job_id=j.id
  JOIN studio_artifacts a ON a.company_id=promoted.company_id AND a.project_id=promoted.project_id AND a.id=promoted.artifact_id
  WHERE j.company_id=$1 AND j.project_id=$2 AND j.work_item_id=$3 AND j.id=$4`,[companyId,projectId,workItemId,executionJobId])).rows[0];
 if(!row)fail(409,'This exact completed render needs a human-promoted private artifact before specialist follow-up.','COORDINATION_RENDER_NOT_READY');
 const unavailable=()=>fail(409,'The original delegated render, current task, approved production or promoted artifact no longer matches this follow-up.','COORDINATION_RENDER_CHANGED');
 if(row.execution!=='dcc'||row.status!=='succeeded'||row.output_kind!=='image_sequence'||!row.approved_by||row.source_status!=='succeeded'||row.requested_run_id!==row.source_child_run_id||row.requested_agent_id!==row.specialist_agent_id||row.assigned_agent_id!==row.specialist_agent_id||row.produced_agent_id!==row.specialist_agent_id||row.artifact_run_id!==row.source_child_run_id)unavailable();
 if(row.project_status==='delivered'||row.ai_policy!=='allowed'||row.gates.brief?.decision!=='approved'||row.gates.production?.decision!=='approved'||canonical(row.project_spec)!==canonical(row.spec)||row.dependencies_pending||row.execution_pending||row.assignee_id)unavailable();
 if(row.latest_artifact_id!==row.artifact_id||row.latest_run_id!==(followupRunId??row.source_child_run_id)||!(followupRunId?['doing','review','done']:['doing']).includes(row.task_status)||![row.source_child_run_id,...followupRunId?[followupRunId]:[]].includes(row.task_run_id))unavailable();
 if(hashToken(canonical(row.manifest))!==row.manifest_hash||hashToken(row.manifest_text)!==row.manifest_sha256||row.artifact_sha256!==row.manifest_sha256||row.artifact_metadata.storageVerification!=='server_bytes'||row.artifact_metadata.referenceKind!=='image_sequence_manifest'||row.artifact_metadata.executionProvenance?.jobId!==executionJobId||row.artifact_metadata.executionProvenance?.executionManifestSha256!==row.manifest_hash)unavailable();
 const files=(await client.query('SELECT f.output_path,f.kind,f.frame,f.sha256,f.bytes FROM studio_media_files f JOIN studio_media_verifications v ON v.company_id=f.company_id AND v.file_id=f.id AND v.sha256=f.sha256 AND v.bytes=f.bytes WHERE f.company_id=$1 AND f.job_id=$2',[companyId,executionJobId])).rows;
 if(!Array.isArray(row.manifest.files)||!row.manifest.files.length||row.manifest.files.some((file:Row)=>!files.some(saved=>saved.output_path===file.path&&saved.kind===file.kind&&saved.sha256===file.sha256&&Number(saved.bytes)===file.bytes&&(file.frame??null)===saved.frame)))fail(409,'Every recorded output file must pass private storage verification before automatic follow-up.','COORDINATION_MEDIA_UNVERIFIED');
 const frames=row.manifest.files.filter((file:Row)=>file.kind==='image').sort((a:Row,b:Row)=>a.frame-b.frame);
 if(frames.length!==row.frame_end-row.frame_start+1||frames.some((file:Row,index:number)=>file.frame!==row.frame_start+index))unavailable();
 return {projectId,workItemId,executionJobId,sourceChildRunId:row.source_child_run_id,specialistAgentId:row.specialist_agent_id,taskId:row.task_id,roleKey:row.role_key,executionManifestSha256:row.manifest_hash,artifactId:row.artifact_id,artifactSha256:row.artifact_sha256};
}
export async function availableRenderFollowups(client:PoolClient,companyId:string,projectId:string){
 const candidates=(await client.query(`SELECT j.id,j.work_item_id FROM studio_execution_jobs j JOIN studio_media_promotions p ON p.company_id=j.company_id AND p.job_id=j.id JOIN studio_coordination_dispatches d ON d.company_id=j.company_id AND d.project_id=j.project_id AND d.work_item_id=j.work_item_id AND d.child_run_id=j.requested_run_id AND d.specialist_agent_id=j.requested_agent_id WHERE j.company_id=$1 AND j.project_id=$2 AND j.status='succeeded' AND p.artifact_id=(SELECT latest.id FROM studio_artifacts latest WHERE latest.company_id=j.company_id AND latest.work_item_id=j.work_item_id ORDER BY latest.version DESC LIMIT 1) AND NOT EXISTS(SELECT 1 FROM studio_coordination_followups f WHERE f.company_id=j.company_id AND f.execution_job_id=j.id) ORDER BY j.created_at,j.id LIMIT 100`,[companyId,projectId])).rows,result=[];
 for(const job of candidates)try{result.push(await renderFollowupEvidence(client,companyId,projectId,job.work_item_id,job.id));}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;}
 return result;
}
/** Called inside the existing leased tool transaction, before replay or effects. */
export async function assertRenderFollowupTool(client:PoolClient,agent:Row,run:Row,name:string,args:Row){
 const receipt=(await client.query('SELECT * FROM studio_coordination_followups WHERE company_id=$1 AND child_run_id=$2',[agent.company_id,run.id])).rows[0];if(!receipt)return;
 // Serialize media version/gate changes with an exact claim or submission.
 await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[agent.company_id,receipt.project_id]);
 const evidence=await renderFollowupEvidence(client,agent.company_id,receipt.project_id,receipt.work_item_id,receipt.execution_job_id,run.id);
 if(receipt.specialist_agent_id!==agent.id||receipt.execution_manifest_sha256!==evidence.executionManifestSha256||receipt.artifact_id!==evidence.artifactId||receipt.artifact_sha256!==evidence.artifactSha256)fail(409,'The pinned render follow-up evidence changed.','COORDINATION_RENDER_CHANGED');
 const allowed=(name==='studio_get'&&args.projectId===receipt.project_id&&((args.artifactId===receipt.artifact_id&&!args.workItemId)||(args.workItemId===receipt.work_item_id&&!args.artifactId)))||(name==='studio_execution_get'&&args.jobId===receipt.execution_job_id)||(['tasks_claim','tasks_submit'].includes(name)&&args.taskId===evidence.taskId);
 if(!allowed)fail(403,'This post-render run may only read its exact work, job or promoted artifact and claim or submit its existing task.','COORDINATION_FOLLOWUP_SCOPE');
}
