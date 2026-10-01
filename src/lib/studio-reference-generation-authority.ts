/** Exact authority for one derived-reference handoff. An ended producer is
 * historical evidence; it never supplies a current worker or agent lease. */
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {fail,hashToken,id} from './security';
import {managedAgentAuthoritySql,managedAgentAuthorityPrincipals} from './studio-hosting';
import {studioCoordinationPolicyRow,studioCoordinationStatus} from './studio-coordination';
import {HIGGSFIELD_REFERENCE_GENERATION_CAPABILITIES} from './higgsfield-references-protocol';
import {referenceGenerationClaimTransition} from './studio-reference-generation-transition';

type Row=Record<string,any>;
const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),grants=z.array(z.string().min(1).max(100)).max(100);
export const referenceGenerationIdentitySnapshotSchema=z.object({runId:uuid,agentId:uuid,requestedBy:uuid,sponsorId:uuid,tokenHash:sha,
 capabilities:grants,runCapabilities:grants,attempts:z.number().int().positive(),startedAt:z.iso.datetime(),
 installation:z.object({id:uuid,revision:z.number().int().positive()}).strict().nullable()}).strict();
export const referenceGenerationSnapshotSchema=z.object({schemaVersion:z.literal(1),project:z.record(z.string(),z.unknown()),
 work:z.object({workItemId:uuid,taskId:uuid,taskRevision:z.number().int().positive(),stage:z.literal('generation'),shotId:uuid.nullable(),roleKey:z.string().min(1).max(100),
  roleAgentId:uuid,roleHumanId:z.null(),taskContentHash:sha,status:z.literal('doing'),title:z.string(),description:z.string()}).strict(),
 producer:referenceGenerationIdentitySnapshotSchema,coordinator:referenceGenerationIdentitySnapshotSchema,
 policy:z.object({revision:z.number().int().positive(),coordinatorAgentId:uuid,approvedBy:uuid,authoritySnapshot:z.record(z.string(),z.unknown()),expiresAt:z.iso.datetime()}).strict()
}).strict();
const canonical=(v:unknown):string=>v instanceof Date?JSON.stringify(v.toISOString()):Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
export const referenceGenerationHandoffHash=(value:unknown)=>hashToken(canonical(value));
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function ended():never{return fail(409,'This exact derived-reference handoff no longer has current authority. Review a new request.','REFERENCE_GENERATION_HANDOFF_ENDED');}
const iso=(v:Date|string)=>new Date(v).toISOString();
export function referenceGenerationAuthorityBusy(error:unknown):never{if((error as {code?:string})?.code==='55P03')fail(409,'Another authority operation is committing. Retry the same request.','REFERENCE_GENERATION_AUTHORITY_BUSY');throw error;}
const semantic=(p:Row)=>{const {revision:_revision,updated_at:_updated,...fields}=p;return JSON.parse(JSON.stringify(fields));};

/** Markerless references return before any new private-table dependency. */
export async function readReferenceGenerationHandoff(db:PoolClient,r:Row):Promise<Row|null>{
 if(!r.generation_handoff_id)return null;
 const h=(await db.query('SELECT * FROM studio_reference_generation_handoffs WHERE company_id=$1 AND id=$2 AND reference_id=$3',[r.company_id,id(r.generation_handoff_id),r.id])).rows[0];
 if(!h||h.project_id!==r.project_id||h.work_item_id!==r.work_item_id||h.reference_request_hash!==r.request_hash||h.source_child_run_id!==r.proposed_run_id||h.specialist_agent_id!==r.proposed_agent_id||h.requested_by!==r.proposed_by)ended();return h;
}

/** Acquire only authority locks before the existing project -> reference lock
 * order. This remains callable when authority has ended so revocation can work. */
export async function lockReferenceGenerationHandoff(db:PoolClient,companyId:string,referenceId:string,extraUsers:string[]=[],options:{nonBlocking?:boolean}={}):Promise<Row|null>{
 try{
 const r=(await db.query('SELECT id,company_id,project_id,work_item_id,request_hash,proposed_run_id,proposed_agent_id,proposed_by,generation_handoff_id FROM higgsfield_references WHERE company_id=$1 AND id=$2',[id(companyId),id(referenceId)])).rows[0];
 if(!r?.generation_handoff_id)return null;const h=await readReferenceGenerationHandoff(db,r);if(!h)return null;
 await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId]);
 const ids=[...new Set([h.specialist_agent_id,h.coordinator_agent_id])].sort(),users=[h.requested_by,...extraUsers];
 const previews=(await db.query('SELECT id,created_by FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[companyId,ids])).rows;
 for(const a of previews)users.push(a.created_by,...await managedAgentAuthorityPrincipals(db,companyId,a.id));
 const adoption=(await db.query('SELECT approved_by FROM studio_reference_generation_inspection_adoptions WHERE company_id=$1 AND reference_id=$2',[companyId,referenceId])).rows[0];if(adoption)users.push(adoption.approved_by);
 await db.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId,[...new Set(users)].sort()]);
 await db.query('SELECT id FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId,ids]);
 await db.query('SELECT id FROM plugin_installations WHERE company_id=$1 AND agent_id=ANY($2::uuid[]) ORDER BY id FOR SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId,ids]);
 await db.query('SELECT id FROM agent_runs WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId,[h.source_child_run_id,h.initial_parent_run_id].sort()]);
 await db.query('SELECT revision FROM studio_coordination_policies WHERE company_id=$1 AND project_id=$2 FOR SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId,h.project_id]);
 await db.query('SELECT revision FROM studio_profiles WHERE company_id=$1 FOR SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId]);
 await db.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE'+(options.nonBlocking?' NOWAIT':''),[companyId]);return h;
 }catch(error){if(options.nonBlocking)referenceGenerationAuthorityBusy(error);throw error;}
}

async function identity(db:PoolClient,companyId:string,s:z.infer<typeof referenceGenerationIdentitySnapshotSchema>,mode:'running'|'succeeded'|'either',nonBlocking=false){
 try{
 const a=(await db.query(`SELECT a.id,a.created_by,a.token_hash,a.capabilities,a.invocation_access,
  a.status='active' AND a.expires_at>clock_timestamp() AND ${managedAgentAuthoritySql('a')} AS live,a.expires_at,
  r.id AS run_id,r.requested_by,r.capabilities AS run_capabilities,r.purpose,r.status,r.attempts,r.max_attempts,r.started_at,r.finished_at,r.result_message_id,r.lease_expires_at,
  r.lease_token_hash IS NOT NULL AND r.lease_expires_at>clock_timestamp() AND r.started_at>clock_timestamp()-interval '30 minutes' AS lease_live
  FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id
  WHERE a.company_id=$1 AND a.id=$2 AND r.id=$3 FOR SHARE OF a,r${nonBlocking?' NOWAIT':''}`,[companyId,s.agentId,s.runId])).rows[0];
 if(!a||!a.live||a.invocation_access==='none'||a.created_by!==s.sponsorId||a.token_hash!==s.tokenHash||a.requested_by!==s.requestedBy||a.attempts!==s.attempts||!a.started_at||iso(a.started_at)!==s.startedAt
  ||!same([...a.capabilities].sort(),s.capabilities)||!same([...a.run_capabilities].sort(),s.runCapabilities))ended();
 const install=(await db.query('SELECT id,revision FROM plugin_installations WHERE company_id=$1 AND agent_id=$2 FOR SHARE'+(nonBlocking?' NOWAIT':''),[companyId,s.agentId])).rows[0]??null;if(!same(install,s.installation))ended();
 const users=[...new Set([s.requestedBy,s.sponsorId,...await managedAgentAuthorityPrincipals(db,companyId,s.agentId)])].sort();
 if((await db.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin') AND access_revoked_at IS NULL ORDER BY user_id FOR SHARE"+(nonBlocking?' NOWAIT':''),[companyId,users])).rowCount!==users.length)ended();
 if(a.status==='running'){if(mode==='succeeded'||!a.lease_live)ended();}
 else if(a.status==='succeeded'){
  if(mode==='running'||!a.finished_at||!a.result_message_id||!(await db.query(`SELECT 1 FROM agent_run_receipts WHERE company_id=$1 AND run_id=$2 AND kind='complete'
   AND response#>>'{run,id}'=$2::text AND response#>>'{run,status}'='succeeded' AND response#>>'{run,resultMessageId}'=$3::text LIMIT 1`,[companyId,s.runId,a.result_message_id])).rowCount)ended();
 }else ended();return a;
 }catch(error){if(nonBlocking)referenceGenerationAuthorityBusy(error);throw error;}
}

export async function assertReferenceGenerationHandoff(db:PoolClient,r:Row,options:{requireSucceededProducer:boolean;adoptedSource?:boolean;nonBlockingRunLocks?:boolean}):Promise<{handoff:Row;expiresAt:string}|null>{
 const h=await readReferenceGenerationHandoff(db,r);if(!h)return null;
 const parsed=referenceGenerationSnapshotSchema.safeParse(h.source_snapshot);if(!parsed.success||Buffer.byteLength(canonical(h.source_snapshot))>65536||referenceGenerationHandoffHash(h.source_snapshot)!==h.handoff_sha256)ended();const s=parsed.data;
 if(r.inspection_authority||r.revoked_at||['revoked','blocked','failed','uncertain'].includes(r.status)||h.project_revision!==r.project_revision||h.task_revision!==r.work_snapshot.taskRevision||h.task_id!==r.work_snapshot.taskId
  ||s.producer.runId!==h.source_child_run_id||s.producer.agentId!==h.specialist_agent_id||s.producer.requestedBy!==h.requested_by
  ||s.coordinator.runId!==h.initial_parent_run_id||s.coordinator.agentId!==h.coordinator_agent_id||s.coordinator.requestedBy!==h.requested_by
  ||s.policy.revision!==h.policy_revision||s.policy.coordinatorAgentId!==h.coordinator_agent_id||s.policy.approvedBy!==h.requested_by
  ||!same(s.project,r.project_snapshot)||!same({...s.work,title:undefined,description:undefined},{...r.work_snapshot,title:undefined,description:undefined}))ended();
 const producer=await identity(db,r.company_id,s.producer,options.requireSucceededProducer?'succeeded':'running',options.nonBlockingRunLocks),parent=await identity(db,r.company_id,s.coordinator,'either',options.nonBlockingRunLocks);
 if(producer.purpose!=='task'||producer.attempts!==1||producer.max_attempts!==1||HIGGSFIELD_REFERENCE_GENERATION_CAPABILITIES.some(cap=>!producer.capabilities.includes(cap)||!producer.run_capabilities.includes(cap)))ended();
 const p=await studioCoordinationPolicyRow(db,r.company_id,r.project_id,'share');
 if(!p||p.referenceGenerationContinuations!==true||p.revision!==h.policy_revision||p.coordinatorAgentId!==h.coordinator_agent_id||p.approvedBy!==h.requested_by||iso(p.expiresAt)!==s.policy.expiresAt||!same(p.authoritySnapshot,s.policy.authoritySnapshot)
  ||!['active','exhausted'].includes((await studioCoordinationStatus(db,r.company_id,p)).effectiveStatus))ended();
 const dispatch=(await db.query(`SELECT 1 FROM studio_coordination_dispatches WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 AND child_run_id=$4
  AND parent_run_id=$5 AND coordinator_agent_id=$6 AND specialist_agent_id=$7 AND policy_revision=$8`,[r.company_id,r.project_id,r.work_item_id,h.source_child_run_id,h.initial_parent_run_id,h.coordinator_agent_id,h.specialist_agent_id,h.policy_revision])).rowCount;if(!dispatch)ended();
 const project=(await db.query('SELECT * FROM studio_projects WHERE company_id=$1 AND id=$2',[r.company_id,r.project_id])).rows[0];
 if(!project||project.revision!==h.project_revision||!same(semantic(project),s.project)||project.status==='delivered'||project.ai_policy!=='allowed'||project.production_path!=='higgsfield'||project.contract_version!==2
  ||['brief','estimate','production'].some(g=>project.gates[g]?.decision!=='approved'))ended();
 const work=(await db.query(`SELECT w.*,t.title,t.description,t.status,t.revision AS task_revision,t.agent_run_id,t.assignee_id,b.agent_id,b.human_id
  FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  LEFT JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3`,[r.company_id,r.project_id,r.work_item_id])).rows[0];
 if(!work||work.task_id!==h.task_id||work.stage!=='generation'||work.execution!=='creative'||work.shot_id!==s.work.shotId||work.role_key!==s.work.roleKey||work.agent_id!==h.specialist_agent_id||work.human_id!==null||work.assignee_id!==null
  ||work.title!==s.work.title||work.description!==s.work.description||work.status!=='doing')ended();
 if((work.task_revision!==h.task_revision||work.agent_run_id!==h.source_child_run_id)&&!await referenceGenerationClaimTransition(db,r,h,work))ended();
 const proof=options.adoptedSource?(await db.query('SELECT * FROM studio_reference_generation_adoption_facts WHERE company_id=$1 AND handoff_id=$2 AND reference_id=$3',[r.company_id,h.id,r.id])).rows[0]
  :(await db.query(`SELECT p.status AS preparation_status,p.revision AS preparation_revision,p.revoked_at,p.cleanup_confirmed_at,d.*,
   d.receipt_sha256 AS derivation_sha256 FROM project_image_preparations p JOIN project_image_preparation_derivations d
   ON (d.company_id,d.project_id,d.preparation_id)=(p.company_id,p.project_id,p.id) WHERE p.company_id=$1 AND p.project_id=$2 AND p.id=$3`,[r.company_id,r.project_id,h.preparation_id])).rows[0];
 if(!proof||proof.preparation_status!=='ready'||proof.preparation_revision!==h.preparation_revision||proof.revoked_at||!proof.cleanup_confirmed_at||proof.preparation_id!==h.preparation_id
  ||proof.source_version_id!==h.source_version_id||proof.source_sha256!==h.source_sha256||Number(proof.source_bytes)!==Number(h.source_bytes)||proof.output_version_id!==h.output_version_id||proof.output_sha256!==h.output_sha256||Number(proof.output_bytes)!==Number(h.output_bytes)
  ||proof.recipe_sha256!==h.recipe_sha256||proof.derivation_sha256!==h.derivation_sha256||r.source_version_id!==h.source_version_id||r.proxy_version_id!==h.output_version_id
  ||r.proxy_snapshot.sha256!==h.output_sha256||Number(r.proxy_snapshot.bytes)!==Number(h.output_bytes)||r.source_snapshot?.sha256!==h.source_sha256||Number(r.source_snapshot?.bytes)!==Number(h.source_bytes))ended();
 const liveRunExpiry=(run:Row)=>run.status==='running'?new Date(Math.min(+new Date(run.lease_expires_at),+new Date(run.started_at)+1800000)).toISOString():null;
 const time=(await db.query(`SELECT LEAST($1::timestamptz,$2::timestamptz,$3::timestamptz,$4::timestamptz,$5::timestamptz) AS expires_at,
  LEAST($1::timestamptz,$2::timestamptz,$3::timestamptz,$4::timestamptz,$5::timestamptz)>clock_timestamp() AS live`,[p.expiresAt,producer.expires_at,parent.expires_at,liveRunExpiry(producer),liveRunExpiry(parent)])).rows[0];if(!time.live)ended();
 return {handoff:h,expiresAt:iso(time.expires_at)};
}
