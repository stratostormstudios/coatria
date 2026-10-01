import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {database,query,transaction} from '../src/lib/db';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {inspectHiggsfieldArchiveMedia} from '../src/lib/higgsfield-media-inspection';
import {createHiggsfieldReferenceWorker} from '../src/lib/higgsfield-reference-worker';
import {createHiggsfieldReferenceUploader} from '../src/lib/higgsfield-reference-transport';
import {createDatabaseHiggsfieldReferenceBroker} from '../src/lib/higgsfield-reference-broker-db';
import {approveHiggsfieldReference,authorizeHiggsfieldReference,beginHiggsfieldReferencePhase,claimHiggsfieldReference,completeHiggsfieldReferencePhase,failHiggsfieldReference,getHiggsfieldReference,getHiggsfieldReferenceStorageContext,higgsfieldReferenceDigest,proposeHiggsfieldReference,recordHiggsfieldReferenceInspection,resolveHiggsfieldReferences,type HiggsfieldReferenceOptions} from '../src/lib/higgsfield-references';
import type {HiggsfieldTool} from '../src/lib/higgsfield-mcp';

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// Actual control plane + broker + worker + HTTP transport, with only provider
// I/O replaced. The full-decode test uses local native tools explicitly; it is
// not evidence of a qualified production host or enabled reference service.
test('prepared-image handoff joins real database fences, exact broker operations and unchanged decoded proxy bytes',{timeout:240000},async t=>{
 const before={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,fetch:globalThis.fetch};
 const dbWorker=new Worker(`const {parentPort}=require('node:worker_threads');(async()=>{const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),{readdir,readFile}=require('node:fs/promises'),db=await PGlite.create();for(const name of(await readdir('database')).filter(name=>/^\\d.*\\.sql$/.test(name)).sort())await db.exec(await readFile('database/'+name,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();parentPort.postMessage({url:'postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres'});parentPort.once('message',async()=>{await socket.stop();await db.close();parentPort.postMessage({stopped:true});parentPort.close();});})().catch(error=>{throw error;});`,{eval:true,execArgv:[]});
 const databaseUrl=await new Promise<string>((yes,no)=>{dbWorker.once('error',no);dbWorker.once('message',value=>yes(value.url));});
 process.env.DATABASE_URL=databaseUrl;process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'reference-handoff-fixture',keys:{'reference-handoff-fixture':Buffer.alloc(32,73).toString('base64')}});
 let network=0;globalThis.fetch=async()=>{network++;throw Error('Reference handoff has no live provider access');};
 const scratchRoot=await mkdtemp(join(tmpdir(),'coatria-reference-handoff-')),owner=randomUUID(),profile='a'.repeat(64),body=await readFile(resolve('tests/fixtures/media/synthetic.png')),companies:string[]=[];
 const tools:HiggsfieldTool[]=[...['generate_image','generate_video','generate_audio'].map(name=>({name,description:'synthetic generation catalog',inputSchema:{type:'object',properties:{params:{type:'object',properties:{model:{type:'string'},prompt:{type:'string'},medias:{type:'array',items:{type:'object',properties:{role:{type:'string',enum:['image','start_image','end_image']},value:{type:'string',format:'uuid'}},required:['role','value'],additionalProperties:false}}},required:['model','prompt'],additionalProperties:false}},required:['params'],additionalProperties:false}})),{name:'media_upload',description:'synthetic catalog',inputSchema:{type:'object',properties:{filename:{type:'string'},content_type:{type:'string'},method:{type:'string',enum:['upload_url']}},additionalProperties:false}},{name:'media_confirm',description:'synthetic catalog',inputSchema:{type:'object',properties:{media_id:{type:'string'},type:{type:'string',enum:['image','video','audio','file']}},required:['type'],additionalProperties:false}}];
 const options:HiggsfieldReferenceOptions={availability:async()=>({enabled:true,code:'fixture_ready',message:'Synthetic qualified fixture only',expiresAt:new Date(Date.now()+600000).toISOString(),qualificationSha256:profile,catalogSha256:higgsfieldReferenceDigest(tools)})};
 const bin=process.platform==='win32'?join(process.env.LOCALAPPDATA??'C:/Users/pecem/AppData/Local','Microsoft/WinGet/Links'):'/usr/bin';
 async function fixture(lost:'none'|'allocate'|'put'|'confirm'='none'){
  const companyId=randomUUID(),projectId=randomUUID(),taskId=randomUUID(),workItemId=randomUUID(),providerId=randomUUID(),fileId=randomUUID(),versionId=randomUUID(),mediaId=randomUUID(),actor={companyId,userId:owner};companies.push(companyId);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Reference handoff fixture',$2,'blank')",[companyId,companyId]);await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,owner]);await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,owner]);
  const gates=Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:owner}]));
  await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Prepared proxy fixture','Internal','Synthetic only',$3,'allowed','production',$4,$5,'higgsfield')",[projectId,companyId,JSON.stringify({width:16,height:16,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'}),JSON.stringify(gates),owner]);
  await query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Reference fixture task',$3)",[taskId,companyId,owner]);await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[workItemId,companyId,projectId,taskId]);await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'comp',$2)",[companyId,owner]);
  const sealed=sealHiggsfieldSecret({token:{access_token:'server-only-synthetic-credential',token_type:'Bearer'}},{companyId,id:providerId,purpose:'oauth-connection'});
  await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour',$5)",[companyId,providerId,owner,JSON.stringify(sealed),JSON.stringify(tools)]);
  const connection=(await transaction(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic source',region:'US-NC-2',volumeId:'synthetic-volume',accessKeyId:'user_fixture',secretAccessKey:'rps_fixture-storage-key'}))).connection;
  const binding=(await transaction(db=>bindProjectStorage(db,actor,projectId,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  await transaction(async db=>{await db.query("INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,'prepared.png','prepared.png',$5)",[fileId,companyId,projectId,binding.id,owner]);await db.query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,'image/png',$7,$8)",[versionId,companyId,projectId,fileId,body.length,digest(body),`coatria/companies/${companyId}/projects/${projectId}/objects/${versionId}`,owner]);await db.query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,'synthetic-etag',$6)",[companyId,projectId,versionId,body.length,digest(body),randomUUID()]);});
  const proposed=(await transaction(db=>proposeHiggsfieldReference(db,actor,{clientId:randomUUID(),projectId,projectRevision:1,workItemId,proxyVersionId:versionId,proxySha256:digest(body),proxyBytes:body.length,role:'image',purpose:'Synthetic exact proxy'}))).reference;
  const counts={allocate:0,put:0,confirm:0},uploaded:Buffer[]=[];
  const state=()=>query('SELECT * FROM higgsfield_references WHERE company_id=$1 AND id=$2',[companyId,proposed.id]).then(r=>r.rows[0]);
  const checkIntent=async(phase:string)=>{const r=await state();assert.equal(r.action_operation,phase);assert(r.action_id);assert.equal((await query("SELECT count(*)::int n FROM higgsfield_reference_receipts WHERE company_id=$1 AND reference_id=$2 AND operation=$3 AND phase='intent'",[companyId,proposed.id,phase])).rows[0].n,1);};
  // Exercise the normal encrypted credential path and official MCP client. No
  // generic callback substitutes for the database broker's real composition.
  globalThis.fetch=async(input,init)=>{
   assert.equal(String(input),'https://mcp.higgsfield.ai/mcp');assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer server-only-synthetic-credential');
   const command=JSON.parse(String(init?.body));if(command.method==='notifications/initialized')return new Response(null,{status:202});
   if(command.method==='initialize')return Response.json({jsonrpc:'2.0',id:command.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
   assert.equal(command.method,'tools/call');const {name,arguments:args}=command.params;let result:unknown;
   if(name==='media_upload'){counts.allocate++;await checkIntent('allocate');assert.deepEqual(args,{filename:`reference-${proposed.id}.png`,content_type:'image/png',method:'upload_url'});if(lost==='allocate')throw Error('synthetic allocation reply lost');result={content:[],structuredContent:{uploads:[{media_id:mediaId,content_type:'image/png',method:'PUT',expires_in_seconds:60,upload_url:'https://uploads.reviewed.example/private?signature=synthetic-private-value'}]}};}
   else{assert.equal(name,'media_confirm');counts.confirm++;await checkIntent('confirm');assert.deepEqual(args,{media_id:mediaId,type:'image'});if(lost==='confirm')throw Error('synthetic confirmation reply lost');result={content:[],structuredContent:{results:[{media_id:mediaId,type:'image',status:'confirmed'}]}};}
   return Response.json({jsonrpc:'2.0',id:command.id,result});
  };
  const broker=createDatabaseHiggsfieldReferenceBroker(options);
  const upload=createHiggsfieldReferenceUploader({allowedHosts:['uploads.reviewed.example']},{resolve:async()=>[{address:'93.184.216.34',family:4}],request:(request,reply)=>{
   assert.equal(request.method,'PUT');assert.equal((request.headers as Record<string,string>).Authorization,undefined);counts.put++;
   const req=new EventEmitter() as ClientRequest;let destroyed=false;req.destroy=(error?:Error)=>{if(!destroyed){destroyed=true;if(error)queueMicrotask(()=>req.emit('error',error));}return req;};
   req.write=((chunk:Uint8Array,done:(error?:Error)=>void)=>{uploaded.push(Buffer.from(chunk));queueMicrotask(()=>done());return false;}) as ClientRequest['write'];
   req.end=((done:()=>void)=>{void checkIntent('put').then(()=>{done();if(lost==='put'){req.emit('error',new Error('synthetic PUT reply lost'));return;}const response=new PassThrough() as IncomingMessage&PassThrough;response.statusCode=200;response.headers={};response.rawHeaders=[];response.complete=true;reply(response);response.end();},error=>req.emit('error',error));return req;}) as ClientRequest['end'];return req;
  }});
  const worker=createHiggsfieldReferenceWorker({scratchRoot,inspectionProfileSha256:profile,companyId,projectIds:[projectId],operationDeadlineMs:120000,authorityIntervalMs:1000,authorityTimeoutMs:5000},{
   readiness:async()=>({enabled:true,hostQualified:true,storageVerified:true,catalogVerified:true,profileSha256:profile,expiresAt:new Date(Date.now()+600000).toISOString()}),
   claim:()=>transaction(db=>claimHiggsfieldReference(db,{companyId,projectIds:[projectId]},options)),
   authorize:lease=>transaction(db=>authorizeHiggsfieldReference(db,lease,options)),
   readProxy:async lease=>{const c=await transaction(db=>getHiggsfieldReferenceStorageContext(db,lease,options));assert.equal(c.versionId,versionId);assert.equal(c.connectionId,connection.id);assert.equal(c.providerEtag,'synthetic-etag');assert.equal(c.sha256,digest(body));return {stream:new ReadableStream({start(controller){controller.enqueue(Buffer.from(body));controller.close();}}),bytes:body.length,totalBytes:body.length,etag:c.providerEtag,contentType:'image/png',range:null,contentRange:null};},
   inspectMedia:input=>inspectHiggsfieldArchiveMedia(input,{nativeTestMode:true,ffprobePath:process.env.COATRIA_TEST_FFPROBE_PATH??join(bin,process.platform==='win32'?'ffprobe.exe':'ffprobe'),ffmpegPath:process.env.COATRIA_TEST_FFMPEG_PATH??join(bin,process.platform==='win32'?'ffmpeg.exe':'ffmpeg'),limits:{maxBytes:10*1024**2,maxDimension:4096,maxPixels:16_000_000,maxVideoFrames:1,maxDecodedPixels:16_000_000}}),
   recordInspection:async(lease,value)=>{await transaction(db=>recordHiggsfieldReferenceInspection(db,lease,value,options));},
   beginPut:async lease=>(await transaction(db=>beginHiggsfieldReferencePhase(db,lease,'put',options))).actionId,
   completePut:async(lease,action,result)=>{await transaction(db=>completeHiggsfieldReferencePhase(db,lease,action,result,options));},
   fail:async(lease,result)=>{await transaction(db=>failHiggsfieldReference(db,lease,result.uncertain?'HIGGSFIELD_REFERENCE_OUTCOME_UNKNOWN':'HIGGSFIELD_REFERENCE_WORKER_FAILED'));},broker,upload,
  });
  const view=()=>transaction(db=>getHiggsfieldReference(db,actor,proposed.id));
  const approve=async()=>{const r=(await view()).reference;return transaction(db=>approveHiggsfieldReference(db,actor,r.id,{clientId:randomUUID(),revision:r.revision,requestHash:r.requestHash,inspectionHash:r.inspection!.inspectionHash,expiresInMinutes:10,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true},options));};
  return {companyId,projectId,workItemId,proposed,actor,mediaId,worker,counts,uploaded,state,view,approve};
 }
 try{
  await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Reference fixture',$2,'not-a-login')",[owner,owner+'@example.invalid']);
  for(const lost of ['none','allocate','put','confirm'] as const)await t.test(lost==='none'?'complete handoff preserves exact bytes and resolves confirmed UUID':'lost '+lost+' is never repeated',async()=>{
   const f=await fixture(lost);const inspected=await f.worker.runNext();assert.equal(inspected.status,'awaiting_approval',JSON.stringify(inspected));assert.deepEqual(f.counts,{allocate:0,put:0,confirm:0});assert.equal((await f.view()).reference.inspection?.descriptor.verification,'full_decode');
   await f.approve();const result=await f.worker.runNext();assert.equal(result.status,lost==='none'?'confirmed':'uncertain',JSON.stringify(result));assert.equal((await f.state()).status,result.status);assert.equal(f.counts.allocate,1);assert.equal(f.counts.put,lost==='allocate'?0:1);assert.equal(f.counts.confirm,lost==='allocate'||lost==='put'?0:1);
   if(lost==='none'){assert.deepEqual(Buffer.concat(f.uploaded),body);const r=await transaction(db=>resolveHiggsfieldReferences(db,f.actor,{projectId:f.projectId,workItemId:f.workItemId,referenceIds:[f.proposed.id]}));assert.deepEqual(r.medias,[{role:'image',value:f.mediaId}]);assert.equal(r.snapshot.references[0].sha256,digest(body));}
   const publicView=JSON.stringify(await f.view());assert(!publicView.includes('synthetic-private-value'));assert(!publicView.includes('server-only-synthetic-credential'));assert(!publicView.includes('uploadUrl'));assert(!publicView.includes('leaseId'));
   const savedTransport=(await query('SELECT sealed FROM higgsfield_reference_transports WHERE company_id=$1',[f.companyId])).rows;assert(!JSON.stringify(savedTransport).includes('synthetic-private-value'));
   const counts={...f.counts};assert.equal((await f.worker.runNext()).status,'idle');assert.deepEqual(f.counts,counts);assert.deepEqual(await readdir(scratchRoot),[]);
  });assert.equal(network,0);
 }finally{
  globalThis.fetch=before.fetch;await database().end();delete(globalThis as any).coatriaPool;
  try{await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('Fixture shutdown timed out')),5000);dbWorker.once('message',()=>{clearTimeout(timer);yes();});dbWorker.postMessage('stop');});}finally{await dbWorker.terminate();}
  await rm(scratchRoot,{recursive:true,force:true});for(const [key,value] of Object.entries({DATABASE_URL:before.url,DATABASE_POOL_MAX:before.pool,COATRIA_HOSTING_KEYRING:before.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
