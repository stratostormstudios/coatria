import {conversationFixture} from './conversation-fixture';
import {test,expect,type Page,type Route} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import type {Company,Message,User,Workspace} from '../../src/lib/client';

// Exercise the real shell and conversation provider. Only HTTP and the 3D
// renderer boundary are replaced; these tests never create production records.
const firstUser:User={id:'10000000-0000-4000-8000-000000000241',name:'Conversation Reviewer',email:'conversation@example.invalid',roleTitle:'Designer',avatarColor:'#738e6a',avatarId:null};
const secondUser:User={...firstUser,id:'10000000-0000-4000-8000-000000000242',name:'Second Reviewer',email:'second-conversation@example.invalid'};
const peer:User={...firstUser,id:'10000000-0000-4000-8000-000000000243',name:'Ari Rivera',email:'ari-conversation@example.invalid'};
const companies:Company[]=[
 {id:'20000000-0000-4000-8000-000000000241',name:'North Conversation Studio',slug:'north-conversation',template:'blank',role:'owner'},
 {id:'20000000-0000-4000-8000-000000000242',name:'South Conversation Studio',slug:'south-conversation',template:'blank',role:'owner'},
];
const greenhouse='30000000-0000-4000-8000-000000000241';
const quietRoom='30000000-0000-4000-8000-000000000242';
const seat={id:'conversation-chair',x:-2,z:1,yaw:0,seatHeight:.53,approach:{x:-2,z:0}};
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const json=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
type Write={companyId:string;kind:string;channel?:string;identity:string|undefined;body:Record<string,any>};
type HeldSend={route:Route;write:Write;author:User;publish:()=>any};

function workspace(company:Company,user:User):Workspace{
 const timestamp=new Date().toISOString();
 return {company,members:[{...user,userId:user.id,role:'owner'},{...peer,userId:peer.id,role:'member'}],rooms:[{id:greenhouse,name:'The greenhouse',kind:'meeting',capacity:8},{id:quietRoom,name:'Quiet corner',kind:'focus',capacity:4}],agents:[],tasks:[],messages:Array.from({length:60},(_,index)=>({id:`${company.id}-message-${index}`,roomId:null,body:`${company.name} message ${index+1}. A clear update for the team about the current design review.`,createdAt:new Date(Date.now()-60000+index*100).toISOString(),userId:peer.id,authorName:peer.name})),presence:[{userId:user.id,name:user.name,avatarColor:user.avatarColor,avatarId:null,roomId:quietRoom,x:seat.x,z:seat.z,status:'focus',updatedAt:timestamp,seatId:seat.id,seat,motionMode:'walk'}],activity:[],drives:[],openings:[],applications:[],layout:[],floor:{width:20,depth:16},layoutRevision:0};
}

async function fixture(page:Page){
 await page.addInitScript(()=>{
  const state={current:null as any,mounts:[] as any[]};(window as any).__conversationScene=state;
  (window as any).CoatriaOfficeRuntime={createCharacterLibrary:()=>({dispose(){}}),createOfficeAssetLibrary:()=>({dispose(){}}),mount(host:HTMLElement,options:any){
   const canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:100%;height:360px';host.replaceChildren(canvas);
   const entry={options,latest:options,disposed:false};state.current=entry;state.mounts.push(entry);
   return {dispose(){entry.disposed=true;canvas.remove();},updateSnapshot(snapshot:any){entry.latest={...entry.latest,...snapshot};},get diagnostics(){return {position:options.state.spatialPosition||{x:0,z:3}};}};
  }};
 });
 let activeUser=firstUser,holdNextSend=false,failNextSend=false;
 const data=new Map(companies.map(company=>[company.id,workspace(company,firstUser)]));
 const writes:Write[]=[],held:HeldSend[]=[],unexpected:string[]=[];
 function publish(send:HeldSend){return send.publish();}
 const messaging=conversationFixture(id=>data.get(id),()=>activeUser,async send=>{
  const write:Write={companyId:send.companyId,kind:'messages',channel:send.channel,identity:send.route.request().headers()['x-coatria-user'],body:send.body};writes.push(write);
  if(failNextSend){failNextSend=false;await json(send.route,{error:'Local test connection interrupted.'},503);return true;}
  if(holdNextSend){holdNextSend=false;held.push({...send,write});return true;}return false;
 });
 await page.route('**/api/**',async route=>{
  if(await messaging.handle(route))return;
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/session')return json(route,{user:activeUser,companies,configured:true});
  const match=path.match(/^\/api\/companies\/([^/]+)\/(workspace|presence|messages)$/);
  if(!match){unexpected.push(`${request.method()} ${path}`);return json(route,{error:'Unexpected conversation fixture request.'},501);}
  const [,companyId,kind]=match,current=data.get(companyId);
  if(!current)return json(route,{error:'Unknown test company.'},404);
  if(kind==='workspace')return json(route,copy(current));
  if(request.method()==='GET'&&kind==='presence')return json(route,{presence:copy(current.presence)});
  const write:Write={companyId,kind,identity:request.headers()['x-coatria-user'],body:request.postDataJSON()};writes.push(write);
  if(kind==='presence'){
   // Missing seatId is an ordinary heartbeat and must retain an existing seat.
   const own=current.presence.find(row=>row.userId===activeUser.id)!;
   Object.assign(own,write.body,{updatedAt:new Date().toISOString()});
   if(write.body.seatId===null)own.seat=null;
   return json(route,{presence:copy(current.presence)});
  }
  return json(route,{error:'Legacy messages route is not part of this fixture.'},501);
 });
 return {data,writes,held,unexpected,holdSend(){holdNextSend=true;},failSend(){failNextSend=true;},async release(index=0){const send=held[index];expect(send,'A held message request must exist.').toBeTruthy();try{await json(send.route,{message:publish(send)},201);}catch{/* A provider may abort an obsolete identity's request. */}},async changeAccount(){activeUser=secondUser;for(const company of companies)data.set(company.id,workspace(company,activeUser));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));}};
}

const dock=(page:Page)=>page.locator('#conversation-dock');
const composer=(page:Page)=>page.getByRole('textbox',{name:'Your message',exact:true});
async function openOffice(page:Page){await page.goto('/#office');await expect(page.getByRole('button',{name:'Company conversation',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>(window as any).__conversationScene.current?.latest.companyName)).toBe(companies[0].name);}
async function openDock(page:Page){await page.getByRole('button',{name:'Open conversation panel',exact:true}).click();await expect(dock(page)).toBeVisible();}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
async function screenshot(page:Page,name:string){const directory='C:/CODEX/Agent002/output/coatria-conversation-shell';await mkdir(directory,{recursive:true});await page.screenshot({path:`${directory}/${name}.png`,animations:'disabled'});}

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Conversation fixtures only run on a loopback origin.');});

test('the full conversation fills the main frame and uses the existing workplace sidebar',async({page})=>{
 const state=await fixture(page);await page.goto('/#chat');
 const navigation=page.locator('#workspace-navigation'),log=page.getByRole('log',{name:'Conversation messages',exact:true});
 await expect(navigation.getByRole('button',{name:'Company commons',exact:true})).toBeVisible();
 await expect(navigation.getByRole('button',{name:'# The greenhouse',exact:true})).toBeVisible();
 await expect(navigation.getByRole('navigation',{name:'Main navigation',exact:true})).toHaveCount(0);
 await expect(page.locator('#main .page-head')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Company commons',exact:true})).toBeVisible();
 await expect(log).toContainText('message 60.');
 const bounds=await log.boundingBox(),send=await page.getByRole('button',{name:'Send',exact:true}).boundingBox();
 expect(bounds!.height).toBeGreaterThan(450);expect(send!.y+send!.height).toBeLessThanOrEqual(1000);
 expect(await page.evaluate(()=>window.scrollY)).toBe(0);await noOverflow(page);
 await screenshot(page,'desktop-full');
 await navigation.getByRole('button',{name:'Back to workplace',exact:true}).click();
 await expect(page).toHaveURL(/#office$/);await expect(navigation.getByRole('navigation',{name:'Main navigation',exact:true})).toBeVisible();
 expect(state.unexpected).toEqual([]);
});

test('opening and using the office dock preserves the scene and physical room, seat and availability',async({page})=>{
 const state=await fixture(page);await openOffice(page);
 await expect.poll(()=>state.writes.filter(write=>write.kind==='presence').length).toBeGreaterThan(0);
 const mounts=await page.evaluate(()=>(window as any).__conversationScene.mounts.length);
 await page.getByRole('button',{name:'Company conversation',exact:true}).click();await expect(dock(page)).toHaveAttribute('role','complementary');
 await dock(page).getByRole('combobox',{name:'Choose conversation',exact:true}).selectOption(greenhouse);
 await composer(page).fill('A room draft while I remain seated.');
 await screenshot(page,'desktop-office-dock');
 await dock(page).getByRole('button',{name:'Close conversation panel',exact:true}).click();await expect(dock(page)).toBeHidden();
 await openDock(page);await expect(composer(page)).toHaveValue('A room draft while I remain seated.');
 await expect(page).toHaveURL(/#office$/);
 expect(await page.evaluate(()=>(window as any).__conversationScene.mounts.length)).toBe(mounts);
 const own=await page.evaluate(id=>(window as any).__conversationScene.current.latest.presence.find((row:any)=>row.userId===id),firstUser.id);
 expect(own).toMatchObject({roomId:quietRoom,x:seat.x,z:seat.z,status:'focus',seatId:seat.id});
 for(const write of state.writes.filter(write=>write.kind==='presence')){expect(write.body).toMatchObject({roomId:quietRoom,x:seat.x,z:seat.z,status:'focus'});expect(write.body).not.toHaveProperty('seatId');}
 expect(state.writes.filter(write=>write.kind==='messages')).toHaveLength(0);
});

test('selection and separate channel drafts survive expand, dock, close and reopen',async({page})=>{
 await fixture(page);await openOffice(page);await openDock(page);
 await dock(page).getByRole('combobox',{name:'Choose conversation',exact:true}).selectOption(greenhouse);
 await composer(page).fill('Greenhouse design notes');await dock(page).getByRole('button',{name:'Expand conversation',exact:true}).click();
 await expect(page).toHaveURL(/#chat$/);await expect(dock(page)).toBeHidden();
 await expect(page.getByRole('heading',{name:'The greenhouse',exact:true})).toBeVisible();await expect(composer(page)).toHaveValue('Greenhouse design notes');
 await page.locator('#workspace-navigation').getByRole('button',{name:'Company commons',exact:true}).click();await composer(page).fill('Company-wide notes');
 await page.getByRole('button',{name:'Dock conversation',exact:true}).click();await expect(page).toHaveURL(/#office$/);await expect(dock(page)).toBeVisible();await expect(composer(page)).toHaveValue('Company-wide notes');
 await dock(page).getByRole('button',{name:'Close conversation panel',exact:true}).click();await openDock(page);await expect(composer(page)).toHaveValue('Company-wide notes');
 await dock(page).getByRole('combobox',{name:'Choose conversation',exact:true}).selectOption(greenhouse);await expect(composer(page)).toHaveValue('Greenhouse design notes');
});

test('a delayed send survives reparenting without clearing a newer draft, and failed sends remain retryable',async({page})=>{
 const state=await fixture(page);await openOffice(page);await openDock(page);
 state.holdSend();await composer(page).fill('The first submitted message');await dock(page).getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>state.held.length).toBe(1);
 await composer(page).fill('A newer draft written while waiting');await dock(page).getByRole('button',{name:'Expand conversation',exact:true}).click();
 await expect(page).toHaveURL(/#chat$/);await expect(composer(page)).toHaveValue('A newer draft written while waiting');await expect(page.getByRole('button',{name:'Sending…',exact:true})).toBeDisabled();
 await state.release();await expect(page.getByRole('log',{name:'Conversation messages',exact:true})).toContainText('The first submitted message');await expect(composer(page)).toHaveValue('A newer draft written while waiting');
 expect(state.writes.filter(write=>write.kind==='messages')).toHaveLength(1);
 state.failSend();await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.locator('#main').getByRole('alert')).toContainText('Local test connection interrupted');
 await page.getByRole('button',{name:'Dock conversation',exact:true}).click();await expect(composer(page)).toHaveValue('A newer draft written while waiting');await expect(dock(page).getByRole('alert')).toContainText('Local test connection interrupted');
 await dock(page).getByRole('button',{name:'Send',exact:true}).click();await expect(composer(page)).toHaveValue('');await expect(dock(page).getByRole('log')).toContainText('A newer draft written while waiting');
 expect(state.writes.filter(write=>write.kind==='messages')).toHaveLength(3);
});

test('the mobile conversation panel traps focus, closes with Escape and restores its opener',async({page})=>{
 await fixture(page);await page.setViewportSize({width:390,height:844});await openOffice(page);const opener=page.getByRole('button',{name:'Open conversation panel',exact:true,includeHidden:true});await openDock(page);
 await expect(dock(page)).toHaveAttribute('role','dialog');await expect(dock(page)).toHaveAttribute('aria-modal','true');
 expect(await opener.evaluate(element=>Boolean(element.closest('[inert]')))).toBe(true);
 await expect.poll(()=>dock(page).evaluate(element=>element.contains(document.activeElement))).toBe(true);
 await composer(page).fill('Mobile draft stays here');
 const focusable=dock(page).locator('button:not([disabled]),textarea:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex="0"]').filter({visible:true});
 await focusable.last().focus();await page.keyboard.press('Tab');await expect(focusable.first()).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(focusable.last()).toBeFocused();
 const send=await dock(page).getByRole('button',{name:'Send',exact:true}).boundingBox();expect(send!.y+send!.height).toBeLessThanOrEqual(844);await noOverflow(page);
 await screenshot(page,'mobile-office-dock');
 await page.keyboard.press('Escape');await expect(dock(page)).toBeHidden();await expect(opener).toBeFocused();expect(await opener.evaluate(element=>Boolean(element.closest('[inert]')))).toBe(false);
 await openDock(page);await expect(composer(page)).toHaveValue('Mobile draft stays here');
});

test('crossing the panel breakpoint applies and releases modal isolation without discarding the draft',async({page})=>{
 await fixture(page);await page.setViewportSize({width:1200,height:900});await openOffice(page);await openDock(page);await expect(dock(page)).toHaveAttribute('role','complementary');await composer(page).fill('Keep this through resize');
 await page.setViewportSize({width:1199,height:900});await expect(dock(page)).toHaveAttribute('role','dialog');await expect(dock(page)).toHaveAttribute('aria-modal','true');
 expect(await page.getByRole('button',{name:'Open conversation panel',exact:true,includeHidden:true}).evaluate(element=>Boolean(element.closest('[inert]')))).toBe(true);
 await page.setViewportSize({width:1200,height:900});await expect(dock(page)).toHaveAttribute('role','complementary');await expect(dock(page)).not.toHaveAttribute('aria-modal','true');
 expect(await page.getByRole('button',{name:'Open conversation panel',exact:true}).evaluate(element=>Boolean(element.closest('[inert]')))).toBe(false);await expect(composer(page)).toHaveValue('Keep this through resize');await noOverflow(page);
});

test('switching company clears private conversation state and a late send cannot affect the new company',async({page})=>{
 const state=await fixture(page);await openOffice(page);await openDock(page);await dock(page).getByRole('combobox',{name:'Choose conversation',exact:true}).selectOption(greenhouse);
 state.holdSend();await composer(page).fill('North-only submitted message');await dock(page).getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>state.held.length).toBe(1);await composer(page).fill('North-only unsent draft');
 await page.getByRole('button',{name:'Switch to South Conversation Studio',exact:true}).click();await expect(dock(page)).toBeHidden();await expect.poll(()=>page.evaluate(()=>(window as any).__conversationScene.current?.latest.companyName)).toBe(companies[1].name);
 await openDock(page);await expect(composer(page)).toHaveValue('');await expect(dock(page).getByRole('combobox',{name:'Choose conversation',exact:true})).toHaveValue('');await composer(page).fill('South-only draft');
 await state.release();await expect(composer(page)).toHaveValue('South-only draft');await expect(dock(page).getByRole('log')).not.toContainText('North-only submitted message');await expect(dock(page).getByRole('log')).not.toContainText('North Conversation Studio message');
 await expect(dock(page).getByRole('button',{name:'Send',exact:true})).toBeEnabled();expect(state.held[0].write).toMatchObject({companyId:companies[0].id,identity:firstUser.id,channel:greenhouse});
 await page.getByRole('button',{name:'Switch to North Conversation Studio',exact:true}).click();await openDock(page);await expect(composer(page)).toHaveValue('');
});

test('an account change closes the old modal and discards its drafts and late send state',async({page})=>{
 const state=await fixture(page);await page.setViewportSize({width:390,height:844});await openOffice(page);await openDock(page);state.holdSend();await composer(page).fill('First-account private submission');await dock(page).getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>state.held.length).toBe(1);await composer(page).fill('First-account private draft');
 await state.changeAccount();await expect(dock(page)).toBeHidden();const opener=page.getByRole('button',{name:'Open conversation panel',exact:true});expect(await opener.evaluate(element=>Boolean(element.closest('[inert]')))).toBe(false);
 await openDock(page);await expect(composer(page)).toHaveValue('');await composer(page).fill('Second-account draft');await state.release();await expect(composer(page)).toHaveValue('Second-account draft');await expect(dock(page).getByRole('alert')).toHaveCount(0);await expect(dock(page).getByRole('button',{name:'Send',exact:true})).toBeEnabled();
 await page.keyboard.press('Escape');await expect(opener).toBeFocused();
});

test('the narrow full-page conversation keeps its composer visible and navigation returns to the selected room',async({page})=>{
 await fixture(page);await page.setViewportSize({width:390,height:844});await page.goto('/#chat');
 const choose=page.getByRole('combobox',{name:'Choose conversation',exact:true});await expect(choose).toBeVisible();await choose.selectOption(greenhouse);await composer(page).fill('A narrow-screen room draft');
 const log=page.getByRole('log',{name:'Conversation messages',exact:true}),send=await page.getByRole('button',{name:'Send',exact:true}).boundingBox();expect(send!.y+send!.height).toBeLessThanOrEqual(844);expect((await log.boundingBox())!.height).toBeGreaterThan(250);await noOverflow(page);
 await screenshot(page,'mobile-full');
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();const sidebar=page.locator('#workspace-navigation');await expect(sidebar.getByRole('button',{name:'# The greenhouse',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(choose).toHaveValue(greenhouse);await expect(composer(page)).toHaveValue('A narrow-screen room draft');
 await page.getByRole('button',{name:'Dock conversation',exact:true}).click();await expect(page).toHaveURL(/#office$/);await expect(dock(page)).toHaveAttribute('role','dialog');await expect(composer(page)).toHaveValue('A narrow-screen room draft');
});

test('quick navigation over a modal conversation panel releases both scroll locks when leaving Office',async({page})=>{
 await fixture(page);await page.setViewportSize({width:390,height:844});await openOffice(page);await openDock(page);await composer(page).fill('Draft behind quick navigation');
 await page.keyboard.press('Control+k');const search=page.getByRole('dialog',{name:'Find your way',exact:true});await expect(search).toBeVisible();
 const query=search.getByRole('combobox',{name:'Search navigation',exact:true});await query.fill('People');await query.press('Enter');
 await expect(page).toHaveURL(/#people$/);await expect(search).toHaveCount(0);await expect(dock(page)).toBeHidden();
 expect(await page.evaluate(()=>getComputedStyle(document.body).overflow)).not.toBe('hidden');
 expect(await page.locator('#main').evaluate(element=>Boolean(element.closest('[inert]')))).toBe(false);
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.locator('#workspace-navigation').getByRole('button',{name:'The office',exact:true}).click();await expect(dock(page)).toBeVisible();await expect(composer(page)).toHaveValue('Draft behind quick navigation');
});

test('read position and unseen updates survive docking, closing and expanding the conversation',async({page})=>{
 const state=await fixture(page);await page.goto('/#chat');const log=page.getByRole('log',{name:'Conversation messages',exact:true});await expect(log).toContainText('message 60.');
 await log.evaluate(element=>{element.scrollTop=100;element.dispatchEvent(new Event('scroll'));});await expect.poll(()=>log.evaluate(element=>element.scrollTop)).toBe(100);
 await page.getByRole('button',{name:'Dock conversation',exact:true}).click();await expect(dock(page)).toBeVisible();await expect.poll(()=>log.evaluate(element=>element.scrollTop)).toBe(100);
 await dock(page).getByRole('button',{name:'Close conversation panel',exact:true}).click();await openDock(page);await expect.poll(()=>log.evaluate(element=>element.scrollTop)).toBe(100);
 state.data.get(companies[0].id)!.messages.push({id:'new-message-while-reading',roomId:null,body:'A new update while you read earlier messages.',createdAt:new Date().toISOString(),userId:peer.id,authorName:peer.name});
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(log).toContainText('A new update while you read earlier messages.');
 const jump=page.getByRole('button',{name:'1 new message · Jump to latest',exact:true});await expect(jump).toBeVisible();await expect.poll(()=>log.evaluate(element=>element.scrollTop)).toBe(100);
 await dock(page).getByRole('button',{name:'Expand conversation',exact:true}).click();await expect(page).toHaveURL(/#chat$/);await expect(jump).toBeVisible();await expect.poll(()=>log.evaluate(element=>element.scrollTop)).toBe(100);
 await jump.click();await expect(jump).toHaveCount(0);expect(await log.evaluate(element=>element.scrollHeight-element.scrollTop-element.clientHeight)).toBeLessThan(2);
});

test('a removed room falls back safely without reusing its private draft in Company commons',async({page})=>{
 const state=await fixture(page);await page.goto('/#chat');await composer(page).fill('The existing commons draft');
 const navigation=page.locator('#workspace-navigation');await navigation.getByRole('button',{name:'# The greenhouse',exact:true}).click();await composer(page).fill('A draft intended only for the greenhouse');
 state.data.get(companies[0].id)!.rooms=state.data.get(companies[0].id)!.rooms.filter(room=>room.id!==greenhouse);
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(navigation.getByRole('button',{name:'# The greenhouse',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Company commons',exact:true})).toBeVisible();await expect(composer(page)).toHaveValue('The existing commons draft');
 expect(state.writes.filter(write=>write.kind==='messages')).toHaveLength(0);await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
});
