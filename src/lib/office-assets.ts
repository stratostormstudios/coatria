import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {requireUser} from './auth';
import {OFFICE_CATALOG,getOfficeAsset} from './office-catalog';
import {assertOrigin,errorResponse,fail,json,rateLimit} from './security';

export const MAX_OFFICE_MODEL_BYTES=4*1024*1024;
export const MAX_OFFICE_PREVIEW_BYTES=256*1024;
export const MAX_OFFICE_LIBRARY_BYTES=128*1024*1024;
export type OfficeAssetKind='model'|'preview'|'plan';
const extensions:Record<OfficeAssetKind,string>={model:'glb',preview:'png',plan:'plan.png'};

/** User-supplied values never become filenames without an exact catalog match. */
export function officeAssetPath(assetId:string,kind:OfficeAssetKind='model'){
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assetId)||!getOfficeAsset(assetId)||!['model','preview','plan'].includes(kind))fail(404,'Office object not found.');
  return resolve(process.cwd(),'.runtime-assets','office-models',`${assetId}.${extensions[kind]}`);
}

/** Validate GLB chunk boundaries and reject all external resource references. */
export function validOfficeModel(bytes:Buffer):boolean{
  try{
    if(bytes.length<28||bytes.length>MAX_OFFICE_MODEL_BYTES||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)return false;
    const jsonLength=bytes.readUInt32LE(12);
    if(!jsonLength||jsonLength%4||bytes.readUInt32LE(16)!==0x4e4f534a||jsonLength>bytes.length-28)return false;
    const binaryOffset=20+jsonLength,binaryLength=bytes.readUInt32LE(binaryOffset);
    if(binaryLength%4||bytes.readUInt32LE(binaryOffset+4)!==0x004e4942||binaryOffset+8+binaryLength!==bytes.length)return false;
    const document=JSON.parse(bytes.subarray(20,binaryOffset).toString('utf8'));
    if(document.asset?.version!=='2.0'||!Array.isArray(document.meshes)||!document.meshes.length||!Array.isArray(document.nodes)||!document.nodes.length||!Array.isArray(document.scenes)||!document.scenes.length)return false;
    const hasUri=(value:unknown):boolean=>Boolean(value&&typeof value==='object'&&Object.entries(value).some(([key,child])=>key.toLowerCase().endsWith('uri')||hasUri(child)));
    if(hasUri(document)||!Array.isArray(document.buffers)||document.buffers.length!==1)return false;
    const length=document.buffers[0]?.byteLength;
    if(!Number.isSafeInteger(length)||length<1||length>binaryLength||binaryLength-length>3)return false;
    if(document.bufferViews!==undefined&&!Array.isArray(document.bufferViews))return false;
    const views=document.bufferViews||[];
    if(views.some((view:{buffer?:number;byteOffset?:number;byteLength?:number})=>view?.buffer!==0||!Number.isSafeInteger(view.byteOffset??0)||(view.byteOffset??0)<0||!Number.isSafeInteger(view.byteLength)||!view.byteLength||view.byteLength<0||(view.byteOffset??0)+view.byteLength>length))return false;
    if(document.images!==undefined&&!Array.isArray(document.images))return false;
    return !(document.images||[]).some((image:{bufferView?:number;mimeType?:string})=>!Number.isSafeInteger(image?.bufferView)||!views[image.bufferView!]||!['image/png','image/jpeg','image/webp'].includes(image.mimeType||''));
  }catch{return false;}
}

function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
/** Check PNG dimensions, complete chunks and checksums before serving a preview. */
export function validOfficePreview(bytes:Buffer):boolean{
  if(bytes.length<57||bytes.length>MAX_OFFICE_PREVIEW_BYTES||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
  let offset=8,header=false,data=false;
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset),end=offset+length+12;
    if(end>bytes.length)return false;
    const kind=bytes.toString('ascii',offset+4,offset+8);
    if(!/^[A-Za-z]{4}$/.test(kind)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return false;
    if(!header){
      if(kind!=='IHDR'||length!==13)return false;
      const width=bytes.readUInt32BE(offset+8),height=bytes.readUInt32BE(offset+12),depth=bytes[offset+16],color=bytes[offset+17];
      if(!width||width>1024||!height||height>1024||![1,2,4,8,16].includes(depth)||![0,2,3,4,6].includes(color)||bytes[offset+18]!==0||bytes[offset+19]!==0||bytes[offset+20]>1)return false;
      header=true;
    }else if(kind==='IHDR')return false;
    if(kind==='IDAT'&&length>0)data=true;
    if(kind==='IEND')return length===0&&data&&end===bytes.length;
    offset=end;
  }
  return false;
}

export async function handleOfficeAssetRequest(request:Request,assetId?:string,kind:OfficeAssetKind='model'){
  try{
    if(request.headers.get('sec-fetch-site')==='cross-site')fail(403,'Cross-site requests are not allowed.');
    if(request.headers.has('origin'))assertOrigin(request);
    const user=await requireUser(request);
    if(assetId===undefined){await rateLimit(`office-catalog:${user.id}`,120,60);return json({assets:OFFICE_CATALOG},200,{'Vary':'Cookie, X-Coatria-User','Cross-Origin-Resource-Policy':'same-origin'});}
    const path=officeAssetPath(assetId,kind),isImage=kind!=='model',limit=isImage?MAX_OFFICE_PREVIEW_BYTES:MAX_OFFICE_MODEL_BYTES;
    await rateLimit(`office-${isImage?'preview':'model'}:${user.id}`,isImage?360:240,60);
    let bytes:Buffer;
    try{const info=await stat(path);if(!info.isFile()||info.size<20||info.size>limit)fail(503,'This office object is temporarily unavailable.','OFFICE_ASSET_UNAVAILABLE');bytes=await readFile(path);}
    catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')fail(503,'This office object is temporarily unavailable.','OFFICE_ASSET_UNAVAILABLE');throw error;}
    if(!(isImage?validOfficePreview(bytes):validOfficeModel(bytes)))fail(503,'This office object is temporarily unavailable.','OFFICE_ASSET_UNAVAILABLE');
    return new Response(new Uint8Array(bytes),{headers:{
      'Content-Type':isImage?'image/png':'model/gltf-binary','Content-Length':String(bytes.byteLength),
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin',
      'Content-Disposition':`inline; filename="${assetId}.${extensions[kind]}"`,'Vary':'Cookie, X-Coatria-User'
    }});
  }catch(error){return errorResponse(error);}
}
