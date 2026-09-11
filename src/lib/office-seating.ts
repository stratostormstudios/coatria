import type {FloorSize,LayoutItem} from './floor-plan';
import {getOfficeAsset} from './office-catalog';

/** Audited authored geometry only. This metadata contains no purchased asset data. */
export const OFFICE_SEATING:Readonly<Record<string,{seatHeight:number;forwardRotation:number}>>=Object.freeze({
 'office-chair-001':{seatHeight:.45,forwardRotation:0},
 'office-chair-009':{seatHeight:.55,forwardRotation:0},
 'office-chair-012':{seatHeight:.48,forwardRotation:0},
 'office-chair-006':{seatHeight:.45,forwardRotation:0}
});
export type OfficeSeat={id:string;x:number;z:number;yaw:number;seatHeight:number;approach:{x:number;z:number}};

export function resolveOfficeSeat(item:LayoutItem,floor:FloorSize):OfficeSeat|null{
 const definition=item.type==='asset'&&item.assetId?OFFICE_SEATING[item.assetId]:undefined;
 const asset=definition&&item.assetId?getOfficeAsset(item.assetId):undefined;
 if(!definition||!asset)return null;
 const rotation=item.rotation??0,swapped=rotation%180!==0;
 const width=item.w/100*floor.width,depth=item.h/100*floor.depth;
 const scale=Math.min(width/(swapped?asset.depth:asset.width),depth/(swapped?asset.width:asset.depth));
 const x=(item.x+item.w/2)/100*floor.width-floor.width/2,z=(item.y+item.h/2)/100*floor.depth-floor.depth/2;
 // Matches the asset renderer's clockwise layout rotation and raised floor slab.
 const yaw=-rotation*Math.PI/180+definition.forwardRotation,authoredSeatHeight=definition.seatHeight*scale;
 if(![x,z,yaw,authoredSeatHeight,scale].every(Number.isFinite)||scale<=0||authoredSeatHeight<.25||authoredSeatHeight>.8)return null;
 const seatHeight=.08+authoredSeatHeight;
 const distance=asset.depth*scale/2+.55;
 const approach={x:x-Math.sin(yaw)*distance,z:z-Math.cos(yaw)*distance};
 if(Math.abs(approach.x)>floor.width/2-.45||Math.abs(approach.z)>floor.depth/2-.45)return null;
 return {id:item.id,x,z,yaw,seatHeight,approach};
}
export function getOfficeSeats(layout:LayoutItem[],floor:FloorSize):OfficeSeat[]{return layout.flatMap(item=>{const seat=resolveOfficeSeat(item,floor);return seat?[seat]:[];});}
