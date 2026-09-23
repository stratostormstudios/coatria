import type {PoolClient} from 'pg';
import {z} from 'zod';
import {fail,hashToken,id} from './security';
import {canonicalStudioMedia} from './studio-media';
import {loadStoredGeneratedArtifact,loadStoredGeneratedArtifacts} from './studio-generated-artifacts';
import {studioGeneratedSpecInput} from './studio-generated-protocol';
import type {StudioGeneratedClientPackage} from './studio-client-delivery-protocol';
import {assertGeneratedDeliveryCurrent,generatedRoundScope} from './studio-generated-rounds';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const optionsInput=z.object({requireReady:z.boolean().optional(),requireAvailable:z.boolean().optional()}).strict();
type Options=z.infer<typeof optionsInput>;
const manifestInput=z.object({schemaVersion:z.literal(2),kind:z.literal('generated_media_package'),project:z.object({id:uuid,name:z.string().min(1).max(160),clientName:z.string().min(1).max(160),spec:studioGeneratedSpecInput,revision:z.number().int().positive()}).strict(),revisionRound:z.object({roundId:uuid,number:z.number().int().positive(),planSha256:sha}).strict().optional(),generatedAt:z.string().datetime(),preparedBy:uuid,transportStatus:z.literal('not_transferred'),artifacts:z.array(z.object({id:uuid}).passthrough()).min(1).max(100),reviewReceipts:z.array(z.object({id:uuid,artifactId:uuid}).passthrough()).min(1).max(100),note:z.string().max(4000)}).strict();
const deliveryInput=z.object({id:uuid,company_id:uuid,project_id:uuid,name:z.string().min(1).max(160),created_by:uuid,created_at:z.union([z.date(),z.string().datetime()]),manifest:manifestInput}).passthrough();
const grantInput=z.object({company_id:uuid,project_id:uuid,delivery_id:uuid,recipient_user_id:uuid,package_snapshot:z.unknown(),package_hash:sha,source_manifest_hash:sha}).passthrough();
const invalid=():never=>fail(409,'This generated package no longer matches its immutable approved evidence.','CLIENT_PACKAGE_UNAVAILABLE');
const excluded=():never=>fail(403,'A producer, sponsor, reviewer or studio operator cannot act as this package’s external client.','CLIENT_IDENTITY_REQUIRED');
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)return invalid();return result.data;}
const digest=(value:unknown)=>hashToken(canonicalStudioMedia(value));
const equal=(left:unknown,right:unknown)=>canonicalStudioMedia(left)===canonicalStudioMedia(right);
const instant=(value:Date|string)=>new Date(value).toISOString();

/** Transaction-only: callers retain account/grant authorization and project
 * mutation locks. Historical validation deliberately uses immutable source
 * evidence, not storage lifecycle locks or today's latest artifact version. */
export async function buildGeneratedClientPackage(client:PoolClient,companyId:string,projectId:string,deliveryInputValue:unknown,recipientUserId:string,options:Options={}):Promise<StudioGeneratedClientPackage>{
 [companyId,projectId,recipientUserId].forEach(id);
 const {requireReady=true,requireAvailable=true}=parse(optionsInput,options),delivery=parse(deliveryInput,deliveryInputValue),manifest=delivery.manifest;
 if(delivery.company_id!==companyId||delivery.project_id!==projectId||manifest.project.id!==projectId||manifest.preparedBy!==delivery.created_by)invalid();
 const project=(await client.query('SELECT contract_version,production_path,spec,created_by,gates,ai_policy FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,projectId])).rows[0];
 if(!project||project.contract_version!==2||project.production_path!=='higgsfield'||!equal(parse(studioGeneratedSpecInput,project.spec),manifest.project.spec))invalid();
 if([project.created_by,delivery.created_by,manifest.preparedBy].includes(recipientUserId))excluded();
 // Existing and removed memberships both disqualify a client. The parent
 // account-grant service also holds the company invitation advisory lock.
 if((await client.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2',[companyId,recipientUserId])).rowCount)excluded();
 const scope=requireReady?await assertGeneratedDeliveryCurrent(client,companyId,projectId,delivery.id):await generatedRoundScope(client,companyId,projectId,{deliveryId:delivery.id});
 if(requireReady&&(project.gates?.production?.decision!=='approved'||project.ai_policy!=='allowed'))fail(409,'Restore production approval and the client AI-use policy before delivery.','CLIENT_DELIVERY_NOT_READY');
 if(scope.roundId?!equal(manifest.revisionRound,{roundId:scope.roundId,number:scope.number,planSha256:scope.planSha256}):manifest.revisionRound!==undefined)invalid();
 const work=(await client.query(`SELECT w.id,w.shot_id,w.stage,w.execution,t.status,
 COALESCE((SELECT jsonb_agg(d.predecessor_id ORDER BY d.predecessor_id) FROM studio_dependencies d WHERE d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id),'[]') AS dependencies
 FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=ANY($3::uuid[]) ORDER BY w.id`,[companyId,projectId,scope.workItemIds])).rows;
 if(work.length!==scope.workItemIds.length)invalid();
 if(requireReady&&work.some(item=>item.status!=='done'))fail(409,'All production and independent delivery-handoff work must be accepted before client delivery.','CLIENT_DELIVERY_NOT_READY');
 const units=(await client.query('SELECT id FROM studio_shots WHERE company_id=$1 AND project_id=$2 ORDER BY id',[companyId,projectId])).rows;
 const finalIds=new Set<string>();
 if(!units.length||units.length>100||scope.finals.length!==units.length)invalid();
 for(const unit of units){
  const finals=scope.finals.filter(final=>final.unitId===unit.id);if(finals.length!==1||finalIds.has(finals[0].generationWorkItemId))invalid();const selected=finals[0];
  if(!selected.carry){const final=work.find(item=>item.id===selected.generationWorkItemId),qc=work.find(item=>item.id===selected.qcWorkItemId);if(!final||!qc||final.shot_id!==unit.id||final.stage!=='generation'||final.execution!=='creative'||qc.stage!=='qc'||qc.shot_id!==unit.id||!Array.isArray(qc.dependencies)||qc.dependencies.length!==1||qc.dependencies[0]!==final.id)invalid();}
  finalIds.add(selected.generationWorkItemId);
 }
 const artifactIds=manifest.artifacts.map(artifact=>artifact.id);
 if(new Set(artifactIds).size!==artifactIds.length||artifactIds.length!==finalIds.size||manifest.reviewReceipts.length!==artifactIds.length||new Set(manifest.reviewReceipts.map(review=>review.id)).size!==artifactIds.length||new Set(manifest.reviewReceipts.map(review=>review.artifactId)).size!==artifactIds.length)invalid();
 const evidence:Awaited<ReturnType<typeof loadStoredGeneratedArtifact>>[]=[];
 if(requireAvailable){for(const artifactId of artifactIds)evidence.push(await loadStoredGeneratedArtifact(client,companyId,projectId,artifactId,{requireAvailable:true}));}
 else evidence.push(...await loadStoredGeneratedArtifacts(client,companyId,projectId,artifactIds));
 const reviewRows=(await client.query(`SELECT r.id,r.artifact_id AS "artifactId",r.decision,r.note,r.technical_qc AS "technicalQc",r.reviewed_by AS "reviewedBy",r.created_at AS "createdAt",
 e.spec_sha256 AS "specSha256",e.manifest_sha256 AS "manifestSha256",e.attestation_version AS "attestationVersion",e.technical_match AS "technicalMatch"
 FROM studio_reviews r JOIN studio_generated_review_evidence e ON e.company_id=r.company_id AND e.project_id=r.project_id AND e.review_id=r.id AND e.artifact_id=r.artifact_id
 WHERE r.company_id=$1 AND r.project_id=$2 AND r.id=ANY($3::uuid[])`,[companyId,projectId,manifest.reviewReceipts.map(review=>review.id)])).rows;
 const archiveRows=(await client.query('SELECT id,storage_connection_snapshot FROM higgsfield_output_archives WHERE company_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[companyId,projectId,evidence.map(item=>item.archiveId)])).rows;
 const latestArtifacts=requireReady?(await client.query('SELECT DISTINCT ON(work_item_id) id,work_item_id FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=ANY($3::uuid[]) ORDER BY work_item_id,version DESC',[companyId,projectId,[...finalIds]])).rows:[];
 const latestReviews=requireReady?(await client.query('SELECT DISTINCT ON(artifact_id) id,artifact_id FROM studio_reviews WHERE company_id=$1 AND project_id=$2 AND artifact_id=ANY($3::uuid[]) ORDER BY artifact_id,created_at DESC,id DESC',[companyId,projectId,artifactIds])).rows:[];
 const selectedWork=new Set<string>(),selectedVersions=new Set<string>();
 const artifacts=[],files=[];
 for(let index=0;index<evidence.length;index++){
  const item=evidence[index],artifact=item.artifact,source=item.sourceSnapshot,snapshot=manifest.artifacts[index];
  if(artifact.id!==snapshot.id||!finalIds.has(artifact.workItemId)||selectedWork.has(artifact.workItemId)||selectedVersions.has(item.storageVersionId))invalid();
  selectedWork.add(artifact.workItemId);selectedVersions.add(item.storageVersionId);
  // Review status is a historical approved claim in the prepared snapshot;
  // verify its exact pinned review below, independently of later decisions.
  if(!equal(snapshot,{...artifact,reviewStatus:'approved'}))invalid();
  const pinned=manifest.reviewReceipts.find(review=>review.artifactId===artifact.id),stored=reviewRows.find(review=>review.id===pinned?.id&&review.artifactId===artifact.id);
  if(!pinned||!stored||stored.decision!=='approved'||stored.technicalQc!==true||stored.attestationVersion!==1||stored.specSha256!==item.specSha256||stored.manifestSha256!==item.manifestSha256||!item.match.matches||!equal(stored.technicalMatch,item.match))invalid();
  const carry=scope.finals.find(final=>final.generationWorkItemId===artifact.workItemId)?.carry;
  if(carry&&(carry.artifactId!==artifact.id||carry.reviewId!==stored.id||carry.storageVersionId!==item.storageVersionId||carry.manifestSha256!==item.manifestSha256||carry.fileSha256!==item.fileFacts.sha256))invalid();
  const reviewed={...stored,createdAt:instant(stored.createdAt),contractVersion:2};
  if(!equal(pinned,reviewed))invalid();
  if([artifact.producedBy,source.requestedBy,source.agentSponsorId,source.providerSponsorId,item.registeredBy].includes(stored.reviewedBy))invalid();
  const archive=archiveRows.find(row=>row.id===item.archiveId),storageSponsor=uuid.safeParse(archive?.storage_connection_snapshot?.sponsorId);
  if(!storageSponsor.success)invalid();
  if([artifact.producedBy,source.requestedBy,source.agentSponsorId,source.providerSponsorId,source.approvedBy,source.roleHumanId,item.archiveApprovedBy,item.registeredBy,stored.reviewedBy,storageSponsor.data].includes(recipientUserId))excluded();
  if(requireReady&&(latestArtifacts.find(row=>row.work_item_id===artifact.workItemId)?.id!==artifact.id||latestReviews.find(row=>row.artifact_id===artifact.id)?.id!==stored.id))fail(409,'This package no longer contains the latest independently approved versions.','CLIENT_PACKAGE_SUPERSEDED');
  artifacts.push({id:artifact.id,name:artifact.name,version:artifact.version,sha256:artifact.sha256});
  files.push({fileId:item.storageVersionId,artifactId:artifact.id,path:`${item.unit.code}_v${artifact.version}.${item.observedMedia.format}`,frame:null,sha256:item.fileFacts.sha256,bytes:item.fileFacts.bytes,contentType:item.fileFacts.contentType,storageVersionId:item.storageVersionId,mediaKind:item.mediaKind,transport:'project_storage' as const});
 }
 return {schemaVersion:2 as const,...manifest.revisionRound?{revisionRound:manifest.revisionRound}:{},delivery:{id:delivery.id,name:delivery.name,preparedAt:instant(delivery.created_at)},project:{id:projectId,name:manifest.project.name,clientName:manifest.project.clientName,spec:manifest.project.spec},sourceManifestSha256:digest(manifest),reviewBasis:'independently_approved' as const,artifacts,files};
}

/** Validate before returning even a cached client receipt. Readiness may be
 * disabled for historical or already-acknowledged responses, never integrity. */
export async function validateGeneratedClientPackage(client:PoolClient,grantValue:unknown,options:Options={}){
 const grant=parse(grantInput,grantValue),delivery=(await client.query('SELECT * FROM studio_deliveries WHERE company_id=$1 AND project_id=$2 AND id=$3',[grant.company_id,grant.project_id,grant.delivery_id])).rows[0];
 if(!delivery)invalid();
 const snapshot=await buildGeneratedClientPackage(client,grant.company_id,grant.project_id,delivery,grant.recipient_user_id,options);
 if(snapshot.sourceManifestSha256!==grant.source_manifest_hash||digest(grant.package_snapshot)!==grant.package_hash||digest(snapshot)!==grant.package_hash||!equal(snapshot,grant.package_snapshot))invalid();
 return snapshot;
}
