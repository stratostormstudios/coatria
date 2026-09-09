import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_FLOOR,readFloorPlan,type LayoutItem} from '../src/lib/floor-plan';
import {layoutInput,STUDIO_LAYOUT} from '../src/lib/model';

const item:LayoutItem={id:'desk-1',type:'desk',x:20,y:10,w:15,h:25,label:'Design desk'};
const valid={layout:[item],floor:{width:24,depth:18},revision:0};

test('legacy layouts retain their objects and receive independent default floor metadata',()=>{
 const first=readFloorPlan([item]),second=readFloorPlan([]);
 assert.deepEqual(first,{version:1,items:[item],floor:DEFAULT_FLOOR,revision:0});
 first.floor.width=30;assert.equal(second.floor.width,20);assert.equal(DEFAULT_FLOOR.width,20);
 assert.equal(readFloorPlan(STUDIO_LAYOUT).items.length,8);
});

test('versioned layouts preserve floor size, quarter-turn rotation and revision',()=>{
 const plan={version:1,items:[{...item,rotation:270}],floor:{width:40,depth:8},revision:7};
 assert.deepEqual(readFloorPlan(JSON.parse(JSON.stringify(plan))),plan);
 for(const rotation of [0,90,180,270])assert.equal(layoutInput.safeParse({...valid,layout:[{...item,rotation}]}).success,true);
 assert.equal(layoutInput.safeParse(valid).success,true,'An omitted rotation retains legacy forward orientation.');
 assert.equal(layoutInput.safeParse({...valid,layout:STUDIO_LAYOUT}).success,true);
});

test('floor writes require bounded dimensions, a current integer revision and exact geometry',()=>{
 const invalid=[
  {layout:[item]}, {...valid,revision:undefined}, {...valid,revision:-1}, {...valid,revision:0.5}, {...valid,revision:Number.MAX_SAFE_INTEGER},
  {...valid,floor:{width:7.99,depth:16}}, {...valid,floor:{width:20,depth:40.01}}, {...valid,floor:{width:Infinity,depth:16}},
  {...valid,floor:{width:'20',depth:16}}, {...valid,floor:{width:20,depth:16,height:8}},
  {...valid,layout:[{...item,rotation:45}]}, {...valid,layout:[{...item,rotation:'90'}]},
  {...valid,layout:[{...item,x:90}]}, {...valid,layout:[{...item,h:0}]}, {...valid,layout:[{...item,y:NaN}]},
  {...valid,layout:[item,item]}, {...valid,layout:Array.from({length:101},(_,index)=>({...item,id:String(index)}))},
  {...valid,layout:[{...item,modelUrl:'https://external.example/model.glb'}]}, {...valid,companyId:'another-company'}
 ];
 for(const value of invalid)assert.equal(layoutInput.safeParse(value).success,false,JSON.stringify(value));
 const oldEditor=layoutInput.safeParse({layout:[item],floor:DEFAULT_FLOOR});
 assert.equal(oldEditor.success,false);if(!oldEditor.success)assert.match(oldEditor.error.issues.map(issue=>issue.message).join(' '),/Reload the office editor/);
});

test('unknown or corrupt stored documents fail instead of silently resetting an office',()=>{
 for(const value of [null,{},'[]',{version:2,items:[item],floor:DEFAULT_FLOOR,revision:0},{version:1,items:[],floor:{width:400,depth:16},revision:0},{version:1,items:[],floor:DEFAULT_FLOOR,revision:-1}])assert.throws(()=>readFloorPlan(value),/Invalid stored floor plan/);
});
