import {test,expect,type Page,type Route} from '@playwright/test';
import {AVATAR_CATALOG} from '../../src/lib/avatar-catalog';

const user={id:'10000000-0000-4000-8000-000000000091',name:'Mara Chen',email:'mara@example.invalid',roleTitle:'Creative director',avatarColor:'#c9d6b5',avatarId:null as string|null};
const company={id:'20000000-0000-4000-8000-000000000091',name:'Northlight Studio',slug:'northlight-fixture',template:'blank',role:'owner'};
const room={id:'30000000-0000-4000-8000-000000000091',name:'The greenhouse',kind:'meeting',capacity:8};
const peer={id:'40000000-0000-4000-8000-000000000091',userId:'40000000-0000-4000-8000-000000000091',name:'Ari Santos',email:'ari@example.invalid',roleTitle:'Film editor',role:'member',avatarId:null,avatarColor:'#d9bba7'};
const json=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
function snapshot(){return {company,members:[{...user,userId:user.id,role:'owner'},peer],rooms:[room,{...room,id:'30000000-0000-4000-8000-000000000092',name:'Quiet corner',kind:'focus'}],agents:[],tasks:[],messages:[] as any[],presence:[{...peer,status:'focus',roomId:room.id,x:0,z:0,updatedAt:new Date().toISOString()}],activity:[{id:'a1',kind:'task.created',description:'Mara Chen created the launch review.',actorName:'Mara Chen',createdAt:new Date().toISOString()},{id:'a2',kind:'member.joined',description:'Ari Santos joined the company.',actorName:'Ari Santos',createdAt:new Date(Date.now()-86400000).toISOString()}],drives:[],openings:[],applications:[],layout:[] as any[]};}
async function fixture(page:Page,data:ReturnType<typeof snapshot>,special?:(route:Route)=>Promise<boolean>){
  await page.addInitScript(()=>{(window as any).CoatriaOfficeRuntime={mount:(host:HTMLElement)=>{const canvas=document.createElement('canvas');host.append(canvas);return {dispose:()=>canvas.remove(),updateSnapshot:()=>{},diagnostics:{position:{x:0,z:0}},setCharacterModel:()=>false};},loadCharacter:()=>Promise.reject(new Error('Fixture')),disposeCharacter:()=>{}};});
  let identity={...user};const profileWrites:any[]=[];
  await page.route('**/api/**',async route=>{
    if(special&&await special(route))return;
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')return json(route,{user:identity,companies:[company],configured:true});
    if(path.endsWith('/workspace'))return json(route,data);
    if(path==='/api/avatars')return json(route,{avatars:AVATAR_CATALOG});
    if(path.endsWith('/preview'))return json(route,{error:'Preview deliberately unavailable in public fixture'},503);
    if(path==='/api/profile'&&route.request().method()==='PATCH'){const payload=route.request().postDataJSON();profileWrites.push(payload);identity={...identity,...payload};return json(route,{user:identity});}
    return json(route,{presence:data.presence});
  });
  return {profileWrites};
}
test.beforeEach(async({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local API-intercepted fixtures only.');});

test('chat keeps reading position and per-room drafts through a delayed send and failure',async({page})=>{
  const data=snapshot();data.messages=Array.from({length:60},(_,index)=>({id:'message-'+index,roomId:null,body:'Production update '+index+' — A longer update gives the conversation a realistic scroll height.',createdAt:new Date(Date.now()-(60-index)*60000).toISOString(),userId:peer.userId,authorName:peer.name}));
  let held:Route|undefined,fail=false;const writes:any[]=[];
  await fixture(page,data,async route=>{if(new URL(route.request().url()).pathname.endsWith('/messages')&&route.request().method()==='POST'){writes.push(route.request().postDataJSON());if(fail)await json(route,{error:'Connection interrupted'},503);else held=route;return true;}return false;});
  await page.goto('/#chat');const log=page.getByRole('log',{name:'Conversation messages'});
  await expect(page.locator('.message')).toHaveCount(60);
  await log.evaluate(element=>{element.scrollTop=0;element.dispatchEvent(new Event('scroll'));});
  data.messages.push({...data.messages[0],id:'new-incoming',body:'A new update arrived',createdAt:new Date().toISOString()});
  await expect(page.getByRole('button',{name:'1 new message · Jump to latest'})).toBeVisible();
  expect(await log.evaluate(element=>element.scrollTop)).toBeLessThan(10);
  await page.getByRole('button',{name:'1 new message · Jump to latest'}).click();
  expect(await log.evaluate(element=>element.scrollHeight-element.scrollTop-element.clientHeight)).toBeLessThan(10);
  await page.getByLabel('Your message',{exact:true}).fill('Commons draft');
  await page.getByRole('button',{name:'# '+room.name,exact:true}).click();
  await expect(page.getByLabel('Your message',{exact:true})).toHaveValue('');
  await page.getByLabel('Your message',{exact:true}).fill('Room draft');
  await page.getByRole('button',{name:'Company commons',exact:true}).click();
  await expect(page.getByLabel('Your message',{exact:true})).toHaveValue('Commons draft');
  await page.getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>!!held).toBe(true);
  await page.getByLabel('Your message',{exact:true}).fill('Next commons draft');
  await page.getByRole('button',{name:'# '+room.name,exact:true}).click();
  await expect(page.getByLabel('Your message',{exact:true})).toHaveValue('Room draft');
  const posted={...data.messages[0],id:'posted-message',body:'Commons draft',userId:user.id,authorName:user.name,createdAt:new Date().toISOString()};data.messages.push(posted);await json(held!,{message:posted},201);
  await page.getByRole('button',{name:'Company commons',exact:true}).click();
  await expect(page.getByLabel('Your message',{exact:true})).toHaveValue('Next commons draft');
  await expect(page.getByText('Message posted',{exact:true})).toBeVisible();
  expect(writes).toEqual([{body:'Commons draft',roomId:null}]);
  fail=true;await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect(page.locator('#main').getByRole('alert').filter({hasText:'Your draft is kept.'})).toContainText('Not sent. Your draft is kept.');
  await expect(page.getByLabel('Your message',{exact:true})).toHaveValue('Next commons draft');
  await page.setViewportSize({width:390,height:844});
  const selector=page.getByRole('combobox',{name:'Choose conversation',exact:true});await expect(selector).toBeVisible();await expect(page.getByLabel('Search conversations',{exact:true})).toBeHidden();
  await expect(selector.locator('option')).toHaveCount(data.rooms.length+1);await selector.selectOption(room.id);await expect(page.getByLabel('Your message',{exact:true})).toHaveValue('Room draft');
  await selector.selectOption('');await expect(page.getByLabel('Your message',{exact:true})).toHaveValue('Next commons draft');expect(await selector.evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await page.evaluate(()=>window.scrollTo(0,0));const sendBounds=await page.getByRole('button',{name:'Send',exact:true}).boundingBox();expect(sendBounds!.y+sendBounds!.height).toBeLessThanOrEqual(844);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('rooms, people and activity offer meaningful search and recoverable no-results states',async({page})=>{
  const data=snapshot();await fixture(page,data);await page.goto('/#rooms');
  await page.getByLabel('Search rooms',{exact:true}).fill('green');await expect(page.getByRole('heading',{name:room.name,exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Quiet corner',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Focus',exact:true}).click();await expect(page.getByRole('heading',{name:'No rooms match these filters'})).toBeVisible();await page.getByRole('button',{name:'Clear filters',exact:true}).click();await expect(page.getByRole('heading',{name:'Quiet corner',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'People',exact:true}).click();await page.getByLabel('Search people',{exact:true}).fill('film editor');await expect(page.getByRole('cell',{name:'Film editor',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'Creative director',exact:true})).toHaveCount(0);
  await page.getByLabel('Search people',{exact:true}).fill('no-such-person');await expect(page.getByRole('heading',{name:'No teammates match these filters'})).toBeVisible();await page.getByRole('button',{name:'Clear filters',exact:true}).click();await expect(page.getByRole('button',{name:'Manage '+peer.name,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Activity',exact:true}).click();await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Yesterday',exact:true})).toBeVisible();await page.getByRole('button',{name:'Work',exact:true}).click();await expect(page.getByText('Mara Chen created the launch review.',{exact:true})).toBeVisible();await expect(page.getByText('Ari Santos joined the company.',{exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await page.getByLabel('Search activity',{exact:true}).evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
});

test('layout preserves newer edits across a save and protects navigation with a discard path',async({page})=>{
  const data=snapshot();let held:Route|undefined;const writes:any[]=[];
  await fixture(page,data,async route=>{if(new URL(route.request().url()).pathname.endsWith('/layout')&&route.request().method()==='PATCH'){writes.push(route.request().postDataJSON());held=route;return true;}return false;});
  await page.goto('/#layout');await page.getByRole('button',{name:'Workstation',exact:true}).click();await page.getByLabel('Label',{exact:true}).fill('First desk');await page.getByRole('button',{name:'Save shared floor plan',exact:true}).click();await expect.poll(()=>!!held).toBe(true);
  await page.getByLabel('Label',{exact:true}).fill('Second draft');data.layout=writes[0].layout;await json(held!,{layout:data.layout});
  await expect(page.getByText('You have unpublished changes',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save shared floor plan',exact:true})).toBeEnabled();
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'People',exact:true}).click();await expect(page.getByLabel('Label',{exact:true})).toHaveValue('Second draft');
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Discard changes',exact:true}).click();await expect(page.getByText('Shared floor plan is up to date',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Select First desk',exact:true}).click();await expect(page.getByLabel('Label',{exact:true})).toHaveValue('First desk');
  await page.getByLabel('Left (%)',{exact:true}).fill('99');await expect(page.getByText('This object extends beyond the floor. Reduce its position or size.')).toBeVisible();await expect(page.getByRole('button',{name:'Save shared floor plan',exact:true})).toBeDisabled();
});

test('profile shows a compact selection and applies searchable character choices only after explicit save',async({page})=>{
  const {profileWrites}=await fixture(page,snapshot());await page.goto('/#profile');await expect(page.getByRole('radio')).toHaveCount(0);await expect(page.getByRole('region',{name:'Your office character'})).toBeVisible();await page.getByRole('button',{name:'Change character',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Choose your office character'})).toBeVisible();await expect(page.getByRole('radio')).toHaveCount(13);for(const name of ['Cancel','Use this character']){const bounds=await page.getByRole('button',{name,exact:true}).boundingBox();expect(bounds).not.toBeNull();expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);}await page.getByLabel('Search characters',{exact:true}).fill('Coral hoodie');await expect(page.getByRole('radio')).toHaveCount(2);
  await page.locator('label.avatar-choice').filter({has:page.getByRole('radio',{name:'Coral hoodie',exact:true})}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(profileWrites).toHaveLength(0);await expect(page.getByText('Save profile to apply',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Change character',exact:true}).click();await page.locator('label.avatar-choice').filter({has:page.getByRole('radio',{name:'Coral hoodie',exact:true})}).click();await page.getByRole('button',{name:'Use this character',exact:true}).click();await expect(page.getByText('Save profile to apply',{exact:true})).toBeVisible();expect(profileWrites).toHaveLength(0);
  await page.getByRole('button',{name:'Save personal profile',exact:true}).click();await expect.poll(()=>profileWrites.length).toBe(1);expect(profileWrites[0].avatarId).toBe('city-145');await page.reload();await expect(page.getByRole('region',{name:'Your office character'})).toContainText('Coral hoodie');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Change character',exact:true}).click();await expect(page.getByRole('radio',{name:'Coral hoodie',exact:true})).toBeChecked();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await page.getByLabel('Search characters',{exact:true}).evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);for(const name of ['Cancel','Use this character']){const bounds=await page.getByRole('button',{name,exact:true}).boundingBox();expect(bounds).not.toBeNull();expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);}
});
