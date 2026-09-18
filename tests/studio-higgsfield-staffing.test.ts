import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {draftStudioStaffing,studioStaffingPlanInput,studioStaffingCapabilities,STUDIO_STAFFING_CAPABILITIES,STUDIO_PLANNING_REVIEW_CAPABILITIES} from '../src/lib/studio-staffing-protocol';

const provider={pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}};
const roles=['producer','coordinator','supervisor','ingest','comp','delivery'];
const input=(extra:Record<string,unknown>={})=>({brief:'Synthetic AI creative studio using reviewed official Higgsfield requests and storage-only reference metadata.',teamSize:6,disciplines:['compositing'],reviewerHumanId:null,provider,...extra});
function canonical(value:unknown):string{return Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);}

test('AI staffing covers the selected template exactly with useful generation and reference skills',()=>{
 const draft=draftStudioStaffing(input({templateId:'ai-production',disciplines:['fx']}));
 assert.equal(draft.data.templateId,'ai-production');assert.equal(draft.specialists.length,6);
 assert.deepEqual(draft.requiredRoleKeys,roles);assert.deepEqual(draft.specialists.flatMap(person=>person.roleKeys).sort(),[...roles].sort());
 assert(draft.specialists.every(person=>!person.roleKeys.includes('qc')));
 assert(draft.specialists.find(person=>person.roleKeys.includes('comp'))!.skills.some(skill=>skill.key==='higgsfield-production'&&/official Higgsfield MCP/.test(skill.instructions)));
 assert(draft.specialists.find(person=>person.roleKeys.includes('ingest'))!.skills.some(skill=>skill.key==='creative-references'&&/metadata only/.test(skill.instructions)));
 assert(draft.specialists.find(person=>person.roleKeys.includes('supervisor'))!.skillKeys.includes('creative-direction'));
 const grouped=draftStudioStaffing(input({templateId:'ai-production',teamSize:1}));assert.deepEqual(grouped.specialists[0].roleKeys,roles);
 for(const roleKeys of [roles.slice(0,-1),[...roles,'fx'],[...roles,'qc']])assert.throws(()=>draftStudioStaffing(input({templateId:'ai-production',teamSize:1,specialists:[{name:'Invalid scope',roleKeys}]})));
});

test('AI creative and reference grants are explicit role additions; legacy and reviewer authority stay unchanged',()=>{
 assert.deepEqual(studioStaffingCapabilities('vfx-boutique',roles),[...STUDIO_STAFFING_CAPABILITIES]);
 assert.deepEqual(studioStaffingCapabilities('ai-production',['producer','coordinator','supervisor','delivery']),[...STUDIO_STAFFING_CAPABILITIES]);
 assert.deepEqual(studioStaffingCapabilities('ai-production',['ingest']),[...STUDIO_STAFFING_CAPABILITIES,'infrastructure.read','creative.read']);
 assert.deepEqual(studioStaffingCapabilities('ai-production',['comp']),[...STUDIO_STAFFING_CAPABILITIES,'creative.read','creative.write']);
 const combined=studioStaffingCapabilities('ai-production',roles);assert.equal(new Set(combined).size,combined.length);assert(!combined.includes('studio.execute'));assert(!combined.includes('studio.review'));
 assert.deepEqual(STUDIO_PLANNING_REVIEW_CAPABILITIES,['studio.read','studio.review']);
 assert.equal(studioStaffingPlanInput.parse(input()).templateId,'vfx-boutique');
 for(const patch of [{templateId:'other'},{productionPath:'higgsfield'},{creativeGrants:['*']},{specialists:[{name:'Injection',roleKeys:roles,capabilities:['creative.write']}]}])assert.equal(studioStaffingPlanInput.safeParse(input(patch)).success,false);
});

test('human and agent staffing schemas expose the same explicit template selection and exact plan receipt',async()=>{
 const {agentRuntimeOpenApi}=await import('../src/lib/agent-runtime-openapi'),spec:any=agentRuntimeOpenApi;
 const human=spec.paths['/api/companies/{companyId}/studio/staffing/proposals'].post.requestBody.content['application/json'].schema;
 const tool=spec.paths['/api/agent/tools/studio_staffing_propose'].post.requestBody.content['application/json'].schema.properties.arguments;
 for(const schema of [human,tool]){assert.deepEqual(schema.properties.templateId.enum,['vfx-boutique','ai-production']);assert.equal(schema.properties.templateId.default,'vfx-boutique');assert(!schema.required.includes('templateId'));}
 assert.deepEqual(human.properties.templateId,tool.properties.templateId);
 assert.deepEqual(spec.components.schemas.StudioStaffingPlan.properties.templateId.enum,['vfx-boutique','ai-production']);
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('AI staffing applies only exact reviewed creative grants and preserves existing identities',{skip:!emulate&&!integrationUrl,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api');
 const prior={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX};process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();const url=new URL('postgresql://'+server.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),reviewer=randomUUID(),member=randomUUID(),outsider=randomUUID(),sessions={owner:randomUUID(),reviewer:randomUUID(),member:randomUUID(),outsider:randomUUID()};
 const users={owner,reviewer,member,outsider},origin='http://localhost:4180',prefix=`companies/${company}/studio/staffing/proposals`;
 type Actor=keyof typeof sessions|'anonymous';
 async function call(path:string,method='GET',payload?:unknown,actor:Actor='owner',expected:number|number[]=200){const headers:Record<string,string>={Origin:origin};if(actor!=='anonymous')headers.Cookie='coatria_session='+sessions[actor];if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...(payload===undefined?{}:{body:JSON.stringify(payload)})}),path.split('?')[0].split('/'));const result=await response.json();assert((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${path}: got ${response.status}, code ${result.code??''}, error ${result.error??''}`);return result;}
 const propose=async(extra:Record<string,unknown>={})=>(await call(prefix,'POST',{clientId:randomUUID(),...input({templateId:'ai-production',reviewerHumanId:reviewer,...extra})},'owner',201)).proposal;
 const approval=(p:any)=>({clientId:randomUUID(),revision:p.revision,planHash:p.planHash,profileRevision:p.profileRevision});
 const countAgents=async()=>Number((await query('SELECT count(*) FROM agents WHERE company_id=$1',[company])).rows[0].count);
 let legacyIdentity:any,aiProposal:any,aiApplied:any;
 try{
  for(const [actor,userId]of Object.entries(users))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'AI staffing fixture '+actor,userId+'@example.invalid','fixture']);
  for(const companyId of [company,foreign])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'AI staffing fixture',$2,'blank')",[companyId,companyId]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[company,owner,reviewer,member,foreign,outsider]);
  for(const [actor,userId]of Object.entries(users))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[actor as keyof typeof sessions]),userId]);

  await t.test('legacy default request hashes and immutable plans replay after adding the template selector',async()=>{
   const request={clientId:randomUUID(),...input({teamSize:1,reviewerHumanId:reviewer})};
   const p=(await call(prefix,'POST',request,'owner',201)).proposal;
   const {templateId:_,...oldNormalized}=studioStaffingPlanInput.parse(requestWithoutClient(request));
   const oldRequestHash=hashToken(canonical({...oldNormalized,clientId:request.clientId}));
   assert.equal((await query('SELECT request_hash FROM studio_staffing_proposals WHERE company_id=$1 AND id=$2',[company,p.id])).rows[0].request_hash,oldRequestHash);
   const replay=await call(prefix,'POST',{...request,templateId:'vfx-boutique'});assert.equal(replay.replayed,true);assert.deepEqual(replay.proposal,p);
   assert.equal((await call(prefix,'POST',{...request,templateId:'ai-production'},'owner',409)).code,'IDEMPOTENCY_CONFLICT');
   const applied=await call(`${prefix}/${p.id}/apply`,'POST',approval(p),'owner',201);legacyIdentity=applied.application.specialists[0];assert.deepEqual(legacyIdentity.capabilities,[...STUDIO_STAFFING_CAPABILITIES]);
   assert.equal((await call(`companies/${company}/studio`)).profile.templateId,'vfx-boutique');
  });

  await t.test('existing legacy identities cannot acquire creative or storage scopes through staffing',async()=>{
   const before=(await call(`companies/${company}/plugin-installations/${legacyIdentity.installationId}`)).installation;
   const blocked=await call(prefix,'POST',{clientId:randomUUID(),...input({templateId:'ai-production',teamSize:1,specialists:[{name:'Reuse legacy',roleKeys:roles,existingAgentId:legacyIdentity.agentId}]})},'owner',409);
   assert.equal(blocked.code,'STAFFING_AGENT_GRANTS_REQUIRED');assert.deepEqual((await call(`companies/${company}/plugin-installations/${legacyIdentity.installationId}`)).installation,before);assert.equal(await countAgents(),1);
  });

  await t.test('only a company administrator can approve an exact AI template with independent human QC',async()=>{
   const payload={clientId:randomUUID(),...input({templateId:'ai-production',reviewerHumanId:reviewer})};
   await call(prefix,'POST',payload,'member',403);await call(prefix,'POST',payload,'outsider',404);await call(prefix,'POST',payload,'anonymous',401);
   aiProposal=(await call(prefix,'POST',payload,'owner',201)).proposal;assert.equal(aiProposal.plan.templateId,'ai-production');assert.equal(aiProposal.plan.templateVersion,1);assert.deepEqual(aiProposal.plan.unassignedRoleKeys,[]);assert.equal(aiProposal.plan.specialists.length,6);
   for(const person of aiProposal.plan.specialists)assert.deepEqual(person.capabilities,studioStaffingCapabilities('ai-production',person.roleKeys));
   assert(aiProposal.plan.warnings.some((warning:string)=>/each paid Higgsfield request/.test(warning)));
   await call(`${prefix}/${aiProposal.id}/apply`,'POST',{...approval(aiProposal),planHash:'0'.repeat(64)},'owner',409);await call(`${prefix}/${aiProposal.id}/apply`,'POST',approval(aiProposal),'member',403);await call(`${prefix}/${aiProposal.id}/apply`,'POST',approval(aiProposal),'reviewer',409);assert.equal(await countAgents(),1);
   const request=approval(aiProposal);aiApplied=await call(`${prefix}/${aiProposal.id}/apply`,'POST',request,'owner',201);assert.equal(await countAgents(),7);
   const replay=await call(`${prefix}/${aiProposal.id}/apply`,'POST',request);assert.equal(replay.replayed,true);assert.deepEqual(replay.application,aiApplied.application);assert.equal(await countAgents(),7);
   const studio=await call(`companies/${company}/studio`);assert.equal(studio.profile.templateId,'ai-production');assert.equal(studio.profile.roles.length,7);assert.equal(studio.profile.roles.find((role:any)=>role.key==='qc').humanId,reviewer);assert.equal(studio.profile.roles.find((role:any)=>role.key==='qc').agentId,null);
   for(const person of aiApplied.application.specialists){const installed=(await call(`companies/${company}/plugin-installations/${person.installationId}`)).installation;assert.deepEqual([...installed.capabilities].sort(),[...person.capabilities].sort());assert.equal(installed.status,'paused');assert.equal(installed.invocationAccess,'admins');assert.equal(person.credentialState,'not_issued');assert.equal(person.connectionState,'unconnected');assert(!person.roleKeys.includes('qc'));}
   const legacy=(await call(`companies/${company}/plugin-installations/${legacyIdentity.installationId}`)).installation;assert.deepEqual(legacy.capabilities,[...STUDIO_STAFFING_CAPABILITIES]);
  });

  await t.test('rebinding rechecks the exact reviewed grants and never writes existing agent configuration',async()=>{
   const bound=aiApplied.application.specialists.map((person:any)=>({name:person.name,roleKeys:person.roleKeys,existingAgentId:person.agentId}));
   const pending=await propose({specialists:bound});assert.equal(pending.plan.newAgentCount,0);
   const comp=aiApplied.application.specialists.find((person:any)=>person.roleKeys.includes('comp')),installation=(await call(`companies/${company}/plugin-installations/${comp.installationId}`)).installation;
   await call(`companies/${company}/plugin-installations/${comp.installationId}`,'PATCH',{revision:installation.revision,capabilities:[...STUDIO_STAFFING_CAPABILITIES,'creative.read']});
   assert.equal((await call(`${prefix}/${pending.id}/apply`,'POST',approval(pending),'owner',409)).code,'STAFFING_AGENT_GRANTS_REQUIRED');assert.equal(await countAgents(),7);
   let current=(await call(`companies/${company}/plugin-installations/${comp.installationId}`)).installation;
   current=(await call(`companies/${company}/plugin-installations/${comp.installationId}`,'PATCH',{revision:current.revision,capabilities:[...comp.capabilities,'workspace.read']})).installation;
   const fresh=await propose({specialists:bound});assert(fresh.plan.warnings.some((warning:string)=>/broader grants/.test(warning)));
   const result=await call(`${prefix}/${fresh.id}/apply`,'POST',approval(fresh),'owner',201);assert.equal(await countAgents(),7);assert(result.application.specialists.every((person:any)=>person.mode==='bind'&&person.credentialState==='existing'));
   assert.deepEqual((await call(`companies/${company}/plugin-installations/${comp.installationId}`)).installation,current);
  });

  await t.test('separate planning reviewer remains isolated and applying AI staffing starts no provider or worker activity',async()=>{
   const p=await propose({teamSize:7,planningReviewer:{name:'Separate machine planning reviewer'}});assert.equal(p.plan.actualAgentCount,7);assert.equal(p.plan.specialists.length,6);assert.deepEqual(p.plan.planningReviewer.capabilities,[...STUDIO_PLANNING_REVIEW_CAPABILITIES]);
   const result=await call(`${prefix}/${p.id}/apply`,'POST',approval(p),'owner',201),identity=result.application.planningReviewer;
   assert.deepEqual(identity.capabilities,['studio.read','studio.review']);assert.deepEqual(identity.roleKeys,[]);assert.equal(identity.status,'paused');assert.equal(identity.connectionState,'unconnected');assert.equal(result.application.startsWorkers,false);assert.equal(result.application.startsInference,false);
   const profile=(await call(`companies/${company}/studio`)).profile;assert.equal(profile.templateId,'ai-production');assert(profile.roles.every((role:any)=>role.agentId!==identity.agentId));assert.equal(profile.roles.find((role:any)=>role.key==='qc').humanId,reviewer);
   const counts=(await query("SELECT (SELECT count(*) FROM studio_review_policies WHERE company_id=$1)::int reviews,(SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1)::int hosts,(SELECT count(*) FROM studio_host_provisions WHERE company_id=$1)::int provisions,(SELECT count(*) FROM agent_runs WHERE company_id=$1)::int runs",[company])).rows[0];assert.deepEqual(counts,{reviews:0,hosts:0,provisions:0,runs:0});assert.doesNotMatch(JSON.stringify(result),/"token"|token_hash|Bearer |ca_[A-Za-z0-9_-]{30}/);
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,reviewer,member,outsider]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}
});

function requestWithoutClient(request:Record<string,unknown>){const {clientId:_,...fields}=request;return fields;}
