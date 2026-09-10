import {test,expect,type Page,type Route} from '@playwright/test';
import type {Company,Presence,Workspace} from '../../src/lib/client';

// Keep the real Home/API/OfficeScene wiring and spy only on the renderer edge.
// These local intercepted fixtures cannot create users or publish company data.
const user={id:'10000000-0000-4000-8000-000000000181',name:'Sync Reviewer',email:'sync@example.invalid',roleTitle:'Reviewer',avatarColor:'#64835e',avatarId:null};
const peer={...user,id:'10000000-0000-4000-8000-000000000182',name:'Remote Teammate',email:'peer@example.invalid'};
const companies:Company[]=[{id:'20000000-0000-4000-8000-000000000181',name:'North Studio',slug:'north-sync',template:'blank',role:'owner'},{id:'20000000-0000-4000-8000-000000000182',name:'South Studio',slug:'south-sync',template:'blank',role:'owner'}];
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const json=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
const presence=(x=1,z=1,updatedAt='2026-09-10T12:00:00Z'):Presence[]=>[{userId:user.id,name:user.name,avatarColor:user.avatarColor,avatarId:null,roomId:null,x:0,z:3,status:'available',updatedAt:'2026-09-10T12:00:00Z'},{userId:peer.id,name:peer.name,avatarColor:peer.avatarColor,avatarId:null,roomId:null,x,z,status:'available',updatedAt}];
const workspace=(company:Company):Workspace=>({company,members:[{...user,userId:user.id,role:'owner'},{...peer,userId:peer.id,role:'member'}],rooms:[],agents:[],tasks:[],messages:[],presence:presence(),activity:[],drives:[],openings:[],applications:[],layout:[],floor:{width:20,depth:16},layoutRevision:0});
type RequestRecord={companyId:string;kind:string;method:string;body:any};
type Held={route:Route;response:unknown;record:RequestRecord;finish:()=>void;released:boolean};
async function runtime(page:Page){await page.addInitScript(()=>{
 const state={current:null as any,mounts:[] as any[]};(window as any).__presenceScene=state;
 (window as any).CoatriaOfficeRuntime={createCharacterLibrary:()=>({dispose(){}}),createOfficeAssetLibrary:()=>({dispose(){}}),mount(host:HTMLElement,options:any){const canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:100%;height:360px';host.replaceChildren(canvas);const entry={options,latest:options,updates:0,disposed:false};state.current=entry;state.mounts.push(entry);return {dispose(){entry.disposed=true;canvas.remove();},updateSnapshot(snapshot:any){entry.latest={...entry.latest,...snapshot};entry.updates++;},get diagnostics(){return {position:options.state.spatialPosition||{x:0,z:3}};}};}};
 });}
async function fixture(page:Page){
 await runtime(page);const data=new Map(companies.map(company=>[company.id,workspace(company)])),rosters=new Map(companies.map(company=>[company.id,presence()])),requests:RequestRecord[]=[],held:Held[]=[],holdNext=new Set<string>(),active=new Map<string,number>(),maximum=new Map<string,number>(),revoked=new Set<string>();let memberships=companies;
 const key=(companyId:string,kind:string,method='GET')=>companyId+':'+kind+':'+method;
 await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname,method=request.method();if(path==='/api/session')return json(route,{user,companies:memberships,configured:true});const match=path.match(/^\/api\/companies\/([^/]+)\/(workspace|presence)$/);if(!match)return json(route,{error:'Unexpected presence fixture request.'},501);const [,companyId,kind]=match,record={companyId,kind,method,body:request.postData()?request.postDataJSON():null};requests.push(record);const requestKey=key(companyId,kind,method);active.set(requestKey,(active.get(requestKey)||0)+1);maximum.set(requestKey,Math.max(maximum.get(requestKey)||0,active.get(requestKey)!));const finish=()=>active.set(requestKey,active.get(requestKey)!-1);
  if(revoked.has(companyId)){try{return await json(route,{error:'You no longer have access to this company.'},403);}finally{finish();}}
  const response=kind==='workspace'?copy(data.get(companyId)):copy({presence:rosters.get(companyId)});
  if(holdNext.delete(requestKey)){held.push({route,response,record,finish,released:false});return;}
  try{return await json(route,response);}finally{finish();}
 });
 return {data,rosters,requests,held,maximum,key,hold(kind:'workspace'|'presence',method='GET',companyId=companies[0].id){holdNext.add(key(companyId,kind,method));},async release(index:number,response?:unknown){const request=held[index];expect(request,'A held request must exist.').toBeTruthy();request.released=true;try{await json(request.route,response??request.response);}catch{/* A switched company's request may already have been aborted. */}finally{request.finish();}},revoke(companyId=companies[0].id){revoked.add(companyId);memberships=companies.filter(company=>!revoked.has(company.id));}};
}
async function clock(page:Page){await page.clock.install({time:new Date('2026-09-10T12:00:00Z')});await page.clock.pauseAt(new Date('2026-09-10T12:00:01Z'));}
async function open(page:Page){await page.goto('/#office');await expect.poll(()=>page.evaluate(()=>(window as any).__presenceScene.current?.latest.companyName)).toBe('North Studio');}
async function remotePosition(page:Page){return page.evaluate(id=>{const person=(window as any).__presenceScene.current?.latest.presence.find((person:any)=>person.userId===id);return person?{x:person.x,z:person.z}:null;},peer.id);}
async function move(page:Page,x:number,z:number){await page.evaluate(position=>(window as any).__presenceScene.current.options.onMove(position),{x,z});}
const count=(requests:RequestRecord[],kind:string,method='GET',companyId=companies[0].id)=>requests.filter(request=>request.kind===kind&&request.method===method&&request.companyId===companyId).length;
test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Presence fixtures only run on a loopback origin.');});

test('a movement POST response updates remote scene presence before any subsequent GET',async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);await expect.poll(()=>count(state.requests,'presence','POST')).toBeGreaterThan(0);const workspaceCount=count(state.requests,'workspace');state.rosters.set(companies[0].id,presence(6,-3,'2026-09-10T12:00:02Z'));await move(page,4,2);await page.clock.runFor(1100);await expect.poll(()=>remotePosition(page)).toEqual({x:6,z:-3});expect(count(state.requests,'workspace')).toBe(workspaceCount);expect(count(state.requests,'presence','GET')).toBe(0);expect(state.requests.some(request=>request.kind==='presence'&&request.method==='POST'&&request.body.x===4&&request.body.z===2)).toBe(true);
});

test('slow movement writes coalesce intermediate positions and never overlap',async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);state.hold('presence','POST');await move(page,2,2);await page.clock.runFor(1100);await expect.poll(()=>state.held.length).toBe(1);await move(page,3,3);await move(page,4,4);await move(page,5,5);await page.clock.runFor(4000);expect(count(state.requests,'presence','POST')).toBe(2);await state.release(0);await expect.poll(()=>state.requests.filter(request=>request.kind==='presence'&&request.method==='POST').at(-1)?.body.x).toBe(5);const positions=state.requests.filter(request=>request.kind==='presence'&&request.method==='POST').map(request=>request.body.x);expect(positions).not.toContain(3);expect(positions).not.toContain(4);expect(state.maximum.get(state.key(companies[0].id,'presence','POST'))).toBe(1);
});

test('slow workspace and presence polls stay single-flight, including an explicit visibility refresh',async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);state.hold('workspace');state.hold('presence');await page.clock.runFor(5100);await expect.poll(()=>state.held.length).toBe(2);const workspaceRequests=count(state.requests,'workspace'),presenceRequests=count(state.requests,'presence');await page.clock.runFor(20000);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));expect(count(state.requests,'workspace')).toBe(workspaceRequests);expect(count(state.requests,'presence')).toBe(presenceRequests);expect(state.maximum.get(state.key(companies[0].id,'workspace'))).toBe(1);expect(state.maximum.get(state.key(companies[0].id,'presence'))).toBe(1);for(let index=0;index<state.held.length;index++)await state.release(index);await page.clock.runFor(1200);await expect.poll(()=>count(state.requests,'workspace')).toBeGreaterThan(workspaceRequests);
});

test('an older workspace response cannot replace the roster received from a newer movement write',async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);state.hold('workspace');await page.clock.runFor(5100);await expect.poll(()=>state.held.length).toBe(1);expect((state.held[0].response as Workspace).presence[1].x).toBe(1);state.rosters.set(companies[0].id,presence(7,-4,'2026-09-10T12:00:06Z'));await move(page,3,1);await expect.poll(()=>remotePosition(page)).toEqual({x:7,z:-4});await state.release(0);await expect.poll(()=>remotePosition(page)).toEqual({x:7,z:-4});await page.clock.runFor(200);expect(await remotePosition(page)).toEqual({x:7,z:-4});
});

for(const pollArrivesFirst of [true,false])test(`server commit timestamps preserve a movement when the later stale GET arrives ${pollArrivesFirst?'before':'after'} its POST response`,async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);state.hold('presence','POST');if(!pollArrivesFirst)state.hold('presence','GET');await move(page,6,4);await page.clock.runFor(2100);await expect.poll(()=>state.held.length).toBe(pollArrivesFirst?1:2);expect(state.held[0].record).toMatchObject({kind:'presence',method:'POST',body:{x:6,z:4}});expect(count(state.requests,'presence','GET')).toBe(1);
 // The GET began later but read before the POST committed. Request-start
 // sequence numbers therefore cannot tell us which surviving row is newest.
 const committed=presence();committed[0]={...committed[0],x:6,z:4,updatedAt:'2026-09-10T12:00:03.050Z'};await state.release(0,{presence:committed});const own=()=>page.evaluate(id=>{const row=(window as any).__presenceScene.current.latest.presence.find((row:Presence)=>row.userId===id);return row?{x:row.x,z:row.z,updatedAt:row.updatedAt}:null;},user.id);await expect.poll(own).toEqual({x:6,z:4,updatedAt:'2026-09-10T12:00:03.050Z'});
 if(!pollArrivesFirst){expect(state.held[1].record.method).toBe('GET');await state.release(1);await expect.poll(own).toEqual({x:6,z:4,updatedAt:'2026-09-10T12:00:03.050Z'});}expect(count(state.requests,'workspace')).toBe(1);expect(count(state.requests,'presence','GET')).toBe(1);
});

test('a delayed earlier roster cannot resurrect a participant removed by the newer roster',async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);state.hold('presence','POST');await move(page,7,2);await page.clock.runFor(1100);await expect.poll(()=>state.held.length).toBe(1);const committed={...presence()[0],x:7,z:2,updatedAt:'2026-09-10T12:00:02.050Z'};state.rosters.set(companies[0].id,[committed]);state.data.get(companies[0].id)!.members=state.data.get(companies[0].id)!.members.filter(member=>member.userId!==peer.id);await page.clock.runFor(1100);await expect.poll(()=>remotePosition(page)).toBeNull();await state.release(0,{presence:[committed,presence()[1]]});await expect.poll(()=>remotePosition(page)).toBeNull();const ids=await page.evaluate(()=>(window as any).__presenceScene.current.latest.presence.map((row:Presence)=>row.userId));expect(ids).toEqual([user.id]);expect(count(state.requests,'presence','GET')).toBe(1);
});

test('switching companies discards a delayed old snapshot and stops the old company pollers',async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);state.hold('workspace');await page.clock.runFor(5100);await expect.poll(()=>state.held.length).toBe(1);state.rosters.set(companies[1].id,presence(-5,4));state.data.get(companies[1].id)!.presence=presence(-5,4);await page.getByRole('button',{name:'Switch to South Studio',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__presenceScene.current?.latest.companyName)).toBe('South Studio');await expect.poll(()=>remotePosition(page)).toEqual({x:-5,z:4});const oldRequests=state.requests.filter(request=>request.companyId===companies[0].id).length;await state.release(0);await page.clock.runFor(16000);await expect.poll(()=>remotePosition(page)).toEqual({x:-5,z:4});expect(state.requests.filter(request=>request.companyId===companies[0].id)).toHaveLength(oldRequests);expect(await page.evaluate(()=>(window as any).__presenceScene.mounts.filter((mount:any)=>mount.options.companyName==='North Studio').every((mount:any)=>mount.disposed))).toBe(true);
});

test('revoked company access clears its scene, reloads membership and stops stale polling',async({page})=>{
 await clock(page);const state=await fixture(page);await open(page);state.revoke();await page.clock.runFor(2100);await expect(page.getByRole('button',{name:'Switch to North Studio',exact:true})).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).__presenceScene.current?.latest.companyName)).toBe('South Studio');const oldRequests=state.requests.filter(request=>request.companyId===companies[0].id).length;await page.clock.runFor(16000);expect(state.requests.filter(request=>request.companyId===companies[0].id)).toHaveLength(oldRequests);expect(await page.evaluate(()=>(window as any).__presenceScene.mounts.filter((mount:any)=>mount.options.companyName==='North Studio').every((mount:any)=>mount.disposed))).toBe(true);
});
