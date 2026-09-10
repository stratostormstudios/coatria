import type {FloorSize,LayoutItem} from './floor-plan';
import {getOfficeAsset} from './office-catalog';

/** Furniture geometry is public metadata; models remain in authenticated assets. */
export type OfficePoint={x:number;z:number};
export type OfficeBounds={x:number;y:number;width:number;depth:number};
export type OfficeWorkstation={id:string;label:string;zoneId:string;deskId:string;chairId:string;approach:OfficePoint;seat:OfficePoint;/** Radians, +Z forward, matching the scene character convention. */facing:number};
export type OfficeZone={id:string;name:string;kind:'team'|'meeting'|'lounge'|'commons';capacity:number;bounds:OfficeBounds;meetingPoint:OfficePoint};
export type OfficePreset={id:string;name:string;description:string;floor:FloorSize;layout:LayoutItem[];workstations:OfficeWorkstation[];zones:OfficeZone[];spawn:OfficePoint;aisles:{id:string;bounds:OfficeBounds}[]};

const floor:FloorSize={width:30,depth:20};
const world=(x:number,y:number):OfficePoint=>({x:x-floor.width/2,z:y-floor.depth/2});

function makeOffice50():OfficePreset{
 const layout:LayoutItem[]=[],workstations:OfficeWorkstation[]=[],zones:OfficeZone[]=[];
 function add(assetId:string,id:string,label:string,x:number,y:number,rotation:0|90|180|270=0,footprint?:{width:number;depth:number}){
  const asset=getOfficeAsset(assetId);if(!asset)throw new Error('Unknown office preset furniture: '+assetId);
  if(footprint&&asset.resize!=='footprint')throw new Error('Preset furniture must keep authored proportions: '+assetId);
  const original=footprint||asset,swapped=rotation%180!==0,width=swapped?original.depth:original.width,depth=swapped?original.width:original.depth;
  const item:LayoutItem={id,type:'asset',assetId,label,rotation,x:(x-width/2)/floor.width*100,y:(y-depth/2)/floor.depth*100,w:width/floor.width*100,h:depth/floor.depth*100};layout.push(item);return item;
 }
 function finish(id:string,name:string,bounds:OfficeBounds,assetId='office-floor-018'){add(assetId,id,name,bounds.x+bounds.width/2,bounds.y+bounds.depth/2,0,{width:bounds.width,depth:bounds.depth});}
 const teams=[
  {id:'atelier',name:'Atelier',x:2.2,y:0,desk:'office-desk-001',chair:'office-chair-001'},
  {id:'studio',name:'Studio',x:11.8,y:0,desk:'office-desk-010',chair:'office-chair-009'},
  {id:'product',name:'Product',x:21.3,y:0,desk:'office-desk-016',chair:'office-chair-001'},
  {id:'engineering',name:'Engineering',x:2.2,y:7,desk:'office-desk-040',chair:'office-chair-012'},
  {id:'operations',name:'Operations',x:11.8,y:7,desk:'office-desk-017',chair:'office-chair-009'},
 ];
 for(const [teamIndex,team] of teams.entries()){
  const bounds={x:team.x-1.08,y:team.y+1.45,width:8.6,depth:4.05};
  zones.push({id:team.id,name:team.name,kind:'team',capacity:10,bounds,meetingPoint:world(team.x+3.22,team.y+5.8)});
  finish('office50-'+team.id+'-finish',team.name+' floor',bounds,teamIndex%2?'office-floor-020':'office-floor-018');
  for(let row=0;row<2;row++)for(let column=0;column<5;column++){
   const number=teamIndex*10+row*5+column+1,id='station-'+String(number).padStart(2,'0'),label='Workstation '+String(number).padStart(2,'0');
   const x=team.x+column*1.61,deskY=team.y+(row?3.85:3),chairY=team.y+(row?4.85:2),deskId='office50-'+id+'-desk',chairId='office50-'+id+'-chair';
   add(team.desk,deskId,label+' desk',x,deskY,row?0:180);add(team.chair,chairId,label+' chair',x,chairY,row?180:0);
   workstations.push({id,label,zoneId:team.id,deskId,chairId,approach:world(x,team.y+(row?5.8:1.05)),seat:world(x,chairY),facing:row?Math.PI:0});
  }
 }

 // The sixth team-sized bay is an open project lounge. Low dividers define it
 // without closing the cross aisles or implying a separate audio permission.
 const project={x:20.5,y:7.15,width:8.5,depth:5.75};
 zones.push({id:'project-lounge',name:'Project lounge',kind:'meeting',capacity:8,bounds:project,meetingPoint:world(21,10)});
 finish('office50-project-finish','Project lounge floor',project,'office-floor-014');
 add('office-sofa-001','office50-project-sofa-n','Project lounge north sofa',24.8,8.1);
 add('office-sofa-005','office50-project-sofa-s','Project lounge south sofa',24.8,11.9,180);
 add('office-armchair-008','office50-project-chair-w','Project lounge west armchair',22,9.9,270);
 add('office-armchair-008','office50-project-chair-e','Project lounge east armchair',27.5,9.9,90);
 add('office-coffee-table-014','office50-project-table-w','Project lounge west table',24,10);
 add('office-coffee-table-014','office50-project-table-e','Project lounge east table',25.6,10);
 add('office-partitions-055','office50-project-divider-n','Project lounge north low divider',24.8,7.2,0,{width:6,depth:.079304});
 add('office-partitions-055','office50-project-divider-s','Project lounge south low divider',24.8,12.8,0,{width:6,depth:.079304});
 add('office-plant-002','office50-project-plant-n','Project lounge north planter',28.5,8.1);
 add('office-plant-022','office50-project-plant-s','Project lounge south planter',28.5,11.9);
 add('office-shelf-030','office50-project-storage','Project lounge storage',21.2,12);

 const welcome={x:1.1,y:14.8,width:8.6,depth:4.7};
 zones.push({id:'welcome-lounge',name:'Welcome lounge',kind:'lounge',capacity:6,bounds:welcome,meetingPoint:world(7.2,16.9)});
 finish('office50-welcome-finish','Welcome lounge floor',welcome);
 add('office-sofa-013','office50-welcome-sofa-n','Welcome lounge north sofa',3.7,15.4);
 add('office-sofa-013','office50-welcome-sofa-s','Welcome lounge south sofa',3.7,18.4,180);
 add('office-armchair-001','office50-welcome-chair','Welcome lounge armchair',6.2,16.9,90);
 add('office-coffee-table-007','office50-welcome-table','Welcome lounge table',3.7,16.9);
 add('office-plant-002','office50-welcome-plant-n','Welcome lounge north planter',1.7,15.3);
 add('office-plant-022','office50-welcome-plant-s','Welcome lounge south planter',1.7,18.7);
 add('office-lamp-floor-007','office50-welcome-lamp','Welcome lounge reading lamp',5.5,18.7);
 add('office-shelf-031','office50-welcome-storage-n','Welcome lounge shared cabinet',8.4,15.3);
 add('office-shelf-031','office50-welcome-storage-s','Welcome lounge shared library',8.4,18.7);

 const commons={x:11,y:14.8,width:8,depth:4.7};
 zones.push({id:'commons',name:'The commons',kind:'commons',capacity:4,bounds:commons,meetingPoint:world(15,16.8)});
 finish('office50-commons-finish','Commons floor',commons,'office-floor-020');
 for(const [side,x] of [['west',12.5],['east',17.5]] as const){
  add('office-armchair-008','office50-commons-'+side+'-chair-n','Commons '+side+' north chair',x,15.5);
  add('office-armchair-008','office50-commons-'+side+'-chair-s','Commons '+side+' south chair',x,18,180);
  add('office-coffee-table-003','office50-commons-'+side+'-table','Commons '+side+' side table',x,16.75);
 }
 add('office-shelf-031','office50-commons-storage-w','Commons west shared cabinet',12,19.4);
 add('office-shelf-031','office50-commons-storage-e','Commons east shared cabinet',18,19.4);
 add('office-shelf-030','office50-commons-storage-n','Commons information shelf',18.5,14.9);
 add('office-plant-022','office50-commons-plant-w','Commons west planter',11.5,17);
 add('office-plant-022','office50-commons-plant-e','Commons east planter',18.7,17);

 const quiet={x:20.5,y:14.8,width:8.5,depth:4.7};
 zones.push({id:'quiet-lounge',name:'Quiet lounge',kind:'lounge',capacity:5,bounds:quiet,meetingPoint:world(24.8,15.1)});
 finish('office50-quiet-finish','Quiet lounge floor',quiet,'office-floor-014');
 add('office-sofa-001','office50-quiet-sofa','Quiet lounge sofa',24.8,18.2,180);
 add('office-armchair-008','office50-quiet-chair-w','Quiet lounge west armchair',22.8,15.9);
 add('office-armchair-008','office50-quiet-chair-e','Quiet lounge east armchair',26.8,15.9);
 add('office-coffee-table-014','office50-quiet-table','Quiet lounge table',24.8,16.8);
 add('office-plant-002','office50-quiet-plant-w','Quiet lounge west planter',21.2,18.5);
 add('office-plant-022','office50-quiet-plant-e','Quiet lounge east planter',28.5,15.2);
 add('office-lamp-floor-007','office50-quiet-lamp','Quiet lounge reading lamp',26.5,18.7);
 add('office-shelf-031','office50-quiet-storage','Quiet lounge shared cabinet',28.1,18.7);

 return {id:'office-50',name:'The 50-person studio',description:'Five team neighborhoods, 50 furnished workstations, an open project lounge and three shared commons.',floor:{...floor},layout,workstations,zones,spawn:world(15,18.8),aisles:[
  {id:'north-walkway',bounds:{x:.5,y:.5,width:29,depth:.8}},
  {id:'north-cross-aisle',bounds:{x:.5,y:5.55,width:29,depth:1.25}},
  {id:'middle-walkway',bounds:{x:.5,y:7.5,width:19.6,depth:.8}},
  {id:'south-cross-aisle',bounds:{x:.65,y:13.25,width:28.7,depth:1.1}},
  {id:'west-spine',bounds:{x:9.75,y:.45,width:.95,depth:18.9}},
  {id:'east-spine',bounds:{x:19.35,y:.45,width:.75,depth:18.9}},
  {id:'entry',bounds:{x:14.1,y:14.35,width:1.8,depth:5.1}},
 ]};
}

/** This is a physical furniture preset, not a roster or an assignment record. */
export const OFFICE_50_PRESET:OfficePreset=makeOffice50();
