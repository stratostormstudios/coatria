import {test,expect,type Locator,type Page,type Route} from '@playwright/test';
import type {LayoutItem,Workspace} from '../../src/lib/client';

// Local intercepted fixtures exercise the editor through the browser, including
// its actual pointer geometry. Backend revision/auth rules have separate tests.
const user={id:'10000000-0000-4000-8000-000000000081',name:'Floor Reviewer',email:'floor-editor@example.invalid',roleTitle:'Studio designer',avatarColor:'#607850',avatarId:null};
const company={id:'20000000-0000-4000-8000-000000000081',name:'Floor Design Studio',slug:'floor-design-fixture',template:'blank',role:'owner'};
type Floor={width:number;depth:number};
type Item=LayoutItem&{rotation?:number};
type Snapshot=Workspace&{layout:Item[];floor?:Floor;layoutRevision?:number};
type LayoutWrite={layout:Item[];floor:Floor;revision:number};
type Point={x:number;y:number};
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const json=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
const desk=(overrides:Partial<Item>={}):Item=>({id:'desk-original',type:'desk',x:20,y:25,w:15,h:12.5,label:'Review desk',...overrides});
function snapshot(layout:Item[]=[]):Snapshot{return {company,members:[{...user,userId:user.id,role:'owner'}],rooms:[],agents:[],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:copy(layout),floor:{width:20,depth:16},layoutRevision:0};}

async function fixture(page:Page,data=snapshot()){
 const state={data,writes:[] as LayoutWrite[],holdNextSave:false,held:null as null|{route:Route;write:LayoutWrite},remoteOnSave:null as Item[]|null};
 function apply(write:LayoutWrite){state.data.layout=copy(write.layout);state.data.floor=copy(write.floor);state.data.layoutRevision=(state.data.layoutRevision||0)+1;return {layout:copy(state.data.layout),floor:copy(state.data.floor),layoutRevision:state.data.layoutRevision};}
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/session')return json(route,{user,companies:[state.data.company],configured:true});
  if(path===`/api/companies/${company.id}/workspace`)return json(route,state.data);
  if(path===`/api/companies/${company.id}/presence`)return json(route,{ok:true});
  if(path===`/api/companies/${company.id}/layout`&&route.request().method()==='PATCH'){
   const write=copy(route.request().postDataJSON()) as LayoutWrite;state.writes.push(write);
   if(state.holdNextSave){state.holdNextSave=false;state.held={route,write};return;}
   if(state.remoteOnSave){state.data.layout=state.remoteOnSave;state.data.layoutRevision=(state.data.layoutRevision||0)+1;state.remoteOnSave=null;}
   if(write.revision!==(state.data.layoutRevision||0))return json(route,{error:'The floor plan changed since you opened it. Reload the latest floor before saving your changes.',code:'LAYOUT_CONFLICT'},409);
   return json(route,apply(write));
  }
  return json(route,{error:'Unexpected floor-editor fixture request: '+path},501);
 });
 return {get data(){return state.data;},get writes(){return state.writes;},holdSave(){state.holdNextSave=true;},hasHeldSave(){return !!state.held;},async releaseSave(){const held=state.held;if(!held)throw new Error('No layout save is pending.');state.held=null;await json(held.route,apply(held.write));},conflictOnSave(remote:Item[]){state.remoteOnSave=copy(remote);}};
}

async function bounds(locator:Locator){await expect(locator).toBeVisible();const box=await locator.boundingBox();expect(box).not.toBeNull();return box!;}
async function drag(page:Page,from:Point,to:Point){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:12});await page.mouse.up();}
async function center(locator:Locator):Promise<Point>{const b=await bounds(locator);return {x:b.x+b.width/2,y:b.y+b.height/2};}
async function refreshWorkspace(page:Page){const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/companies/${company.id}/workspace`);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await (await response).finished();}
const floor=(page:Page)=>page.getByTestId('floor-plan');
const item=(page:Page,id='desk-original')=>page.locator(`[data-object-id="${id}"]`);
const objects=(page:Page)=>page.locator('[data-object-id]');
const button=(page:Page,name:string)=>page.getByRole('button',{name,exact:true});
const field=(page:Page,name:string)=>page.getByLabel(name,{exact:true});
async function number(page:Page,name:string){return Number(await field(page,name).inputValue());}
async function editNumber(page:Page,name:string,value:number){await field(page,name).fill(String(value));await field(page,name).press('Tab');}
async function position(page:Page,id='desk-original'){const f=await bounds(floor(page)),b=await bounds(item(page,id));return {x:(b.x-f.x)/f.width*100,y:(b.y-f.y)/f.height*100,w:b.width/f.width*100,h:b.height/f.height*100};}
async function save(page:Page){await button(page,'Save shared floor plan').click();await expect(page.getByText('Shared floor plan is up to date',{exact:true})).toBeVisible();}

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Pointer and revision fixtures run only on a local origin.');});

test('palette drop uses the pointer location and repositioning is one undoable gesture',async({page})=>{
 await fixture(page);await page.goto('/#layout');await expect(floor(page)).toBeVisible();
 const palette=button(page,'Workstation');await palette.scrollIntoViewIfNeeded();const from=await center(palette),board=await bounds(floor(page)),target={x:board.x+board.width*.73,y:board.y+board.height*.62};await drag(page,from,target);
 await expect(objects(page)).toHaveCount(1);const added=objects(page).first(),id=(await added.getAttribute('data-object-id'))!,placed=await bounds(added);
 // Half of a 0.5m snap step plus borders/rounding. A default-centre insertion fails.
 expect(Math.abs(placed.x+placed.width/2-target.x)).toBeLessThan(board.width/20*.3+3);expect(Math.abs(placed.y+placed.height/2-target.y)).toBeLessThan(board.height/16*.3+3);
 const first=await position(page,id),start=await center(added);await drag(page,start,{x:start.x-board.width*.2,y:start.y-board.height*.15});const moved=await position(page,id);expect(moved.x).toBeLessThan(first.x-15);expect(moved.y).toBeLessThan(first.y-10);
 await button(page,'Undo').click();const restored=await position(page,id);expect(restored.x).toBeCloseTo(first.x,1);expect(restored.y).toBeCloseTo(first.y,1);await button(page,'Redo').click();const redone=await position(page,id);expect(redone.x).toBeCloseTo(moved.x,1);expect(redone.y).toBeCloseTo(moved.y,1);
});

test('edge and corner handles resize only their intended axes and remain within the floor',async({page})=>{
 await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();const original=await position(page),board=await bounds(floor(page));
 let from=await center(button(page,'Resize East'));await drag(page,from,{x:from.x+board.width*.1,y:from.y});const wider=await position(page);expect(wider.w).toBeGreaterThan(original.w+7);expect(wider.h).toBeCloseTo(original.h,1);expect(wider.x).toBeCloseTo(original.x,1);expect(wider.y).toBeCloseTo(original.y,1);
 from=await center(button(page,'Resize Southeast'));await drag(page,from,{x:from.x+board.width*.1,y:from.y+board.height*.1});const larger=await position(page);expect(larger.w).toBeGreaterThan(wider.w+7);expect(larger.h).toBeGreaterThan(wider.h+7);await button(page,'Undo').click();expect((await position(page)).h).toBeCloseTo(wider.h,1);
 from=await center(button(page,'Resize East'));await drag(page,from,{x:board.x+board.width+30,y:from.y});const clamped=await position(page);expect(clamped.x+clamped.w).toBeLessThanOrEqual(100.6);expect(clamped.w).toBeGreaterThan(0);
});

test('floor width and depth handles preserve physical furniture dimensions and enforce floor limits',async({page})=>{
 await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();const objectWidth=await number(page,'Width (m)'),objectDepth=await number(page,'Depth (m)'),board=await bounds(floor(page));
 let from=await center(button(page,'Resize floor width'));await drag(page,from,{x:from.x-board.width*.12,y:from.y});expect(await number(page,'Floor width (m)')).toBeLessThan(20);expect(await number(page,'Floor depth (m)')).toBe(16);expect(await number(page,'Width (m)')).toBeCloseTo(objectWidth,2);expect(await number(page,'Depth (m)')).toBeCloseTo(objectDepth,2);
 from=await center(button(page,'Resize floor depth'));await drag(page,from,{x:from.x,y:from.y-board.height*.12});expect(await number(page,'Floor depth (m)')).toBeLessThan(16);expect(await number(page,'Width (m)')).toBeCloseTo(objectWidth,2);expect(await number(page,'Depth (m)')).toBeCloseTo(objectDepth,2);
 await editNumber(page,'Floor width (m)',40);await editNumber(page,'Floor depth (m)',8);expect(await number(page,'Floor width (m)')).toBe(40);expect(await number(page,'Floor depth (m)')).toBe(8);
 await editNumber(page,'Left (m)',17);await editNumber(page,'Floor width (m)',2);await editNumber(page,'Floor depth (m)',50);expect(await number(page,'Floor width (m)')).toBeGreaterThanOrEqual(17+objectWidth);expect(await number(page,'Left (m)')).toBeCloseTo(17,2);expect(await number(page,'Floor depth (m)')).toBeLessThanOrEqual(40);expect(await number(page,'Width (m)')).toBeCloseTo(objectWidth,2);expect(await number(page,'Depth (m)')).toBeCloseTo(objectDepth,2);
});

test('duplicate, rotate, delete and keyboard nudge preserve selection and ignore text-field shortcuts',async({page})=>{
 const state=await fixture(page,snapshot([desk()]));await page.goto('/#layout');const original=button(page,'Select Review desk');await original.click();await page.getByRole('checkbox',{name:/^Snap to grid/}).uncheck();const left=await number(page,'Left (m)'),top=await number(page,'Top (m)');await original.focus();await page.keyboard.press('ArrowRight');await expect.poll(()=>number(page,'Left (m)')).toBeCloseTo(left+.1,2);await page.keyboard.press('Shift+ArrowDown');await expect.poll(()=>number(page,'Top (m)')).toBeCloseTo(top+1,2);
 await field(page,'Label').fill('Keyboard-safe desk');await field(page,'Label').press('Home');await page.keyboard.press('Delete');await expect(objects(page)).toHaveCount(1);expect(await number(page,'Left (m)')).toBeCloseTo(left+.1,2);await field(page,'Label').fill('Keyboard-safe desk');await field(page,'Label').press('Tab');
 const width=await number(page,'Width (m)'),depth=await number(page,'Depth (m)');await button(page,'Duplicate selected object').click();await expect(objects(page)).toHaveCount(2);await button(page,'Rotate selected object').click();await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(depth,2);await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(width,2);await button(page,'Remove selected object').click();await expect(objects(page)).toHaveCount(1);await button(page,'Undo').click();await expect(objects(page)).toHaveCount(2);
 await save(page);expect(state.data.layout).toHaveLength(2);expect(new Set(state.data.layout.map(v=>v.id)).size).toBe(2);expect(state.data.layout.find(v=>v.id!=='desk-original')?.rotation).toBe(90);
});

test('save includes floor dimensions and expected revision and reload restores the saved layout',async({page})=>{
 const legacy=snapshot([desk()]);delete legacy.floor;delete legacy.layoutRevision;const state=await fixture(page,legacy);await page.goto('/#layout');expect(await number(page,'Floor width (m)')).toBe(20);expect(await number(page,'Floor depth (m)')).toBe(16);await button(page,'Select Review desk').click();await field(page,'Label').fill('Editorial desk');await editNumber(page,'Width (m)',4);await editNumber(page,'Floor width (m)',24);await editNumber(page,'Floor depth (m)',20);await save(page);
 expect(state.writes).toHaveLength(1);expect(Object.keys(state.writes[0]).sort()).toEqual(['floor','layout','revision']);expect(state.writes[0].revision).toBe(0);expect(state.data.layoutRevision).toBe(1);expect(state.writes[0].floor).toEqual({width:24,depth:20});expect(state.writes[0].layout[0].label).toBe('Editorial desk');expect(state.writes[0].layout[0].w*24/100).toBeCloseTo(4,2);
 await page.reload();await button(page,'Select Editorial desk').click();expect(await number(page,'Width (m)')).toBeCloseTo(4,2);expect(await number(page,'Floor width (m)')).toBe(24);expect(await number(page,'Floor depth (m)')).toBe(20);await expect(button(page,'Save shared floor plan')).toBeDisabled();
});

test('a delayed save advances the baseline revision without marking newer edits as saved',async({page})=>{
 const state=await fixture(page,snapshot([desk()]));state.holdSave();await page.goto('/#layout');await button(page,'Select Review desk').click();await field(page,'Label').fill('Submitted version');await button(page,'Save shared floor plan').click();await expect.poll(()=>state.hasHeldSave()).toBe(true);
 await field(page,'Label').fill('Newer local version');await editNumber(page,'Left (m)',7);await state.releaseSave();await expect(page.getByText('You have unpublished changes',{exact:true})).toBeVisible();await expect(field(page,'Label')).toHaveValue('Newer local version');expect(state.data.layout[0].label).toBe('Submitted version');await expect(button(page,'Save shared floor plan')).toBeEnabled();await save(page);
 expect(state.writes).toHaveLength(2);expect(state.writes.map(w=>w.revision)).toEqual([0,1]);expect(state.data.layout[0].label).toBe('Newer local version');expect(state.data.layout[0].x*state.data.floor!.width/100).toBeCloseTo(7,2);expect(state.data.layoutRevision).toBe(2);
});

for(const choice of ['Reload saved layout','Keep my draft'] as const)test(`a revision conflict preserves the draft until ${choice.toLowerCase()} is chosen`,async({page})=>{
 const state=await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();await field(page,'Label').fill('My unpublished draft');await field(page,'Label').press('Tab');state.conflictOnSave([desk({label:'Teammate saved desk',x:35})]);
 const conflictResponse=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.endsWith('/layout'));await button(page,'Save shared floor plan').click();expect((await conflictResponse).status()).toBe(409);await expect(button(page,'Reload saved layout')).toBeVisible();await expect(field(page,'Label')).toHaveValue('My unpublished draft');await expect(button(page,'Save shared floor plan')).toBeDisabled();expect(state.data.layout[0].label).toBe('Teammate saved desk');expect(state.writes).toHaveLength(1);
 await button(page,choice).click();if(choice==='Reload saved layout'){await button(page,'Select Teammate saved desk').click();await expect(field(page,'Label')).toHaveValue('Teammate saved desk');await expect(button(page,'Save shared floor plan')).toBeDisabled();}else{await expect(field(page,'Label')).toHaveValue('My unpublished draft');await save(page);expect(state.writes[1].revision).toBe(1);expect(state.data.layoutRevision).toBe(2);expect(state.data.layout[0].label).toBe('My unpublished draft');}
});

test('390px layout keeps zoomed geometry inside its viewport and numeric editing remains usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);await page.goto('/#layout');await button(page,'Workstation').click();await expect(objects(page)).toHaveCount(1);await editNumber(page,'Floor width (m)',40);await editNumber(page,'Floor depth (m)',40);await button(page,'Zoom in').click();await button(page,'Zoom in').click();
 const viewport=await bounds(page.getByTestId('floor-viewport'));expect(viewport.x).toBeGreaterThanOrEqual(0);expect(viewport.x+viewport.width).toBeLessThanOrEqual(391);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await field(page,'Floor width (m)').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);await button(page,'Fit floor').click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('Escape cancels a numeric draft without changing geometry or enabling save',async({page})=>{
 await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();const original=await position(page),left=await number(page,'Left (m)'),floorWidth=await number(page,'Floor width (m)');
 await field(page,'Left (m)').fill('9');await field(page,'Left (m)').press('Escape');await expect(field(page,'Left (m)')).toHaveValue(String(left));const unchanged=await position(page);expect(unchanged.x).toBeCloseTo(original.x,2);
 await field(page,'Floor width (m)').fill('35');await field(page,'Floor width (m)').press('Escape');await expect(field(page,'Floor width (m)')).toHaveValue(String(floorWidth));await expect(button(page,'Save shared floor plan')).toBeDisabled();
});

test('label edits form one history step and unpublished work can be kept or explicitly discarded',async({page})=>{
 await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();await field(page,'Label').fill('My complete label edit');await field(page,'Label').press('Tab');await button(page,'Undo').click();await expect(field(page,'Label')).toHaveValue('Review desk');await button(page,'Redo').click();await expect(field(page,'Label')).toHaveValue('My complete label edit');
 page.once('dialog',dialog=>dialog.dismiss());await button(page,'People').click();await expect(page).toHaveURL(/#layout$/);await expect(field(page,'Label')).toHaveValue('My complete label edit');
 page.once('dialog',dialog=>dialog.accept());await button(page,'Discard changes').click();await button(page,'Select Review desk').click();await expect(field(page,'Label')).toHaveValue('Review desk');await expect(button(page,'Save shared floor plan')).toBeDisabled();
 await floor(page).focus();await page.keyboard.press('Delete');await expect(objects(page)).toHaveCount(0);await page.keyboard.press('Control+z');await expect(objects(page)).toHaveCount(1);await page.keyboard.press('Control+Shift+z');await expect(objects(page)).toHaveCount(0);
});

test('label undo keeps a clean remote floor adopted while the label field was focused',async({page})=>{
 const state=await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();await field(page,'Label').focus();
 state.data.layout=[desk({label:'Latest shared desk',x:35})];state.data.floor={width:24,depth:18};state.data.layoutRevision=1;await refreshWorkspace(page);await expect(field(page,'Label')).toHaveValue('Latest shared desk');await expect(field(page,'Floor width (m)')).toHaveValue('24');
 await field(page,'Label').fill('My later label');await field(page,'Label').press('Tab');await button(page,'Undo').click();await expect(field(page,'Label')).toHaveValue('Latest shared desk');expect(await number(page,'Floor width (m)')).toBe(24);expect(await number(page,'Left (m)')).toBeCloseTo(8.4,2);await expect(button(page,'Save shared floor plan')).toBeDisabled();
});

test('blurring an untouched numeric field cannot revert a newer shared position',async({page})=>{
 const state=await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();await field(page,'Left (m)').focus();
 state.data.layout=[desk({x:40,w:20})];state.data.floor={width:24,depth:18};state.data.layoutRevision=1;await refreshWorkspace(page);await expect(field(page,'Left (m)')).toHaveValue('9.6');await field(page,'Left (m)').press('Tab');await expect(field(page,'Left (m)')).toHaveValue('9.6');expect(await number(page,'Width (m)')).toBeCloseTo(4.8,2);await expect(button(page,'Save shared floor plan')).toBeDisabled();expect(state.writes).toHaveLength(0);
});

test('Escape cancels a palette drag even when keyboard focus started outside the editor',async({page})=>{
 await fixture(page);await page.goto('/#layout');await floor(page).waitFor();await page.locator('#main').focus();const from=await center(button(page,'Workstation')),board=await bounds(floor(page)),to={x:board.x+board.width*.65,y:board.y+board.height*.55};await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:12});await expect(page.getByText('Drop here',{exact:true})).toBeVisible();await page.keyboard.press('Escape');await page.mouse.up();await expect(objects(page)).toHaveCount(0);await expect(page.getByText('Drop here',{exact:true})).toHaveCount(0);await expect(button(page,'Save shared floor plan')).toBeDisabled();
});

test('a browser pointer-cancel event rolls a move back without adding a history entry',async({page})=>{
 await fixture(page,snapshot([desk()]));await page.goto('/#layout');await button(page,'Select Review desk').click();const original=await position(page),from=await center(item(page)),board=await bounds(floor(page));await page.evaluate(()=>window.addEventListener('pointerdown',event=>{(window as any).floorTestPointerId=event.pointerId;},{once:true,capture:true}));await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(from.x+board.width*.1,from.y+board.height*.1,{steps:12});await expect.poll(async()=>(await position(page)).x).toBeGreaterThan(original.x+5);
 await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:(window as any).floorTestPointerId,pointerType:'mouse',isPrimary:true})));await page.mouse.up();const restored=await position(page);expect(restored.x).toBeCloseTo(original.x,2);expect(restored.y).toBeCloseTo(original.y,2);await expect(button(page,'Undo')).toBeDisabled();await expect(button(page,'Save shared floor plan')).toBeDisabled();
});
