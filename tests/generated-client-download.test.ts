import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloadGeneratedClientFile,GENERATED_CLIENT_PART_BYTES as partBytes,type GeneratedClientFile,type GeneratedClientAccess} from '../src/lib/generated-client-download';
import {STORAGE_BROWSER_BLOB_LIMIT,type StorageSaveTarget} from '../src/lib/project-storage-client';
const version='00000000-0000-4000-8000-000000000001',artifact='00000000-0000-4000-8000-000000000002',origin='https://gateway.example.invalid';
function fixture(length=3){const bytes=Uint8Array.from({length},(_,i)=>i%251),sha256=createHash('sha256').update(bytes).digest('hex'),file:GeneratedClientFile={fileId:version,artifactId:artifact,path:'final.png',frame:null,sha256,bytes:length,contentType:'image/png',storageVersionId:version,mediaKind:'image',transport:'project_storage'},access:GeneratedClientAccess={transport:'project_storage',storageVersionId:version,gatewayOrigin:origin,url:origin+'/v1/client-files/'+version,headers:{Authorization:'Bearer sct_'+'s'.repeat(43)},expiresAt:'2099-01-01T00:00:00.000Z',bytes:length,name:file.path,sha256,contentType:file.contentType,status:'download_access_issued',bytesReceivedByClient:'not_observed'};return {bytes,file,access};}
function disk(){const events:string[]=[],chunks:Uint8Array[]=[],target:StorageSaveTarget={async write(chunk){events.push('write');chunks.push(chunk);},async close(){events.push('close');},async abort(){events.push('abort');}};return {events,chunks,target};}
function rangeResponse(f:ReturnType<typeof fixture>,init?:RequestInit,change?:(part:Uint8Array)=>Uint8Array){const range=new Headers(init?.headers).get('Range')!,[,start,end]=/^bytes=(\d+)-(\d+)$/.exec(range)!,part=f.bytes.slice(Number(start),Number(end)+1);return new Response(new Uint8Array(change?change(part):part),{status:206,headers:{'Content-Range':`${range.replace('=',' ')}/${f.file.bytes}`,'Content-Length':String(part.length),'X-Content-SHA256':f.file.sha256}});}
function clocks(t:TestContext){const clock={wall:Date.now(),monotonic:0};t.mock.method(Date,'now',()=>clock.wall);t.mock.method(performance,'now',()=>clock.monotonic);return clock;}
test('fast sequential ranges reuse live access and verify the complete disk file',async(t)=>{
 clocks(t);
 const f=fixture(partBytes+97),d=disk(),calls:string[]=[],events:string[]=[];
 const result=await downloadGeneratedClientFile(f.access,f.file,d.target,{renew:async()=>{throw Error('Unexpected renewal within the live access window.');},fetch:async(input,init)=>{assert.equal(String(input),f.access.url);assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.equal(init?.referrerPolicy,'no-referrer');const h=new Headers(init?.headers);calls.push(h.get('Range')!);events.push('get');assert.equal(h.get('Authorization'),f.access.headers.Authorization);return rangeResponse(f,init);}});
 assert.deepEqual(events,['get','get']);assert.deepEqual(calls,[`bytes=0-${partBytes-1}`,`bytes=${partBytes}-${f.file.bytes-1}`]);assert.equal(result.bytes,f.file.bytes);assert.equal(result.blob,null);assert.equal(d.events.at(-1),'close');assert.deepEqual(Buffer.concat(d.chunks),Buffer.from(f.bytes));
});
test('121 actual 4 MiB ranges use one grant with bounded staging memory and full SHA-256',{timeout:60_000},async(t)=>{
 clocks(t);
 const count=121,chunk=new Uint8Array(partBytes).fill(7),hash=createHash('sha256');for(let n=0;n<count;n++)hash.update(chunk);
 const f=fixture(),sha256=hash.digest('hex'),bytes=count*partBytes,file={...f.file,bytes,sha256},access={...f.access,bytes,sha256};
 let gets=0,renewals=0,received=0,closed=false,aborted=false;
 const target:StorageSaveTarget={async write(value){received+=value.byteLength;},async close(){closed=true;},async abort(){aborted=true;}};
 const result=await downloadGeneratedClientFile(access,file,target,{renew:async()=>{renewals++;return access;},fetch:async(_input,init)=>{
  const headers=new Headers(init?.headers),start=gets*partBytes;assert.equal(headers.get('Authorization'),access.headers.Authorization);assert.equal(headers.get('Range'),'bytes='+start+'-'+(start+partBytes-1));gets++;
  return new Response(new ReadableStream<Uint8Array>({start(stream){stream.enqueue(chunk);stream.close();}}),{status:206,headers:{'Content-Range':'bytes '+start+'-'+(start+partBytes-1)+'/'+bytes,'Content-Length':String(partBytes),'X-Content-SHA256':sha256}});
 }});
 assert.equal(gets,count);assert.equal(renewals,0);assert.equal(received,bytes);assert.equal(result.bytes,bytes);assert.equal(result.blob,null);assert(closed);assert(!aborted);
});
for(const wallShift of [0,-60_000])test('30-second monotonic age renews once with wall clock shifted '+wallShift+' ms',async(t)=>{
 const clock=clocks(t),f=fixture(partBytes*2+1),d=disk(),events:string[]=[];let gets=0;
 await downloadGeneratedClientFile(f.access,f.file,d.target,{renew:async()=>{events.push('renew');return {...f.access,headers:{Authorization:'Bearer sct_'+'r'.repeat(43)}};},fetch:async(_input,init)=>{
  gets++;events.push('get');assert.equal(new Headers(init?.headers).get('Authorization'),gets===1?f.access.headers.Authorization:'Bearer sct_'+'r'.repeat(43));
  if(gets===1){clock.monotonic=30_000;clock.wall+=wallShift;}return rangeResponse(f,init);
 }});
 assert.deepEqual(events,['get','renew','get','get']);assert.equal(d.events.at(-1),'close');
});
test('15-second wall-clock expiry margin renews even when monotonic age remains young',async(t)=>{
 const clock=clocks(t),f=fixture(partBytes*2+1),d=disk(),events:string[]=[];let gets=0;
 const initial={...f.access,expiresAt:new Date(clock.wall+60_000).toISOString()};
 await downloadGeneratedClientFile(initial,f.file,d.target,{renew:async()=>{events.push('renew');return {...f.access,expiresAt:new Date(clock.wall+60_000).toISOString()};},fetch:async(_input,init)=>{
  gets++;events.push('get');if(gets===1)clock.wall+=44_999;if(gets===2)clock.wall++;return rangeResponse(f,init);
 }});
 assert.deepEqual(events,['get','get','renew','get']);assert.equal(d.events.at(-1),'close');
});
test('gateway revocation on a reused live grant aborts without an API renewal or automatic retry',async(t)=>{
 clocks(t);const f=fixture(partBytes+1),d=disk();let gets=0,renewals=0;
 await assert.rejects(downloadGeneratedClientFile(f.access,f.file,d.target,{renew:async()=>{renewals++;return f.access;},fetch:async(_i,init)=>{gets++;assert.equal(new Headers(init?.headers).get('Authorization'),f.access.headers.Authorization);return gets===1?rangeResponse(f,init):new Response(null,{status:403});}}),/range was not confirmed/);
 assert.equal(gets,2);assert.equal(renewals,0);assert(d.events.includes('abort'));assert(!d.events.includes('close'));
});
test('correct small Blob output verifies SHA while same-length tamper never returns a downloadable Blob',async()=>{
 const f=fixture();let calls=0;const renew=async()=>f.access;
 await assert.rejects(downloadGeneratedClientFile(f.access,f.file,null,{renew,fetch:async(_i,init)=>{calls++;return rangeResponse(f,init,p=>{p[0]^=1;return p;});}}),/checksum differs/);assert.equal(calls,1);
 const result=await downloadGeneratedClientFile(f.access,f.file,null,{renew,fetch:async(_i,init)=>rangeResponse(f,init)});assert.deepEqual(new Uint8Array(await result.blob!.arrayBuffer()),f.bytes);
});
test('failed threshold renewal aborts staged bytes without a second GET or renewal retry',async(t)=>{
 const clock=clocks(t),f=fixture(partBytes+1),d=disk();let calls=0,renewals=0;
 await assert.rejects(downloadGeneratedClientFile(f.access,f.file,d.target,{renew:async()=>{renewals++;throw Error('Client access revoked.');},fetch:async(_i,init)=>{calls++;clock.monotonic=30_000;return rangeResponse(f,init);}}),/revoked/);assert.equal(calls,1);assert.equal(renewals,1);assert(d.events.includes('write'));assert(d.events.includes('abort'));assert(!d.events.includes('close'));
});
test('renewal cannot substitute version, gateway, name, digest or byte facts',async(t)=>{
 const clock=clocks(t),f=fixture(partBytes+1);
 for(const change of [{storageVersionId:artifact},{url:f.access.url.replace(version,artifact)},{gatewayOrigin:'https://other.example',url:'https://other.example/v1/client-files/'+version},{name:'other.png'},{sha256:'f'.repeat(64)},{bytes:f.file.bytes+1},{contentType:'video/mp4'}]){clock.monotonic=0;const d=disk();let calls=0;await assert.rejects(downloadGeneratedClientFile(f.access,f.file,d.target,{renew:async()=>({...f.access,...change}),fetch:async(_i,init)=>{calls++;clock.monotonic=30_000;return rangeResponse(f,init);}}),/does not match/);assert.equal(calls,1);assert(!d.events.includes('close'));}
});
test('unconfirmed range status, bounds or digest stop immediately without retries',async()=>{
 const f=fixture();for(const [status,headers]of [[200,{}],[206,{'Content-Range':'bytes 1-3/3'}],[206,{'Content-Length':'4'}],[206,{'X-Content-SHA256':'f'.repeat(64)}]] as const){let calls=0;const d=disk();await assert.rejects(downloadGeneratedClientFile(f.access,f.file,d.target,{renew:async()=>f.access,fetch:async(_i,init)=>{calls++;const r=rangeResponse(f,init);return new Response(new Uint8Array(f.bytes),{status,headers:{...Object.fromEntries(r.headers),...headers}});}}),/range was not confirmed/);assert.equal(calls,1);assert(!d.events.includes('close'));}
});
test('session abort cancels a stuck range reader and never closes staged disk bytes',{timeout:3000},async()=>{
 const f=fixture(),d=disk(),controller=new AbortController();let cancelled=false;
 const task=downloadGeneratedClientFile(f.access,f.file,d.target,{signal:controller.signal,renew:async()=>f.access,fetch:async(_i,init)=>{const r=rangeResponse(f,init);return new Response(new ReadableStream({start(){setTimeout(()=>controller.abort(),10);},cancel(){cancelled=true;}}),{status:206,headers:r.headers});}});
 await assert.rejects(task,{name:'AbortError'});assert(cancelled);assert(!d.events.includes('close'));assert(d.events.includes('abort'));
});
test('large Blob fallback and invalid initial identity are refused before any transport',async()=>{
 const f=fixture();let calls=0;const context={renew:async()=>{calls++;return f.access;},fetch:async()=>{calls++;throw Error('unexpected transport');}};
 await assert.rejects(downloadGeneratedClientFile({...f.access,bytes:STORAGE_BROWSER_BLOB_LIMIT+1},{...f.file,bytes:STORAGE_BROWSER_BLOB_LIMIT+1},null,context),/cannot save this large file/);
 await assert.rejects(downloadGeneratedClientFile(f.access,{...f.file,fileId:artifact},null,context),/does not match/);assert.equal(calls,0);
 await assert.rejects(downloadGeneratedClientFile({...f.access,headers:{Authorization:'Bearer sct_short'}},f.file,null,context),/does not match/);assert.equal(calls,0);
});
