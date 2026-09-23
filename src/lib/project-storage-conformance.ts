/** Operator-only provider qualification. This does not grant Coatria file access. */
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {RUNPOD_STORAGE_REGIONS} from './project-storage-protocol';
import {createRunpodProjectStorage,RunpodStorageError,type RunpodProjectStorage,type RunpodProjectStorageConfig,type RunpodStorageTransport} from './project-storage-runpod';

export const STORAGE_CONFORMANCE_PART_BYTES=5*1024**2;
export const STORAGE_CONFORMANCE_BYTES=STORAGE_CONFORMANCE_PART_BYTES+64*1024;
const protectedVolumes=new Set(['k4mj9x0yas']);
const uuid=z.string().uuid();
export const storageConformancePlanSchema=z.object({
 schemaVersion:z.literal(1),purpose:z.literal('synthetic-provider-conformance'),runId:uuid,
 volumeId:z.string().regex(/^[a-z0-9-]{4,64}$/).refine(value=>!protectedVolumes.has(value),'Retained inference storage is not a conformance target.'),region:z.enum(RUNPOD_STORAGE_REGIONS),
 companyId:uuid,projectId:uuid,versionId:uuid,abortVersionId:uuid,
 bytes:z.literal(STORAGE_CONFORMANCE_BYTES),partBytes:z.literal(STORAGE_CONFORMANCE_PART_BYTES),abortBytes:z.literal(64*1024),
}).strict().refine(v=>new Set([v.runId,v.companyId,v.projectId,v.versionId,v.abortVersionId]).size===5,'Use separate fresh identities.');
export type StorageConformancePlan=z.infer<typeof storageConformancePlanSchema>;
export function prepareStorageConformance(volumeId:string,region:unknown):StorageConformancePlan{
 return storageConformancePlanSchema.parse({schemaVersion:1,purpose:'synthetic-provider-conformance',runId:randomUUID(),volumeId,region,companyId:randomUUID(),projectId:randomUUID(),versionId:randomUUID(),abortVersionId:randomUUID(),bytes:STORAGE_CONFORMANCE_BYTES,partBytes:STORAGE_CONFORMANCE_PART_BYTES,abortBytes:64*1024});
}
export function storageConformancePlanSha256(plan:StorageConformancePlan){return createHash('sha256').update(JSON.stringify(storageConformancePlanSchema.parse(plan))).digest('hex');}
export function conformanceBytes(plan:StorageConformancePlan,length=plan.bytes){
 const block=createHash('sha256').update('coatria-synthetic-conformance:'+plan.runId).digest(),data=Buffer.alloc(length);for(let i=0;i<length;i+=block.length)block.copy(data,i,0,Math.min(block.length,length-i));return data;
}
export type ConformanceEvent={step:string;phase:'intent'|'returned'|'passed'|'failed';detail?:Record<string,unknown>};
type Dependencies={credentials:RunpodProjectStorageConfig['credentials'];record:(event:ConformanceEvent)=>Promise<void>;transport?:RunpodStorageTransport;factory?:(config:RunpodProjectStorageConfig,transport?:RunpodStorageTransport)=>RunpodProjectStorage;signal?:AbortSignal};
const code=(error:unknown)=>error instanceof RunpodStorageError?error.code:'STORAGE_CONFORMANCE_FAILED';
function insist(value:unknown):asserts value{if(!value)throw new RunpodStorageError('STORAGE_PROVIDER_PROTOCOL');}
function providerConfig(plan:StorageConformancePlan,credentials:Dependencies['credentials']):RunpodProjectStorageConfig{return {companyId:plan.companyId,projectId:plan.projectId,volumeId:plan.volumeId,region:plan.region,credentials:{...credentials},timeoutMs:30000,partBytes:plan.partBytes,maxObjectBytes:plan.bytes};}
function active(signal?:AbortSignal){if(signal?.aborted)throw new RunpodStorageError('STORAGE_ABORTED');}
function recorder(save:Dependencies['record'],signal?:AbortSignal){return async(event:ConformanceEvent)=>{active(signal);await save(event);active(signal);};}
async function collect(stream:ReadableStream<Uint8Array>,expected:number,signal?:AbortSignal){const reader=stream.getReader(),chunks:Uint8Array[]=[];let length=0;try{for(;;){active(signal);let abort:()=>void=()=>{};const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new RunpodStorageError('STORAGE_ABORTED'));signal?.addEventListener('abort',abort,{once:true});});let chunk:ReadableStreamReadResult<Uint8Array>;try{chunk=await Promise.race([reader.read(),cancelled]);active(signal);}finally{signal?.removeEventListener('abort',abort);}if(chunk.done)break;insist(chunk.value instanceof Uint8Array);length+=chunk.value.byteLength;insist(length<=expected);chunks.push(chunk.value);}insist(length===expected);return Buffer.concat(chunks);}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}}
async function verify(plan:StorageConformancePlan,storage:RunpodProjectStorage,record:Dependencies['record'],signal?:AbortSignal){
 const bytes=conformanceBytes(plan),sha256=createHash('sha256').update(bytes).digest('hex'),head=await storage.head(plan.versionId,{signal});insist(head&&head.bytes===plan.bytes&&head.contentType==='application/octet-stream');
 const full=await storage.get({versionId:plan.versionId,maxBytes:plan.bytes,ifMatch:head.etag,signal});insist(full.bytes===plan.bytes&&full.totalBytes===plan.bytes&&full.etag===head.etag&&full.contentType==='application/octet-stream'&&full.range===null&&full.contentRange===null);const actual=await collect(full.stream,plan.bytes,signal);insist(createHash('sha256').update(actual).digest('hex')===sha256);
 await record({step:'stored-sha256',phase:'passed',detail:{bytes:plan.bytes,sha256,etag:head.etag}});
 // Crosses the multipart boundary so a provider cannot pass by serving part 1.
 const start=plan.partBytes-32,end=plan.partBytes+31,range=await storage.get({versionId:plan.versionId,maxBytes:64,range:{start,end},ifMatch:head.etag,signal});insist(range.bytes===64&&range.totalBytes===plan.bytes&&range.etag===head.etag&&range.range?.start===start&&range.range.end===end&&range.contentRange===`bytes ${start}-${end}/${plan.bytes}`&&(await collect(range.stream,64,signal)).equals(bytes.subarray(start,end+1)));
 await record({step:'range-across-parts',phase:'passed',detail:{start,end,totalBytes:range.totalBytes}});
 let rejected=false;try{const wrong=await storage.get({versionId:plan.versionId,maxBytes:plan.bytes,ifMatch:'"coatria-stale-'+plan.runId+'"',signal});void wrong.stream.cancel().catch(()=>{});}catch(error){if(error instanceof RunpodStorageError&&error.code==='STORAGE_OBJECT_CHANGED')rejected=true;else throw error;}insist(rejected);
 await record({step:'stale-etag-rejected-by-adapter',phase:'passed'});
 return {bytes:plan.bytes,sha256,etag:head.etag};
}
/** No mutation retries, no deletion, no volume creation; every mutation requires
 * a durable intent callback. A failed journal write prevents the next I/O. */
export async function runStorageConformance(input:unknown,deps:Dependencies){
 const plan=storageConformancePlanSchema.parse(input),factory=deps.factory??createRunpodProjectStorage,config=providerConfig(plan,deps.credentials),signal=deps.signal,save=deps.record,transport=deps.transport;active(signal);let storage=factory(config,transport),step='known-bucket-access';
 const record=recorder(save,signal);
 try{
  await storage.verifyBucketAccess({signal});await record({step,phase:'passed',detail:{operation:'HeadBucket',writePermissionEstablished:false}});
  step='preflight';
  insist(await storage.head(plan.versionId,{signal})===null&&await storage.head(plan.abortVersionId,{signal})===null);
  await record({step,phase:'passed',detail:{planSha256:storageConformancePlanSha256(plan)}});
  step='create-multipart';await record({step,phase:'intent'});const upload=await storage.createMultipart({versionId:plan.versionId,bytes:plan.bytes,contentType:'application/octet-stream',signal});await record({step,phase:'returned',detail:{upload}});
  const bytes=conformanceBytes(plan),parts=[];
  for(let partNumber=1;partNumber<=2;partNumber++){
   step='upload-part-'+partNumber;await record({step,phase:'intent'});const part=await storage.uploadPart({upload,partNumber,body:bytes.subarray((partNumber-1)*plan.partBytes,partNumber*plan.partBytes),signal});parts.push(part);await record({step,phase:'returned',detail:{part}});
   if(partNumber===1){storage.close();storage=factory(config,transport);storage.validateMultipart(JSON.parse(JSON.stringify(upload)));await record({step:'fresh-client-after-part-one',phase:'passed'});}
  }
  step='complete-multipart';await record({step,phase:'intent'});const complete=await storage.completeMultipart({upload,parts,signal});await record({step,phase:'returned',detail:{complete}});
  step='verify-stored-file';storage.close();storage=factory(config,transport);const verified=await verify(plan,storage,record,signal);insist(verified.etag===complete.etag);
  step='create-abort-test';await record({step,phase:'intent'});const abortUpload=await storage.createMultipart({versionId:plan.abortVersionId,bytes:plan.abortBytes,contentType:'application/octet-stream',signal});await record({step,phase:'returned',detail:{upload:abortUpload}});
  step='upload-abort-test';await record({step,phase:'intent'});const abortPart=await storage.uploadPart({upload:abortUpload,partNumber:1,body:conformanceBytes(plan,plan.abortBytes),signal});await record({step,phase:'returned',detail:{part:abortPart}});
  step='abort-confirmed-multipart';await record({step,phase:'intent'});await storage.abortMultipart({upload:abortUpload,signal});await record({step,phase:'returned'});insist(await storage.head(plan.abortVersionId,{signal})===null);
  const report={schemaVersion:1,planSha256:storageConformancePlanSha256(plan),providerTransportPassed:true,verified,retainedVersionId:plan.versionId,syntheticBytesRetained:plan.bytes,syntheticBytesSent:plan.bytes+plan.abortBytes,coverage:['multipart-create','two-parts','fresh-adapter-between-parts','complete','head','full-sha256-readback','cross-part-range','stale-etag-adapter-rejection','multipart-abort-acknowledgement'],notEstablished:['aborted-part-reclamation','gateway-authorization','tenant-isolation','grant-revocation','server-side-conditional-get','backup-retention','production-media','host-qualification','process-crash-recovery','power-loss-journal-durability']};
  await record({step:'completed',phase:'passed',detail:{report}});return report;
 }catch(error){await save({step,phase:'failed',detail:{code:code(error),automaticRetry:false,automaticCleanup:false}}).catch(()=>{});throw new RunpodStorageError(error instanceof RunpodStorageError?error.code:'STORAGE_PROVIDER_UNAVAILABLE');}finally{storage.close();}
}
/** Separate invocation can verify saved exact bytes without any provider writes. */
export async function verifyStorageConformance(input:unknown,deps:Dependencies){const plan=storageConformancePlanSchema.parse(input),signal=deps.signal,record=recorder(deps.record,signal);active(signal);const storage=(deps.factory??createRunpodProjectStorage)(providerConfig(plan,deps.credentials),deps.transport);try{return await verify(plan,storage,record,signal);}finally{storage.close();}}
