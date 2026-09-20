import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloadGeneratedMedia} from '../src/lib/generated-media-download';
import {STORAGE_BROWSER_BLOB_LIMIT,type StorageDownloadAccess,type StorageSaveTarget} from '../src/lib/project-storage-client';
import type {StudioGeneratedArtifact} from '../src/lib/studio-protocol';

const version='00000000-0000-4000-8000-000000000001',gatewayOrigin='https://storage.example',hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fixture(value=new TextEncoder().encode('abc')){
 const artifact={file:{bytes:value.length,sha256:hash(value),contentType:'image/png'},provenance:{storageVersionId:version}} as StudioGeneratedArtifact;
 const access:StorageDownloadAccess={bytes:value.length,sha256:hash(value),contentType:'image/png',name:'fixture.png',url:gatewayOrigin+'/v1/files/'+version,headers:{Authorization:'Bearer stg_synthetic'},expiresAt:'2099-01-01T00:00:00.000Z'};
 return {artifact,access};
}
function disk(){const writes:Uint8Array[]=[],events:string[]=[];const target:StorageSaveTarget={async write(chunk){writes.push(new Uint8Array(chunk));events.push('write');},async close(){events.push('close');},async abort(){events.push('abort');}};return {writes,events,target};}
function response(parts:number[][],cancel?:()=>void){let index=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(index<parts.length)controller.enqueue(new Uint8Array(parts[index++]));else controller.close();},cancel}));}
test('correct chunked media hashes before disk close, preserving the authenticated one-request transport',async()=>{
 const {artifact,access}=fixture(),{target,writes,events}=disk();let calls=0;
 const result=await downloadGeneratedMedia(access,artifact,target,{gatewayOrigin,fetch:async(input,init)=>{calls++;assert.equal(String(input),access.url);assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.equal(init?.referrerPolicy,'no-referrer');assert.equal(new Headers(init?.headers).get('Authorization'),access.headers.Authorization);return response([[97],[98],[99]]);}});
 assert.deepEqual(writes.map(item=>[...item]),[[97],[98],[99]]);assert.deepEqual(events,['write','write','write','close']);assert.equal(calls,1);assert.equal(result.bytes,3);assert.equal(result.blob,null);
});
test('same-length tampered streamed media aborts staged disk bytes and never closes or retries',async()=>{
 const {artifact,access}=fixture(),{target,events}=disk();let calls=0;
 await assert.rejects(downloadGeneratedMedia(access,artifact,target,{gatewayOrigin,fetch:async()=>{calls++;return response([[97],[98],[100]]);}}),/checksum differs/);
 assert(events.includes('write'));assert(events.includes('abort'));assert(!events.includes('close'));assert.equal(calls,1);
});
test('same-length tampered Blob download never returns a saveable Blob',async()=>{
 const {artifact,access}=fixture();let calls=0;
 await assert.rejects(downloadGeneratedMedia(access,artifact,null,{gatewayOrigin,fetch:async()=>{calls++;return response([[97,98,100]]);}}),/checksum differs/);assert.equal(calls,1);
 const result=await downloadGeneratedMedia(access,artifact,null,{gatewayOrigin,fetch:async()=>response([[97,98],[99]])});assert.equal(await result.blob!.text(),'abc');
});
test('abort during the final disk write cannot commit a file even if the stream checksum is complete',async()=>{
 const {artifact,access}=fixture(),controller=new AbortController(),events:string[]=[];
 const target:StorageSaveTarget={async write(){events.push('write');controller.abort();},async close(){events.push('close');},async abort(){events.push('abort');}};
 await assert.rejects(downloadGeneratedMedia(access,artifact,target,{gatewayOrigin,signal:controller.signal,fetch:async()=>response([[97,98,99]])}),{name:'AbortError'});assert.deepEqual(events,['write','abort']);
});
test('abort cancels an in-flight response even when a transport ignores its fetch signal',{timeout:3000},async()=>{
 const {artifact,access}=fixture(),controller=new AbortController(),{target,events}=disk();let cancelled=false;
 const task=downloadGeneratedMedia(access,artifact,target,{gatewayOrigin,signal:controller.signal,fetch:async()=>new Response(new ReadableStream({start(){setTimeout(()=>controller.abort(),10);},cancel(){cancelled=true;}}))});
 await assert.rejects(task,{name:'AbortError'});assert(cancelled);assert(events.includes('abort'));assert(!events.includes('close'));
});
test('foreign metadata, pre-abort and the existing large-Blob ceiling refuse before fetching',async()=>{
 const {artifact,access}=fixture();let calls=0;const transport:typeof fetch=async()=>{calls++;return response([[97,98,99]]);};
 const {target,events}=disk();await assert.rejects(downloadGeneratedMedia({...access,sha256:'f'.repeat(64)},artifact,target,{gatewayOrigin,fetch:transport}),/does not match/);assert.deepEqual(events,['abort']);
 const controller=new AbortController();controller.abort();await assert.rejects(downloadGeneratedMedia(access,artifact,null,{gatewayOrigin,fetch:transport,signal:controller.signal}),{name:'AbortError'});
 const huge={...artifact,file:{...artifact.file,bytes:STORAGE_BROWSER_BLOB_LIMIT+1}};await assert.rejects(downloadGeneratedMedia({...access,bytes:huge.file.bytes},huge,null,{gatewayOrigin,fetch:transport}),/cannot save this large file/);assert.equal(calls,0);
});
test('incremental hash handles block-boundary chunks, rejects truncation and does not close early',async()=>{
 const bytes=Uint8Array.from({length:4097},(_,index)=>index%251),{artifact,access}=fixture(bytes),{target,events}=disk();
 const parts=[Array.from(bytes.slice(0,63)),Array.from(bytes.slice(63,65)),Array.from(bytes.slice(65,4096)),Array.from(bytes.slice(4096))];
 await downloadGeneratedMedia(access,artifact,target,{gatewayOrigin,fetch:async()=>response(parts)});assert.equal(events.at(-1),'close');
 const bad=disk();await assert.rejects(downloadGeneratedMedia(access,artifact,bad.target,{gatewayOrigin,fetch:async()=>response(parts.slice(0,-1))}),/checksum differs|complete file/);assert(bad.events.includes('abort'));assert(!bad.events.includes('close'));
});
