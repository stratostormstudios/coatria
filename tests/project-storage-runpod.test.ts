import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createRunpodProjectStorage,runpodProjectRoot,runpodProjectObjectKey,runpodStorageEndpoint,RUNPOD_STORAGE_REGIONS,RunpodStorageError,type RunpodProjectStorageConfig} from '../src/lib/project-storage-runpod';

const companyId='00000000-0000-4000-8000-000000000001',projectId='00000000-0000-4000-8000-000000000002',versionId='00000000-0000-4000-8000-000000000003',otherId='00000000-0000-4000-8000-000000000004';
const config:RunpodProjectStorageConfig={companyId,projectId,volumeId:'fixture-volume',region:'US-NC-2',credentials:{accessKeyId:['user','fixture'].join('_'),secretAccessKey:['rps','fixture-storage-credential'].join('_')},partBytes:4,maxObjectBytes:1000,timeoutMs:2000};
const key=runpodProjectObjectKey(companyId,projectId,versionId),prefix=runpodProjectRoot(companyId,projectId)+'objects/';
type Call={url:URL;init:RequestInit};
function fixture(reply:(call:Call)=>Promise<Response>|Response,changes:Partial<RunpodProjectStorageConfig>={}){const calls:Call[]=[];const storage=createRunpodProjectStorage({...config,...changes},{fetch:async(url,init)=>{const call={url:new URL(String(url)),init:init!};calls.push(call);assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');return reply(call);}});return {storage,calls};}
const xml=(body:string,status=200)=>new Response(body,{status,headers:{'Content-Type':'application/xml'}});
const created=()=>xml(`<InitiateMultipartUploadResult><Bucket>${config.volumeId}</Bucket><Key>${key}</Key><UploadId>opaque+upload/id</UploadId></InitiateMultipartUploadResult>`);
const completed=()=>xml(`<CompleteMultipartUploadResult><Bucket>${config.volumeId}</Bucket><Key>${key}</Key><ETag>"complete-etag"</ETag></CompleteMultipartUploadResult>`);
const isCode=(code:string)=>(error:unknown)=>error instanceof RunpodStorageError&&error.code===code;
const buffer=(value:ReadableStream<Uint8Array>)=>new Response(value).arrayBuffer().then(result=>Buffer.from(result));
function bytes(value:string){return new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from(value));c.close();}});}
function object(value:string,status=200,extra:Record<string,string>={}){return new Response(value,{status,headers:{'Content-Length':String(Buffer.byteLength(value)),ETag:'"object-etag"','Content-Type':'video/mp4',...extra}});}
async function multipart(f:ReturnType<typeof fixture>,size=6){return f.storage.createMultipart({versionId,bytes:size,contentType:'video/mp4'});}

test('Runpod adapter derives fixed regional endpoint and opaque company/project/version keys',()=>{
 assert.equal(RUNPOD_STORAGE_REGIONS.length,15);assert.equal(runpodStorageEndpoint('US-NC-2'),'https://s3api-us-nc-2.runpod.io');assert.equal(key,`coatria/companies/${companyId}/projects/${projectId}/objects/${versionId}`);
 for(const change of [{region:'evil.example'},{volumeId:'bucket/escape'},{companyId:'../escape'},{credentials:{accessKeyId:'bad',secretAccessKey:'bad'}},{partBytes:500_000_001}])assert.throws(()=>createRunpodProjectStorage({...config,...change} as RunpodProjectStorageConfig),isCode('STORAGE_CONFIG_INVALID'));
 for(const version of ['../secret','https://evil.example',versionId+'/../'+otherId,versionId.toUpperCase().replace('00000000','FFFFFFFF')])assert.throws(()=>runpodProjectObjectKey(companyId,projectId,version),isCode('STORAGE_INPUT_INVALID'));
});

test('heavy-file gateway can set a bounded two-hour deadline but cannot disable or exceed it',()=>{
 const f=fixture(()=>{throw Error('Configuration must not contact provider');},{timeoutMs:7_200_000,maxObjectBytes:100*1024**3,partBytes:64*1024**2});f.storage.close();assert.equal(f.calls.length,0);for(const timeoutMs of [7_200_001,Infinity,0,-1])assert.throws(()=>createRunpodProjectStorage({...config,timeoutMs}),isCode('STORAGE_CONFIG_INVALID'));
});

test('real AWS SDK signs a bounded scoped listing; cursors cannot cross projects',async()=>{
 const f=fixture(()=>xml(`<ListBucketResult><Name>${config.volumeId}</Name><IsTruncated>true</IsTruncated><NextContinuationToken>opaque-next</NextContinuationToken><Contents><Key>${key}</Key><Size>6</Size><ETag>"list-etag"</ETag><LastModified>2026-09-18T00:00:00.000Z</LastModified></Contents></ListBucketResult>`));
 try{const page=await f.storage.list({limit:5});assert.equal(page.objects[0].versionId,versionId);assert.equal(page.objects[0].bytes,6);assert(page.cursor);const call=f.calls[0];assert.equal(call.url.origin,'https://s3api-us-nc-2.runpod.io');assert.equal(call.url.pathname,'/'+config.volumeId+'/');assert.equal(call.url.searchParams.get('prefix'),prefix);assert.equal(call.url.searchParams.get('max-keys'),'5');assert.match(new Headers(call.init.headers).get('authorization')!,/^AWS4-HMAC-SHA256 /);assert(!JSON.stringify(page).includes(config.credentials.accessKeyId));assert(!JSON.stringify(page).includes(config.credentials.secretAccessKey));
  const second=fixture(()=>{throw Error('must not contact provider');},{projectId:otherId});try{await assert.rejects(second.storage.list({cursor:page.cursor}),isCode('STORAGE_INPUT_INVALID'));assert.equal(second.calls.length,0);}finally{second.storage.close();}
  await assert.rejects(f.storage.list({cursor:page.cursor}),isCode('STORAGE_PROVIDER_PROTOCOL'));assert.equal(f.calls[1].url.searchParams.get('continuation-token'),'opaque-next');
 }finally{f.storage.close();}
});

test('listing rejects escaped provider keys, nested unexpected prefixes and oversized pages',async()=>{
 for(const contents of [`<Contents><Key>outside/${versionId}</Key><Size>2</Size><ETag>x</ETag></Contents>`,`<CommonPrefixes><Prefix>${prefix}nested/</Prefix></CommonPrefixes>`,[versionId,otherId].map(id=>`<Contents><Key>${prefix+id}</Key><Size>2</Size><ETag>x</ETag></Contents>`).join('')]){
  const f=fixture(()=>xml(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`));try{await assert.rejects(f.storage.list({limit:1}),isCode('STORAGE_PROVIDER_PROTOCOL'));}finally{f.storage.close();}
 }
});

test('HEAD returns metadata, only maps genuine 404 to missing, and sanitizes other provider failures',async()=>{
 const f=fixture(({url})=>url.pathname.endsWith(versionId)?new Response(null,{headers:{'Content-Length':'6',ETag:'"head-etag"','Content-Type':'video/mp4'}}):new Response(null,{status:404}));
 try{assert.equal((await f.storage.head(versionId))?.bytes,6);assert.equal(await f.storage.head(otherId),null);assert.equal(f.calls[0].init.method,'HEAD');}finally{f.storage.close();}
 const denied=fixture(()=>xml(`<Error><Code>AccessDenied</Code><Message>${config.credentials.secretAccessKey}</Message></Error>`,403));try{await assert.rejects(denied.storage.head(versionId),error=>isCode('STORAGE_PROVIDER_UNAVAILABLE')(error)&&!String(error).includes(config.credentials.secretAccessKey));assert.equal(denied.calls.length,1);}finally{denied.storage.close();}
});

test('HEAD allows heavy object lengths without treating them as a metadata response body',async()=>{
 const f=fixture(()=>new Response(null,{headers:{'Content-Length':String(10*1024**3),ETag:'"large-object"'}}),{maxObjectBytes:100*1024**3});try{assert.equal((await f.storage.head(versionId))?.bytes,10*1024**3);assert.equal(f.calls.length,1);}finally{f.storage.close();}
});

test('multipart upload streams bounded parts through signed SDK requests and completes exact ordered receipts',async()=>{
 const bodies:Buffer[]=[];const f=fixture(async({url,init})=>{if(url.searchParams.has('uploads'))return created();if(init.method==='PUT'){bodies.push(Buffer.from(await new Response(init.body).arrayBuffer()));return new Response(null,{headers:{ETag:'"part-'+url.searchParams.get('partNumber')+'"'}});}assert.equal(init.method,'POST');assert.match(String(init.body),/<PartNumber>1<\/PartNumber>/);return completed();});
 try{const upload=await multipart(f);assert.equal(upload.bytes,6);assert.equal(upload.partBytes,4);const first=await f.storage.uploadPart({upload,partNumber:1,body:bytes('abcd')}),last=await f.storage.uploadPart({upload,partNumber:2,body:Buffer.from('ef')});assert.deepEqual(bodies,[Buffer.from('abcd'),Buffer.from('ef')]);const result=await f.storage.completeMultipart({upload,parts:[first,last]});assert.deepEqual(result,{versionId,etag:'"complete-etag"'});assert.equal(f.calls.length,4);for(const call of f.calls)assert.equal(call.url.pathname,'/'+config.volumeId+'/'+key);assert.equal(f.calls[1].url.searchParams.get('uploadId'),'opaque+upload/id');assert.equal(new Headers(f.calls[1].init.headers).get('content-length'),'4');assert(f.calls[1].init.body instanceof Readable);
 }finally{f.storage.close();}
});

test('multipart rejects foreign handles, invalid part lengths and incomplete/duplicate/out-of-order receipts before I/O',async()=>{
 const f=fixture(()=>created());try{const upload=await multipart(f);for(const candidate of [{...upload,scope:'wrong'},{...upload,versionId:'../escape'},{...upload,partBytes:8}])await assert.rejects(f.storage.uploadPart({upload:candidate,partNumber:1,body:Buffer.from('abcd')}),isCode('STORAGE_INPUT_INVALID'));await assert.rejects(f.storage.uploadPart({upload,partNumber:2,body:Buffer.from('abc')}),isCode('STORAGE_INPUT_INVALID'));for(const parts of [[],[{partNumber:1,etag:'a',bytes:4}],[{partNumber:1,etag:'a',bytes:4},{partNumber:1,etag:'b',bytes:2}]])await assert.rejects(f.storage.completeMultipart({upload,parts}),isCode('STORAGE_INPUT_INVALID'));assert.equal(f.calls.length,1);}finally{f.storage.close();}
});

test('gateway Node streams stay streaming and multipart descriptors are validated without accepting authority from extra fields',async()=>{
 const f=fixture(async({url,init})=>{if(url.searchParams.has('uploads'))return created();assert(init.body instanceof Readable);const headers=new Headers(init.headers);assert.equal(headers.get('content-length'),'4');assert.equal(headers.get('x-amz-trailer'),null);assert.notEqual(headers.get('content-encoding'),'aws-chunked');assert.equal(Buffer.from(await new Response(init.body).arrayBuffer()).toString(),'abcd');return new Response(null,{headers:{ETag:'part-node'}});});
 try{const upload=await multipart(f);assert.deepEqual(f.storage.validateMultipart({...upload,untrusted:'discarded'}),upload);assert.throws(()=>f.storage.validateMultipart(null),isCode('STORAGE_INPUT_INVALID'));assert.throws(()=>f.storage.validateMultipart({...upload,bytes:NaN}),isCode('STORAGE_INPUT_INVALID'));await f.storage.uploadPart({upload,partNumber:1,body:Readable.from([Buffer.from('ab'),Buffer.from('cd')])});}finally{f.storage.close();}
});

test('streaming upload rejects short and overlong bodies without claiming completion',async()=>{
 for(const input of ['abc','abcde']){const f=fixture(async({url,init})=>{if(url.searchParams.has('uploads'))return created();await new Response(init.body).arrayBuffer();return new Response(null,{headers:{ETag:'x'}});});try{const upload=await multipart(f);await assert.rejects(f.storage.uploadPart({upload,partNumber:1,body:bytes(input)}),isCode('STORAGE_PROVIDER_UNCERTAIN'));assert.equal(f.calls.length,2);}finally{f.storage.close();}}
});

test('an early success response cannot confirm a streaming part that was never consumed',async()=>{
 let cancelled=false;const f=fixture(({url})=>url.searchParams.has('uploads')?created():new Response(null,{headers:{ETag:'false-success'}}));try{const upload=await multipart(f);await assert.rejects(f.storage.uploadPart({upload,partNumber:1,body:new ReadableStream({cancel(){cancelled=true;}})}),isCode('STORAGE_PROVIDER_UNCERTAIN'));assert.equal(cancelled,true);}finally{f.storage.close();}
});

test('abort targets one persisted multipart upload; write failures never auto-retry or expose provider messages',async()=>{
 let abort=false;const f=fixture(({url,init})=>{if(url.searchParams.has('uploads'))return created();if(abort){assert.equal(init.method,'DELETE');return new Response(null,{status:204});}return xml(`<Error><Code>SlowDown</Code><Message>${config.credentials.secretAccessKey}</Message></Error>`,503);});
 try{const upload=await multipart(f);await assert.rejects(f.storage.uploadPart({upload,partNumber:1,body:Buffer.from('abcd')}),error=>isCode('STORAGE_PROVIDER_UNCERTAIN')(error)&&!String(error).includes(config.credentials.secretAccessKey));assert.equal(f.calls.length,2);abort=true;await f.storage.abortMultipart({upload});assert.equal(f.calls.length,3);assert.equal(f.calls[2].url.searchParams.get('uploadId'),upload.uploadId);}finally{f.storage.close();}
});

test('streamed GET validates full object size and exact range metadata before exposing bytes',async()=>{
 const f=fixture(({init})=>{const range=new Headers(init.headers).get('range');return range?object('cde',206,{'Content-Range':'bytes 2-4/6'}):object('abcdef');});
 try{const whole=await f.storage.get({versionId,maxBytes:6});assert.equal(whole.bytes,6);assert.equal(whole.totalBytes,6);assert.equal(whole.range,null);assert.equal((await buffer(whole.stream)).toString(),'abcdef');const part=await f.storage.get({versionId,range:{start:2,end:4},maxBytes:3});assert.equal(part.totalBytes,6);assert.deepEqual(part.range,{start:2,end:4});assert.equal((await buffer(part.stream)).toString(),'cde');await assert.rejects(f.storage.get({versionId,range:{start:0,end:6},maxBytes:3}),isCode('STORAGE_INPUT_INVALID'));assert.equal(f.calls.length,2);}finally{f.storage.close();}
});

test('ignored or malformed Range cannot masquerade as successful seeking',async()=>{
 for(const response of [()=>object('abc',200),()=>object('abc',206,{'Content-Range':'bytes 0-2/6'}),()=>object('abc',206,{'Content-Range':'garbage'})]){const f=fixture(response);try{await assert.rejects(f.storage.get({versionId,range:{start:2,end:4},maxBytes:3}),isCode('STORAGE_RANGE_UNSUPPORTED'));}finally{f.storage.close();}}
});

test('verified object downloads pin If-Match and reject changed or missing provider ETags',async()=>{
 const f=fixture(({init})=>{assert.equal(new Headers(init.headers).get('if-match'),'"object-etag"');return object('abc');});try{const result=await f.storage.get({versionId,maxBytes:3,ifMatch:'"object-etag"'});assert.equal((await buffer(result.stream)).toString(),'abc');assert.equal(result.contentRange,null);await assert.rejects(f.storage.get({versionId,maxBytes:3,ifMatch:'*'}),isCode('STORAGE_INPUT_INVALID'));assert.equal(f.calls.length,1);}finally{f.storage.close();}
 for(const [reply,code]of [[()=>object('abc'), 'STORAGE_OBJECT_CHANGED'],[()=>new Response('abc',{headers:{'Content-Length':'3'}}),'STORAGE_PROVIDER_PROTOCOL'],[()=>xml('<Error><Code>PreconditionFailed</Code></Error>',412),'STORAGE_OBJECT_CHANGED']] as const){const changed=fixture(reply);try{await assert.rejects(changed.storage.get({versionId,maxBytes:3,ifMatch:'"verified-old-etag"'}),isCode(code));assert.equal(changed.calls.length,1);}finally{changed.storage.close();}}
});

test('a provider response arriving after timeout is cancelled rather than leaked', {timeout:5000},async()=>{
 let resolveResponse!:(response:Response)=>void,cancelled=false;const f=fixture(()=>new Promise<Response>(resolve=>{resolveResponse=resolve;}),{timeoutMs:20});try{await assert.rejects(f.storage.list(),isCode('STORAGE_TIMEOUT'));resolveResponse(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(done=>setImmediate(done));assert.equal(cancelled,true);assert.equal(f.calls.length,1);}finally{f.storage.close();}
});

test('GET enforces byte caps, declared lengths and cancels an unread stream when the caller cancels',async()=>{
 for(const [body,declared,expected]of [['abc',2,'STORAGE_RESPONSE_TOO_LARGE'],['ab',3,'STORAGE_PROVIDER_PROTOCOL']] as const){const f=fixture(()=>object(body,200,{'Content-Length':String(declared)}));try{const result=await f.storage.get({versionId,maxBytes:declared});await assert.rejects(buffer(result.stream),isCode(expected));}finally{f.storage.close();}}
 let cancelled=false;const f=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Length':'3',ETag:'x'}}));try{const result=await f.storage.get({versionId,maxBytes:3});await result.stream.cancel();await new Promise(done=>setImmediate(done));assert.equal(cancelled,true);}finally{f.storage.close();}
});

test('metadata HTTP responses are bounded before SDK parsing',async()=>{
 let cancelled=false;const f=fixture(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/xml'}}));try{await assert.rejects(f.storage.list(),isCode('STORAGE_RESPONSE_TOO_LARGE'));assert.equal(cancelled,true);}finally{f.storage.close();}
});

test('deadline covers both ignored fetch cancellation and an unconsumed GET body', {timeout:5000},async()=>{
 const hanging=fixture(()=>new Promise<Response>(()=>{}),{timeoutMs:30});try{await assert.rejects(hanging.storage.list(),isCode('STORAGE_TIMEOUT'));assert.equal(hanging.calls.length,1);}finally{hanging.storage.close();}
 let cancelled=false;const f=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Length':'2',ETag:'x'}}),{timeoutMs:50});try{const result=await f.storage.get({versionId,maxBytes:2});await assert.rejects(buffer(result.stream),isCode('STORAGE_TIMEOUT'));assert.equal(cancelled,true);}finally{f.storage.close();}
});

test('caller abort and close stop active reads; no network request starts after pre-abort or close',async()=>{
 const controller=new AbortController();controller.abort();const f=fixture(()=>object('ab'));try{await assert.rejects(f.storage.head(versionId,{signal:controller.signal}),isCode('STORAGE_ABORTED'));assert.equal(f.calls.length,0);const result=await f.storage.get({versionId,maxBytes:2});f.storage.close();await assert.rejects(buffer(result.stream),isCode('STORAGE_ABORTED'));await assert.rejects(f.storage.head(versionId),isCode('STORAGE_ABORTED'));assert.equal(f.calls.length,1);}finally{f.storage.close();}
});
