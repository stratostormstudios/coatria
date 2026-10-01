/** Whole processor -> metadata HTTP -> relational control -> byte HTTP -> signed
 * SDK pipeline. Actual local decoding, synthetic S3 transport and enrollment.
 * This proves composition, not a deployed/qualified Linux host or live storage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {mkdtemp,mkdir,readdir,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {openImagePreparationServiceDatabase,imagePreparationServiceFixture} from './fixtures/image-preparation-service';
import {createImagePreparationControlService} from '../src/lib/project-image-preparation-service';
import {createProjectImagePreparationServiceHttpHandler} from '../src/lib/project-image-preparation-service-http';
import {createImagePreparationByteGateway} from '../src/lib/project-image-preparation-byte-gateway';
import {createImagePreparationServiceClient} from '../src/lib/project-image-preparation-service-client';
import {createProjectImagePreparationWorkerCore} from '../src/lib/project-image-preparation-worker-core';
import {prepareReferenceImage} from '../src/lib/higgsfield-image-preparation';
import {resolveProjectImagePreparationProcessor} from '../src/lib/project-image-preparation-service-authority';

const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function png(){
 const ihdr=Buffer.alloc(13),rows=Buffer.alloc(16*(16*4+1));ihdr.writeUInt32BE(16);ihdr.writeUInt32BE(16,4);ihdr[8]=8;ihdr[9]=6;
 for(let y=0;y<16;y++)for(let x=0;x<16;x++){const i=y*65+x*4+1;rows[i]=x*16;rows[i+1]=y*16;rows[i+2]=100;rows[i+3]=255;}
 const chunk=(name:string,data:Buffer)=>{const length=Buffer.alloc(4),type=Buffer.from(name),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([length,type,data,crc]);};
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('tEXt',Buffer.from('Comment\0synthetic confidential source metadata')),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

test('hosted preparation composition processes pixels through both private HTTP boundaries',{timeout:120000},async t=>{
 const database=await openImagePreparationServiceDatabase(),previousFetch=globalThis.fetch,previousKeyring=process.env.COATRIA_HOSTING_KEYRING;
 const scratch=await realpath(await mkdtemp(join(tmpdir(),'coatria-hosted-preparation-'))),ffmpegPath=await realpath(process.env.COATRIA_TEST_FFMPEG_PATH??'C:/Users/pecem/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe');
 const native={nativeTestMode:true as const,ffmpegPath,ffmpegSha256:hash(await readFile(ffmpegPath))};
 try{
  for(const scenario of ['success','lost-initiation-response','changed-readback'] as const)await t.test(scenario,async()=>{
   const original=png(),f=await database.tx(db=>imagePreparationServiceFixture(db,{sourceBytes:original}));process.env.COATRIA_HOSTING_KEYRING=f.storageKeyring;
   await database.tx(db=>f.approve(db));
   const processor=await database.tx(db=>resolveProjectImagePreparationProcessor(db,f.companyId,f.projectId,f.serviceId));assert(processor);
   const root=join(scratch,f.companyId);await mkdir(root);
   const service=createImagePreparationControlService({transaction:database.tx}),http=createProjectImagePreparationServiceHttpHandler({origin:'https://coatria.com',execute:service.execute});
   const gateway=createImagePreparationByteGateway({transaction:database.tx,identity:{version:1,companyId:f.companyId,projectIds:[f.projectId],provisionId:f.gateway.provisionId,configurationHash:f.gateway.configurationHash,sourceCommit:'b'.repeat(40),expiresAt:f.gateway.expiresAt}});
   const sdkCalls:string[]=[],metadataBodies:string[]=[],byteTokens:string[]=[];let stored:Buffer|undefined,derivativeId:string|undefined,transforms=0;
   const object=(bytes:Buffer,etag:string)=>new Response(new Uint8Array(bytes),{headers:{'content-type':'image/png','content-length':String(bytes.length),etag}});
   globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://s3api-us-ca-2.runpod.io');
    assert.ok(url.pathname.startsWith('/synthetic-volume/coatria/companies/'+f.companyId+'/projects/'+f.projectId+'/objects/'));
    assert.match(new Headers(init?.headers).get('authorization')!,/^AWS4-HMAC-SHA256 /);assert.equal(init?.redirect,'error');
    const id=url.pathname.split('/').at(-1)!,operation=init?.method==='GET'?id===f.versionId?'read-source':'read-output':url.searchParams.has('uploads')?'initiate':init?.method==='PUT'?'part':'complete';sdkCalls.push(operation);
    if(operation==='read-source')return object(original,'synthetic-source-etag');
    assert.notEqual(id,f.versionId);derivativeId=id;
    if(operation==='initiate'){
     if(scenario==='lost-initiation-response')throw Error('Synthetic provider lost response; no network fallback.');
     return new Response(`<InitiateMultipartUploadResult><Bucket>synthetic-volume</Bucket><Key>${url.pathname.slice('/synthetic-volume/'.length)}</Key><UploadId>private-upload-id</UploadId></InitiateMultipartUploadResult>`,{headers:{'content-type':'application/xml'}});
    }
    if(operation==='part'){stored=Buffer.from(await new Response(init?.body).arrayBuffer());return new Response(null,{headers:{etag:'private-part-etag'}});}
    if(operation==='complete')return new Response(`<CompleteMultipartUploadResult><Bucket>synthetic-volume</Bucket><Key>${url.pathname.slice('/synthetic-volume/'.length)}</Key><ETag>stored-etag</ETag></CompleteMultipartUploadResult>`,{headers:{'content-type':'application/xml'}});
    assert(stored);const bytes=Buffer.from(stored);if(scenario==='changed-readback')bytes[bytes.length-1]^=1;return object(bytes,'stored-etag');
   };
   const transport:typeof fetch=async(input,init)=>{
    const url=String(input),request=new Request(url,init);
    if(url.startsWith('https://coatria.com/')){
     assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+f.token);metadataBodies.push(String(init?.body));return http(request);
    }
    assert.ok(url.startsWith(f.gateway.origin+'/v1/image-preparations/capabilities/'));const token=new Headers(init?.headers).get('authorization')!;assert.match(token,/^Bearer ipt_/);byteTokens.push(token.slice(7));return gateway.handle(request);
   };
   const client=createImagePreparationServiceClient({origin:'https://coatria.com',serviceId:f.serviceId,companyId:f.companyId,projectIds:[f.projectId],gateways:[{projectId:f.projectId,origin:f.gateway.origin}],token:f.token,expiresAt:f.enrollment.expiresAt,processor},{fetch:transport});
   const worker=createProjectImagePreparationWorkerCore({scope:{companyId:f.companyId,projectIds:[f.projectId]},scratchRoot:root,createPorts:()=>client,transform:async(input,context)=>{
    transforms++;assert.doesNotMatch(JSON.stringify(context),/private-upload-id|rps_|accessKey|secretAccess|objectKey/);return prepareReferenceImage(input,native);
   }});
   try{
    await client.readiness();const result=await worker.runNext();assert.equal(result.status,scenario==='success'?'ready':'uncertain',JSON.stringify(result));assert.equal(transforms,1);
    const rows=await database.db.query('SELECT p.status,p.cleanup_confirmed_at,(SELECT count(*)::int FROM project_image_preparation_derivations d WHERE d.preparation_id=p.id) AS derivations FROM project_image_preparations p WHERE p.id=$1',[f.proposed!.id]);
    assert.equal(rows.rows[0].derivations,scenario==='success'?1:0);assert.deepEqual(await readdir(root),[]);
    if(scenario==='success'){
     assert(stored);assert.notEqual(derivativeId,f.versionId);assert.ok(!stored.includes(Buffer.from('confidential')));assert.deepEqual(sdkCalls,['read-source','initiate','part','complete','read-output']);assert.ok(rows.rows[0].cleanup_confirmed_at);
    }else{
     assert.equal(rows.rows[0].cleanup_confirmed_at,null);assert.equal(sdkCalls.filter(op=>op==='initiate').length,1);
     assert.equal((await database.db.query("SELECT count(*)::int AS n FROM project_image_preparation_byte_results r JOIN project_image_preparation_byte_grants g ON g.id=r.grant_id WHERE g.preparation_id=$1 AND r.status='started'",[f.proposed!.id])).rows[0].n,1);
    }
    for(const body of metadataBodies)assert.doesNotMatch(body,/base64|objectKey|private-upload-id|private-part-etag|rps_|secretAccess|synthetic confidential/);
    const persisted=JSON.stringify((await database.db.query('SELECT response FROM project_image_preparation_service_calls WHERE service_id=$1',[f.serviceId])).rows);
    for(const token of byteTokens)assert.ok(!persisted.includes(token));assert.ok(!persisted.includes(f.token));
    const source=(await database.db.query('SELECT bytes,sha256 FROM project_storage_versions WHERE id=$1',[f.versionId])).rows[0];assert.equal(Number(source.bytes),original.length);assert.equal(source.sha256,hash(original));
   }finally{client.close();gateway.close();await client.drain();await gateway.drain();}
  });
 }finally{
  globalThis.fetch=previousFetch;if(previousKeyring===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=previousKeyring;
  await database.close();const resolved=resolve(scratch),parent=resolve(tmpdir());assert.ok(resolved.startsWith(parent+sep));assert.ok(resolved.split(sep).at(-1)!.startsWith('coatria-hosted-preparation-'));await rm(resolved,{recursive:true,force:false});
 }
});
