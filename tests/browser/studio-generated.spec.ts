import {test,expect} from '@playwright/test';
import {generatedFixture,mockGenerated,openGenerated,noOverflow,ids,uuid} from './studio-generated-fixture';

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Synthetic fixtures require a local origin.');});

for(const kind of ['image','video','audio'] as const)test(`${kind} projects show real units, typed targets and the complete workspace`,async({page},testInfo)=>{
 const state=generatedFixture(kind);await mockGenerated(page,state);await openGenerated(page,state);
 await expect(page.getByRole('button',{name:'Record client acceptance',exact:true})).toHaveCount(0);
 await expect(page.getByText('Client acceptance recorded',{exact:true})).toHaveCount(0);
 const header=page.getByRole('heading',{name:state.detail.project.name,exact:true,level:1}).locator('..');
 await expect(header).toContainText(kind==='audio'?'48,000 Hz':'1280 × 720');
 expect(await header.innerText()).not.toMatch(/undefined|NaN/);
 await page.getByRole('tab',{name:/^Deliverables/}).click();await expect(page.getByRole('heading',{name:'Your deliverables',exact:true})).toBeVisible();
 await expect(page.getByRole('tabpanel')).toContainText(kind==='image'?'One still image':'0.999 s – 1.001 s');
 expect(await page.getByRole('tabpanel').innerText()).not.toMatch(/handles|frames|undefined|NaN/);
 // Keyboard navigation stays inside the project tablist.
 await page.getByRole('tab',{name:/^Deliverables/}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'Team & skills',exact:true})).toBeFocused();
 await page.getByRole('tab',{name:'Generations & references',exact:true}).click();await expect(page.getByRole('tabpanel')).toContainText(kind==='audio'?'48,000':'1280');
 await page.getByRole('tab',{name:/^Review & delivery/}).click();await expect(page.getByRole('tabpanel')).not.toContainText('Record client acceptance');
 await expect(page.getByRole('button',{name:/Invite client|Create client delivery/})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath(kind+'-review-mobile.png'),fullPage:true});
 expect(state.reads.filter(url=>url.pathname.endsWith('/'+ids.project)).every(url=>url.searchParams.get('contractVersion')==='2')).toBe(true);
 expect(state.unexpected).toEqual([]);
});

test('mixed project pagination retains explicit version negotiation and existing VFX views',async({page})=>{
 const state=generatedFixture();state.snapshot.projects=[state.detail.project];state.snapshot.hasMore=true;state.snapshot.nextAfter=ids.project;
 state.handler=async(route,url)=>{if(!url.pathname.endsWith('/studio')||!url.searchParams.has('after'))return false;expect(url.searchParams.get('contractVersion')).toBe('2');expect(url.searchParams.get('after')).toBe(ids.project);await route.fulfill({json:{...state.snapshot,projects:[state.legacy],hasMore:false,nextAfter:null}});return true;};
 await mockGenerated(page,state);await page.goto('/#studio');await page.getByRole('button',{name:'Next page',exact:true}).click();await page.getByRole('button').filter({has:page.getByRole('heading',{name:'Existing VFX film',exact:true})}).click();
 await expect(page.getByRole('heading',{name:'Existing VFX film',level:1})).toBeVisible();await page.getByRole('tab',{name:/^Shots/}).click();await expect(page.getByRole('tabpanel')).toContainText('24 frames');await expect(page.getByRole('tabpanel')).toContainText('8 handles / end');
 await page.getByRole('button',{name:'All productions',exact:true}).click();await page.getByRole('button',{name:'Previous page',exact:true}).click();await expect(page.getByRole('heading',{name:'Image campaign',exact:true})).toBeVisible();
});

test('generated pipeline never offers the legacy followup',async({page})=>{
 const state=generatedFixture();state.detail.artifacts=[state.artifact];state.detail.workItems[0]={...state.detail.workItems[0],runId:uuid(50),runStatus:'succeeded'};await mockGenerated(page,state);await openGenerated(page,state);await page.getByRole('tab',{name:/^Production work/}).click();
 await expect(page.getByRole('button',{name:'Review generation handoff',exact:true})).toHaveCount(0);
 await expect(page.getByRole('tabpanel')).toContainText('Register a verified project archive');
});

for(const hasStorageRead of [false,true])test(`prepared image selection uses explicit existing grants (${hasStorageRead?'ready':'missing storage'})`,async({page},testInfo)=>{
 const state=generatedFixture(),agentId=uuid(60),capabilities=['studio.read','studio.write','tasks.write','creative.read',...(hasStorageRead?['storage.read']:[])];
 state.detail.workItems=[{...state.detail.workItems[0],title:'Select exact prepared images',stage:'references',roleKey:'ingest',status:'todo',readiness:'ready',execution:'agent',agentId,humanId:null}];
 state.detail.roles=state.detail.roles.map(role=>role.key==='ingest'?{...role,agentId,humanId:null}:role);
 let attempts=0;
 state.handler=async(route,url)=>{
  if(url.pathname.endsWith('/workspace')){await route.fulfill({json:{company:state.company,rooms:[],members:[{...state.user,userId:state.user.id,role:'owner'}],agents:[{id:agentId,name:'Reviewed reference specialist',status:'active',harness:'custom',capabilities,pluginInstallationId:uuid(61),invocationAccess:'admins',expiresAt:'2099-01-01T00:00:00Z'}],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]}});return true;}
  if(url.pathname.endsWith('/dispatch')&&route.request().method()==='POST'){
   attempts++;if(attempts===1){await route.fulfill({status:503,json:{error:'Synthetic unknown dispatch response.'}});return true;}
   state.detail.workItems[0]={...state.detail.workItems[0],runId:uuid(62),runStatus:'queued',readiness:'queued'};
   await route.fulfill({status:201,json:{run:{id:uuid(62),status:'queued'},project:state.detail.project,replayed:true}});return true;
  }return false;
 };
 await mockGenerated(page,state);await openGenerated(page,state);await page.getByRole('tab',{name:/^Production work/}).click();
 const prepare=page.getByRole('button',{name:'Select prepared images',exact:true}),ordinary=page.getByRole('button',{name:'Queue specialist',exact:true});
 await expect(ordinary).toBeEnabled();await expect(page.getByRole('tabpanel')).toContainText('Uses existing verified images unchanged');
 expect(capabilities).not.toContain('creative.write');
 if(!hasStorageRead){await expect(prepare).toBeDisabled();expect(state.writes.filter(w=>w.path.endsWith('/dispatch'))).toHaveLength(0);return;}
 await expect(prepare).toBeEnabled();await prepare.click();await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('Synthetic unknown dispatch response');expect(attempts).toBe(1);
 await page.screenshot({path:testInfo.outputPath('prepared-reference-dispatch-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await prepare.scrollIntoViewIfNeeded();await noOverflow(page);await page.screenshot({path:testInfo.outputPath('prepared-reference-dispatch-mobile.png'),fullPage:true});
 await prepare.click();await expect(prepare).toHaveCount(0);await expect(ordinary).toHaveCount(0);expect(attempts).toBe(2);
 const writes=state.writes.filter(w=>w.path.endsWith('/dispatch'));expect(writes[0].body).toEqual(writes[1].body);expect(writes[0].body).toMatchObject({preparationProfile:'prepared_image_v1',revision:7,workItemId:ids.work});expect(Object.keys(writes[0].body).sort()).toEqual(['clientId','preparationProfile','revision','workItemId']);expect(state.unexpected).toEqual([]);
});

for(const hasStorageRead of [false,true])test(`original-image preparation dispatch preserves planning and exact retry (${hasStorageRead?'four grants':'missing storage'})`,async({page},testInfo)=>{
 const state=generatedFixture(),agentId=uuid(63),capabilities=['studio.read','studio.write','tasks.write',...(hasStorageRead?['storage.read']:[])];
 state.detail.workItems=[{...state.detail.workItems[0],title:'Propose one original image preparation',stage:'references',roleKey:'ingest',status:'todo',readiness:'ready',execution:'agent',agentId,humanId:null}];state.detail.roles=state.detail.roles.map(role=>role.key==='ingest'?{...role,agentId,humanId:null}:role);let attempts=0;
 state.handler=async(route,url)=>{
  if(url.pathname.endsWith('/workspace')){await route.fulfill({json:{company:state.company,rooms:[],members:[{...state.user,userId:state.user.id,role:'owner'}],agents:[{id:agentId,name:'Reviewed original-image specialist',status:'active',harness:'custom',capabilities,pluginInstallationId:uuid(64),invocationAccess:'admins',expiresAt:'2099-01-01T00:00:00Z'}],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]}});return true;}
  if(url.pathname.endsWith('/dispatch')&&route.request().method()==='POST'){attempts++;if(attempts===1){await route.fulfill({status:503,json:{error:'Synthetic original dispatch acknowledgement lost.'}});return true;}state.detail.workItems[0]={...state.detail.workItems[0],runId:uuid(65),runStatus:'queued',readiness:'queued'};await route.fulfill({status:201,json:{run:{id:uuid(65),status:'queued'},project:state.detail.project,replayed:true}});return true;}return false;
 };
 await mockGenerated(page,state);await openGenerated(page,state);await page.getByRole('tab',{name:/^Production work/}).click();const original=page.getByRole('button',{name:'Propose original image preparation',exact:true}),prepared=page.getByRole('button',{name:'Select prepared images',exact:true}),ordinary=page.getByRole('button',{name:'Queue specialist',exact:true});
 await expect(ordinary).toBeEnabled();await expect(prepared).toBeDisabled();await expect(page.getByRole('tabpanel')).toContainText('adds no permissions and grants no processing or sharing approval');expect(capabilities).not.toContain('creative.read');expect(capabilities).not.toContain('creative.write');
 if(!hasStorageRead){await expect(original).toBeDisabled();expect(state.writes.filter(write=>write.path.endsWith('/dispatch'))).toHaveLength(0);return;}
 await original.click();await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('acknowledgement lost');await page.setViewportSize({width:390,height:844});await original.scrollIntoViewIfNeeded();await noOverflow(page);await page.screenshot({path:testInfo.outputPath('original-image-dispatch-mobile.png'),fullPage:true});await original.click();await expect(original).toHaveCount(0);await expect(prepared).toHaveCount(0);await expect(ordinary).toHaveCount(0);
 const writes=state.writes.filter(write=>write.path.endsWith('/dispatch'));expect(writes).toHaveLength(2);expect(writes[0].body).toEqual(writes[1].body);expect(writes[0].body).toMatchObject({preparationProfile:'original_image_v1',revision:7,workItemId:ids.work});expect(Object.keys(writes[0].body).sort()).toEqual(['clientId','preparationProfile','revision','workItemId']);expect(state.writes.filter(write=>write.path.endsWith('/image-preparations')||write.path.endsWith('/approve'))).toHaveLength(0);expect(state.unexpected).toEqual([]);
});
