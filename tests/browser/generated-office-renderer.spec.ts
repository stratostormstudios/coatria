import {test,expect,type Page} from '@playwright/test';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {AVATAR_CATALOG} from '../../src/lib/avatar-catalog';
import {OFFICE_CATALOG,getOfficeAsset} from '../../src/lib/office-catalog';
import {getOfficeSeats} from '../../src/lib/office-seating';
import {generateOffice,OFFICE_GENERATOR_PRESETS,type GeneratedOffice} from '../../src/lib/office-generator';

const identity='10000000-0000-4000-8000-000000007301';
const curated=OFFICE_GENERATOR_PRESETS.find(preset=>preset.id==='canopy-court')!;
const plans=[{key:'canopy-court',plan:{...generateOffice(curated.options),name:curated.name}},{key:'maximum-60',plan:generateOffice({deskCount:60,roomCount:8,style:'courtyard',spaciousness:'airy',seed:'maximum-renderer-review'})}];
const diagnostics=(page:Page)=>page.evaluate(()=>(window as any).generatedReview.instance.diagnostics);

async function mount(page:Page,plan:GeneratedOffice){
 const requests:{kind:string;id:string;identity:string}[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/generated-office-review',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/spatial/office-scene.css"><style>body{margin:0;font-family:Arial}#office{height:100vh;width:100vw}</style></head><body><main id="office"></main><script type="module">import "/spatial/bootstrap.js";import * as THREE from "/spatial/vendor/three.module.js";window.generatedReview={THREE,runtime:window.CoatriaOfficeRuntime};</script></body></html>'}));
 await page.route('**/api/**',route=>{
  const request=route.request(),pathname=new URL(request.url()).pathname;if(request.method()!=='GET'){errors.push('Unexpected server mutation: '+request.method()+' '+pathname);return route.abort();}
  if(pathname==='/api/avatars')return route.fulfill({contentType:'application/json',body:JSON.stringify({avatars:AVATAR_CATALOG})});
  const match=pathname.match(/^\/api\/(avatars|office-assets)\/([a-z0-9-]+)\/model$/);if(!match){errors.push('Unexpected API request: '+pathname);return route.abort();}
  const [,kind,id]=match,allowed=kind==='avatars'?AVATAR_CATALOG.some(avatar=>avatar.id===id):OFFICE_CATALOG.some(asset=>asset.id===id);if(!allowed){errors.push('Unknown model ID');return route.abort();}
  requests.push({kind,id,identity:request.headers()['x-coatria-user']});return route.fulfill({contentType:'model/gltf-binary',body:readFileSync(join(process.cwd(),'.runtime-assets',kind==='avatars'?'city-characters':'office-models',id+'.glb'))});
 });
 await page.goto('/generated-office-review');await expect.poll(()=>page.evaluate(()=>typeof (window as any).generatedReview?.runtime?.mount)).toBe('function');
 const members=plan.workstations.map((_,index)=>({id:index===0?identity:`10000000-0000-4000-8000-${String(7301+index).padStart(12,'0')}`,name:index===0?'Local preview':'Preview colleague '+String(index+1).padStart(2,'0'),avatarId:AVATAR_CATALOG[index%AVATAR_CATALOG.length].id,roleTitle:'Local renderer fixture'}));
 const seats=getOfficeSeats(plan.layout,plan.floor);
 await page.evaluate(({plan,members,seats,catalog,identity})=>{
  const h=(window as any).generatedReview;h.plan=plan;h.members=members;h.seats=seats;h.claims=[];
  h.characters=h.runtime.createCharacterLibrary({userId:identity,selectAvatar:(_:string,id:string,avatars:any[])=>avatars.find(avatar=>avatar.id===id)||avatars[0]});h.furniture=h.runtime.createOfficeAssetLibrary({userId:identity,catalog});
  h.own={userId:identity,name:members[0].name,...plan.spawn,status:'available',seatId:null,seat:null,updatedAt:new Date().toISOString()};
  h.presence=members.slice(1).map((member:any,index:number)=>({userId:member.id,name:member.name,...plan.workstations[index+1].approach,status:'available',updatedAt:new Date().toISOString()}));
  h.snapshot=()=>({user:members[0],members,agents:[],presence:[h.own,...h.presence]});
  h.instance=h.runtime.mount(document.getElementById('office'),{customLayout:true,companyName:plan.name+' · local preview',floor:plan.floor,layout:plan.layout,seats,officeCatalog:catalog,loadOfficeAsset:h.furniture.loadAsset,loadCharacter:h.characters.loadCharacter,state:{user:members[0],spatialPosition:plan.spawn},...h.snapshot(),onMove:(position:any)=>{h.own={...h.own,...position,seatId:null,seat:null,updatedAt:new Date().toISOString()};},onInteraction:async(command:any)=>{h.claims.push(command);const seat=seats.find((seat:any)=>seat.id===command.seatId);if(!seat)throw new Error('Unknown fixture seat');h.own={...h.own,seatId:seat.id,seat:{x:seat.x,z:seat.z,yaw:seat.yaw,seatHeight:seat.seatHeight},x:seat.x,z:seat.z,updatedAt:new Date().toISOString()};return h.own;},quality:'balanced'});
 },{plan,members,seats,catalog:OFFICE_CATALOG,identity});
 await expect.poll(async()=>(await diagnostics(page)).loadedCharacterModels,{timeout:45000}).toBe(members.length);await expect.poll(async()=>(await diagnostics(page)).officeAssets.filter((asset:any)=>asset.modelLoaded).length,{timeout:45000}).toBe(plan.layout.length);
 return {requests,errors,members,seats};
}

for(const {key,plan} of plans)test(`${key}: actual licensed furniture, reachable seats and a clear 3D floor`,async({page,baseURL},testInfo)=>{
 test.setTimeout(120000);test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Read-only local renderer fixture.');
 const needed=[...new Set(plan.layout.map(item=>item.assetId!))];test.skip(!needed.every(id=>existsSync(join(process.cwd(),'.runtime-assets/office-models',id+'.glb')))||!AVATAR_CATALOG.every(avatar=>existsSync(join(process.cwd(),'.runtime-assets/city-characters',avatar.id+'.glb'))),'Install the licensed private runtime bundle.');
 const state=await mount(page,plan),loaded=await diagnostics(page);
 expect(loaded.floor).toEqual(plan.floor);expect(loaded.officeAssets).toHaveLength(plan.layout.length);expect(loaded.proceduralCharacters).toBe(0);expect(loaded.characters).toBe(plan.workstations.length);expect(loaded.officeAssets.every((asset:any)=>asset.status==='ready'&&asset.modelLoaded)).toBe(true);
 for(const actual of loaded.officeAssets){const item=plan.layout.find(item=>item.id===actual.id)!,asset=getOfficeAsset(item.assetId!)!;
  // The catalog gives planar floor finishes a nominal minimum height. Their
  // purchased mesh can be thinner; solid furniture must keep its true height.
  if(asset.collidable===false){expect(actual.height).toBeGreaterThanOrEqual(0);expect(actual.height).toBeLessThanOrEqual(asset.height+.00001);}else expect(actual.height).toBeCloseTo(asset.height,4);
  expect(actual.bounds.minX).toBeCloseTo(item.x/100*plan.floor.width-plan.floor.width/2,4);expect(actual.bounds.maxX-actual.bounds.minX).toBeCloseTo(item.w/100*plan.floor.width,4);expect(actual.bounds.maxZ-actual.bounds.minZ).toBeCloseTo(item.h/100*plan.floor.depth,4);
 }
 expect(state.requests.every(request=>request.identity===identity)).toBe(true);expect(state.requests.filter(request=>request.kind==='office-assets')).toHaveLength(needed.length);expect(state.requests.filter(request=>request.kind==='avatars')).toHaveLength(12);

 // Exercise the renderer's own router using its actual post-load mesh bounds.
 // Reset to the entrance before each route; never accept nearest-open fallback.
 const routes=await page.evaluate(()=>{
  const h=(window as any).generatedReview,scene=h.instance,reports=[];
  const targets=[...h.seats.map((seat:any)=>({id:seat.id,point:seat.approach})),...h.plan.spatialRooms.map((room:any)=>({id:room.zoneId+' entry',point:room.entry}))];
  const obstacles=scene.diagnostics.obstacles;
  function clear(a:any,b:any){return !obstacles.some((obstacle:any)=>{let near=0,far=1;for(const [axis,min,max] of [['x',obstacle.minX-.3+1e-6,obstacle.maxX+.3-1e-6],['z',obstacle.minZ-.3+1e-6,obstacle.maxZ+.3-1e-6]] as const){const origin=a[axis],delta=b[axis]-origin;if(Math.abs(delta)<1e-10){if(origin<=min||origin>=max)return false;}else{const first=(min-origin)/delta,last=(max-origin)/delta;near=Math.max(near,Math.min(first,last));far=Math.min(far,Math.max(first,last));if(near>far)return false;}}return near<=far;});}
  for(const target of targets){const reset=scene.teleportTo(h.plan.spawn.x,h.plan.spawn.z),accepted=scene.walkTo(target.point.x,target.point.z),path=scene.diagnostics.plannedPath;let previous=h.plan.spawn,clearance=true;for(const point of path){if(!clear(previous,point))clearance=false;previous=point;}reports.push({id:target.id,reset,accepted,last:path.at(-1),target:target.point,clearance});}
  scene.teleportTo(h.plan.spawn.x,h.plan.spawn.z);return reports;
 });
 expect(routes).toHaveLength(state.seats.length+plan.spatialRooms.length);for(const route of routes){expect(route.reset,route.id+' reset').toBe(true);expect(route.accepted,route.id+' route').toBe(true);expect(route.last?.x,route.id+' final X').toBeCloseTo(route.target.x,5);expect(route.last?.z,route.id+' final Z').toBeCloseTo(route.target.z,5);expect(route.clearance,route.id+' padded segments').toBe(true);}

 const availability=await page.evaluate(async()=>{
  const h=(window as any).generatedReview,reports=[];
  for(const seat of h.seats){const selected=h.instance.selectEntity(seat.id),button=document.querySelector<HTMLButtonElement>('.cs-seat-action'),enabled=!!button&&!button.disabled,approach=h.instance.teleportTo(seat.approach.x,seat.approach.z),accepted=h.instance.requestSeat(seat.id);await new Promise(resolve=>setTimeout(resolve,0));const seated=h.instance.diagnostics.occupants.find((person:any)=>person.id===h.members[0].id);h.instance.stand();const standing=h.instance.diagnostics.position;reports.push({id:seat.id,selected,enabled,approach,accepted,seatedId:seated.seatId,standing,expected:seat.approach});}
  document.querySelector<HTMLButtonElement>('.cs-scene-close')?.click();h.instance.teleportTo(h.plan.spawn.x,h.plan.spawn.z);return reports;
 });
 expect(availability).toHaveLength(plan.options.deskCount+plan.options.roomCount*2);for(const seat of availability){expect(seat.selected&&seat.enabled&&seat.approach&&seat.accepted,seat.id).toBe(true);expect(seat.seatedId).toBe(seat.id);expect(seat.standing.x).toBeCloseTo(seat.expected.x,5);expect(seat.standing.z).toBeCloseTo(seat.expected.z,5);}

 const finishes=await page.evaluate(()=>{
  const h=(window as any).generatedReview;h.instance.scene.updateMatrixWorld(true);
  return h.plan.layout.filter((item:any)=>item.assetId.startsWith('office-floor-')).map((item:any)=>{const root=h.instance.scene.getObjectByName('office-asset:'+item.id);let model:any;root.traverse((object:any)=>{if(object.userData.coatriaOfficeAsset)model=object;});const b=new h.THREE.Box3().setFromObject(model);return{id:item.id,minY:b.min.y,maxY:b.max.y,rootY:root.position.y};});
 });
 expect(finishes.length).toBeGreaterThan(0);for(const finish of finishes){expect(finish.minY).toBeGreaterThan(.081);expect(finish.maxY).toBeLessThan(.095);expect(finish.maxY-finish.minY).toBeGreaterThanOrEqual(0);expect(finish.maxY-finish.minY).toBeLessThanOrEqual(.00101);}expect(new Set(finishes.map((finish:{rootY:number})=>finish.rootY)).size).toBe(finishes.length);

 // Populate half the workstations with seated local fixture occupants for the
 // visual review. This remains a scene snapshot; there is no presence API write.
 await page.evaluate(()=>{const h=(window as any).generatedReview;h.presence=h.presence.map((person:any,index:number)=>{if(index%2)return person;const station=h.plan.workstations[index+1],seat=h.seats.find((seat:any)=>seat.id===station.chairId);return{...person,x:seat.x,z:seat.z,seatId:seat.id,seat,updatedAt:new Date().toISOString()};});h.instance.updateSnapshot(h.snapshot());});
 await expect.poll(async()=>(await diagnostics(page)).occupants.filter((person:any)=>person.seatId).length).toBe(Math.ceil((plan.workstations.length-1)/2));await page.waitForTimeout(400);
 const output=resolve(process.cwd(),'../output/coatria-generated-office-3d');mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,key+'-overview.png')});await page.evaluate(()=>{const h=(window as any).generatedReview;h.instance.camera.zoom=1.5;h.instance.camera.updateProjectionMatrix();h.instance.renderer.render(h.instance.scene,h.instance.camera);});await page.waitForTimeout(150);await page.screenshot({path:join(output,key+'-detail.png')});
 const report={scope:'Local licensed renderer QA; not a production capacity benchmark',name:plan.name,floor:plan.floor,objects:loaded.officeAssets.length,uniqueFurniture:needed.length,loadedHumans:loaded.loadedCharacterModels,availableSeats:availability.length,routedApproaches:routes.length,clearPaths:routes.every(route=>route.clearance),floorFinishes:finishes};writeFileSync(join(output,key+'-report.json'),JSON.stringify(report,null,2));await testInfo.attach('generated-office-review',{body:JSON.stringify(report,null,2),contentType:'application/json'});
 const release=await page.evaluate(()=>{const h=(window as any).generatedReview;h.instance.dispose();h.characters.dispose();h.furniture.dispose();return{scene:h.instance.diagnostics.disposed,characterLeases:h.characters.diagnostics.leases,furnitureLeases:h.furniture.diagnostics.leases};});expect(release).toEqual({scene:true,characterLeases:0,furnitureLeases:0});expect(state.errors).toEqual([]);
});
