import {test,expect,type Page,type Route} from '@playwright/test';
import type {Task} from '../../src/lib/client';
import {taskPatch} from '../../src/lib/model';
import {taskHref} from '../../src/lib/task-navigation';
import {generatedFixture,ids,mockGenerated,openGenerated,uuid} from './studio-generated-fixture';

const date='2026-09-20T10:00:00.000Z';
const respond=(route:Route,value:unknown,status=200)=>route.fulfill({status,json:value});
async function fixture(page:Page){
 const studio=generatedFixture(),qc=studio.detail.workItems.find(work=>work.stage==='qc')!;
 qc.status='todo';qc.readiness='ready';qc.blockedReason=null;
 const task:Task={id:qc.taskId,title:qc.title,description:'Inspect the exact image and record the QC handoff.',status:'todo',revision:1,assigneeId:ids.user,createdBy:ids.producer,submissionUrl:null,submissionSummary:'',reviewNote:null,authorIds:[],createdAt:date,updatedAt:date};
 const recent=Array.from({length:500},(_,i)=>({...task,id:uuid(1000+i),title:`Recent unrelated task ${i+1}`,status:'done',assigneeId:ids.producer,updatedAt:'2026-09-21T10:00:00.000Z'}));
 const state={studio,task,recent,companies:[studio.company],exactCompanyId:ids.company,reads:[] as string[],patches:[] as ReturnType<typeof taskPatch.parse>[],signedOut:false,missing:false,denied:false,wrongResponse:false,hold:undefined as Promise<void>|undefined};
 studio.handler=async(route,url)=>{
  const method=route.request().method();
  if(url.pathname==='/api/session'){await respond(route,{user:state.signedOut?null:studio.user,companies:state.signedOut?[]:state.companies,configured:true});return true;}
  if(url.pathname==='/api/auth/login'&&method==='POST'){state.signedOut=false;await respond(route,{user:studio.user,companies:state.companies,configured:true});return true;}
  if(url.pathname.endsWith('/workspace')){await respond(route,{company:state.companies.find(company=>url.pathname===`/api/companies/${company.id}/workspace`),rooms:[],members:[{...studio.user,userId:studio.user.id,role:'owner'},{...studio.user,id:ids.user,userId:ids.user,name:'Original QC reviewer',role:'admin'},{...studio.user,id:ids.producer,userId:ids.producer,name:'Task creator',role:'admin'}],agents:[],tasks:recent,messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]});return true;}
  if(url.pathname.includes('/tasks/')){
   if(method==='GET'){
    state.reads.push(url.pathname);const saved=structuredClone(state.task);if(state.hold)await state.hold;
    if(state.denied)await respond(route,{error:'Company membership required.'},403);
    else if(state.missing||url.pathname!==`/api/companies/${state.exactCompanyId}/tasks/${state.task.id}`)await respond(route,{error:'Task not found.'},404);
    else await respond(route,{task:state.wrongResponse?{...saved,id:ids.task,title:'Unrelated task response'}:saved});return true;
   }
   if(method==='PATCH'){
    const patch=taskPatch.parse(route.request().postDataJSON());state.patches.push(patch);
    if(patch.expectedRevision!==state.task.revision){await respond(route,{error:'This task changed.',code:'TASK_REVISION_CONFLICT'},409);return true;}
    if(patch.status==='done'&&(state.task.status!=='review'||state.task.submittedBy===studio.user.id)){await respond(route,{error:'Independent reviewer required.'},403);return true;}
    state.task={...state.task,...patch,revision:state.task.revision+1,...patch.status==='review'?{submittedBy:studio.user.id,authorIds:[studio.user.id]}:patch.status==='done'?{approvedBy:studio.user.id}:{}};
    await respond(route,{task:state.task});return true;
   }
  }
  return false;
 };
 await mockGenerated(page,studio);return state;
}
test.beforeEach(async({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local intercepted UI fixtures only; no live data or provider calls.');});

test('Studio opens an older QC task outside the 500-task snapshot and uses ordinary revisioned submission and review',async({page})=>{
 const state=await fixture(page);await openGenerated(page,state.studio);await page.getByRole('tab',{name:/Production work/}).click();
 const row=page.getByRole('article').filter({has:page.getByRole('heading',{name:state.task.title,exact:true})});
 await expect(row.getByRole('link',{name:'View work'})).toHaveAttribute('href',taskHref(ids.company,state.task.id));await row.getByRole('link',{name:'View work'}).click();
 await expect(page.getByRole('dialog',{name:state.task.title})).toBeVisible();expect(state.recent.some(task=>task.id===state.task.id)).toBe(false);
 await expect(page.getByLabel('Task title',{exact:true})).toHaveValue(state.task.title);
 await page.getByRole('combobox',{name:'Status',exact:true}).selectOption('review');await page.getByRole('button',{name:'Save task updates',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Independent review',exact:true})).toBeVisible();expect(state.patches[0]).toEqual({expectedRevision:1,status:'review'});
 await expect(page.getByRole('button',{name:'Review and accept',exact:true})).toHaveCount(0);
 // A different signed-in administrator performs the existing independent review.
 state.studio.user={...state.studio.user,id:ids.registrar,name:'Independent administrator'};await page.reload();
 await page.getByRole('button',{name:'Review and accept',exact:true}).click();await page.getByLabel('Review decision',{exact:true}).fill('Verified the exact QC contribution and its evidence.');
 await page.getByRole('button',{name:'Accept contribution',exact:true}).click();await expect(page.getByRole('heading',{name:'Accepted by an independent reviewer',exact:true})).toBeVisible();
 expect(state.patches[1]).toEqual({expectedRevision:2,status:'done',reviewNote:'Verified the exact QC contribution and its evidence.'});expect(state.reads.length).toBeGreaterThanOrEqual(4);
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(page).toHaveURL(/#tasks$/);await expect(page.getByText(/This board shows the 500 most recently updated tasks/)).toBeVisible();
});

test('linked task refresh preserves an in-progress review and prevents accepting a newer uninspected revision',async({page})=>{
 const state=await fixture(page);state.task={...state.task,status:'review',assigneeId:ids.producer,submittedBy:ids.producer,authorIds:[ids.producer]};await page.goto('/'+taskHref(ids.company,state.task.id));
 await page.getByRole('button',{name:'Review and accept',exact:true}).click();await page.getByLabel('Review decision',{exact:true}).fill('Notes for the first observed revision.');
 state.task={...state.task,revision:2,submissionSummary:'A different submitted result.'};await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByText('This contribution changed while you were reviewing.',{exact:true})).toBeVisible();await expect(page.getByLabel('Review decision',{exact:true})).toHaveValue('Notes for the first observed revision.');await expect(page.getByRole('button',{name:'Accept contribution',exact:true})).toBeDisabled();expect(state.patches).toHaveLength(0);
});

for(const [label,hash] of [['invalid UUID',`#tasks?company=${ids.company}&task=broken`],['duplicate parameter',`#tasks?company=${ids.company}&task=${ids.task}&task=${ids.task}`],['wrong company',taskHref(uuid(999),ids.task)]])test(`${label} never requests a task from another scope`,async({page})=>{
 const state=await fixture(page);await page.goto('/'+hash);await expect(page.getByRole('dialog',{name:'Task unavailable'})).toBeVisible();await expect(page.getByRole('dialog').getByRole('alert')).toContainText(label==='wrong company'?'another company':'invalid');expect(state.reads).toHaveLength(0);expect(state.patches).toHaveLength(0);
 await page.getByRole('button',{name:'Return to work board',exact:true}).click();await expect(page).toHaveURL(/#tasks$/);
});

for(const status of [403,404])test(`an exact task becoming unavailable (${status}) clears its details`,async({page})=>{
 const state=await fixture(page);await page.goto('/'+taskHref(ids.company,state.task.id));await expect(page.getByRole('dialog',{name:state.task.title})).toBeVisible();state.denied=status===403;state.missing=status===404;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByRole('dialog',{name:'Task unavailable'})).toBeVisible();await expect(page.getByLabel('Task title',{exact:true})).toHaveCount(0);expect(state.patches).toHaveLength(0);
});

test('a late exact-task response cannot reopen a dismissed task',async({page})=>{
 const state=await fixture(page);let release!:()=>void;state.hold=new Promise(resolve=>release=resolve);await page.goto('/'+taskHref(ids.company,state.task.id));await expect(page.getByRole('dialog',{name:'Opening task'})).toBeVisible();await page.getByRole('button',{name:'Close dialog',exact:true}).click();release();await expect(page).toHaveURL(/#tasks$/);await expect(page.getByRole('dialog')).toHaveCount(0);expect(state.patches).toHaveLength(0);
});

test('declining task navigation keeps the exact link and its unsaved contribution',async({page})=>{
 const state=await fixture(page),hash=taskHref(ids.company,state.task.id);await page.goto('/'+hash);await page.getByLabel('Task title',{exact:true}).fill('My unfinished QC notes');
 page.once('dialog',dialog=>dialog.dismiss());await page.evaluate(()=>{location.hash='#tasks';});await expect(page).toHaveURL(url=>url.hash===hash);await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('My unfinished QC notes');expect(state.patches).toHaveLength(0);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(page).toHaveURL(/#tasks$/);
});

test('switching the signed-in identity discards a delayed task read from the previous account',async({page})=>{
 const state=await fixture(page);let release!:()=>void;state.hold=new Promise(resolve=>release=resolve);await page.goto('/'+taskHref(ids.company,state.task.id));await expect(page.getByRole('dialog',{name:'Opening task'})).toBeVisible();
 state.studio.user={...state.studio.user,id:ids.registrar,name:'New account'};state.denied=true;await page.evaluate(()=>window.dispatchEvent(new Event('coatria:session-changed')));release();
 await expect(page.getByRole('dialog',{name:'Task unavailable'})).toBeVisible();await expect(page.getByLabel('Task title',{exact:true})).toHaveCount(0);await expect(page.getByRole('dialog').getByRole('alert')).toContainText('membership');expect(state.patches).toHaveLength(0);
});

test('a mismatched exact-task response clears the old task without exposing the unrelated response',async({page})=>{
 const state=await fixture(page);await page.goto('/'+taskHref(ids.company,state.task.id));await expect(page.getByRole('dialog',{name:state.task.title})).toBeVisible();state.wrongResponse=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByRole('dialog',{name:'Task unavailable'})).toBeVisible();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('did not match this link');await expect(page.getByLabel('Task title',{exact:true})).toHaveCount(0);await expect(page.getByText('Unrelated task response',{exact:true})).toHaveCount(0);expect(state.patches).toHaveLength(0);
});

test('a bookmarked task for another joined company opens only after an explicit scoped switch',async({page})=>{
 const state=await fixture(page),company={...state.studio.company,id:uuid(999),name:'Second production studio',slug:'second-studio'};state.companies.push(company);state.exactCompanyId=company.id;
 const hash=taskHref(company.id,state.task.id);await page.goto('/'+hash);await expect(page.getByRole('dialog',{name:'Task unavailable'})).toBeVisible();expect(state.reads).toHaveLength(0);
 await page.getByRole('button',{name:`Switch to ${company.name} and open task`,exact:true}).click();await expect(page.getByRole('dialog',{name:state.task.title})).toBeVisible();await expect(page).toHaveURL(url=>url.hash===hash);expect(state.reads.every(path=>path===`/api/companies/${company.id}/tasks/${state.task.id}`)).toBe(true);
});

test('a background submission preserves an unsaved task edit until it is explicitly discarded',async({page})=>{
 const state=await fixture(page);await page.goto('/'+taskHref(ids.company,state.task.id));await page.getByLabel('Task title',{exact:true}).fill('My unsaved QC wording');
 state.task={...state.task,status:'review',revision:2,submittedBy:ids.producer,authorIds:[ids.producer]};await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByText('This task changed while you were editing.',{exact:true})).toBeVisible();await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('My unsaved QC wording');await expect(page.getByRole('button',{name:'Save task updates',exact:true})).toBeDisabled();expect(state.patches).toHaveLength(0);
 await page.getByRole('button',{name:'Discard edits and load latest',exact:true}).click();await expect(page.getByLabel('Task title',{exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Independent review',exact:true})).toBeVisible();
});

for(const status of ['doing','done'])test(`a background transition to ${status} preserves a dirty review without permitting stale acceptance`,async({page})=>{
 const state=await fixture(page);state.task={...state.task,status:'review',assigneeId:ids.producer,submittedBy:ids.producer,authorIds:[ids.producer]};await page.goto('/'+taskHref(ids.company,state.task.id));await page.getByRole('button',{name:'Review and accept',exact:true}).click();await page.getByLabel('Review decision',{exact:true}).fill('My unsaved independent findings');
 state.task={...state.task,status,revision:2};await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByText('This contribution changed while you were reviewing.',{exact:true})).toBeVisible();await expect(page.getByLabel('Review decision',{exact:true})).toHaveValue('My unsaved independent findings');await expect(page.getByRole('button',{name:'Accept contribution',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Continue working',exact:true})).toHaveCount(0);expect(state.patches).toHaveLength(0);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Cancel review',exact:true}).click();await expect(page.getByLabel('Review decision',{exact:true})).toHaveCount(0);if(status==='done')await expect(page.getByRole('heading',{name:'Accepted by an independent reviewer',exact:true})).toBeVisible();else await expect(page.getByLabel('Task title',{exact:true})).toBeVisible();
});

test('signing in from a task bookmark preserves the requested task',async({page})=>{
 const state=await fixture(page),hash=taskHref(ids.company,state.task.id);state.signedOut=true;await page.goto('/'+hash);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByLabel('Email address',{exact:true}).fill('reviewer@example.invalid');await page.getByLabel('Password',{exact:true}).fill('synthetic-local-fixture-only');await page.getByRole('button',{name:'Enter your workspace',exact:true}).click();
 await expect(page.getByRole('dialog',{name:state.task.title})).toBeVisible();await expect(page).toHaveURL(url=>url.hash===hash);expect(state.reads.every(path=>path===`/api/companies/${ids.company}/tasks/${state.task.id}`)).toBe(true);expect(state.patches).toHaveLength(0);
});
