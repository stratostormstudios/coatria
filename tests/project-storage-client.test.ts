import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cancelStorageUpload,downloadStorageFile,readStorageUpload,STORAGE_BROWSER_BLOB_LIMIT,uploadStorageFile,type StorageDownloadAccess,type StorageSaveTarget,type StorageUploadTicket} from '../src/lib/project-storage-client';

const gatewayOrigin='https://storage.example.test',hash='a'.repeat(64);
const ticket:StorageUploadTicket={id:'fixture-upload',versionId:'fixture-version',baseUrl:gatewayOrigin+'/v1/uploads/fixture-upload',token:'stg_fixture',expiresAt:new Date(Date.now()+60000).toISOString(),partBytes:3,totalBytes:8};
const status=(value='uploading',parts:{partNumber:number;bytes:number;sha256:string}[]=[])=>({upload:{id:ticket.id,versionId:ticket.versionId,status:value,totalBytes:ticket.totalBytes,partBytes:ticket.partBytes,uploadedBytes:parts.reduce((sum,part)=>sum+part.bytes,0),parts,expiresAt:ticket.expiresAt}});
const response=(value:unknown,code=200)=>new Response(JSON.stringify(value),{status:code,headers:{'Content-Type':'application/json'}});

test('browser upload sends bounded Blob parts once and requires a verified status receipt',async()=>{
 const calls:{url:string;init:RequestInit}[]=[],parts:{partNumber:number;bytes:number;sha256:string}[]=[];let phase='allocated';
 const transport=async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);calls.push({url,init:init!});assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.equal(init?.referrerPolicy,'no-referrer');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer stg_fixture');
  if(url.endsWith('/start')){assert.equal(init?.body,'{}');phase='uploading';return response(status(phase));}
  if(url.includes('/parts/')){const body=init?.body;assert(body instanceof Blob);assert(body.size<=ticket.partBytes);const part={partNumber:Number(url.split('/').at(-1)),bytes:body.size,sha256:hash};parts.push(part);return response(part);}
  if(url.endsWith('/complete')){phase='verifying';return response(status(phase,parts),202);}return response(status(phase,parts));};
 const progress:number[]=[];const result=await uploadStorageFile(new Blob(['abcdefgh']),ticket,{gatewayOrigin,fetch:transport as typeof fetch,onProgress:value=>progress.push(value)});
 assert.equal(result.upload.status,'verifying');assert.deepEqual(parts.map(part=>part.bytes),[3,3,2]);assert.deepEqual(progress,[0,3,6,8,8]);assert.equal(calls.filter(call=>call.url.endsWith('/start')).length,1);assert.equal(calls.filter(call=>call.url.endsWith('/complete')).length,1);assert(!('verified'in result));
});
test('manual resume verifies committed bytes before sending only the remainder',async()=>{
 const parts=[{partNumber:1,bytes:3,sha256:createHash('sha256').update('abc').digest('hex')}],sent:number[]=[];let phase='uploading';
 const transport=async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);if(url.includes('/parts/')){const partNumber=Number(url.split('/').at(-1));sent.push(partNumber);const part={partNumber,bytes:(init?.body as Blob).size,sha256:hash};parts.push(part);return response(part);}if(url.endsWith('/complete'))phase='verifying';assert(!url.endsWith('/start'));return response(status(phase,parts));};
 const file=new Blob(['abcdefgh']);file.arrayBuffer=async()=>{throw Error('The whole file must not be buffered to resume.');};
 await uploadStorageFile(file,ticket,{gatewayOrigin,fetch:transport as typeof fetch});assert.deepEqual(sent,[2,3]);
});
test('same-size wrong files cannot resume or fill an earlier gap before a later receipt mismatch',async()=>{
 for(const {partNumber,original,replacement}of [{partNumber:1,original:'abc',replacement:'XYZdefgh'},{partNumber:2,original:'def',replacement:'abcXYZgh'}]){
  let puts=0,completes=0;
  const parts=[{partNumber,bytes:3,sha256:createHash('sha256').update(original).digest('hex')}];
  const transport=async(input:RequestInfo|URL)=>{const url=String(input);if(url.includes('/parts/'))puts++;if(url.endsWith('/complete'))completes++;return response(status('uploading',parts));};
  await assert.rejects(uploadStorageFile(new Blob([replacement]),ticket,{gatewayOrigin,fetch:transport as typeof fetch}),/differs from the bytes already uploaded/);
  assert.equal(puts,0,'No remaining part may be written before every old part matches.');assert.equal(completes,0);
 }
});
test('a same-size wrong final file cannot complete when every part was already committed',async()=>{
 let posts=0;const parts=['abc','def','gh'].map((value,index)=>({partNumber:index+1,bytes:value.length,sha256:createHash('sha256').update(value).digest('hex')}));
 const transport=async(_input:RequestInfo|URL,init?:RequestInit)=>{if(init?.method!=='GET')posts++;return response(status('uploading',parts));};
 await assert.rejects(uploadStorageFile(new Blob(['abcdefgh'.replace('h','!')]),ticket,{gatewayOrigin,fetch:transport as typeof fetch}),/differs from the bytes already uploaded/);assert.equal(posts,0);
});
test('an uncertain multipart request is never automatically retried or completed',async()=>{
 let puts=0,completes=0;const transport=async(input:RequestInfo|URL)=>{const url=String(input);if(url.includes('/parts/')){puts++;throw Error('Synthetic lost response');}if(url.endsWith('/complete'))completes++;return response(status());};
 await assert.rejects(uploadStorageFile(new Blob(['abcdefgh']),ticket,{gatewayOrigin,fetch:transport as typeof fetch}),/lost response/);assert.equal(puts,1);assert.equal(completes,0);
});
test('expired or foreign-origin access is rejected before a bearer leaves the client',async()=>{
 let calls=0;const transport=async()=>{calls++;return response(status());};
 await assert.rejects(readStorageUpload({...ticket,baseUrl:'https://other.example.test/upload'},{gatewayOrigin,fetch:transport as typeof fetch}),/address is invalid/);
 await assert.rejects(readStorageUpload({...ticket,expiresAt:new Date(0).toISOString()},{gatewayOrigin,fetch:transport as typeof fetch}),/expired/);
 assert.equal(calls,0);
});
test('expired upload access renews the same session before reading and leaves the original ticket unchanged',async()=>{
 const original={...ticket,expiresAt:new Date(0).toISOString()},renewed={...ticket,token:'stg_renewed',expiresAt:new Date(Date.now()+7200000).toISOString()},order:string[]=[];let published:StorageUploadTicket|undefined;
 const result=await readStorageUpload(original,{gatewayOrigin,renew:async current=>{assert.deepEqual(current,original);order.push('renew');return renewed;},onRenew:value=>{published=value;},fetch:(async(_input,init)=>{order.push('read');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer stg_renewed');return response(status());})as typeof fetch});
 assert.deepEqual(order,['renew','read']);assert.equal(result.upload.id,ticket.id);assert.deepEqual(published,renewed);assert.equal(original.token,ticket.token);assert.equal(original.expiresAt,new Date(0).toISOString());
});
test('a capability nearing expiry between parts renews before the next part without restarting the upload',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const original={...ticket,expiresAt:new Date(now+70000).toISOString()},parts:{partNumber:number;bytes:number;sha256:string}[]=[],order:string[]=[];let phase='uploading',renewals=0;
 const transport=async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input),auth=new Headers(init?.headers).get('authorization');if(url.includes('/parts/')){const partNumber=Number(url.split('/').at(-1));order.push('part'+partNumber);assert.equal(auth,partNumber===1?'Bearer stg_fixture':'Bearer stg_renewed');const part={partNumber,bytes:(init?.body as Blob).size,sha256:hash};parts.push(part);if(partNumber===1)now+=20000;return response(part);}if(url.endsWith('/complete')){order.push('complete');phase='verifying';assert.equal(auth,'Bearer stg_renewed');}assert(!url.endsWith('/start'));return response(status(phase,parts));};
 const result=await uploadStorageFile(new Blob(['abcdefgh']),original,{gatewayOrigin,fetch:transport as typeof fetch,renew:async current=>{renewals++;assert.equal(current.id,original.id);order.push('renew');return {...current,token:'stg_renewed',expiresAt:new Date(now+7200000).toISOString()};}});
 assert.deepEqual(order,['part1','renew','part2','part3','complete']);assert.equal(renewals,1);assert.equal(result.upload.status,'verifying');
});
test('renewal denial or changed upload identity stops before any gateway request',async()=>{
 const expired={...ticket,expiresAt:new Date(0).toISOString()};let calls=0,published=0;const transport=(async()=>{calls++;return response(status());})as typeof fetch;
 await assert.rejects(readStorageUpload(expired,{gatewayOrigin,fetch:transport,renew:async()=>{throw Error('Storage access was revoked');}}),/revoked/);
 for(const change of [{id:'another-upload'},{versionId:'another-version'},{baseUrl:gatewayOrigin+'/v1/uploads/another-upload'},{partBytes:4},{totalBytes:9}])await assert.rejects(readStorageUpload(expired,{gatewayOrigin,fetch:transport,renew:async()=>({...ticket,...change,expiresAt:new Date(Date.now()+7200000).toISOString()}),onRenew:()=>{published++;}}),/different file details/);
 assert.equal(calls,0);assert.equal(published,0);
});
test('a gateway failure is not retried or treated as a reason to renew and replay a write',async()=>{
 let puts=0,renewals=0,completes=0;const current={...ticket,expiresAt:new Date(Date.now()+7200000).toISOString()};
 const transport=async(input:RequestInfo|URL)=>{const url=String(input);if(url.includes('/parts/')){puts++;return response({error:'The write outcome is uncertain.'},502);}if(url.endsWith('/complete'))completes++;return response(status());};
 await assert.rejects(uploadStorageFile(new Blob(['abcdefgh']),current,{gatewayOrigin,fetch:transport as typeof fetch,renew:async()=>{renewals++;return current;}}),/uncertain/);assert.equal(puts,1);assert.equal(renewals,0);assert.equal(completes,0);
});
test('invalid renewed capabilities never publish access or send a gateway request',async()=>{
 const expired={...ticket,expiresAt:new Date(0).toISOString()};let requests=0,published=0;
 for(const change of [{baseUrl:'https://foreign.example.test/v1/uploads/fixture-upload'},{expiresAt:'invalid'},{expiresAt:new Date(0).toISOString()},{token:''}]){
  await assert.rejects(readStorageUpload(expired,{gatewayOrigin,renew:async()=>({...ticket,...change}),onRenew:()=>{published++;},fetch:(async()=>{requests++;return response(status());})as typeof fetch}),/invalid|expired/);
 }
 assert.equal(requests,0);assert.equal(published,0);
});
test('pausing during renewal stops before sending or publishing the new capability',async()=>{
 const expired={...ticket,expiresAt:new Date(0).toISOString()},controller=new AbortController();let requests=0,published=0;
 await assert.rejects(readStorageUpload(expired,{gatewayOrigin,signal:controller.signal,renew:async()=>{controller.abort();return {...ticket,token:'stg_renewed',expiresAt:new Date(Date.now()+7200000).toISOString()};},onRenew:()=>{published++;},fetch:(async()=>{requests++;return response(status());})as typeof fetch}),{name:'AbortError'});
 assert.equal(requests,0);assert.equal(published,0);
});
test('explicit cancellation renews once and sends only the intended cancellation',async()=>{
 const expired={...ticket,expiresAt:new Date(0).toISOString()},calls:string[]=[];let renewals=0;
 await cancelStorageUpload(expired,{gatewayOrigin,renew:async()=>{renewals++;return {...ticket,token:'stg_cancel',expiresAt:new Date(Date.now()+7200000).toISOString()};},fetch:(async(input,init)=>{calls.push(String(input));assert.equal(init?.method,'POST');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer stg_cancel');return response(status('cancelled'));})as typeof fetch});
 assert.equal(renewals,1);assert.deepEqual(calls,[ticket.baseUrl+'/cancel']);
});
test('ready without verified complete-byte evidence and malformed part receipts fail closed',async()=>{
 await assert.rejects(readStorageUpload(ticket,{gatewayOrigin,fetch:(async()=>response(status('ready',[{partNumber:1,bytes:3,sha256:hash},{partNumber:2,bytes:3,sha256:hash},{partNumber:3,bytes:2,sha256:hash}]))) as typeof fetch}),/verified file receipt/);
 await assert.rejects(readStorageUpload(ticket,{gatewayOrigin,fetch:(async()=>response(status('uploading',[{partNumber:1,bytes:4,sha256:hash}]))) as typeof fetch}),/not confirmed/);
 const ready={...status('ready',[{partNumber:1,bytes:3,sha256:hash},{partNumber:2,bytes:3,sha256:hash},{partNumber:3,bytes:2,sha256:hash}]),verified:{bytes:8,sha256:hash}};assert.equal((await readStorageUpload(ticket,{gatewayOrigin,fetch:(async()=>response(ready))as typeof fetch})).verified?.bytes,8);
});
test('cancellation is explicit and does not reuse browser or provider cookies',async()=>{
 let called=false;await cancelStorageUpload(ticket,{gatewayOrigin,fetch:(async(input,init)=>{called=true;assert.equal(String(input),ticket.baseUrl+'/cancel');assert.equal(init?.method,'POST');assert.equal(init?.body,'{}');assert.equal(init?.credentials,'omit');return response(status('cancelled'));})as typeof fetch});assert(called);
});
const access:StorageDownloadAccess={url:gatewayOrigin+'/v1/files/version',headers:{Authorization:'Bearer stg_fixture'},expiresAt:ticket.expiresAt,bytes:8,name:'reference.bin',sha256:hash};
test('streamed downloads await each disk write and close only after all expected bytes arrive',async()=>{
 const written:number[]=[];let closed=false,aborted=false;const target:StorageSaveTarget={async write(chunk){written.push(chunk.byteLength);await new Promise(resolve=>setTimeout(resolve,1));},async close(){closed=true;},async abort(){aborted=true;}};
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1,2,3]));controller.enqueue(new Uint8Array([4,5,6,7,8]));controller.close();}});
 const result=await downloadStorageFile(access,target,{gatewayOrigin,fetch:(async(_input,init)=>{assert.equal(init?.credentials,'omit');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer stg_fixture');return new Response(stream,{headers:{'Content-Length':'8'}});})as typeof fetch});
 assert.deepEqual(written,[3,5]);assert.equal(result.blob,null);assert.equal(result.bytes,8);assert(closed);assert(!aborted);
});
test('short and oversized downloads abort the file writer instead of marking a saved file',async()=>{
 for(const length of [7,9]){let closed=false,aborted=false;const target:StorageSaveTarget={async write(){},async close(){closed=true;},async abort(){aborted=true;}};
  await assert.rejects(downloadStorageFile(access,target,{gatewayOrigin,fetch:(async()=>new Response(new Uint8Array(length)))as typeof fetch}),/expected file size|complete file/);assert(aborted);assert(!closed);}
});
test('large unsupported browser downloads refuse before fetching, while bounded files produce a download Blob',async()=>{
 let fetched=0;const transport=(async()=>{fetched++;return new Response(new Uint8Array(8));})as typeof fetch;
 await assert.rejects(downloadStorageFile({...access,bytes:STORAGE_BROWSER_BLOB_LIMIT+1},null,{gatewayOrigin,fetch:transport}),/cannot save this large file/);assert.equal(fetched,0);
 const result=await downloadStorageFile(access,null,{gatewayOrigin,fetch:transport});assert.equal(result.blob?.size,8);assert.equal(fetched,1);
});
