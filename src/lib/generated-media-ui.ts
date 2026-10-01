/** Browser presentation guards. The server rechecks every source and permission. */
import type {HiggsfieldArchive} from './higgsfield-archive-protocol';
import type {HiggsfieldRequest} from './higgsfield-protocol';
import type {StudioGeneratedArtifact,StudioGeneratedProjectDetail} from './studio-protocol';
import type {StorageDownloadAccess} from './project-storage-client';
import {matchGeneratedArchiveMedia} from './studio-generated-protocol';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value:string){if(!uuid.test(value))throw Error('This media identifier is invalid. Refresh the project.');return value;}
export function generatedProjectPath(companyId:string,projectId:string){return `/api/companies/${id(companyId)}/studio/projects/${id(projectId)}`;}
export function generatedManifestPath(companyId:string,projectId:string,artifactId:string){return `${generatedProjectPath(companyId,projectId)}/generated-artifacts/${id(artifactId)}/manifest`;}
export function generatedVersionAccessPath(companyId:string,projectId:string,versionId:string){return `${generatedProjectPath(companyId,projectId)}/files/versions/${id(versionId)}/access`;}
export function assertGeneratedDownload(access:StorageDownloadAccess,artifact:StudioGeneratedArtifact,gatewayOrigin:string){
 const url=new URL(access.url),gateway=new URL(gatewayOrigin);
 if(url.origin!==gateway.origin||url.pathname!==`/v1/files/${id(artifact.provenance.storageVersionId)}`||url.search||url.hash||url.username||url.password||access.bytes!==artifact.file.bytes||access.sha256!==artifact.file.sha256||access.contentType!==artifact.file.contentType)throw Error('Download access does not match this registered file version. Refresh the project.');
}
export function generatedTechnicalMatch(detail:StudioGeneratedProjectDetail,artifact:StudioGeneratedArtifact){
 const work=generatedEvidenceWork(detail).find(item=>item.id===artifact.workItemId),shot=detail.shots.find(item=>item.id===work?.shotId);
 const unit=shot?Object.fromEntries(Object.entries(shot).filter(([key])=>key!=='id')):null;
 return matchGeneratedArchiveMedia(detail.project.spec,unit,artifact.media,artifact.file);
}
/** Historical work is available only for attribution and immutable carry evidence. */
export function generatedEvidenceWork(detail:StudioGeneratedProjectDetail){return [...detail.workItems,...(detail.historyWorkItems??[]).filter(item=>!detail.workItems.some(current=>current.id===item.id))];}
export function generatedCurrentDeliveries(detail:StudioGeneratedProjectDetail){return detail.deliveries.filter(delivery=>(delivery.roundId??null)===(detail.generatedRound?.roundId??null));}
export function generatedCarriedArtifact(detail:StudioGeneratedProjectDetail,artifactId:string){return detail.generatedRound?.finals.some(final=>final.carry?.artifactId===artifactId)??false;}
export function generatedReviewerReason(detail:StudioGeneratedProjectDetail,artifact:StudioGeneratedArtifact,userId:string,role:string):string|null{
 if(!['owner','admin'].includes(role))return 'A human company administrator must review this version.';
 if(detail.project.status==='delivered')return 'This project is closed.';
 if(detail.artifacts.some(other=>other.workItemId===artifact.workItemId&&other.version>artifact.version))return 'A newer version supersedes this output.';
 const work=detail.workItems.find(item=>item.id===artifact.workItemId);
 if(!work||work.stage!=='generation'||work.execution!=='creative')return detail.historyWorkItems?.some(item=>item.id===artifact.workItemId)?'This accepted version belongs to an earlier round and stays unchanged.':'The exact generation work is unavailable. Refresh the project.';
 if(work.status==='done')return 'Accepted work and its reviewed version are closed.';
 if([artifact.producedBy,artifact.source.agentSponsorId,artifact.source.providerSponsorId,artifact.provenance.registeredBy].includes(userId))return 'A different administrator must review this version: its producer, agent sponsor, provider sponsor and registrar cannot review it.';
 return null;
}
export function generatedArchiveReason(detail:StudioGeneratedProjectDetail,archive:HiggsfieldArchive,request:Pick<HiggsfieldRequest,'id'|'projectId'|'workItemId'|'tool'|'status'>|null,workItemId=''):string|null{
 if(archive.projectId!==detail.project.id||archive.kind!==detail.project.spec.kind)return 'This archive belongs to a different project or media kind.';
 if(archive.status!=='verified'||!archive.bytesVerified||!archive.versionId||!archive.fetched||archive.revokedAt)return 'A current verified archive with an immutable file version is required.';
 if(detail.artifacts.some(artifact=>artifact.provenance.archiveId===archive.id||artifact.provenance.storageVersionId===archive.versionId||artifact.provenance.outputId===archive.outputId))return 'This output is already registered.';
 if(!request||request.id!==archive.requestId||request.projectId!==detail.project.id||request.status!=='returned'||request.tool!==`generate_${archive.kind}`)return 'The exact generation request could not be verified.';
 const work=detail.workItems.find(item=>item.id===request.workItemId);
 if(!work||work.stage!=='generation'||work.execution!=='creative'||!detail.shots.some(shot=>shot.id===work.shotId&&shot.kind===archive.kind))return 'This request is not associated with an exact generation deliverable.';
 if(workItemId&&work.id!==workItemId)return 'This archive belongs to a different generation task.';
 if(!work.agentId&&!work.humanId)return 'Assign the generation role before registering this output.';
 if(['review','done'].includes(work.status))return 'This generation task is already submitted or accepted.';
 if(work.blockedReason||work.dependencies.some(dependency=>detail.workItems.find(item=>item.id===dependency)?.status!=='done'))return 'Complete the prerequisite work before registration.';
 if(work.runId&&['queued','running'].includes(work.runStatus??''))return 'Finish or cancel the active agent run before human registration.';
 return null;
}
export function generatedRegistrationReason(detail:StudioGeneratedProjectDetail,role:string):string|null{
 if(!['owner','admin'].includes(role))return 'A company administrator must register generated media.';
 if(detail.project.status==='delivered')return 'This project is closed.';
 if(detail.project.aiPolicy!=='allowed'||['brief','estimate','production'].some(gate=>detail.project.gates[gate]?.decision!=='approved'))return 'Approve the brief, estimate, production gate and client AI-use policy before registration.';
 return null;
}
export function generatedPackageSelection(detail:StudioGeneratedProjectDetail):{artifacts:StudioGeneratedArtifact[];reason:string|null}{
 const empty=(reason:string)=>({artifacts:[],reason});
 if(detail.project.status==='delivered')return empty('This project is closed.');
 if(detail.project.gates.production?.decision!=='approved')return empty('Production approval is required.');
 const round=detail.generatedRound,allWork=generatedEvidenceWork(detail);
 let finals:Array<{work:StudioGeneratedProjectDetail['workItems'][number];carry:NonNullable<StudioGeneratedProjectDetail['generatedRound']>['finals'][number]['carry']}>;
 if(round?.roundId){
  if(!detail.shots.length||round.finals.length!==detail.shots.length||new Set(round.finals.map(final=>final.unitId)).size!==detail.shots.length||detail.shots.some(shot=>!round.finals.some(final=>final.unitId===shot.id))||new Set(round.workItemIds).size!==detail.workItems.length||detail.workItems.some(work=>!round.workItemIds.includes(work.id)))return empty('The current revision work scope is incomplete. Refresh before packaging.');
  finals=[];
  for(const final of round.finals){
   const work=allWork.find(item=>item.id===final.generationWorkItemId),qc=allWork.find(item=>item.id===final.qcWorkItemId);
   if(!work||work.stage!=='generation'||work.execution!=='creative'||work.shotId!==final.unitId||!qc||qc.stage!=='qc'||qc.shotId!==final.unitId||qc.dependencies.length!==1||qc.dependencies[0]!==work.id||(!final.carry&&(!round.workItemIds.includes(work.id)||!round.workItemIds.includes(qc.id)))||(final.carry&&(work.status!=='done'||qc.status!=='done')))return empty('Every revision final needs its exact generation and independent QC evidence.');
   finals.push({work,carry:final.carry});
  }
 }else{
  const qc=detail.workItems.filter(work=>work.stage==='qc');
  if(!detail.shots.length||qc.length!==detail.shots.length||detail.shots.some(shot=>qc.filter(work=>work.shotId===shot.id).length!==1))return empty('Every deliverable needs its own independent QC task.');
  const work=qc.map(item=>detail.workItems.find(candidate=>candidate.id===item.dependencies[0]));
  if(qc.some((item,index)=>item.dependencies.length!==1||!work[index]||work[index]!.stage!=='generation'||work[index]!.execution!=='creative'||work[index]!.shotId!==item.shotId)||new Set(work.map(item=>item!.id)).size!==detail.shots.length)return empty('Each QC task must depend on its exact generation final.');
  finals=work.map(item=>({work:item!,carry:null}));
 }
 const artifacts:StudioGeneratedArtifact[]=[];
 for(const {work,carry} of finals){
  const artifact=carry?detail.artifacts.find(item=>item.id===carry.artifactId):detail.artifacts.filter(item=>item.workItemId===work.id).sort((a,b)=>b.version-a.version)[0];
  if(!artifact||artifact.reviewStatus!=='approved')return empty('The latest final for every deliverable must be approved.');
  if(artifact.workItemId!==work.id||carry&&(artifact.provenance.storageVersionId!==carry.storageVersionId||artifact.manifestSha256!==carry.manifestSha256||artifact.file.sha256!==carry.fileSha256))return empty('A kept version no longer matches the exact approved revision plan.');
  const review=detail.reviews.filter(item=>item.artifactId===artifact.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
  if(carry&&review?.id!==carry.reviewId)return empty('A kept version needs its exact preserved independent review.');
  if(!review||review.contractVersion!==2||review.decision!=='approved'||!review.technicalQc||review.attestationVersion!==1||review.specSha256!==artifact.specSha256||review.manifestSha256!==artifact.manifestSha256||!review.technicalMatch.matches||review.technicalMatch.issues.length||[artifact.producedBy,artifact.source.agentSponsorId,artifact.source.providerSponsorId,artifact.provenance.registeredBy].includes(review.reviewedBy)||!generatedTechnicalMatch(detail,artifact).matches)return empty('Each final needs an independent technical review of its exact specification and manifest.');
  artifacts.push(artifact);
 }
 if(detail.workItems.some(work=>work.stage!=='delivery'&&work.status!=='done'))return {artifacts,reason:'Accept all planning, generation and QC tasks on the work board before packaging.'};
 return {artifacts,reason:null};
}
export const generatedLimitationText={COLOR_METADATA_NOT_REQUIRED:'This specification does not require color metadata. Unknown color values remain unknown.',VIDEO_DURATION_ROUNDED_TO_MS:'Video duration is measured to milliseconds; sub-millisecond timing is not attested.',EMBEDDED_AUDIO_TIMING_UNVERIFIED:'Embedded audio properties were inspected; audio-to-picture synchronization still needs human QC.'} as const;
export function generatedBytes(bytes:number){if(bytes<1024)return `${bytes} B`;if(bytes<1024**2)return `${(bytes/1024).toFixed(1)} KiB`;if(bytes<1024**3)return `${(bytes/1024**2).toFixed(1)} MiB`;return `${(bytes/1024**3).toFixed(2)} GiB`;}
