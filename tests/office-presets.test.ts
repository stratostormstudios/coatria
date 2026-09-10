import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICE_50_PRESET as preset,type OfficePoint} from '../src/lib/office-presets';
import {getOfficeAsset} from '../src/lib/office-catalog';
import {MAX_LAYOUT_ITEMS,type LayoutItem} from '../src/lib/floor-plan';
import {layoutInput} from '../src/lib/model';

const EPS=1e-7,clearance=.3,wallMargin=.45;
type Bounds={minX:number;maxX:number;minZ:number;maxZ:number};
function box(item:LayoutItem):Bounds{return {minX:item.x*preset.floor.width/100-preset.floor.width/2,maxX:(item.x+item.w)*preset.floor.width/100-preset.floor.width/2,minZ:item.y*preset.floor.depth/100-preset.floor.depth/2,maxZ:(item.y+item.h)*preset.floor.depth/100-preset.floor.depth/2};}
const collidable=preset.layout.filter(item=>getOfficeAsset(item.assetId!)?.collidable!==false).map(item=>({item,bounds:box(item)}));
const padded=collidable.map(({item,bounds:b})=>({id:item.id,minX:b.minX-clearance,maxX:b.maxX+clearance,minZ:b.minZ-clearance,maxZ:b.maxZ+clearance}));
const nav={minX:-preset.floor.width/2+wallMargin,maxX:preset.floor.width/2-wallMargin,minZ:-preset.floor.depth/2+wallMargin,maxZ:preset.floor.depth/2-wallMargin};
function inside(point:OfficePoint,b:Bounds){return point.x>b.minX+EPS&&point.x<b.maxX-EPS&&point.z>b.minZ+EPS&&point.z<b.maxZ-EPS;}
function open(point:OfficePoint){return point.x>=nav.minX&&point.x<=nav.maxX&&point.z>=nav.minZ&&point.z<=nav.maxZ&&!padded.some(b=>inside(point,b));}
function overlap(a:Bounds,b:Bounds){return Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX)>EPS&&Math.min(a.maxZ,b.maxZ)-Math.max(a.minZ,b.minZ)>EPS;}
function near(actual:number,expected:number,message:string){assert.ok(Math.abs(actual-expected)<1e-6,message+`: ${actual} != ${expected}`);}

test('the 50-person preset is a valid bounded floor write with an explicit workstation inventory',()=>{
 assert.equal(preset.id,'office-50');assert.deepEqual(preset.floor,{width:30,depth:20});assert.equal(preset.layout.length,148);assert.ok(preset.layout.length<=MAX_LAYOUT_ITEMS);assert.ok(MAX_LAYOUT_ITEMS<=180);
 const parsed=layoutInput.safeParse({layout:preset.layout,floor:preset.floor,revision:0});assert.equal(parsed.success,true,parsed.success?'':JSON.stringify(parsed.error.issues));
 assert.equal(preset.workstations.length,50);assert.equal(new Set(preset.workstations.map(station=>station.id)).size,50);assert.equal(new Set(preset.layout.map(item=>item.id)).size,148);assert.equal(preset.zones.filter(zone=>zone.kind==='team').length,5);
 for(const zone of preset.zones.filter(zone=>zone.kind==='team')){assert.equal(zone.capacity,10);assert.equal(preset.workstations.filter(station=>station.zoneId===zone.id).length,10);}
});

test('every placed object uses an allowlisted asset and uniform furniture retains native physical dimensions',()=>{
 for(const item of preset.layout){const asset=getOfficeAsset(item.assetId!);assert.ok(asset,item.id);assert.equal(item.type,'asset');const rotated=(item.rotation||0)%180!==0;
  if(asset.resize==='uniform'){near(item.w*preset.floor.width/100,rotated?asset.depth:asset.width,item.id+' width');near(item.h*preset.floor.depth/100,rotated?asset.width:asset.depth,item.id+' depth');}
  assert.ok(item.x>=0&&item.y>=0&&item.x+item.w<=100&&item.y+item.h<=100,item.id+' stays inside the floor');
 }
 assert.equal(preset.layout.filter(item=>getOfficeAsset(item.assetId!)?.collidable===false).length,9,'Only the nine floor finishes are non-collidable.');
});

test('no two solid furniture footprints overlap, including separately placed chairs',()=>{
 for(let index=0;index<collidable.length;index++)for(let other=index+1;other<collidable.length;other++)assert.equal(overlap(collidable[index].bounds,collidable[other].bounds),false,`${collidable[index].item.id} overlaps ${collidable[other].item.id}`);
});

test('each workstation has its own desk and chair, with a facing direction toward that desk',()=>{
 const deskIds=new Set<string>(),chairIds=new Set<string>();
 for(const station of preset.workstations){const desk=preset.layout.find(item=>item.id===station.deskId),chair=preset.layout.find(item=>item.id===station.chairId);assert.ok(desk&&chair,station.id);assert.equal(getOfficeAsset(desk.assetId!)?.category,'desks');assert.equal(getOfficeAsset(chair.assetId!)?.category,'seating');deskIds.add(desk.id);chairIds.add(chair.id);const db=box(desk),cb=box(chair),deskCenter={x:(db.minX+db.maxX)/2,z:(db.minZ+db.maxZ)/2};
  near(station.seat.x,(cb.minX+cb.maxX)/2,station.id+' seat X');near(station.seat.z,(cb.minZ+cb.maxZ)/2,station.id+' seat Z');const dx=deskCenter.x-station.seat.x,dz=deskCenter.z-station.seat.z,length=Math.hypot(dx,dz);near(Math.sin(station.facing),dx/length,station.id+' facing X');near(Math.cos(station.facing),dz/length,station.id+' facing Z');assert.ok(inside(station.seat,cb),'Seat metadata represents the chair, not a walkable spawn.');
 }
 assert.equal(deskIds.size,50);assert.equal(chairIds.size,50);
});

test('all 50 standing approaches, meeting points and the entrance clear furniture and floor padding',()=>{
 for(const station of preset.workstations)assert.ok(open(station.approach),station.id+' approach is blocked');for(const zone of preset.zones)assert.ok(open(zone.meetingPoint),zone.id+' meeting point is blocked');assert.ok(open(preset.spawn),'Entrance spawn is blocked');
 for(let i=0;i<preset.workstations.length;i++)for(let j=i+1;j<preset.workstations.length;j++){const a=preset.workstations[i].approach,b=preset.workstations[j].approach;assert.ok(Math.hypot(a.x-b.x,a.z-b.z)>=clearance*2,'Standing participants need separate positions.');}
});

test('declared circulation bands retain at least 0.6m of clear width after collision padding',()=>{
 for(const aisle of preset.aisles){const b=aisle.bounds,world={minX:b.x-preset.floor.width/2,maxX:b.x+b.width-preset.floor.width/2,minZ:b.y-preset.floor.depth/2,maxZ:b.y+b.depth-preset.floor.depth/2};assert.ok(Math.min(b.width,b.depth)>=.6,aisle.id);assert.ok(world.minX>=nav.minX&&world.maxX<=nav.maxX&&world.minZ>=nav.minZ&&world.maxZ<=nav.maxZ,aisle.id+' boundary');for(const obstacle of padded)assert.equal(overlap(world,obstacle),false,aisle.id+' blocked by '+obstacle.id);}
});

// Conservative four-neighbour grid connectivity uses the renderer's 0.38m
// sampling and0.3m padding. Segment checks prevent crossing obstacle corners.
test('the renderer-resolution occupancy grid connects every station and shared zone to the entrance',()=>{
 const columns=Math.ceil((nav.maxX-nav.minX)/.38)+1,rows=Math.ceil((nav.maxZ-nav.minZ)/.38)+1,stepX=(nav.maxX-nav.minX)/(columns-1),stepZ=(nav.maxZ-nav.minZ)/(rows-1);
 const points=Array.from({length:columns*rows},(_,index)=>({x:nav.minX+(index%columns)*stepX,z:nav.minZ+Math.floor(index/columns)*stepZ})),walkable=points.map(open);
 function clear(a:OfficePoint,b:OfficePoint){if(!open(a)||!open(b))return false;return !padded.some(obstacle=>{let near=0,far=1;for(const [key,min,max] of [['x',obstacle.minX+EPS,obstacle.maxX-EPS],['z',obstacle.minZ+EPS,obstacle.maxZ-EPS]] as const){const origin=a[key],delta=b[key]-origin;if(Math.abs(delta)<1e-10){if(origin<=min||origin>=max)return false;}else{const first=(min-origin)/delta,last=(max-origin)/delta;near=Math.max(near,Math.min(first,last));far=Math.min(far,Math.max(first,last));if(near>far)return false;}}return near<=far;});}
 function nearest(point:OfficePoint){let best=-1,distance=Infinity;for(let index=0;index<points.length;index++){const p=points[index],next=Math.hypot(point.x-p.x,point.z-p.z);if(walkable[index]&&next<distance&&next<=.38*3&&clear(point,p)){best=index;distance=next;}}return best;}
 const start=nearest(preset.spawn);assert.ok(start>=0,'Entrance has no reachable grid sample.');const seen=new Set([start]),queue=[start];for(let head=0;head<queue.length;head++){const index=queue[head],x=index%columns,y=Math.floor(index/columns);for(const next of [x>0?index-1:-1,x+1<columns?index+1:-1,y>0?index-columns:-1,y+1<rows?index+columns:-1])if(next>=0&&!seen.has(next)&&walkable[next]&&clear(points[index],points[next])){seen.add(next);queue.push(next);}}
 for(const target of [...preset.workstations.map(station=>({id:station.id,point:station.approach})),...preset.zones.map(zone=>({id:zone.id,point:zone.meetingPoint}))]){const index=nearest(target.point);assert.ok(index>=0&&seen.has(index),target.id+' is disconnected from the entrance.');}
 assert.ok(seen.size>1000,'The floor must provide a shared circulation network, not isolated standing pockets.');
});
