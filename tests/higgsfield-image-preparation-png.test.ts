import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateSync} from 'node:zlib';
import {validatePreparedPng} from '../src/lib/higgsfield-image-preparation-png';
import {ImagePreparationError,preparationDimensions} from '../src/lib/higgsfield-image-preparation-policy';

const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type:string,data=Buffer.alloc(0)) {const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4,'ascii');data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,out.length-4)),out.length-4);return out;}
function header(width=2,height=2,type=6) {const out=Buffer.alloc(13);out.writeUInt32BE(width);out.writeUInt32BE(height,4);out[8]=8;out[9]=type;return chunk('IHDR',out);}
const raw=Buffer.from([0,255,0,0,127,0,255,0,255,0,0,0,255,255,255,255,255,0]);
const packed=deflateSync(raw), ihdr=header(), idat=chunk('IDAT',packed), end=chunk('IEND'), size={width:2,height:2};
const png=(...chunks:Buffer[])=>Buffer.concat([signature,...chunks]);
const valid=png(ihdr,idat,end);
function invalid(bytes:Buffer,remove=false) {assert.throws(()=>validatePreparedPng(bytes,size,remove),(error:unknown)=>error instanceof ImagePreparationError&&error.code==='PREPARATION_OUTPUT_INVALID');}

test('fixed output validator preserves arbitrary RGBA binary bytes, valid filters and contiguous IDAT',()=>{
 assert.deepEqual(validatePreparedPng(valid,size),valid);
 const split=png(ihdr,chunk('IDAT',packed.subarray(0,2)),chunk('IDAT',packed.subarray(2)),end);
 assert.deepEqual(validatePreparedPng(split,size),split);
 for(let f=0;f<=4;f++){const rows=Buffer.from(raw);rows[0]=rows[9]=f;const file=png(ihdr,chunk('IDAT',deflateSync(rows)),end);assert.deepEqual(validatePreparedPng(file,size),file);}
});

test('only one bounded encoder density chunk can be removed and the final bytes are validated again',()=>{
 const density=Buffer.alloc(9);density.writeUInt32BE(3780);density.writeUInt32BE(3780,4);density[8]=1;
 const phys=chunk('pHYs',density),encoded=png(ihdr,phys,idat,end);
 invalid(encoded); assert.deepEqual(validatePreparedPng(encoded,size,true),valid);
 invalid(png(ihdr,phys,phys,idat,end),true); invalid(png(ihdr,idat,phys,end),true);
 invalid(png(ihdr,chunk('pHYs',Buffer.alloc(8)),idat,end),true);
 density[8]=2;invalid(png(ihdr,chunk('pHYs',density),idat,end),true);
});

test('encoder metadata, a returned unsanitized source and appended payload cannot claim sanitization',()=>{
 for(const type of ['tEXt','iTXt','zTXt','eXIf','iCCP','sRGB','gAMA','cHRM','acTL','fcTL','fdAT','PLTE','tRNS','vpAg']){
  const returnedSource=png(ihdr,chunk(type,Buffer.from('private-source-metadata')),idat,end);invalid(returnedSource,true);
 }
 invalid(Buffer.concat([valid,Buffer.from('hidden-tail')]));invalid(Buffer.concat([valid,valid]));
});

test('CRC, all chunk boundaries, exact shape, bit depth and order are enforced',()=>{
 for(let length=0;length<valid.length;length++) invalid(valid.subarray(0,length));
 const crc=Buffer.from(valid);crc[crc.length-1]^=1;invalid(crc);
 invalid(png(idat,ihdr,end));invalid(png(ihdr,ihdr,idat,end));invalid(png(ihdr,end));
 invalid(png(header(3,2),idat,end));invalid(png(header(2,2,2),idat,end));invalid(png(ihdr,chunk('IDAT'),end));
 for(const index of [8,10,11,12]){const data=Buffer.from(ihdr.subarray(8,21));data[index]=index===8?16:1;invalid(png(chunk('IHDR',data),idat,end));}
 assert.throws(()=>validatePreparedPng(valid,{width:2049,height:2}),ImagePreparationError);
 assert.throws(()=>validatePreparedPng(valid,{width:1.5,height:2}),ImagePreparationError);
 for(const target of ['IHDR','IDAT','IEND']) {
  const chunks=[ihdr,idat,end].map(value=>{const out=Buffer.from(value);if(out.toString('latin1',4,8)===target){for(let i=4;i<8;i++)out[i]|=128;out.writeUInt32BE(crc32(out.subarray(4,out.length-4)),out.length-4);}return out;});
  invalid(png(...chunks));
 }
});

test('full compressed-stream consumption and exact decoded row allocation are mandatory',()=>{
 const variants=[Buffer.concat([packed,Buffer.from('tail')]),Buffer.concat([packed,packed]),packed.subarray(0,packed.length-1),
  deflateSync(raw.subarray(0,raw.length-1)),deflateSync(Buffer.concat([raw,Buffer.from([0])])),deflateSync(Buffer.alloc(1024**2))];
 for(const value of variants)invalid(png(ihdr,chunk('IDAT',value),end));
 const badFilter=Buffer.from(raw);badFilter[9]=5;invalid(png(ihdr,chunk('IDAT',deflateSync(badFilter)),end));
 const badAdler=Buffer.from(packed);badAdler[badAdler.length-1]^=1;invalid(png(ihdr,chunk('IDAT',badAdler),end));
});

test('the fixed size policy preserves aspect ratio to the nearest pixel without enlargement',()=>{
 assert.deepEqual(preparationDimensions(4096,2001),{width:2048,height:1001});
 assert.deepEqual(preparationDimensions(9,1),{width:9,height:1});
 assert.deepEqual(preparationDimensions(8192,1),{width:2048,height:1});
 assert.throws(()=>preparationDimensions(8193,1),ImagePreparationError);
 assert.throws(()=>preparationDimensions(8192,8192),ImagePreparationError);
});
