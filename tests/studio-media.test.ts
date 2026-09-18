import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken,errorResponse} from '../src/lib/security';
import {setupStudio,createStudioProject} from '../src/lib/studio';
import {handleApi} from '../src/lib/api';
import {createStudioMediaProvider,studioMediaRoute,verifyStudioMediaBytes,canonicalStudioMedia,type StudioMediaProvider} from '../src/lib/studio-media';
import {STUDIO_MEDIA_MAX_FILE_BYTES,studioMediaUploadInput} from '../src/lib/studio-media-protocol';
import {EXECUTION_BUILTIN_PROFILES} from '../src/lib/studio-execution-protocol';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const pathname=()=>`studio/${randomUUID()}/${randomUUID()}/${'a'.repeat(64)}/${randomUUID()}.exr`;
const stream=(bytes:Uint8Array)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
test('private Blob signatures authorize only one path, operation, size and write-once upload',async()=>{
 const issued:any[]=[],signed:any[]=[],read:any[]=[];
 const sdk={issueSignedToken:async(input:unknown)=>{issued.push(input);return {delegationToken:'fixture',clientSigningToken:'fixture'};},presignUrl:async(_token:unknown,input:unknown)=>{signed.push(input);return {presignedUrl:'https://fixture.invalid/scoped'};},get:async(path:string,options:unknown)=>{read.push({path,options});return {statusCode:200,stream:stream(Buffer.from('ok')),headers:new Headers({'content-length':'2'}),blob:{size:2,etag:'immutable-etag'}};}};
 const provider=createStudioMediaProvider(sdk as never),path=pathname(),expiresAt=Date.now()+300000;
 await provider.signUpload(path,2,'image/x-exr',expiresAt);assert.deepEqual(issued[0].operations,['put']);assert.equal(issued[0].pathname,path);assert.equal(issued[0].maximumSizeInBytes,2);
 assert.equal(signed[0].access,'private');assert.equal(signed[0].allowOverwrite,false);assert.equal(signed[0].addRandomSuffix,false);assert.equal(signed[0].maximumSizeInBytes,2);assert.equal(signed[0].pathname,path);assert.deepEqual(signed[0].allowedContentTypes,['image/x-exr']);
 await provider.read(path,AbortSignal.timeout(1000));assert.equal(read[0].path,path);assert.equal(read[0].options.access,'private');assert.equal(read[0].options.useCache,false);assert.equal(read[0].options.headers['Accept-Encoding'],'identity');
 await provider.signRead(path,expiresAt);assert.deepEqual(issued[1].operations,['get']);assert.equal(signed[1].access,'private');assert.equal(signed[1].operation,'get');assert.equal(signed[1].pathname,path);
 for(const bad of['https://untrusted.invalid/a','../private',path+'?other=x'])await assert.rejects(()=>provider.signRead(bad,expiresAt));
 await assert.rejects(()=>provider.signUpload(path,STUDIO_MEDIA_MAX_FILE_BYTES+1,'image/x-exr',expiresAt));assert.equal(issued.length,2);
 assert.equal(studioMediaUploadInput.safeParse({clientId:randomUUID(),path:'../escape'}).success,false);assert.equal(studioMediaUploadInput.safeParse({clientId:randomUUID(),path:'scene.blend',url:'https://attacker.invalid'}).success,false);
});
test('compressed or chunked Blob responses verify the actual decoded file length and checksum',async()=>{
 const bytes=Buffer.from('a compressible native scene or JSON report'.repeat(100)),expected={bytes:bytes.length,sha256:sha(bytes)},path=pathname();
 const provider=(headers:HeadersInit,actual=bytes)=>createStudioMediaProvider({get:async()=>({statusCode:200,headers:new Headers(headers),stream:stream(actual),blob:{size:Number(new Headers(headers).get('content-length')||0),etag:'immutable-etag'}})} as never);
 const headerCases:HeadersInit[]=[{}, {'content-encoding':'gzip','content-length':'96'}, {'content-encoding':'br'}, {'content-encoding':'identity','content-length':String(bytes.length)}];
 for(const headers of headerCases){
  assert.equal((await verifyStudioMediaBytes(provider(headers),path,expected)).bytes,bytes.length);
  await assert.rejects(()=>verifyStudioMediaBytes(provider(headers,Buffer.alloc(bytes.length)),path,expected),{status:409});
  await assert.rejects(()=>verifyStudioMediaBytes(provider(headers,bytes.subarray(1)),path,expected),{status:409});
  await assert.rejects(()=>verifyStudioMediaBytes(provider(headers,Buffer.concat([bytes,bytes])),path,expected),{status:409});
 }
 await assert.rejects(()=>verifyStudioMediaBytes(provider({'content-length':'96'}),path,expected),{status:409});
});
test('verification reads actual bounded bytes and rejects false sizes, digests, truncation and cancellation',async()=>{
 const bytes=Buffer.from('stored output bytes'),expected={bytes:bytes.length,sha256:sha(bytes)},path=pathname();
 const provider=(actual:Uint8Array,size=actual.length):StudioMediaProvider=>({signUpload:async()=>'',signRead:async()=>'',read:async()=>({stream:stream(actual),bytes:size,etag:'etag'})});
 assert.equal((await verifyStudioMediaBytes(provider(bytes),path,expected)).sha256,expected.sha256);
 for(const candidate of[provider(Buffer.from('different bytes....'),bytes.length),provider(bytes,bytes.length+1),provider(bytes.subarray(1),bytes.length),provider(Buffer.concat([bytes,bytes]),bytes.length)])await assert.rejects(()=>verifyStudioMediaBytes(candidate,path,expected),{status:409});
 await assert.rejects(()=>verifyStudioMediaBytes(provider(bytes),path,{...expected,bytes:STUDIO_MEDIA_MAX_FILE_BYTES+1}),{status:413});
 let cancelled=false;const controller=new AbortController(),hung:StudioMediaProvider={...provider(bytes),read:async()=>({bytes:bytes.length,etag:'etag',stream:new ReadableStream({pull(){controller.abort();},cancel(){cancelled=true;}})})};
 await assert.rejects(()=>verifyStudioMediaBytes(hung,path,expected,controller.signal));assert.equal(cancelled,true);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',connection=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('private media APIs bind exact completed output, immutable verification and reviewed sequence promotion',{skip:!emulate&&!connection,timeout:180000},async t=>{
 process.env.DATABASE_URL=connection;process.env.DATABASE_POOL_MAX='4';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const{PGlite}=await import('@electric-sql/pglite');const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:4});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stop=async()=>{await server.stop();await db.close();};}
 const companies=[randomUUID(),randomUUID()],users={owner:randomUUID(),operator:randomUUID(),reviewer:randomUUID(),member:randomUUID(),outsider:randomUUID()},sessions=Object.fromEntries(Object.keys(users).map(key=>[key,randomUUID()])),origin='http://localhost:4180';
 const spec={width:128,height:128,fpsNumerator:24000,fpsDenominator:1001,format:'exr',colorSpace:'Linear Rec.709'},profile=EXECUTION_BUILTIN_PROFILES[0];
 const source=new Map([['frames/0001.exr',Buffer.from('synthetic-frame-one')],['frames/0002.exr',Buffer.from('synthetic-frame-two')],['scene.blend',Buffer.from('synthetic-native-scene')],['preview.png',Buffer.from('synthetic-preview')]]);
 const files=[...source].map(([path,bytes],index)=>({path,kind:index<2?'image':index===2?'scene':'media',...(index<2?{frame:index+1}:{}),sha256:sha(bytes),bytes:bytes.length}));
 files.push({path:'oversized.blend',kind:'scene',sha256:'f'.repeat(64),bytes:STUDIO_MEDIA_MAX_FILE_BYTES+1});
 const manifest={schemaVersion:1,spec,engineVersion:'synthetic-fixture',verification:{fileHashes:true,fileSizes:true,frameCoverage:true,imageMetadata:true},files};
 const blobs=new Map<string,Uint8Array>(),signed:string[]=[],readPaths:string[]=[];let revokeOnRead=false;
 const provider:StudioMediaProvider={signUpload:async(path)=>{signed.push(path);return 'https://fixture.invalid/put?signature=temporary';},signRead:async(path)=>{signed.push(path);return 'https://fixture.invalid/get?signature=temporary';},read:async(path)=>{readPaths.push(path);if(revokeOnRead)await query("UPDATE studio_execution_connectors SET status='paused' WHERE id=$1",[connectorId]);const bytes=blobs.get(path);return bytes?{stream:stream(bytes),bytes:bytes.length,etag:'immutable-'+sha(bytes)}:null;}};
 let projectId='',workItemId='',jobId='',secondJobId='',connectorId='',token='',foreignToken='';const prefix=()=>`companies/${companies[0]}/studio`,jobPath=()=>`${prefix()}/execution/jobs/${jobId}/media`,workerPath=()=>`execution/jobs/${jobId}/media`;
 async function call(path:string,method='GET',payload?:unknown,actor='owner',expected=200,raw=false){const headers:Record<string,string>=actor==='worker'||actor==='foreignWorker'?{Authorization:'Bearer '+(actor==='worker'?token:foreignToken)}:{Cookie:'coatria_session='+sessions[actor],Origin:origin};if(payload!==undefined)headers['Content-Type']='application/json';const request=new Request(origin+'/api/'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)});let response:Response;try{response=await studioMediaRoute(request,path.split('?')[0].split('/'),method,provider)??await handleApi(request,path.split('?')[0].split('/'));}catch(error){response=errorResponse(error);}const text=await response.text();assert.equal(response.status,expected,`${method} ${path}: ${text}`);return raw?{text,headers:response.headers}:JSON.parse(text);}
 const upload=(path:string,clientId=randomUUID(),actor='worker',expected=200)=>call(workerPath()+'/upload','POST',{clientId,path},actor,expected);
 const verify=(fileId:string,clientId=randomUUID(),actor='worker',expected=200)=>call(workerPath()+'/verify','POST',{clientId,fileId},actor,expected);
 const promote=(extra:Row={},expected=200)=>call(jobPath()+'/promote','POST',{clientId:randomUUID(),revision:1,name:'Verified render sequence',...extra},'reviewer',expected);
 type Row=Record<string,any>;
 try{
  for(const[key,userId]of Object.entries(users)){await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,key,userId+'@example.invalid','fixture']);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[key]),userId]);}
  for(const companyId of companies)await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Media fixture',$2,'blank')",[companyId,companyId]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'admin'),($1,$5,'member'),($6,$7,'owner')",[companies[0],users.owner,users.operator,users.reviewer,users.member,companies[1],users.outsider]);
  await transaction(async client=>{const actor={companyId:companies[0],userId:users.owner};await setupStudio(client,actor,{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:0,assignments:[]});const made=await createStudioProject(client,actor,{clientId:randomUUID(),name:'Media fixture project',clientName:'Synthetic client',brief:'A two-frame synthetic hash-verification fixture.',spec,aiPolicy:'allowed',shots:[{code:'SH010',description:'Fixture.',frameStart:1,frameEnd:2,handles:0,disciplines:['compositing']}]});projectId=made.project.id;});
  workItemId=(await query("SELECT id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND execution='dcc'",[companies[0],projectId])).rows[0].id;
  await query("UPDATE tasks SET status='done' WHERE id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage IN ('estimate','breakdown','ingest'))",[companies[0],projectId]);
  await query('UPDATE studio_projects SET gates=$3 WHERE company_id=$1 AND id=$2',[companies[0],projectId,JSON.stringify({brief:{decision:'approved'},production:{decision:'approved'}})]);
  const installed=await call(`${prefix()}/execution/connectors`,'POST',{clientId:randomUUID(),name:'Private media fixture',profiles:[profile]},'operator',201);connectorId=installed.connector.id;token=installed.token;
  foreignToken=(await call(`companies/${companies[1]}/studio/execution/connectors`,'POST',{clientId:randomUUID(),name:'Other company connector',profiles:[profile]},'outsider',201)).token;
  for(let index=0;index<2;index++){const made=(await query("INSERT INTO studio_execution_jobs(company_id,project_id,work_item_id,connector_id,requested_by,approved_by,profile,spec,input_snapshot,frame_start,frame_end,output_kind,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]',1,2,'image_sequence','succeeded') RETURNING id",[companies[0],projectId,workItemId,connectorId,users.owner,users.reviewer,JSON.stringify(profile),JSON.stringify(spec)])).rows[0];await query('INSERT INTO studio_execution_manifests(company_id,job_id,connector_id,manifest,manifest_hash) VALUES($1,$2,$3,$4,$5)',[companies[0],made.id,connectorId,JSON.stringify(manifest),hashToken(canonicalStudioMedia(manifest))]);if(index===0)jobId=made.id;else secondJobId=made.id;}
  await t.test('uploads accept only the owning connector, completed exact files and bounded immutable paths',async()=>{
   await upload('frames/0001.exr',randomUUID(),'foreignWorker',404);await upload('unknown.exr',randomUUID(),'worker',404);await upload('oversized.blend',randomUUID(),'worker',413);
   await query("UPDATE studio_execution_jobs SET status='failed' WHERE id=$1",[jobId]);await upload('frames/0001.exr',randomUUID(),'worker',409);await query("UPDATE studio_execution_jobs SET status='succeeded' WHERE id=$1",[jobId]);
   const request=randomUUID(),first=await upload('frames/0001.exr',request),again=await upload('frames/0001.exr',request);assert.equal(first.file.id,again.file.id);assert.equal(again.replayed,true);assert.equal(first.file.verifiedState,'awaiting_upload_or_verification');assert.equal(first.upload.method,'PUT');assert.deepEqual(first.upload.headers,{'Content-Type':'image/x-exr','x-content-type':'image/x-exr'});assert(!JSON.stringify(first.file).includes('blob_pathname'));
   await upload('frames/0002.exr',request,'worker',409);assert.equal((await query('SELECT count(*)::int AS count FROM studio_media_files WHERE job_id=$1',[jobId])).rows[0].count,1);
   await call(`${prefix()}/media/${first.file.id}`,'GET',undefined,'member',409);await call(`companies/${companies[1]}/studio/media/${first.file.id}`,'GET',undefined,'outsider',404);
   const receipts=JSON.stringify((await query('SELECT response FROM studio_media_requests WHERE company_id=$1',[companies[0]])).rows);assert(!receipts.includes('signature'));assert(!receipts.includes('fixture.invalid'));assert(!receipts.includes(token));
  });
  await t.test('wrong bytes and revoked authority never gain a verification receipt; exact verification replays',async()=>{
   const prepared=await upload('frames/0001.exr'),path=(await query('SELECT blob_pathname FROM studio_media_files WHERE id=$1',[prepared.file.id])).rows[0].blob_pathname;
   await verify(prepared.file.id,randomUUID(),'worker',409);blobs.set(path,Buffer.from('wrong'));await verify(prepared.file.id,randomUUID(),'worker',409);
   blobs.set(path,source.get('frames/0001.exr')!);revokeOnRead=true;await verify(prepared.file.id,randomUUID(),'worker',401);revokeOnRead=false;assert.equal((await query('SELECT count(*)::int AS count FROM studio_media_verifications WHERE file_id=$1',[prepared.file.id])).rows[0].count,0);await query("UPDATE studio_execution_connectors SET status='active' WHERE id=$1",[connectorId]);
   const request=randomUUID(),verified=await verify(prepared.file.id,request);assert.equal(verified.file.verifiedState,'verified');assert.equal(verified.file.verificationSource,'server_bytes');assert.equal(verified.file.independentlyReviewed,false);const reads=readPaths.length;assert.equal((await verify(prepared.file.id,request)).replayed,true);assert.equal(readPaths.length,reads);
   await call(`execution/jobs/${secondJobId}/media/verify`,'POST',{clientId:randomUUID(),fileId:prepared.file.id},'worker',404);
   assert.equal((await upload('frames/0001.exr')).upload,null);const access=await call(`${prefix()}/media/${prepared.file.id}`,'GET',undefined,'member');assert.match(access.access.url,/signature/);assert(Date.parse(access.access.expiresAt)-Date.now()<=60000);assert.equal((await query('SELECT count(*)::int AS count FROM studio_media_verifications WHERE file_id=$1',[prepared.file.id])).rows[0].count,1);
  });
  await t.test('all frames are required; native assets stay separate; canonical promotion preserves source producer and review fences',async()=>{
   await promote({},409);await call(jobPath()+'/promote','POST',{clientId:randomUUID(),revision:1,name:'Forbidden'},'member',403);
   for(const path of['frames/0002.exr','scene.blend','preview.png']){const prepared=await upload(path),storage=(await query('SELECT blob_pathname FROM studio_media_files WHERE id=$1',[prepared.file.id])).rows[0].blob_pathname;blobs.set(storage,source.get(path)!);await verify(prepared.file.id);}
   await promote({revision:2},409);const request=randomUUID(),result=await promote({clientId:request});assert.equal(result.artifact.reviewStatus,'pending');assert.equal(result.project.revision,2);assert.equal((await promote({clientId:request})).replayed,true);
   const stored=(await query('SELECT * FROM studio_artifacts WHERE id=$1',[result.artifact.id])).rows[0];assert.equal(stored.produced_by,users.owner);assert.notEqual(stored.produced_by,users.reviewer);assert.equal(stored.metadata.executionProvenance.connectorSponsorId,users.operator);assert.equal(stored.metadata.executionProvenance.promotedBy,users.reviewer);
   const content=await call(jobPath()+'/manifest','GET',undefined,'member',200,true);assert.equal(hashToken(content.text),stored.sha256);assert.equal(content.headers.get('X-Content-SHA256'),stored.sha256);const parsed=JSON.parse(content.text);assert.equal(parsed.frames.length,2);assert.equal(parsed.kind,'verified_image_sequence');assert(parsed.frames.every((file:Row)=>file.path.endsWith('.exr')));assert.equal(parsed.frames[0].sha256,files[0].sha256);assert(!content.text.includes('signature'));assert(!content.text.includes('blob.vercel'));
   await call(`companies/${companies[1]}/studio/execution/jobs/${jobId}/media/manifest`,'GET',undefined,'outsider',404);await promote({revision:2},409);
   const review={clientId:randomUUID(),revision:2,artifactId:result.artifact.id,decision:'approved',note:'Synthetic test review, not an actual image-quality certification.',technicalQc:true};await call(`${prefix()}/projects/${projectId}/reviews`,'POST',review,'owner',403);await call(`${prefix()}/projects/${projectId}/reviews`,'POST',{...review,clientId:randomUUID()},'operator',403);
   assert.equal((await query('SELECT count(*)::int AS count FROM studio_reviews WHERE artifact_id=$1',[result.artifact.id])).rows[0].count,0);
  });
  await t.test('member paging is complete and revocation denies short-lived access without disclosing storage paths',async()=>{
   const seen:string[]=[];let after:string|undefined;do{const page=await call(`${prefix()}/media?jobId=${jobId}&limit=2${after?'&after='+after:''}`,'GET',undefined,'member');seen.push(...page.files.map((file:Row)=>file.id));assert(!JSON.stringify(page).includes('blob_pathname'));after=page.page.nextAfter??undefined;}while(after);assert.equal(new Set(seen).size,4);
   await call(`${prefix()}/media?jobId=${jobId}&after=${randomUUID()}`,'GET',undefined,'member',404);await query('DELETE FROM memberships WHERE company_id=$1 AND user_id=$2',[companies[0],users.member]);const signedBefore=signed.length;await call(`${prefix()}/media/${seen[0]}`,'GET',undefined,'member',404);assert.equal(signed.length,signedBefore);
   const receipts=JSON.stringify((await query('SELECT response FROM studio_media_requests WHERE company_id=$1',[companies[0]])).rows);assert(!receipts.includes('signature'));assert(!receipts.includes(token));
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[Object.values(users)]);}finally{await database().end();await stop?.();}}
});
