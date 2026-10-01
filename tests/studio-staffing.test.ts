import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {STUDIO_STAFFING_CAPABILITIES,STUDIO_STAFFING_ROLE_KEYS,STUDIO_PLANNING_REVIEW_CAPABILITIES,STUDIO_PLANNING_REVIEW_INSTRUCTIONS,draftStudioStaffing,studioStaffingPlanInput,studioStaffingApplyInput} from '../src/lib/studio-staffing-protocol';
import {proposeStudioStaffing} from '../src/lib/studio-staffing';

const provider={pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8',maxSteps:8,maxOutputTokens:2048,maxTotalTokens:24000,timeoutSeconds:180}};
const input=(extra:Record<string,unknown>={})=>({brief:'A synthetic boutique studio that prepares compositing work with independent review.',teamSize:2,disciplines:['compositing'],reviewerHumanId:null,provider,...extra});
const required=['producer','coordinator','supervisor','ingest','comp','delivery'];

test('staffing planning has concrete identities, useful department grouping and independent human QC',()=>{
 const draft=draftStudioStaffing(input());assert.equal(draft.specialists.length,2);
 assert.deepEqual(draft.specialists[0].roleKeys,['producer','coordinator','delivery']);
 assert.deepEqual(draft.specialists[1].roleKeys,['supervisor','ingest','comp']);
 assert.deepEqual(draft.specialists.flatMap(s=>s.roleKeys).sort(),[...required].sort());
 assert(draft.specialists.every(s=>!s.roleKeys.includes('qc')));
 for(const specialist of draft.specialists){assert(specialist.skills.length);assert(specialist.skills.every(skill=>specialist.skillKeys.includes(skill.key)&&skill.version===1&&skill.instructions.length>30));assert.match(specialist.character.persona,/independent human review/);assert(specialist.character.persona.length<=1600);}
 const full=draftStudioStaffing(input({teamSize:11,disciplines:['prep','matchmove','layout','animation','fx','lighting','compositing']}));assert.equal(full.specialists.length,10);assert.equal(full.specialists.flatMap(s=>s.roleKeys).length,10);
 const six=draftStudioStaffing(input({teamSize:6,disciplines:['prep','matchmove','layout','animation','fx','lighting','compositing']}));assert(six.specialists.some(s=>s.roleKeys.join(',')==='producer,coordinator,delivery'));assert(six.specialists.some(s=>s.roleKeys.join(',')==='ingest,prep'));assert(six.specialists.some(s=>s.roleKeys.join(',')==='lighting,comp'));
 assert.equal(studioStaffingPlanInput.parse(input()).reviewerHumanId,null);
});

test('custom harness staffing cannot duplicate, omit, invent or assign quality review to agent roles',()=>{
 const valid={name:'Fixture specialist',roleKeys:required};assert.equal(draftStudioStaffing(input({teamSize:1,specialists:[valid]})).specialists.length,1);
 for(const specialists of [[{...valid,roleKeys:['qc',...required]}],[{...valid,roleKeys:required.slice(1)}],[valid,valid],[{...valid,roleKeys:[...required,'root-admin']}],[{...valid,roleKeys:[...required,'producer']}]])assert.throws(()=>draftStudioStaffing(input({specialists})));
 assert.throws(()=>draftStudioStaffing(input({teamSize:1,specialists:[{name:'A',roleKeys:['producer']},{name:'B',roleKeys:required.slice(1)}]})));
 assert.throws(()=>draftStudioStaffing(input({teamSize:2,specialists:[{name:'A',roleKeys:['producer'],existingAgentId:'00000000-0000-4000-8000-000000000001'},{name:'B',roleKeys:required.slice(1),existingAgentId:'00000000-0000-4000-8000-000000000001'}]})));
});

test('optional planning reviewer reserves one distinct slot without changing the production template or default plan',()=>{
 const ordinary=draftStudioStaffing(input());assert.equal(Object.hasOwn(ordinary.data,'planningReviewer'),false);assert.equal(ordinary.specialists.length,2);
 const review={name:'Fixture planning reviewer',persona:'Review evidence carefully.'},draft=draftStudioStaffing(input({teamSize:3,planningReviewer:review}));assert.equal(draft.specialists.length,2);assert.deepEqual(draft.specialists.flatMap(person=>person.roleKeys).sort(),[...required].sort());assert.deepEqual(STUDIO_PLANNING_REVIEW_CAPABILITIES,['studio.read','studio.review']);assert.equal(STUDIO_PLANNING_REVIEW_INSTRUCTIONS.version,1);
 assert.throws(()=>draftStudioStaffing(input({teamSize:1,planningReviewer:review})),/at least two/);
 assert.throws(()=>draftStudioStaffing(input({planningReviewer:review,specialists:[{name:'A',roleKeys:required.slice(0,3)},{name:'B',roleKeys:required.slice(3)}]})),/separate slot/);
 assert.throws(()=>draftStudioStaffing(input({planningReviewer:{name:'Studio coordinator'}})),/distinct name/);
 for(const extra of [{existingAgentId:randomUUID()},{capabilities:['studio.execute']},{roleKeys:['qc']},{persona:'x'.repeat(501)}])assert.equal(studioStaffingPlanInput.safeParse(input({planningReviewer:{...review,...extra}})).success,false);
 const full=draftStudioStaffing(input({teamSize:11,disciplines:['prep','matchmove','layout','animation','fx','lighting','compositing'],planningReviewer:review}));assert.equal(full.specialists.length,10);assert(full.specialists.every(person=>!person.roleKeys.includes('qc')));
});

test('staffing schemas reject privilege, private-skill and credential injection',()=>{
 for(const patch of [{teamSize:0},{teamSize:12},{capabilities:['*']},{providerToken:'fixture'},{reviewerAgentId:randomUUID()},{copyPrivateVault:true},{status:'active'},{specialists:[{name:'A',roleKeys:required,capabilities:['studio.execute']}]}])assert.equal(studioStaffingPlanInput.safeParse(input(patch)).success,false);
 const apply={clientId:randomUUID(),revision:1,planHash:'a'.repeat(64),profileRevision:0};assert(studioStaffingApplyInput.safeParse(apply).success);
 for(const patch of [{planHash:'a'},{profileRevision:-1},{approvedCapabilities:['*']},{startWorkers:true},{token:'fixture'},{reviewerHumanId:randomUUID()}])assert.equal(studioStaffingApplyInput.safeParse({...apply,...patch}).success,false);
 assert.deepEqual(STUDIO_STAFFING_CAPABILITIES,['studio.read','studio.write','tasks.write']);
});

test('staffing human API and generated agent tool schemas describe the same optional reviewer and immutable result',async()=>{
 const {agentRuntimeOpenApi}=await import('../src/lib/agent-runtime-openapi'),spec:any=agentRuntimeOpenApi;
 const human=spec.paths['/api/companies/{companyId}/studio/staffing/proposals'].post.requestBody.content['application/json'].schema;
 const tool=spec.paths['/api/agent/tools/studio_staffing_propose'].post.requestBody.content['application/json'].schema.properties.arguments;
 for(const schema of [human,tool]){assert(!schema.required.includes('planningReviewer'));const reviewer=schema.properties.planningReviewer;assert.equal(reviewer.additionalProperties,false);assert.deepEqual(reviewer.required,['name']);assert.equal(reviewer.properties.name.minLength,1);assert.equal(reviewer.properties.name.maxLength,80);assert.equal(reviewer.properties.persona.maxLength,500);assert.match(reviewer.description,/separately approved/);for(const key of ['capabilities','existingAgentId','roleKeys','status'])assert.equal(key in reviewer.properties,false);}
 for(const schema of [human,tool]){const role=schema.properties.specialists.items.properties.roleKeys.items;assert.deepEqual(role.enum,STUDIO_STAFFING_ROLE_KEYS);assert(!role.enum.includes('qc'));assert.match(role.description,/independent human/);}
 assert.deepEqual(human.properties.planningReviewer,tool.properties.planningReviewer);
 const schemas=spec.components.schemas,plan=schemas.StudioStaffingPlan,application=schemas.StudioStaffingApplication;
 for(const schema of [plan,application]){assert.equal(schema.additionalProperties,false);assert(!schema.required.includes('planningReviewer'));assert(schema.required.includes('specialists'));const pinned=schema.properties.planningReviewer.allOf[1].properties;assert.deepEqual(pinned.roleKeys.const,[]);assert.deepEqual(pinned.capabilities.const,['studio.read','studio.review']);assert.equal(pinned.mode.const,'create');}
 assert.equal(plan.properties.templateVersion.const,1);assert.equal(application.properties.planningReviewer.allOf[1].properties.status.const,'paused');
 const apply=spec.paths['/api/companies/{companyId}/studio/staffing/proposals/{proposalId}/apply'].post;assert.deepEqual(apply.security,[{sessionCookie:[]}]);assert.equal(apply.responses['201'].content['application/json'].schema.properties.application.$ref,'#/components/schemas/StudioStaffingApplication');
});

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integrationUrl=process.env.COATRIA_INTEGRATION_DATABASE_URL;
test('staffing uses real authority, reviewed grant snapshots and an atomic idempotent identity application',{skip:!emulate&&!integrationUrl,timeout:120000},async t=>{
 const {handleApi}=await import('../src/lib/api');
 const prior={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX};process.env.DATABASE_URL=integrationUrl;process.env.DATABASE_POOL_MAX=emulate?'1':'10';let stop:(()=>Promise<void>)|undefined;
 if(emulate){const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();const url=new URL('postgresql://'+server.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;stop=async()=>{await server.stop();await db.close();};}
 const company=randomUUID(),foreign=randomUUID(),owner=randomUUID(),reviewer=randomUUID(),member=randomUUID(),outsider=randomUUID(),sessions={owner:randomUUID(),reviewer:randomUUID(),member:randomUUID(),outsider:randomUUID()};
 const ids={owner,reviewer,member,outsider},origin='http://localhost:4180',prefix=`companies/${company}/studio/staffing/proposals`;let agentToken='';
 type Actor=keyof typeof sessions|'anonymous'|'agent';
 async function call(path:string,method='GET',payload?:unknown,actor:Actor='owner',expected:number|number[]=200){const headers:Record<string,string>={Origin:origin};if(actor==='agent')headers.Authorization='Bearer '+agentToken;else if(actor!=='anonymous')headers.Cookie='coatria_session='+sessions[actor];if(payload!==undefined)headers['Content-Type']='application/json';const response=await handleApi(new Request(origin+'/api/'+path,{method,headers,...(payload===undefined?{}:{body:JSON.stringify(payload)})}),path.split('?')[0].split('/'));const result=await response.json();assert((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${path}: got ${response.status}, code ${result.code??''}, error ${result.error??''}`);return result;}
 const proposal=(extra:Record<string,unknown>={})=>call(prefix,'POST',{clientId:randomUUID(),...input({reviewerHumanId:reviewer,...extra})},'owner',201);
 const approval=(p:any)=>({clientId:randomUUID(),revision:p.revision,planHash:p.planHash,profileRevision:p.profileRevision});
 const countAgents=async()=>Number((await query('SELECT count(*) FROM agents WHERE company_id=$1',[company])).rows[0].count);
 let first:any,applied:any,firstInstall:any;
 try{
  for(const [actor,userId]of Object.entries(ids))await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'Staffing fixture '+actor,userId+'@example.invalid','fixture']);
  for(const [companyId,name]of [[company,'Staffing company'],[foreign,'Foreign company']])await query("INSERT INTO companies(id,name,slug,template) VALUES($1,$2,$3,'blank')",[companyId,name,companyId]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[company,owner,reviewer,member,foreign,outsider]);
  for(const [actor,userId]of Object.entries(ids))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(sessions[actor as keyof typeof sessions]),userId]);
  await t.test('tenant-scoped administrators propose; solo-owner setup can leave QC explicitly unassigned',async()=>{
   await call(prefix,'GET',undefined,'anonymous',401);await call(prefix,'GET',undefined,'member',403);await call(prefix,'GET',undefined,'outsider',404);
   const payload={clientId:randomUUID(),...input({reviewerHumanId:null})};const created=await call(prefix,'POST',payload,'owner',201);assert.equal(created.proposal.plan.reviewer,null);assert(created.proposal.plan.warnings.some((w:string)=>/QC is unassigned/.test(w)));assert.equal(await countAgents(),0);
   const replay=await call(prefix,'POST',payload);assert.equal(replay.proposal.id,created.proposal.id);assert.equal(replay.replayed,true);await call(prefix,'POST',{...payload,teamSize:3},'owner',409);
   await call(prefix,'POST',{...payload,clientId:randomUUID(),reviewerHumanId:owner},'owner',409);await call(prefix,'POST',{...payload,clientId:randomUUID(),reviewerHumanId:member},'owner',403);await call(prefix,'POST',{...payload,clientId:randomUUID(),reviewerHumanId:outsider},'owner',403);
   await call(prefix,'POST',{...payload,clientId:randomUUID(),provider:{...provider,pluginId:'unknown-plugin'}},'owner',400);
   await call(`companies/${foreign}/studio/staffing/proposals/${created.proposal.id}`,'GET',undefined,'outsider',404);
   await call(prefix+'?after='+randomUUID(),'GET',undefined,'owner',404);
   const foreignPrefix=`companies/${foreign}/studio/staffing/proposals`,solo=(await call(foreignPrefix,'POST',{clientId:randomUUID(),...input()},'outsider',201)).proposal,soloApply=approval(solo);
   const results=await Promise.all([call(`${foreignPrefix}/${solo.id}/apply`,'POST',soloApply,'outsider',[200,201]),call(`${foreignPrefix}/${solo.id}/apply`,'POST',soloApply,'outsider',[200,201])]);assert.equal(results.filter(result=>result.replayed).length,1);assert.equal(Number((await query('SELECT count(*) FROM agents WHERE company_id=$1',[foreign])).rows[0].count),2);assert.equal((await call(`companies/${foreign}/studio`,'GET',undefined,'outsider')).profile.roles.find((r:any)=>r.key==='qc').humanId,null);
  });
  await t.test('exact human approval creates only scoped paused identities, installs shared personas and replays without duplicates or secrets',async()=>{
   first=(await proposal()).proposal;const request=approval(first);
   await call(`${prefix}/${first.id}/apply`,'POST',{...request,planHash:'f'.repeat(64)},'owner',409);await call(`${prefix}/${first.id}/apply`,'POST',{...request,revision:2},'owner',409);await call(`${prefix}/${first.id}/apply`,'POST',{...request,profileRevision:1},'owner',409);await call(`${prefix}/${first.id}/apply`,'POST',request,'member',403);assert.equal(await countAgents(),0);
   applied=await call(`${prefix}/${first.id}/apply`,'POST',request,'owner',201);assert.equal(applied.application.specialists.length,2);assert.equal(applied.application.startsWorkers,false);assert.equal(applied.application.startsInference,false);assert.equal(applied.application.credentialDelivery,'not_issued');assert.equal(await countAgents(),2);
   assert(applied.application.specialists.every((s:any)=>s.status==='paused'&&s.connectionState==='unconnected'&&s.credentialState==='not_issued'&&JSON.stringify(s.capabilities)===JSON.stringify(STUDIO_STAFFING_CAPABILITIES)));
   const replay=await call(`${prefix}/${first.id}/apply`,'POST',request);assert.equal(replay.replayed,true);assert.deepEqual(replay.application,applied.application);assert.equal(await countAgents(),2);
   await call(`${prefix}/${first.id}/apply`,'POST',{...request,clientId:randomUUID()},'owner',409);
   const stored=(await query('SELECT result::text FROM studio_staffing_applications WHERE company_id=$1',[company])).rows[0].result;assert.doesNotMatch(stored,/"token"|token_hash|Bearer |ca_[A-Za-z0-9_-]{30}/);
   const installs=(await call(`companies/${company}/plugin-installations`)).installations;assert.equal(installs.length,2);firstInstall=installs[0];for(const install of installs){assert.equal(install.invocationAccess,'admins');assert.equal(install.status,'paused');assert.match(install.character.persona,/curated shared skills/);assert(install.character.persona.length<=1600);}
   const studio=await call(`companies/${company}/studio`);assert.equal(studio.profile.roles.find((r:any)=>r.key==='qc').humanId,reviewer);assert.equal(studio.profile.roles.filter((r:any)=>r.agentId).length,6);
   const another=(await proposal()).proposal;await call(`${prefix}/${another.id}/apply`,'POST',{...approval(another),clientId:request.clientId},'owner',409);
  });
  await t.test('existing agents retain disclosed grants and a changed configuration invalidates the pending access plan',async()=>{
   const spec={teamSize:1,specialists:[{name:'Requested alias never renames an existing identity',roleKeys:required,existingAgentId:firstInstall.agentId}]};const old=(await proposal(spec)).proposal;assert.equal(old.plan.specialists[0].mode,'bind');assert.equal(old.plan.specialists[0].name,firstInstall.name);
   await call(`companies/${company}/plugin-installations/${firstInstall.id}`,'PATCH',{revision:firstInstall.revision,capabilities:[...STUDIO_STAFFING_CAPABILITIES,'workspace.read']});
   const changed=await call(`${prefix}/${old.id}/apply`,'POST',approval(old),'owner',409);assert.equal(changed.code,'STAFFING_AGENT_CHANGED');assert.equal(await countAgents(),2);
   const fresh=(await proposal(spec)).proposal;assert(fresh.plan.warnings.some((w:string)=>/broader grants/.test(w)));assert(fresh.plan.specialists[0].capabilities.includes('workspace.read'));
   const result=await call(`${prefix}/${fresh.id}/apply`,'POST',approval(fresh),'owner',201);assert.equal(result.application.specialists[0].agentId,firstInstall.agentId);assert.equal(result.application.specialists[0].connectionState,'unverified');assert.equal(await countAgents(),2);
   assert.deepEqual((await call(`companies/${company}/plugin-installations/${firstInstall.id}`)).installation.capabilities,[...STUDIO_STAFFING_CAPABILITIES,'workspace.read'].sort());
   await proposal({...spec,specialists:[{name:'Foreign reference',roleKeys:required,existingAgentId:randomUUID()}]}).then(()=>assert.fail('Unknown existing agent must be rejected'),error=>assert.match(String(error),/404/));
  });
  await t.test('stale structure, changed reviewer authority and expiry roll back the entire application before any new identity appears',async()=>{
   const pending=(await proposal()).proposal,snapshot=await call(`companies/${company}/studio`);
   await call(`companies/${company}/studio/setup`,'POST',{clientId:randomUUID(),templateId:'vfx-boutique',templateVersion:1,revision:snapshot.profile.revision,assignments:[]},'owner',201);
   const stale=await call(`${prefix}/${pending.id}/apply`,'POST',approval(pending),'owner',409);assert.equal(stale.code,'STUDIO_REVISION_CONFLICT');assert.equal(await countAgents(),2);
   const reviewerSponsor=(await proposal()).proposal;await call(`${prefix}/${reviewerSponsor.id}/apply`,'POST',approval(reviewerSponsor),'reviewer',409);assert.equal(await countAgents(),2);
   const expired=(await proposal()).proposal;await query("UPDATE studio_staffing_proposals SET expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND id=$2",[company,expired.id]);assert.equal((await call(`${prefix}/${expired.id}/apply`,'POST',approval(expired),'owner',409)).code,'STAFFING_PROPOSAL_EXPIRED');
   const changed=(await proposal()).proposal;await query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);await call(`${prefix}/${changed.id}/apply`,'POST',approval(changed),'owner',403);await query("UPDATE memberships SET role='admin' WHERE company_id=$1 AND user_id=$2",[company,reviewer]);assert.equal(await countAgents(),2);
  });
  await t.test('an authenticated leased harness can propose actual staffing; cancellation removes authority to apply it',async()=>{
   let current=(await call(`companies/${company}/plugin-installations/${firstInstall.id}`)).installation;current=(await call(`companies/${company}/plugin-installations/${firstInstall.id}`,'PATCH',{revision:current.revision,status:'active'})).installation;
   const rotated=await call(`companies/${company}/plugin-installations/${firstInstall.id}/rotate`,'POST',{revision:current.revision,expiresInDays:30});agentToken=rotated.token;assert(agentToken);
   const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:firstInstall.agentId,prompt:'Propose a synthetic staffing plan without applying it.'},'owner',201)).run;
   const lease=await call('agent/runs/claim','POST',{workerId:'staffing-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,run.id);
   const {authenticateAgent}=await import('../src/lib/integrations'),{authorizeRunTool}=await import('../src/lib/agent-runs');
   const identity=await authenticateAgent(new Request(origin+'/api/agent/identity',{headers:{Authorization:'Bearer '+agentToken}}));
   const payload={clientId:randomUUID(),...input({reviewerHumanId:null})};
   const proposed=await transaction(async client=>{await authorizeRunTool(client,identity,run.id,lease.leaseToken);return proposeStudioStaffing(client,{companyId:company,userId:owner,agentId:firstInstall.agentId,runId:run.id,agentSponsorId:owner},payload);});assert.equal(proposed.proposal.createdAgentId,firstInstall.agentId);assert.equal(proposed.proposal.plan.actualAgentCount,2);assert.equal(await countAgents(),2);
   await call(`companies/${company}/agent-runs/${run.id}/cancel`,'POST',{});assert.equal((await call(`${prefix}/${proposed.proposal.id}/apply`,'POST',approval(proposed.proposal),'owner',409)).code,'STAFFING_SOURCE_UNAVAILABLE');assert.equal(await countAgents(),2);
  });
  await t.test('an administrator can reject a proposal without touching identities or role bindings',async()=>{
   const pending=(await proposal({reviewerHumanId:null})).proposal;const result=await call(`${prefix}/${pending.id}/reject`,'POST',{revision:pending.revision,planHash:pending.planHash,note:'Synthetic fixture: reconsider staffing.'});assert.equal(result.proposal.status,'rejected');await call(`${prefix}/${pending.id}/apply`,'POST',approval(pending),'owner',409);assert.equal(await countAgents(),2);
  });
  await t.test('the real leased staffing tool can finish a proposal and a human applies its exact plan without starting another run',async()=>{
   const run=(await call(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:firstInstall.agentId,prompt:'Create the final synthetic staffing proposal, leaving quality review unassigned.'},'owner',201)).run;
   const lease=await call('agent/runs/claim','POST',{workerId:'staffing-fixture',claimId:randomUUID()},'agent');assert.equal(lease.run.id,run.id);
   const requestId=randomUUID(),toolRequest={runId:run.id,leaseToken:lease.leaseToken,requestId,arguments:input()};
   const tool=await call('agent/tools/studio_staffing_propose','POST',toolRequest,'agent');const p=tool.result.proposal;assert.equal(p.createdAgentId,firstInstall.agentId);assert.equal(p.plan.newAgentCount,2);
   const replay=await call('agent/tools/studio_staffing_propose','POST',toolRequest,'agent');assert.equal(replay.replayed,true);assert.equal(replay.result.proposal.id,p.id);
   await call(`${prefix}/${p.id}/apply`,'POST',approval(p),'agent',401);
   await call(`agent/runs/${run.id}/complete`,'POST',{leaseToken:lease.leaseToken,clientId:randomUUID(),result:'Synthetic staffing plan awaits human approval. No workers or media processing started.'},'agent');
   const result=await call(`${prefix}/${p.id}/apply`,'POST',approval(p),'owner',201);assert.equal(result.application.specialists.length,2);assert(result.application.specialists.every((s:any)=>s.status==='paused'&&s.credentialState==='not_issued'));assert.equal(await countAgents(),4);assert.equal((await call(`companies/${company}/studio`)).profile.roles.find((r:any)=>r.key==='qc').humanId,null);
   assert.equal(Number((await query("SELECT count(*) FROM agent_runs WHERE company_id=$1 AND status IN ('queued','running')",[company])).rows[0].count),0);
  });
  await t.test('a reviewed optional planning reviewer is a distinct paused installation with exact grants and no automatic policy or worker',async()=>{
   const before=await countAgents(),legacy=(await proposal()).proposal;assert.equal(Object.hasOwn(legacy.plan,'planningReviewer'),false);assert.equal(legacy.plan.templateVersion,1);
   const data={clientId:randomUUID(),...input({teamSize:3,reviewerHumanId:reviewer,planningReviewer:{name:'Dedicated planning reviewer',persona:'Check assumptions and cite the pinned evidence.'}})};
   await call(prefix,'POST',data,'member',403);const p=(await call(prefix,'POST',data,'owner',201)).proposal;assert.equal(await countAgents(),before);assert.equal(p.plan.actualAgentCount,3);assert.equal(p.plan.newAgentCount,3);assert.equal(p.plan.specialists.length,2);assert.deepEqual(p.plan.planningReviewer.roleKeys,[]);assert.deepEqual(p.plan.planningReviewer.capabilities,[...STUDIO_PLANNING_REVIEW_CAPABILITIES]);assert(p.plan.warnings.some((warning:string)=>/shared-sponsor/.test(warning)));assert.deepEqual(p.plan.planningReviewer.skills,[STUDIO_PLANNING_REVIEW_INSTRUCTIONS]);
   const replay=(await call(prefix,'POST',data)).proposal;assert.equal(replay.planHash,p.planHash);await call(prefix,'POST',{...data,planningReviewer:{name:'Changed reviewer'}},'owner',409);
   const request=approval(p);await call(`${prefix}/${p.id}/apply`,'POST',{...request,planHash:legacy.planHash},'owner',409);assert.equal(await countAgents(),before);
   const applied=await call(`${prefix}/${p.id}/apply`,'POST',request,'owner',201),identity=applied.application.planningReviewer;assert(identity);assert.equal(applied.application.specialists.length,2);assert.equal(new Set([...applied.application.specialists.map((person:any)=>person.agentId),identity.agentId]).size,3);assert.equal(identity.status,'paused');assert.equal(identity.connectionState,'unconnected');assert.equal(identity.credentialState,'not_issued');assert.deepEqual(identity.roleKeys,[]);assert.deepEqual(identity.capabilities,[...STUDIO_PLANNING_REVIEW_CAPABILITIES]);assert.equal(await countAgents(),before+3);
   assert.deepEqual((await call(`${prefix}/${p.id}/apply`,'POST',request)).application,applied.application);assert.equal(await countAgents(),before+3);
   const installed=(await call(`companies/${company}/plugin-installations/${identity.installationId}`)).installation;assert.equal(installed.status,'paused');assert.deepEqual(installed.capabilities,[...STUDIO_PLANNING_REVIEW_CAPABILITIES]);assert.equal(installed.invocationAccess,'admins');assert.match(installed.character.persona,/Role instructions v1/);assert(installed.character.persona.includes(STUDIO_PLANNING_REVIEW_INSTRUCTIONS.instructions));assert.equal(installed.runtimeConfig.modelId,provider.runtimeConfig.modelId);
   const studio=await call(`companies/${company}/studio`);assert.equal(studio.profile.templateId,'vfx-boutique');assert(studio.profile.roles.every((role:any)=>role.agentId!==identity.agentId));assert.equal(studio.profile.roles.find((role:any)=>role.key==='qc').humanId,reviewer);
   const counts=(await query('SELECT (SELECT count(*) FROM studio_review_policies WHERE company_id=$1)::int policies,(SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1)::int hosts,(SELECT count(*) FROM studio_host_provisions WHERE company_id=$1)::int provisions,(SELECT count(*) FROM agent_runs WHERE company_id=$1 AND status IN (\'queued\',\'running\'))::int runs',[company])).rows[0];assert.deepEqual(counts,{policies:0,hosts:0,provisions:0,runs:0});assert.doesNotMatch(JSON.stringify(applied),/"token"|token_hash|Bearer |ca_[A-Za-z0-9_-]{30}/);
  });
 }finally{try{await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[[company,foreign]]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,reviewer,member,outsider]]);}finally{await database().end();delete(globalThis as any).coatriaPool;await stop?.();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}
});
