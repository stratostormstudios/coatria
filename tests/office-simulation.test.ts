import test from 'node:test';
import assert from 'node:assert/strict';
import {simulationMembers,simulationPresence,readConnectionReport} from '../src/lib/office-simulation';
const viewer={id:'test-viewer',name:'Viewer',email:'viewer@example.invalid',roleTitle:'Designer',avatarColor:'#dbe5cf',avatarId:null};
test('simulation has 50 distinct identities, includes the viewer and caps its population',()=>{
 const members=simulationMembers(viewer,500);assert.equal(members.length,50);assert.equal(new Set(members.map(p=>p.userId)).size,50);assert.equal(members[0].userId,viewer.id);assert.ok(members.every(m=>m.email===''));assert.equal(simulationMembers(viewer,10).length,10);
});
test('disconnect scenario removes and restores the same test identities',()=>{
 const members=simulationMembers(viewer,50),before=simulationPresence(members,0,'reconnect'),during=simulationPresence(members,20,'reconnect'),after=simulationPresence(members,32,'reconnect');assert.equal(before.length,50);assert.equal(during.length,41);assert.equal(after.length,50);assert.deepEqual(after.map(p=>p.userId),before.map(p=>p.userId));assert.ok(during.some(p=>p.userId===viewer.id));
});
test('untrusted connection reports must have bounded finite measurements and check records',()=>{
 for(const value of [null,{},[],{schemaVersion:2,kind:'coatria-connections'},JSON.parse('{"__proto__":{"polluted":true}}')])assert.throws(()=>readConnectionReport(value));
 assert.equal(({} as Record<string,unknown>).polluted,undefined);
});
