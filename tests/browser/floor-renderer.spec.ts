import {test,expect,type Page} from '@playwright/test';

const layout=[
  {id:'desk',type:'desk',label:'Resizable desk',x:10,y:12,w:20,h:16,rotation:0},
  {id:'sofa',type:'lounge',label:'Small lounge',x:60,y:15,w:10,h:14,rotation:90},
  {id:'focus',type:'focus',label:'Focus zone',x:12,y:60,w:18,h:25,rotation:180},
  {id:'meeting',type:'meeting',label:'Meeting zone',x:58,y:60,w:26,h:25,rotation:270},
  {id:'plant',type:'plant',label:'Corner plant',x:94,y:94,w:4,h:4,rotation:0}
];
const person={id:'10000000-0000-4000-8000-000000000077',name:'Floor reviewer'};
const peer={id:'10000000-0000-4000-8000-000000000078',userId:'10000000-0000-4000-8000-000000000078',name:'Nearby reviewer'};
async function install(page:Page){
  await page.route('**/floor-renderer-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/spatial/office-scene.css"><style>body{margin:0}#office{height:100vh;width:100vw}</style></head><body><main id="office"></main><script type="module">import * as THREE from "/spatial/vendor/three.module.js";import {mount} from "/spatial/office-scene.js";window.floorTest={THREE,mount};</script></body></html>'}));
  await page.goto('/floor-renderer-fixture');await expect.poll(()=>page.evaluate(()=>typeof (window as any).floorTest?.mount)).toBe('function');
}
async function mount(page:Page,floor?:{width:number;depth:number},items=layout,reducedMotion=false){
  return page.evaluate(({floor,items,person,peer,reducedMotion})=>{
    const test=(window as any).floorTest;test.moves=[];
    test.instance=test.mount(document.getElementById('office'),{floor,customLayout:true,layout:items,state:{user:person,spatialPosition:{x:20,z:20}},companyName:'Floor geometry fixture',rooms:[],members:[peer],presence:[{...peer,x:-20,z:-20,status:'available',updatedAt:new Date().toISOString()}],agents:[],quality:'low',reducedMotion,onMove:(point:any)=>test.moves.push(point)});
    return test.instance.diagnostics;
  },{floor,items,person,peer,reducedMotion});
}
function inside(bounds:any,container:any,tolerance=.0001){
  expect(bounds.minX).toBeGreaterThanOrEqual(container.minX-tolerance);expect(bounds.maxX).toBeLessThanOrEqual(container.maxX+tolerance);
  expect(bounds.minZ).toBeGreaterThanOrEqual(container.minZ-tolerance);expect(bounds.maxZ).toBeLessThanOrEqual(container.maxZ+tolerance);
}
test.beforeEach(async({baseURL})=>test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Isolated local renderer fixture; no accounts or API mutations.'));

for(const floor of [{width:8,depth:8},{width:20,depth:16},{width:40,depth:40},{width:8,depth:40},{width:32,depth:12}]){
  test(`floor ${floor.width}×${floor.depth}: actual mesh fit, rotations, camera and safe paths`,async({page},testInfo)=>{
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await install(page);const diagnostics=await mount(page,floor);
    expect(diagnostics.floor).toEqual(floor);expect(diagnostics.objects).toHaveLength(layout.length);
    const expectedFloor={minX:-floor.width/2,maxX:floor.width/2,minZ:-floor.depth/2,maxZ:floor.depth/2};
    for(const object of diagnostics.objects){
      const source=layout.find(item=>item.id===object.id)!;
      expect(object.width).toBeCloseTo(source.w*floor.width/100,6);expect(object.depth).toBeCloseTo(source.h*floor.depth/100,6);
      inside(object.bounds,expectedFloor);inside(object.meshBounds,object.bounds);inside(object.furnitureBounds,object.bounds);
      expect(object.forward.x).toBeCloseTo(-Math.sin(source.rotation*Math.PI/180),6);expect(object.forward.z).toBeCloseTo(Math.cos(source.rotation*Math.PI/180),6);
    }
    const geometry=await page.evaluate(()=>{
      const {instance,THREE}=(window as any).floorTest;let slab:any,pick:any;
      instance.scene.traverse((object:any)=>{if(object.isMesh&&object.material.color?.getHexString()==='e0e2d3')slab=object;if(object.geometry?.type==='PlaneGeometry')pick=object;});
      const bounds=new THREE.Box3().setFromObject(slab),corners=[];const {width,depth}=instance.diagnostics.floor;
      for(const x of [-width/2-.2,width/2+.2])for(const z of [-depth/2-.2,depth/2+.2])for(const y of [0,3.8]){const point=new THREE.Vector3(x,y,z).project(instance.camera);corners.push({x:point.x,y:point.y,z:point.z});}
      return{slab:{minX:bounds.min.x,maxX:bounds.max.x,minZ:bounds.min.z,maxZ:bounds.max.z},pick:{width:pick.geometry.parameters.width,depth:pick.geometry.parameters.height},corners};
    });
    expect(geometry.slab).toEqual(expectedFloor);expect(geometry.pick).toEqual({width:floor.width,depth:floor.depth});
    for(const point of geometry.corners){expect(Math.abs(point.x)).toBeLessThanOrEqual(1);expect(Math.abs(point.y)).toBeLessThanOrEqual(1);expect(Math.abs(point.z)).toBeLessThanOrEqual(1);}
    for(const occupant of diagnostics.occupants){inside({minX:occupant.x,maxX:occupant.x,minZ:occupant.z,maxZ:occupant.z},diagnostics.navigation);expect(Math.abs(occupant.x)).toBeLessThanOrEqual(20);expect(Math.abs(occupant.z)).toBeLessThanOrEqual(20);}
    for(const target of [{x:-100,z:-100},{x:100,z:-100},{x:-100,z:100},{x:100,z:100}]){
      const route=await page.evaluate(target=>{const instance=(window as any).floorTest.instance;const from=instance.diagnostics.position,result=instance.walkTo(target.x,target.z);return{result,from,...instance.diagnostics};},target);
      expect(route.result).toBe(true);expect(route.plannedPath.length).toBeGreaterThan(0);
      let previous=route.from;
      for(const point of route.plannedPath){
        inside({minX:point.x,maxX:point.x,minZ:point.z,maxZ:point.z},route.navigation);
        const steps=Math.ceil(Math.hypot(point.x-previous.x,point.z-previous.z)/.05);
        for(let i=0;i<=steps;i++){const x=previous.x+(point.x-previous.x)*i/Math.max(1,steps),z=previous.z+(point.z-previous.z)*i/Math.max(1,steps);expect(route.obstacles.some((obstacle:any)=>x>obstacle.minX-.299&&x<obstacle.maxX+.299&&z>obstacle.minZ-.299&&z<obstacle.maxZ+.299)).toBe(false);}
        previous=point;
      }
    }
    if((floor.width===8&&floor.depth===8)||(floor.width===40&&floor.depth===40))await page.screenshot({path:testInfo.outputPath('floor-'+floor.width+'x'+floor.depth+'.png')});
    expect(errors).toEqual([]);
  });
}

test('resizing remounts safely, clamps saved presence, and preserves the legacy default',async({page})=>{
  await install(page);const initial=await mount(page,undefined,[]);expect(initial.floor).toEqual({width:20,depth:16});
  await page.evaluate(()=>{(window as any).floorTest.previous=(window as any).floorTest.instance;});
  const small=await mount(page,{width:8,depth:8},[],true);expect(await page.evaluate(()=>(window as any).floorTest.previous.diagnostics.disposed)).toBe(true);
  inside({minX:small.position.x,maxX:small.position.x,minZ:small.position.z,maxZ:small.position.z},small.navigation);
  const moved=await page.evaluate(()=>{const test=(window as any).floorTest;const accepted=test.instance.walkTo(-100,100);return {accepted,moves:test.moves,...test.instance.diagnostics};});
  expect(moved.accepted).toBe(true);expect(moved.moves.length).toBe(1);inside({minX:moved.position.x,maxX:moved.position.x,minZ:moved.position.z,maxZ:moved.position.z},moved.navigation);
  const invalid=await mount(page,{width:2,depth:100},[]);expect(invalid.floor).toEqual({width:8,depth:40});
  await page.evaluate(()=>{(window as any).floorTest.instance.dispose();});await expect(page.locator('canvas')).toHaveCount(0);
});
