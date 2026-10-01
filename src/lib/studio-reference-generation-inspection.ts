/** A human adopts one exact stopped producer's reference for one bounded
 * inspection. This is separate from generation, transfer and sharing consent. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {fail,id} from './security';
import {referenceGenerationInspectionAdoptInput} from './higgsfield-references-protocol';
import {assertReferenceGenerationHandoff,lockReferenceGenerationHandoff,readReferenceGenerationHandoff,referenceGenerationHandoffHash} from './studio-reference-generation-authority';

type Row=Record<string,any>;
function ended():never{return fail(409,'The finite inspection adoption ended or its exact source changed. Review a new request.','REFERENCE_GENERATION_INSPECTION_ENDED');}
const iso=(v:Date|string)=>new Date(v).toISOString();
const memberSnapshot=(m:Row)=>({userId:m.user_id,role:m.role,joinedAt:m.joined_at});
async function member(db:PoolClient,companyId:string,userId:string){
 const m=(await db.query("SELECT user_id,role,joined_at::text AS joined_at FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND access_revoked_at IS NULL FOR SHARE",[companyId,userId])).rows[0];
 if(!m)fail(403,'A current human company administrator must approve this inspection.','REFERENCE_GENERATION_INSPECTION_ADMIN_REQUIRED');return m;
}
export async function readReferenceGenerationInspectionAdoption(db:PoolClient,r:Row):Promise<Row|null>{
 if(!r.generation_handoff_id)return null;
 return (await db.query('SELECT * FROM studio_reference_generation_inspection_adoptions WHERE company_id=$1 AND reference_id=$2 AND handoff_id=$3',[r.company_id,r.id,r.generation_handoff_id])).rows[0]??null;
}
export function referenceGenerationInspectionAdoptionView(a:Row){return {id:a.id,approvedBy:a.approved_by,approvedAt:iso(a.approved_at),expiresAt:iso(a.expires_at),approvalHash:a.approval_hash,maximumAttempts:1 as const};}
export async function referenceGenerationHandoffView(db:PoolClient,r:Row){
 const h=await readReferenceGenerationHandoff(db,r);if(!h)return null;const a=await readReferenceGenerationInspectionAdoption(db,r);
 return {id:h.id,handoffSha256:h.handoff_sha256,inspectionAdoption:a?referenceGenerationInspectionAdoptionView(a):null};
}

/** Called under the existing authority/project/reference locks. Inspection
 * expiry is checked only for inspection; completed byte evidence does not
 * grant sharing, and a later sharing approval has its own finite deadline. */
export async function assertReferenceGenerationInspectionAdoption(db:PoolClient,r:Row,inspection=true,options:{nonBlockingRunLocks?:boolean}={}){
 if(!r.generation_handoff_id)return null;
 const a=await readReferenceGenerationInspectionAdoption(db,r);if(!a||r.generation_inspection_adoption_id!==a.id||a.max_attempts!==1||a.request_hash!==r.request_hash||a.project_id!==r.project_id||a.work_item_id!==r.work_item_id||a.handoff_id!==r.generation_handoff_id||a.inspection_consent!==true)ended();
 const proof=await assertReferenceGenerationHandoff(db,r,{requireSucceededProducer:true,adoptedSource:true,...options});if(!proof||a.handoff_sha256!==proof.handoff.handoff_sha256)ended();
 const current=memberSnapshot(await member(db,r.company_id,a.approved_by));if(referenceGenerationHandoffHash(current)!==referenceGenerationHandoffHash(a.approver_snapshot))ended();
 if(inspection){
  const time=(await db.query('SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=$2::timestamptz AND $1::timestamptz<=$3::timestamptz AS live',[a.expires_at,r.inspect_expires_at,proof.expiresAt])).rows[0];if(!time.live)ended();
 }
 return {adoption:a,expiresAt:iso(a.expires_at),handoff:proof.handoff};
}

export async function adoptStudioReferenceGenerationInspection(db:PoolClient,actor:{companyId:string;userId:string},referenceId:string,input:unknown){
 const parsed=referenceGenerationInspectionAdoptInput.safeParse(input);if(!parsed.success)fail(400,'Review the exact reference and finite inspection consent.','VALIDATION_ERROR');
 const data=parsed.data;id(actor.companyId);id(actor.userId);id(referenceId);
 // Do not accept an agent-shaped caller even if its requester is an owner.
 if('agentId'in actor||'runId'in actor)fail(403,'Only a human administrator can adopt inspection.','REFERENCE_GENERATION_INSPECTION_ADMIN_REQUIRED');
 await lockReferenceGenerationHandoff(db,actor.companyId,referenceId,[actor.userId]);const adopter=await member(db,actor.companyId,actor.userId);
 const scope=(await db.query('SELECT project_id FROM higgsfield_references WHERE company_id=$1 AND id=$2',[actor.companyId,referenceId])).rows[0];if(!scope)fail(404,'Reference not found.');
 await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,scope.project_id]);
 const r=(await db.query('SELECT * FROM higgsfield_references WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,referenceId])).rows[0];
 if(!r.generation_handoff_id)ended();
 const key='human:'+actor.userId,requestHash=referenceGenerationHandoffHash({operation:'inspection-adopt:'+referenceId,data});
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`higgsfield-reference:${actor.companyId}:${key}:${data.clientId}`]);
 const old=(await db.query('SELECT request_hash,response FROM higgsfield_reference_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[actor.companyId,key,data.clientId])).rows[0];
 if(old){if(old.request_hash!==requestHash)fail(409,'This inspection request ID was used for different details.','IDEMPOTENCY_CONFLICT');const current=await assertReferenceGenerationInspectionAdoption(db,r,true);if(!current||current.adoption.id!==old.response.adoption.id||current.adoption.approved_by!==actor.userId)ended();return {adoption:referenceGenerationInspectionAdoptionView(current.adoption),replayed:true};}
 if(r.status!=='proposed'||r.revoked_at||r.lease_id||r.action_id||r.inspection_authority||r.inspection_attempts!==0||r.approved_by||r.revision!==data.referenceRevision||r.request_hash!==data.requestHash)ended();
 if(await readReferenceGenerationInspectionAdoption(db,r))ended();
 const current=await assertReferenceGenerationHandoff(db,r,{requireSucceededProducer:true});if(!current||current.handoff.handoff_sha256!==data.handoffSha256)ended();
 const clock=(await db.query(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at) SELECT at::text AS approved,
  LEAST(at+make_interval(mins=>$1),$2::timestamptz,$3::timestamptz)::text AS expires FROM tick`,[data.expiresInMinutes,r.inspect_expires_at,current.expiresAt])).rows[0];
 if(!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS live',[clock.expires])).rows[0].live)ended();
 const fields={id:randomUUID(),company_id:r.company_id,project_id:r.project_id,work_item_id:r.work_item_id,reference_id:r.id,handoff_id:r.generation_handoff_id,reference_revision:r.revision,request_hash:r.request_hash,handoff_sha256:current.handoff.handoff_sha256,approved_by:actor.userId,approver_snapshot:memberSnapshot(adopter),approved_at:clock.approved,expires_at:clock.expires,inspection_consent:true,max_attempts:1};
 const approvalHash=referenceGenerationHandoffHash(fields),row={...fields,approver_snapshot:JSON.stringify(fields.approver_snapshot),approval_hash:approvalHash},columns=Object.keys(row);
 const saved=(await db.query(`INSERT INTO studio_reference_generation_inspection_adoptions(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row))).rows[0];
 const adopted=(await db.query("UPDATE higgsfield_references SET generation_inspection_adoption_id=$3 WHERE company_id=$1 AND id=$2 AND generation_inspection_adoption_id IS NULL AND status='proposed' AND revision=$4 RETURNING *",[r.company_id,r.id,saved.id,r.revision])).rows[0];if(!adopted)ended();
 await assertReferenceGenerationInspectionAdoption(db,adopted,true);
 const response={adoption:referenceGenerationInspectionAdoptionView(saved)};
 await db.query('INSERT INTO higgsfield_reference_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.companyId,key,data.clientId,requestHash,JSON.stringify(response)]);
 await db.query("INSERT INTO activity(company_id,kind,description) VALUES($1,'studio.reference_inspection_adopted',$2)",[actor.companyId,'A human administrator adopted one exact derived reference for one finite inspection. No sharing or generation was approved.']);
 // Receipt insertion or a later row wait cannot extend this finite consent.
 await assertReferenceGenerationInspectionAdoption(db,adopted,true);return {...response,replayed:false};
}
