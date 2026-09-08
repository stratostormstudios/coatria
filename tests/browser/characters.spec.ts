import {test,expect,type Page,type Route} from '@playwright/test';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

// Original synthetic geometry and clips. No purchased character data enters tests.
function characterFixture(){
  const chunks:Buffer[]=[],views:any[]=[],accessors:any[]=[];let offset=0;
  function accessor(array:Float32Array|Uint16Array|Uint8Array,type:string,count:number,min?:number[],max?:number[]){
    while(offset%4){chunks.push(Buffer.from([0]));offset++;}
    const buffer=Buffer.from(array.buffer,array.byteOffset,array.byteLength),view=views.length;
    views.push({buffer:0,byteOffset:offset,byteLength:buffer.length});chunks.push(buffer);offset+=buffer.length;
    accessors.push({bufferView:view,componentType:array instanceof Float32Array?5126:array instanceof Uint16Array?5123:5121,type,count,...(min?{min,max}:{})});return accessors.length-1;
  }
  const position=accessor(new Float32Array([-.25,0,0,.25,0,0,-.25,2,0,.25,2,0]),'VEC3',4,[-.25,0,0],[.25,2,0]);
  const normal=accessor(new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),'VEC3',4);
  const joints=accessor(new Uint8Array([1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0]),'VEC4',4);
  const weights=accessor(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]),'VEC4',4);
  const indices=accessor(new Uint16Array([0,1,2,2,1,3]),'SCALAR',6);
  const matrices=accessor(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,-1,0,1,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),'MAT4',2);
  const times=accessor(new Float32Array([0,.5,1]),'SCALAR',3,[0],[1]);
  const idle=accessor(new Float32Array([0,1,0,.02,1.025,0,0,1,0]),'VEC3',3);
  const walk=accessor(new Float32Array([0,1,0,.04,1.06,.02,0,1,0]),'VEC3',3);
  const identity=accessor(new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]),'VEC4',3);
  const stride=accessor(new Float32Array([0,0,0,1,.258819,0,0,.965926,0,0,0,1]),'VEC4',3);
  const animation=(name:string,translation:number,rotation:number)=>({name,samplers:[{input:times,output:translation},{input:times,output:rotation}],channels:[{sampler:0,target:{node:0,path:'translation'}},{sampler:1,target:{node:1,path:'rotation'}}]});
  while(offset%4){chunks.push(Buffer.from([0]));offset++;}
  const document={asset:{version:'2.0'},scene:0,scenes:[{nodes:[3]}],nodes:[{name:'Hips',translation:[0,1,0],children:[1]},{name:'Foot',translation:[0,-1,0]},{name:'Fixture mesh',mesh:0,skin:0},{name:'Armature',children:[0,2]}],skins:[{joints:[0,1],inverseBindMatrices:matrices}],meshes:[{primitives:[{attributes:{POSITION:position,NORMAL:normal,JOINTS_0:joints,WEIGHTS_0:weights},indices,material:0}]}],materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.25,.5,.3,1],metallicFactor:0,roughnessFactor:.8}}],animations:[animation('Idle',idle,identity),animation('Walk',walk,stride)],buffers:[{byteLength:offset}],bufferViews:views,accessors};
  let json=Buffer.from(JSON.stringify(document));while(json.length%4)json=Buffer.concat([json,Buffer.from(' ')]);
  const binary=Buffer.concat(chunks),header=Buffer.alloc(12),jsonHeader=Buffer.alloc(8),binHeader=Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+json.length+8+binary.length,8);
  jsonHeader.writeUInt32LE(json.length);jsonHeader.writeUInt32LE(0x4e4f534a,4);binHeader.writeUInt32LE(binary.length);binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jsonHeader,json,binHeader,binary]);
}

const user={id:'11000000-0000-4000-8000-000000000001',name:'Character owner',email:'characters@example.invalid',roleTitle:'Designer',avatarColor:'#c9d6b5',avatarId:'fixture-a'};
const colleague={...user,id:'11000000-0000-4000-8000-000000000002',name:'Real colleague'};
const company={id:'22000000-0000-4000-8000-000000000001',name:'Character fixture',slug:'character-fixture',template:'blank',role:'owner'};
// Optional private local model for the same regression suite; never commit it.
const privateModel=process.env.COATRIA_CHARACTER_MODEL;
const catalog={avatars:['fixture-a','fixture-b'].map(id=>({id,name:id,idleClip:'Idle',walkClip:'Walk',walkSpeed:privateModel ? 0.9505 : 1.5}))};
const fixture=privateModel?readFileSync(privateModel):characterFixture();
const screenshotDirectory=process.env.COATRIA_CHARACTER_SCREENSHOT_DIR;
const json=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});

async function install(page:Page,{hold=false,fail=false}:{hold?:boolean;fail?:boolean}={}){
  const fresh=()=>new Date().toISOString();
  const data={company,members:[user,colleague].map(person=>({...person,userId:person.id,role:'owner'})),rooms:[],agents:[{id:'33000000-0000-4000-8000-000000000001',name:'Distinct bot',harness:'API',status:'active',lastSeenAt:fresh()}],tasks:[],messages:[],presence:[{userId:colleague.id,name:colleague.name,x:3,z:2,status:'available',updatedAt:fresh()}],activity:[],drives:[],openings:[],applications:[],layout:[]};
  const requests:{id:string;identity:string}[]=[],held:Route[]=[],errors:string[]=[],animationWarnings:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(/THREE\.(PropertyBinding|AnimationMixer|AnimationAction)|No target node found/i.test(message.text()))animationWarnings.push(message.text());});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')return json(route,{user,companies:[company],configured:true});
    if(path==='/api/avatars')return json(route,catalog);
    if(/^\/api\/avatars\/[^/]+\/model$/.test(path)){
      requests.push({id:path.split('/')[3],identity:route.request().headers()['x-coatria-user']});
      if(hold){held.push(route);return;}
      if(fail)return json(route,{error:'Unavailable'},503);
      return route.fulfill({status:200,contentType:'model/gltf-binary',body:fixture});
    }
    if(path.endsWith('/workspace'))return json(route,data);
    if(path==='/api/vault')return json(route,{skills:[]});
    return json(route,{presence:data.presence});
  });
  await page.goto('/#office');
  await expect(page.locator('canvas')).toBeVisible();
  return{data,requests,held,errors,animationWarnings};
}
const diagnostics=(page:Page)=>page.evaluate(()=>(window as any).CoatriaScene.instance.diagnostics);

test.beforeEach(async({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Only local intercepted API fixtures.');});

test('human coworkers share downloads but animate independent rigs with blended calibrated locomotion',async({page})=>{
  const state=await install(page);
  await expect.poll(async()=>(await diagnostics(page)).loadedCharacterModels).toBe(2);
  expect(state.requests).toEqual([{id:'fixture-a',identity:user.id}]);
  const clones=await page.evaluate(()=>{
    const meshes:any[]=[];(window as any).CoatriaScene.instance.scene.traverse((object:any)=>{if(object.userData.coatriaAvatar){let mesh:any;object.traverse((child:any)=>{if(child.isSkinnedMesh&&!mesh)mesh=child;});meshes.push(mesh);}});
    (window as any).movingRig=meshes[0];(window as any).startingBonePose=meshes[0].skeleton.bones.flatMap((bone:any)=>[...bone.quaternion.toArray(),...bone.position.toArray()]);
    return{sharedGeometry:meshes[0].geometry===meshes[1].geometry,independentSkeleton:meshes[0].skeleton!==meshes[1].skeleton,independentBones:meshes[0].skeleton.bones[0]!==meshes[1].skeleton.bones[0]};
  });
  expect(clones).toEqual({sharedGeometry:true,independentSkeleton:true,independentBones:true});
  if(privateModel&&screenshotDirectory){mkdirSync(screenshotDirectory,{recursive:true});await page.evaluate(()=>{const camera=(window as any).CoatriaScene.instance.camera;camera.zoom=2;camera.updateProjectionMatrix();});}
  const initial=await diagnostics(page);
  expect(initial.occupants.find((person:any)=>person.type==='agent').modelLoaded).toBe(false);
  const samples=await page.evaluate(async()=>{
    const scene=(window as any).CoatriaScene.instance,out:any[]=[];scene.walkTo(2,3);
    for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);out.push(scene.diagnostics.occupants[0]);}
    return out;
  });
  expect(samples.some((sample:any)=>sample.walkWeight>.05&&sample.walkWeight<.9)).toBe(true);
  expect(samples.some((sample:any)=>sample.speed>.1&&sample.speed<1.3)).toBe(true);
  for(let i=1;i<samples.length;i++)expect(Math.abs(samples[i].rotation-samples[i-1].rotation)).toBeLessThan(.4);
  const current=(await diagnostics(page)).occupants[0];
  expect(current.walkPlaybackRate).toBeCloseTo(current.speed/current.referenceSpeed,2);
  expect(await page.evaluate(()=>{const pose=(window as any).movingRig.skeleton.bones.flatMap((bone:any)=>[...bone.quaternion.toArray(),...bone.position.toArray()]);return Math.max(...pose.map((value:number,index:number)=>Math.abs(value-(window as any).startingBonePose[index])));})).toBeGreaterThan(.01);
  if(privateModel&&screenshotDirectory)await page.screenshot({path:join(screenshotDirectory,'coatria-city-characters-walking.png'),fullPage:true});
  expect((await diagnostics(page)).occupants.find((person:any)=>person.id===colleague.id).walkWeight).toBe(0);
  await expect.poll(async()=>(await diagnostics(page)).walking).toBe(false);
  await expect.poll(async()=>(await diagnostics(page)).occupants[0].walkWeight).toBeLessThan(.001);
  if(privateModel&&screenshotDirectory){
    await page.screenshot({path:join(screenshotDirectory,'coatria-city-characters-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:join(screenshotDirectory,'coatria-city-characters-mobile.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
  expect(state.errors).toEqual([]);
  expect(state.animationWarnings).toEqual([]);
});

test('remote humans walk to snapshots and leaving releases only their own skeleton',async({page})=>{
  const state=await install(page);
  await expect.poll(async()=>(await diagnostics(page)).loadedCharacterModels).toBe(2);
  await page.evaluate(()=>{
    const scene=(window as any).CoatriaScene.instance;scene.scene.traverse((object:any)=>{if(object.isSkinnedMesh){(window as any).sharedCharacterGeometry=object.geometry;}});
    (window as any).geometryDisposals=0;(window as any).sharedCharacterGeometry.addEventListener('dispose',()=>{(window as any).geometryDisposals++;});
  });
  state.data.presence[0]={...state.data.presence[0],x:4,z:4,updatedAt:new Date(Date.now()+500).toISOString()};
  await page.evaluate(data=>(window as any).CoatriaScene.instance.updateSnapshot(data),state.data);
  await expect.poll(async()=>(await diagnostics(page)).occupants.find((person:any)=>person.id===colleague.id).walkWeight).toBeGreaterThan(.4);
  const moving=(await diagnostics(page)).occupants.find((person:any)=>person.id===colleague.id);
  expect(moving.speed).toBeLessThanOrEqual(3.01);expect(moving.x).toBeGreaterThan(3);expect(moving.x).toBeLessThan(4);
  await expect.poll(async()=>(await diagnostics(page)).occupants.find((person:any)=>person.id===colleague.id).pathLength).toBe(0);
  state.data.presence=[];
  await page.evaluate(data=>(window as any).CoatriaScene.instance.updateSnapshot(data),state.data);
  expect((await diagnostics(page)).loadedCharacterModels).toBe(1);
  expect(await page.evaluate(()=>(window as any).geometryDisposals)).toBe(0);
  expect(state.requests).toHaveLength(1);
  await page.getByRole('button',{name:/^My skill vault/}).click();
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).geometryDisposals)).toBe(1);
  expect(state.errors).toEqual([]);
});

test('late avatar responses cannot replace a newer choice or resurrect a closed office',async({page})=>{
  const state=await install(page,{hold:true});
  await expect.poll(()=>state.held.length).toBe(1);
  state.data.members[0].avatarId='fixture-b';
  await page.evaluate(data=>(window as any).CoatriaScene.instance.updateSnapshot({...data,user:{...data.members[0],id:data.members[0].userId}}),state.data);
  await expect.poll(()=>state.held.length).toBe(2);
  await state.held[1].fulfill({status:200,contentType:'model/gltf-binary',body:fixture});
  await expect.poll(async()=>(await diagnostics(page)).occupants[0].avatarId).toBe('fixture-b');
  await state.held[0].fulfill({status:200,contentType:'model/gltf-binary',body:fixture});
  await expect.poll(async()=>(await diagnostics(page)).loadedCharacterModels).toBe(2);
  expect((await diagnostics(page)).occupants[0].avatarId).toBe('fixture-b');
  await page.getByRole('button',{name:/^My skill vault/}).click();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('button',{name:'The office',exact:true}).click();
  await expect.poll(()=>state.held.length).toBeGreaterThan(2);
  await page.getByRole('button',{name:/^My skill vault/}).click();
  await Promise.all(state.held.slice(2).map(route=>route.fulfill({status:200,contentType:'model/gltf-binary',body:fixture}).catch(()=>{})));
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(()=>(window as any).CoatriaScene.instance)).toBeNull();
  expect(state.errors).toEqual([]);
});

test('model failure preserves a navigable procedural office and accessible room controls',async({page})=>{
  const state=await install(page,{fail:true});
  await expect.poll(()=>state.requests.length).toBe(1);
  expect((await diagnostics(page)).loadedCharacterModels).toBe(0);
  await page.evaluate(()=>(window as any).CoatriaScene.instance.walkTo(1,5));
  await expect.poll(async()=>(await diagnostics(page)).walking).toBe(false);
  expect((await diagnostics(page)).position.x).toBeCloseTo(1,1);
  await expect(page.getByText('Office rooms · accessible list',{exact:true})).toBeVisible();
  expect(state.errors).toEqual([]);
});
