import {test,expect,type Page,type Route} from '@playwright/test';
import type {Task,Skill} from '../../src/lib/client';

const user={id:'10000000-0000-4000-8000-000000000011',name:'Morgan Review',email:'morgan-ui@example.invalid',roleTitle:'Designer',avatarColor:'#c9d6b5',avatarId:null};
const peer={...user,id:'10000000-0000-4000-8000-000000000012',name:'Sam Contributor',email:'sam-ui@example.invalid'};
const company={id:'20000000-0000-4000-8000-000000000011',name:'Work UX Studio',slug:'work-ux',template:'blank',role:'owner'};
const date='2026-09-08T10:00:00.000Z';
const task=(suffix:string,title:string,extra:Partial<Task>={}):Task=>({id:'30000000-0000-4000-8000-'+suffix.padStart(12,'0'),title,description:'A clear outcome for the launch.',status:'todo',assigneeId:user.id,createdBy:peer.id,submissionUrl:null,reviewNote:null,createdAt:date,updatedAt:date,authorIds:[],...extra});
const skill=(suffix:string,title:string,content:string):Skill=>({id:'40000000-0000-4000-8000-'+suffix.padStart(12,'0'),title,description:'A reusable personal method.',content,version:1,updatedAt:date});
const fulfill=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});

async function fixture(page:Page,role='owner'){
 const state={tasks:[task('1','Review the launch page'),task('2','Check the final captions',{status:'review',assigneeId:peer.id,submittedBy:peer.id,authorIds:[peer.id],submissionUrl:'https://example.com/outcome'}),task('3','Draft the announcement',{assigneeId:null}),task('4','Prepare the accepted handoff',{status:'done',assigneeId:peer.id,submittedBy:peer.id,approvedBy:user.id})],skills:[skill('1','Creative brief','A private lighthouse process with three careful steps.'),skill('2','Review checklist','Check the result against the original outcome.')],patches:[] as Array<{id:string;body:Record<string,unknown>}>,failSkillSave:false};
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();
  if(path==='/api/session')return fulfill(route,{user,companies:[{...company,role}],configured:true});
  if(path===`/api/companies/${company.id}/workspace`)return fulfill(route,{company:{...company,role},members:[{...user,userId:user.id,role},{...peer,userId:peer.id,role:'member'}],rooms:[],agents:[],tasks:state.tasks,messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]});
  if(path.includes('/tasks/')&&method==='PATCH'){
   const id=path.split('/').at(-1)!,body=route.request().postDataJSON();state.patches.push({id,body});
   state.tasks=state.tasks.map(item=>item.id===id?{...item,...body,updatedAt:new Date(Date.parse(item.updatedAt)+1000).toISOString(),...(body.status==='review'?{submittedBy:user.id,authorIds:[user.id]}:{})}:item);
   return fulfill(route,{task:state.tasks.find(item=>item.id===id)});
  }
  if(path==='/api/vault'&&method==='GET')return fulfill(route,{skills:state.skills});
  if(path.startsWith('/api/vault/')&&method==='PATCH'){
   if(state.failSkillSave)return fulfill(route,{error:'The vault could not save right now. Please retry.'},503);
   const id=path.split('/').at(-1),body=route.request().postDataJSON();state.skills=state.skills.map(item=>item.id===id?{...item,...body,version:item.version+1,updatedAt:new Date(Date.parse(item.updatedAt)+1000).toISOString()}:item);return fulfill(route,{skill:state.skills.find(item=>item.id===id)});
  }
  return fulfill(route,{presence:[]});
 });
 return state;
}
test.beforeEach(async({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local intercepted UI fixtures only; no production data.');});

test('task views combine ownership and status with recoverable search and responsive list layout',async({page})=>{
 await fixture(page);await page.goto('/#tasks');
 const cards=page.getByRole('button',{name:/^Open task:/});await expect(cards).toHaveCount(4);
 await page.getByRole('button',{name:/^Assigned to me/}).click();await expect(cards).toHaveCount(1);
 await page.getByRole('button',{name:/^All company work/}).click();await page.getByRole('textbox',{name:'Search tasks',exact:true}).fill('  sam contributor  ');await expect(cards).toHaveCount(2);
 await page.getByRole('textbox',{name:'Search tasks',exact:true}).fill('no matching outcome');await expect(page.getByRole('heading',{name:'No tasks match this view.',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Clear task filters',exact:true}).click();await expect(cards).toHaveCount(4);
 await page.getByRole('button',{name:/^Needs review/}).click();await expect(cards).toHaveCount(1);
 await page.getByRole('combobox',{name:'Filter task status',exact:true}).selectOption('done');await expect(page.getByRole('button',{name:'Open task: Prepare the accepted handoff',exact:true})).toBeVisible();await expect(cards).toHaveCount(1);
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();await page.getByRole('button',{name:'List view',exact:true}).click();await expect(page.getByRole('region',{name:'Task list',exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:'Sort tasks',exact:true}).selectOption('title');await expect(cards.first()).toHaveAccessibleName('Open task: Check the final captions');
 await page.screenshot({path:'test-results/coatria-work-list-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.reload();await expect(page.getByRole('button',{name:'List view',exact:true})).toHaveAttribute('aria-pressed','true');expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
 await page.screenshot({path:'test-results/coatria-work-list-mobile.png',fullPage:true});
});

test('an assignee submits only changed fields and submitted outcomes become read-only',async({page})=>{
 const state=await fixture(page,'member');state.tasks[0].reviewNote='Please verify the final heading before resubmitting.';await page.goto('/#tasks');await page.getByRole('button',{name:'Open task: Review the launch page',exact:true}).click();
 await expect(page.getByRole('button',{name:'Save task updates',exact:true})).toBeDisabled();
 await expect(page.getByRole('dialog').getByRole('combobox',{name:'Assign to',exact:true})).toBeDisabled();
 await expect(page.getByLabel('Reviewer notes',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Review feedback',exact:true})).toBeVisible();await expect(page.getByText('Please verify the final heading before resubmitting.',{exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:'Status',exact:true}).selectOption('review');await page.getByLabel('Contribution link',{exact:true}).fill('https://example.com/launch-reviewed');
 await page.getByRole('button',{name:'Save task updates',exact:true}).click();await expect(page.getByRole('heading',{name:'Independent review',exact:true})).toBeVisible();
 expect(state.patches[0].body).toEqual({status:'review',submissionUrl:'https://example.com/launch-reviewed'});
 await expect(page.getByLabel('Task title',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Review and accept',exact:true})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'Open contribution link',exact:true})).toHaveAttribute('href','https://example.com/launch-reviewed');
 await page.getByRole('button',{name:'Continue working',exact:true}).click();await expect(page.getByLabel('Task title',{exact:true})).toBeVisible();expect(state.patches[1].body).toEqual({status:'doing'});
});

test('independent reviewers can request changes without rewriting the submitted work',async({page})=>{
 const state=await fixture(page);await page.goto('/#tasks');await page.getByRole('button',{name:'Open task: Check the final captions',exact:true}).click();
 await expect(page.getByLabel('Task title',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Request changes',exact:true}).click();await page.getByLabel('Review decision',{exact:true}).fill('Please verify the final name spelling.');
 await page.getByRole('button',{name:'Return to in progress',exact:true}).click();await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('Check the final captions');
 expect(state.patches[0].body).toEqual({status:'doing',reviewNote:'Please verify the final name spelling.'});
});

test('a polled task update preserves a local draft until the person loads the latest version',async({page})=>{
 const state=await fixture(page);await page.goto('/#tasks');await page.getByRole('button',{name:'Open task: Review the launch page',exact:true}).click();await page.getByLabel('Task title',{exact:true}).fill('My unfinished local title');
 state.tasks=state.tasks.map(item=>item.id===state.tasks[0].id?{...item,title:'A teammate updated this title',updatedAt:'2026-09-08T10:01:00.000Z'}:item);
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await expect(page.getByText('This task changed while you were editing.',{exact:true})).toBeVisible();await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('My unfinished local title');await expect(page.getByRole('button',{name:'Save task updates',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Discard edits and load latest',exact:true}).click();await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('A teammate updated this title');expect(state.patches).toHaveLength(0);
});

test('private skill search includes instructions and failed version saves retain the draft',async({page})=>{
 const state=await fixture(page);await page.goto('/#vault');await page.getByRole('textbox',{name:'Search your skills',exact:true}).fill('  lighthouse  ');await expect(page.getByRole('button',{name:/^Open skill:/})).toHaveCount(1);
 await page.getByRole('textbox',{name:'Search your skills',exact:true}).fill('absent technique');await expect(page.getByRole('heading',{name:'No skills match your search.',exact:true})).toBeVisible();await page.getByRole('button',{name:'Clear skill search',exact:true}).last().click();
 await page.getByRole('button',{name:'Open skill: Creative brief',exact:true}).click();await expect(page.getByText(state.skills[0].content,{exact:true})).toBeVisible();await page.getByRole('button',{name:'Edit and save a new version',exact:true}).click();
 await page.getByLabel('Instructions, process or knowledge',{exact:true}).fill('My revised private method, with a final quality check.');
 state.failSkillSave=true;await page.getByRole('button',{name:'Save new version',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('The vault could not save');await expect(page.getByLabel('Instructions, process or knowledge',{exact:true})).toHaveValue('My revised private method, with a final quality check.');
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
 page.once('dialog',dialog=>dialog.dismiss());const allowed=await page.evaluate(()=>document.dispatchEvent(new Event('coatria:before-navigate',{cancelable:true})));expect(allowed).toBe(false);
 state.failSkillSave=false;await page.getByRole('button',{name:'Save new version',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(state.skills[0].version).toBe(2);
 await page.getByRole('button',{name:'Open skill: Creative brief',exact:true}).click();await expect(page.getByRole('dialog').getByText('Version 2',{exact:true})).toBeVisible();await expect(page.getByText('My revised private method, with a final quality check.',{exact:true})).toBeVisible();
 await page.screenshot({path:'test-results/coatria-vault-reader.png',fullPage:true});await page.getByRole('button',{name:'Close dialog',exact:true}).click();await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);await page.screenshot({path:'test-results/coatria-vault-mobile.png',fullPage:true});
});
