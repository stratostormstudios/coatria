import test from 'node:test';
import assert from 'node:assert/strict';
import {generateOffice,OFFICE_GENERATOR_PRESETS,OfficeGenerationError,type GeneratedOffice,type OfficeGeneratorOptions} from '../src/lib/office-generator';
import {getOfficeAsset} from '../src/lib/office-catalog';
import {MAX_LAYOUT_ITEMS,type LayoutItem} from '../src/lib/floor-plan';
import type {OfficePoint} from '../src/lib/office-presets';
import {layoutInput} from '../src/lib/model';
import {getOfficeSeats} from '../src/lib/office-seating';

const EPS=1e-7;
const DEFAULT:OfficeGeneratorOptions={deskCount:24,roomCount:3,style:'courtyard',spaciousness:'airy',seed:'Coatria'};
const STYLES=['courtyard','neighborhoods','gallery'] as const,SPACING=['balanced','airy'] as const;
type Bounds={minX:number;maxX:number;minZ:number;maxZ:number};
const near=(actual:number,expected:number,label:string)=>assert.ok(Math.abs(actual-expected)<1e-6,`${label}: ${actual} != ${expected}`);
function box(plan:GeneratedOffice,item:LayoutItem):Bounds{return {minX:item.x*plan.floor.width/100-plan.floor.width/2,maxX:(item.x+item.w)*plan.floor.width/100-plan.floor.width/2,minZ:item.y*plan.floor.depth/100-plan.floor.depth/2,maxZ:(item.y+item.h)*plan.floor.depth/100-plan.floor.depth/2};}
function overlap(a:Bounds,b:Bounds){return Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX)>EPS&&Math.min(a.maxZ,b.maxZ)-Math.max(a.minZ,b.minZ)>EPS;}
function solids(plan:GeneratedOffice){return plan.layout.filter(item=>getOfficeAsset(item.assetId!)?.collidable!==false).map(item=>({id:item.id,...box(plan,item)}));}
function walkability(plan:GeneratedOffice){
 const padded=solids(plan).map(b=>({...b,minX:b.minX-.3,maxX:b.maxX+.3,minZ:b.minZ-.3,maxZ:b.maxZ+.3}));
 const nav={minX:-plan.floor.width/2+.45,maxX:plan.floor.width/2-.45,minZ:-plan.floor.depth/2+.45,maxZ:plan.floor.depth/2-.45};
 const open=(p:OfficePoint)=>p.x>=nav.minX&&p.x<=nav.maxX&&p.z>=nav.minZ&&p.z<=nav.maxZ&&!padded.some(b=>p.x>b.minX+EPS&&p.x<b.maxX-EPS&&p.z>b.minZ+EPS&&p.z<b.maxZ-EPS);
 const clear=(a:OfficePoint,b:OfficePoint)=>open(a)&&open(b)&&!padded.some(obstacle=>{
  let near=0,far=1;
  for(const [key,min,max] of [['x',obstacle.minX+EPS,obstacle.maxX-EPS],['z',obstacle.minZ+EPS,obstacle.maxZ-EPS]] as const){
   const origin=a[key],delta=b[key]-origin;
   if(Math.abs(delta)<1e-10){if(origin<=min||origin>=max)return false;}
   else{const first=(min-origin)/delta,last=(max-origin)/delta;near=Math.max(near,Math.min(first,last));far=Math.min(far,Math.max(first,last));if(near>far)return false;}
  }
  return near<=far;
 });
 return {padded,nav,open,clear};
}
function checkGeometry(plan:GeneratedOffice){
 const label=JSON.stringify(plan.options),solid=solids(plan),walk=walkability(plan);
 const parsed=layoutInput.safeParse({layout:plan.layout,floor:plan.floor,revision:0});
 assert.equal(parsed.success,true,label+(parsed.success?'':JSON.stringify(parsed.error.issues)));
 assert.ok(plan.layout.length<=180&&plan.layout.length<=MAX_LAYOUT_ITEMS,label);
 assert.equal(plan.workstations.length,plan.options.deskCount,label);assert.equal(plan.spatialRooms.length,plan.options.roomCount,label);
 assert.equal(plan.zones.filter(zone=>zone.kind==='meeting').length,plan.options.roomCount,label);
 for(const item of plan.layout){const asset=getOfficeAsset(item.assetId!)!;assert.ok(asset,item.id);if(asset.resize==='uniform'){
  const swapped=(item.rotation||0)%180!==0;near(item.w*plan.floor.width/100,swapped?asset.depth:asset.width,item.id+' native width');near(item.h*plan.floor.depth/100,swapped?asset.width:asset.depth,item.id+' native depth');
 }}
 for(let i=0;i<solid.length;i++)for(let j=i+1;j<solid.length;j++)assert.equal(overlap(solid[i],solid[j]),false,`${label}: ${solid[i].id} overlaps ${solid[j].id}`);
 for(const target of [{id:'spawn',point:plan.spawn},...plan.workstations.map(s=>({id:s.id,point:s.approach})),...plan.zones.map(z=>({id:z.id,point:z.meetingPoint})),...plan.spatialRooms.map(r=>({id:r.zoneId+' entry',point:r.entry}))])assert.ok(walk.open(target.point),label+': '+target.id+' must clear 0.3 m furniture padding.');
 for(const aisle of plan.aisles){const b=aisle.bounds,wb={minX:b.x-plan.floor.width/2,maxX:b.x+b.width-plan.floor.width/2,minZ:b.y-plan.floor.depth/2,maxZ:b.y+b.depth-plan.floor.depth/2};
  assert.ok(Math.min(b.width,b.depth)>=.6-EPS,aisle.id+' clear width');assert.ok(wb.minX>=walk.nav.minX-EPS&&wb.maxX<=walk.nav.maxX+EPS&&wb.minZ>=walk.nav.minZ-EPS&&wb.maxZ<=walk.nav.maxZ+EPS,aisle.id+' boundary');
  for(const obstacle of walk.padded)assert.equal(overlap(wb,obstacle),false,label+': '+aisle.id+' blocked by '+obstacle.id);
 }
 for(const room of plan.spatialRooms){assert.equal(room.partitionIds.length,3);assert.ok(room.entryWidthM>=5.1-EPS);const zone=plan.zones.find(zone=>zone.id===room.zoneId)!;assert.equal(zone.capacity,2);assert.ok(walk.clear(room.entry,zone.meetingPoint),label+': '+zone.name+' entry must stay open.');}
}

function checkConnected(plan:GeneratedOffice,extraTargets:{id:string;point:OfficePoint}[]=[]){
 const {nav,open,clear}=walkability(plan),columns=Math.ceil((nav.maxX-nav.minX)/.38)+1,rows=Math.ceil((nav.maxZ-nav.minZ)/.38)+1,stepX=(nav.maxX-nav.minX)/(columns-1),stepZ=(nav.maxZ-nav.minZ)/(rows-1);
 const points=Array.from({length:columns*rows},(_,i)=>({x:nav.minX+(i%columns)*stepX,z:nav.minZ+Math.floor(i/columns)*stepZ})),walkable=points.map(open);
 function nearest(point:OfficePoint){let best=-1,distance=Infinity;for(let index=0;index<points.length;index++){const p=points[index],next=Math.hypot(point.x-p.x,point.z-p.z);if(walkable[index]&&next<distance&&next<=.38*3&&clear(point,p)){best=index;distance=next;}}return best;}
 const start=nearest(plan.spawn);assert.ok(start>=0,'Entrance has a grid sample.');const seen=new Uint8Array(points.length),queue=[start];seen[start]=1;
 for(let head=0;head<queue.length;head++){const index=queue[head],x=index%columns,y=Math.floor(index/columns);for(const next of [x>0?index-1:-1,x+1<columns?index+1:-1,y>0?index-columns:-1,y+1<rows?index+columns:-1])if(next>=0&&!seen[next]&&walkable[next]&&clear(points[index],points[next])){seen[next]=1;queue.push(next);}}
 for(const target of [...plan.workstations.map(s=>({id:s.id,point:s.approach})),...plan.zones.map(z=>({id:z.id,point:z.meetingPoint})),...plan.spatialRooms.map(r=>({id:r.zoneId+' entry',point:r.entry})),...extraTargets]){
  const nearestIndex=nearest(target.point);assert.ok(nearestIndex>=0&&seen[nearestIndex],JSON.stringify(plan.options)+': '+target.id+' cannot reach the entrance on the renderer-resolution grid.');
 }
}

test('input validation rejects ambiguous, out-of-range and malformed requests precisely',()=>{
 const invalid:[keyof OfficeGeneratorOptions,unknown][]=[['deskCount',0],['deskCount',61],['deskCount',2.5],['deskCount',NaN],['deskCount','24'],['roomCount',-1],['roomCount',9],['roomCount',Infinity],['style','random'],['spaciousness','dense'],['seed',''],['seed','   '],['seed','a'.repeat(65)],['seed',Infinity],['seed',{}]];
 for(const [field,value] of invalid)assert.throws(()=>generateOffice({...DEFAULT,[field]:value} as OfficeGeneratorOptions),(error:unknown)=>error instanceof OfficeGenerationError&&error.code==='INVALID_OPTIONS'&&error.issues.some(issue=>issue.field===field&&issue.message.length>20));
 assert.throws(()=>generateOffice(null as unknown as OfficeGeneratorOptions),OfficeGenerationError);
});

test('the same seed reproduces exact geometry without mutating input or sharing mutable output',()=>{
 const options=Object.freeze({...DEFAULT}),first=generateOffice(options),second=generateOffice(options);
 assert.deepEqual(first,second);assert.deepEqual(options,DEFAULT);first.layout[0].x=99;first.options.deskCount=1;
 assert.deepEqual(generateOffice(options),second);assert.equal(second.options.deskCount,24);
 const signatures=new Set(Array.from({length:20},(_,seed)=>JSON.stringify(generateOffice({...DEFAULT,seed}).layout)));
 assert.equal(signatures.size,20,'Seeds vary cell placement and authored furniture palettes.');
});

test('all supported desk and nook counts fit the floor and hard object budget without reducing requests',()=>{
 for(const style of STYLES)for(const spaciousness of SPACING)for(let deskCount=1;deskCount<=60;deskCount++)for(let roomCount=0;roomCount<=8;roomCount++){
  const plan=generateOffice({deskCount,roomCount,style,spaciousness,seed:'capacity'});
  assert.equal(plan.workstations.length,deskCount);assert.equal(plan.spatialRooms.length,roomCount);assert.ok(plan.layout.length<=180);assert.ok(plan.floor.width>=8&&plan.floor.width<=40&&plan.floor.depth>=8&&plan.floor.depth<=40);
  assert.equal(new Set(plan.layout.map(item=>item.id)).size,plan.layout.length);assert.equal(plan.summary.objectCount,plan.layout.length);
 }
});

test('many seeds, styles and densities preserve native proportions, solid separation and safe aisle bands',()=>{
 const counts=[[1,0],[1,8],[6,1],[7,0],[12,4],[24,3],[36,4],[50,8],[60,0],[60,8]] as const;
 for(const style of STYLES)for(const spaciousness of SPACING)for(const [deskCount,roomCount] of counts)for(const seed of ['forest',29])checkGeometry(generateOffice({deskCount,roomCount,style,spaciousness,seed}));
});

test('each station has a distinct calibrated chair, a distinct desk and an approach behind its seat',()=>{
 for(const style of STYLES){const plan=generateOffice({...DEFAULT,deskCount:60,roomCount:8,style}),deskIds=new Set<string>(),chairIds=new Set<string>();
  for(const station of plan.workstations){const desk=plan.layout.find(item=>item.id===station.deskId)!,chair=plan.layout.find(item=>item.id===station.chairId)!;assert.equal(getOfficeAsset(desk.assetId!)!.category,'desks');assert.ok(['office-chair-001','office-chair-009','office-chair-012'].includes(chair.assetId!));deskIds.add(desk.id);chairIds.add(chair.id);
   const db=box(plan,desk),cb=box(plan,chair),dx=(db.minX+db.maxX)/2-station.seat.x,dz=(db.minZ+db.maxZ)/2-station.seat.z;
   near(station.seat.x,(cb.minX+cb.maxX)/2,'Seat center X');near(station.seat.z,(cb.minZ+cb.maxZ)/2,'Seat center Z');near(Math.sin(station.facing),dx/Math.hypot(dx,dz),'Facing X');near(Math.cos(station.facing),dz/Math.hypot(dx,dz),'Facing Z');
   assert.ok((station.approach.x-station.seat.x)*dx+(station.approach.z-station.seat.z)*dz<0,'Approach stays behind its chair.');
  }
  assert.equal(deskIds.size,60);assert.equal(chairIds.size,60);assert.equal(plan.zones.filter(z=>z.kind==='team').reduce((count,z)=>count+z.capacity,0),60);
 }
});

test('standing approaches and all open nook entries remain connected with renderer collision padding',()=>{
 for(const style of STYLES)for(const spaciousness of SPACING)for(const [deskCount,roomCount] of [[1,0],[1,8],[24,3],[60,8]] as const)for(const seed of [3,71])checkConnected(generateOffice({deskCount,roomCount,style,spaciousness,seed}));
});

test('the shared seating helper exposes every task and visitor chair with a reachable runtime approach',()=>{
 for(const style of STYLES)for(const spaciousness of SPACING)for(const [deskCount,roomCount] of [[1,0],[24,3],[50,4],[60,8]] as const)for(const seed of [2,87]){
  const plan=generateOffice({deskCount,roomCount,style,spaciousness,seed}),seats=getOfficeSeats(plan.layout,plan.floor),walk=walkability(plan);
  assert.equal(seats.length,deskCount+roomCount*2,'The runtime discovers every task chair and two visitor chairs per nook.');
  for(const seat of seats)assert.ok(walk.open(seat.approach),JSON.stringify(plan.options)+': '+seat.id+' runtime approach must clear padded furniture');
  for(const station of plan.workstations){const seat=seats.find(seat=>seat.id===station.chairId);assert.ok(seat,station.id+' needs a resolvable seat');near(seat.x,station.seat.x,'Runtime seat center X');near(seat.z,station.seat.z,'Runtime seat center Z');near(Math.sin(seat.yaw),Math.sin(station.facing),'Runtime facing X');near(Math.cos(seat.yaw),Math.cos(station.facing),'Runtime facing Z');assert.ok(walk.open(seat.approach),station.id+' runtime approach must clear padded furniture');assert.ok(walk.clear(station.approach,seat.approach),station.id+' runtime approach must connect to its planned approach');}
  checkConnected(plan,seats.map(seat=>({id:seat.id+' runtime approach',point:seat.approach})));
 }
});

test('curated studios use real generator geometry with honest names and distinct spatial arrangements',()=>{
 assert.ok(OFFICE_GENERATOR_PRESETS.length>=3);assert.equal(new Set(OFFICE_GENERATOR_PRESETS.map(p=>p.id)).size,OFFICE_GENERATOR_PRESETS.length);assert.equal(new Set(OFFICE_GENERATOR_PRESETS.map(p=>p.options.style)).size,3);
 for(const definition of OFFICE_GENERATOR_PRESETS){const plan=generateOffice(definition.options);checkGeometry(plan);checkConnected(plan);assert.ok(definition.name.length>5);assert.equal(plan.summary.deskCount,definition.options.deskCount);}
 const courtyard=generateOffice(DEFAULT),gallery=generateOffice({...DEFAULT,style:'gallery'}),neighborhoods=generateOffice({...DEFAULT,style:'neighborhoods'});
 assert.ok(courtyard.zones.some(zone=>zone.name==='Canopy court'&&zone.kind==='commons'));assert.ok(gallery.floor.width>gallery.floor.depth);assert.notDeepEqual(gallery.floor,courtyard.floor);assert.notDeepEqual(neighborhoods.layout,courtyard.layout);
 assert.ok(gallery.aisles.some(aisle=>aisle.id.includes('-aisle-h-')&&aisle.bounds.depth>=2),'Gallery reserves a broader horizontal promenade.');
});

test('small courtyard requests avoid a compulsory empty central bay and oversized three-by-three grid',()=>{
 const small=generateOffice({...DEFAULT,deskCount:12,roomCount:2});assert.deepEqual(small.floor,{width:16.5,depth:16.1});assert.equal(small.workstations.length,12);assert.equal(small.spatialRooms.length,2);assert.equal(small.zones.some(zone=>zone.name==='Canopy court'),false);assert.match(small.description,/compact airy studio/);assert.ok(small.summary.areaM2<300);checkGeometry(small);checkConnected(small);
 const larger=generateOffice(DEFAULT);assert.ok(larger.zones.some(zone=>zone.name==='Canopy court'));assert.match(larger.description,/an airy courtyard studio/);
});

test('maximum requests retain exact required furniture and explicitly disclose optional omissions and room scope',()=>{
 for(const style of STYLES){const plan=generateOffice({...DEFAULT,deskCount:60,roomCount:8,style});assert.equal(plan.layout.length,180);assert.equal(plan.workstations.length,60);assert.equal(plan.spatialRooms.length,8);assert.ok(plan.warnings.some(message=>message.includes('optional')));assert.ok(plan.warnings.some(message=>message.includes('do not create audio rooms')));assert.equal(plan.summary.areaM2,Math.round(plan.floor.width*plan.floor.depth*1e8)/1e8);}
 const small=generateOffice({...DEFAULT,deskCount:1,roomCount:0});assert.equal(small.warnings.some(message=>message.includes('omitted')),false);assert.equal(small.warnings.some(message=>message.includes('audio rooms')),false);
});
