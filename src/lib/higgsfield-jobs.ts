import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {query,transaction} from './db';
import type {Membership} from './auth';
import {fail,hashToken} from './security';
import {sealHiggsfieldSecret} from './higgsfield-secrets';
import {callHiggsfieldTool} from './higgsfield-mcp';
import {normalizeHiggsfieldSubmission,normalizeHiggsfieldPoll,buildHiggsfieldPollArguments,type NormalizedHiggsfieldJob,type HiggsfieldJobKind} from './higgsfield-job-contract';

type Row=Record<string,any>;
export const higgsfieldJobsInput=z.object({projectId:z.string().uuid(),requestId:z.string().uuid().optional(),after:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
const terminal=new Set(['completed','failed','cancelled']);
const kindForTool=(tool:string)=>tool.slice('generate_'.length) as HiggsfieldJobKind;
const sourceHash=(value:unknown)=>hashToken(JSON.stringify(value));
async function preserveProviderResponse(db:PoolClient,request:Row,response:unknown,source:'submission'|'poll',jobId?:string){
 const responseId=randomUUID(),sha=sourceHash(response),sealed=sealHiggsfieldSecret(response,{companyId:request.company_id,id:responseId,purpose:'provider-response'});
 // Targetless DO NOTHING uses the table's unique constraints without requiring
 // SELECT privilege on private journal rows for an explicit conflict target.
 await db.query('INSERT INTO higgsfield_provider_responses(id,company_id,project_id,request_id,job_id,source,source_sha256,sealed) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[responseId,request.company_id,request.project_id,request.request_id??request.id,jobId??null,source,sha,JSON.stringify(sealed)]);
}

/** Called only for the response to our already committed, human-approved paid
 * dispatch. Imported reports and caller-supplied IDs never enter these tables. */
export async function recordHiggsfieldSubmission(db:PoolClient,request:Row,response:unknown){
 const persisted=(await db.query('SELECT * FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[request.company_id,request.project_id,request.id])).rows[0];
 if(!persisted||persisted.status!=='returned'||!persisted.approved_by||!persisted.connection_id||['connection_id','connection_revision','approved_by','request_hash','tool'].some(key=>persisted[key]!==request[key]))fail(409,'Only the committed, approved provider response can create tracked jobs.','HIGGSFIELD_RECEIPT_NOT_ADOPTED');
 request=persisted;
 const normalized=normalizeHiggsfieldSubmission(response,kindForTool(request.tool)),sha=sourceHash(response);
 let alreadyBound=false;
 for(const job of [...normalized.jobs].sort((a,b)=>a.providerJobId.localeCompare(b.providerJobId))){
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['higgsfield-job:'+request.company_id+':'+request.connection_id+':'+job.providerJobId]);
  if((await db.query('SELECT 1 FROM higgsfield_jobs WHERE company_id=$1 AND connection_id=$2 AND provider_job_id=$3 AND request_id<>$4',[request.company_id,request.connection_id,job.providerJobId,request.id])).rowCount)alreadyBound=true;
 }
 const outcome=alreadyBound?'unsupported':normalized.outcome,code=alreadyBound?'HIGGSFIELD_JOB_ALREADY_BOUND':normalized.code??null;
 const summary={contract:normalized.contract,outcome,code,providerJobCount:!alreadyBound&&normalized.supported?normalized.jobs.length:0,sourceSha256:sha,bytesVerified:false,mediaApproved:false};
 if(!request.connection_id||!request.approved_by)return {...summary,outcome:'unsupported',code:'HIGGSFIELD_HISTORICAL_IDENTITY_UNKNOWN',providerJobCount:0};
 const inserted=await db.query(`INSERT INTO higgsfield_job_receipts(request_id,company_id,project_id,connection_id,connection_revision,approved_by,request_hash,contract,source_sha256,outcome,diagnostic_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,[request.id,request.company_id,request.project_id,request.connection_id,request.connection_revision,request.approved_by,request.request_hash,normalized.contract,sha,outcome,code]);
 if(!inserted.rowCount){
  const old=(await db.query('SELECT * FROM higgsfield_job_receipts WHERE company_id=$1 AND project_id=$2 AND request_id=$3',[request.company_id,request.project_id,request.id])).rows[0];
  if(!old||old.source_sha256!==sha||old.request_hash!==request.request_hash||old.connection_id!==request.connection_id||old.connection_revision!==request.connection_revision||old.approved_by!==request.approved_by)fail(409,'This dispatch already has a different committed receipt.','IDEMPOTENCY_CONFLICT');
  const count=Number((await db.query('SELECT count(*) FROM higgsfield_jobs WHERE company_id=$1 AND project_id=$2 AND request_id=$3',[request.company_id,request.project_id,request.id])).rows[0].count);
  return {contract:old.contract,outcome:old.outcome,code:old.diagnostic_code,providerJobCount:count,sourceSha256:old.source_sha256,bytesVerified:false,mediaApproved:false};
 }
 await preserveProviderResponse(db,request,response,'submission');
 if(!alreadyBound&&normalized.supported&&normalized.outcome==='jobs')for(const job of normalized.jobs){
  const row=(await db.query(`INSERT INTO higgsfield_jobs(company_id,project_id,request_id,provider_job_id,kind,model,status,next_poll_at,connection_id) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN clock_timestamp() ELSE NULL END,$9) RETURNING *`,[request.company_id,request.project_id,request.id,job.providerJobId,job.kind,job.model??null,job.status,!terminal.has(job.status),request.connection_id])).rows[0];
  await applyObservation(db,row,job,sha,'submission');
 }
 return summary;
}

async function applyObservation(db:PoolClient,row:Row,job:NormalizedHiggsfieldJob,sha:string,source:'submission'|'poll'){
 const outputs=job.outputs??[],old=(await db.query('SELECT ordinal,kind,locator_identity FROM higgsfield_job_outputs WHERE company_id=$1 AND project_id=$2 AND job_id=$3 ORDER BY ordinal',[row.company_id,row.project_id,row.id])).rows;
 const identityChanged=old.length>0&&(outputs.length!==old.length||old.some((o:Row,i:number)=>o.ordinal!==outputs[i]?.ordinal||o.kind!==outputs[i]?.kind||o.locator_identity!==outputs[i]?.identity));
 const conflict=job.model&&row.model&&job.model!==row.model||job.kind&&job.kind!==row.kind||terminal.has(row.status)&&job.status!==row.status||identityChanged;
 const status=conflict?'conflict':job.status==='lookup_failed'?(job.retryable?'running':'unresolved'):job.status;
 const code=conflict?'HIGGSFIELD_PROVIDER_CONFLICT':job.diagnosticCode??null;
 await db.query(`INSERT INTO higgsfield_job_observations(company_id,project_id,job_id,source,source_sha256,status,provider_status,diagnostic_code,output_identities) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(company_id,project_id,job_id,source,source_sha256) DO NOTHING`,[row.company_id,row.project_id,row.id,source,sha,status,job.providerStatus,code,JSON.stringify(outputs.map(o=>({ordinal:o.ordinal,kind:o.kind,identity:o.identity})))]);
 if(!conflict&&outputs.length&&!old.length)for(const output of outputs){
  const outputId=randomUUID();
  await db.query('INSERT INTO higgsfield_job_outputs(id,company_id,project_id,job_id,ordinal,kind,locator_identity) VALUES($1,$2,$3,$4,$5,$6,$7)',[outputId,row.company_id,row.project_id,row.id,output.ordinal,output.kind,output.identity]);
  const sealed=sealHiggsfieldSecret({locator:output.locator},{companyId:row.company_id,id:outputId,purpose:'provider-output'});
  await db.query('INSERT INTO higgsfield_output_locators(output_id,company_id,project_id,sealed) VALUES($1,$2,$3,$4)',[outputId,row.company_id,row.project_id,JSON.stringify(sealed)]);
 }
 await db.query(`UPDATE higgsfield_jobs SET status=$4,diagnostic_code=$5,next_poll_at=CASE WHEN $4 IN ('queued','running') THEN clock_timestamp()+interval '1 minute' ELSE NULL END,poll_lease_id=NULL,poll_lease_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND project_id=$2 AND id=$3`,[row.company_id,row.project_id,row.id,status,code]);
}

export async function listHiggsfieldJobs(db:PoolClient,companyId:string,input:unknown){
 const parsed=higgsfieldJobsInput.safeParse(input);if(!parsed.success)fail(400,'Use a project and a bounded job page.');const data=parsed.data;
 if(!(await db.query('SELECT 1 FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,data.projectId])).rowCount)fail(404,'Project not found.');
 if(data.requestId&&!(await db.query('SELECT 1 FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,data.projectId,data.requestId])).rowCount)fail(404,'Generation request not found.');
 if(data.after&&!(await db.query('SELECT 1 FROM higgsfield_jobs WHERE company_id=$1 AND project_id=$2 AND id=$3 AND ($4::uuid IS NULL OR request_id=$4)',[companyId,data.projectId,data.after,data.requestId??null])).rowCount)fail(404,'Job cursor not found.');
 const rows=(await db.query(`SELECT id,project_id AS "projectId",request_id AS "requestId",provider_job_id AS "providerJobId",kind,model,status,diagnostic_code AS "diagnosticCode",poll_attempts AS "pollAttempts",next_poll_at AS "nextPollAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM higgsfield_jobs WHERE company_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR request_id=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,[companyId,data.projectId,data.requestId??null,data.after??null,data.limit+1])).rows;
 const page=rows.slice(0,data.limit),outputs=page.length?(await db.query(`SELECT id,job_id AS "jobId",ordinal,kind,locator_identity AS "locatorIdentity",false AS "bytesVerified" FROM higgsfield_job_outputs WHERE company_id=$1 AND project_id=$2 AND job_id=ANY($3::uuid[]) ORDER BY ordinal`,[companyId,data.projectId,page.map(r=>r.id)])).rows:[];
 return {jobs:page.map(job=>({...job,outputs:outputs.filter(o=>o.jobId===job.id).map(({jobId:_,...output})=>output)})),hasMore:rows.length>data.limit,nextAfter:rows.length>data.limit?page.at(-1)!.id:null};
}

/** Recheck the durable human adoption, exact account identity and current
 * project permission. This is read-only provider authority, never an agent
 * lease extension, generation retry, file transfer or task approval. */
async function pollAuthority(db:PoolClient,row:Row):Promise<{member:Membership;arguments:Record<string,unknown>}|{code:string;retryable?:boolean}>{
 const request=(await db.query('SELECT * FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR SHARE',[row.company_id,row.project_id,row.request_id])).rows[0];
 if(!request?.connection_id||request.status!=='returned'||!request.approved_by)return {code:'HIGGSFIELD_POLL_NOT_ADOPTED'};
 const receipt=(await db.query('SELECT * FROM higgsfield_job_receipts WHERE company_id=$1 AND project_id=$2 AND request_id=$3',[row.company_id,row.project_id,row.request_id])).rows[0];
 if(!receipt||receipt.outcome!=='jobs'||receipt.connection_id!==request.connection_id||receipt.connection_revision!==request.connection_revision||receipt.approved_by!==request.approved_by||receipt.request_hash!==request.request_hash)return {code:'HIGGSFIELD_POLL_RECEIPT_MISMATCH'};
 const member=(await db.query(`SELECT m.role,u.id,u.name,u.email,u.role_title AS "roleTitle",u.avatar_color AS "avatarColor",u.avatar_id AS "avatarId",u.email_verified_at IS NOT NULL AS "emailVerified" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin') FOR SHARE OF m`,[row.company_id,request.approved_by])).rows[0];
 if(!member)return {code:'HIGGSFIELD_APPROVER_UNAVAILABLE'};
 const current=(await db.query(`SELECT c.* FROM higgsfield_connections c JOIN memberships m ON m.company_id=c.company_id AND m.user_id=c.connected_by WHERE c.company_id=$1 AND m.role IN ('owner','admin') FOR SHARE OF c,m`,[row.company_id])).rows[0];
 if(!current||current.id!==request.connection_id||current.revision!==request.connection_revision)return {code:'HIGGSFIELD_CONNECTION_CHANGED'};
 if(current.status==='reconnect_required'&&current.sealed===null)return {code:'HIGGSFIELD_CONNECTION_REFRESH_PENDING',retryable:true};
 if(current.status!=='connected')return {code:'HIGGSFIELD_CONNECTION_CHANGED'};
 const project=(await db.query('SELECT status,ai_policy,gates FROM studio_projects WHERE company_id=$1 AND id=$2 FOR SHARE',[row.company_id,row.project_id])).rows[0];
 if(!project||project.status==='delivered'||project.ai_policy!=='allowed'||['brief','estimate','production'].some(gate=>project.gates[gate]?.decision!=='approved'))return {code:'HIGGSFIELD_PROJECT_AUTHORITY_CHANGED'};
 if(request.work_item_id){
  await db.query('SELECT role_key FROM studio_role_bindings WHERE company_id=$1 ORDER BY role_key FOR SHARE',[row.company_id]);
  const work=(await db.query(`SELECT b.agent_id,b.human_id FROM studio_work_items w LEFT JOIN studio_role_bindings b ON b.company_id=w.company_id AND b.role_key=w.role_key WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3`,[row.company_id,row.project_id,request.work_item_id])).rows[0];
  if(!work||(work.agent_id??null)!==request.role_agent_id||(work.human_id??null)!==request.role_human_id)return {code:'HIGGSFIELD_WORK_CHANGED'};
 }
 const tool=current.tools.find((tool:Row)=>tool.name==='jobs_wait'),args=buildHiggsfieldPollArguments(tool?.inputSchema,[row.provider_job_id]);
 if(!args)return {code:'HIGGSFIELD_POLL_SCHEMA_UNSUPPORTED'};
 return {member:{companyId:row.company_id,userId:member.id,role:member.role,user:{id:member.id,name:member.name,email:member.email,roleTitle:member.roleTitle,avatarColor:member.avatarColor,avatarId:member.avatarId,emailVerified:member.emailVerified}},arguments:args};
}

async function deferAuthority(db:PoolClient,row:Row,authority:{code:string;retryable?:boolean}){
 if(!authority.retryable)return stopJob(db,row,'blocked',authority.code);
 await db.query("UPDATE higgsfield_jobs SET diagnostic_code=$3,next_poll_at=clock_timestamp()+interval '5 minutes',poll_lease_id=NULL,poll_lease_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[row.company_id,row.id,authority.code]);
}
async function stopJob(db:PoolClient,row:Row,status:string,code:string){
 await db.query('UPDATE higgsfield_jobs SET status=$4,diagnostic_code=$5,next_poll_at=NULL,poll_lease_id=NULL,poll_lease_expires_at=NULL,updated_at=clock_timestamp() WHERE company_id=$1 AND project_id=$2 AND id=$3',[row.company_id,row.project_id,row.id,status,code]);
}

/** Bounded, leased, read-only reconciliation. A process crash only repeats a
 * status read after the lease expires; the paid dispatch is never repeated. */
export async function reconcileHiggsfieldJobs(limit=2){
 if(!Number.isInteger(limit)||limit<1||limit>2)throw Error('Invalid job reconciliation limit');
 const due=(await query(`SELECT id,company_id FROM higgsfield_jobs WHERE next_poll_at<=clock_timestamp() AND (poll_lease_expires_at IS NULL OR poll_lease_expires_at<=clock_timestamp()) ORDER BY next_poll_at,id LIMIT $1`,[limit])).rows;
 let checked=0,blocked=0;
 for(const hint of due){
  const claim=await transaction(async db=>{
   await db.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[hint.company_id]);
   const row=(await db.query(`SELECT * FROM higgsfield_jobs WHERE company_id=$1 AND id=$2 AND next_poll_at<=clock_timestamp() AND (poll_lease_expires_at IS NULL OR poll_lease_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED`,[hint.company_id,hint.id])).rows[0];
   if(!row)return null;
   if(row.poll_attempts>=1440||+new Date(row.deadline_at)<=Date.now()){await stopJob(db,row,'unresolved','HIGGSFIELD_POLL_BUDGET_EXHAUSTED');blocked++;return null;}
   const authority=await pollAuthority(db,row);if('code'in authority){await deferAuthority(db,row,authority);blocked++;return null;}
   const lease=randomUUID();await db.query(`UPDATE higgsfield_jobs SET poll_attempts=poll_attempts+1,poll_lease_id=$3,poll_lease_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2`,[row.company_id,row.id,lease]);
   return {row,lease,...authority};
  });
  if(!claim)continue;
  let response:unknown,transportFailed=false;
  try{
   const {higgsfieldCredential}=await import('./higgsfield');const saved=await higgsfieldCredential(claim.member);
   if('error'in saved)throw Error('Credentials unavailable');
   // Credential refresh may cross a revocation. Check identity/authority again
   // immediately before provider I/O, then again before accepting its response.
   const allowed=await transaction(async db=>{
    const current=(await db.query('SELECT * FROM higgsfield_jobs WHERE company_id=$1 AND id=$2 AND poll_lease_id=$3 AND poll_lease_expires_at>clock_timestamp() FOR UPDATE',[claim.row.company_id,claim.row.id,claim.lease])).rows[0];
    if(!current)return false;const authority=await pollAuthority(db,current);if('code'in authority){await deferAuthority(db,current,authority);return false;}return true;
   });
   if(!allowed){blocked++;continue;}
   response=await callHiggsfieldTool(saved.token,'jobs_wait',claim.arguments,{timeoutMs:12000});
   if(Buffer.byteLength(JSON.stringify(response))>262144)throw Error('Bounded response exceeded');
  }catch{transportFailed=true;}
  await transaction(async db=>{
   const row=(await db.query('SELECT * FROM higgsfield_jobs WHERE company_id=$1 AND id=$2 AND poll_lease_id=$3 AND poll_lease_expires_at>clock_timestamp() FOR UPDATE',[claim.row.company_id,claim.row.id,claim.lease])).rows[0];if(!row)return;
   const authority=await pollAuthority(db,row);if('code'in authority){await deferAuthority(db,row,authority);blocked++;return;}
   if(transportFailed){await db.query(`UPDATE higgsfield_jobs SET diagnostic_code='HIGGSFIELD_POLL_TRANSPORT_UNCERTAIN',poll_lease_id=NULL,poll_lease_expires_at=NULL,next_poll_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2`,[row.company_id,row.id]);return;}
   await preserveProviderResponse(db,row,response,'poll',row.id);
   const normalized=normalizeHiggsfieldPoll(response,[row.provider_job_id]);
   if(!normalized.supported||normalized.outcome!=='jobs'){
    await db.query(`INSERT INTO higgsfield_job_observations(company_id,project_id,job_id,source,source_sha256,status,diagnostic_code) VALUES($1,$2,$3,'poll',$4,'unresolved',$5) ON CONFLICT(company_id,project_id,job_id,source,source_sha256) DO NOTHING`,[row.company_id,row.project_id,row.id,sourceHash(response),normalized.code??'HIGGSFIELD_UNSUPPORTED_SHAPE']);
    await stopJob(db,row,'unresolved',normalized.code??'HIGGSFIELD_UNSUPPORTED_SHAPE');return;
   }
   await applyObservation(db,row,normalized.jobs[0],sourceHash(response),'poll');
  });
  checked++;
 }
 return {checked,blocked,providerGenerationsSubmitted:0};
}
