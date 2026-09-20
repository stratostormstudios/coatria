import {test,expect,type Page} from '@playwright/test';
import {studioCoordinationInput,type StudioCoordinationPolicy,type StudioCoordinationSnapshot} from '../../src/lib/studio-coordination-protocol';
import {generatedFixture,mockGenerated,openGenerated,noOverflow,ids,uuid,date} from './studio-generated-fixture';

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Synthetic fixtures require a local origin.');});
const coordinator=uuid(70),specialist=uuid(71),option='Allow verified generated output continuations';
const review=(page:Page)=>page.getByRole('checkbox',{name:/^I reviewed the coordinator/});
const policyWrites=(fixture:ReturnType<typeof coordinationFixture>)=>fixture.state.writes.filter(write=>write.path.endsWith('/coordination'));
function coordinationFixture({enabled,legacy=false,policy=true}:{enabled?:boolean;legacy?:boolean;policy?:boolean}={}){
 const state=generatedFixture();
 for(const role of state.detail.roles){if(role.key==='producer'){role.agentId=coordinator;role.humanId=null;role.agentName='Production coordinator';}if(role.key==='comp'){role.agentId=specialist;role.humanId=null;role.agentName='Generation specialist';}}
 state.detail.workItems[0].agentId=specialist;state.detail.workItems[0].humanId=null;
 const initial:StudioCoordinationPolicy={projectId:legacy?state.legacy.id:ids.project,coordinatorAgentId:coordinator,allowedRoleKeys:['comp'],status:'active',effectiveStatus:'active',blocker:null,revision:4,maxRuns:5,runsStarted:2,remainingRuns:3,maxConcurrentRuns:1,approvedBy:ids.user,expiresAt:'2027-01-01T00:00:00.000Z',updatedAt:date,profileRevision:1,...enabled!==undefined?{generatedContinuations:enabled}:{}};
 const snapshot:StudioCoordinationSnapshot={policy:policy?initial:null,dispatches:[],budgetUnit:'specialist_runs',budgetScope:'coordinator_dispatched_runs_only',startsWorkers:false,startsInference:false};
 let failNext=false,commitBeforeFailure=false;
 state.handler=async(route,url)=>{
  if(url.pathname.endsWith('/workspace')){
   await route.fulfill({json:{company:state.company,rooms:[],members:[{...state.user,userId:state.user.id,role:state.company.role}],agents:[coordinator,specialist].map((id,index)=>({id,name:index?'Generation specialist':'Production coordinator',pluginInstallationId:uuid(72+index),harness:'codex',status:'active',description:'Synthetic fixture',capabilities:['studio.read','studio.write','tasks.write'],createdBy:ids.user,lastSeenAt:date})),tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]}});return true;
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
 await expect(page.getByText(/Verified generated output continuations:/)).toHaveCount(0);
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await expect(page.getByRole('checkbox',{name:option,exact:true})).toHaveCount(0);
 await review(page).check();await page.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Pause delegation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause delegation',exact:true})).toHaveCount(0);
 for(const write of policyWrites(fixture)){expect(write.body).not.toHaveProperty('generatedContinuations');expect(Object.keys(write.body).sort()).toEqual(['allowedRoleKeys','clientId','coordinatorAgentId','expiresAt','maxConcurrentRuns','maxRuns','revision','status'].sort());}
 expect(policyWrites(fixture)).toHaveLength(2);expect(fixture.state.unexpected).toEqual([]);
});

test('read-only members see generated continuation source history without policy controls',async({page})=>{
 const fixture=coordinationFixture({enabled:true});fixture.state.company.role='member';
 fixture.snapshot.dispatches=[{workItemId:ids.work,parentRunId:uuid(80),childRunId:uuid(81),coordinatorAgentId:coordinator,specialistAgentId:specialist,policyRevision:4,createdAt:date,status:'queued',archiveId:ids.archive,sourceChildRunId:uuid(82),artifactId:ids.artifact},{workItemId:ids.work,parentRunId:uuid(83),childRunId:uuid(82),coordinatorAgentId:coordinator,specialistAgentId:specialist,policyRevision:3,createdAt:date,status:'failed'}];
 await openCoordination(page,fixture);await expect(page.getByRole('button',{name:/Review policy|Set delegation policy|Pause delegation/})).toHaveCount(0);
 await expect(page.getByText('Verified generated output continuation',{exact:true})).toHaveCount(1);
 const generated=page.getByRole('listitem').filter({has:page.getByText('Verified generated output continuation',{exact:true})});await generated.getByText('Request provenance',{exact:true}).click();
 await expect(generated).toContainText('Verified archive: '+ids.archive);await expect(generated).toContainText('Original specialist request: '+uuid(82));await expect(generated).toContainText('Registered artifact: '+ids.artifact);
 await page.setViewportSize({width:390,height:844});await noOverflow(page);expect(policyWrites(fixture)).toHaveLength(0);expect(fixture.state.unexpected).toEqual([]);
});
