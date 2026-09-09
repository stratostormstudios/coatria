import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {Matrix4,Quaternion,Vector3} from '../public/spatial/vendor/three.core.js';
import {editorPlan,metres,moveItem,newItem,place,resizeFloor,resizeItem,rotateItem,setItemDimension,type Edge,type Rect} from '../src/lib/floor-editor';
import type {FloorSize,LayoutItem} from '../src/lib/floor-plan';
import {OFFICE_CATALOG,getOfficeAsset} from '../src/lib/office-catalog';
import {layoutInput} from '../src/lib/model';
import {officeAssetPath} from '../src/lib/office-assets';
import {checkOfficeAssets} from '../scripts/check-office-assets';

const close=(actual:number,expected:number,context='',epsilon=1e-9)=>assert.ok(Math.abs(actual-expected)<epsilon,`${context}: ${actual} should equal ${expected}`);
const edges:Edge[]=['n','ne','e','se','s','sw','w','nw'];
const valid=(item:LayoutItem,floor:FloorSize)=>assert.ok(layoutInput.safeParse({layout:[item],floor,revision:0}).success,JSON.stringify({item,floor}));
const original=(assetId:string,floor:FloorSize={width:20,depth:16})=>newItem('asset',editorPlan([],floor),'library-item',undefined,false,assetId);
function anchor(before:Rect,after:Rect,edge:Edge){
 close(after.x+(edge.includes('w')?after.w:edge.includes('e')?0:after.w/2),before.x+(edge.includes('w')?before.w:edge.includes('e')?0:before.w/2),edge+' horizontal anchor');
 close(after.y+(edge.includes('n')?after.h:edge.includes('s')?0:after.h/2),before.y+(edge.includes('n')?before.h:edge.includes('s')?0:before.h/2),edge+' vertical anchor');
}

test('all eight uniform resize handles preserve proportions and the opposite edge or centre through clamps',()=>{
 for(const floor of [{width:8,depth:8},{width:40,depth:8},{width:8,depth:40},{width:40,depth:40}]){
  for(const id of ['office-desk-001','office-sofa-019','office-plant-023']){
   for(const rotation of [0,90]){
    let item=original(id,floor);if(rotation)item=rotateItem(item,floor);
    const before=metres(item,floor);
    for(const edge of edges)for(const amount of [-100,-.17,.23,100])for(const snapping of [false,true]){
     const dx=edge.includes('w')?-amount:edge.includes('e')?amount:0,dy=edge.includes('n')?-amount:edge.includes('s')?amount:0;
     const changed=resizeItem(item,floor,edge,dx,dy,snapping),after=metres(changed,floor);
     valid(changed,floor);close(after.w/after.h,before.w/before.h,id+' '+edge+' aspect');anchor(before,after,edge);
     assert(after.w>=.04-1e-9&&after.h>=.04-1e-9);assert.equal(changed.rotation,item.rotation);assert.equal(changed.assetId,id);
    }
   }
  }
 }
});

test('numeric furniture sizing keeps its top-left and aspect, including rotated and floor-bound cases',()=>{
 for(const floor of [{width:8,depth:40},{width:40,depth:8}])for(const rotation of [0,90]){
  let item=original('office-desk-001',floor);if(rotation)item=rotateItem(item,floor);
  const before=metres(item,floor);
  for(const key of ['w','h'] as const)for(const value of [-100,.04,.73,100]){
   const changed=setItemDimension(item,floor,key,value),after=metres(changed,floor);valid(changed,floor);
   close(after.x,before.x);close(after.y,before.y);close(after.w/after.h,before.w/before.h);
   assert(after.w>=.04-1e-9&&after.h>=.04-1e-9);
  }
 }
});

test('thin partition footprints keep their authored thickness during moves, long-edge resizes and turns',()=>{
 for(const floor of [{width:8,depth:8},{width:40,depth:40}]){
  for(const asset of OFFICE_CATALOG.filter(asset=>asset.resize==='footprint'&&asset.depth<.2)){
   const item=original(asset.id,floor),before=metres(item,floor);
   assert(before.h<.2);close(before.h,asset.depth);
   for(const edge of ['e','w'] as Edge[])for(const delta of [-100,.2,100]){
    const changed=resizeItem(item,floor,edge,delta,0,false),after=metres(changed,floor);valid(changed,floor);
    close(after.h,before.h);assert(after.w>=.04-1e-9);
   }
   const moved=moveItem(item,floor,2,2,true);close(metres(moved,floor).h,before.h);
   const quarter=rotateItem(item,floor),turned=metres(quarter,floor);valid(quarter,floor);close(turned.w,before.h);close(turned.h,before.w);
   const resized=resizeItem(quarter,floor,'s',0,.5,false);close(metres(resized,floor).w,before.h);
   const minimum=resizeItem(item,floor,'s',0,-100,false);valid(minimum,floor);close(metres(minimum,floor).h,.04);
  }
 }
});

test('every library object starts at the catalog size and four turns preserve its stored size',()=>{
 for(const floor of [{width:8,depth:8},{width:8,depth:40},{width:40,depth:8},{width:40,depth:40}])for(const asset of OFFICE_CATALOG){
  const item=original(asset.id,floor),before=metres(item,floor),fit=Math.min(1,floor.width/asset.width,floor.depth/asset.depth);
  valid(item,floor);close(before.w,asset.width*fit,asset.id+' default width');close(before.h,asset.depth*fit,asset.id+' default depth');
  assert.equal(item.assetId,asset.id);assert.equal(item.rotation,0);
  let rotated=item;for(let i=0;i<4;i++)rotated=rotateItem(rotated,floor);
  const after=metres(rotated,floor);valid(rotated,floor);close(after.w,before.w);close(after.h,before.h);assert.equal(rotated.rotation,0);
 }
 const plan=editorPlan([]),item=original('office-desk-001');plan.layout.push({...item,label:item.label.toUpperCase()});
 assert.equal(newItem('asset',plan,'second',undefined,false,item.assetId).label,'Compact task desk 02');
 assert.throws(()=>newItem('asset',plan,'unknown',undefined,false,'../office-desk-001'),/Choose furniture from the library/);
});

test('floor changes preserve asset metre positions, edited dimensions and rotation without growing thin panels',()=>{
 for(const asset of OFFICE_CATALOG){
  let plan=editorPlan([]),item=original(asset.id);item=rotateItem(item,plan.floor);item=place(item,{...metres(item,plan.floor),x:1,y:1},plan.floor);
  if(asset.resize==='uniform')item=setItemDimension(item,plan.floor,'w',metres(item,plan.floor).w*1.2);
  plan.layout.push(item);const before=metres(item,plan.floor);
  for(const floor of [{width:40,depth:40},{width:8,depth:8},{width:20.123,depth:16.567},{width:20,depth:16}]){
   plan=resizeFloor(plan,floor);const after=metres(plan.layout[0],plan.floor);valid(plan.layout[0],plan.floor);
   for(const key of ['x','y','w','h'] as const)close(after[key],before[key],asset.id+' '+key);
   assert.equal(plan.layout[0].rotation,item.rotation);assert.equal(plan.layout[0].assetId,item.assetId);
  }
 }
});

type Gltf={
 scene?:number;scenes:{nodes:number[]}[];
 nodes:{matrix?:number[];translation?:number[];rotation?:number[];scale?:number[];children?:number[];mesh?:number;skin?:number;camera?:number}[];
 meshes:{primitives:{attributes:Record<string,number>;indices?:number;material?:number;targets?:unknown[];mode?:number}[]}[];
 accessors:{bufferView:number;byteOffset?:number;componentType:number;count:number;type:string;sparse?:unknown}[];
 bufferViews:{buffer:number;byteOffset?:number;byteLength:number;byteStride?:number}[];
 materials?:Record<string,unknown>[];textures?:{source:number;sampler?:number}[];images?:{bufferView:number}[];samplers?:unknown[];
 animations?:unknown[];skins?:unknown[];extensionsUsed?:unknown[];
};
/** Read actual vertices, not accessor min/max or the preparation pipeline's audit. */
function modelBounds(bytes:Buffer){
 const jsonLength=bytes.readUInt32LE(12),document=JSON.parse(bytes.subarray(20,20+jsonLength).toString()) as Gltf;
 const binary=bytes.subarray(28+jsonLength),min=new Vector3(Infinity,Infinity,Infinity),max=new Vector3(-Infinity,-Infinity,-Infinity);let vertices=0;
 assert(!document.skins?.length&&!document.animations?.length&&!document.extensionsUsed?.length,'The office pipeline only supports static unextended meshes.');
 function visit(index:number,parent:InstanceType<typeof Matrix4>,ancestors:Set<number>){
  assert(!ancestors.has(index),'Scene graph must be acyclic.');const next=new Set(ancestors).add(index),node=document.nodes[index];assert(node);assert.equal(node.skin,undefined);assert.equal(node.camera,undefined);
  const local=node.matrix?new Matrix4().fromArray(node.matrix):new Matrix4().compose(new Vector3().fromArray(node.translation||[0,0,0]),new Quaternion().fromArray(node.rotation||[0,0,0,1]),new Vector3().fromArray(node.scale||[1,1,1]));
  const world=new Matrix4().multiplyMatrices(parent,local);
  if(node.mesh!==undefined){const mesh=document.meshes[node.mesh];assert(mesh);for(const primitive of mesh.primitives){
   assert(!primitive.targets?.length,'Morph targets need explicit remapping before this pipeline supports them.');assert.equal(primitive.mode??4,4);
   for(const id of Object.values(primitive.attributes))assert(document.accessors[id]);
   if(primitive.indices!==undefined)assert(document.accessors[primitive.indices]);if(primitive.material!==undefined)assert(document.materials?.[primitive.material]);
   const accessor=document.accessors[primitive.attributes.POSITION];assert(accessor);assert.equal(accessor.componentType,5126);assert.equal(accessor.type,'VEC3');assert.equal(accessor.sparse,undefined);
   const view=document.bufferViews[accessor.bufferView];assert(view);assert.equal(view.buffer,0);const stride=view.byteStride??12,offset=(view.byteOffset??0)+(accessor.byteOffset??0);
   assert(offset+(accessor.count-1)*stride+12<=(view.byteOffset??0)+view.byteLength);
   for(let i=0;i<accessor.count;i++){const at=offset+i*stride,point=new Vector3(binary.readFloatLE(at),binary.readFloatLE(at+4),binary.readFloatLE(at+8)).applyMatrix4(world);assert([point.x,point.y,point.z].every(Number.isFinite));min.min(point);max.max(point);vertices++;}
  }}
  for(const child of node.children||[])visit(child,world,next);
 }
 for(const root of document.scenes[document.scene??0].nodes)visit(root,new Matrix4(),new Set());assert(vertices>0);
 for(const texture of document.textures||[]){assert(document.images?.[texture.source]);if(texture.sampler!==undefined)assert(document.samplers?.[texture.sampler]);}
 for(const image of document.images||[])assert(document.bufferViews[image.bufferView]);
 return {min,max,size:new Vector3().subVectors(max,min)};
}

test('installed licensed bundle has complete previews and model geometry matching catalog footprints',async context=>{
 if(!existsSync(officeAssetPath(OFFICE_CATALOG[0].id))){context.skip('Source-only checkout: the purchased private bundle is not installed.');return;}
 const bundle=await checkOfficeAssets();assert.equal(bundle.count,OFFICE_CATALOG.length);
 for(const asset of OFFICE_CATALOG){
  const {min,max,size}=modelBounds(await readFile(officeAssetPath(asset.id)));
  close(size.x,asset.width,asset.id+' model width',1e-5);close(size.z,asset.depth,asset.id+' model depth',1e-5);
  // Flat floor finishes use a 1 mm metadata height to avoid a zero display size.
  if(asset.collidable===false)assert(size.y>=0&&size.y<=.002);else close(size.y,asset.height,asset.id+' model height',1e-5);
  close((min.x+max.x)/2,0,asset.id+' horizontal centre',1e-5);close((min.z+max.z)/2,0,asset.id+' depth centre',1e-5);close(min.y,0,asset.id+' ground',1e-5);
  assert.equal(getOfficeAsset(asset.id),asset);
 }
});
