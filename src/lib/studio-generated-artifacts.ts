import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {assertGeneratedWorkCurrent} from './studio-generated-rounds';
import {z} from 'zod';
import {fail,id} from './security';
import {authorizeProjectStorageActor} from './project-storage';
import type {StudioActor} from './studio';
import type {StudioGeneratedArtifact} from './studio-protocol';
import {studioGeneratedArtifactRegisterInput,studioGeneratedSpecInput,studioGeneratedWorkUnitInput,studioGeneratedObservedMediaInput,studioGeneratedFileFactsInput,generatedSpecificationSha256,matchGeneratedArchiveMedia} from './studio-generated-protocol';

const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const sourceInput=z.object({requestId:uuid,requestHash:hash,receiptHash:hash,contract:z.string().min(1).max(120),providerConnectionId:uuid,requestConnectionRevision:z.number().int().positive(),providerSponsorId:uuid,providerJobId:uuid,kind:z.enum(['image','video','audio']),model:z.string().min(1).max(200).nullable(),outputId:uuid,ordinal:z.number().int().min(0).max(10000),outputIdentity:hash,requestedBy:uuid,agentId:uuid.nullable(),runId:uuid.nullable(),agentSponsorId:uuid.nullable(),approvedBy:uuid,workItemId:uuid,roleAgentId:uuid.nullable(),roleHumanId:uuid.nullable(),taskId:uuid,roleKey:z.string().min(1).max(80)}).strict();
type Source=z.infer<typeof sourceInput>;
type Row=Record<string,any>;
/** ASCII-key canonicalization is v2-only. Never use it to rewrite v1 receipts. */
function canonical(value:unknown):string{return Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(value);}
const digest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const invalid=():never=>fail(409,'The generated media evidence is incomplete or changed.','STUDIO_GENERATED_EVIDENCE_INVALID');
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)return invalid();return result.data;}
const manifestInput=z.object({schemaVersion:z.literal(2),kind:z.literal('verified_generated_media'),mediaKind:z.enum(['image','video','audio']),companyId:uuid,projectId:uuid,artifactId:uuid,workItemId:uuid,archiveId:uuid,archiveApprovedBy:uuid,requestId:uuid,jobId:uuid,outputId:uuid,storageVersionId:uuid,specSha256:hash,source:sourceInput,media:studioGeneratedObservedMediaInput,file:studioGeneratedFileFactsInput}).strict();
export {sourceInput as studioGeneratedSourceInput,manifestInput as studioGeneratedManifestInput};
export type StudioGeneratedManifestInput={companyId:string;projectId:string;artifactId:string;workItemId:string;archiveId:string;archiveApprovedBy:string;requestId:string;jobId:string;outputId:string;storageVersionId:string;specSha256:string;sourceSnapshot:unknown;observedMedia:unknown;fileFacts:unknown};
export function buildStudioGeneratedArtifactManifest(input:StudioGeneratedManifestInput){
 const manifest=parse(manifestInput,{schemaVersion:2,kind:'verified_generated_media',mediaKind:parse(sourceInput,input.sourceSnapshot).kind,companyId:input.companyId,projectId:input.projectId,artifactId:input.artifactId,workItemId:input.workItemId,archiveId:input.archiveId,archiveApprovedBy:input.archiveApprovedBy,requestId:input.requestId,jobId:input.jobId,outputId:input.outputId,storageVersionId:input.storageVersionId,specSha256:input.specSha256,source:input.sourceSnapshot,media:input.observedMedia,file:input.fileFacts});
 if(manifest.source.kind!==manifest.media.kind||manifest.source.workItemId!==manifest.workItemId||manifest.source.requestId!==manifest.requestId||manifest.source.outputId!==manifest.outputId||manifest.media.bytes!==manifest.file.bytes||manifest.media.sha256!==manifest.file.sha256||manifest.media.contentType!==manifest.file.contentType)invalid();
 const manifestText=canonical(manifest);if(Buffer.byteLength(manifestText)>131072)invalid();return {manifest,manifestText,manifestSha256:digest(manifestText)};
}
export const studioGeneratedArtifactManifestPath=(companyId:string,projectId:string,artifactId:string)=>`/api/companies/${id(companyId)}/studio/projects/${id(projectId)}/generated-artifacts/${id(artifactId)}/manifest`;

async function requirements(db:PoolClient,companyId:string,projectId:string,workItemId:string){
 const row=(await db.query(`SELECT p.contract_version,p.production_path,p.spec,w.id,w.task_id,w.role_key,w.stage,w.execution,s.media_kind,s.code,s.description,s.duration_min_ms,s.duration_max_ms
 FROM studio_projects p JOIN studio_work_items w ON w.company_id=p.company_id AND w.project_id=p.id JOIN studio_shots s ON s.company_id=w.company_id AND s.project_id=w.project_id AND s.id=w.shot_id WHERE p.company_id=$1 AND p.id=$2 AND w.id=$3`,[companyId,projectId,workItemId])).rows[0];
 return parseRequirements(row);
}
function parseRequirements(row:Row){
 if(!row||row.contract_version!==2||row.production_path!=='higgsfield'||row.stage!=='generation'||row.execution!=='creative')invalid();
 const spec=parse(studioGeneratedSpecInput,row.spec),unit=parse(studioGeneratedWorkUnitInput,{kind:row.media_kind,code:row.code,description:row.description,...row.media_kind==='image'?{}:{durationMs:{min:row.duration_min_ms,max:row.duration_max_ms}}});
 if(spec.kind!==unit.kind)invalid();return {spec,unit,taskId:row.task_id as string,roleKey:row.role_key as string};
}
type Requirement=ReturnType<typeof parseRequirements>;
function assertArchive(a:Row,available:boolean){if(!a||available&&(a.status!=='verified'||a.revoked_at)||!a.approved_by||!a.upload_id||!a.version_id)invalid();}
function parseSourceEvidence(requirement:Requirement,workItemId:string,a:Row,row:Row,available:boolean){
 const source=parse(sourceInput,a.source_snapshot);
 if(!row||available&&(row.job_status!=='completed'||row.request_status!=='returned')||row.outcome!=='jobs'||row.kind!==row.job_kind||row.connection_id!==a.provider_connection_id||row.job_connection_id!==row.connection_id||row.receipt_connection_id!==row.connection_id||row.receipt_connection_revision!==row.connection_revision||row.receipt_request_hash!==row.request_hash||row.receipt_approved_by!==row.approved_by||row.work_item_id!==workItemId||row.locator_identity!==a.locator_identity)invalid();
 const expected:Source={requestId:a.request_id,requestHash:row.request_hash,receiptHash:row.source_sha256,contract:row.contract,providerConnectionId:row.connection_id,requestConnectionRevision:row.connection_revision,providerSponsorId:source.providerSponsorId,providerJobId:row.provider_job_id,kind:row.kind,model:row.model,outputId:a.output_id,ordinal:row.ordinal,outputIdentity:row.locator_identity,requestedBy:row.requested_by,agentId:row.agent_id,runId:row.run_id,agentSponsorId:source.agentSponsorId,approvedBy:row.approved_by,workItemId,roleAgentId:row.role_agent_id,roleHumanId:row.role_human_id,taskId:requirement.taskId,roleKey:requirement.roleKey};
 if(!equal(source,expected)||source.kind!==requirement.spec.kind||Boolean(source.agentId)!==Boolean(source.runId)||Boolean(source.agentId)!==Boolean(source.agentSponsorId))invalid();return source;
}
function assertOriginalRun(source:Source,run:Row|undefined){if(source.agentId&&(!run||run.agent_id!==source.agentId||run.requested_by!==source.requestedBy))invalid();}
function assertStoredFile(a:Row,archiveId:string,stored:Row,available:boolean){
 if(!stored||available&&(stored.status!=='ready'||stored.action_id!==null)||stored.archive_id!==archiveId||stored.actor_key!=='archive:'+archiveId||stored.actor_user_id!==a.approved_by||stored.actor_agent_id!==null||stored.run_id!==null||stored.locator_identity!==a.locator_identity||stored.provider_etag!==stored.verified_etag||stored.fetched_bytes!==stored.version_bytes||stored.version_bytes!==stored.verified_bytes||stored.fetched_sha256!==stored.version_sha256||stored.version_sha256!==stored.verified_sha256||stored.verified_bytes>Number(a.max_bytes))invalid();
}
async function completeEvidence(requirement:Requirement,a:Row,source:Source,stored:Row){
 const observedMedia=parse(studioGeneratedObservedMediaInput,stored.media),fileFacts=parse(studioGeneratedFileFactsInput,{bytes:stored.verified_bytes,sha256:stored.verified_sha256,contentType:stored.content_type});
 const match=matchGeneratedArchiveMedia(requirement.spec,requirement.unit,observedMedia,fileFacts);if(!match.matches)fail(409,'The verified media does not match the generated work requirements.','STUDIO_GENERATED_SPEC_MISMATCH');
 return {archiveId:a.id as string,archiveApprovedBy:a.approved_by as string,requestId:a.request_id as string,jobId:a.job_id as string,outputId:a.output_id as string,storageVersionId:a.version_id as string,sourceSnapshot:source,observedMedia,fileFacts,specSha256:await generatedSpecificationSha256(requirement.spec,requirement.unit),mediaKind:source.kind,match,...requirement};
}

/** Trusted transaction-only reader. It reads no locator, object key, credentials,
 * or provider journal, and does not authorize a caller. Historical completed
 * leases are intentionally irrelevant; current storage availability is not. */
export async function loadVerifiedGeneratedSource(db:PoolClient,companyId:string,projectId:string,workItemId:string,archiveId:string,options:{requireAvailable?:boolean}={}){
 const requireAvailable=options.requireAvailable!==false;
 [companyId,projectId,workItemId,archiveId].forEach(id);const requirement=await requirements(db,companyId,projectId,workItemId);
 const a=(await db.query(`SELECT id,request_id,job_id,output_id,locator_identity,source_snapshot,provider_connection_id,storage_binding_id,storage_connection_id,storage_connection_snapshot,approved_by,status,revoked_at,upload_id,version_id,max_bytes FROM higgsfield_output_archives WHERE company_id=$1 AND project_id=$2 AND id=$3${requireAvailable?' FOR SHARE':''}`,[companyId,projectId,archiveId])).rows[0];
 assertArchive(a,requireAvailable);
 const row=(await db.query(`SELECT o.id AS output_id,o.job_id,o.kind,o.ordinal,o.locator_identity,j.request_id,j.provider_job_id,j.connection_id AS job_connection_id,j.kind AS job_kind,j.model,j.status AS job_status,
 r.status AS request_status,r.requested_by,r.agent_id,r.run_id,r.approved_by,r.request_hash,r.connection_id,r.connection_revision,r.work_item_id,r.role_agent_id,r.role_human_id,
 receipt.connection_id AS receipt_connection_id,receipt.connection_revision AS receipt_connection_revision,receipt.approved_by AS receipt_approved_by,receipt.request_hash AS receipt_request_hash,receipt.source_sha256,receipt.outcome,receipt.contract
 FROM higgsfield_job_outputs o JOIN higgsfield_jobs j ON j.company_id=o.company_id AND j.project_id=o.project_id AND j.id=o.job_id JOIN higgsfield_requests r ON r.company_id=j.company_id AND r.project_id=j.project_id AND r.id=j.request_id JOIN higgsfield_job_receipts receipt ON receipt.company_id=r.company_id AND receipt.project_id=r.project_id AND receipt.request_id=r.id
 WHERE o.company_id=$1 AND o.project_id=$2 AND o.id=$3 AND j.id=$4 AND r.id=$5${requireAvailable?' FOR SHARE OF j,r':''}`,[companyId,projectId,a.output_id,a.job_id,a.request_id])).rows[0];
 const source=parseSourceEvidence(requirement,workItemId,a,row,requireAvailable);
 if(source.agentId)assertOriginalRun(source,(await db.query('SELECT agent_id,requested_by FROM agent_runs WHERE company_id=$1 AND id=$2',[companyId,source.runId])).rows[0]);
 const stored=(await db.query(`SELECT f.bytes::float8 AS fetched_bytes,f.sha256 AS fetched_sha256,f.media,f.locator_identity,v.bytes::float8 AS version_bytes,v.sha256 AS version_sha256,v.content_type,v.file_id,
 ok.bytes::float8 AS verified_bytes,ok.sha256 AS verified_sha256,ok.provider_etag AS verified_etag,u.status,u.archive_id,u.actor_key,u.actor_user_id,u.actor_agent_id,u.run_id,u.action_id,u.provider_etag
 FROM higgsfield_archive_fetches f JOIN project_storage_versions v ON v.company_id=f.company_id AND v.project_id=f.project_id AND v.id=$4 JOIN project_storage_verifications ok ON ok.company_id=v.company_id AND ok.project_id=v.project_id AND ok.version_id=v.id JOIN project_storage_uploads u ON u.company_id=v.company_id AND u.project_id=v.project_id AND u.version_id=v.id AND u.id=$5
 WHERE f.company_id=$1 AND f.project_id=$2 AND f.archive_id=$3${requireAvailable?' FOR SHARE OF u':''}`,[companyId,projectId,archiveId,a.version_id,a.upload_id])).rows[0];
 assertStoredFile(a,archiveId,stored,requireAvailable);
 if(requireAvailable){
  // Match writableBinding/file rename: connection, binding, then file. A
  // joined FOR SHARE OF f,b,c can hold f while waiting for a rename's binding
  // lock; that rename then waits for f. Separate statements make the order
  // independent of the join plan while retaining stable file membership.
  const connection=(await db.query('SELECT id FROM project_storage_connections WHERE company_id=$1 AND id=$2 FOR SHARE',[companyId,a.storage_connection_id])).rows[0];
  const binding=(await db.query('SELECT id FROM project_storage_bindings WHERE company_id=$1 AND project_id=$2 AND id=$3 AND connection_id=$4 FOR SHARE',[companyId,projectId,a.storage_binding_id,a.storage_connection_id])).rows[0];
  if(!connection||!binding)invalid();
 }
 const storage=(await db.query(requireAvailable?`SELECT b.id AS binding_id,b.connection_id,c.id,c.region,c.volume_id,c.created_by,c.status,c.secret_envelope IS NOT NULL AS credentials_present,c.provider
 FROM project_storage_files f JOIN project_storage_bindings b ON b.company_id=f.company_id AND b.project_id=f.project_id AND b.id=f.binding_id JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id WHERE f.company_id=$1 AND f.project_id=$2 AND f.id=$3 FOR SHARE OF f`:'SELECT binding_id FROM project_storage_files WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,projectId,stored.file_id])).rows[0];
 const snapshot=a.storage_connection_snapshot;
 if(!storage||storage.binding_id!==a.storage_binding_id)invalid();
 if(requireAvailable){
  if(storage.connection_id!==a.storage_connection_id||storage.status!=='configured'||!storage.credentials_present||storage.provider!=='runpod'||snapshot?.id!==storage.id||snapshot?.region!==storage.region||snapshot?.volumeId!==storage.volume_id)fail(409,'The archived file storage is unavailable or changed.','STUDIO_GENERATED_STORAGE_UNAVAILABLE');
  const sponsor=(await db.query("SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE",[companyId,storage.created_by])).rows[0];if(!sponsor||!['owner','admin'].includes(sponsor.role))fail(409,'The archived file storage sponsor is unavailable.','STUDIO_GENERATED_STORAGE_UNAVAILABLE');
 }
 return completeEvidence(requirement,a,source,stored);
}

/** Historical reads validate exact stored manifest and immutable evidence without
 * blocking active transfers. Publication/QC callers set requireAvailable:true.
 * Caller must authenticate membership/lease and retain its transaction. */
export async function loadStoredGeneratedArtifact(db:PoolClient,companyId:string,projectId:string,artifactId:string,options:{requireAvailable?:boolean}={}){
 [companyId,projectId,artifactId].forEach(id);
 if(options.requireAvailable!==true)return (await loadStoredGeneratedArtifacts(db,companyId,projectId,[artifactId]))[0];
 const a=(await db.query(`SELECT a.id,a.work_item_id,a.name,a.version,a.url,a.sha256,a.metadata,a.produced_by,a.produced_agent_id,a.agent_sponsor_id,a.run_id,a.created_at,a.contract_version,
 s.archive_id,s.request_id,s.job_id,s.output_id,s.storage_version_id,s.spec_sha256,s.manifest_text,s.manifest_sha256,s.source_snapshot,s.observed_media,s.file_facts,s.archive_approved_by,s.registered_by,s.registered_agent_id,s.registered_run_id,
 COALESCE((SELECT decision FROM studio_reviews r WHERE r.company_id=a.company_id AND r.project_id=a.project_id AND r.artifact_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1),'pending') AS review_status
 FROM studio_artifacts a JOIN studio_generated_artifact_sources s ON s.company_id=a.company_id AND s.project_id=a.project_id AND s.artifact_id=a.id AND s.work_item_id=a.work_item_id WHERE a.company_id=$1 AND a.project_id=$2 AND a.id=$3`,[companyId,projectId,artifactId])).rows[0];
 if(!a||a.contract_version!==2)invalid();
 const evidence=await loadVerifiedGeneratedSource(db,companyId,projectId,a.work_item_id,a.archive_id,{requireAvailable:options.requireAvailable===true});
 return projectStoredArtifact(companyId,projectId,artifactId,a,evidence);
}
function projectStoredArtifact(companyId:string,projectId:string,artifactId:string,a:Row,evidence:Awaited<ReturnType<typeof completeEvidence>>){
 if(!a||a.contract_version!==2)invalid();
 if(a.request_id!==evidence.requestId||a.job_id!==evidence.jobId||a.output_id!==evidence.outputId||a.storage_version_id!==evidence.storageVersionId||a.archive_approved_by!==evidence.archiveApprovedBy||a.spec_sha256!==evidence.specSha256||!equal(a.source_snapshot,evidence.sourceSnapshot)||!equal(a.observed_media,evidence.observedMedia)||!equal(a.file_facts,evidence.fileFacts)||a.produced_by!==evidence.sourceSnapshot.requestedBy||a.produced_agent_id!==evidence.sourceSnapshot.agentId||a.run_id!==evidence.sourceSnapshot.runId||a.agent_sponsor_id!==evidence.sourceSnapshot.agentSponsorId)invalid();
 const manifest=buildStudioGeneratedArtifactManifest({companyId,projectId,artifactId,workItemId:a.work_item_id,...evidence});
 if(manifest.manifestText!==a.manifest_text||manifest.manifestSha256!==a.manifest_sha256||a.sha256!==a.manifest_sha256||a.url!==studioGeneratedArtifactManifestPath(companyId,projectId,artifactId))invalid();
 const metadata=parse(z.object({notes:z.string().max(4000)}).strict(),a.metadata);
 const artifact:StudioGeneratedArtifact={contractVersion:2,kind:'verified_generated_media',mediaKind:evidence.mediaKind,id:artifactId,workItemId:a.work_item_id,name:a.name,version:a.version,url:a.url,sha256:a.sha256,notes:metadata.notes,reviewStatus:a.review_status,createdAt:new Date(a.created_at).toISOString(),producedBy:a.produced_by,producedAgentId:a.produced_agent_id,media:evidence.observedMedia,file:evidence.fileFacts,source:evidence.sourceSnapshot,provenance:{archiveId:a.archive_id,archiveApprovedBy:a.archive_approved_by,requestId:a.request_id,jobId:a.job_id,outputId:a.output_id,storageVersionId:a.storage_version_id,registeredBy:a.registered_by,registeredAgentId:a.registered_agent_id,registeredRunId:a.registered_run_id},specSha256:a.spec_sha256,manifestSha256:a.manifest_sha256,limitations:evidence.match.limitations};
 return {artifact,manifestText:manifest.manifestText,manifestSha256:manifest.manifestSha256,...evidence,registeredBy:a.registered_by as string,registeredAgentId:a.registered_agent_id as string|null,registeredRunId:a.registered_run_id as string|null,workItemId:a.work_item_id as string};
}

/** One snapshot and one bounded query for immutable historical evidence. Missing,
 * foreign, duplicated or incomplete IDs fail the entire read rather than being
 * silently omitted. No lifecycle authority, row locks or credential columns are
 * involved. Active publication still uses the separate availability path. */
export async function loadStoredGeneratedArtifacts(db:PoolClient,companyId:string,projectId:string,artifactIds:string[]){
 companyId=id(companyId).toLowerCase();projectId=id(projectId).toLowerCase();
 const parsed=z.array(uuid).max(1000).safeParse(artifactIds);if(!parsed.success)fail(400,'Use at most 1,000 exact generated artifact IDs.','VALIDATION_ERROR');
 const ids=parsed.data.map(value=>value.toLowerCase());if(new Set(ids).size!==ids.length)fail(400,'Generated artifact IDs must be distinct.','VALIDATION_ERROR');
 if(ids.length===0)return [];
 // OFFSET 0 keeps the unique-ID lookups correlated. Without these barriers a
 // fresh project with poor statistics can become a many-table nested-loop
 // cross-product before identity filters are applied, despite bounded IDs.
 const rows=(await db.query(`SELECT a.id,
 jsonb_build_object('id',a.id,'work_item_id',a.work_item_id,'name',a.name,'version',a.version,'url',a.url,'sha256',a.sha256,'metadata',a.metadata,'produced_by',a.produced_by,'produced_agent_id',a.produced_agent_id,'agent_sponsor_id',a.agent_sponsor_id,'run_id',a.run_id,'created_at',a.created_at,'contract_version',a.contract_version,
 'archive_id',s.archive_id,'request_id',s.request_id,'job_id',s.job_id,'output_id',s.output_id,'storage_version_id',s.storage_version_id,'spec_sha256',s.spec_sha256,'manifest_text',s.manifest_text,'manifest_sha256',s.manifest_sha256,'source_snapshot',s.source_snapshot,'observed_media',s.observed_media,'file_facts',s.file_facts,'archive_approved_by',s.archive_approved_by,'registered_by',s.registered_by,'registered_agent_id',s.registered_agent_id,'registered_run_id',s.registered_run_id,'review_status',COALESCE(review.decision,'pending')) AS artifact,
 jsonb_build_object('contract_version',p.contract_version,'production_path',p.production_path,'spec',p.spec,'task_id',w.task_id,'role_key',w.role_key,'stage',w.stage,'execution',w.execution,'media_kind',shot.media_kind,'code',shot.code,'description',shot.description,'duration_min_ms',shot.duration_min_ms,'duration_max_ms',shot.duration_max_ms) AS requirement,
 jsonb_build_object('id',ar.id,'request_id',ar.request_id,'job_id',ar.job_id,'output_id',ar.output_id,'locator_identity',ar.locator_identity,'source_snapshot',ar.source_snapshot,'provider_connection_id',ar.provider_connection_id,'storage_binding_id',ar.storage_binding_id,'approved_by',ar.approved_by,'upload_id',ar.upload_id,'version_id',ar.version_id,'max_bytes',ar.max_bytes) AS archive,
 jsonb_build_object('kind',o.kind,'ordinal',o.ordinal,'locator_identity',o.locator_identity,'provider_job_id',j.provider_job_id,'job_connection_id',j.connection_id,'job_kind',j.kind,'model',j.model,'requested_by',r.requested_by,'agent_id',r.agent_id,'run_id',r.run_id,'approved_by',r.approved_by,'request_hash',r.request_hash,'connection_id',r.connection_id,'connection_revision',r.connection_revision,'work_item_id',r.work_item_id,'role_agent_id',r.role_agent_id,'role_human_id',r.role_human_id,
 'receipt_connection_id',receipt.connection_id,'receipt_connection_revision',receipt.connection_revision,'receipt_approved_by',receipt.approved_by,'receipt_request_hash',receipt.request_hash,'source_sha256',receipt.source_sha256,'outcome',receipt.outcome,'contract',receipt.contract) AS source,
 jsonb_build_object('fetched_bytes',af.bytes::float8,'fetched_sha256',af.sha256,'media',af.media,'locator_identity',af.locator_identity,'version_bytes',v.bytes::float8,'version_sha256',v.sha256,'content_type',v.content_type,'verified_bytes',ok.bytes::float8,'verified_sha256',ok.sha256,'verified_etag',ok.provider_etag,'archive_id',u.archive_id,'actor_key',u.actor_key,'actor_user_id',u.actor_user_id,'actor_agent_id',u.actor_agent_id,'run_id',u.run_id,'provider_etag',u.provider_etag) AS stored,
 file.binding_id,jsonb_build_object('agent_id',original_run.agent_id,'requested_by',original_run.requested_by) AS original_run
 FROM studio_artifacts a
 JOIN LATERAL (SELECT s.archive_id,s.request_id,s.job_id,s.output_id,s.storage_version_id,s.spec_sha256,s.manifest_text,s.manifest_sha256,s.source_snapshot,s.observed_media,s.file_facts,s.archive_approved_by,s.registered_by,s.registered_agent_id,s.registered_run_id FROM studio_generated_artifact_sources s WHERE s.company_id=a.company_id AND s.project_id=a.project_id AND s.artifact_id=a.id AND s.work_item_id=a.work_item_id OFFSET 0) s ON true
 JOIN studio_projects p ON p.company_id=a.company_id AND p.id=a.project_id
 JOIN LATERAL (SELECT w.task_id,w.role_key,w.stage,w.execution,w.shot_id FROM studio_work_items w WHERE w.company_id=a.company_id AND w.project_id=a.project_id AND w.id=a.work_item_id OFFSET 0) w ON true
 JOIN LATERAL (SELECT shot.media_kind,shot.code,shot.description,shot.duration_min_ms,shot.duration_max_ms FROM studio_shots shot WHERE shot.company_id=a.company_id AND shot.project_id=a.project_id AND shot.id=w.shot_id OFFSET 0) shot ON true
 JOIN LATERAL (SELECT ar.id,ar.request_id,ar.job_id,ar.output_id,ar.locator_identity,ar.source_snapshot,ar.provider_connection_id,ar.storage_binding_id,ar.approved_by,ar.upload_id,ar.version_id,ar.max_bytes FROM higgsfield_output_archives ar WHERE ar.company_id=a.company_id AND ar.project_id=a.project_id AND ar.id=s.archive_id OFFSET 0) ar ON true
 JOIN LATERAL (SELECT o.job_id,o.kind,o.ordinal,o.locator_identity FROM higgsfield_job_outputs o WHERE o.company_id=a.company_id AND o.project_id=a.project_id AND o.id=ar.output_id OFFSET 0) o ON true
 JOIN LATERAL (SELECT j.request_id,j.provider_job_id,j.connection_id,j.kind,j.model FROM higgsfield_jobs j WHERE j.company_id=a.company_id AND j.project_id=a.project_id AND j.id=o.job_id AND j.id=ar.job_id OFFSET 0) j ON true
 JOIN LATERAL (SELECT r.id,r.requested_by,r.agent_id,r.run_id,r.approved_by,r.request_hash,r.connection_id,r.connection_revision,r.work_item_id,r.role_agent_id,r.role_human_id FROM higgsfield_requests r WHERE r.company_id=a.company_id AND r.project_id=a.project_id AND r.id=j.request_id AND r.id=ar.request_id OFFSET 0) r ON true
 JOIN LATERAL (SELECT receipt.connection_id,receipt.connection_revision,receipt.approved_by,receipt.request_hash,receipt.source_sha256,receipt.outcome,receipt.contract FROM higgsfield_job_receipts receipt WHERE receipt.company_id=a.company_id AND receipt.project_id=a.project_id AND receipt.request_id=r.id OFFSET 0) receipt ON true
 JOIN LATERAL (SELECT af.bytes,af.sha256,af.media,af.locator_identity FROM higgsfield_archive_fetches af WHERE af.company_id=a.company_id AND af.project_id=a.project_id AND af.archive_id=ar.id OFFSET 0) af ON true
 JOIN LATERAL (SELECT v.id,v.bytes,v.sha256,v.content_type,v.file_id FROM project_storage_versions v WHERE v.company_id=a.company_id AND v.project_id=a.project_id AND v.id=ar.version_id OFFSET 0) v ON true
 JOIN LATERAL (SELECT ok.bytes,ok.sha256,ok.provider_etag FROM project_storage_verifications ok WHERE ok.company_id=a.company_id AND ok.project_id=a.project_id AND ok.version_id=v.id OFFSET 0) ok ON true
 JOIN LATERAL (SELECT u.archive_id,u.actor_key,u.actor_user_id,u.actor_agent_id,u.run_id,u.provider_etag FROM project_storage_uploads u WHERE u.company_id=a.company_id AND u.project_id=a.project_id AND u.version_id=v.id AND u.id=ar.upload_id OFFSET 0) u ON true
 JOIN LATERAL (SELECT file.binding_id FROM project_storage_files file WHERE file.company_id=a.company_id AND file.project_id=a.project_id AND file.id=v.file_id OFFSET 0) file ON true
 LEFT JOIN LATERAL (SELECT original_run.agent_id,original_run.requested_by FROM agent_runs original_run WHERE original_run.company_id=a.company_id AND original_run.id=r.run_id OFFSET 0) original_run ON true
 LEFT JOIN LATERAL (SELECT decision FROM studio_reviews review WHERE review.company_id=a.company_id AND review.project_id=a.project_id AND review.artifact_id=a.id ORDER BY review.created_at DESC,review.id DESC LIMIT 1) review ON true
 WHERE a.company_id=$1 AND a.project_id=$2 AND a.id=ANY($3::uuid[]) LIMIT 1001`,[companyId,projectId,ids])).rows;
 if(rows.length!==ids.length||new Set(rows.map(row=>row.id)).size!==rows.length)invalid();
 const byId=new Map(rows.map(row=>[row.id,row])),result=[];
 // Sequential projection bounds transient allocations; all facts came from the
 // same SQL snapshot and the pure checks are shared with the active loader.
 for(const artifactId of ids){
  const row=byId.get(artifactId);if(!row)return invalid();
  const requirement=parseRequirements(row.requirement),a=row.archive;assertArchive(a,false);
  const source=parseSourceEvidence(requirement,row.artifact.work_item_id,a,row.source,false);assertOriginalRun(source,row.original_run);assertStoredFile(a,a.id,row.stored,false);
  if(row.binding_id!==a.storage_binding_id)invalid();
  result.push(projectStoredArtifact(companyId,projectId,artifactId,row.artifact,await completeEvidence(requirement,a,source,row.stored)));
 }
 return result;
}

async function actorAuthority(db:PoolClient,actor:StudioActor){
 await authorizeProjectStorageActor(db,actor,'storage.read',!actor.agentId);
 const member=(await db.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[actor.companyId,actor.userId])).rows[0];if(!member||!['owner','admin'].includes(member.role))fail(403,'A current administrator request is required for generated registration.','STUDIO_REQUESTER_ACCESS');
 if(actor.agentId){const row=(await db.query('SELECT a.capabilities,r.capabilities AS run_capabilities FROM agents a JOIN agent_runs r ON r.company_id=a.company_id AND r.agent_id=a.id AND r.id=$3 WHERE a.company_id=$1 AND a.id=$2 FOR SHARE OF a,r',[actor.companyId,actor.agentId,actor.runId])).rows[0];if(!row||['studio.write','creative.read','creative.write','storage.read'].some(cap=>!row.capabilities.includes(cap)||!row.run_capabilities.includes(cap)))fail(403,'Generated registration requires the explicitly reviewed studio, creative and storage grants.','AGENT_CAPABILITY_REQUIRED');}
}

/** Call inside the authenticated member/agent transaction. Agent transport must
 * first prove the exact lease token with authorizeRunTool, as for storage APIs. */
export async function registerStudioGeneratedArtifact(db:PoolClient,actor:StudioActor,projectId:string,input:unknown){
 const parsed=studioGeneratedArtifactRegisterInput.safeParse(input);if(!parsed.success)fail(400,'Invalid generated artifact registration.','VALIDATION_ERROR');const data=parsed.data;id(projectId);await actorAuthority(db,actor);
 // This new operation has its own v2 digest; existing v1 request hashes stay unchanged.
 const operation='generated-artifact:'+projectId,actorKey=actor.agentId?'agent:'+actor.agentId:'human:'+actor.userId,requestHash=digest(canonical({operation,data}));
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-request:${actor.companyId}:${actorKey}:${data.clientId}`]);
 const old=(await db.query('SELECT request_hash,response FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=$3',[actor.companyId,actorKey,data.clientId])).rows[0];if(old&&old.request_hash!==requestHash)fail(409,'This request ID belongs to another studio operation.','IDEMPOTENCY_CONFLICT');
 const {lockedStudioProject,studioWorkItems,bumpStudioProject,studioActivity}=await import('./studio');
 const project=await lockedStudioProject(db,actor.companyId,projectId,old?undefined:data.revision);
 if(project.contractVersion!==2||project.productionPath!=='higgsfield')fail(409,'Generated registration requires a version 2 Higgsfield project.','STUDIO_CONTRACT_UNSUPPORTED');
 await assertGeneratedWorkCurrent(db,actor.companyId,projectId,data.workItemId);
 if(project.status==='delivered'||project.aiPolicy!=='allowed'||['brief','estimate','production'].some(gate=>project.gates[gate]?.decision!=='approved'))fail(409,'Current production authorization is required.','STUDIO_GATE_REQUIRED');
 const work=(await studioWorkItems(db,actor.companyId,project)).find(w=>w.id===data.workItemId);if(!work||work.execution!=='creative'||work.stage!=='generation')return invalid();
 if(!work.agentId&&!work.humanId)fail(409,'Assign the generation role before registering its media.','STUDIO_ROLE_REQUIRED');
 const tasks=(await db.query('SELECT id,status,agent_run_id FROM tasks WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[actor.companyId,[work.taskId,...(await db.query('SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[actor.companyId,projectId,work.dependencies])).rows.map(r=>r.task_id)].sort()])).rows;
 const task=tasks.find(row=>row.id===work.taskId);if(!task||(!old&&['done','review'].includes(task.status))||tasks.some(row=>row.id!==work.taskId&&row.status!=='done')||work.blockedReason)fail(409,'The generation work is blocked or already submitted.','STUDIO_WORK_BLOCKED');
 if(actor.agentId&&(work.agentId!==actor.agentId||task.agent_run_id!==actor.runId||task.status!=='doing'))fail(403,'The assigned specialist must reserve this production task for its current run.','STUDIO_ROLE_REQUIRED');
 if(!actor.agentId&&task.agent_run_id&&(await db.query("SELECT id FROM agent_runs WHERE company_id=$1 AND id=$2 AND status IN ('queued','running')",[actor.companyId,task.agent_run_id])).rowCount)fail(409,'Finish or cancel the reserved agent run before human registration.','STUDIO_RUN_ACTIVE');
 const evidence=await loadVerifiedGeneratedSource(db,actor.companyId,projectId,data.workItemId,data.archiveId);
 // Any advisory/row-lock wait may have consumed a lease. Recheck DB time last.
 await actorAuthority(db,actor);
 if(old){await loadStoredGeneratedArtifact(db,actor.companyId,projectId,old.response.artifact.id,{requireAvailable:true});await actorAuthority(db,actor);return {...old.response,replayed:true};}
 const used=(await db.query('SELECT artifact_id FROM studio_generated_artifact_sources WHERE company_id=$1 AND (archive_id=$2 OR storage_version_id=$3 OR project_id=$4 AND output_id=$5)',[actor.companyId,data.archiveId,evidence.storageVersionId,projectId,evidence.outputId])).rows[0];if(used)fail(409,'This generated output is already registered.','STUDIO_GENERATED_SOURCE_ALREADY_REGISTERED');
 const count=Number((await db.query('SELECT count(*) AS count FROM studio_artifacts WHERE company_id=$1 AND project_id=$2',[actor.companyId,projectId])).rows[0].count);if(count>=1000)fail(409,'This project reached its 1,000-version limit.');
 const version=Number((await db.query('SELECT COALESCE(max(version),0)+1 AS version FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3',[actor.companyId,projectId,data.workItemId])).rows[0].version),artifactId=randomUUID(),manifest=buildStudioGeneratedArtifactManifest({companyId:actor.companyId,projectId,artifactId,workItemId:data.workItemId,...evidence}),source=evidence.sourceSnapshot;
 await db.query('INSERT INTO studio_artifacts(id,company_id,project_id,work_item_id,name,version,url,sha256,metadata,produced_by,produced_agent_id,agent_sponsor_id,run_id,contract_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,2)',[artifactId,actor.companyId,projectId,data.workItemId,data.name,version,studioGeneratedArtifactManifestPath(actor.companyId,projectId,artifactId),manifest.manifestSha256,JSON.stringify({notes:data.notes}),source.requestedBy,source.agentId,source.agentSponsorId,source.runId]);
 await db.query('INSERT INTO studio_generated_artifact_sources(company_id,project_id,artifact_id,work_item_id,archive_id,request_id,job_id,output_id,storage_version_id,spec_sha256,manifest_text,manifest_sha256,source_snapshot,observed_media,file_facts,archive_approved_by,registered_by,registered_agent_id,registered_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',[actor.companyId,projectId,artifactId,data.workItemId,data.archiveId,evidence.requestId,evidence.jobId,evidence.outputId,evidence.storageVersionId,evidence.specSha256,manifest.manifestText,manifest.manifestSha256,JSON.stringify(source),JSON.stringify(evidence.observedMedia),JSON.stringify(evidence.fileFacts),evidence.archiveApprovedBy,actor.userId,actor.agentId??null,actor.runId??null]);
 const {artifact}=await loadStoredGeneratedArtifact(db,actor.companyId,projectId,artifactId,{requireAvailable:true});await actorAuthority(db,actor);
 await studioActivity(db,actor,'studio.generated_artifact_registered','A generated media version was registered from independently verified stored bytes. Creative and technical review remain separate.');
 const result={artifact,project:await bumpStudioProject(db,actor.companyId,projectId)};await db.query('INSERT INTO studio_requests(company_id,actor_key,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.companyId,actorKey,data.clientId,requestHash,JSON.stringify(result)]);await actorAuthority(db,actor);return {...result,replayed:false};
}
