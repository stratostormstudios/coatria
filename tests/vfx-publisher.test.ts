import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {controlledRenderJobSchema,renderJobDigest,RenderError,sha256File,type RenderManifest,type RenderResult} from '../scripts/vfx/renderer.mjs';
import {publishExecutionOutputs,publicationRequestId} from '../scripts/vfx/publish.mjs';

const token='ce_'+randomUUID().replaceAll('-',''),companyId=randomUUID();
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fails=(code:string)=>(error:unknown)=>error instanceof RenderError&&error.code===code;
// Header-only fixtures exercise transport and byte integrity, not render quality.
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'coatria-publisher-test-'));
 const job=controlledRenderJobSchema.parse({schemaVersion:1,jobId:randomUUID(),profile:'coatria-product-turntable-v1',frameStart:1,frameEnd:1,width:32,height:32,fpsNumerator:24,fpsDenominator:1});
 const attempt=path.join(root,job.jobId,'attempts','0001');await mkdir(path.join(attempt,'frames'),{recursive:true});
 const png=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(32,16);png.writeUInt32BE(32,20);
 const exr=Buffer.alloc(80);exr.writeUInt32LE(20000630);exr.writeUInt32LE(2,4);const attr=Buffer.from('dataWindow\0box2i\0');attr.copy(exr,8);exr.writeUInt32LE(16,8+attr.length);exr.writeInt32LE(31,8+attr.length+12);exr.writeInt32LE(31,8+attr.length+16);
 const files:RenderManifest['files']=[];
 for(const [name,kind,bytes] of [['scene.blend','scene',Buffer.concat([Buffer.from('BLENDER'),Buffer.alloc(64)])],['review.png','review',png],['frames/frame-0001.exr','frame',exr]] as const){await writeFile(path.join(attempt,name),bytes);files.push({path:name,kind,sizeBytes:bytes.length,sha256:hash(bytes),...kind==='scene'?{}:{width:32,height:32},...kind==='frame'?{frame:1}:{}});}
 const manifest:RenderManifest={schemaVersion:1,job,jobSpecSha256:renderJobDigest(job),profileSha256:'a'.repeat(64),attempt:1,files,evidence:{blenderVersion:'unit fixture',blenderBuildHash:'fixture'},createdAt:new Date().toISOString()};
 await writeFile(path.join(attempt,'manifest.json'),JSON.stringify(manifest));
 const result:RenderResult={schemaVersion:1,status:'succeeded',jobId:job.jobId,attempt:1,manifestPath:'attempts/0001/manifest.json',manifestSha256:await sha256File(path.join(attempt,'manifest.json')),elapsedMs:1,replayed:false};
 await writeFile(path.join(root,job.jobId,'result.json'),JSON.stringify(result));
 const expected=new Map<string,{sha256:string;bytes:number;contentType:string}>();for(const file of files)expected.set(`${job.jobId}/attempts/0001/${file.path}`,{sha256:file.sha256,bytes:file.sizeBytes,contentType:file.path.endsWith('.png')?'image/png':file.path.endsWith('.exr')?'image/x-exr':'application/octet-stream'});
 const report=await readFile(path.join(attempt,'manifest.json'));expected.set(`${job.jobId}/attempts/0001/manifest.json`,{sha256:hash(report),bytes:report.length,contentType:'application/json'});
 return{root,job,attempt,expected,options:{origin:'https://coatria.com',token,outputRoot:root,jobId:job.jobId},clean:async()=>{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert(path.basename(root).startsWith('coatria-publisher-test-'));await rm(root,{recursive:true,force:true});}};
}
function service(f:Awaited<ReturnType<typeof fixture>>,changes:{url?:(url:URL)=>void;headers?:(headers:Record<string,string>)=>void;uploadStatus?:number;uncertainOnce?:boolean;wrongFile?:boolean}={}){
 const records=new Map<string,any>(),stored=new Map<string,Buffer>(),ids:any[]=[],calls:string[]=[];let lost=false;
 const transport=async(input:any,options:any)=>{
  const url=new URL(String(input));calls.push(options.method+' '+url.pathname);assert.equal(options.redirect,'error');
  if(url.origin==='https://coatria.com'){
   assert.equal(options.headers.Authorization,'Bearer '+token);const body=options.body?JSON.parse(options.body):{};
   if(url.pathname==='/api/execution/identity')return Response.json({connector:{id:randomUUID(),companyId}});
   if(url.pathname.endsWith('/upload')){
    ids.push(body);const expected=f.expected.get(body.path);assert(expected);let file=records.get(body.path);
    if(!file){file={id:randomUUID(),path:body.path,...expected,verifiedState:'awaiting_upload_or_verification'};records.set(body.path,file);}
    const extension=body.path.split('.').at(-1),blob=new URL('https://vercel.com/api/blob/');blob.searchParams.set('pathname',`studio/${companyId}/${f.job.jobId}/${expected.sha256}/${file.id}.${extension}`);blob.searchParams.set('signed','fixture');changes.url?.(blob);
    const headers={'Content-Type':file.contentType,'x-content-type':file.contentType};changes.headers?.(headers);
    return Response.json({file:changes.wrongFile?{...file,sha256:'f'.repeat(64)}:file,upload:file.verifiedState==='verified'?null:{url:blob.href,method:'PUT',headers,expiresAt:new Date(Date.now()+60000).toISOString()}});
   }
   if(url.pathname.endsWith('/verify')){
    ids.push(body);const file=[...records.values()].find(item=>item.id===body.fileId);assert(file);const bytes=stored.get(file.id);
    if(!bytes||bytes.length!==file.bytes||hash(bytes)!==file.sha256)return Response.json({code:'MEDIA_VERIFICATION_FAILED'},{status:409});
    file.verifiedState='verified';return Response.json({file});
   }
   throw Error('Unexpected API path.');
  }
  assert.equal(url.origin,'https://vercel.com');assert.equal(url.pathname,'/api/blob/');assert.deepEqual(Object.keys(options.headers),['Content-Type','x-content-type']);assert.equal(options.headers['x-content-type'],options.headers['Content-Type']);assert(!JSON.stringify(options.headers).includes(token));
  const id=url.searchParams.get('pathname')!.split('/').at(-1)!.split('.')[0];
  if(changes.uploadStatus)return Response.json({code:'fixture'},{status:changes.uploadStatus});
  if(stored.has(id))return Response.json({code:'existing_file'},{status:409});
  stored.set(id,Buffer.from(options.body));if(changes.uncertainOnce&&!lost){lost=true;throw Error('Response lost after storing bytes.');}
  return Response.json({ok:true});
 };
 return{transport,records,stored,ids,calls};
}

test('publishes every sealed file, verifies server bytes, replays without another PUT and keeps connector token off storage',async()=>{
 const f=await fixture(),api=service(f);
 try{const first=await publishExecutionOutputs({...f.options,fetch:api.transport}),puts=api.calls.filter(call=>call.startsWith('PUT')).length;assert.equal(first.files.length,4);assert.equal(first.independentlyReviewed,false);assert.equal(first.verificationSource,'server_bytes');assert.equal(puts,4);const second=await publishExecutionOutputs({...f.options,fetch:api.transport});assert.deepEqual(second,first);assert.equal(api.calls.filter(call=>call.startsWith('PUT')).length,puts);assert.equal(new Set(api.ids.map(item=>item.clientId)).size,8);assert(!JSON.stringify(first).includes(token));}finally{await f.clean();}
});

test('lost upload response is reconciled with stable IDs, write-once conflict and actual server verification',async()=>{
 const f=await fixture(),api=service(f,{uncertainOnce:true});
 try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_UPLOAD_UNCERTAIN'));assert.equal(api.stored.size,1);const result=await publishExecutionOutputs({...f.options,fetch:api.transport});assert.equal(result.status,'verified');assert.equal(result.files.length,4);assert.equal(api.ids[0].clientId,api.ids[1].clientId);}finally{await f.clean();}
});

test('a storage conflict or bad request alone cannot mark missing bytes verified',async()=>{
 for(const status of [400,409]){const f=await fixture(),api=service(f,{uploadStatus:status});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_API_REJECTED'));assert(api.calls.some(call=>call.endsWith('/verify')));assert.equal(api.stored.size,0);}finally{await f.clean();}}
});

test('rejects untrusted upload hosts, routes, physical path changes and mismatched manifest metadata before PUT',async()=>{
 for(const change of [(url:URL)=>{url.hostname='attacker.invalid';},(url:URL)=>{url.pathname='/api/other';},(url:URL)=>{url.searchParams.set('pathname','studio/other');},(url:URL)=>{url.username='private';}]){
  const f=await fixture(),api=service(f,{url:change});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_UPLOAD_REJECTED'));assert.equal(api.calls.filter(call=>call.startsWith('PUT')).length,0);}finally{await f.clean();}
 }
 const f=await fixture(),api=service(f,{wrongFile:true});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_PROTOCOL'));assert.equal(api.stored.size,0);}finally{await f.clean();}
});

test('changed local bytes or a different job never request an upload grant',async()=>{
 const f=await fixture(),api=service(f);try{await writeFile(path.join(f.attempt,'review.png'),Buffer.from('tampered'));await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}));assert.equal(api.calls.length,0);}finally{await f.clean();}
 const other=await fixture(),second=service(other);try{const file=path.join(other.root,other.job.jobId,'result.json'),result=JSON.parse(await readFile(file,'utf8'));result.jobId=randomUUID();await writeFile(file,JSON.stringify(result));await assert.rejects(publishExecutionOutputs({...other.options,fetch:second.transport}),fails('PUBLISH_JOB_MISMATCH'));assert.equal(second.calls.length,0);}finally{await other.clean();}
});

test('requires the exact MIME override pair and rejects missing, changed or extra upload headers',async()=>{
 for(const change of[(headers:Record<string,string>)=>{delete headers['x-content-type'];},(headers:Record<string,string>)=>{headers['x-content-type']='image/aces';},(headers:Record<string,string>)=>{headers.Authorization='fixture-do-not-forward';}]){
  const f=await fixture(),api=service(f,{headers:change});try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:api.transport}),fails('PUBLISH_UPLOAD_REJECTED'));assert.equal(api.calls.filter(call=>call.startsWith('PUT')).length,0);}finally{await f.clean();}
 }
});

test('publisher bounds API body consumption and derives deterministic job-scoped operation IDs',async()=>{
 const jobId=randomUUID();assert.equal(publicationRequestId(jobId,'scene.blend','upload'),publicationRequestId(jobId,'scene.blend','upload'));assert.notEqual(publicationRequestId(jobId,'scene.blend','upload'),publicationRequestId(jobId,'scene.blend','verify'));assert.notEqual(publicationRequestId(jobId,'scene.blend','upload'),publicationRequestId(randomUUID(),'scene.blend','upload'));
 const f=await fixture();let cancelled=false;try{await assert.rejects(publishExecutionOutputs({...f.options,fetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}))}),fails('PUBLISH_PROTOCOL'));assert.equal(cancelled,true);}finally{await f.clean();}
});
