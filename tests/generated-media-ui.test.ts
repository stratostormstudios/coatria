import test from 'node:test';
import assert from 'node:assert/strict';
import {assertGeneratedDownload,generatedArchiveReason,generatedCurrentDeliveries,generatedManifestPath,generatedPackageSelection,generatedRegistrationReason,generatedReviewerReason,generatedTechnicalMatch,generatedVersionAccessPath} from '../src/lib/generated-media-ui';
import type {StudioGeneratedArtifact,StudioGeneratedProjectDetail,StudioGeneratedReview,StudioWorkItem} from '../src/lib/studio-protocol';
import type {GeneratedObservedMedia,GeneratedProjectSpec,GeneratedWorkUnit} from '../src/lib/studio-generated-protocol';
import type {HiggsfieldArchive} from '../src/lib/higgsfield-archive-protocol';
import type {HiggsfieldRequest} from '../src/lib/higgsfield-protocol';
import type {StorageDownloadAccess} from '../src/lib/project-storage-client';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sha='a'.repeat(64),manifestSha='b'.repeat(64),specSha='c'.repeat(64),at='2026-09-20T00:00:00.000Z';
function fixture(kind:'image'|'video'|'audio'='image'){
 const color={space:null,primaries:null,transfer:null,range:null};
 const spec:GeneratedProjectSpec=kind==='image'?{kind,format:'png',width:32,height:16,color:{mode:'not_required'}}:kind==='video'?{kind,format:'mp4',codec:'h264',width:32,height:16,color:{mode:'not_required'},frameRate:{mode:'constant',numerator:24,denominator:1},audio:{mode:'none'}}:{kind,format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:2};
 const unit:GeneratedWorkUnit=kind==='image'?{kind,code:'STILL01',description:'Synthetic unit'}:{kind,code:'MEDIA01',description:'Synthetic unit',durationMs:{min:999,max:1001}};
 const common={bytes:100,sha256:sha,verification:'full_decode' as const,inspectionVersion:1 as const};
 const media:GeneratedObservedMedia=kind==='image'?{...common,kind,format:'png',contentType:'image/png',codec:'png',width:32,height:16,color}:kind==='video'?{...common,kind,format:'mp4',contentType:'video/mp4',codec:'h264',width:32,height:16,color,durationMs:1000,frameRate:{numerator:24,denominator:1},averageFrameRate:{numerator:24,denominator:1},vfr:false,frameCount:24,audio:null}:{...common,kind,format:'wav',contentType:'audio/wav',codec:'pcm_s16le',sampleRateHz:48000,channels:2,durationMs:1000,decodedSamples:48000};
 const generation:StudioWorkItem={id:id(3),taskId:id(4),title:'Generate final',stage:'generation',roleKey:'generation',shotId:id(2),dependencies:[],status:'doing',readiness:'ready',blockedReason:null,revision:1,execution:'creative',agentId:null,humanId:id(10)};
 const artifact:StudioGeneratedArtifact={contractVersion:2,kind:'verified_generated_media',mediaKind:kind,id:id(5),workItemId:generation.id,name:'Registered final',version:1,url:'https://untrusted.example/never-follow-this',sha256:manifestSha,notes:'Actual source facts are checked on the server.',reviewStatus:'approved',createdAt:at,producedBy:id(10),producedAgentId:id(14),media,file:{bytes:100,sha256:sha,contentType:media.contentType},source:{agentSponsorId:id(11),providerSponsorId:id(12)},provenance:{archiveId:id(20),archiveApprovedBy:id(13),requestId:id(21),jobId:id(22),outputId:id(23),storageVersionId:id(24),registeredBy:id(13),registeredAgentId:null,registeredRunId:null},specSha256:specSha,manifestSha256:manifestSha,limitations:kind==='image'?['COLOR_METADATA_NOT_REQUIRED']:[]};
 const review:StudioGeneratedReview={contractVersion:2,id:id(6),artifactId:artifact.id,decision:'approved',note:'Independent actual-media technical review.',technicalQc:true,reviewedBy:id(15),createdAt:at,specSha256:specSha,manifestSha256:manifestSha,attestationVersion:1,technicalMatch:{matches:true,issues:[],limitations:[]}};
 const detail:StudioGeneratedProjectDetail={project:{contractVersion:2,id:id(1),name:'Generated fixture',clientName:'Synthetic',brief:'UI guard tests without provider or storage operations.',productionPath:'higgsfield',dueDate:null,spec,aiPolicy:'allowed',revision:4,status:'production',gates:Object.fromEntries(['brief','estimate','production'].map(key=>[key,{decision:'approved',note:'Reviewed.',recordedBy:id(16),at}])),createdAt:at,updatedAt:at},shots:[{...unit,id:id(2)}],workItems:[generation,{...generation,id:id(7),taskId:id(8),title:'QC final',stage:'qc',execution:'human',humanId:id(15),dependencies:[generation.id],status:'todo'}],artifacts:[artifact],reviews:[review],deliveries:[],roles:[],skills:[]};
 const archive:HiggsfieldArchive={id:id(20),projectId:detail.project.id,requestId:id(21),jobId:id(22),outputId:id(23),outputIdentity:sha,kind,status:'verified',revision:3,requestHash:'d'.repeat(64),projectRevision:4,bindingId:id(25),bindingRevision:2,storageConnectionId:id(26),storageConnectionRevision:1,destination:{parentId:null,fileId:id(27),name:'archive.png',ancestors:[]},maxBytes:1000,sourceAttribution:{requestedBy:id(10),agentId:id(14),runId:id(28),agentSponsorId:id(11),approvedBy:id(12)},proposedBy:id(13),proposedAgentId:null,createdAt:at,approvedBy:id(13),approvedAt:at,expiresAt:at,revokedAt:null,approvedProjectRevision:4,approvedBindingRevision:2,uploadId:id(29),versionId:id(24),diagnosticCode:null,fetched:{bytes:100,sha256:sha},bytesVerified:true};
 const request:HiggsfieldRequest={id:id(21),projectId:detail.project.id,workItemId:id(3),taskRevision:1,tool:`generate_${kind}`,arguments:{},note:'Original generation',requestHash:'e'.repeat(64),status:'returned',createdAt:at};
 return {detail,artifact,review,archive,request};
}

test('all three generated categories use their real typed facts without requiring legacy frames',()=>{
 for(const kind of ['image','video','audio'] as const){const {detail,artifact}=fixture(kind);assert.equal(generatedTechnicalMatch(detail,artifact).matches,true);artifact.file.sha256='f'.repeat(64);assert.equal(generatedTechnicalMatch(detail,artifact).matches,false);}
 const {detail,artifact}=fixture();if(detail.project.spec.kind!=='image')throw Error('fixture');detail.project.spec.color={mode:'exact',space:'bt709',primaries:'bt709',transfer:'bt709',range:'tv'};
 assert(generatedTechnicalMatch(detail,artifact).issues.some(issue=>issue.code==='COLOR_METADATA_UNKNOWN'));
});
test('review visibility excludes every recorded actor, ordinary members, superseded versions and accepted work',()=>{
 const {detail,artifact}=fixture();assert.equal(generatedReviewerReason(detail,artifact,id(15),'admin'),null);assert.equal(generatedReviewerReason(detail,artifact,id(15),'owner'),null);
 for(const actor of [10,11,12,13])assert.match(generatedReviewerReason(detail,artifact,id(actor),'owner')!,/different administrator/);
 assert.match(generatedReviewerReason(detail,artifact,id(15),'member')!,/administrator/);
 // The producing agent's current owner is not substituted for the immutable sponsor.
 assert.equal(generatedReviewerReason(detail,artifact,id(99),'admin'),null);
 detail.artifacts.push({...artifact,id:id(30),version:2});assert.match(generatedReviewerReason(detail,artifact,id(15),'admin')!,/newer version/);detail.artifacts.pop();
 detail.workItems[0].status='done';assert.match(generatedReviewerReason(detail,artifact,id(15),'admin')!,/closed/);
});
test('archive selection requires verified bytes and the exact returned generation association',()=>{
 const {detail,archive,request}=fixture();detail.artifacts=[];assert.equal(generatedArchiveReason(detail,archive,request,id(3)),null);
 // The archive proposal hash and generation request hash are distinct contracts.
 assert.notEqual(archive.requestHash,request.requestHash);
 assert.match(generatedArchiveReason(detail,archive,{...request,id:id(90)})!,/exact generation request/);
 assert.match(generatedArchiveReason(detail,archive,{...request,projectId:id(90)})!,/exact generation request/);
 assert.match(generatedArchiveReason(detail,archive,{...request,status:'uncertain'})!,/exact generation request/);
 assert.match(generatedArchiveReason(detail,archive,{...request,workItemId:id(7)})!,/exact generation deliverable/);
 assert.match(generatedArchiveReason(detail,archive,request,id(90))!,/different generation task/);
 for(const changed of [{status:'verifying' as const},{bytesVerified:false},{revokedAt:at},{versionId:null},{fetched:null}])assert.match(generatedArchiveReason(detail,{...archive,...changed},request)!,/verified archive/);
 detail.workItems[0].agentId=null;detail.workItems[0].humanId=null;assert.match(generatedArchiveReason(detail,archive,request)!,/Assign/);
 detail.workItems[0].humanId=id(10);detail.workItems[0].runId=id(90);detail.workItems[0].runStatus='running';assert.match(generatedArchiveReason(detail,archive,request)!,/active agent run/);
});
test('already registered archive, output or immutable file version cannot be picked again',()=>{
 const {detail,archive,request}=fixture();assert.match(generatedArchiveReason(detail,archive,request)!,/already registered/);
 for(const changed of [{id:id(80),versionId:id(81)},{id:id(80),outputId:id(81)},{versionId:id(80),outputId:id(81)}])assert.match(generatedArchiveReason(detail,{...archive,...changed},request)!,/already registered/);
});
test('registration keeps business gates and incomplete generation prerequisites visible',()=>{
 const {detail,archive,request}=fixture();detail.artifacts=[];
 assert.equal(generatedRegistrationReason(detail,'admin'),null);assert.match(generatedRegistrationReason(detail,'member')!,/administrator/);
 detail.project.gates.production.decision='pending';assert.match(generatedRegistrationReason(detail,'owner')!,/Approve/);detail.project.gates.production.decision='approved';
 detail.project.aiPolicy='unknown';assert.match(generatedRegistrationReason(detail,'owner')!,/AI-use/);
 detail.workItems[0].dependencies=[id(7)];assert.match(generatedArchiveReason(detail,archive,request)!,/prerequisite/);
});
test('package needs current approved final, exact independent review evidence and completed work',()=>{
 for(const kind of ['image','video','audio'] as const){const {detail,artifact,review}=fixture(kind);
  assert.match(generatedPackageSelection(detail).reason!,/Accept all/);
  detail.workItems.forEach(work=>work.status='done');assert.equal(generatedPackageSelection(detail).reason,null);assert.deepEqual(generatedPackageSelection(detail).artifacts.map(item=>item.id),[artifact.id]);
  detail.artifacts.push({...artifact,id:id(90),version:2,reviewStatus:'pending'});assert.match(generatedPackageSelection(detail).reason!,/latest final/);detail.artifacts.pop();
  detail.reviews.push({...review,id:id(91),createdAt:'2026-09-21T00:00:00.000Z',decision:'changes_requested'});assert.match(generatedPackageSelection(detail).reason!,/independent technical review/);detail.reviews.pop();
  review.manifestSha256='f'.repeat(64);assert.match(generatedPackageSelection(detail).reason!,/exact specification and manifest/);review.manifestSha256=manifestSha;
  review.reviewedBy=id(12);assert.match(generatedPackageSelection(detail).reason!,/independent/);review.reviewedBy=id(15);
  artifact.file.bytes++;assert.match(generatedPackageSelection(detail).reason!,/exact specification and manifest/);
 }
});
test('package rejects incomplete or altered QC graphs rather than selecting arbitrary approved artifacts',()=>{
 const {detail}=fixture();detail.workItems.forEach(work=>work.status='done');
 detail.workItems[1].dependencies=[];assert.match(generatedPackageSelection(detail).reason!,/exact generation final/);
 detail.workItems[1].dependencies=[id(3)];detail.workItems[1].shotId=id(99);assert.match(generatedPackageSelection(detail).reason!,/own independent QC/);
 detail.workItems[1].shotId=id(2);detail.workItems[0].execution='dcc';assert.match(generatedPackageSelection(detail).reason!,/exact generation final/);
});
test('media links are locally constructed and access must pin the exact version and file facts',()=>{
 const {detail,artifact}=fixture(),company=id(50),gateway='https://storage.example';
 assert.equal(generatedManifestPath(company,detail.project.id,artifact.id),`/api/companies/${company}/studio/projects/${detail.project.id}/generated-artifacts/${artifact.id}/manifest`);
 assert.equal(generatedVersionAccessPath(company,detail.project.id,artifact.provenance.storageVersionId),`/api/companies/${company}/studio/projects/${detail.project.id}/files/versions/${artifact.provenance.storageVersionId}/access`);
 assert.throws(()=>generatedManifestPath(company,detail.project.id,'../../private'));
 const access:StorageDownloadAccess={url:`${gateway}/v1/files/${artifact.provenance.storageVersionId}`,headers:{Authorization:'Bearer synthetic_fixture'},expiresAt:'2099-01-01T00:00:00.000Z',bytes:artifact.file.bytes,name:'output.png',sha256:artifact.file.sha256,contentType:artifact.file.contentType};
 assert.doesNotThrow(()=>assertGeneratedDownload(access,artifact,gateway));
 for(const changes of [{url:gateway+'/v1/files/'+id(99)},{url:'https://different.example/v1/files/'+artifact.provenance.storageVersionId},{url:access.url+'?token=leak'},{url:access.url+'#fragment'},{sha256:'f'.repeat(64)},{bytes:101},{contentType:'text/html'}])assert.throws(()=>assertGeneratedDownload({...access,...changes},artifact,gateway));
});

function revisionFixture(kind:'image'|'video'|'audio'='image'){
 const f=fixture(kind),{detail,artifact,review}=f;detail.workItems.forEach(work=>work.status='done');
 detail.historyWorkItems=structuredClone(detail.workItems);
 const unit={...detail.shots[0],id:id(70),code:'NEW02'};detail.shots.push(unit);
 const generation={...detail.workItems[0],id:id(71),taskId:id(72),shotId:unit.id},qc={...detail.workItems[1],id:id(73),taskId:id(74),shotId:unit.id,dependencies:[generation.id]};
 detail.workItems=[generation,qc];
 const next={...structuredClone(artifact),id:id(75),workItemId:generation.id,provenance:{...artifact.provenance,storageVersionId:id(76)},manifestSha256:'d'.repeat(64)};
 detail.artifacts.push(next);detail.reviews.push({...review,id:id(77),artifactId:next.id,manifestSha256:next.manifestSha256});
 const carry={artifactId:artifact.id,reviewId:review.id,storageVersionId:artifact.provenance.storageVersionId,manifestSha256:artifact.manifestSha256,fileSha256:artifact.file.sha256};
 detail.generatedRound={roundId:id(80),number:1,planSha256:'e'.repeat(64),workItemIds:detail.workItems.map(work=>work.id),finals:[{unitId:id(2),generationWorkItemId:id(3),qcWorkItemId:id(7),carry},{unitId:unit.id,generationWorkItemId:generation.id,qcWorkItemId:qc.id,carry:null}]};
 return {...f,next,carry};
}
test('revision packages combine exact historical carry and newly approved work across all media kinds',()=>{
 for(const kind of ['image','video','audio'] as const){const {detail,artifact,next}=revisionFixture(kind),before=JSON.stringify(detail.historyWorkItems);
  assert.deepEqual(generatedPackageSelection(detail),{artifacts:[artifact,next],reason:null});
  assert.equal(generatedTechnicalMatch(detail,artifact).matches,true);
  assert.match(generatedReviewerReason(detail,artifact,id(15),'owner')!,/earlier round/);
  assert.equal(JSON.stringify(detail.historyWorkItems),before);
  detail.workItems[0].status='doing';assert.match(generatedPackageSelection(detail).reason!,/Accept all/);
 }
});
test('carry pins, original QC and active scope cannot be substituted or silently omitted',()=>{
 for(const field of ['artifactId','storageVersionId','manifestSha256','fileSha256','reviewId'] as const){const {detail,carry}=revisionFixture();carry[field]=field.endsWith('Sha256')?'f'.repeat(64):id(99);assert.notEqual(generatedPackageSelection(detail).reason,null,field);}
 const {detail}=revisionFixture();detail.historyWorkItems![1].dependencies=[id(71)];assert.match(generatedPackageSelection(detail).reason!,/exact generation/);
 const second=revisionFixture().detail;second.generatedRound!.workItemIds.push(id(99));assert.match(generatedPackageSelection(second).reason!,/scope is incomplete/);
 const third=revisionFixture().detail;third.generatedRound!.finals.pop();assert.match(generatedPackageSelection(third).reason!,/scope is incomplete/);
});
test('only the active round packages are eligible while earlier deliveries stay in history',()=>{
 const {detail}=revisionFixture(),base={id:id(90),name:'Original package',note:'Original immutable package.',createdAt:at,status:'prepared' as const,manifest:{}};
 detail.deliveries=[base,{...base,id:id(91),name:'Round 1',roundId:detail.generatedRound!.roundId,roundNumber:1}];
 assert.deepEqual(generatedCurrentDeliveries(detail).map(item=>item.id),[id(91)]);assert.equal(detail.deliveries.length,2);
 delete detail.generatedRound;assert.deepEqual(generatedCurrentDeliveries(detail).map(item=>item.id),[id(90)]);
});
