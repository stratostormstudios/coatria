import {MAX_FLOOR_SIZE,MAX_LAYOUT_ITEMS,MIN_FLOOR_SIZE,type FloorSize,type LayoutItem} from './floor-plan';
import {getOfficeAsset} from './office-catalog';
import type {OfficeBounds,OfficePoint,OfficePreset,OfficeWorkstation,OfficeZone} from './office-presets';

export type OfficeStyle='courtyard'|'neighborhoods'|'gallery';
export type OfficeSpaciousness='balanced'|'airy';
export type OfficeGeneratorOptions={deskCount:number;roomCount:number;style:OfficeStyle;spaciousness:OfficeSpaciousness;seed:string|number};
export type GeneratedOffice=OfficePreset&{
 options:OfficeGeneratorOptions;
 summary:{deskCount:number;roomCount:number;objectCount:number;areaM2:number;uniqueAssets:number;/** Narrowest declared clear band, including the perimeter. */clearAisleWidthM:number;/** Inter-bay clear band, after the renderer's furniture padding. */mainAisleWidthM:number};
 warnings:string[];
 /** Spatial furniture zones, not audio rooms or permission boundaries. */
 spatialRooms:{zoneId:string;entry:OfficePoint;entryWidthM:number;partitionIds:string[]}[];
};
export class OfficeGenerationError extends Error{
 readonly code:'INVALID_OPTIONS'|'CAPACITY_EXCEEDED'|'FLOOR_TOO_LARGE';
 readonly issues:{field:string;message:string}[];
 constructor(code:OfficeGenerationError['code'],issues:OfficeGenerationError['issues']){
  super(issues.map(issue=>issue.message).join(' '));this.name='OfficeGenerationError';this.code=code;this.issues=issues;
 }
}

export const OFFICE_GENERATOR_PRESETS:readonly {id:string;name:string;description:string;options:OfficeGeneratorOptions}[]=[
 {id:'canopy-court',name:'Canopy Court',description:'Four team bays around a planted social courtyard, with three open meeting nooks.',options:{deskCount:24,roomCount:3,style:'courtyard',spaciousness:'airy',seed:'canopy-court'}},
 {id:'makers-quarter',name:'Makers’ Quarter',description:'Six connected team neighborhoods, shared lounges and four meeting nooks.',options:{deskCount:36,roomCount:4,style:'neighborhoods',spaciousness:'airy',seed:'makers-quarter'}},
 {id:'northlight-gallery',name:'Northlight Gallery',description:'An elongated creative studio with a broad promenade and two meeting nooks.',options:{deskCount:18,roomCount:2,style:'gallery',spaciousness:'airy',seed:'northlight-gallery'}},
 {id:'pocket-studio',name:'Pocket Studio',description:'A smaller six-person studio with one open meeting nook and connected standing approaches.',options:{deskCount:6,roomCount:1,style:'neighborhoods',spaciousness:'balanced',seed:'pocket-studio'}},
];

type Rotation=0|90|180|270;
type Cell={column:number;row:number;x:number;y:number;rank:number};
const CELL_WIDTH=5.8,CELL_DEPTH=5.6,PERIMETER=1.5;
const STYLE_NAMES:Record<OfficeStyle,string>={courtyard:'Courtyard studio',neighborhoods:'Neighborhood studio',gallery:'Gallery studio'};
const TEAM_NAMES=['Atelier','Product','Northlight','Workshop','Studio','Orchard','Foundry','Library','Terrace','Assembly'];
const ROOM_NAMES=['Cedar','Juniper','Willow','Birch','Alder','Maple','Hazel','Olive'];
const DESKS=['office-desk-001','office-desk-010','office-desk-016','office-desk-017','office-desk-040','office-desk-003','office-desk-035'];
const CHAIRS=['office-chair-001','office-chair-009','office-chair-012'];
const FINISHES=['office-floor-018','office-floor-020','office-floor-014','office-floor-004'];
const round=(value:number)=>Math.round(value*1e8)/1e8;

function validate(value:OfficeGeneratorOptions):OfficeGeneratorOptions{
 const options=value as OfficeGeneratorOptions|undefined,issues:OfficeGenerationError['issues']=[];
 if(!options||typeof options!=='object'||Array.isArray(options))throw new OfficeGenerationError('INVALID_OPTIONS',[{field:'options',message:'Choose the number of desks, meeting nooks, layout style, spaciousness and a seed.'}]);
 if(!Number.isInteger(options.deskCount)||options.deskCount<1||options.deskCount>60)issues.push({field:'deskCount',message:'Choose a whole number of desks from 1 to 60.'});
 if(!Number.isInteger(options.roomCount)||options.roomCount<0||options.roomCount>8)issues.push({field:'roomCount',message:'Choose a whole number of meeting nooks from 0 to 8.'});
 if(!['courtyard','neighborhoods','gallery'].includes(options.style))issues.push({field:'style',message:'Choose courtyard, neighborhoods or gallery as the layout style.'});
 if(!['balanced','airy'].includes(options.spaciousness))issues.push({field:'spaciousness',message:'Choose balanced or airy spacing.'});
 if(!((typeof options.seed==='string'&&options.seed.trim().length>0&&options.seed.length<=64)||(typeof options.seed==='number'&&Number.isSafeInteger(options.seed))))issues.push({field:'seed',message:'Use a non-empty seed of up to 64 characters or a safe whole number.'});
 if(issues.length)throw new OfficeGenerationError('INVALID_OPTIONS',issues);
 return {deskCount:options.deskCount,roomCount:options.roomCount,style:options.style,spaciousness:options.spaciousness,seed:options.seed};
}

function hash(text:string){let value=2166136261;for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);return value>>>0;}
function random(seed:number){return ()=>{seed=(seed+0x6D2B79F5)|0;let value=Math.imul(seed^(seed>>>15),1|seed);value^=value+Math.imul(value^(value>>>7),61|value);return ((value^(value>>>14))>>>0)/4294967296;};}
function shuffle<T>(items:readonly T[],next:()=>number){const result=[...items];for(let i=result.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}

/** Pure, deterministic geometry. No asset requests, room creation or server writes. */
export function generateOffice(input:OfficeGeneratorOptions):GeneratedOffice{
 const options=validate(input),requiredObjects=options.deskCount*2+options.roomCount*7;
 if(requiredObjects>MAX_LAYOUT_ITEMS)throw new OfficeGenerationError('CAPACITY_EXCEEDED',[{field:'deskCount',message:`The requested desks and meeting nooks need ${requiredObjects} objects; the shared floor supports ${MAX_LAYOUT_ITEMS}. Reduce the desk or meeting-nook count.`}]);
 const signature=JSON.stringify(options),seed=hash(signature),next=random(seed),id='generated-'+seed.toString(36);
 const gap=options.spaciousness==='airy'?1.9:1.5,pitch=options.spaciousness==='airy'?1.9:1.72;
 const bays=Math.ceil(options.deskCount/6),modules=bays+options.roomCount;
 // Reserve a furnished common space on medium and large plans. Small plans
 // remain compact, using any spare grid bay as their shared space instead.
 const reserve=modules>=(options.style==='courtyard'?6:4)?1:0,needed=modules+reserve;
 const targetRatio=options.style==='gallery'?1.8:options.style==='courtyard'?1:1.3;
 const candidates:{columns:number;rows:number;floor:FloorSize;score:number;promenade:number}[]=[];
 for(let columns=1;columns<=5;columns++)for(let rows=1;rows<=5;rows++){
  if(columns*rows<needed)continue;
  if(reserve&&options.style==='courtyard'&&(columns<3||rows<3))continue;
  const promenade=options.style==='gallery'&&rows>1?1.2:0;
  const width=Math.max(MIN_FLOOR_SIZE,round(columns*CELL_WIDTH+(columns-1)*gap+PERIMETER*2));
  const depth=Math.max(MIN_FLOOR_SIZE,round(rows*CELL_DEPTH+(rows-1)*gap+PERIMETER*2+promenade));
  if(width>MAX_FLOOR_SIZE||depth>MAX_FLOOR_SIZE)continue;
  const score=(columns*rows-needed)*2.2+Math.abs(Math.log(width/depth/targetRatio))*7+width*depth*.001;
  candidates.push({columns,rows,floor:{width,depth},score,promenade});
 }
 const grid=candidates.sort((a,b)=>a.score-b.score||a.floor.width-b.floor.width)[0];
 if(!grid)throw new OfficeGenerationError('FLOOR_TOO_LARGE',[{field:'deskCount',message:'This layout cannot preserve its circulation within a 40 × 40 m floor. Reduce desks or meeting nooks, or choose balanced spacing.'}]);
 const {floor,columns,rows,promenade}=grid;
 const startX=(floor.width-(columns*CELL_WIDTH+(columns-1)*gap))/2;
 const startY=(floor.depth-(rows*CELL_DEPTH+(rows-1)*gap+promenade))/2;
 const promenadeRow=Math.max(1,Math.floor(rows/2));
 const cells:Cell[]=[];
 for(let row=0;row<rows;row++)for(let column=0;column<columns;column++)cells.push({column,row,x:startX+column*(CELL_WIDTH+gap),y:startY+row*(CELL_DEPTH+gap)+(row>=promenadeRow?promenade:0),rank:next()});
 const center={column:(columns-1)/2,row:(rows-1)/2};
 const distance=(cell:Cell)=>Math.abs(cell.column-center.column)+Math.abs(cell.row-center.row);
 const shared:Cell[]=reserve?[...cells].sort((a,b)=>distance(a)-distance(b)||a.rank-b.rank).slice(0,1):[];
 const available=cells.filter(cell=>!shared.includes(cell));
 // Rooms are peripheral, opening onto the common circulation network. Gallery
 // rooms face the long promenade; courtyard rooms face the planted centre.
 const roomCells=[...available].sort((a,b)=>options.style==='gallery'?a.row-b.row||a.rank-b.rank:distance(b)-distance(a)||a.rank-b.rank).slice(0,options.roomCount);
 const remaining=available.filter(cell=>!roomCells.includes(cell));
 const teamCells=[...remaining].sort((a,b)=>options.style==='gallery'?b.row-a.row||a.column-b.column:options.style==='neighborhoods'?a.row-b.row||a.column-b.column:a.rank-b.rank).slice(0,bays);
 shared.push(...remaining.filter(cell=>!teamCells.includes(cell)));
 const layout:LayoutItem[]=[],workstations:OfficeWorkstation[]=[],zones:OfficeZone[]=[],spatialRooms:GeneratedOffice['spatialRooms']=[],aisles:OfficePreset['aisles']=[];
 const world=(x:number,y:number):OfficePoint=>({x:round(x-floor.width/2),z:round(y-floor.depth/2)});
 function add(assetId:string,key:string,label:string,x:number,y:number,rotation:Rotation=0,footprint?:{width:number;depth:number}){
  const asset=getOfficeAsset(assetId);if(!asset)throw new Error('Missing generator catalog asset: '+assetId);
  if(footprint&&asset.resize!=='footprint')throw new Error('Generator cannot stretch uniform furniture: '+assetId);
  const dimensions=footprint||asset,swapped=rotation%180!==0,width=swapped?dimensions.depth:dimensions.width,depth=swapped?dimensions.width:dimensions.depth;
  const item:LayoutItem={id:id+'-'+key,type:'asset',assetId,label,rotation,x:(x-width/2)/floor.width*100,y:(y-depth/2)/floor.depth*100,w:width/floor.width*100,h:depth/floor.depth*100};
  layout.push(item);return item.id;
 }
 function finish(key:string,label:string,bounds:OfficeBounds,assetId:string){return add(assetId,key,label,bounds.x+bounds.width/2,bounds.y+bounds.depth/2,0,{width:bounds.width,depth:bounds.depth});}
 const desks=shuffle(DESKS,next),chairs=shuffle(CHAIRS,next),finishes=shuffle(FINISHES,next),teamNames=shuffle(TEAM_NAMES,next),roomNames=shuffle(ROOM_NAMES,next);
 let stationNumber=0;
 for(const [index,cell] of teamCells.entries()){
  const count=Math.floor(options.deskCount/bays)+(index<options.deskCount%bays?1:0),zoneId=id+'-team-'+(index+1),name=teamNames[index];
  const bounds={x:cell.x,y:cell.y,width:CELL_WIDTH,depth:CELL_DEPTH};
  zones.push({id:zoneId,name,kind:'team',capacity:count,bounds,meetingPoint:world(cell.x+CELL_WIDTH/2,cell.y+.45)});
  for(let row=0;row<2;row++){
   const rowCount=row?Math.floor(count/2):Math.ceil(count/2);
   for(let column=0;column<rowCount;column++){
    const number=String(++stationNumber).padStart(2,'0'),stationId=id+'-station-'+number,label='Workstation '+number;
    const x=cell.x+CELL_WIDTH/2+(column-(rowCount-1)/2)*pitch,deskY=cell.y+(row?3.3:2.45),chairY=cell.y+(row?4.3:1.45);
    const deskId=add(desks[index%desks.length],'station-'+number+'-desk',label+' desk',x,deskY,row?0:180);
    const chairId=add(chairs[index%chairs.length],'station-'+number+'-chair',label+' chair',x,chairY,row?180:0);
    workstations.push({id:stationId,label,zoneId,deskId,chairId,approach:world(x,cell.y+(row?5.3:.45)),seat:world(x,chairY),facing:row?Math.PI:0});
   }
  }
 }
 for(const [index,cell] of roomCells.entries()){
  // Leave a renderer-grid-width passage behind both visitor chairs, including
  // the shared seating helper's approach offset and 0.3 m collision padding.
  const width=5.4,depth=options.spaciousness==='airy'?4.8:4.6,cx=cell.x+CELL_WIDTH/2,cy=cell.y+CELL_DEPTH/2;
  const horizontal=Math.abs(cell.column-center.column)>Math.abs(cell.row-center.row);
  const rotation:Rotation=options.style==='gallery'?(cell.row<center.row?0:180):horizontal?(cell.column<center.column?270:90):(cell.row<center.row?0:180);
  const radians=rotation*Math.PI/180,transform=(x:number,y:number)=>({x:cx+x*Math.cos(radians)-y*Math.sin(radians),y:cy+x*Math.sin(radians)+y*Math.cos(radians)});
  function local(assetId:string,key:string,label:string,x:number,y:number,localRotation:Rotation=0,footprint?:{width:number;depth:number}){const p=transform(x,y);return add(assetId,'room-'+(index+1)+'-'+key,label,p.x,p.y,((localRotation+rotation)%360) as Rotation,footprint);}
  const zoneId=id+'-room-'+(index+1),name=roomNames[index]+' nook',panel=index%2?'office-partitions-055':'office-partitions-005',thickness=getOfficeAsset(panel)!.depth;
  const partitionIds=[local(panel,'back',name+' back divider',0,-depth/2+thickness/2,0,{width,depth:thickness}),local(panel,'left',name+' left divider',-width/2+thickness/2,thickness/2,90,{width:depth-thickness,depth:thickness}),local(panel,'right',name+' right divider',width/2-thickness/2,thickness/2,90,{width:depth-thickness,depth:thickness})];
  local('office-chair-006','chair-left',name+' left visitor chair',-1.16,-.1,270);
  local('office-chair-006','chair-right',name+' right visitor chair',1.16,-.1,90);
  local('office-coffee-table-014','table',name+' meeting table',0,-.1);
  local(finishes[index%finishes.length],'finish',name+' floor',0,0,0,{width,depth});
  const meeting=transform(0,depth/2-.65),entry=transform(0,depth/2+.4),swapped=rotation%180!==0;
  zones.push({id:zoneId,name,kind:'meeting',capacity:2,bounds:{x:cx-(swapped?depth:width)/2,y:cy-(swapped?width:depth)/2,width:swapped?depth:width,depth:swapped?width:depth},meetingPoint:world(meeting.x,meeting.y)});
  spatialRooms.push({zoneId,entry:world(entry.x,entry.y),entryWidthM:round(width-thickness*2),partitionIds});
 }

 let omittedDecorations=0;
 function optional(count:number,write:()=>void){if(layout.length+count<=MAX_LAYOUT_ITEMS)write();else omittedDecorations+=count;}
 // Shared furniture is kept out of the circulation bands. Required desk/chair
 // pairs and every nook are already placed before this optional budget is used.
 for(const [index,cell] of shared.entries()){
  const cx=cell.x+CELL_WIDTH/2,cy=cell.y+CELL_DEPTH/2,name=options.style==='courtyard'?(index===0?'Canopy court':'Garden lounge '+index):options.style==='gallery'?'Gallery lounge '+(index+1):'Neighborhood commons '+(index+1);
  if(layout.length+4>MAX_LAYOUT_ITEMS){omittedDecorations+=4;continue;}
  const bounds={x:cell.x+.2,y:cell.y+.2,width:CELL_WIDTH-.4,depth:CELL_DEPTH-.4},zoneId=id+'-commons-'+(index+1);
  finish('commons-'+index+'-finish',name+' floor',bounds,finishes[(index+1)%finishes.length]);
  add('office-sofa-001','commons-'+index+'-sofa',name+' sofa',cx,cy-1.65);
  add('office-coffee-table-007','commons-'+index+'-table',name+' table',cx,cy-.1);
  add('office-plant-022','commons-'+index+'-plant',name+' planter',cx+2,cy-1.65);
  zones.push({id:zoneId,name,kind:options.style==='courtyard'&&index===0?'commons':'lounge',capacity:3,bounds,meetingPoint:world(cx,cy+1.6)});
  optional(2,()=>{add('office-armchair-008','commons-'+index+'-chair',name+' reading chair',cx-1.7,cy+1,270);add('office-plant-002','commons-'+index+'-plant-west',name+' tall planter',cx-2,cy-1.65);});
 }
 for(const [index,cell] of teamCells.entries())optional(1,()=>finish('team-'+(index+1)+'-finish',teamNames[index]+' floor',{x:cell.x+.1,y:cell.y+1,width:CELL_WIDTH-.2,depth:CELL_DEPTH-1.6},finishes[index%finishes.length]));
 // Partial bays have a spare side pocket; full bays keep this space clear.
 for(const [index,cell] of teamCells.entries())if(zones[index].capacity<=4)optional(1,()=>add('office-plant-022','team-'+(index+1)+'-plant',teamNames[index]+' planter',cell.x+.4,cell.y+2.8));

 const verticalBands=[{x:.45,width:startX-.85},...Array.from({length:columns-1},(_,column)=>({x:startX+(column+1)*CELL_WIDTH+column*gap+.4,width:gap-.8})),{x:startX+columns*CELL_WIDTH+(columns-1)*gap+.4,width:floor.width-(startX+columns*CELL_WIDTH+(columns-1)*gap)-.85}];
 for(const [index,band] of verticalBands.entries())aisles.push({id:id+'-aisle-v-'+index,bounds:{...band,y:.45,depth:floor.depth-.9}});
 const horizontalBands=[{y:.45,depth:startY-.85},...Array.from({length:rows-1},(_,row)=>({y:startY+(row+1)*CELL_DEPTH+row*gap+(row+1>promenadeRow?promenade:0)+.4,depth:gap-.8+(row+1===promenadeRow?promenade:0)})),{y:startY+rows*CELL_DEPTH+(rows-1)*gap+promenade+.4,depth:floor.depth-(startY+rows*CELL_DEPTH+(rows-1)*gap+promenade)-.85}];
 for(const [index,band] of horizontalBands.entries())aisles.push({id:id+'-aisle-h-'+index,bounds:{...band,x:.45,width:floor.width-.9}});
 const warnings:string[]=[];
 if(options.roomCount)warnings.push('Meeting nooks are furnished spatial zones with open entries and low dividers. They do not create audio rooms or private access permissions.');
 if(omittedDecorations)warnings.push(`Some optional planting and shared furniture were omitted to stay within ${MAX_LAYOUT_ITEMS} objects. All ${options.deskCount} desk-and-chair pairs and ${options.roomCount} meeting nooks are included.`);
 if(options.spaciousness==='balanced')warnings.push('Balanced spacing uses narrower connecting aisles. Choose airy for more circulation space.');
 const compactCourtyard=options.style==='courtyard'&&!reserve;
 const name=compactCourtyard?'Compact courtyard studio':STYLE_NAMES[options.style];
 const arrangement=compactCourtyard?`a compact ${options.spaciousness} studio with connected team bays`:`${options.spaciousness==='airy'?'an':'a'} ${options.spaciousness} ${options.style} studio`;
 return {id,name,description:`${options.deskCount} workstations and ${options.roomCount} open meeting nooks, arranged as ${arrangement}.`,floor,layout,workstations,zones,spawn:world(floor.width/2,floor.depth-.8),aisles,options,spatialRooms,warnings,summary:{deskCount:workstations.length,roomCount:spatialRooms.length,objectCount:layout.length,areaM2:round(floor.width*floor.depth),uniqueAssets:new Set(layout.map(item=>item.assetId)).size,clearAisleWidthM:round(Math.min(...aisles.map(aisle=>Math.min(aisle.bounds.width,aisle.bounds.depth)))),mainAisleWidthM:round(gap-.8)}};
}
