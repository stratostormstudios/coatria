import test from 'node:test';
import assert from 'node:assert/strict';
import {editorPlan,floorMaximum,metres,moveItem,newItem,place,resizeFloor,resizeItem,rotateItem,type Edge} from '../src/lib/floor-editor';
import {layoutInput} from '../src/lib/model';

const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<.001,`${actual} should equal ${expected}`);
test('palette placement, movement and every resize edge produce bounded valid geometry',()=>{
 for(const floor of [{width:8,depth:8},{width:40,depth:40},{width:8,depth:40},{width:37.7,depth:13.3}]){
  const plan=editorPlan([],floor),item=newItem('desk',plan,'desk',{x:floor.width-.1,y:floor.depth-.1});
  for(const delta of [-200,-5,.01,3,200]){
   const values=[moveItem(item,floor,delta,delta,true),...(['n','ne','e','se','s','sw','w','nw'] as Edge[]).map(edge=>resizeItem(item,floor,edge,delta,delta,false))];
   for(const geometry of values){assert.ok(layoutInput.safeParse({layout:[geometry],floor,revision:0}).success,JSON.stringify(geometry));const r=metres(geometry,floor);assert.ok(r.w>=.4999&&r.h>=.4999);}
  }
 }
});
test('floor expansion preserves furniture dimensions and top-left distances across repeated changes',()=>{
 let plan=editorPlan([]),item=newItem('desk',plan,'desk',{x:7,y:8},false);plan.layout.push(item);const original=metres(item,plan.floor);
 for(const floor of [{width:40,depth:40},{width:19.3,depth:17.7},{width:30,depth:20},{width:20,depth:16}]){
  plan=resizeFloor(plan,floor);const r=metres(plan.layout[0],plan.floor);for(const key of ['x','y','w','h'] as const)close(r[key],original[key]);
 }
 const small=resizeFloor(plan,{width:8,depth:8}),r=metres(small.layout[0],small.floor);assert.ok(small.floor.depth>=r.y+r.h-.001);close(r.w,original.w);close(r.y,original.y);
});
test('resize from west and north anchors the opposite edges and quarter-turns preserve dimensions',()=>{
 const plan=editorPlan([]),item=place(newItem('desk',plan,'desk'),{x:4,y:4,w:6,h:3},plan.floor),r=metres(item,plan.floor);
 const changed=metres(resizeItem(item,plan.floor,'nw',-2,-1,false),plan.floor);close(changed.x+changed.w,r.x+r.w);close(changed.y+changed.h,r.y+r.h);
 let rotated=item;for(let index=0;index<4;index++)rotated=rotateItem(rotated,plan.floor);assert.equal(rotated.rotation,0);const final=metres(rotated,plan.floor);for(const key of ['x','y','w','h'] as const)close(final[key],r[key]);
});
test('a quarter turn that cannot fit refuses instead of shrinking furniture',()=>{
 const plan=editorPlan([],{width:20,depth:8}),item=place(newItem('meeting',plan,'meeting'),{x:0,y:2,w:20,h:2},plan.floor);
 assert.equal(rotateItem(item,plan.floor),item);
});

test('moving, copying, rotating and floor resizing preserve small legacy furniture',()=>{
 const precise=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} should preserve ${expected}`);
 for(const percent of [.1,2]){
  const original={id:'legacy',type:'plant' as const,label:'Legacy plant',x:12.3456,y:24.321,w:percent,h:percent,rotation:0 as const};
  let plan=editorPlan([original],{width:20,depth:16});const before=metres(original,plan.floor);
  const moved=metres(moveItem(original,plan.floor,1,1,false),plan.floor);precise(moved.w,before.w);precise(moved.h,before.h);
  const duplicate=metres(place({...original,id:'copy'},{...before,x:before.x+.5,y:before.y+.5},plan.floor),plan.floor);precise(duplicate.w,before.w);precise(duplicate.h,before.h);
  for(const floor of [{width:40,depth:40},{width:8,depth:8},{width:19.123,depth:14.987},{width:20,depth:16}]){
   plan=resizeFloor(plan,floor);const after=metres(plan.layout[0],plan.floor);for(const key of ['x','y','w','h'] as const)precise(after[key],before[key]);
   assert.ok(layoutInput.safeParse({layout:plan.layout,floor:plan.floor,revision:0}).success,JSON.stringify(plan));
  }
  const rotated=rotateItem(original,{width:20,depth:16});
  if(percent===.1)assert.equal(rotated,original,'A turn below the destination-axis0.1% minimum is refused, not enlarged.');
  else{const after=metres(rotated,{width:20,depth:16});precise(after.w,before.h);precise(after.h,before.w);}
 }
});

test('floor enlargement caps each axis by content and preserves fractional cap dimensions',()=>{
 const legacy={id:'tiny',type:'plant' as const,label:'Small legacy plant',x:10,y:10,w:.1,h:.2};
 const plan=editorPlan([legacy],{width:20.1234567,depth:16});
 assert.deepEqual(floorMaximum(plan),{width:20.1234567,depth:32});
 const expanded=resizeFloor(plan,{width:40,depth:40});assert.deepEqual(expanded.floor,{width:20.1234567,depth:32});
 const depthOnly=resizeFloor(plan,{width:plan.floor.width,depth:20});assert.equal(depthOnly.floor.width,plan.floor.width,'An unchanged axis keeps its existing fractional dimension.');
 for(const key of ['x','y','w','h'] as const)assert.ok(Math.abs(metres(expanded.layout[0],expanded.floor)[key]-metres(legacy,plan.floor)[key])<1e-10);
 assert.ok(layoutInput.safeParse({layout:expanded.layout,floor:expanded.floor,revision:0}).success);
 assert.deepEqual(floorMaximum(editorPlan([])),{width:40,depth:40});
});

test('resizing one legacy edge keeps the untouched tiny dimension',()=>{
 const floor={width:20,depth:16},item={id:'legacy',type:'plant' as const,label:'Legacy plant',x:20,y:20,w:.1,h:.1};
 const before=metres(item,floor),after=metres(resizeItem(item,floor,'e',1,0,false),floor);
 assert.ok(after.w>=.5);assert.ok(Math.abs(after.h-before.h)<1e-10);
});

test('full-precision placement remains inside strict API percentage boundaries',()=>{
 let seed=719;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const item={id:'edge',type:'plant' as const,label:'Boundary plant',x:0,y:0,w:.1,h:.1};
 for(let index=0;index<2000;index++){
  const floor={width:8+random()*32,depth:8+random()*32};
  const placed=place(item,{x:40*random(),y:40*random(),w:index%2?.001:40*random(),h:index%3?.001:40*random()},floor);
  assert.ok(layoutInput.safeParse({layout:[placed],floor,revision:0}).success,JSON.stringify(placed));
 }
});
