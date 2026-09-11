import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICE_SEATING,getOfficeSeats,resolveOfficeSeat} from '../src/lib/office-seating';
import {getOfficeAsset} from '../src/lib/office-catalog';
import {OFFICE_50_PRESET} from '../src/lib/office-presets';
import type {LayoutItem} from '../src/lib/floor-plan';
import {presenceInput} from '../src/lib/model';

test('seats use calibrated task-chair geometry and all fifty workstation chairs resolve',()=>{
 const seats=getOfficeSeats(OFFICE_50_PRESET.layout,OFFICE_50_PRESET.floor);
 assert.equal(seats.length,50);
 for(const station of OFFICE_50_PRESET.workstations){const seat=seats.find(seat=>seat.id===station.chairId)!;assert(seat);assert(Math.abs(seat.x-station.seat.x)<.000001);assert(Math.abs(seat.z-station.seat.z)<.000001);assert(Math.abs(Math.cos(seat.yaw)-Math.cos(station.facing))<.000001);assert(seat.seatHeight>=.53-.000001&&seat.seatHeight<=.63+.000001);}
 assert.deepEqual(Object.keys(OFFICE_SEATING).sort(),['office-chair-001','office-chair-006','office-chair-009','office-chair-012']);
});
test('seat rotation, uniform scale and floor boundaries produce authoritative transforms',()=>{
 const asset=getOfficeAsset('office-chair-001')!,floor={width:20,depth:16};
 const item:LayoutItem={id:'calibrated-chair',type:'asset',assetId:asset.id,label:'Chair',x:45,y:45,w:asset.depth*1.2/floor.width*100,h:asset.width*1.2/floor.depth*100,rotation:90};
 const seat=resolveOfficeSeat(item,floor)!;assert(seat);assert(Math.abs(seat.seatHeight-.62)<.000001);assert.equal(seat.yaw,-Math.PI/2);assert(seat.approach.x>seat.x);assert(Math.abs(seat.approach.z-seat.z)<.000001);
 for(const rotation of [0,90,180,270] as const){const rotated=resolveOfficeSeat({...item,rotation},floor)!;assert(rotated);assert(Math.abs(rotated.yaw+rotation*Math.PI/180)<.000001);const direction={x:-Math.sin(rotation*Math.PI/180),z:Math.cos(rotation*Math.PI/180)};assert((rotated.x-rotated.approach.x)*direction.x+(rotated.z-rotated.approach.z)*direction.z>0);}
 assert.equal(resolveOfficeSeat({...item,assetId:'office-chair-004'},floor),null);
 assert.equal(resolveOfficeSeat({...item,type:'desk',assetId:undefined},floor),null);
 assert.equal(resolveOfficeSeat({...item,x:0,rotation:270},floor),null);
 assert.equal(resolveOfficeSeat({...item,w:50,h:50},floor),null);
});
test('interaction input accepts legacy heartbeats and rejects untrusted event data',()=>{
 const heartbeat={roomId:null,x:0,z:0,status:'available'};
 assert(presenceInput.safeParse(heartbeat).success);
 for(const value of ['wave','dance'])assert(presenceInput.safeParse({...heartbeat,interaction:{type:'emote',value}}).success);
 for(const interaction of [{type:'emote',value:'<script>'},{type:'reaction',value:'❤️'},{type:'reaction',value:'heart',id:'client-id'},{type:'emote',value:'wave',expiresAt:'2099-01-01'},{type:'run',value:'fast'}])assert.equal(presenceInput.safeParse({...heartbeat,interaction}).success,false);
 assert.equal(presenceInput.safeParse({...heartbeat,seat:{x:0,z:0}}).success,false);
});
