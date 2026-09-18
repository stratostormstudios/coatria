import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {errorResponse,hashToken} from '../src/lib/security';
import {authorizeRunTool} from '../src/lib/agent-runs';
import {setupStudio,createStudioProject} from '../src/lib/studio';
import {studioCreativeAssetsRoute,importStudioGeneration,registerStudioStorageReference} from '../src/lib/studio-creative-assets';
import {studioGenerationImportInput,studioStorageReferenceInput,creativePublicUrl} from '../src/lib/studio-creative-assets-protocol';

const generation=(extra:Record<string,unknown>={})=>({clientId:randomUUID(),revision:1,providerJobId:randomUUID(),kind:'image',model:'fixture-official-tool-model',sourceTool:'jobs_wait',observedStatus:'completed',observedAt:new Date().toISOString(),outputs:[{kind:'image',mediaId:randomUUID()}],...extra});
test('creative receipts never accept verification, authority, executable or arbitrary provider overrides',()=>{
 assert(studioGenerationImportInput.safeParse(generation()).success);
 for(const extra of[{providerVerified:true},{evidenceSource:'provider_verified'},{provider:'other'},{command:'curl private'},{recordedBy:randomUUID()},{apiKey:'secret'},{observedStatus:'succeeded'},{providerJobId:'invented-id'},{references:[{kind:'higgsfield_media',mediaId:randomUUID(),role:'shell'}]}])assert(!studioGenerationImportInput.safeParse(generation(extra)).success);
 assert(!studioGenerationImportInput.safeParse(generation({observedStatus:'queued'})).success);
 for(const url of['file:///private/footage.mov','https://user:pass@example.com/file','https://example.com/file?token=private','https://example.com/file#secret','https://127.0.0.1/file','https://2130706433/file','https://[::ffff:127.0.0.1]/file'])assert(!creativePublicUrl.safeParse(url).success,url);
});
test('storage pointers require exact bounded relative metadata and cannot request access or execution',()=>{
 const value={clientId:randomUUID(),revision:1,driveId:randomUUID(),path:'project/shot 010/plate.exr',expectedBytes:100,expectedModifiedAt:new Date().toISOString(),name:'Plate'};assert(studioStorageReferenceInput.safeParse(value).success);
 for(const path of['../outside','C:/private','/mnt/private','a/../b','a\\b','a//b','a\u0000b'])assert(!studioStorageReferenceInput.safeParse({...value,path}).success);
 for(const extra of[{sha256:'a'.repeat(64)},{uploaded:true},{filesystemRoot:'C:/'},{url:'https://example.com'},{expectedBytes:Number.MAX_SAFE_INTEGER+1}])assert(!studioStorageReferenceInput.safeParse({...value,...extra}).success);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const safeIntegration=integration&&['127.0.0.1','localhost','[::1]'].includes(new URL(integration).hostname);
test('creative metadata preserves real project authority, immutable receipts and storage-only boundaries',{skip:!emulate&&!safeIntegration,timeout:120000},async t=>{
 const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX};process.env.DATABASE_URL=integration;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await socket.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),agentId=randomUUID(),driveId=randomUUID(),foreignDrive=randomUUID(),runId=randomUUID(),leaseToken=randomUUID()+randomUUID(),sessions={owner:randomUUID(),member:randomUUID(),outsider:randomUUID()},origin='http://localhost:4180',modifiedAt='2026-01-02T03:04:05.000Z';
 let projectId='',foreignProjectId='',workItemId='',taskId='',identity:any;
 const revision=async()=>Number((await query('SELECT revision FROM studio_projects WHERE company_id=$1 AND id=$2',[company,projectId])).rows[0].revision);
 const base=()=>`companies/${company}/studio/projects/${projectId}/creative-assets`;
 async function call(path:string,method='GET',data?:unknown,actor:keyof typeof sessions|'anonymous'='owner',expected=200){
  const headers:Record<string,string>={Origin:origin};if(actor!=='anonymous')headers.Cookie='coatria_session='+sessions[actor];if(data!==undefined)headers['Content-Type']='application/json';const req=new Request(origin+'/api/'+path,{method,headers,...data===undefined?{}:{body:JSON.stringify(data)}});let response:Response;
  try{response=await studioCreativeAssetsRoute(req,path.split('?')[0].split('/'),method)??new Response(null,{status:404});}catch(error){response=errorResponse(error);}const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
 }
 const asAgent=async(kind:'generation'|'storage',data:any,proof=leaseToken)=>transaction(async client=>{await authorizeRunTool(client,identity,runId,proof);const actor={companyId:company,userId:owner,agentId,runId};return kind==='generation'?importStudioGeneration(client,actor,projectId,data):registerStudioStorageReference(client,actor,projectId,data);});
 const originalFetch=globalThis.fetch;let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw Error('This metadata-only fixture must never make outbound requests.');};
 try{
  for(const[user,name]of[[owner,'Creative owner'],[member,'Creative member'],[outsider,'Foreign owner']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[user,name,user+'@example.invalid','fixture']);
  for(const id of[company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Creative fixture',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",[company,owner,member,foreign,outsider]);
  for(const[name,user]of Object.entries({owner,member,outsider}))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),user]);
  await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,capabilities,invocation_access) VALUES($1,$2,'Creative fixture agent','custom',$3,$4,'[\"studio.read\",\"studio.write\",\"tasks.write\"]','admins')",[agentId,company,hashToken('creative-fixture-token'),owner]);identity=(await query('SELECT * FROM agents WHERE id=$1',[agentId])).rows[0];
  for(const [cid,uid]of[[company,owner],[foreign,outsider]]){
   await transaction(client=>setupStudio(client,{companyId:cid,userId:uid},{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:0,assignments:cid===company?[{roleKey:'comp',agentId}]:[]}));
   const result=await transaction(client=>createStudioProject(client,{companyId:cid,userId:uid},{clientId:randomUUID(),name:'Generation metadata project',clientName:'Fixture',brief:'Synthetic receipts, no provider invocation.',aiPolicy:'allowed',spec:{width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'sRGB'},shots:[{code:'SH010',description:'Synthetic shot',frameStart:1,frameEnd:24,handles:0,disciplines:['compositing']}]}));if(cid===company)projectId=result.project.id;else foreignProjectId=result.project.id;
  }
  const work=(await query("SELECT id,task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage='compositing'",[company,projectId])).rows[0];workItemId=work.id;taskId=work.task_id;
  await query("UPDATE tasks SET status='done' WHERE company_id=$1 AND id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage IN ('estimate','breakdown','ingest'))",[company,projectId]);
  await query('UPDATE studio_projects SET gates=$3 WHERE company_id=$1 AND id=$2',[company,projectId,JSON.stringify({brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}})]);
  const convo=(await query('INSERT INTO conversations(company_id) VALUES($1) RETURNING id',[company])).rows[0].id;
  await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic generation receipt import','[\"studio.read\",\"studio.write\",\"tasks.write\"]','running','creative-fixture',$8,clock_timestamp()+interval '20 minutes',clock_timestamp())",[runId,company,agentId,owner,convo,randomUUID(),'a'.repeat(64),hashToken(leaseToken)]);
  await query("UPDATE tasks SET status='doing',agent_run_id=$3 WHERE company_id=$1 AND id=$2",[company,taskId,runId]);
  for(const[did,cid,uid]of[[driveId,company,owner],[foreignDrive,foreign,outsider]]){await query("INSERT INTO drives(id,company_id,name,token_hash,created_by,status,last_seen_at,file_count) VALUES($1,$2,'Approved metadata drive',$3,$4,'online',clock_timestamp(),1)",[did,cid,hashToken(did),uid]);await query('INSERT INTO drive_files(drive_id,path,size,modified_at) VALUES($1,$2,$3,$4)',[did,'heavy/plate.exr',4_000_000_000,modifiedAt]);}
  let pointer:any,firstGeneration:any;
  await t.test('same-company indexed heavy file becomes a snapshot without reading, hashing, upload or access',async()=>{
   const payload={clientId:randomUUID(),revision:await revision(),driveId,path:'heavy/plate.exr',expectedBytes:4_000_000_000,expectedModifiedAt:modifiedAt,name:'Heavy source'};
   const first=await call(base()+'/storage-references','POST',payload,'owner',201);pointer=first.reference;assert.equal(pointer.bytes,4_000_000_000);assert.equal(pointer.verificationSource,'metadata_only');assert.equal(pointer.bytesVerified,false);assert.equal(pointer.uploadedToHiggsfield,false);assert.equal(pointer.fileAccessGranted,false);
   const replay=await call(base()+'/storage-references','POST',payload,'owner');assert.equal(replay.replayed,true);assert.equal(replay.reference.id,pointer.id);
   await call(base()+'/storage-references','POST',{...payload,name:'Conflicting request'},'owner',409);
   await call(base()+'/storage-references','POST',{...payload,clientId:randomUUID(),revision:await revision(),driveId:foreignDrive},'owner',404);
   await call(base()+'/storage-references','POST',{...payload,clientId:randomUUID(),revision:await revision(),expectedBytes:1},'owner',409);
   assert.equal(externalCalls,0);
  });
  await t.test('index replacement and revocation do not rewrite the historical pointer',async()=>{
   await query('UPDATE drive_files SET size=10 WHERE drive_id=$1',[driveId]);let view=(await call(base()+'/storage-references/'+pointer.id)).reference;assert.equal(view.indexState,'changed');assert.equal(view.bytes,4_000_000_000);
   await query('DELETE FROM drive_files WHERE drive_id=$1',[driveId]);view=(await call(base()+'/storage-references/'+pointer.id)).reference;assert.equal(view.indexState,'missing');
   await query("UPDATE drives SET status='revoked' WHERE id=$1",[driveId]);view=(await call(base()+'/storage-references/'+pointer.id)).reference;assert.equal(view.indexState,'revoked');
   await call(base()+'/storage-references','POST',{clientId:randomUUID(),revision:await revision(),driveId,path:pointer.path,expectedBytes:pointer.bytes,expectedModifiedAt:modifiedAt,name:'Revoked'},'owner',404);
   await query("UPDATE drives SET status='online' WHERE id=$1",[driveId]);await query('INSERT INTO drive_files(drive_id,path,size,modified_at) VALUES($1,$2,$3,$4)',[driveId,pointer.path,pointer.bytes,modifiedAt]);
  });
  await t.test('pending and completed official-tool observations retain immutable identity and unverified provenance',async()=>{
   const payload=generation({revision:await revision(),workItemId,observedStatus:'queued',outputs:[],references:[{kind:'storage',storageReferenceId:pointer.id,role:'image'}]});const first=await call(base()+'/generations','POST',payload,'owner',201);firstGeneration=first.generation;
   assert.equal(first.receipt.evidenceSource,'imported_report');assert.equal(first.receipt.providerVerified,false);assert.equal(first.receipt.bytesVerified,false);assert.equal(first.receipt.independentlyReviewed,false);
   const completed={...payload,clientId:randomUUID(),revision:await revision(),observedStatus:'completed',outputs:[{kind:'image',url:'https://media.example.invalid/generated.png'}],observedAt:new Date(Date.now()+100).toISOString()};const result=await call(base()+'/generations','POST',completed,'owner',201);assert.equal(result.generation.id,firstGeneration.id);
   const replay=await call(base()+'/generations','POST',completed,'owner');assert.equal(replay.replayed,true);assert.equal(replay.receipt.id,result.receipt.id);
   const detail=await call(base()+'/generations/'+firstGeneration.id);assert.equal(detail.receipts.length,2);assert.equal(detail.generation.latestReceipt.observedStatus,'completed');
   await call(base()+'/generations','POST',{...completed,clientId:randomUUID(),revision:await revision(),model:'changed-model'},'owner',409);
   await call(base()+'/generations','POST',{...completed,clientId:randomUUID(),revision:await revision(),observedStatus:'failed',outputs:[]},'owner',409);
   assert.equal(Number((await query('SELECT count(*) FROM studio_artifacts WHERE company_id=$1',[company])).rows[0].count),0);assert.equal(Number((await query('SELECT count(*) FROM studio_reviews WHERE company_id=$1',[company])).rows[0].count),0);assert.equal((await query('SELECT status FROM tasks WHERE id=$1',[taskId])).rows[0].status,'doing');
  });
  await t.test('member reads, admin writes and exact tenant/reference/cursor boundaries are enforced',async()=>{
   assert.equal((await call(base()+'/generations','GET',undefined,'member')).generations.length,1);await call(base()+'/generations','POST',generation({revision:await revision()}),'member',403);await call(base()+'/generations','GET',undefined,'outsider',404);await call(base()+'/generations','GET',undefined,'anonymous',401);
   await call(base()+'/generations?after='+randomUUID(),'GET',undefined,'owner',404);await call(base()+'/generations?limit=2&limit=3','GET',undefined,'owner',400);
   await call(base()+'/generations','POST',generation({revision:await revision(),references:[{kind:'generation',generationId:randomUUID(),role:'image'}]}),'owner',404);
   await call(`companies/${foreign}/studio/projects/${foreignProjectId}/creative-assets/generations/${firstGeneration.id}`,'GET',undefined,'outsider',404);
  });
  await t.test('agent uses the actual leased authority and exact assigned task; human gates remain in force',async()=>{
   const imported:any=await asAgent('generation',generation({revision:await revision(),workItemId,references:[{kind:'generation',generationId:firstGeneration.id,role:'image'},{kind:'higgsfield_media',mediaId:randomUUID(),role:'image'}]}));assert.equal(imported.receipt.importedAgentId,agentId);assert.equal(imported.receipt.runId,runId);
   const attempt=async(extra:Record<string,unknown>={})=>asAgent('generation',generation({revision:await revision(),workItemId,...extra}));
   await assert.rejects(attempt({workItemId:null}),/exact assigned task/);await assert.rejects(attempt({workItemId:randomUUID()}),/not found/);await assert.rejects(asAgent('generation',generation({revision:await revision(),workItemId}),'incorrect-proof'),/lease/);
   await query('UPDATE tasks SET agent_run_id=NULL WHERE id=$1',[taskId]);await assert.rejects(attempt(),/Reserve/);await query('UPDATE tasks SET agent_run_id=$2 WHERE id=$1',[taskId,runId]);
   await query("UPDATE studio_projects SET ai_policy='restricted' WHERE id=$1",[projectId]);await assert.rejects(attempt(),/does not authorize/);await query("UPDATE studio_projects SET ai_policy='allowed' WHERE id=$1",[projectId]);
   await query("UPDATE agents SET capabilities='[\"studio.read\"]' WHERE id=$1",[agentId]);await assert.rejects(attempt(),/studio.write/);await query("UPDATE agents SET capabilities='[\"studio.read\",\"studio.write\",\"tasks.write\"]' WHERE id=$1",[agentId]);
   await query("UPDATE studio_role_bindings SET agent_id=NULL WHERE company_id=$1 AND role_key='comp'",[company]);await assert.rejects(attempt(),/role must be assigned/);await query("UPDATE studio_role_bindings SET agent_id=$2 WHERE company_id=$1 AND role_key='comp'",[company,agentId]);
   await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,owner]);await assert.rejects(attempt(),/sponsor|access|owner|administrator/i);await query("UPDATE memberships SET role='owner' WHERE company_id=$1 AND user_id=$2",[company,owner]);assert.equal(externalCalls,0);
  });
  await t.test('stale and delivered projects cannot accept new evidence; replay remains immutable',async()=>{
   await call(base()+'/generations','POST',generation({revision:1}),'owner',409);await call(base()+'/generations','POST',generation({revision:await revision(),observedAt:new Date(Date.now()+600000).toISOString()}),'owner',400);
   await query("UPDATE studio_projects SET status='delivered' WHERE id=$1",[projectId]);await call(base()+'/generations','POST',generation({revision:await revision()}),'owner',409);assert.equal(externalCalls,0);
  });
 }finally{
  globalThis.fetch=originalFetch;
  try{for(const cid of[company,foreign])await query('DELETE FROM companies WHERE id=$1',[cid]);for(const uid of[owner,member,outsider])await query('DELETE FROM users WHERE id=$1',[uid]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
