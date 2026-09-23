import {currentTaskPatchForFixture} from './task-fixture-revision';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import type {Pool} from 'pg';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {studioProjectInput,studioVersionedProjectInput,type StudioGeneratedProjectDetail,type StudioSnapshot,type StudioReadableSnapshot} from '../src/lib/studio-protocol';

const legacySpec={width:1920,height:1080,fpsNumerator:24000,fpsDenominator:1001,format:'exr',colorSpace:'ACEScg'};
const legacy=()=>({clientId:randomUUID(),name:'Legacy request fixture',clientName:'Synthetic client',brief:'Keep the original frame contract and request receipts.',spec:legacySpec,shots:[{code:'SH010',description:'Original frame-based work',frameStart:1001,frameEnd:1024,handles:8,disciplines:['compositing']}]});
const generated=(kind:'image'|'video'|'audio')=>({clientId:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:`Generated ${kind} fixture`,clientName:'Synthetic client',brief:'A typed generated-media planning fixture without any provider operation.',aiPolicy:'allowed',spec:kind==='image'?{kind,format:'png',width:1920,height:1080,color:{mode:'not_required'}}:kind==='video'?{kind,format:'mp4',codec:'h264',width:1920,height:1080,color:{mode:'not_required'},frameRate:{mode:'constant',numerator:48000,denominator:2000},audio:{mode:'none'}}:{kind,format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:2},shots:[{kind,code:'MEDIA010',description:`Typed ${kind} work`,...kind==='image'?{}:{durationMs:{min:900,max:1100}}}]});
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);

test('project version negotiation keeps original normalized requests and requires explicit generated media',()=>{
 const old=legacy();assert.deepEqual(studioVersionedProjectInput.parse(old),studioProjectInput.parse(old));
 for(const kind of ['image','video','audio'] as const){const input=generated(kind),parsed=studioVersionedProjectInput.parse(input);assert('contractVersion' in parsed);assert.equal(parsed.contractVersion,2);assert.equal(studioProjectInput.safeParse(input).success,false);}
 for(const contractVersion of [1,3,'2',null])assert.equal(studioVersionedProjectInput.safeParse({...generated('image'),contractVersion}).success,false);
 const {contractVersion:_,...missingVersion}=generated('image');assert.equal(studioVersionedProjectInput.safeParse(missingVersion).success,false);
 assert.equal(studioVersionedProjectInput.safeParse({...generated('audio'),productionPath:'vfx'}).success,false);
 assert.equal(studioVersionedProjectInput.safeParse({...generated('image'),shots:[{...generated('image').shots[0],frameStart:0,frameEnd:0,handles:0,disciplines:[]}]}).success,false);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('generated project API stores real typed units, preserves v1 receipts and negotiates before pagination',{skip:!emulate&&!integrationUrl,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api');
 const previous={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX};
 process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';
 let stop:(()=>Promise<void>)|undefined;
 if(emulate){
  const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');
  const db=await PGlite.create();for(const file of (await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile(`database/${file}`,'utf8'));
  const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
  stop=async()=>{await server.stop();await db.close();};
 }
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),reviewer=randomUUID();
 const sessions={owner:randomUUID(),member:randomUUID(),outsider:randomUUID(),reviewer:randomUUID()},origin='http://localhost:4180',prefix=`companies/${company}/studio`;
 type Actor=keyof typeof sessions|'anonymous';
 async function call(path:string,method='GET',payload?:unknown,expected=200,actor:Actor='owner'){
  payload=await currentTaskPatchForFixture(path,method,payload);
    const headers:Record<string,string>={Origin:origin};if(actor!=='anonymous')headers.Cookie=`coatria_session=${sessions[actor]}`;if(payload!==undefined)headers['Content-Type']='application/json';
  const response=await handleApi(new Request(`${origin}/api/${path}`,{method,headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('?')[0].split('/'));
  const result=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(result)}`);return result;
 }
 const generatedIds:string[]=[],legacyIds:string[]=[];
 try{
  for(const [id,name] of [[owner,'Owner'],[member,'Member'],[outsider,'Outsider'],[reviewer,'Independent reviewer']])await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,\'fixture\')',[id,name,`${id}@example.invalid`]);
  for(const id of [company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Generated project test',$2,'blank')",[id,id]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner'),($1,$6,'admin')",[company,owner,member,foreign,outsider,reviewer]);
  for(const [actor,user] of [["owner",owner],["member",member],["outsider",outsider],["reviewer",reviewer]] as const)await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[actor]),user]);
  await call(`${prefix}/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:0,assignments:[{roleKey:'producer',humanId:owner}]},201);

  await t.test('all three generated kinds retain real media units and the references-to-QC dependency graph',async()=>{
   for(const kind of ['image','video','audio'] as const){
    const input=generated(kind),created=await call(`${prefix}/projects`,'POST',input,201),projectId=created.project.id;generatedIds.push(projectId);
    assert.equal(created.project.contractVersion,2);assert.equal(created.project.productionPath,'higgsfield');assert.equal(created.project.spec.kind,kind);
    const detail=await call(`${prefix}/projects/${projectId}?contractVersion=2`) as StudioGeneratedProjectDetail;
    assert.equal(detail.shots.length,1);assert.equal(detail.shots[0].kind,kind);assert(!('frameStart' in detail.shots[0]));assert(!('handles' in detail.shots[0]));assert(!('disciplines' in detail.shots[0]));
    if(kind==='image')assert(!('durationMs' in detail.shots[0]));else assert.deepEqual('durationMs' in detail.shots[0]&&detail.shots[0].durationMs,{min:900,max:1100});
    if(detail.project.spec.kind==='video')assert.deepEqual(detail.project.spec.frameRate,{mode:'constant',numerator:24,denominator:1});
    const stages=['estimate','breakdown','references','generation','qc','delivery'];assert.deepEqual(detail.workItems.map(work=>work.stage).sort(),[...stages].sort());
    for(let index=0;index<stages.length;index++){const work=detail.workItems.find(item=>item.stage===stages[index])!;assert.deepEqual(work.dependencies,index?[detail.workItems.find(item=>item.stage===stages[index-1])!.id]:[]);assert.notEqual(work.execution,'dcc');assert.equal(work.status,'todo');}
    const stored=(await query('SELECT media_kind,frame_start,frame_end,handles,disciplines,duration_min_ms,duration_max_ms FROM studio_shots WHERE project_id=$1',[projectId])).rows[0];
    assert.equal(stored.media_kind,kind);for(const field of ['frame_start','frame_end','handles'])assert.equal(stored[field],null);assert.deepEqual(stored.disciplines,[]);
    const replay=await call(`${prefix}/projects`,'POST',input,200);assert.equal(replay.replayed,true);assert.deepEqual(replay.project,created.project);
    await call(`${prefix}/projects`,'POST',{...input,name:'Changed request'},409);
    const expected=createHash('sha256').update(canonical({operation:'project',data:studioVersionedProjectInput.parse(input)})).digest('hex');
    assert.equal((await query('SELECT request_hash FROM studio_requests WHERE company_id=$1 AND client_id=$2',[company,input.clientId])).rows[0].request_hash,expected);
   }
  });

  await t.test('legacy create and replay keep their original digest and response fields',async()=>{
   // ai-production also contains all roles needed by this one-comp legacy plan.
   const input=legacy(),created=await call(`${prefix}/projects`,'POST',input,201);legacyIds.push(created.project.id);
   assert(!('contractVersion' in created.project));assert.deepEqual(created.project.spec,legacySpec);
   const replay=await call(`${prefix}/projects`,'POST',{...input,productionPath:'vfx'},200);assert.deepEqual(replay.project,created.project);
   const {productionPath:_,...legacyRequest}=studioProjectInput.parse(input),expected=createHash('sha256').update(canonical({operation:'project',data:legacyRequest})).digest('hex');
   assert.equal((await query('SELECT request_hash FROM studio_requests WHERE company_id=$1 AND client_id=$2',[company,input.clientId])).rows[0].request_hash,expected);
   legacyIds.push((await call(`${prefix}/projects`,'POST',{...legacy(),productionPath:'higgsfield'},201)).project.id);
  });

  await t.test('default pages and cursors exclude generated projects before limiting',async()=>{
   let after:string|null=null;const seen:string[]=[];
   do{const page=await call(`${prefix}?limit=1${after?`&after=${after}`:''}`) as StudioSnapshot;assert(page.projects.every(project=>!('contractVersion' in project)));seen.push(...page.projects.map(project=>project.id));after=page.nextAfter;}while(after);
   assert.deepEqual(seen,[...legacyIds].sort());
   const opted=await call(`${prefix}?contractVersion=2`) as StudioReadableSnapshot;assert.equal(opted.projects.length,5);assert.equal(opted.projects.filter(project=>project.contractVersion===2).length,3);
   for(const projectId of generatedIds){assert.equal((await call(`${prefix}/projects/${projectId}`,'GET',undefined,409)).code,'STUDIO_CONTRACT_UNSUPPORTED');await call(`${prefix}?after=${projectId}`,'GET',undefined,404);}
   await call(`${prefix}?contractVersion=3`,'GET',undefined,400);await call(`${prefix}?contractVersion=2&contractVersion=2`,'GET',undefined,400);
   await call(`${prefix}/projects/${generatedIds[0]}?contractVersion=1`,'GET',undefined,400);
   await call(`${prefix}/projects/${generatedIds[0]}?contractVersion=2&contractVersion=2`,'GET',undefined,400);
  });

  await t.test('authority and unsupported legacy write paths cannot downgrade v2 media',async()=>{
   const input=generated('image');await call(`${prefix}/projects`,'POST',input,403,'member');await call(`${prefix}/projects`,'POST',input,401,'anonymous');await call(`${prefix}/projects`,'POST',input,404,'outsider');
   for(const contractVersion of [1,3,'2',null])await call(`${prefix}/projects`,'POST',{...input,contractVersion},400);
   const detail=await call(`${prefix}/projects/${generatedIds[0]}?contractVersion=2`) as StudioGeneratedProjectDetail;
   await call(`${prefix}/projects/${generatedIds[0]}?contractVersion=2`,'GET',undefined,404,'outsider');
   const common={clientId:randomUUID(),revision:detail.project.revision};
   assert.equal((await call(`${prefix}/projects/${detail.project.id}/artifacts`,'POST',{...common,workItemId:detail.workItems.find(work=>work.stage==='generation')!.id,name:'Cannot downgrade',url:'https://example.invalid/ref.exr',sha256:'aa'.repeat(32),frameStart:0,frameEnd:10,...legacySpec,notes:'Synthetic legacy bypass attempt'},409)).code,'STUDIO_CONTRACT_UNSUPPORTED');
   assert.equal((await call(`${prefix}/projects/${detail.project.id}/gates`,'POST',{...common,clientId:randomUUID(),gate:'client_acceptance',decision:'changes_requested',note:'Cannot create unqualified client acceptance'},409)).code,'STUDIO_GENERATED_CLIENT_IDENTITY_REQUIRED');
   assert.equal((await call(`${prefix}/projects/${detail.project.id}/creative-followup`,'GET',undefined,409)).code,'STUDIO_CONTRACT_UNSUPPORTED');
   assert.equal((await query('SELECT count(*) FROM studio_artifacts WHERE company_id=$1',[company])).rows[0].count,'0');
  });

  await t.test('real task submission stays blocked without verified generated media after planning acceptance',async()=>{
   const projectId=generatedIds[0],projectPath=`${prefix}/projects/${projectId}`;
   const detail=()=>call(`${projectPath}?contractVersion=2`) as Promise<StudioGeneratedProjectDetail>;
   const gate=async(name:string)=>{const state=await detail();await call(`${projectPath}/gates`,'POST',{clientId:randomUUID(),revision:state.project.revision,gate:name,decision:'approved',note:'Synthetic planning test approval'},201);};
   const accept=async(stage:string)=>{const work=(await detail()).workItems.find(item=>item.stage===stage)!;await call(`companies/${company}/tasks/${work.taskId}`,'PATCH',{status:'review'});await call(`companies/${company}/tasks/${work.taskId}`,'PATCH',{status:'done',reviewNote:'Independent synthetic planning acceptance'},200,'reviewer');};
   await gate('brief');await accept('estimate');await gate('estimate');await gate('production');await accept('breakdown');await accept('references');
   const generation=(await detail()).workItems.find(item=>item.stage==='generation')!;assert.equal(generation.readiness,'ready');
   const response=await call(`companies/${company}/tasks/${generation.taskId}`,'PATCH',{status:'review'},409);assert.equal(response.code,'STUDIO_ARTIFACT_REQUIRED');
   assert.equal((await detail()).workItems.find(item=>item.id===generation.id)!.status,'todo');
   const state=await detail(),review=await call(`${projectPath}/reviews`,'POST',{clientId:randomUUID(),revision:state.project.revision,artifactId:randomUUID(),decision:'approved',technicalQc:true,note:'Cannot approve nonexistent generated bytes'},409,'reviewer');
   assert.equal(review.code,'STUDIO_GENERATED_EVIDENCE_INVALID');assert.equal((await detail()).reviews.length,0);
   const delivery=await call(`${projectPath}/deliveries`,'POST',{clientId:randomUUID(),revision:state.project.revision,name:'Cannot package incomplete work',artifactIds:[randomUUID()],note:'Synthetic failed packaging'},409);assert.equal(delivery.code,'STUDIO_WORK_INCOMPLETE');
  });

  await t.test('queued generation specialists receive explicit version negotiation and the source-bound tool',async()=>{
   const agent=randomUUID(),capabilities=['workspace.read','tasks.write','studio.read','studio.write','creative.read','creative.write','storage.read'];
   await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Generated specialist fixture','custom',$3,$4,'admins',$5)",[agent,company,hashToken(`ca_${randomUUID()}`),owner,JSON.stringify(capabilities)]);
   const profile=(await call(prefix)).profile;
   await call(`${prefix}/setup`,'POST',{clientId:randomUUID(),templateId:'ai-production',templateVersion:1,revision:profile.revision,assignments:[{roleKey:'producer',humanId:owner},{roleKey:'comp',agentId:agent}]},201);
   const projectPath=`${prefix}/projects/${generatedIds[0]}`,detail=await call(`${projectPath}?contractVersion=2`) as StudioGeneratedProjectDetail,generation=detail.workItems.find(item=>item.stage==='generation')!;
   const payload={clientId:randomUUID(),revision:detail.project.revision,workItemId:generation.id},dispatched=await call(`${projectPath}/dispatch`,'POST',payload,201);
   assert.equal(dispatched.run.status,'queued');assert.match(dispatched.run.prompt,/Read studio_get with contractVersion:2/);assert.match(dispatched.run.prompt,/studio_generated_artifact_register with the exact verified archive ID/);assert(dispatched.run.prompt.includes(generation.taskId));
   const replay=await call(`${projectPath}/dispatch`,'POST',payload,200);assert.equal(replay.run.id,dispatched.run.id);assert.equal(replay.replayed,true);
   assert.equal((await query('SELECT count(*)::int AS count FROM studio_dispatches WHERE company_id=$1 AND project_id=$2',[company,detail.project.id])).rows[0].count,1);
   assert.equal((await query('SELECT status FROM tasks WHERE company_id=$1 AND id=$2',[company,generation.taskId])).rows[0].status,'todo');
  });
 }finally{
  try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,member,outsider,reviewer]]);}finally{await database().end();delete(globalThis as {coatriaPool?:Pool}).coatriaPool;await stop?.();for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 }
});
