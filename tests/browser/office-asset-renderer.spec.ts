import {test,expect,type Page,type Route} from '@playwright/test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OFFICE_CATALOG} from '../../src/lib/office-catalog';

const identity='18000000-0000-4000-8000-000000000001';
const definition=(id:string)=>({id,name:id,category:'desks',width:2,depth:1,height:1,resize:'uniform',collidable:true});
const catalog=Array.from({length:18},(_,index)=>definition('fixture-'+index));
// Original box fixture only. Purchased geometry is read locally, never embedded.
function binaryFixture(externalUri?:string){
  const positions=Buffer.from(new Float32Array([-1,0,-.5,1,0,-.5,-1,1,-.5,1,1,-.5,-1,0,.5,1,0,.5,-1,1,.5,1,1,.5]).buffer);
  const indices=Buffer.from(new Uint16Array([0,2,1,1,2,3,4,5,6,5,7,6,0,4,2,4,6,2,1,3,5,3,7,5,2,6,3,3,6,7,0,1,4,1,5,4]).buffer);
  const binary=Buffer.concat([positions,indices]);
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[.5,.65,.45,1],metallicFactor:0,roughnessFactor:1}}],buffers:[{byteLength:binary.length,...(externalUri?{uri:externalUri}:{})}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.length},{buffer:0,byteOffset:positions.length,byteLength:indices.length}],accessors:[{bufferView:0,componentType:5126,type:'VEC3',count:8,min:[-1,0,-.5],max:[1,1,.5]},{bufferView:1,componentType:5123,type:'SCALAR',count:36}]};
  let json=Buffer.from(JSON.stringify(doc));while(json.length%4)json=Buffer.concat([json,Buffer.from(' ')]);
  const header=Buffer.alloc(12),jsonHeader=Buffer.alloc(8),binHeader=Buffer.alloc(8);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);jsonHeader.writeUInt32LE(json.length);jsonHeader.writeUInt32LE(0x4e4f534a,4);binHeader.writeUInt32LE(binary.length);binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jsonHeader,json,binHeader,binary]);
}
const fixture=binaryFixture();
const diagnostics=(page:Page)=>page.evaluate(()=>(window as any).assetTest.instance.diagnostics);
const fulfill=(route:Route,body=fixture)=>route.fulfill({contentType:'model/gltf-binary',body});
async function install(page:Page){
  await page.route('**/office-asset-renderer-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/spatial/office-scene.css"><style>body{margin:0}#office{height:100vh;width:100vw}</style></head><body><main id="office"></main><script type="module">import * as THREE from "/spatial/vendor/three.module.js";import {mount} from "/spatial/office-scene.js";import {createOfficeAssetLibrary} from "/spatial/office-asset-library.js";window.assetTest={THREE,mount,createOfficeAssetLibrary};</script></body></html>'}));
  await page.goto('/office-asset-renderer-fixture');await expect.poll(()=>page.evaluate(()=>typeof (window as any).assetTest?.mount)).toBe('function');
}
async function mount(page:Page,definitions:any[],layout:any[]){
  await page.evaluate(({definitions,layout,identity})=>{
    const harness=(window as any).assetTest;harness.openedRooms=[];harness.library=harness.createOfficeAssetLibrary({userId:identity,catalog:definitions});
    harness.instance=harness.mount(document.getElementById('office'),{customLayout:true,officeCatalog:definitions,loadOfficeAsset:harness.library.loadAsset,layout,state:{user:{id:identity,name:'Furniture reviewer'},spatialPosition:{x:0,z:5}},rooms:[],members:[],presence:[],agents:[],quality:'low',reducedMotion:true,onOpenRoom:(id:string)=>harness.openedRooms.push(id)});
  },{definitions,layout,identity});
}
const item=(id:string,assetId:string,x:number,y:number,w=10,h=6.25,rotation=0)=>({id,assetId,type:'asset',label:id,x,y,w,h,rotation});
test.beforeEach(async({baseURL})=>test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Read-only local renderer and network fixtures.'));

test('actual private models fit authored metres and rotations, floors stay walkable, and leases protect shared resources',async({page},testInfo)=>{
  const ids=['office-desk-001','office-chair-001','office-partitions-005','office-floor-004','office-partitions-039'];
  test.skip(ids.some(id=>!existsSync(join(process.cwd(),'.runtime-assets/office-models',id+'.glb'))),'Purchased local runtime bundle is required for this geometry audit.');
  const definitions=ids.map(id=>OFFICE_CATALOG.find(asset=>asset.id===id)!);
  const [desk,chair,panel,floor,thinPanel]=definitions,requests:{id:string;identity:string}[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/office-assets/*/model',route=>{const id=new URL(route.request().url()).pathname.split('/')[3];requests.push({id,identity:route.request().headers()['x-coatria-user']});return fulfill(route,readFileSync(join(process.cwd(),'.runtime-assets/office-models',id+'.glb')));});
  await install(page);
  const layout=[item('desk',desk.id,20,20,desk.width/20*100,desk.depth/16*100),item('desk-copy',desk.id,62,20,desk.width*.6/20*100,desk.depth*.6/16*100,180),item('chair',chair.id,42,20,chair.depth/20*100,chair.width/16*100,90),item('panel',panel.id,20,55,panel.depth*2/20*100,panel.width*1.3/16*100,270),item('floor',floor.id,60,50,25,25),item('thin-panel',thinPanel.id,40,50,thinPanel.depth/20*100,thinPanel.width/16*100,90)];
  await mount(page,definitions,layout);await expect.poll(async()=>(await diagnostics(page)).officeAssets.filter((asset:any)=>asset.status==='ready').length).toBe(6);
  expect(requests).toHaveLength(5);expect(requests.every(request=>request.identity===identity)).toBe(true);
  const info=await diagnostics(page);expect(info.obstacles).toHaveLength(5);
  for(const object of info.objects){const source=layout.find(value=>value.id===object.id)!;expect(object.width).toBeCloseTo(source.w*.2,6);expect(object.depth).toBeCloseTo(source.h*.16,6);expect(object.forward.x).toBeCloseTo(-Math.sin(source.rotation*Math.PI/180),6);expect(object.forward.z).toBeCloseTo(Math.cos(source.rotation*Math.PI/180),6);}
  for(const asset of info.officeAssets){const source=layout.find(value=>value.id===asset.id)!;const metadata=definitions.find(value=>value.id===source.assetId)!;const expectedHeight=metadata.resize==='footprint'?metadata.height:metadata.height*(asset.id==='desk-copy'?.6:1);if(asset.id!=='floor')expect(asset.height).toBeCloseTo(expectedHeight,4);const bounds=info.objects.find((value:any)=>value.id===asset.id).bounds;expect(asset.bounds.minX).toBeGreaterThanOrEqual(bounds.minX-.00001);expect(asset.bounds.maxX).toBeLessThanOrEqual(bounds.maxX+.00001);expect(asset.bounds.minZ).toBeGreaterThanOrEqual(bounds.minZ-.00001);expect(asset.bounds.maxZ).toBeLessThanOrEqual(bounds.maxZ+.00001);if(metadata.resize==='uniform'){expect(asset.scale.x).toBeCloseTo(asset.scale.y,6);expect(asset.scale.z).toBeCloseTo(asset.scale.y,6);}else expect(asset.scale.y).toBe(1);}
  const clones=await page.evaluate(()=>{
    const harness=(window as any).assetTest,models:any[]=[];harness.instance.scene.traverse((object:any)=>{if(object.userData.coatriaOfficeAsset==='office-desk-001')models.push(object);});
    const first=(model:any)=>{let found:any;model.traverse((object:any)=>{if(object.isMesh&&!found)found=object;});return found;};
    const a=first(models[0]),b=first(models[1]);harness.resourceDisposals=[];const seen=new Set();
    harness.instance.scene.traverse((model:any)=>{if(model.userData.coatriaOfficeAsset)model.traverse((object:any)=>{for(const resource of [object.geometry,...(Array.isArray(object.material)?object.material:[object.material])].filter(Boolean)){if(seen.has(resource))continue;seen.add(resource);const record={count:0};harness.resourceDisposals.push(record);resource.addEventListener('dispose',()=>record.count++);}});});
    const floor=harness.instance.diagnostics.officeAssets.find((asset:any)=>asset.id==='floor'),point={x:(floor.bounds.minX+floor.bounds.maxX)/2,z:(floor.bounds.minZ+floor.bounds.maxZ)/2};
    return {geometryShared:a.geometry===b.geometry,materialShared:a.material===b.material,independent:models[0]!==models[1],floorWalk:harness.instance.walkTo(point.x,point.z),position:harness.instance.diagnostics.position,point};
  });
  expect(clones.geometryShared).toBe(true);expect(clones.materialShared).toBe(true);expect(clones.independent).toBe(true);expect(clones.floorWalk).toBe(true);expect(clones.position).toEqual(clones.point);
  await page.evaluate(()=>(window as any).assetTest.instance.selectEntity('desk'));await expect(page.getByRole('button',{name:'Walk nearby'})).toBeVisible();await page.getByRole('button',{name:'Walk nearby'}).click();expect(await page.evaluate(()=>(window as any).assetTest.openedRooms)).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('purchased-office-models.png')});
  const rendererRelease=await page.evaluate(()=>{const harness=(window as any).assetTest;harness.instance.dispose();return{counts:harness.resourceDisposals.map((record:any)=>record.count),...harness.library.diagnostics};});
  expect(rendererRelease.leases).toBe(0);expect(rendererRelease.counts.every((count:number)=>count===0)).toBe(true);
  const libraryRelease=await page.evaluate(()=>{const harness=(window as any).assetTest;harness.library.dispose();harness.library.dispose();return{counts:harness.resourceDisposals.map((record:any)=>record.count),...harness.library.diagnostics};});
  expect(libraryRelease.sources).toBe(0);expect(libraryRelease.counts.every((count:number)=>count===1)).toBe(true);expect(errors).toEqual([]);
});

test('unique downloads are bounded at three, repeated objects dedupe, and idle cache remains bounded',async({page})=>{
  const held:Route[]=[],requests:string[]=[];
  await page.route('**/api/office-assets/*/model',route=>{requests.push(new URL(route.request().url()).pathname.split('/')[3]);held.push(route);});
  await install(page);await mount(page,catalog,Array.from({length:14},(_,index)=>item('item-'+index,catalog[index%7].id,5+index%7*13,10+Math.floor(index/7)*40,8,8)));
  await expect.poll(()=>held.length).toBe(3);await page.waitForTimeout(150);expect(held.length).toBe(3);
  for(let i=0;i<3;i++)await fulfill(held[i]);await expect.poll(()=>held.length).toBe(6);for(let i=3;i<6;i++)await fulfill(held[i]);await expect.poll(()=>held.length).toBe(7);await fulfill(held[6]);
  await expect.poll(async()=>(await diagnostics(page)).officeAssets.filter((asset:any)=>asset.modelLoaded).length).toBe(14);expect(new Set(requests).size).toBe(7);
  expect(await page.evaluate(()=>(window as any).assetTest.library.diagnostics.leases)).toBe(14);
  await page.evaluate(()=>(window as any).assetTest.instance.dispose());
  await page.unroute('**/api/office-assets/*/model');await page.route('**/api/office-assets/*/model',route=>fulfill(route));
  const cache=await page.evaluate(async ids=>{const harness=(window as any).assetTest;for(const id of ids){const lease=await harness.library.loadAsset(id);lease.release();}return harness.library.diagnostics;},catalog.slice(7).map(asset=>asset.id));
  expect(cache.sources).toBeLessThanOrEqual(8);expect(cache.leases).toBe(0);await page.evaluate(()=>(window as any).assetTest.library.dispose());
});

test('failed pieces remain visible, can retry, and never become room actions',async({page})=>{
  let fails=true,requests=0;await page.route('**/api/office-assets/*/model',route=>{requests++;return fails?route.fulfill({status:503,contentType:'application/json',body:'{"error":"Unavailable"}'}):fulfill(route);});
  await install(page);await mount(page,catalog,[item('recoverable',catalog[0].id,20,20),item('missing','not-in-collection',60,20)]);
  await expect(page.locator('[data-office-asset-status]')).toContainText('2 furniture items couldn’t load');expect(requests).toBe(1);expect((await diagnostics(page)).obstacles).toHaveLength(2);
  await page.evaluate(()=>(window as any).assetTest.instance.selectEntity('missing'));await expect(page.getByRole('button',{name:'Open room'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Walk nearby'})).toBeVisible();
  fails=false;await page.getByRole('button',{name:'Retry furniture'}).click();await expect.poll(async()=>(await diagnostics(page)).officeAssets.find((asset:any)=>asset.id==='recoverable').status).toBe('ready');await expect(page.locator('[data-office-asset-status]')).toContainText('1 furniture item couldn’t load');expect(requests).toBe(2);
});

test('model validation rejects external resource URLs, oversized bodies, and unknown ids without secondary requests',async({page})=>{
  const unexpected:string[]=[],requested:string[]=[];await page.route('https://untrusted.example/**',route=>{unexpected.push(route.request().url());return route.abort();});
  await page.route('**/api/office-assets/*/model',route=>{const id=new URL(route.request().url()).pathname.split('/')[3];requested.push(id);if(id==='fixture-0')return fulfill(route,binaryFixture('https://untrusted.example/mesh.bin'));return route.fulfill({contentType:'model/gltf-binary',body:Buffer.alloc(4*1024*1024+1)});});
  await install(page);
  const rejected=await page.evaluate(async({catalog,identity})=>{const harness=(window as any).assetTest,library=harness.createOfficeAssetLibrary({userId:identity,catalog});const results=[];for(const id of ['fixture-0','fixture-1','../other']){try{await library.loadAsset(id);results.push(false);}catch{results.push(true);}}const data=library.diagnostics;library.dispose();return{results,data};},{catalog,identity});
  expect(rejected.results).toEqual([true,true,true]);expect(rejected.data.sources).toBe(0);expect(unexpected).toEqual([]);expect(requested).toEqual(['fixture-0','fixture-1']);
});

test('identity change destroys the old mount and late downloads cannot attach after cancellation',async({page})=>{
  const held:Route[]=[];await page.route('**/api/office-assets/*/model',route=>{held.push(route);});await install(page);await mount(page,catalog,Array.from({length:7},(_,index)=>item('pending-'+index,catalog[index].id,5+index*13,20,8,8)));
  await expect.poll(()=>held.length).toBe(3);
  const closed=await page.evaluate(()=>{const harness=(window as any).assetTest;harness.oldLibrary=harness.library;harness.oldInstance=harness.instance;harness.instance.dispose();harness.library.dispose();return harness.oldLibrary.diagnostics;});expect(closed.disposed).toBe(true);expect(closed.sources).toBe(0);expect(closed.queued).toBe(0);expect(closed.leases).toBe(0);
  for(const route of held)await fulfill(route).catch(()=>{});
  await expect.poll(()=>page.evaluate(()=>(window as any).assetTest.oldLibrary.diagnostics.activeLoads)).toBe(0);await expect(page.locator('canvas')).toHaveCount(0);expect((await diagnostics(page)).officeAssets.some((asset:any)=>asset.modelLoaded)).toBe(false);
  await page.unroute('**/api/office-assets/*/model');const identities:string[]=[];await page.route('**/api/office-assets/*/model',route=>{identities.push(route.request().headers()['x-coatria-user']);return fulfill(route);});
  await page.evaluate(async catalog=>{const harness=(window as any).assetTest;const next=harness.createOfficeAssetLibrary({userId:'different-user',catalog});const lease=await next.loadAsset('fixture-0');lease.release();next.dispose();},catalog);expect(identities).toEqual(['different-user']);
});

test('a late parser result is disposed once, and a stale identity requests reconciliation once',async({page})=>{
  await page.route('**/api/office-assets/*/model',route=>fulfill(route));await install(page);
  await page.evaluate(async({catalog,identity})=>{
    const harness=(window as any).assetTest;const {GLTFLoader}=await import(/* webpackIgnore: true */ '/spatial/vendor/GLTFLoader.js' as string);const original=GLTFLoader.prototype.parseAsync;
    harness.restoreParser=()=>{GLTFLoader.prototype.parseAsync=original;};
    GLTFLoader.prototype.parseAsync=async function(...args:any[]){const source=await original.apply(this,args);harness.lateDisposals=[];const seen=new Set();source.scene.traverse((object:any)=>{if(object.geometry&&!seen.has(object.geometry)){seen.add(object.geometry);const record={count:0};object.geometry.addEventListener('dispose',()=>record.count++);harness.lateDisposals.push(record);}});return new Promise(resolve=>{harness.finishParse=()=>resolve(source);});};
    harness.library=harness.createOfficeAssetLibrary({userId:identity,catalog});harness.pending=harness.library.loadAsset('fixture-0').then(()=>({accepted:true}), (error:Error)=>({accepted:false,name:error.name}));
  },{catalog,identity});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).assetTest.finishParse)).toBe('function');
  const late=await page.evaluate(async()=>{const harness=(window as any).assetTest;harness.library.dispose();harness.finishParse();const result=await harness.pending;harness.restoreParser();return{result,counts:harness.lateDisposals.map((record:any)=>record.count),...harness.library.diagnostics};});
  expect(late.result).toEqual({accepted:false,name:'AbortError'});expect(late.counts.length).toBeGreaterThan(0);expect(late.counts.every((count:number)=>count===1)).toBe(true);expect(late.sources).toBe(0);expect(late.leases).toBe(0);
  await page.unroute('**/api/office-assets/*/model');await page.route('**/api/office-assets/*/model',route=>route.fulfill({status:409,contentType:'application/json',body:'{"code":"SESSION_CHANGED"}'}));
  const reconciled=await page.evaluate(async({catalog,identity})=>{const harness=(window as any).assetTest;let events=0;const listener=()=>events++;window.addEventListener('coatria:session-changed',listener);const library=harness.createOfficeAssetLibrary({userId:identity,catalog});await Promise.all(['fixture-0','fixture-1'].map(id=>library.loadAsset(id).catch(()=>undefined)));library.dispose();window.removeEventListener('coatria:session-changed',listener);return events;},{catalog,identity});expect(reconciled).toBe(1);
});
