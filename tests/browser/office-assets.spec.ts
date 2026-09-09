import {test,expect,type Locator,type Page,type Route} from '@playwright/test';
import type {FloorSize,LayoutItem,Workspace} from '../../src/lib/client';
import {OFFICE_CATALOG} from '../../src/lib/office-catalog';

// All intercepted cases use synthetic previews and local-only workspace data.
// The separate opt-in persistence case uses actual authenticated local APIs;
// no purchased model or preview bytes are embedded in this public test file.
type Asset={id:string;name:string;category:string;width:number;depth:number;height:number;resize:'uniform'|'footprint'};
type Snapshot=Workspace&{floor:FloorSize;layoutRevision:number};
type Write={layout:LayoutItem[];floor:FloorSize;revision:number};
type Point={x:number;y:number};
const user={id:'10000000-0000-4000-8000-000000000091',name:'Office Asset Reviewer',email:'office-assets@example.invalid',roleTitle:'Studio designer',avatarColor:'#607850',avatarId:null};
const company={id:'20000000-0000-4000-8000-000000000091',name:'Office Asset Studio',slug:'office-asset-fixture',template:'blank',role:'owner'};
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const json=(route:Route,value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const preview=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPoXdjyHwAGIwKyeWvUQwAAAABJRU5ErkJggg==','base64');
const legacy=():LayoutItem=>({id:'legacy-desk',type:'desk',x:5,y:8,w:15,h:12.5,label:'Existing desk',rotation:0});
function snapshot(layout:LayoutItem[]=[]):Snapshot{return {company,members:[{...user,userId:user.id,role:'owner'}],rooms:[],agents:[],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:copy(layout),floor:{width:20,depth:16},layoutRevision:0};}
function assetItem(asset:Asset,overrides:Partial<LayoutItem>={}):LayoutItem{return {id:'asset-review',type:'asset',assetId:asset.id,x:30,y:30,w:asset.width/20*100,h:asset.depth/16*100,label:asset.name,rotation:0,...overrides};}

async function fixture(page:Page,catalog:readonly Asset[],data=snapshot(),failedPreview?:string){
 const writes:Write[]=[],previewRequests:string[]=[],planRequests:string[]=[],unexpected:string[]=[],failedPreviews=new Set(failedPreview?[failedPreview]:[]);
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/session')return json(route,{user,companies:[data.company],configured:true});
  if(path===`/api/companies/${company.id}/workspace`)return json(route,data);
  if(path===`/api/companies/${company.id}/presence`)return json(route,{ok:true});
  if(path==='/api/office-assets')return json(route,{assets:catalog});
  const request=path.match(/^\/api\/office-assets\/([^/]+)\/(preview|plan)$/);
  if(request){(request[2]==='preview'?previewRequests:planRequests).push(request[1]);if(request[2]==='preview'&&failedPreviews.has(request[1]))return json(route,{error:'This office asset is temporarily unavailable.',code:'OFFICE_ASSET_UNAVAILABLE'},503);return route.fulfill({status:200,contentType:'image/png',body:preview});}
  if(path===`/api/companies/${company.id}/layout`&&route.request().method()==='PATCH'){
   const write=copy(route.request().postDataJSON()) as Write;writes.push(write);
   if(write.revision!==data.layoutRevision)return json(route,{error:'The floor plan changed since you opened it. Reload the latest floor before saving your changes.',code:'LAYOUT_CONFLICT'},409);
   data.layout=copy(write.layout);data.floor=copy(write.floor);data.layoutRevision++;
   return json(route,{layout:data.layout,floor:data.floor,layoutRevision:data.layoutRevision});
  }
  unexpected.push(path);return json(route,{error:'Unexpected office-asset fixture request.'},501);
 });
 return {data,writes,previewRequests,planRequests,unexpected,restorePreview:(id:string)=>failedPreviews.delete(id)};
}

const button=(page:Page,name:string)=>page.getByRole('button',{name,exact:true});
const field=(page:Page,name:string)=>page.getByLabel(name,{exact:true});
const floor=(page:Page)=>page.getByTestId('floor-plan');
const objects=(page:Page)=>page.locator('[data-object-id]');
async function number(page:Page,name:string){return Number(await field(page,name).inputValue());}
async function editNumber(page:Page,name:string,value:number){await field(page,name).fill(String(value));await field(page,name).press('Tab');}
async function bounds(locator:Locator){await expect(locator).toBeVisible();const box=await locator.boundingBox();expect(box).not.toBeNull();return box!;}
async function center(locator:Locator):Promise<Point>{const box=await bounds(locator);return {x:box.x+box.width/2,y:box.y+box.height/2};}
async function drag(page:Page,from:Point,to:Point){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:12});await page.mouse.up();}
async function physical(page:Page){return {x:await number(page,'Left (m)'),y:await number(page,'Top (m)'),width:await number(page,'Width (m)'),depth:await number(page,'Depth (m)')};}
async function save(page:Page){await button(page,'Save shared floor plan').click();await expect(page.getByText('Shared floor plan is up to date',{exact:true})).toBeVisible();}

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Office-asset fixtures are restricted to a loopback application.');});

const taskDesk=OFFICE_CATALOG.find(asset=>asset.name==='Compact task desk')!;
const privacyPanel=OFFICE_CATALOG.find(asset=>asset.name==='White privacy panel')!;
const search=(page:Page)=>field(page,'Search furniture');
const category=(page:Page)=>field(page,'Furniture category');
async function findAsset(page:Page,asset:Asset){await search(page).fill(asset.name);await expect(button(page,asset.name)).toBeVisible();return button(page,asset.name);}

test('library pagination and combined search/category filters reveal the expected furniture',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG);await page.goto('/#layout');await expect(floor(page)).toBeVisible();
 for(const asset of OFFICE_CATALOG.slice(0,12))await expect(button(page,asset.name)).toBeVisible();
 await expect(button(page,OFFICE_CATALOG[12].name)).toHaveCount(0);await button(page,'Show more furniture').click();
 for(const asset of OFFICE_CATALOG.slice(12,24))await expect(button(page,asset.name)).toBeVisible();
 await category(page).selectOption({label:'Partitions & floors'});await search(page).fill('  WHITE PRIVACY  ');await expect(button(page,privacyPanel.name)).toBeVisible();await expect(button(page,taskDesk.name)).toHaveCount(0);
 await category(page).selectOption({label:'Desks'});await expect(button(page,privacyPanel.name)).toHaveCount(0);await expect(button(page,taskDesk.name)).toHaveCount(0);
 await search(page).fill('Compact');await expect(button(page,taskDesk.name)).toBeVisible();await category(page).selectOption({label:'All furniture'});await search(page).fill('');
 await expect(button(page,OFFICE_CATALOG[0].name)).toBeVisible();await expect(button(page,OFFICE_CATALOG[12].name)).toHaveCount(0);expect(state.unexpected).toEqual([]);
});

test('furniture cards reserve visible image space instead of collapsing loaded thumbnails',async({page})=>{
 await fixture(page,OFFICE_CATALOG);await page.goto('/#layout');const card=await findAsset(page,taskDesk),image=card.locator('img');await expect.poll(()=>image.evaluateAll(images=>images.length===1&&(images[0] as HTMLImageElement).naturalWidth>0)).toBe(true);const imageBox=await bounds(image);expect(imageBox.height).toBeGreaterThan(50);expect(imageBox.width).toBeGreaterThan(50);
 await page.setViewportSize({width:390,height:844});await card.scrollIntoViewIfNeeded();const mobileBox=await bounds(image);expect(mobileBox.height).toBeGreaterThan(50);expect(mobileBox.width).toBeGreaterThan(50);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('dragging a model places its authored dimensions at the pointer and saves its catalog ID',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG);await page.goto('/#layout');const card=await findAsset(page,taskDesk);await card.scrollIntoViewIfNeeded();const from=await center(card),board=await bounds(floor(page)),target={x:board.x+board.width*.69,y:board.y+board.height*.58};await drag(page,from,target);
 await expect(objects(page)).toHaveCount(1);await expect(objects(page).first()).toHaveAttribute('data-object-type','asset');const placed=await bounds(objects(page).first());
 expect(Math.abs(placed.x+placed.width/2-target.x)).toBeLessThan(board.width/20*.3+3);expect(Math.abs(placed.y+placed.height/2-target.y)).toBeLessThan(board.height/16*.3+3);
 await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(taskDesk.width,2);await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(taskDesk.depth,2);await expect(page.getByText('Proportions locked',{exact:false})).toBeVisible();await save(page);
 expect(state.writes).toHaveLength(1);const stored=state.data.layout[0];expect(stored.type).toBe('asset');expect(stored.assetId).toBe(taskDesk.id);expect(stored.w*20/100).toBeCloseTo(taskDesk.width,5);expect(stored.h*16/100).toBeCloseTo(taskDesk.depth,5);expect(state.data.layoutRevision).toBe(1);
 await page.reload();await button(page,'Select '+stored.label).click();await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(taskDesk.width,2);await expect(button(page,'Save shared floor plan')).toBeDisabled();expect(state.unexpected).toEqual([]);
});

test('starting an object drag commits a pending numeric size before capturing the move',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG,snapshot([assetItem(taskDesk,{w:20,h:4*taskDesk.depth/taskDesk.width/16*100})]));await page.goto('/#layout');await button(page,'Select '+taskDesk.name).click();await page.getByRole('checkbox',{name:/^Snap to grid/}).uncheck();await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(4,2);const before=await physical(page),board=await bounds(floor(page)),from=await center(objects(page).first());
 // Do not blur or press Tab: pointer-down must commit the 6m text draft before
 // the drag records its geometry/history snapshot.
 await field(page,'Width (m)').fill('6');await expect(field(page,'Width (m)')).toBeFocused();await drag(page,from,{x:from.x+board.width/20*2,y:from.y+board.height/16});await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(6,2);await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(6*taskDesk.depth/taskDesk.width,2);await expect.poll(()=>number(page,'Left (m)')).toBeCloseTo(before.x+2,2);await expect.poll(()=>number(page,'Top (m)')).toBeCloseTo(before.y+1,2);
 await save(page);const stored=state.data.layout[0];expect(stored.w*20/100).toBeCloseTo(6,5);expect(stored.h*16/100).toBeCloseTo(6*taskDesk.depth/taskDesk.width,5);expect(stored.x*20/100).toBeCloseTo(before.x+2,5);
});

test('dragging the center of a native-size selected desk moves it without activating a resize handle',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG,snapshot([assetItem(taskDesk)]));await page.goto('/#layout');await button(page,'Select '+taskDesk.name).click();await page.getByRole('checkbox',{name:/^Snap to grid/}).uncheck();const before=await physical(page),board=await bounds(floor(page)),from=await center(objects(page).first());await drag(page,from,{x:from.x+board.width/20*2,y:from.y+board.height/16});
 await expect.poll(()=>number(page,'Left (m)')).toBeCloseTo(before.x+2,2);await expect.poll(()=>number(page,'Top (m)')).toBeCloseTo(before.y+1,2);await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(taskDesk.width,2);await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(taskDesk.depth,2);await save(page);const stored=state.data.layout[0];expect(stored.w*20/100).toBeCloseTo(taskDesk.width,5);expect(stored.h*16/100).toBeCloseTo(taskDesk.depth,5);expect(stored.x*20/100).toBeCloseTo(before.x+2,5);expect(stored.y*16/100).toBeCloseTo(before.y+1,5);
});

test('uniform furniture keeps its proportions through numeric and pointer resize after rotation',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG,snapshot([assetItem(taskDesk)]));await page.goto('/#layout');await button(page,'Select '+taskDesk.name).click();await page.getByRole('checkbox',{name:/^Snap to grid/}).uncheck();
 await editNumber(page,'Width (m)',2.4);await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(2.4*taskDesk.depth/taskDesk.width,2);await button(page,'Rotate selected object').click();await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(2.4,2);
 const before=await physical(page),board=await bounds(floor(page)),from=await center(button(page,'Resize East'));await drag(page,from,{x:from.x+board.width/20*.5,y:from.y});await expect.poll(()=>number(page,'Width (m)')).toBeGreaterThan(before.width+.35);
 await save(page);const stored=state.data.layout[0];expect(stored.rotation).toBe(90);expect(stored.assetId).toBe(taskDesk.id);expect((stored.w*20)/(stored.h*16)).toBeCloseTo(taskDesk.depth/taskDesk.width,5);expect(stored.w*20/100).toBeGreaterThan(before.width+.35);
});

test('repeated oversized numeric edits display the actual uniform size constrained by the other axis',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG,snapshot([assetItem(taskDesk,{y:87.5})]));await page.goto('/#layout');await button(page,'Select '+taskDesk.name).click();const maximumWidth=2*taskDesk.width/taskDesk.depth;
 await editNumber(page,'Width (m)',20);await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(maximumWidth,2);await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(2,2);
 await editNumber(page,'Width (m)',20);await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(maximumWidth,2);await save(page);const stored=state.data.layout[0];expect(stored.w*20/100).toBeCloseTo(maximumWidth,5);expect(stored.y+stored.h).toBeLessThanOrEqual(100);
});

test('floor resizing preserves model dimensions and a thin partition can grow on just one axis',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG,snapshot([assetItem(taskDesk),assetItem(privacyPanel,{id:'panel-review',x:65,y:65})]));await page.goto('/#layout');await button(page,'Select '+taskDesk.name).click();const initial=await physical(page);await editNumber(page,'Floor width (m)',24);await editNumber(page,'Floor depth (m)',20);
 for(const [key,label] of [['x','Left (m)'],['y','Top (m)'],['width','Width (m)'],['depth','Depth (m)']] as const)await expect.poll(()=>number(page,label)).toBeCloseTo(initial[key],2);
 await button(page,'Select '+privacyPanel.name).click();await editNumber(page,'Width (m)',3);await expect.poll(()=>number(page,'Depth (m)')).toBeCloseTo(privacyPanel.depth,2);await save(page);
 const desk=state.data.layout.find(item=>item.id==='asset-review')!,panel=state.data.layout.find(item=>item.id==='panel-review')!;expect(desk.w*24/100).toBeCloseTo(taskDesk.width,5);expect(desk.h*20/100).toBeCloseTo(taskDesk.depth,5);expect(panel.w*24/100).toBeCloseTo(3,5);expect(panel.h*20/100).toBeCloseTo(privacyPanel.depth,5);expect(panel.assetId).toBe(privacyPanel.id);
});

test('duplicate, rotation, delete and undo retain catalog identity alongside an existing legacy desk',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG,snapshot([legacy(),assetItem(taskDesk)]));await page.goto('/#layout');await button(page,'Select '+taskDesk.name).click();await button(page,'Duplicate selected object').click();await expect(objects(page)).toHaveCount(3);await button(page,'Rotate selected object').click();await button(page,'Remove selected object').click();await expect(objects(page)).toHaveCount(2);await button(page,'Undo').click();await expect(objects(page)).toHaveCount(3);await save(page);
 const stored=state.data.layout,models=stored.filter(item=>item.type==='asset');expect(models).toHaveLength(2);expect(models.every(item=>item.assetId===taskDesk.id)).toBe(true);expect(new Set(stored.map(item=>item.id)).size).toBe(3);expect(models.find(item=>item.id!=='asset-review')?.rotation).toBe(90);expect(stored.find(item=>item.id==='legacy-desk')).toEqual(legacy());
 await page.reload();await expect(objects(page)).toHaveCount(3);await button(page,'Select Existing desk').click();await expect.poll(()=>number(page,'Width (m)')).toBeCloseTo(3,2);await expect(button(page,'Save shared floor plan')).toBeDisabled();
});

test('an unavailable thumbnail keeps the named card usable and can recover through an explicit retry',async({page})=>{
 const state=await fixture(page,OFFICE_CATALOG,snapshot(),taskDesk.id);await page.goto('/#layout');const card=await findAsset(page,taskDesk);await expect.poll(()=>state.previewRequests.includes(taskDesk.id)).toBe(true);await expect(card.getByText('Preview unavailable',{exact:true})).toBeVisible();await expect(card).toBeEnabled();await card.click();await expect(objects(page)).toHaveCount(1);await save(page);expect(state.data.layout[0].assetId).toBe(taskDesk.id);
 const requestsBeforeRetry=state.previewRequests.filter(id=>id===taskDesk.id).length;state.restorePreview(taskDesk.id);await button(page,'Retry previews').click();await expect.poll(()=>card.locator('img').evaluateAll(images=>images.length>0&&images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);await expect(card.getByText('Preview unavailable',{exact:true})).toHaveCount(0);expect(state.previewRequests.filter(id=>id===taskDesk.id)).toHaveLength(requestsBeforeRetry+1);expect(state.unexpected).toEqual([]);
});

test('the searchable library and selected asset inspector stay usable at 390px',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page,OFFICE_CATALOG);await page.goto('/#layout');const card=await findAsset(page,taskDesk);await card.click();await expect(objects(page)).toHaveCount(1);await editNumber(page,'Width (m)',2);await editNumber(page,'Floor width (m)',32);await button(page,'Fit floor').click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);for(const locator of [search(page),category(page),field(page,'Width (m)')]){await locator.scrollIntoViewIfNeeded();const box=await bounds(locator);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(391);expect(await locator.evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);}
 await save(page);await page.reload();await expect(objects(page)).toHaveCount(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('a real local workplace saves a catalog model, reloads its dimensions and loads the licensed geometry',async({page,context,browser,baseURL})=>{
 test.skip(process.env.COATRIA_OFFICE_REAL_DB!=='1','Set COATRIA_OFFICE_REAL_DB=1 only for a disposable loopback database and the private office bundle.');
 const suffix=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const signup=await context.request.post('/api/auth/signup',{headers:{Origin:baseURL!},data:{name:'Office Asset Persistence QA',email:`office-${suffix}@example.invalid`,password:`Office asset persistence passphrase ${suffix}`}});expect(signup.status(),'Local fixture signup must succeed.').toBe(201);const session=await signup.json();
 const creation=await context.request.post('/api/companies',{headers:{Origin:baseURL!},data:{name:'Office Asset Persistence Studio',slug:'office-'+suffix,template:'blank'}});expect(creation.status(),'Local blank workplace creation must succeed.').toBe(201);const sessionResponse=await context.request.get('/api/session');expect(sessionResponse.ok()).toBe(true);const companyId:string=(await sessionResponse.json()).companies[0].id;
 const catalogResponse=await context.request.get('/api/office-assets');expect(catalogResponse.ok()).toBe(true);const catalog=await catalogResponse.json();expect(catalog.assets.find((asset:Asset)=>asset.id===taskDesk.id)).toMatchObject({name:taskDesk.name,width:taskDesk.width,depth:taskDesk.depth,resize:'uniform'});
 const planAvailability=await context.request.get(`/api/office-assets/${taskDesk.id}/plan`,{headers:{'X-Coatria-User':session.user.id}});expect(planAvailability.status(),'The real local top-down plan PNG must be available before the UI check.').toBe(200);expect(planAvailability.headers()['content-type']).toContain('image/png');
 const anonymous=await browser.newContext({baseURL});try{for(const resource of ['preview','plan','model']){const blocked=await anonymous.request.get(`/api/office-assets/${taskDesk.id}/${resource}`);expect(blocked.status()).toBe(401);}}finally{await anonymous.close();}
 await page.goto('/#layout');const card=await findAsset(page,taskDesk);await expect.poll(()=>card.locator('img').evaluateAll(images=>images.length>0&&images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);const planLoading=page.waitForResponse(result=>new URL(result.url()).pathname===`/api/office-assets/${taskDesk.id}/plan`);await card.click();await expect(objects(page)).toHaveCount(1);const planImage=await planLoading;expect(planImage.status()).toBe(200);expect(planImage.headers()['content-type']).toContain('image/png');expect(planImage.request().headers()['x-coatria-user']).toBe(session.user.id);await expect.poll(()=>objects(page).first().locator('img').evaluateAll(images=>images.length===1&&(images[0] as HTMLImageElement).naturalWidth>0)).toBe(true);
 await field(page,'Label').fill('Persisted licensed task desk');await field(page,'Label').press('Tab');await editNumber(page,'Width (m)',2.4);await button(page,'Rotate selected object').click();await editNumber(page,'Floor width (m)',24);await editNumber(page,'Floor depth (m)',18);const expected=await physical(page);
 const saving=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname===`/api/companies/${companyId}/layout`);await save(page);const response=await saving;expect(response.ok()).toBe(true);const submitted=response.request().postDataJSON() as Write,accepted=await response.json();expect(submitted.layout[0]).toMatchObject({type:'asset',assetId:taskDesk.id,rotation:90});expect(accepted.layoutRevision).toBe(submitted.revision+1);
 await page.reload();await button(page,'Select Persisted licensed task desk').click();for(const [key,label] of [['x','Left (m)'],['y','Top (m)'],['width','Width (m)'],['depth','Depth (m)']] as const)await expect.poll(()=>number(page,label)).toBeCloseTo(expected[key],2);await expect(button(page,'Save shared floor plan')).toBeDisabled();
 const workspaceResponse=await context.request.get(`/api/companies/${companyId}/workspace`);expect(workspaceResponse.ok()).toBe(true);const workspace=await workspaceResponse.json() as Snapshot;expect(workspace.floor).toEqual({width:24,depth:18});expect(workspace.layoutRevision).toBe(accepted.layoutRevision);expect(workspace.layout).toHaveLength(1);const stored=workspace.layout[0];expect(stored).toMatchObject({type:'asset',assetId:taskDesk.id,label:'Persisted licensed task desk',rotation:90});expect(stored.w*24/(stored.h*18)).toBeCloseTo(taskDesk.depth/taskDesk.width,5);
 const loading=page.waitForResponse(result=>new URL(result.url()).pathname===`/api/office-assets/${taskDesk.id}/model`);await button(page,'Back to the office').click();await expect(page.locator('canvas')).toBeVisible();const model=await loading;expect(model.status()).toBe(200);expect(model.headers()['content-type']).toContain('model/gltf-binary');expect(model.request().headers()['x-coatria-user']).toBe(session.user.id);
 await expect.poll(()=>page.evaluate(()=>(window as any).CoatriaScene?.instance?.diagnostics.officeAssets?.[0]?.status)).toBe('ready');const scene=await page.evaluate(()=>(window as any).CoatriaScene.instance.diagnostics);expect(scene.floor).toEqual({width:24,depth:18});expect(scene.officeAssets).toHaveLength(1);const rendered=scene.officeAssets[0],footprint=scene.objects.find((item:{id:string})=>item.id===stored.id);
 expect(rendered).toMatchObject({id:stored.id,assetId:taskDesk.id,status:'ready',modelLoaded:true,collidable:true,resize:'uniform'});expect(rendered.scale.x).toBeCloseTo(rendered.scale.y,5);expect(rendered.scale.x).toBeCloseTo(rendered.scale.z,5);expect(rendered.height).toBeCloseTo(taskDesk.height*rendered.scale.y,3);expect(footprint.rotation).toBe(90);expect(footprint.width).toBeCloseTo(stored.w*24/100,5);expect(footprint.depth).toBeCloseTo(stored.h*18/100,5);
 expect(rendered.bounds.maxX-rendered.bounds.minX).toBeGreaterThan(footprint.width*.98);expect(rendered.bounds.maxZ-rendered.bounds.minZ).toBeGreaterThan(footprint.depth*.98);expect(rendered.bounds.minX).toBeGreaterThanOrEqual(footprint.bounds.minX-.002);expect(rendered.bounds.maxX).toBeLessThanOrEqual(footprint.bounds.maxX+.002);expect(rendered.bounds.minZ).toBeGreaterThanOrEqual(footprint.bounds.minZ-.002);expect(rendered.bounds.maxZ).toBeLessThanOrEqual(footprint.bounds.maxZ+.002);
 expect(errors).toEqual([]);
});
