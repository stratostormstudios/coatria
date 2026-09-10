import {test,expect,type Page} from '@playwright/test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {AVATAR_CATALOG} from '../../src/lib/avatar-catalog';
import {OFFICE_CATALOG} from '../../src/lib/office-catalog';
import {OFFICE_50_PRESET} from '../../src/lib/office-presets';

const identity='10000000-0000-4000-8000-000000005001';
const members=Array.from({length:50},(_,index)=>({id:index===0?identity:`10000000-0000-4000-8000-${String(5001+index).padStart(12,'0')}`,name:`Scale participant ${String(index+1).padStart(2,'0')}`,avatarId:AVATAR_CATALOG[index%AVATAR_CATALOG.length].id,roleTitle:'Renderer fixture participant'}));
const gridFixture=process.env.COATRIA_SCALE_GRID_FIXTURE==='1';
const floor=OFFICE_50_PRESET.floor;
const desk=OFFICE_CATALOG.find(asset=>asset.id==='office-desk-001')!,chair=OFFICE_CATALOG.find(asset=>asset.id==='office-chair-001')!;
const stations=gridFixture?Array.from({length:50},(_,index)=>({x:-12+index%10*2.5,z:-8+Math.floor(index/10)*3.5})):OFFICE_50_PRESET.workstations.map(station=>({x:station.approach.x,z:station.approach.z-1.85}));
const layout=gridFixture?stations.flatMap((point,index)=>[desk,chair].map((asset,piece)=>({id:`station-${index}-${piece}`,assetId:asset.id,type:'asset',label:asset.name,x:(point.x-asset.width/2+15)/30*100,y:(point.z+piece*.95-asset.depth/2+10)/20*100,w:asset.width/30*100,h:asset.depth/20*100,rotation:0}))):OFFICE_50_PRESET.layout;

async function install(page:Page){
  const requests:{kind:string;id:string;identity:string}[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/office-scale-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/spatial/office-scene.css"><style>body{margin:0}#office{height:100vh;width:100vw}</style></head><body><main id="office"></main><script type="module">import "/spatial/bootstrap.js";window.scaleTest={runtime:window.CoatriaOfficeRuntime};</script></body></html>'}));
  await page.route('**/api/avatars',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({avatars:AVATAR_CATALOG})}));
  await page.route('**/api/avatars/*/model',route=>{const id=new URL(route.request().url()).pathname.split('/')[3];requests.push({kind:'character',id,identity:route.request().headers()['x-coatria-user']});return route.fulfill({contentType:'model/gltf-binary',body:readFileSync(join(process.cwd(),'.runtime-assets/city-characters',id+'.glb'))});});
  await page.route('**/api/office-assets/*/model',route=>{const id=new URL(route.request().url()).pathname.split('/')[3];requests.push({kind:'furniture',id,identity:route.request().headers()['x-coatria-user']});return route.fulfill({contentType:'model/gltf-binary',body:readFileSync(join(process.cwd(),'.runtime-assets/office-models',id+'.glb'))});});
  await page.goto('/office-scale-fixture');await expect.poll(()=>page.evaluate(()=>typeof (window as any).scaleTest?.runtime?.mount)).toBe('function');
  return{requests,errors};
}
async function mount(page:Page){
  await page.evaluate(({members,stations,layout,floor,catalog,identity})=>{
    const harness=(window as any).scaleTest;harness.members=members;harness.stations=stations;
    harness.characters=harness.runtime.createCharacterLibrary({userId:identity,selectAvatar:(_:string,id:string,avatars:any[])=>avatars.find(avatar=>avatar.id===id)||avatars[0]});
    harness.furniture=harness.runtime.createOfficeAssetLibrary({userId:identity,catalog});
    harness.snapshot=(phase=0,count=50)=>({user:members[0],members:members.slice(0,count),agents:[],presence:members.slice(1,count).map((member:any,index:number)=>({userId:member.id,name:member.name,x:stations[index+1].x+(phase%2?.7:0),z:stations[index+1].z+1.85,status:'available',updatedAt:new Date().toISOString()}))});
    harness.instance=harness.runtime.mount(document.getElementById('office'),{customLayout:true,floor,layout,officeCatalog:catalog,loadOfficeAsset:harness.furniture.loadAsset,loadCharacter:harness.characters.loadCharacter,state:{user:members[0],spatialPosition:{x:stations[0].x,z:stations[0].z+1.85}},...harness.snapshot(),quality:'balanced'});
  },{members,stations,layout,floor,catalog:OFFICE_CATALOG,identity});
  await expect.poll(()=>page.evaluate(()=>(window as any).scaleTest.instance.diagnostics.loadedCharacterModels),{timeout:45000}).toBe(50);
  await expect.poll(()=>page.evaluate(()=>(window as any).scaleTest.instance.diagnostics.officeAssets.filter((asset:any)=>asset.modelLoaded).length)).toBe(layout.length);
}
const diagnostics=(page:Page)=>page.evaluate(()=>(window as any).scaleTest.instance.diagnostics);
async function canvasCoverage(page:Page){
  return page.evaluate(()=>{const instance=(window as any).scaleTest.instance;instance.renderer.render(instance.scene,instance.camera);const canvas=document.createElement('canvas');canvas.width=128;canvas.height=84;const context=canvas.getContext('2d')!;context.drawImage(instance.renderer.domElement,0,0,128,84);const pixels=context.getImageData(0,0,128,84).data;let changed=0;for(let i=0;i<pixels.length;i+=4)if(Math.abs(pixels[i]-233)+Math.abs(pixels[i+1]-237)+Math.abs(pixels[i+2]-231)>45&&pixels[i+3]>200)changed++;return changed/(pixels.length/4);});
}
async function sample(page:Page,moving:boolean,quality='balanced'){
  await page.evaluate(quality=>{const harness=(window as any).scaleTest;harness.instance.setQuality(quality);harness.instance.resetPerformance();},quality);
  // Keep cold shader compilation visible in a separate transition observation;
  // steady-state samples begin only after at least eight accepted loop ticks.
  await expect.poll(async()=>(await diagnostics(page)).performance.sampleCount).toBeGreaterThanOrEqual(8);
  const transition=(await diagnostics(page)).performance;await page.evaluate(()=>(window as any).scaleTest.instance.resetPerformance());
  const durations:number[]=[];
  for(let phase=1;phase<=4;phase++){
    if(moving)durations.push(await page.evaluate(phase=>{const harness=(window as any).scaleTest,started=performance.now();harness.instance.updateSnapshot(harness.snapshot(phase));return performance.now()-started;},phase));
    await page.waitForTimeout(1000);
  }
  return{...(await diagnostics(page)),transition,snapshotMs:durations};
}

test('50 real animated humans in a furnished office: measured frames, motion, selection and teardown',async({page,baseURL},testInfo)=>{
  test.setTimeout(120000);test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local renderer benchmark only; no users or server connections created.');
  test.skip(!existsSync(join(process.cwd(),'.runtime-assets/city-characters/city-023.glb')),'Private licensed assets must be installed locally.');
  const fixture=await install(page);await mount(page);await page.waitForTimeout(800);
  const idle=await sample(page,false);expect(await canvasCoverage(page)).toBeGreaterThan(.1);await page.screenshot({path:testInfo.outputPath('office-50-balanced.png')});const moving=await sample(page,true),low=await sample(page,true,'low');expect(await canvasCoverage(page)).toBeGreaterThan(.1);
  expect(idle.characters).toBe(50);expect(idle.resources.skinnedMeshes).toBeGreaterThanOrEqual(50);expect(idle.resources.skinnedMeshes).toBeLessThanOrEqual(150);expect(idle.resources.bones).toBe(50*44);
  expect(fixture.requests.filter(request=>request.kind==='character')).toHaveLength(12);expect(fixture.requests.filter(request=>request.kind==='furniture')).toHaveLength(new Set(layout.map(item=>item.assetId)).size);expect(fixture.requests.every(request=>request.identity===identity)).toBe(true);
  for(const report of [idle,moving,low]){expect(report.performance.sampleCount).toBeGreaterThan(10);expect(report.performance.fps).toBeGreaterThan(0);expect(report.performance.workMs.p95).toBeGreaterThanOrEqual(report.performance.workMs.p50);for(const occupant of report.occupants){expect(Math.abs(occupant.x)).toBeLessThanOrEqual(floor.width/2);expect(Math.abs(occupant.z)).toBeLessThanOrEqual(floor.depth/2);}}
  await page.evaluate(id=>(window as any).scaleTest.instance.selectEntity(id),members[49].id);await expect(page.locator('.cs-scene-context')).toContainText(members[49].name);await expect(page.getByRole('button',{name:'View teammate'})).toBeVisible();
  await expect.poll(async()=>(await diagnostics(page)).labels.compact).toBeGreaterThan(0);
  const rectangles=await page.locator('.cs-scene-label[data-label-mode="full"]').evaluateAll(elements=>elements.filter(element=>getComputedStyle(element).visibility==='visible').map(element=>{const box=element.getBoundingClientRect();return{x:box.x,y:box.y,right:box.right,bottom:box.bottom};}));
  for(let a=0;a<rectangles.length;a++)for(let b=a+1;b<rectangles.length;b++){const first=rectangles[a],second=rectangles[b];expect(first.x<second.right&&first.right>second.x&&first.y<second.bottom&&first.bottom>second.y).toBe(false);}
  const compact=page.locator('.cs-scene-label[data-label-mode="compact"]').first();const accessibleName=await compact.getAttribute('aria-label');await compact.focus();await expect(page.getByRole('button',{name:accessibleName!,exact:true})).toHaveAttribute('data-label-mode','full');await page.locator('.cs-scene-stage').focus();
  await page.screenshot({path:testInfo.outputPath('office-50-overview.png')});
  await page.evaluate(()=>(window as any).scaleTest.instance.setQuality('balanced'));await page.waitForTimeout(250);expect(await canvasCoverage(page)).toBeGreaterThan(.1);
  expect(idle.animation.fullRateHumans).toBeLessThanOrEqual(24);expect(idle.animation.reducedRateHumans).toBeGreaterThan(0);expect(low.animation.fullRateHumans).toBeLessThanOrEqual(12);expect(idle.resources.skeletons).toBe(50);
  await page.evaluate(()=>{const harness=(window as any).scaleTest;harness.instance.camera.zoom=2.7;harness.instance.camera.updateProjectionMatrix();harness.instance.resetPerformance();});await expect.poll(async()=>(await diagnostics(page)).animation.culledHumans).toBeGreaterThan(0);await page.waitForTimeout(1000);const zoomed=await diagnostics(page);expect(zoomed.animation.visibleHumans+zoomed.animation.culledHumans).toBe(50);
  await page.evaluate(()=>{const harness=(window as any).scaleTest;harness.instance.updateSnapshot(harness.snapshot(0,25));});await expect.poll(async()=>(await diagnostics(page)).loadedCharacterModels).toBe(25);expect(await page.evaluate(()=>(window as any).scaleTest.characters.diagnostics.leases)).toBe(25);
  await page.evaluate(()=>{const harness=(window as any).scaleTest;harness.instance.updateSnapshot(harness.snapshot(0,50));});await expect.poll(async()=>(await diagnostics(page)).loadedCharacterModels).toBe(50);expect(fixture.requests.filter(request=>request.kind==='character')).toHaveLength(12);
  const release=await page.evaluate(()=>{const harness=(window as any).scaleTest;harness.instance.dispose();harness.characters.dispose();harness.furniture.dispose();return{characters:harness.characters.diagnostics,furniture:harness.furniture.diagnostics,scene:harness.instance.diagnostics};});
  expect(release.characters.leases).toBe(0);expect(release.characters.sources).toBe(0);expect(release.furniture.leases).toBe(0);expect(release.furniture.sources).toBe(0);expect(release.scene.disposed).toBe(true);await expect(page.locator('canvas')).toHaveCount(0);
  await mount(page);expect((await diagnostics(page)).characters).toBe(50);await page.evaluate(()=>{const harness=(window as any).scaleTest;harness.instance.dispose();harness.characters.dispose();harness.furniture.dispose();});expect(fixture.errors).toEqual([]);
  const summarize=(report:any)=>({performance:report.performance,transition:report.transition,animation:report.animation,resources:report.resources,pathfinding:report.pathfinding,snapshotMs:report.snapshotMs});
  const report={label:process.env.COATRIA_SCALE_LABEL||'current',environment:{viewport:page.viewportSize(),browser:testInfo.project.name,userAgent:await page.evaluate(()=>navigator.userAgent),devicePixelRatio:await page.evaluate(()=>devicePixelRatio)},fixture:{name:gridFixture?'Baseline grid':OFFICE_50_PRESET.name,humans:50,objects:layout.length,floor,uniqueAvatars:12},idle:summarize(idle),moving:summarize(moving),low:summarize(low),zoomed:summarize(zoomed)};
  await testInfo.attach('renderer-scale-report',{body:JSON.stringify(report,null,2),contentType:'application/json'});
  require('node:fs').writeFileSync(testInfo.outputPath('renderer-scale-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({label:report.label,idle:idle.performance,moving:moving.performance,low:low.performance,movementSnapshots:moving.snapshotMs}));
});

test('demand-rendered idle and off-viewport suspension are explicit performance states',async({page,baseURL})=>{
  test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local renderer fixture.');await install(page);
  await page.evaluate(identity=>{const harness=(window as any).scaleTest;harness.instance=harness.runtime.mount(document.getElementById('office'),{customLayout:true,layout:[],state:{user:{id:identity,name:'Idle fixture'}},rooms:[],members:[],presence:[],agents:[],quality:'low',reducedMotion:true});},identity);
  await expect.poll(async()=>(await diagnostics(page)).performance.state).toBe('idle');await page.waitForTimeout(250);expect((await diagnostics(page)).performance.loopFps).toBeGreaterThan(0);
  await page.evaluate(()=>{document.getElementById('office')!.style.display='none';});await expect.poll(async()=>(await diagnostics(page)).performance.state).toBe('suspended');expect((await diagnostics(page)).performance.fps).toBe(0);
  await page.evaluate(()=>{document.getElementById('office')!.style.display='block';});await expect.poll(async()=>(await diagnostics(page)).performance.state).toBe('idle');await page.evaluate(()=>(window as any).scaleTest.instance.dispose());expect((await diagnostics(page)).performance.state).toBe('disposed');
});

test('opposite-aisle movement burst measures collision routing for the same 50 occupants',async({page,baseURL},testInfo)=>{
  test.setTimeout(120000);test.skip(gridFixture||!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Uses the actual local fifty-workstation preset.');test.skip(!existsSync(join(process.cwd(),'.runtime-assets/city-characters/city-023.glb')),'Private licensed assets must be installed locally.');
  await install(page);await mount(page);
  const report=await page.evaluate(()=>{const harness=(window as any).scaleTest,snapshot=harness.snapshot(),started=performance.now();harness.instance.resetPerformance();snapshot.presence.forEach((person:any,index:number)=>{const own=index+1,other=own%10<5?own+5:own-5,point=harness.stations[other];person.x=point.x;person.z=point.z+1.85;person.updatedAt=new Date().toISOString();});harness.instance.updateSnapshot(snapshot);return{snapshotMs:performance.now()-started,diagnostics:harness.instance.diagnostics};});
  expect(report.diagnostics.characters).toBe(50);expect(report.diagnostics.pathfinding.pending).toBe(49);const drainStart=Date.now();await expect.poll(async()=>(await diagnostics(page)).pathfinding.pending,{timeout:8000}).toBe(0);const settled=await diagnostics(page);expect(settled.pathfinding.requests).toBe(49);expect(settled.pathfinding.routesLastFrame).toBeLessThanOrEqual(4);expect(settled.occupants.filter((person:any)=>person.pathLength>0).length).toBeGreaterThan(0);Object.assign(report,{drainMs:Date.now()-drainStart,settled:settled.pathfinding});console.log(JSON.stringify({routingBurstMs:report.snapshotMs,drainMs:Date.now()-drainStart,pathfinding:settled.pathfinding}));
  require('node:fs').writeFileSync(testInfo.outputPath('routing-burst.json'),JSON.stringify(report,null,2));
  await page.evaluate(()=>{const harness=(window as any).scaleTest;harness.instance.dispose();harness.characters.dispose();harness.furniture.dispose();});
});
