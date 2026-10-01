import {expect,test,type Page} from '@playwright/test';
import {generatedFixture,mockGenerated,noOverflow,type GeneratedFixture} from './studio-generated-fixture';

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Synthetic fixtures require a local origin.');});

async function openWizard(page:Page,state:GeneratedFixture,kind:'image'|'video'|'audio'){
 await mockGenerated(page,state);await page.goto('/#studio');
 await page.getByRole('button',{name:'New project',exact:true}).click();
 await page.getByRole('button',{name:/AI media production/}).click();
 const modal=page.getByRole('dialog');
 await modal.getByRole('radio',{name:new RegExp('^'+kind,'i')}).check();
 await modal.getByLabel('Project name',{exact:true}).fill('First light '+kind);
 await modal.getByLabel('Client / brand',{exact:true}).fill('Client A');
 await modal.getByLabel('Creative brief',{exact:true}).fill('A thoughtful first-light campaign, using approved reference images.');
 await modal.getByLabel('Target delivery date',{exact:true}).fill('2026-12-10');
 await modal.getByLabel('Client AI-use policy',{exact:true}).selectOption('restricted');
 await modal.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(modal.getByRole('heading',{name:'Set the acceptance requirements.'})).toBeFocused();
 if(kind!=='audio'){
  await modal.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(modal.getByRole('heading',{name:'Set the acceptance requirements.'})).toBeVisible();
  await expect(modal.getByLabel('Color metadata policy',{exact:true})).toBeFocused();
  await modal.getByLabel('Color metadata policy',{exact:true}).selectOption('not_required');
 }
 return modal;
}

for(const kind of ['image','video','audio'] as const)test(`create ${kind} project from a reviewed typed contract`,async({page},testInfo)=>{
 const state=generatedFixture(kind),modal=await openWizard(page,state,kind);
 if(kind==='video'){
  await modal.getByLabel('Frame-rate numerator',{exact:true}).fill('48000');await modal.getByLabel('Frame-rate denominator',{exact:true}).fill('2000');
  await modal.getByLabel('Video container',{exact:true}).selectOption('mov');await modal.getByLabel('Video codec',{exact:true}).selectOption('prores');
  await modal.getByLabel('Embedded audio policy',{exact:true}).selectOption('required');await modal.getByLabel('Embedded audio codec',{exact:true}).selectOption('pcm_s24le');
 }
 if(kind==='audio'){await modal.getByLabel('Audio container',{exact:true}).selectOption('mp3');await expect(modal.getByLabel('Audio codec',{exact:true})).toHaveValue('mp3');await expect(modal.getByLabel('Width (pixels)',{exact:true})).toHaveCount(0);}
 await modal.getByRole('button',{name:'Continue',exact:true}).click();
 await modal.getByLabel('Deliverable 1 description',{exact:true}).fill('Opening campaign master');
 if(kind!=='image'){await modal.getByLabel('Deliverable 1 minimum duration (ms)',{exact:true}).fill('9999');await modal.getByLabel('Deliverable 1 maximum duration (ms)',{exact:true}).fill('10001');}
 await modal.getByRole('button',{name:'Review project',exact:true}).click();
 await expect(modal.getByRole('heading',{name:'Review the production plan.'})).toBeFocused();
 await expect(modal).toContainText('Restricted · see brief');await expect(modal).toContainText('2026-12-10');
 if(kind==='video')await expect(modal).toContainText('24/1 fps · constant');
 expect(state.writes.filter(write=>write.path.endsWith('/projects'))).toEqual([]);
 await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath(kind+'-wizard-mobile.png'),fullPage:true});
 await modal.getByRole('button',{name:'Create project',exact:true}).click();
 await expect(page.getByRole('heading',{name:'First light '+kind,level:1,exact:true})).toBeVisible();
 const writes=state.writes.filter(write=>write.path.endsWith('/projects'));expect(writes).toHaveLength(1);
 const body=writes[0].body;expect(body.contractVersion).toBe(2);expect(body.spec.kind).toBe(kind);expect(body.aiPolicy).toBe('restricted');expect(body.dueDate).toBe('2026-12-10');
 expect(body.shots[0]).toEqual(kind==='image'?{kind,code:'MEDIA010',description:'Opening campaign master'}:{kind,code:'MEDIA010',description:'Opening campaign master',durationMs:{min:9999,max:10001}});
 if(kind==='video'){expect(body.spec.frameRate).toEqual({mode:'constant',numerator:24,denominator:1});expect(body.spec.audio).toEqual({mode:'required',codec:'pcm_s24le',sampleRateHz:48000,channels:2});expect(body.spec.codec).toBe('prores');}
 if(kind==='audio')expect(body.spec).toEqual({kind:'audio',format:'mp3',codec:'mp3',sampleRateHz:48000,channels:2});
 expect(state.unexpected).toEqual([]);
});

test('duplicates and inverted durations keep the editable plan in place and focus the error',async({page})=>{
 const state=generatedFixture('audio'),modal=await openWizard(page,state,'audio');
 await modal.getByRole('button',{name:'Continue',exact:true}).click();await modal.getByLabel('Deliverable 1 description',{exact:true}).fill('Opening sound');
 await modal.getByLabel('Deliverable 1 minimum duration (ms)',{exact:true}).fill('6000');await modal.getByRole('button',{name:'Review project',exact:true}).click();
 await expect(modal.getByRole('alert')).toBeFocused();await expect(modal.getByRole('alert')).toContainText('Duration bounds must be ordered');
 await modal.getByLabel('Deliverable 1 minimum duration (ms)',{exact:true}).fill('4999');await modal.getByRole('button',{name:'Add deliverable',exact:true}).click();
 await modal.getByLabel('Deliverable 2 code',{exact:true}).fill('media010');await modal.getByLabel('Deliverable 2 description',{exact:true}).fill('Closing sound');await modal.getByRole('button',{name:'Review project',exact:true}).click();
 await expect(modal.getByRole('alert')).toBeFocused();await expect(modal.getByRole('alert')).toContainText('Deliverable codes must be unique');
 await modal.getByLabel('Deliverable 2 code',{exact:true}).fill('MEDIA020');await modal.getByRole('button',{name:'Review project',exact:true}).click();await expect(modal).toContainText('2 deliverables');
 expect(state.writes.filter(write=>write.path.endsWith('/projects'))).toHaveLength(0);
});

test('failed creates retry one exact request ID; editing the reviewed body creates a new request ID',async({page})=>{
 const state=generatedFixture(),modal=await openWizard(page,state,'image');let attempts=0;
 state.handler=async(route,url)=>{if(!url.pathname.endsWith('/projects')||route.request().method()!=='POST')return false;if(++attempts>2)return false;await route.fulfill({status:503,json:{error:'Synthetic interruption. Please retry.'}});return true;};
 await modal.getByRole('button',{name:'Continue',exact:true}).click();await modal.getByLabel('Deliverable 1 description',{exact:true}).fill('Opening hero');await modal.getByRole('button',{name:'Review project',exact:true}).click();
 await modal.getByRole('button',{name:'Create project',exact:true}).click();await expect(modal.getByRole('alert')).toContainText('Synthetic interruption');await expect(modal.getByRole('alert')).toBeFocused();
 await modal.getByRole('button',{name:'Create project',exact:true}).click();await expect.poll(()=>state.writes.filter(write=>write.path.endsWith('/projects')).length).toBe(2);
 const first=state.writes.filter(write=>write.path.endsWith('/projects'));expect(first[0].body).toEqual(first[1].body);
 await modal.getByRole('button',{name:'Edit brief',exact:true}).click();await modal.getByLabel('Project name',{exact:true}).fill('Revised campaign');await modal.getByRole('button',{name:'Continue',exact:true}).click();await modal.getByRole('button',{name:'Continue',exact:true}).click();await modal.getByRole('button',{name:'Review project',exact:true}).click();
 await modal.getByRole('button',{name:'Create project',exact:true}).click();await expect(page.getByRole('heading',{name:'Revised campaign',level:1,exact:true})).toBeVisible();
 const writes=state.writes.filter(write=>write.path.endsWith('/projects'));expect(writes).toHaveLength(3);expect(writes[2].body.clientId).not.toBe(writes[0].body.clientId);expect(writes[2].body.name).toBe('Revised campaign');
});
