/** Capture the first exact derived reference of an explicitly opted-in initial
 * generation child. This records lineage; it never adopts, inspects or shares. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {fail} from './security';
import type {ProjectImagePreparationActor} from './project-image-preparations-protocol';
import {studioCoordinationPolicyRow,studioCoordinationStatus} from './studio-coordination';
import {assertReferenceGenerationHandoff,referenceGenerationSnapshotSchema,referenceGenerationHandoffHash} from './studio-reference-generation-authority';

type Row=Record<string,any>;
export type ReferenceGenerationHandoffCandidate={id:string;projectId:string;workItemId:string;preparationId:string};
function changed():never{return fail(409,'This exact reference-to-generation handoff changed. Reconcile the original work.','REFERENCE_GENERATION_HANDOFF_CHANGED');}
const required=['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'];

/** The existing authenticated preparation/reference service has already locked
 * the company and current actor. Human proposals do not opt a stopped agent in. */
export async function prepareReferenceGenerationHandoff(db:PoolClient,actor:ProjectImagePreparationActor,projectId:string,workItemId:string,preparationId:string):Promise<ReferenceGenerationHandoffCandidate|null>{
 if(!actor.agentId||!actor.runId)return null;
 const policy=await studioCoordinationPolicyRow(db,actor.companyId,projectId,'share');
 if(!policy?.referenceGenerationContinuations)return null;
 const dispatch=(await db.query(`SELECT d.*,w.task_id,w.stage,w.execution,w.role_key,p.contract_version,p.production_path,
  b.agent_id,b.human_id,t.agent_run_id,t.status AS task_status,r.status AS run_status,r.attempts,r.max_attempts,
  r.lease_expires_at>clock_timestamp() AND r.started_at>clock_timestamp()-interval '30 minutes' AS lease_live
  FROM studio_coordination_dispatches d JOIN studio_work_items w ON (w.company_id,w.project_id,w.id)=(d.company_id,d.project_id,d.work_item_id)
  JOIN studio_projects p ON p.company_id=w.company_id AND p.id=w.project_id
  JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key
  JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN agent_runs r ON r.company_id=d.company_id AND r.id=d.child_run_id
  WHERE d.company_id=$1 AND d.project_id=$2 AND d.work_item_id=$3 AND d.child_run_id=$4`,[actor.companyId,projectId,workItemId,actor.runId])).rows[0];
 // This opt-in is for the initial generation specialist, not reference-stage
 // tasks or an unrelated live agent which happens to share the same identity.
 if(!dispatch)return null;
 if(dispatch.stage!=='generation'||dispatch.execution!=='creative')return null;
 if(dispatch.contract_version!==2||dispatch.production_path!=='higgsfield'||dispatch.policy_revision!==policy.revision||dispatch.coordinator_agent_id!==policy.coordinatorAgentId||dispatch.specialist_agent_id!==actor.agentId||dispatch.agent_id!==actor.agentId||dispatch.human_id||dispatch.task_status!=='doing'||dispatch.agent_run_id!==actor.runId||dispatch.run_status!=='running'||dispatch.attempts!==1||dispatch.max_attempts!==1||dispatch.lease_live!==true||!policy.allowedRoleKeys.includes(dispatch.role_key)||(actor.agentId===policy.coordinatorAgentId&&!policy.coordinatorGeneration))changed();
 const status=await studioCoordinationStatus(db,actor.companyId,policy);
 if(!['active','exhausted'].includes(status.effectiveStatus))changed();
 if((await db.query('SELECT 1 FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 LIMIT 1',[actor.companyId,projectId,workItemId])).rowCount)changed();
 const prior=(await db.query('SELECT id,preparation_id FROM studio_reference_generation_handoffs WHERE company_id=$1 AND source_child_run_id=$2',[actor.companyId,actor.runId])).rows[0];
 if(prior&&prior.preparation_id!==preparationId)changed();
 return {id:prior?.id??randomUUID(),projectId,workItemId,preparationId};
}

async function identitySnapshot(db:PoolClient,companyId:string,runId:string,generation=false){
 const row=(await db.query(`SELECT r.id AS run_id,r.agent_id,r.requested_by,r.capabilities AS run_capabilities,r.attempts,r.started_at,
  a.created_by,a.token_hash,a.capabilities,i.id AS installation_id,i.revision AS installation_revision
  FROM agent_runs r JOIN agents a ON a.company_id=r.company_id AND a.id=r.agent_id
  LEFT JOIN plugin_installations i ON i.company_id=a.company_id AND i.agent_id=a.id
  WHERE r.company_id=$1 AND r.id=$2`,[companyId,runId])).rows[0];
 if(!row?.started_at||(generation?required:['studio.read','studio.write','tasks.write']).some(cap=>!row.capabilities.includes(cap)||!row.run_capabilities.includes(cap)))changed();
 return {runId:row.run_id,agentId:row.agent_id,requestedBy:row.requested_by,sponsorId:row.created_by,tokenHash:row.token_hash,
  capabilities:[...row.capabilities].sort(),runCapabilities:[...row.run_capabilities].sort(),attempts:row.attempts,startedAt:new Date(row.started_at).toISOString(),
  installation:row.installation_id?{id:row.installation_id,revision:row.installation_revision}:null};
}

/** Called in the same transaction after the reference INSERT and before its
 * public response. A deferred FK ties the insert-only discriminator to this row. */
export async function recordReferenceGenerationHandoff(db:PoolClient,actor:ProjectImagePreparationActor,candidate:ReferenceGenerationHandoffCandidate|null,referenceId:string){
 const reference=(await db.query('SELECT * FROM higgsfield_references WHERE company_id=$1 AND id=$2',[actor.companyId,referenceId])).rows[0];
 if(!reference)changed();
 if(!candidate){if(reference.generation_handoff_id)await assertReferenceGenerationHandoff(db,reference,{requireSucceededProducer:false,nonBlockingRunLocks:true});return;}
 if(reference.generation_handoff_id!==candidate.id||reference.project_id!==candidate.projectId||reference.work_item_id!==candidate.workItemId||reference.proposed_agent_id!==actor.agentId||reference.proposed_run_id!==actor.runId||reference.proposed_by!==actor.userId||reference.inspection_authority)changed();
 const prior=(await db.query('SELECT reference_id FROM studio_reference_generation_handoffs WHERE company_id=$1 AND id=$2',[actor.companyId,candidate.id])).rows[0];
 if(prior){if(prior.reference_id!==reference.id)changed();await assertReferenceGenerationHandoff(db,reference,{requireSucceededProducer:false,nonBlockingRunLocks:true});return;}
 const dispatch=(await db.query('SELECT * FROM studio_coordination_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND child_run_id=$4',[actor.companyId,candidate.projectId,candidate.workItemId,actor.runId])).rows[0];
 const policy=await studioCoordinationPolicyRow(db,actor.companyId,candidate.projectId,'share');
 const prep=(await db.query('SELECT * FROM project_image_preparations WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR SHARE',[actor.companyId,candidate.projectId,candidate.preparationId])).rows[0];
 const derivation=(await db.query('SELECT * FROM project_image_preparation_derivations WHERE company_id=$1 AND project_id=$2 AND preparation_id=$3',[actor.companyId,candidate.projectId,candidate.preparationId])).rows[0];
 if(!dispatch||!policy?.referenceGenerationContinuations||policy.revision!==dispatch.policy_revision||!prep||prep.status!=='ready'||prep.revoked_at||!prep.cleanup_confirmed_at||!derivation||reference.proxy_version_id!==derivation.output_version_id||reference.source_version_id!==derivation.source_version_id)changed();
 const task=(await db.query('SELECT title,description FROM tasks WHERE company_id=$1 AND id=$2',[actor.companyId,reference.work_snapshot.taskId])).rows[0];
 if(!task)changed();
 const snapshot=referenceGenerationSnapshotSchema.parse({schemaVersion:1,project:reference.project_snapshot,work:{...reference.work_snapshot,title:task.title,description:task.description},
  producer:await identitySnapshot(db,actor.companyId,actor.runId!,true),coordinator:await identitySnapshot(db,actor.companyId,dispatch.parent_run_id),
  policy:{revision:policy.revision,coordinatorAgentId:policy.coordinatorAgentId,approvedBy:policy.approvedBy,authoritySnapshot:policy.authoritySnapshot,expiresAt:new Date(policy.expiresAt).toISOString()}});
 const insert:Row={id:candidate.id,company_id:actor.companyId,project_id:candidate.projectId,work_item_id:candidate.workItemId,task_id:reference.work_snapshot.taskId,
  initial_parent_run_id:dispatch.parent_run_id,source_child_run_id:actor.runId,coordinator_agent_id:dispatch.coordinator_agent_id,specialist_agent_id:actor.agentId,requested_by:actor.userId,
  policy_revision:policy.revision,project_revision:reference.project_revision,task_revision:reference.work_snapshot.taskRevision,reference_id:reference.id,reference_request_hash:reference.request_hash,
  preparation_id:prep.id,preparation_revision:prep.revision,source_version_id:derivation.source_version_id,source_sha256:derivation.source_sha256,source_bytes:derivation.source_bytes,
  output_version_id:derivation.output_version_id,output_sha256:derivation.output_sha256,output_bytes:derivation.output_bytes,recipe_sha256:derivation.recipe_sha256,derivation_sha256:derivation.receipt_sha256,
  source_snapshot:JSON.stringify(snapshot),handoff_sha256:referenceGenerationHandoffHash(snapshot)};
 const columns=Object.keys(insert);
 await db.query(`INSERT INTO studio_reference_generation_handoffs(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(insert));
 await assertReferenceGenerationHandoff(db,reference,{requireSucceededProducer:false,nonBlockingRunLocks:true});
}
