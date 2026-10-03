import {test,expect,type Page} from '@playwright/test';
import {studioCoordinationInput,type StudioCoordinationPolicy,type StudioCoordinationSnapshot} from '../../src/lib/studio-coordination-protocol';
import {generatedFixture,mockGenerated,openGenerated,noOverflow,ids,uuid,date} from './studio-generated-fixture';

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Synthetic fixtures require a local origin.');});
const coordinator=uuid(70),specialist=uuid(71),option='Allow verified generated output continuations',generationOption='Let the coordinator also handle generation',mediaOption='Allow one correction per rejected media version';
const review=(page:Page)=>page.getByRole('checkbox',{name:/^I reviewed the coordinator/});
const policyWrites=(fixture:ReturnType<typeof coordinationFixture>)=>fixture.state.writes.filter(write=>write.path.endsWith('/coordination'));
function coordinationFixture({enabled,generation,media,singleAgent=false,legacy=false,policy=true,reference=false}:{enabled?:boolean;generation?:boolean;media?:boolean;singleAgent?:boolean;legacy?:boolean;policy?:boolean;reference?:boolean}={}){
 const state=generatedFixture();
 for(const role of state.detail.roles){if(role.key==='producer'){role.agentId=coordinator;role.humanId=null;role.agentName='Production coordinator';}if(role.key==='comp'){role.agentId=singleAgent?coordinator:specialist;role.humanId=null;role.agentName=singleAgent?'Production coordinator':'Generation specialist';}}
 if(reference){state.detail.workItems[0].stage='references';state.detail.workItems[0].execution='agent';}
 state.detail.workItems[0].agentId=singleAgent?coordinator:specialist;state.detail.workItems[0].humanId=null;
 const initial:StudioCoordinationPolicy={projectId:legacy?state.legacy.id:ids.project,coordinatorAgentId:coordinator,allowedRoleKeys:['comp'],status:'active',effectiveStatus:'active',blocker:null,revision:4,maxRuns:5,runsStarted:2,remainingRuns:3,maxConcurrentRuns:1,approvedBy:ids.user,expiresAt:'2027-01-01T00:00:00.000Z',updatedAt:date,profileRevision:1,...enabled!==undefined?{generatedContinuations:enabled}:{},...generation!==undefined?{coordinatorGeneration:generation}:{},...media!==undefined?{mediaRework:media}:{}};
 const snapshot:StudioCoordinationSnapshot={policy:policy?initial:null,dispatches:[],budgetUnit:'specialist_runs',budgetScope:'coordinator_dispatched_runs_only',startsWorkers:false,startsInference:false};
 let failNext=false,commitBeforeFailure=false;
 state.handler=async(route,url)=>{
  if(url.pathname.endsWith('/workspace')){
   await route.fulfill({json:{company:state.company,rooms:[],members:[{...state.user,userId:state.user.id,role:state.company.role}],agents:(singleAgent?[coordinator]:[coordinator,specialist]).map((id,index)=>({id,name:index?'Generation specialist':'Production coordinator',pluginInstallationId:uuid(72+index),harness:'codex',status:'active',description:'Synthetic fixture',capabilities:['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'],createdBy:ids.user,lastSeenAt:date})),tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]}});return true;
  }
  if(legacy&&url.pathname.endsWith('/'+state.legacy.id)){
   await route.fulfill({json:{...state.detail,project:state.legacy,shots:[]}});return true;
  }
  if(!url.pathname.endsWith('/coordination'))return false;
  if(route.request().method()==='PUT'){
   const body=studioCoordinationInput.parse(route.request().postDataJSON());
   if(failNext){failNext=false;if(commitBeforeFailure)snapshot.policy={...initial,...body,revision:body.revision+1,effectiveStatus:body.status};await route.fulfill({status:503,json:{error:'Synthetic lost acknowledgement. Retry the reviewed request.'}});return true;}
   snapshot.policy={...initial,...body,revision:body.revision+1,effectiveStatus:body.status,remainingRuns:body.maxRuns-initial.runsStarted};
  }
  await route.fulfill({json:snapshot});return true;
 };
 return {state,snapshot,failOnce:(committed=false)=>{failNext=true;commitBeforeFailure=committed;}};
}
async function openCoordination(page:Page,fixture:ReturnType<typeof coordinationFixture>,legacy=false){
 await mockGenerated(page,fixture.state);
 if(legacy){await page.goto('/#studio');await page.getByRole('button').filter({has:page.getByRole('heading',{name:fixture.state.legacy.name,exact:true})}).click();}
 else await openGenerated(page,fixture.state);
 await page.getByRole('tab',{name:'Coordination',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Project delegation policy',exact:true})).toBeVisible();
}

test('generated coordinator setup sends an explicit profile paused and retains its exact uncertain retry',async({page},testInfo)=>{
 const fixture=coordinationFixture(),previous=fixture.state.handler,profile={kind:'studio_generated_coordinator',version:1,projectId:ids.project};let attempts=0;
 fixture.state.handler=async(route,url)=>{if(url.pathname.endsWith('/autonomy/missions')&&route.request().method()==='POST'){attempts++;if(attempts===1)await route.fulfill({status:503,json:{error:'Synthetic lost acknowledgement. Retry this exact mission.'}});else await route.fulfill({status:201,json:{mission:{id:uuid(120),status:'paused',inferenceProfile:profile},replayed:true}});return true;}return await previous?.(route,url)||false;};
 await openCoordination(page,fixture);await page.getByRole('button',{name:'Schedule coordinator',exact:true}).click();const dialog=page.getByRole('dialog'),preview=dialog.getByRole('region',{name:'Inference profile to save',exact:true});
 await expect(preview).toContainText('Generated studio coordinator · v1');await expect(preview).toContainText(ids.project);await expect(preview).toContainText('Existing permissions, budgets and human approvals still apply');await expect(dialog.getByLabel('Coordinator objective')).toHaveValue(/^Generated coordinator v6\./);await preview.screenshot({path:testInfo.outputPath('coordinator-profile-preview.png')});
 await dialog.getByRole('button',{name:'Create paused coordinator',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Synthetic lost acknowledgement');await dialog.getByRole('button',{name:'Create paused coordinator',exact:true}).click();await expect(dialog.getByRole('region',{name:'Saved inference profile',exact:true})).toContainText(ids.project);await expect(dialog).toContainText('Coordinator mission saved as paused');
 const writes=fixture.state.writes.filter(write=>write.path.endsWith('/autonomy/missions'));expect(writes).toHaveLength(2);expect(writes[1].body).toEqual(writes[0].body);expect(writes[0].body).toMatchObject({agentId:coordinator,status:'paused',inferenceProfile:profile});expect(writes[0].body.clientId).toMatch(/^[a-f0-9-]{36}$/);expect(fixture.state.unexpected).toEqual([]);
});

test('legacy studio coordinator setup and saved profile remain general',async({page})=>{
 const fixture=coordinationFixture({legacy:true}),previous=fixture.state.handler;
 fixture.state.handler=async(route,url)=>{if(url.pathname.endsWith('/autonomy/missions')&&route.request().method()==='POST'){await route.fulfill({status:201,json:{mission:{id:uuid(121),status:'paused',inferenceProfile:null}}});return true;}return await previous?.(route,url)||false;};
 await openCoordination(page,fixture,true);await page.getByRole('button',{name:'Schedule coordinator',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('region',{name:'Inference profile to save'})).toContainText('General mission · no specialized inference profile');await dialog.getByRole('button',{name:'Create paused coordinator',exact:true}).click();await expect(dialog.getByRole('region',{name:'Saved inference profile'})).toContainText('General mission · no specialized inference profile');
 const writes=fixture.state.writes.filter(write=>write.path.endsWith('/autonomy/missions'));expect(writes).toHaveLength(1);expect(writes[0].body.status).toBe('paused');expect(writes[0].body).not.toHaveProperty('inferenceProfile');expect(fixture.state.unexpected).toEqual([]);
});

test('coordinator success displays the returned profile rather than its request preview',async({page})=>{
 const fixture=coordinationFixture(),previous=fixture.state.handler;
 fixture.state.handler=async(route,url)=>{if(url.pathname.endsWith('/autonomy/missions')&&route.request().method()==='POST'){await route.fulfill({status:201,json:{mission:{id:uuid(122),status:'paused',inferenceProfile:null}}});return true;}return await previous?.(route,url)||false;};
 await openCoordination(page,fixture);await page.getByRole('button',{name:'Schedule coordinator',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('region',{name:'Inference profile to save'})).toContainText('Generated studio coordinator · v1');await dialog.getByRole('button',{name:'Create paused coordinator',exact:true}).click();await expect(dialog.getByRole('region',{name:'Saved inference profile'})).toContainText('General mission · no specialized inference profile');await expect(dialog.getByText('Generated studio coordinator · v1',{exact:true})).toHaveCount(0);
});

function addMediaCorrection(fixture:ReturnType<typeof coordinationFixture>){
 fixture.state.artifact.reviewStatus='changes_requested';fixture.state.detail.artifacts=[fixture.state.artifact];
 fixture.state.detail.workItems[0].status='review';fixture.state.detail.workItems[0].revision=8;
 fixture.snapshot.mediaReworks=[{projectId:ids.project,workItemId:ids.work,reviewId:uuid(110),taskId:ids.task,taskRevision:8,artifactId:ids.artifact,artifactVersion:1,manifestSha256:fixture.state.artifact.manifestSha256,specSha256:fixture.state.artifact.specSha256,roundId:uuid(111),sourceChildRunId:uuid(112),specialistAgentId:specialist,reviewedBy:ids.user,reviewedAt:date,reviewNote:'Keep the approved framing. Remove the stray edge on the product before the next independent review.'}];
 return fixture.snapshot.mediaReworks[0];
}

test('generated continuations start off, require renewed review, retry exactly and survive policy pause',async({page},testInfo)=>{
 const fixture=coordinationFixture({policy:false});await openCoordination(page,fixture);
 await expect(page.getByText(/Verified generated output continuations:/)).toContainText('Off');
 await page.getByRole('button',{name:'Set delegation policy',exact:true}).click();
 const toggle=page.getByRole('checkbox',{name:option,exact:true});await expect(toggle).not.toBeChecked();
 await page.getByRole('checkbox',{name:/Generation specialist/}).check();
 await page.getByLabel('Policy state',{exact:true}).selectOption('active');
 await review(page).check();await expect(page.getByRole('button',{name:'Save reviewed policy',exact:true})).toBeEnabled();
 await toggle.check();await expect(review(page)).not.toBeChecked();await expect(page.getByRole('button',{name:'Save reviewed policy',exact:true})).toBeDisabled();
 await expect(page.getByRole('dialog')).toContainText('adds no generation, file transfer, or review authority');
 await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath('generated-continuations-mobile.png'),fullPage:true});
 await review(page).check();fixture.failOnce();await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Synthetic lost acknowledgement');
 await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 const saved=fixture.state.writes.filter(write=>write.path.endsWith('/coordination'));
 expect(saved).toHaveLength(2);expect(saved[1].body).toEqual(saved[0].body);expect(saved[0].body.generatedContinuations).toBe(true);expect(saved[0].body.revision).toBe(0);
 await expect(page.getByText(/Verified generated output continuations:/)).toContainText('Opted in');
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(toggle).toBeChecked();await review(page).check();await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Pause delegation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause delegation',exact:true})).toHaveCount(0);
 const writes=fixture.state.writes.filter(write=>write.path.endsWith('/coordination'));expect(writes[2].body.generatedContinuations).toBe(true);expect(writes[3].body).toMatchObject({generatedContinuations:true,status:'paused',maxRuns:saved[0].body.maxRuns});expect(fixture.state.unexpected).toEqual([]);
});

test('loaded false is preserved and changing a true opt-in back to false is explicit',async({page})=>{
 const fixture=coordinationFixture({enabled:false});await openCoordination(page,fixture);await page.getByRole('button',{name:'Review policy',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:option,exact:true})).not.toBeChecked();await review(page).check();await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(policyWrites(fixture)[0].body.generatedContinuations).toBe(false);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await page.getByRole('checkbox',{name:option,exact:true}).check();await review(page).check();await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(page.getByRole('checkbox',{name:option,exact:true})).toBeChecked();await page.getByRole('checkbox',{name:option,exact:true}).uncheck();await review(page).check();await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(policyWrites(fixture)[2].body.generatedContinuations).toBe(false);expect(fixture.state.unexpected).toEqual([]);
});

test('a background policy refresh keeps the exact reviewed revision and request identity after a lost acknowledgement',async({page})=>{
 await page.clock.install();const fixture=coordinationFixture({enabled:false});await openCoordination(page,fixture);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await page.getByRole('checkbox',{name:option,exact:true}).check();await review(page).check();fixture.failOnce(true);
 await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Synthetic lost acknowledgement');
 const readCount=fixture.state.reads.filter(url=>url.pathname.endsWith('/coordination')).length;
 await page.clock.fastForward(10_001);await expect.poll(()=>fixture.state.reads.filter(url=>url.pathname.endsWith('/coordination')).length).toBeGreaterThan(readCount);
 await expect(page.getByText(/Verified generated output continuations:/)).toContainText('Opted in');
 await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 const writes=policyWrites(fixture);expect(writes).toHaveLength(2);expect(writes[1].body).toEqual(writes[0].body);expect(writes[0].body.revision).toBe(4);expect(fixture.state.unexpected).toEqual([]);
});

test('legacy policy saves and pauses keep the original omitted-field contract',async({page})=>{
 const fixture=coordinationFixture({legacy:true});await openCoordination(page,fixture,true);
 await expect(page.getByText(/Verified generated output continuations:|Coordinator-owned generation:/)).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Internal QC corrections',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(page.getByRole('checkbox',{name:option,exact:true})).toHaveCount(0);await expect(page.getByRole('checkbox',{name:generationOption,exact:true})).toHaveCount(0);
 await expect(page.getByRole('checkbox',{name:mediaOption,exact:true})).toHaveCount(0);
 await review(page).check();await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Pause delegation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause delegation',exact:true})).toHaveCount(0);
 for(const write of policyWrites(fixture)){expect(write.body).not.toHaveProperty('generatedContinuations');expect(Object.keys(write.body).sort()).toEqual(['allowedRoleKeys','clientId','coordinatorAgentId','expiresAt','maxConcurrentRuns','maxRuns','revision','status'].sort());}
 expect(policyWrites(fixture)).toHaveLength(2);expect(fixture.state.unexpected).toEqual([]);
});

test('read-only members see generated continuation source history without policy controls',async({page})=>{
 const fixture=coordinationFixture({enabled:true,generation:true,singleAgent:true});fixture.state.company.role='member';
 fixture.snapshot.dispatches=[{workItemId:ids.work,parentRunId:uuid(80),childRunId:uuid(81),coordinatorAgentId:coordinator,specialistAgentId:coordinator,policyRevision:4,createdAt:date,status:'queued',archiveId:ids.archive,sourceChildRunId:uuid(82),artifactId:ids.artifact},{workItemId:ids.work,parentRunId:uuid(83),childRunId:uuid(82),coordinatorAgentId:coordinator,specialistAgentId:specialist,policyRevision:3,createdAt:date,status:'failed'}];
 await openCoordination(page,fixture);await expect(page.getByRole('button',{name:/Review policy|Set delegation policy|Pause delegation/})).toHaveCount(0);
 await expect(page.getByText('Verified generated output continuation',{exact:true})).toHaveCount(1);
 await expect(page.getByText(/Coordinator-owned generation:/)).toContainText('Opted in');await expect(page.getByText('Coordinator-owned continuation · separate request',{exact:true})).toHaveCount(1);
 const generated=page.getByRole('listitem').filter({has:page.getByText('Verified generated output continuation',{exact:true})});await generated.getByText('Request provenance',{exact:true}).click();
 await expect(generated).toContainText('Verified archive: '+ids.archive);await expect(generated).toContainText('Original specialist request: '+uuid(82));await expect(generated).toContainText('Registered artifact: '+ids.artifact);
 await page.setViewportSize({width:390,height:844});await noOverflow(page);expect(policyWrites(fixture)).toHaveLength(0);expect(fixture.state.unexpected).toEqual([]);
});

test('one agent can opt into its generation role with exact retry, successful-cycle explanation and unchanged limits',async({page},testInfo)=>{
 await page.clock.install();const fixture=coordinationFixture({singleAgent:true,policy:false});
 // An owned planning role remains ineligible even when generation is enabled.
 fixture.state.detail.workItems.push({...fixture.state.detail.workItems[0],id:uuid(90),taskId:uuid(91),title:'Producer planning',roleKey:'producer',stage:'estimate',execution:'agent'});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await openCoordination(page,fixture);await expect(page.getByText(/Coordinator-owned generation:/)).toContainText('Off');await page.getByRole('button',{name:'Set delegation policy',exact:true}).click();
 const toggle=page.getByRole('checkbox',{name:generationOption,exact:true}),ownRole=page.getByRole('checkbox',{name:/separate generation request/}),save=page.getByRole('button',{name:'Save reviewed policy',exact:true});
 await expect(toggle).not.toBeChecked();await expect(ownRole).toHaveCount(0);await review(page).check();await toggle.check();await expect(review(page)).not.toBeChecked();
 await expect(ownRole).toHaveCount(1);await expect(page.getByRole('group',{name:'Specialist roles this coordinator may request'}).getByRole('checkbox')).toHaveCount(1);
 await ownRole.check();await toggle.uncheck();await expect(ownRole).toHaveCount(0);await expect(save).toBeDisabled();await toggle.check();await expect(ownRole).not.toBeChecked();await ownRole.check();
 await expect(page.getByRole('dialog')).toContainText('no spending approval');await expect(page.getByRole('dialog')).toContainText('successfully');await expect(page.getByRole('checkbox',{name:option,exact:true})).not.toBeChecked();
 await page.getByLabel('Policy state',{exact:true}).selectOption('active');await page.screenshot({path:testInfo.outputPath('coordinator-generation-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath('coordinator-generation-mobile.png'),fullPage:true});
 await review(page).check();fixture.failOnce(true);await save.click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Synthetic lost acknowledgement');
 await page.clock.fastForward(10_001);await expect(page.getByText(/Coordinator-owned generation:/)).toContainText('Opted in');await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);
 const writes=policyWrites(fixture);expect(writes).toHaveLength(2);expect(writes[1].body).toEqual(writes[0].body);expect(writes[0].body).toMatchObject({revision:0,coordinatorGeneration:true,allowedRoleKeys:['comp'],maxRuns:5,maxConcurrentRuns:1});expect(writes[0].body).not.toHaveProperty('generatedContinuations');
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(toggle).toBeChecked();await expect(ownRole).toBeChecked();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Pause delegation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause delegation',exact:true})).toHaveCount(0);
 expect(policyWrites(fixture)[2].body.coordinatorGeneration).toBe(true);expect(policyWrites(fixture)[3].body).toMatchObject({coordinatorGeneration:true,status:'paused',maxRuns:5,maxConcurrentRuns:1});expect(errors).toEqual([]);expect(fixture.state.unexpected).toEqual([]);
});

test('existing v2 policies keep omitted generation opt-in and explicit disable retains other specialists',async({page})=>{
 const fixture=coordinationFixture();await openCoordination(page,fixture);await page.getByRole('button',{name:'Review policy',exact:true}).click();
 const toggle=page.getByRole('checkbox',{name:generationOption,exact:true}),save=page.getByRole('button',{name:'Save reviewed policy',exact:true});
 await expect(toggle).not.toBeChecked();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(policyWrites(fixture)[0].body).not.toHaveProperty('coordinatorGeneration');
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await toggle.check();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(toggle).toBeChecked();await toggle.uncheck();await expect(page.getByRole('checkbox',{name:/Generation specialist/})).toBeChecked();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(policyWrites(fixture)[2].body).toMatchObject({coordinatorGeneration:false,allowedRoleKeys:['comp']});expect(fixture.state.unexpected).toEqual([]);
});


test('prepared image policy is explicit, reviews its exact retry and preserves pause while adding no grants',async({page},testInfo)=>{
 const fixture=coordinationFixture({policy:false,reference:true});await openCoordination(page,fixture);await expect(page.getByText(/Prepared image reference selection:/)).toContainText('Off');
 await page.getByRole('button',{name:'Set delegation policy',exact:true}).click();const toggle=page.getByRole('checkbox',{name:'Allow prepared image reference selection',exact:true}),save=page.getByRole('button',{name:'Save reviewed policy',exact:true});await expect(toggle).not.toBeChecked();
 await toggle.check();await review(page).check();await expect(save).toBeDisabled();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('five existing reference preparation permissions');
 await page.getByRole('checkbox',{name:/Generation specialist/}).check();await expect(review(page)).not.toBeChecked();await page.getByLabel('Policy state',{exact:true}).selectOption('active');await review(page).check();await expect(save).toBeEnabled();await expect(page.getByRole('dialog')).toContainText('not resized or stripped of metadata');
 await page.screenshot({path:testInfo.outputPath('coordinated-prepared-references-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath('coordinated-prepared-references-mobile.png'),fullPage:true});
 fixture.failOnce();await save.click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Synthetic lost acknowledgement');await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(policyWrites(fixture)[1].body).toEqual(policyWrites(fixture)[0].body);expect(policyWrites(fixture)[0].body).toMatchObject({referencePreparationProfile:'prepared_image_v1',allowedRoleKeys:['comp'],revision:0});
 await page.getByRole('button',{name:'Pause delegation',exact:true}).click();expect(policyWrites(fixture)[2].body).toMatchObject({referencePreparationProfile:'prepared_image_v1',status:'paused'});expect(fixture.state.unexpected).toEqual([]);
});

test('planning corrections are an explicit reviewed opt-in with exact retry and pause preservation',async({page})=>{
 const fixture=coordinationFixture({policy:false});await openCoordination(page,fixture);
 await expect(page.getByText(/Planning corrections:/)).toContainText('Off');
 await page.getByRole('button',{name:'Set delegation policy',exact:true}).click();
 const toggle=page.getByRole('checkbox',{name:'Allow reviewed planning corrections',exact:true}),save=page.getByRole('button',{name:'Save reviewed policy',exact:true});await expect(toggle).not.toBeChecked();
 await page.getByRole('checkbox',{name:/Generation specialist/}).check();await page.getByLabel('Policy state',{exact:true}).selectOption('active');await review(page).check();await toggle.check();await expect(review(page)).not.toBeChecked();await expect(save).toBeDisabled();
 await expect(page.getByRole('dialog')).toContainText('Estimates and breakdowns only');await expect(page.getByRole('dialog')).toContainText('Failed or uncertain runs are not retried');await review(page).check();fixture.failOnce(true);await save.click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Synthetic lost acknowledgement');await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(policyWrites(fixture)[1].body).toEqual(policyWrites(fixture)[0].body);expect(policyWrites(fixture)[0].body).toMatchObject({planningRework:true,maxRuns:5,maxConcurrentRuns:1});
 await expect(page.getByText(/Planning corrections:/)).toContainText('Opted in');await page.getByRole('button',{name:'Pause delegation',exact:true}).click();expect(policyWrites(fixture)[2].body).toMatchObject({planningRework:true,status:'paused'});
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(toggle).toBeChecked();await toggle.uncheck();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(policyWrites(fixture)[3].body.planningRework).toBe(false);expect(fixture.state.unexpected).toEqual([]);
});

test('internal media corrections start off, renew review and preserve the exact policy retry and pause limits',async({page},testInfo)=>{
 await page.clock.install();const fixture=coordinationFixture({policy:false});await openCoordination(page,fixture);
 await expect(page.getByText(/^Internal QC corrections:/)).toContainText('Off');await page.getByRole('button',{name:'Review correction setup',exact:true}).click();
 const toggle=page.getByRole('checkbox',{name:mediaOption,exact:true}),save=page.getByRole('button',{name:'Save reviewed policy',exact:true});await expect(toggle).not.toBeChecked();
 await page.getByRole('checkbox',{name:/Generation specialist/}).check();await page.getByLabel('Policy state',{exact:true}).selectOption('active');await review(page).check();await toggle.check();await expect(review(page)).not.toBeChecked();await expect(save).toBeDisabled();
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Another review of the same version does not reset its attempt');await expect(dialog).toContainText('Failed or uncertain attempts are not retried');await expect(dialog).toContainText('separate human approval of its exact arguments, reference sharing and credit charge');
 await page.setViewportSize({width:390,height:844});await toggle.scrollIntoViewIfNeeded();await noOverflow(page);await page.screenshot({path:testInfo.outputPath('internal-qc-policy-mobile.png'),fullPage:true});
 await review(page).check();fixture.failOnce(true);await save.click();await expect(dialog.getByRole('alert')).toContainText('Synthetic lost acknowledgement');
 const readCount=fixture.state.reads.filter(url=>url.pathname.endsWith('/coordination')).length;await page.clock.fastForward(10_001);await expect.poll(()=>fixture.state.reads.filter(url=>url.pathname.endsWith('/coordination')).length).toBeGreaterThan(readCount);
 await expect(page.getByText(/^Internal QC corrections:/)).toContainText('Opted in');await save.click();await expect(dialog).toHaveCount(0);
 const writes=policyWrites(fixture);expect(writes).toHaveLength(2);expect(writes[1].body).toEqual(writes[0].body);expect(writes[0].body).toMatchObject({mediaRework:true,revision:0,maxRuns:5,maxConcurrentRuns:1,allowedRoleKeys:['comp']});
 await page.getByRole('button',{name:'Pause delegation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause delegation',exact:true})).toHaveCount(0);
 expect(policyWrites(fixture)[2].body).toMatchObject({mediaRework:true,status:'paused',maxRuns:5,maxConcurrentRuns:1,expiresAt:writes[0].body.expiresAt});expect(fixture.state.unexpected).toEqual([]);
});

test('existing generated policies preserve omitted media correction opt-in and retain an explicit disable',async({page})=>{
 const fixture=coordinationFixture();await openCoordination(page,fixture);const toggle=page.getByRole('checkbox',{name:mediaOption,exact:true}),save=page.getByRole('button',{name:'Save reviewed policy',exact:true});
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(toggle).not.toBeChecked();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(policyWrites(fixture)[0].body).not.toHaveProperty('mediaRework');
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await toggle.check();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(toggle).toBeChecked();await toggle.uncheck();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(policyWrites(fixture)[2].body.mediaRework).toBe(false);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(toggle).not.toBeChecked();await review(page).check();await save.click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(policyWrites(fixture)[3].body.mediaRework).toBe(false);
 await page.getByRole('button',{name:'Pause delegation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause delegation',exact:true})).toHaveCount(0);expect(policyWrites(fixture)[4].body.mediaRework).toBe(false);expect(fixture.state.unexpected).toEqual([]);
});

test('QC candidates show exact feedback and source with policy blockers and disappear when consumed',async({page},testInfo)=>{
 const fixture=coordinationFixture(),candidate=addMediaCorrection(fixture);await openCoordination(page,fixture);
 const corrections=page.getByRole('region',{name:'Internal QC corrections',exact:true}),status=corrections.getByRole('status');
 await expect(corrections).toContainText('Campaign master · version 1');await expect(corrections).toContainText('Changes requested · Independent reviewer');await expect(corrections).toContainText(candidate.reviewNote);await expect(corrections).toContainText('Current revision round');await expect(status).toContainText('Internal QC corrections are off');
 await corrections.getByText('Exact QC correction source',{exact:true}).click();for(const text of ['Independent review: '+candidate.reviewId,'Rejected artifact: '+ids.artifact,'Task: '+ids.task+' · revision 8','Round: '+candidate.roundId,'Manifest SHA-256: '+candidate.manifestSha256,'Specification SHA-256: '+candidate.specSha256])await expect(corrections).toContainText(text);
 await page.screenshot({path:testInfo.outputPath('internal-qc-source-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath('internal-qc-source-mobile.png'),fullPage:true});
 fixture.snapshot.policy!.mediaRework=true;await page.getByRole('button',{name:'Refresh coordination',exact:true}).click();await expect(status).toContainText('Waiting for the coordinator to request the assigned specialist');
 for(const state of ['paused','expired','approval_required'] as const){fixture.snapshot.policy!.effectiveStatus=state;fixture.snapshot.policy!.blocker='Synthetic '+state+' policy blocker.';await page.getByRole('button',{name:'Refresh coordination',exact:true}).click();await expect(status).toContainText(fixture.snapshot.policy!.blocker!);}
 fixture.snapshot.policy!.effectiveStatus='active';fixture.snapshot.policy!.blocker=null;fixture.snapshot.policy!.remainingRuns=0;await page.getByRole('button',{name:'Refresh coordination',exact:true}).click();await expect(status).toContainText('allowance is exhausted');
 fixture.snapshot.policy!.remainingRuns=3;fixture.snapshot.policy!.allowedRoleKeys=[];await page.getByRole('button',{name:'Refresh coordination',exact:true}).click();await expect(status).toContainText('role is outside the reviewed delegation policy');
 fixture.snapshot.policy!.allowedRoleKeys=['comp'];candidate.specialistAgentId=coordinator;await page.getByRole('button',{name:'Refresh coordination',exact:true}).click();await expect(status).toContainText('Coordinator-owned generation needs its separate policy opt-in');
 fixture.snapshot.mediaReworks=[];await page.getByRole('button',{name:'Refresh coordination',exact:true}).click();await expect(corrections).toContainText('No current rejected version is eligible');await expect(corrections.getByText(candidate.reviewNote,{exact:true})).toHaveCount(0);
 expect(policyWrites(fixture)).toHaveLength(0);expect(fixture.state.writes.filter(write=>/\/dispatch$|\/reviews$|\/higgsfield\//.test(write.path))).toEqual([]);expect(fixture.state.unexpected).toEqual([]);
});

test('members can inspect a failed internal correction attempt without policy or retry controls',async({page})=>{
 const fixture=coordinationFixture({media:true}),candidate=addMediaCorrection(fixture);fixture.state.company.role='member';
 await openCoordination(page,fixture);await expect(page.getByRole('region',{name:'Internal QC corrections',exact:true})).toContainText(candidate.reviewNote);await expect(page.getByRole('button',{name:/Review policy|Set delegation policy|Pause delegation|Review correction setup|Retry/})).toHaveCount(0);
 fixture.snapshot.mediaReworks=[];
 fixture.snapshot.dispatches=[{workItemId:ids.work,parentRunId:uuid(113),childRunId:uuid(114),coordinatorAgentId:coordinator,specialistAgentId:specialist,policyRevision:4,createdAt:date,status:'failed',mediaReviewId:candidate.reviewId,artifactId:ids.artifact,artifactVersion:1,taskRevision:8,roundId:candidate.roundId,sourceChildRunId:candidate.sourceChildRunId}];
 await page.getByRole('button',{name:'Refresh coordination',exact:true}).click();await expect(page.getByRole('region',{name:'Internal QC corrections',exact:true})).toContainText('No current rejected version is eligible');
 const attempt=page.getByRole('listitem').filter({has:page.getByText('Internal QC correction · rejected version 1',{exact:true})});await expect(attempt).toContainText('One attempt recorded for this version');await expect(attempt).toContainText('failed');await expect(attempt.getByRole('button')).toHaveCount(0);await attempt.getByText('Request provenance',{exact:true}).click();
 for(const text of ['Independent QC review: '+candidate.reviewId,'Rejected artifact: '+ids.artifact,'Source task revision: 8','Round: '+candidate.roundId,'Original specialist request: '+candidate.sourceChildRunId])await expect(attempt).toContainText(text);
 await expect(page.getByRole('button',{name:/Review policy|Set delegation policy|Pause delegation|Review correction setup|Retry/})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});await noOverflow(page);expect(policyWrites(fixture)).toHaveLength(0);expect(fixture.state.unexpected).toEqual([]);
});
