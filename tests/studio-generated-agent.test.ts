import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AGENT_TOOLS,agentToolInputSchema,studioAgentProject,studioAgentSnapshot} from '../src/lib/agent-tools';
import {agentRuntimeOpenApi} from '../src/lib/agent-runtime-openapi';
import {studioProjectPlanInput,studioVersionedProjectInput} from '../src/lib/studio-protocol';
import {studioGeneratedArtifactRegisterInput} from '../src/lib/studio-generated-protocol';
import {studioGeneratedSourceInput,studioGeneratedManifestInput} from '../src/lib/studio-generated-artifacts';

const spec:any=agentRuntimeOpenApi,base='/api/companies/{companyId}/studio',projectPath=base+'/projects/{projectId}';
const legacy={name:'Legacy',clientName:'Synthetic',brief:'Legacy reference fixture.',spec:{width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'exr',colorSpace:'ACEScg'},shots:[{code:'SH010',description:'Legacy shot.',frameStart:1,frameEnd:2,disciplines:['compositing']}]};
const mediaSpecs=[{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},{kind:'video',format:'mp4',codec:'h264',width:16,height:16,color:{mode:'not_required'},frameRate:{mode:'constant',numerator:48,denominator:2},audio:{mode:'none'}},{kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:1}];
const plan=(media:any)=>({contractVersion:2,productionPath:'higgsfield',name:'Generated',clientName:'Synthetic',brief:'Generated reference fixture.',spec:media,shots:[{kind:media.kind,code:'GEN001',description:'One generated deliverable.',...media.kind==='image'?{}:{durationMs:{min:999,max:1001}}}]});
const input=(value:z.ZodType)=>z.toJSONSchema(value,{io:'input',unrepresentable:'any'});

test('agent version selection preserves legacy normalization and rejects mixed or unsupported generated contracts',()=>{
 assert.deepEqual(AGENT_TOOLS.studio_plan.schema.parse(legacy),studioProjectPlanInput.parse(legacy));
 assert.equal('contractVersion' in (AGENT_TOOLS.studio_plan.schema.parse(legacy)as any),false);
 for(const media of mediaSpecs){
  const args=plan(media),parsed:any=AGENT_TOOLS.studio_plan.schema.parse(args);assert.equal(parsed.contractVersion,2);assert.equal(parsed.spec.kind,media.kind);
  if(media.kind==='video')assert.deepEqual(parsed.spec.frameRate,{mode:'constant',numerator:24,denominator:1});
  for(const extra of[{clientId:randomUUID()},{contractVersion:1},{contractVersion:3},{contractVersion:'2'},{contractVersion:undefined},{productionPath:'vfx'},{approved:true},{shots:[{...args.shots[0],frameStart:1}]},{spec:legacy.spec}])assert.equal(AGENT_TOOLS.studio_plan.schema.safeParse({...args,...extra}).success,false,JSON.stringify(extra));
 }
 const read:any=AGENT_TOOLS.studio_get.schema.parse({});assert.deepEqual(read,{limit:50});assert(!('contractVersion'in read));
 assert(AGENT_TOOLS.studio_get.schema.safeParse({contractVersion:2}).success);for(const contractVersion of[1,3,'2',null])assert.equal(AGENT_TOOLS.studio_get.schema.safeParse({contractVersion}).success,false);
 const catalog:any=agentToolInputSchema(AGENT_TOOLS.studio_plan);assert.equal(catalog.type,'object');assert.equal(catalog.anyOf.length,2);assert(catalog.anyOf.every((branch:any)=>branch.type==='object'&&branch.additionalProperties===false));
 assert.deepEqual(spec.paths['/api/agent/tools/studio_plan'].post.requestBody.content['application/json'].schema.properties.arguments,catalog);
});

test('generated registration exposes references only and requires the existing four scopes with no approval tool',()=>{
 const tool=AGENT_TOOLS.studio_generated_artifact_register,args={projectId:randomUUID(),revision:1,workItemId:randomUUID(),archiveId:randomUUID(),name:'Exact archived output'};
 assert(tool.schema.safeParse(args).success);assert.equal(tool.capability,'studio.write');assert.deepEqual(tool.additionalCapabilities,['creative.read','creative.write','storage.read']);assert.equal(tool.mutating,true);
 for(const field of['clientId','companyId','agentId','producedBy','source','media','file','url','sha256','verified','technicalQc','runId'])assert.equal(tool.schema.safeParse({...args,[field]:'unsupported'}).success,false,field);
 const operation=spec.paths['/api/agent/tools/studio_generated_artifact_register'].post,envelope=operation.requestBody.content['application/json'].schema;
 assert.deepEqual(envelope.required,['runId','leaseToken','requestId','arguments']);assert.equal(envelope.additionalProperties,false);assert.equal(envelope.properties.leaseToken.writeOnly,true);assert.deepEqual(operation.security,[{agentBearer:[]}]);assert.equal(operation['x-coatria-approval-authority'],false);
 assert.deepEqual(operation['x-coatria-required-capabilities'],['studio.write','creative.read','creative.write','storage.read']);assert.match(operation.description,/revalidate current source, role, project and storage authority/);
 for(const name of['studio_generated_artifact_approve','studio_generated_deliver','studio_generated_client_share'])assert.equal(AGENT_TOOLS[name],undefined);
 assert.deepEqual(spec.paths[projectPath+'/generated-artifacts'].post.requestBody.content['application/json'].schema,input(studioGeneratedArtifactRegisterInput));
});

test('OpenAPI keeps generated image/video/audio schemas separate from legacy frame DTOs and documents withheld transport',()=>{
 const schemas=spec.components.schemas;
 assert.equal(schemas.StudioProject.properties.contractVersion,undefined);assert.equal(schemas.StudioArtifact.properties.media,undefined);assert(schemas.StudioArtifact.required.includes('frameStart'));
 assert.equal(schemas.StudioGeneratedProject.properties.contractVersion.const,2);assert.equal(schemas.StudioGeneratedProject.properties.productionPath.const,'higgsfield');
 const generated=schemas.StudioGeneratedArtifact;assert.equal(generated.additionalProperties,false);assert.equal(generated.properties.kind.const,'verified_generated_media');assert.equal(generated.properties.url.format,'uri-reference');assert.match(generated.properties.sha256.description,/manifest/);
 for(const field of['frameStart','frameEnd','handles','fpsNumerator','executionProvenance','signedUrl','leaseToken'])assert.equal(generated.properties[field],undefined);
 assert.deepEqual(schemas.StudioGeneratedSpec.oneOf?.map((branch:any)=>branch.properties.kind.const)??schemas.StudioGeneratedSpec.anyOf.map((branch:any)=>branch.properties.kind.const),['image','video','audio']);
 for(const branch of schemas.StudioGeneratedShot.oneOf){assert.equal(branch.additionalProperties,false);assert(branch.required.includes('id'));for(const field of['frameStart','frameEnd','handles','disciplines'])assert.equal(branch.properties[field],undefined);}
 for(const path of[base,projectPath]){const operation=spec.paths[path].get,selector=operation.parameters.find((entry:any)=>entry.name==='contractVersion');assert.equal(selector.required,false);assert.equal(selector.schema.const,2);assert.match(operation.description,/legacy|STUDIO_CONTRACT_UNSUPPORTED/);}
 assert.deepEqual(spec.paths[base+'/projects'].post.requestBody.content['application/json'].schema,input(studioVersionedProjectInput));
 const manifest=spec.paths[projectPath+'/generated-artifacts/{artifactId}/manifest'].get;assert.deepEqual(manifest.security,[{sessionCookie:[]}]);assert.equal(manifest.responses['200'].headers['X-Content-SHA256'].schema.pattern,'^[a-f0-9]{64}$');assert.match(manifest.description,/canonical UTF-8 JSON bytes/);
 const review=schemas.StudioGeneratedReview;for(const field of['specSha256','manifestSha256','attestationVersion','technicalMatch'])assert(review.required.includes(field));assert.equal(review.properties.attestationVersion.const,1);
 assert.equal(schemas.StudioGeneratedPackageManifest.properties.transportStatus.const,'not_transferred');assert.match(spec.paths[projectPath+'/deliveries'].post.description,/client access is a separate explicit account-bound invitation/);
 assert.deepEqual(schemas.StudioGeneratedSource,input(studioGeneratedSourceInput));assert.deepEqual(schemas.StudioGeneratedArtifactManifest,input(studioGeneratedManifestInput));
 assert.match(spec.paths[projectPath+'/creative-followup'].get.description,/STUDIO_GENERATED_FOLLOWUP_UNAVAILABLE/);assert.match(spec.paths[projectPath+'/creative-followup'].post.description,/STUDIO_GENERATED_FOLLOWUP_UNAVAILABLE/);assert.match(spec.paths[projectPath+'/client-deliveries'].post.description,/schemaVersion2 external package/);
});

test('generated model-context projections preserve version evidence without claiming inspection or inventing frames',()=>{
 for(const media of mediaSpecs){
  const projectId=randomUUID(),shotId=randomUUID(),workId=randomUUID(),artifactId=randomUUID();
  const artifact={id:artifactId,workItemId:workId,name:'Verified generated file',version:1,contractVersion:2,kind:'verified_generated_media',mediaKind:media.kind,media:{kind:media.kind},file:{bytes:200,sha256:'a'.repeat(64),contentType:media.kind==='image'?'image/png':media.kind==='video'?'video/mp4':'audio/wav'},sha256:'b'.repeat(64),manifestSha256:'b'.repeat(64),specSha256:'c'.repeat(64),url:'/api/companies/'+randomUUID()+'/studio/projects/'+projectId+'/generated-artifacts/'+artifactId+'/manifest',notes:'Original review notes',producedBy:randomUUID(),producedAgentId:null,reviewStatus:'pending'};
  const detail:any={project:{id:projectId,contractVersion:2,productionPath:'higgsfield',name:'Generated project',brief:'Private brief',spec:media,revision:1,gates:{}},shots:[{id:shotId,...plan(media).shots[0]}],workItems:[{id:workId,taskId:randomUUID(),shotId,dependencies:[],status:'doing',revision:2}],artifacts:[artifact],reviews:[],deliveries:[],roles:[],skills:[]};
  const before=JSON.stringify(detail),page:any=studioAgentProject(detail),exact:any=studioAgentProject(detail,{artifactId}),work:any=studioAgentProject(detail,{workItemId:workId});
  for(const result of[page,exact,work])assert.equal(result.project.contractVersion,2);
  assert.equal(page.artifacts[0].mediaKind,media.kind);assert.equal(page.artifacts[0].notes,undefined);assert.deepEqual(exact.artifact,artifact);assert.equal(exact.contentInspectedByThisResponse,false);assert.equal(work.projection.contentInspectedByThisResponse,false);
  assert.deepEqual(page.shots,detail.shots);assert.equal(JSON.stringify(detail),before);
  const sourceSnapshot:any={templates:[],skills:[],profile:null,projects:[detail.project],hasMore:false,nextAfter:null},snapshot:any=studioAgentSnapshot(sourceSnapshot);assert.equal(snapshot.projects[0].contractVersion,2);assert.equal(snapshot.projects[0].brief,undefined);
 }
});
