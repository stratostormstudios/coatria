// Licensed operator tool. Input is the purchased, extracted Separate_assets_glb
// directory; output stays ignored by Git. Never publish the purchased archive.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const source=process.argv[2];
if(!source)throw new Error('Usage: node scripts/prepare-office-assets.mjs <extracted Separate_assets_glb directory>');
const selection=JSON.parse(await readFile(resolve(root,'scripts/office-models.selection.json'),'utf8'));
const destination=resolve(root,'.runtime-assets/office-models');
await mkdir(destination,{recursive:true});
function readGLB(bytes){
  if(bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw new Error('Invalid GLB');
  const length=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+length).toString());
  if(doc.skins?.length||doc.animations?.length||doc.extensionsUsed?.length||doc.buffers?.length!==1||[...(doc.images||[]),...doc.buffers].some(v=>v.uri))throw new Error('Expected self-contained static GLB');
  const bin=20+length;if(bytes.readUInt32LE(bin+4)!==0x004e4942)throw new Error('Missing BIN chunk');
  return {doc,bin:bytes.subarray(bin+8,bin+8+bytes.readUInt32LE(bin))};
}
function merge(parts){
  const out={asset:{version:'2.0',generator:'Coatria licensed office preparation'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],materials:[],textures:[],images:[],samplers:[],accessors:[],bufferViews:[],buffers:[]};
  const bins=[];let offset=0;
  for(const {doc,bin,transform}of parts){
    const base=Object.fromEntries(['nodes','meshes','materials','textures','images','samplers','accessors','bufferViews'].map(key=>[key,out[key].length]));
    for(const v of doc.bufferViews||[])out.bufferViews.push({...v,buffer:0,byteOffset:(v.byteOffset||0)+offset});
    for(const a of doc.accessors||[]){if(a.sparse)throw new Error('Sparse accessor not supported');out.accessors.push({...a,bufferView:a.bufferView+base.bufferViews});}
    for(const i of doc.images||[])out.images.push({...i,bufferView:i.bufferView+base.bufferViews});
    out.samplers.push(...doc.samplers||[]);
    for(const t of doc.textures||[])out.textures.push({...t,source:t.source+base.images,...(t.sampler!==undefined?{sampler:t.sampler+base.samplers}:{})});
    for(const material of doc.materials||[]){const m=structuredClone(material);const fix=obj=>{for(const[key,value]of Object.entries(obj)){if(value&&typeof value==='object'){if(key.endsWith('Texture')&&'index'in value)value.index+=base.textures;else fix(value);}}};fix(m);out.materials.push(m);}
    for(const mesh of doc.meshes||[])out.meshes.push({...mesh,primitives:mesh.primitives.map(p=>({...p,attributes:Object.fromEntries(Object.entries(p.attributes).map(([key,value])=>[key,value+base.accessors])),...(p.indices!==undefined?{indices:p.indices+base.accessors}:{}),...(p.material!==undefined?{material:p.material+base.materials}:{})}))});
    for(const node of doc.nodes||[])out.nodes.push({...node,...(node.mesh!==undefined?{mesh:node.mesh+base.meshes}:{}),...(node.children?{children:node.children.map(i=>i+base.nodes)}:{})});
    out.scenes[0].nodes.push(out.nodes.length);out.nodes.push({...transform,children:doc.scenes[doc.scene||0].nodes.map(i=>i+base.nodes)});
    bins.push(bin);offset+=bin.length;
  }
  out.buffers=[{byteLength:offset}];const json=Buffer.from(JSON.stringify(out));const padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
  const bin=Buffer.concat(bins),result=Buffer.alloc(12+8+padded.length+8+bin.length);result.writeUInt32LE(0x46546c67,0);result.writeUInt32LE(2,4);result.writeUInt32LE(result.length,8);result.writeUInt32LE(padded.length,12);result.writeUInt32LE(0x4e4f534a,16);padded.copy(result,20);const at=20+padded.length;result.writeUInt32LE(bin.length,at);result.writeUInt32LE(0x004e4942,at+4);bin.copy(result,at+8);return result;
}
for(const item of selection){
  if(!/^[a-z0-9-]+$/.test(item.id))throw new Error('Invalid catalog ID');
  const parts=[];for(const part of item.parts){if(basename(part.source)!==part.source)throw new Error('Invalid source filename');const {source:file,...transform}=part;parts.push({...readGLB(await readFile(resolve(source,file))),transform});}
  await writeFile(resolve(destination,item.id+'.glb'),merge(parts));
}
console.log(`Prepared ${selection.length} private office models. Generate and verify previews before release.`);
