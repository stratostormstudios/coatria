import type {PoolClient} from 'pg';
import type {z} from 'zod';
import type {StudioActor} from './studio';
import type {StudioGeneratedProject,studioReviewInput,studioDeliveryInput} from './studio-protocol';
import {fail} from './security';
import {generatedSpecificationSha256,matchGeneratedArchiveMedia,studioGeneratedWorkUnitInput} from './studio-generated-protocol';
import {loadStoredGeneratedArtifact} from './studio-generated-artifacts';

/** These helpers run inside the studio request transaction, after company,
 * caller membership and project locks. They never transfer files, perform a
 * provider call, approve a task or attest that a reviewer actually saw media. */
async function humanAdministrator(client:PoolClient,actor:StudioActor){
 if(actor.agentId)fail(403,'Generated media review and packaging require a human administrator.','STUDIO_HUMAN_REQUIRED');
 const member=(await client.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[actor.companyId,actor.userId])).rows[0];
 if(!member||!['owner','admin'].includes(member.role))fail(403,'A current company administrator is required.','STUDIO_ADMIN_REQUIRED');
}

async function checkedEvidence(client:PoolClient,companyId:string,project:Pick<StudioGeneratedProject,'id'|'spec'>,artifactId:string){
 const evidence=await loadStoredGeneratedArtifact(client,companyId,project.id,artifactId,{requireAvailable:true});
 const work=(await client.query(`SELECT w.id,w.task_id,w.shot_id,w.execution,t.status,s.media_kind,s.code,s.description,s.duration_min_ms,s.duration_max_ms
  FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id
  JOIN studio_shots s ON s.company_id=w.company_id AND s.project_id=w.project_id AND s.id=w.shot_id
  WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3`,[companyId,project.id,evidence.artifact.workItemId])).rows[0];
 if(!work||work.execution!=='creative')fail(409,'The generated artifact is not bound to its production work.','STUDIO_GENERATED_SOURCE_UNAVAILABLE');
 const unit=studioGeneratedWorkUnitInput.safeParse({kind:work.media_kind,code:work.code,description:work.description,...work.media_kind==='image'?{}:{durationMs:{min:work.duration_min_ms,max:work.duration_max_ms}}});
 if(!unit.success||await generatedSpecificationSha256(project.spec,unit.data)!==evidence.specSha256)fail(409,'The generated artifact no longer matches its exact specification.','STUDIO_SPEC_MISMATCH');
 const technicalMatch=matchGeneratedArchiveMedia(project.spec,unit.data,evidence.observedMedia,evidence.fileFacts);
 return {evidence,work,technicalMatch};
}

async function latest(client:PoolClient,companyId:string,projectId:string,workItemId:string,artifactId:string){
 const row=(await client.query('SELECT id FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 ORDER BY version DESC LIMIT 1',[companyId,projectId,workItemId])).rows[0];
 if(!row||row.id!==artifactId)fail(409,'Use the latest generated version of this work item.','STUDIO_VERSION_SUPERSEDED');
}

async function approvedReview(client:PoolClient,companyId:string,projectId:string,artifactId:string,specSha256:string,manifestSha256:string){
 const review=(await client.query(`SELECT r.id,r.artifact_id AS "artifactId",r.decision,r.note,r.technical_qc AS "technicalQc",r.reviewed_by AS "reviewedBy",r.created_at AS "createdAt",
  e.spec_sha256 AS "specSha256",e.manifest_sha256 AS "manifestSha256",e.attestation_version AS "attestationVersion",e.technical_match AS "technicalMatch"
  FROM studio_reviews r LEFT JOIN studio_generated_review_evidence e ON e.company_id=r.company_id AND e.project_id=r.project_id AND e.review_id=r.id AND e.artifact_id=r.artifact_id
  WHERE r.company_id=$1 AND r.project_id=$2 AND r.artifact_id=$3 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,[companyId,projectId,artifactId])).rows[0];
 if(!review||review.decision!=='approved'||review.technicalQc!==true||review.attestationVersion!==1||review.specSha256!==specSha256||review.manifestSha256!==manifestSha256||review.technicalMatch?.matches!==true||!Array.isArray(review.technicalMatch.issues)||review.technicalMatch.issues.length!==0)fail(409,'The latest generated version needs independent technical review before acceptance.','STUDIO_ARTIFACT_REVIEW_REQUIRED');
 return {...review,contractVersion:2 as const};
}

export async function recordGeneratedStudioReview(client:PoolClient,actor:StudioActor,project:StudioGeneratedProject,data:z.infer<typeof studioReviewInput>){
 await humanAdministrator(client,actor);
 if(project.status==='delivered')fail(409,'Delivered review history is closed.','STUDIO_PROJECT_CLOSED');
 const {evidence,work,technicalMatch}=await checkedEvidence(client,actor.companyId,project,data.artifactId);
 if([evidence.artifact.producedBy,evidence.sourceSnapshot.agentSponsorId,evidence.sourceSnapshot.providerSponsorId,evidence.registeredBy].includes(actor.userId))fail(403,'An independent administrator who did not produce, sponsor or register this version must review it.','STUDIO_INDEPENDENT_REVIEW');
 await latest(client,actor.companyId,project.id,work.id,data.artifactId);
 if(work.status==='done')fail(409,'Accepted work and its reviewed version are immutable.','STUDIO_WORK_CLOSED');
 if(data.decision==='approved'){
  if(project.gates.production?.decision!=='approved'||project.aiPolicy!=='allowed')fail(409,'Restore production approval and the client AI-use policy before approving generated media.','STUDIO_GATE_REQUIRED');
  if(!data.technicalQc)fail(400,'Approval requires explicit technical QC of the actual generated media.','STUDIO_QC_REQUIRED');
  if(!technicalMatch.matches)fail(409,'Generated media does not meet the approved specification.','STUDIO_SPEC_MISMATCH');
 }
 if(Number((await client.query('SELECT count(*) FROM studio_reviews WHERE company_id=$1 AND project_id=$2',[actor.companyId,project.id])).rows[0].count)>=1000)fail(409,'This project reached its 1,000-review pilot limit.');
 const review=(await client.query('INSERT INTO studio_reviews(company_id,project_id,artifact_id,decision,note,technical_qc,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,artifact_id AS "artifactId",decision,note,technical_qc AS "technicalQc",reviewed_by AS "reviewedBy",created_at AS "createdAt"',[actor.companyId,project.id,data.artifactId,data.decision,data.note,data.technicalQc,actor.userId])).rows[0];
 await client.query('INSERT INTO studio_generated_review_evidence(company_id,project_id,review_id,artifact_id,spec_sha256,manifest_sha256,attestation_version,technical_match) VALUES($1,$2,$3,$4,$5,$6,1,$7)',[actor.companyId,project.id,review.id,data.artifactId,evidence.specSha256,evidence.manifestSha256,JSON.stringify(technicalMatch)]);
 return {review:{...review,contractVersion:2 as const,specSha256:evidence.specSha256,manifestSha256:evidence.manifestSha256,attestationVersion:1 as const,technicalMatch}};
}

/** Submission requires a real verified source. Acceptance additionally requires
 * an independent approval of that exact latest version; neither action is a
 * creative-quality inference from successful decoding or a text contribution. */
export async function assertGeneratedStudioTaskArtifact(client:PoolClient,companyId:string,projectId:string,workItemId:string,requiresApproval:boolean){
 const p=(await client.query('SELECT id,contract_version AS "contractVersion",production_path AS "productionPath",spec FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,projectId])).rows[0];
 if(p?.contractVersion!==2||p.productionPath!=='higgsfield')fail(409,'A generated-media project is required.','STUDIO_CONTRACT_UNSUPPORTED');
 const artifact=(await client.query('SELECT id,contract_version FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 AND work_item_id=$3 ORDER BY version DESC LIMIT 1',[companyId,projectId,workItemId])).rows[0];
 if(!artifact||artifact.contract_version!==2)fail(409,'Register verified generated media before submitting this production task.','STUDIO_ARTIFACT_REQUIRED');
 const {evidence,technicalMatch}=await checkedEvidence(client,companyId,p,artifact.id);
 if(!technicalMatch.matches)fail(409,'The registered generated media does not meet this work specification.','STUDIO_SPEC_MISMATCH');
 if(requiresApproval)await approvedReview(client,companyId,projectId,artifact.id,evidence.specSha256,evidence.manifestSha256);
}

export async function prepareGeneratedStudioDelivery(client:PoolClient,actor:StudioActor,project:StudioGeneratedProject,data:z.infer<typeof studioDeliveryInput>){
 await humanAdministrator(client,actor);
 if(project.status==='delivered')fail(409,'This project already has recorded client acceptance.','STUDIO_PROJECT_CLOSED');
 if(project.gates.production?.decision!=='approved')fail(409,'Production authorization is required.','STUDIO_GATE_REQUIRED');
 const work=(await client.query(`SELECT w.id,w.stage,w.execution,w.shot_id,t.status,
  COALESCE((SELECT jsonb_agg(d.predecessor_id ORDER BY d.predecessor_id) FROM studio_dependencies d WHERE d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id),'[]') AS dependencies
  FROM studio_work_items w JOIN tasks t ON t.company_id=w.company_id AND t.id=w.task_id WHERE w.company_id=$1 AND w.project_id=$2 ORDER BY w.id`,[actor.companyId,project.id])).rows;
 if(work.some(w=>w.stage!=='delivery'&&w.status!=='done'))fail(409,'All production work needs independent task acceptance before packaging.','STUDIO_WORK_INCOMPLETE');
 const units=(await client.query('SELECT id FROM studio_shots WHERE company_id=$1 AND project_id=$2 ORDER BY id',[actor.companyId,project.id])).rows;
 const qc=work.filter(w=>w.stage==='qc'),finalIds=new Set<string>(qc.flatMap(w=>w.dependencies));
 if(!units.length||qc.length!==units.length||units.some(unit=>qc.filter(w=>w.shot_id===unit.id).length!==1)||qc.some(w=>w.dependencies.length!==1)||finalIds.size!==units.length)fail(409,'Every deliverable needs its complete independent QC dependency.','STUDIO_DELIVERY_INCOMPLETE');
 const artifacts=[],reviews=[],selectedWork=new Set<string>();
 for(const artifactId of [...data.artifactIds].sort()){
  const {evidence,work:item,technicalMatch}=await checkedEvidence(client,actor.companyId,project,artifactId);
  await latest(client,actor.companyId,project.id,item.id,artifactId);
  if(!technicalMatch.matches)fail(409,'A selected generated version does not meet the project specification.','STUDIO_SPEC_MISMATCH');
  if(!finalIds.has(item.id)||selectedWork.has(item.id))fail(409,'Select exactly one final version for each generated deliverable.','STUDIO_DELIVERY_INCOMPLETE');
  selectedWork.add(item.id);
  const review=await approvedReview(client,actor.companyId,project.id,artifactId,evidence.specSha256,evidence.manifestSha256);
  artifacts.push(evidence.artifact);reviews.push(review);
 }
 if(selectedWork.size!==finalIds.size)fail(409,'Include the latest approved final version for every generated deliverable.','STUDIO_DELIVERY_INCOMPLETE');
 if(Number((await client.query('SELECT count(*) FROM studio_deliveries WHERE company_id=$1 AND project_id=$2',[actor.companyId,project.id])).rows[0].count)>=100)fail(409,'This project reached its delivery-package limit.');
 const now=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
 const manifest={schemaVersion:2,kind:'generated_media_package',project:{id:project.id,name:project.name,clientName:project.clientName,spec:project.spec,revision:project.revision},generatedAt:new Date(now).toISOString(),preparedBy:actor.userId,transportStatus:'not_transferred',artifacts,reviewReceipts:reviews,note:data.note};
 const delivery=(await client.query('INSERT INTO studio_deliveries(company_id,project_id,name,manifest,note,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,status,manifest,note,created_at AS "createdAt"',[actor.companyId,project.id,data.name,JSON.stringify(manifest),data.note,actor.userId])).rows[0];
 await client.query("UPDATE studio_projects SET status='delivery' WHERE company_id=$1 AND id=$2",[actor.companyId,project.id]);
 return {delivery};
}
