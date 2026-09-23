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
