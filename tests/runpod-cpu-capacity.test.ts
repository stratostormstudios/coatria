import test from 'node:test';
import assert from 'node:assert/strict';
import {RUNPOD_CPU_CATALOG_PATH,runpodCpuCapacity} from '../src/lib/runpod-cpu-capacity';
const region='US-NC-2';
const snapshot=(availability:unknown='HIGH',dataCenters:unknown=[{id:region,availability}])=>({availability,dataCenters});
test('capacity is requested for the exact Pod CPU size and approved region',()=>{
 assert.equal(RUNPOD_CPU_CATALOG_PATH,'/catalog/cpus/cpu3c?include=AVAILABILITY&product=POD&vcpuCount=2');
 for(const level of ['LOW','MEDIUM','HIGH'])assert.equal(runpodCpuCapacity(snapshot(level),region),'available');
 assert.equal(runpodCpuCapacity(snapshot('HIGH',[{id:'US-TX-3',availability:'HIGH'}]),region),'unavailable');
 assert.equal(runpodCpuCapacity(snapshot('HIGH',[{id:region,availability:'NONE'}]),region),'unavailable');
 assert.equal(runpodCpuCapacity({availability:'NONE'},region),'unavailable');
 assert.equal(runpodCpuCapacity(snapshot('HIGH',[]),region),'unavailable');
});
test('missing, malformed, duplicate and unknown availability never authorize submission',()=>{
 for(const value of [null,{},[],snapshot(null),snapshot('HIGH',null),snapshot('HIGH',[null]),snapshot('HIGH',[{id:region}]),snapshot('HIGH',[{id:region,availability:'PLENTY'}]),snapshot('HIGH',[{id:region,availability:'HIGH'},{id:region,availability:'NONE'}]),snapshot('HIGH',Array.from({length:201},(_,index)=>({id:String(index),availability:'HIGH'})))])assert.equal(runpodCpuCapacity(value,region),'unconfirmed');
 assert.equal(runpodCpuCapacity({availability:'HIGH'},region),'unconfirmed');
});
