import {createHash} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {runtimeOrigin,stableRequestId} from '../../public/downloads/agent-worker.mjs';
import {executionManifestFromResult} from './worker.mjs';
import {RenderError,type RenderResult} from './renderer.mjs';

const MAX_FILE=20*1024*1024,MAX_RESPONSE=1024*1024;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const uuid=z.string().uuid();
const resultSchema=z.object({schemaVersion:z.literal(1),status:z.literal('succeeded'),jobId:uuid,attempt:z.number().int().min(1),manifestPath:z.string().regex(/^attempts\/\d{4}\/manifest\.json$/),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),elapsedMs:z.number().nonnegative(),replayed:z.boolean()}).strict();
const fileSchema=z.object({id:uuid,path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(1).max(MAX_FILE),contentType:z.string(),verifiedState:z.enum(['verified','awaiting_upload_or_verification'])}).passthrough();
type PublishOptions={origin:string;token:string;outputRoot:string;jobId:string;signal?:AbortSignal;fetch?:typeof fetch;requestTimeoutMs?:number};
export const publicationRequestId=(jobId:string,filePath:string,operation:'upload'|'verify')=>stableRequestId(jobId,'media:'+operation+':'+sha(filePath));
function contentType(file:string){return file.endsWith('.png')?'image/png':file.endsWith('.exr')?'image/x-exr':file.endsWith('.json')?'application/json':'application/octet-stream';}
function contained(root:string,file:string){const relative=path.relative(root,file);return Boolean(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
async function checkedFile(root:string,relative:string,maxBytes:number){
 if(!relative||relative.includes('\\')||path.isAbsolute(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new RenderError('PUBLISH_PATH','Use exact contained output paths.');
 let current=root;const parts=relative.split('/');for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);const info=await lstat(current);if(info.isSymbolicLink()||(i<parts.length-1?!info.isDirectory():!info.isFile()))throw new RenderError('PUBLISH_PATH','Publication requires regular output files and directories.');}
 const resolved=await realpath(current),info=await lstat(current);if(!contained(root,resolved)||info.size<1||info.size>maxBytes)throw new RenderError('PUBLISH_FILE_LIMIT','Publication is limited to contained files of at most 20 MiB.');
 return current;
}
async function bytesAt(root:string,relative:string,maxBytes:number){
 const target=await checkedFile(root,relative,maxBytes),handle=await open(target,'r');
 try{const info=await handle.stat();if(!info.isFile()||info.size<1||info.size>maxBytes)throw new RenderError('PUBLISH_FILE_LIMIT','The local file changed.');const bytes=Buffer.alloc(info.size);let offset=0;while(offset<bytes.length){const chunk=await handle.read(bytes,offset,bytes.length-offset,offset);if(!chunk.bytesRead)break;offset+=chunk.bytesRead;}if(offset!==bytes.length||(await handle.stat()).size!==bytes.length)throw new RenderError('PUBLISH_FILE_CHANGED','The local file changed while reading.');return bytes;}finally{await handle.close();}
}
async function abortable<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{let abort:()=>void=()=>{};try{return await Promise.race([operation,new Promise<T>((_resolve,reject)=>{abort=()=>reject(signal.reason);if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}}
async function responseJson(response:Response,signal:AbortSignal){
 const reader=response.body?.getReader();if(!reader)throw new RenderError('PUBLISH_PROTOCOL','Missing bounded API response.');const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE)throw new RenderError('PUBLISH_PROTOCOL','API response exceeds the protocol bound.');chunks.push(next.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function approvedUpload(value:unknown,expected:{jobId:string;companyId:string;fileId:string;sha256:string;path:string;contentType:string}){
 const upload=z.object({url:z.string().max(16000),method:z.literal('PUT'),headers:z.record(z.string(),z.string()),expiresAt:z.string().datetime()}).strict().parse(value);
 const url=new URL(upload.url),expires=Date.parse(upload.expiresAt),extension=expected.path.split('.').at(-1)?.toLowerCase()??'bin';
 const expectedPath=`studio/${expected.companyId}/${expected.jobId}/${expected.sha256}/${expected.fileId}.${extension}`;
 if(url.protocol!=='https:'||url.hostname!=='vercel.com'||url.port||url.username||url.password||url.hash||!['/api/blob','/api/blob/'].includes(url.pathname)||url.searchParams.getAll('pathname').length!==1||url.searchParams.get('pathname')!==expectedPath||expires<=Date.now()||expires>Date.now()+310000||Object.keys(upload.headers).length!==2||upload.headers['Content-Type']!==expected.contentType||upload.headers['x-content-type']!==expected.contentType)throw new RenderError('PUBLISH_UPLOAD_REJECTED','The upload grant does not match the approved storage path.');
 return upload;
}

/** Publish only a locally sealed controlled-render result for a completed job.
 * Server verification reads actual stored bytes; no creative approval is implied.
 * Every invocation derives the same request IDs. No credentials/URLs are journalled.
 */
export async function publishExecutionOutputs(options:PublishOptions){
 const origin=runtimeOrigin(options.origin);uuid.parse(options.jobId);
 if(!/^ce_[A-Za-z0-9_-]{20,200}$/.test(options.token)||!path.isAbsolute(options.outputRoot)||!Number.isInteger(options.requestTimeoutMs??30000)||(options.requestTimeoutMs??30000)<1||(options.requestTimeoutMs??30000)>30000)throw new RenderError('PUBLISH_CONFIG','Use a scoped connector credential, approved output root and bounded timeout.');
 const rootInfo=await lstat(options.outputRoot);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new RenderError('PUBLISH_PATH','The output root must be a real directory.');const root=await realpath(options.outputRoot);
 const result=resultSchema.parse(JSON.parse((await bytesAt(root,options.jobId+'/result.json',32768)).toString('utf8'))) as RenderResult;
 if(result.jobId!==options.jobId)throw new RenderError('PUBLISH_JOB_MISMATCH','The sealed result belongs to another job.');
 await checkedFile(root,options.jobId+'/'+result.manifestPath,256*1024);
 const manifest=await executionManifestFromResult(root,result);
 // Check the complete set before requesting any external storage grants.
 for(const file of manifest.files){if(file.bytes>MAX_FILE)throw new RenderError('PUBLISH_FILE_LIMIT','A completed output exceeds the 20 MiB private-media pilot limit.');await checkedFile(root,file.path,MAX_FILE);}
 const transport=options.fetch??fetch,timeout=options.requestTimeoutMs??30000;
 async function api(endpoint:string,body?:unknown){
  const signal=AbortSignal.any([AbortSignal.timeout(timeout),...(options.signal?[options.signal]:[])]);
  try{const response=await abortable(transport(origin+'/api/execution/'+endpoint,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+options.token,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body),signal,redirect:'error'}),signal);const value=await responseJson(response,signal);if(!response.ok)throw new RenderError('PUBLISH_API_REJECTED',`Media API rejected the request (${response.status}).`);return value;}catch(error){if(error instanceof RenderError)throw error;throw new RenderError('PUBLISH_API_UNCERTAIN','The media request did not finish. Re-run to reconcile the same request.');}
 }
 const identity=await api('identity'),companyId=uuid.parse((identity.connector as {companyId?:string})?.companyId);
 const files:Array<{id:string;path:string;sha256:string;bytes:number;verifiedState:'verified'}>=[];
 for(const file of manifest.files){
  options.signal?.throwIfAborted();const bytes=await bytesAt(root,file.path,MAX_FILE);
  if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw new RenderError('PUBLISH_FILE_CHANGED','An output changed after the local manifest was sealed.');
  const prepared=await api(`jobs/${options.jobId}/media/upload`,{clientId:publicationRequestId(options.jobId,file.path,'upload'),path:file.path}),record=fileSchema.parse(prepared.file);
  if(record.path!==file.path||record.sha256!==file.sha256||record.bytes!==file.bytes||record.contentType!==contentType(file.path))throw new RenderError('PUBLISH_PROTOCOL','The server file differs from the completed local output.');
  if(prepared.upload!==null){
   const upload=approvedUpload(prepared.upload,{jobId:options.jobId,companyId,fileId:record.id,sha256:file.sha256,path:file.path,contentType:record.contentType});
   const signal=AbortSignal.any([AbortSignal.timeout(timeout),...(options.signal?[options.signal]:[])]);
   let response:Response;
   try{response=await abortable(transport(upload.url,{method:'PUT',headers:{'Content-Type':record.contentType,'x-content-type':record.contentType},body:new Uint8Array(bytes),redirect:'error',signal}),signal);}catch{throw new RenderError('PUBLISH_UPLOAD_UNCERTAIN','The upload may have committed. Re-run to reconcile the same file without overwriting it.');}
   // A write-once conflict is never accepted as proof. Verification below must
   // retrieve and hash the exact existing bytes before recording success.
   const acceptable=response.ok||response.status===400||response.status===409;void response.body?.cancel().catch(()=>{});
   if(!acceptable)throw new RenderError('PUBLISH_UPLOAD_REJECTED',`Storage rejected the write-once upload (${response.status}).`);
  }else if(record.verifiedState!=='verified')throw new RenderError('PUBLISH_PROTOCOL','The server omitted an upload grant for unverified media.');
  const verified=fileSchema.parse((await api(`jobs/${options.jobId}/media/verify`,{clientId:publicationRequestId(options.jobId,file.path,'verify'),fileId:record.id})).file);
  if(verified.id!==record.id||verified.path!==file.path||verified.sha256!==file.sha256||verified.bytes!==file.bytes||verified.verifiedState!=='verified')throw new RenderError('PUBLISH_VERIFY_FAILED','Server byte verification did not confirm this exact output.');
  files.push({id:verified.id,path:verified.path,sha256:verified.sha256,bytes:verified.bytes,verifiedState:'verified'});
 }
 return{status:'verified' as const,jobId:options.jobId,verificationSource:'server_bytes' as const,independentlyReviewed:false,files};
}

async function main(){if(process.argv.length!==4||process.argv[2]!=='--job')throw new RenderError('USAGE','Use --job JOB_UUID with the private execution environment.');const result=await publishExecutionOutputs({origin:process.env.COATRIA_BASE_URL??'',token:process.env.COATRIA_EXECUTION_TOKEN??'',outputRoot:process.env.COATRIA_EXECUTION_OUTPUT_ROOT??'',jobId:process.argv[3]});console.log(JSON.stringify({status:result.status,jobId:result.jobId,files:result.files.length,verificationSource:result.verificationSource,independentlyReviewed:false}));}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(JSON.stringify({status:'stopped',code:error instanceof RenderError?error.code:'PUBLISH_FAILED'}));process.exitCode=1;});
