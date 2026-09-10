/** Shared floor geometry. This module is safe to import into the browser. */
export type FloorSize = { width:number; depth:number };
export const DEFAULT_FLOOR:Readonly<FloorSize> = Object.freeze({width:20,depth:16});
export const MIN_FLOOR_SIZE = 8;
export const MAX_FLOOR_SIZE = 40;
export const MAX_LAYOUT_ITEMS = 180;
export const LAYOUT_ROTATIONS = [0,90,180,270] as const;
export const LAYOUT_TYPES = ['desk','meeting','focus','lounge','plant','asset'] as const;
export type LayoutItem = {
  id:string; type:typeof LAYOUT_TYPES[number];
  /** Axis-aligned footprint as percentages of the floor, including rotation. */
  x:number; y:number; w:number; h:number; label:string;
  rotation?:typeof LAYOUT_ROTATIONS[number];
  /** Catalog reference for licensed library objects; never a path or URL. */
  assetId?:string;
};
export type FloorPlanDocument = { version:1; items:LayoutItem[]; floor:FloorSize; revision:number };

/** Decode existing storage without silently replacing an unsupported document. */
export function readFloorPlan(value:unknown):FloorPlanDocument {
  if(Array.isArray(value))return {version:1,items:value as LayoutItem[],floor:{...DEFAULT_FLOOR},revision:0};
  if(!value||typeof value!=='object')throw new TypeError('Invalid stored floor plan.');
  const document=value as Partial<FloorPlanDocument>,floor=document.floor;
  if(document.version!==1||!Array.isArray(document.items)||!floor||
    !Number.isFinite(floor.width)||!Number.isFinite(floor.depth)||
    floor.width<MIN_FLOOR_SIZE||floor.width>MAX_FLOOR_SIZE||floor.depth<MIN_FLOOR_SIZE||floor.depth>MAX_FLOOR_SIZE||
    !Number.isSafeInteger(document.revision)||document.revision!<0)throw new TypeError('Invalid stored floor plan.');
  return {version:1,items:document.items,floor:{width:floor.width,depth:floor.depth},revision:document.revision!};
}
