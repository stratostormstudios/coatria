import {DEFAULT_FLOOR,MIN_FLOOR_SIZE,MAX_FLOOR_SIZE,type FloorSize,type LayoutItem} from './floor-plan';

export type EditorPlan = {floor:FloorSize;layout:LayoutItem[]};
export type Rect = {x:number;y:number;w:number;h:number};
export type Edge = 'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw';
export const MIN_OBJECT_SIZE = .5;
/** Storage accepts legacy footprints as small as 0.1% on either axis. */
export const MIN_OBJECT_PERCENT = .1;
export const round = (n:number,places=4) => Math.round(n*10**places)/10**places;
export const clamp = (n:number,min:number,max:number) => Math.min(max,Math.max(min,n));
export const snap = (n:number,enabled:boolean) => enabled ? Math.round(n*2)/2 : round(n,2);
export const signature = (plan:EditorPlan) => JSON.stringify(plan);
export function editorPlan(layout:LayoutItem[]=[],floor:FloorSize=DEFAULT_FLOOR):EditorPlan {
  return {floor:{...floor},layout:layout.map(item=>({...item,rotation:item.rotation||0}))};
}
export function metres(item:LayoutItem,floor:FloorSize):Rect {
  return {x:item.x*floor.width/100,y:item.y*floor.depth/100,w:item.w*floor.width/100,h:item.h*floor.depth/100};
}
export function place(item:LayoutItem,rect:Rect,floor:FloorSize):LayoutItem {
  // Physical minimum sizes belong to deliberate resize operations. Applying
  // them here would enlarge legacy furniture during a move, copy, or floor edit.
  const w=clamp(rect.w*100/floor.width,MIN_OBJECT_PERCENT,100),h=clamp(rect.h*100/floor.depth,MIN_OBJECT_PERCENT,100);
  let x=clamp(rect.x*100/floor.width,0,100-w),y=clamp(rect.y*100/floor.depth,0,100-h);
  // Retain full precision through floor conversions. A final sub-pixel inward
  // adjustment handles floating-point addition at the strict API boundary.
  if(x+w>100)x=Math.max(0,x-100*Number.EPSILON);
  if(y+h>100)y=Math.max(0,y-100*Number.EPSILON);
  return {...item,x,y,w,h};
}
export function moveItem(item:LayoutItem,floor:FloorSize,dx:number,dy:number,snapping:boolean):LayoutItem {
  const r=metres(item,floor);return place(item,{...r,x:snap(r.x+dx,snapping),y:snap(r.y+dy,snapping)},floor);
}
export function resizeItem(item:LayoutItem,floor:FloorSize,edge:Edge,dx:number,dy:number,snapping:boolean):LayoutItem {
  const r=metres(item,floor);let left=r.x,top=r.y,right=r.x+r.w,bottom=r.y+r.h;
  if(edge.includes('w'))left=clamp(snap(left+dx,snapping),0,right-MIN_OBJECT_SIZE);
  if(edge.includes('e'))right=clamp(snap(right+dx,snapping),left+MIN_OBJECT_SIZE,floor.width);
  if(edge.includes('n'))top=clamp(snap(top+dy,snapping),0,bottom-MIN_OBJECT_SIZE);
  if(edge.includes('s'))bottom=clamp(snap(bottom+dy,snapping),top+MIN_OBJECT_SIZE,floor.depth);
  return place(item,{x:left,y:top,w:right-left,h:bottom-top},floor);
}
export function floorMinimum(plan:EditorPlan):FloorSize {
  return plan.layout.reduce((size,item)=>{const r=metres(item,plan.floor);return {width:Math.max(size.width,Math.min(plan.floor.width,r.x+r.w)),depth:Math.max(size.depth,Math.min(plan.floor.depth,r.y+r.h))};},{width:MIN_FLOOR_SIZE,depth:MIN_FLOOR_SIZE});
}
/** Largest floor that can retain every object without violating storage limits. */
export function floorMaximum(plan:EditorPlan):FloorSize {
  const maximum=plan.layout.reduce((size,item)=>{const r=metres(item,plan.floor);return {width:Math.min(size.width,r.w*100/MIN_OBJECT_PERCENT),depth:Math.min(size.depth,r.h*100/MIN_OBJECT_PERCENT)};},{width:MAX_FLOOR_SIZE,depth:MAX_FLOOR_SIZE});
  // A valid current floor must remain representable despite floating-point noise.
  return {width:Math.max(plan.floor.width,maximum.width),depth:Math.max(plan.floor.depth,maximum.depth)};
}
export function resizeFloor(plan:EditorPlan,requested:FloorSize):EditorPlan {
  const min=floorMinimum(plan),max=floorMaximum(plan),floor={width:requested.width===plan.floor.width?plan.floor.width:clamp(round(requested.width,3),min.width,max.width),depth:requested.depth===plan.floor.depth?plan.floor.depth:clamp(round(requested.depth,3),min.depth,max.depth)};
  return {floor,layout:plan.layout.map(item=>place(item,metres(item,plan.floor),floor))};
}
export function rotateItem(item:LayoutItem,floor:FloorSize):LayoutItem {
  const r=metres(item,floor),rotation=((item.rotation||0)+90)%360 as LayoutItem['rotation'];
  if(r.h>floor.width||r.w>floor.depth||r.h*100/floor.width<MIN_OBJECT_PERCENT||r.w*100/floor.depth<MIN_OBJECT_PERCENT)return item;
  // Quarter turns keep the centre and swap the axis-aligned footprint.
  return place({...item,rotation},{x:r.x+(r.w-r.h)/2,y:r.y+(r.h-r.w)/2,w:r.h,h:r.w},floor);
}
export const furniture = [
  {type:'desk',name:'Workstation',description:'Desk + task chair',w:2.8,h:2.2},
  {type:'meeting',name:'Meeting space',description:'Gather around a table',w:5.5,h:4.5},
  {type:'focus',name:'Focus space',description:'Room for deep work',w:3,h:3},
  {type:'lounge',name:'Lounge',description:'A softer place to meet',w:4.5,h:3},
  {type:'plant',name:'Plant',description:'A little room to grow',w:1,h:1},
] as const;
export function newItem(type:LayoutItem['type'],plan:EditorPlan,id:string,point?:{x:number;y:number},snapping=true):LayoutItem {
  const definition=furniture.find(item=>item.type===type)!;
  let count=1;const labels=new Set(plan.layout.map(item=>item.label.toLowerCase()));
  while(labels.has((definition.name+' '+String(count).padStart(2,'0')).toLowerCase()))count++;
  const item:LayoutItem={id,type,label:definition.name+' '+String(count).padStart(2,'0'),x:0,y:0,w:1,h:1,rotation:0};
  const centre=point||{x:plan.floor.width/2,y:plan.floor.depth/2};
  return place(item,{x:snap(centre.x-definition.w/2,snapping),y:snap(centre.y-definition.h/2,snapping),w:definition.w,h:definition.h},plan.floor);
}
