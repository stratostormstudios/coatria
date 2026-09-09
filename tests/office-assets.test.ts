import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {OFFICE_CATALOG,getOfficeAsset} from '../src/lib/office-catalog';
import {layoutInput} from '../src/lib/model';
import {MAX_OFFICE_MODEL_BYTES,officeAssetPath,validOfficeModel,validOfficePreview} from '../src/lib/office-assets';

function model(patch:Record<string,unknown>={}){
 const document={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],buffers:[{byteLength:36}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}],...patch};
 const text=Buffer.from(JSON.stringify(document)),json=Buffer.alloc(Math.ceil(text.length/4)*4,32);text.copy(json);
 const result=Buffer.alloc(12+8+json.length+8+36);result.writeUInt32LE(0x46546c67,0);result.writeUInt32LE(2,4);result.writeUInt32LE(result.length,8);result.writeUInt32LE(json.length,12);result.writeUInt32LE(0x4e4f534a,16);json.copy(result,20);result.writeUInt32LE(36,20+json.length);result.writeUInt32LE(0x004e4942,24+json.length);return result;
}
const preview=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');

test('office catalog references are exact IDs and legacy furniture cannot claim an asset',()=>{
 assert(OFFICE_CATALOG.length>0);assert.equal(new Set(OFFICE_CATALOG.map(asset=>asset.id)).size,OFFICE_CATALOG.length);
 const base={id:'furniture',type:'asset',label:'Office furniture',x:10,y:10,w:10,h:10};
 const payload=(item:Record<string,unknown>)=>({layout:[item],floor:{width:20,depth:16},revision:0});
 for(const asset of OFFICE_CATALOG){assert.match(asset.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);assert.equal(getOfficeAsset(asset.id),asset);assert(asset.name&&asset.category);assert([asset.width,asset.depth,asset.height].every(value=>Number.isFinite(value)&&value>0));assert(['uniform','footprint'].includes(asset.resize));assert(layoutInput.safeParse(payload({...base,assetId:asset.id})).success);}
 for(const assetId of ['unknown-office-object','../private/model','https://example.com/object.glb','%2e%2e%2fprivate','','__proto__',null,{id:OFFICE_CATALOG[0].id}])assert.equal(layoutInput.safeParse(payload({...base,assetId})).success,false);
 assert.equal(layoutInput.safeParse(payload(base)).success,false);
 assert.equal(layoutInput.safeParse(payload({...base,type:'desk',assetId:OFFICE_CATALOG[0].id})).success,false);
 assert(layoutInput.safeParse(payload({...base,type:'desk'})).success);
 assert.equal(layoutInput.safeParse(payload({...base,assetId:OFFICE_CATALOG[0].id,modelUrl:'https://example.com/object.glb'})).success,false);
 for(const id of ['unknown-office-object','../private/model','a/../../private','%2e%2e%2fprivate','__proto__'])assert.throws(()=>officeAssetPath(id),/Office object not found/);
 const id=OFFICE_CATALOG[0].id;assert.equal(officeAssetPath(id),resolve('.runtime-assets','office-models',id+'.glb'));assert.equal(officeAssetPath(id,'preview'),resolve('.runtime-assets','office-models',id+'.png'));
 assert.equal(officeAssetPath(id,'plan'),resolve('.runtime-assets','office-models',id+'.plan.png'));
});

test('office GLBs must be complete, bounded and contain their resources',()=>{
 const good=model();assert(validOfficeModel(good));
 const badHeader=Buffer.from(good);badHeader.writeUInt32LE(good.length+4,8);assert.equal(validOfficeModel(badHeader),false);
 const badChunk=Buffer.from(good);badChunk.writeUInt32LE(good.length,12);assert.equal(validOfficeModel(badChunk),false);
 for(const bytes of [good.subarray(0,20),good.subarray(0,good.length-1),Buffer.alloc(MAX_OFFICE_MODEL_BYTES+1),model({buffers:[{byteLength:36,uri:'https://example.com/buffer.bin'}]}),model({images:[{uri:'data:image/png;base64,AAAA'}]}),model({extensions:{TEST_external:{uri:'file:///private'}}}),model({bufferViews:[{buffer:0,byteOffset:30,byteLength:36}]}),model({buffers:[{byteLength:100}]}),model({meshes:[]})])assert.equal(validOfficeModel(bytes),false);
});

test('office previews reject truncation, damaged chunks, trailing data and non-PNG content',()=>{
 assert(validOfficePreview(preview));
 const damaged=Buffer.from(preview);damaged[45]^=1;
 for(const bytes of [preview.subarray(0,20),preview.subarray(0,preview.length-1),damaged,Buffer.concat([preview,Buffer.from('extra')]),Buffer.from('<svg onload="alert(1)"></svg>')])assert.equal(validOfficePreview(bytes),false);
});

test('public source builds skip licensed files while mandatory deployment checks fail closed',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'coatria-office-guard-'));
 try{
  const script=resolve('scripts/check-office-assets.ts'),loader=pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  const execute=(required:boolean)=>spawnSync(process.execPath,['--import',loader,script],{cwd:directory,encoding:'utf8',env:{...process.env,VERCEL:required?'1':'',COATRIA_REQUIRE_OFFICE_ASSETS:required?'1':'0'}});
  const optional=execute(false);assert.equal(optional.status,0,optional.stderr);assert.match(optional.stdout,/Source-only build/);
  const mandatory=execute(true);assert.notEqual(mandatory.status,0);assert(mandatory.stderr.length>0,'A missing bundle must report why deployment stopped.');
 }finally{await rmdir(directory);}
});
