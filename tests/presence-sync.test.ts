import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePresence} from '../src/lib/presence-sync';
import type {Presence} from '../src/lib/client';
const row=(userId:string,time:number,extra:Partial<Presence>={}):Presence=>({userId,name:userId,avatarColor:'#123456',avatarId:null,roomId:null,x:0,z:0,status:'available',updatedAt:new Date(time).toISOString(),seatId:null,...extra});

test('a late seat acknowledgement cannot overwrite own pending movement while remote peers still advance',()=>{
 const previous=[row('self',1000),row('peer',1000)],incoming=[row('self',3000,{seatId:'chair'}),row('peer',3000,{x:4})];
 for(const newest of [false,true]){const protectedRows=mergePresence(previous,incoming,newest,'self');assert.equal(protectedRows[0].seatId,null);assert.equal(protectedRows[1].x,4);}
 assert.equal(mergePresence(previous,incoming,true)[0].seatId,'chair');
});
test('protected stale acknowledgements cannot add own synthetic roster entries or resurrect removed peers',()=>{
 const previous=[row('peer',3000)],incoming=[row('self',4000,{seatId:'chair'}),row('peer',4000),row('removed',4000)];
 assert.equal(mergePresence(previous,incoming,true,'self').some(row=>row.userId==='self'),false);
 assert.deepEqual(mergePresence(previous,incoming,false,'self').map(row=>row.userId),['peer']);
});
