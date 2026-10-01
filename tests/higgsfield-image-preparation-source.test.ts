import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {deflateSync} from 'node:zlib';
import {inspectPreparationSource} from '../src/lib/higgsfield-image-preparation-source';
import {IMAGE_PREPARATION_POLICY,ImagePreparationError} from '../src/lib/higgsfield-image-preparation-policy';

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const fixtures=Object.fromEntries(['png','jpeg','webp'].map(format=>[format,readFileSync(new URL(`./fixtures/media/synthetic.${format}`,import.meta.url))])) as Record<'png'|'jpeg'|'webp',Buffer>;
// Independent bit-by-bit reference CRC; mutations below always receive a valid
// new checksum, so rejection cannot be attributed only to a stale CRC.
function crc(bytes:Buffer){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(type:string|Buffer,payload:Buffer=Buffer.alloc(0)){const name=typeof type==='string'?Buffer.from(type,'latin1'):type,head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(payload.length);tail.writeUInt32BE(crc(Buffer.concat([name,payload])));return Buffer.concat([head,name,payload,tail]);}
function pngChunks(bytes:Buffer){const parts:Array<{type:string;payload:Buffer}>=[];for(let i=8;i<bytes.length;){const n=bytes.readUInt32BE(i);parts.push({type:bytes.toString('latin1',i+4,i+8),payload:Buffer.from(bytes.subarray(i+8,i+8+n))});i+=12+n;}return parts;}
function png(parts=pngChunks(fixtures.png)){return Buffer.concat([pngSignature,...parts.map(p=>chunk(p.type,p.payload))]);}
function pngWith(type:string,payload:Buffer){const parts=pngChunks(fixtures.png);parts.splice(1,0,{type,payload});return png(parts);}
function reject(bytes:Buffer,code='PREPARATION_UNSUPPORTED'){assert.throws(()=>inspectPreparationSource(bytes),(error:unknown)=>error instanceof ImagePreparationError&&error.code===code);}
function exif(orientation=1,bigEndian=false,description=false){
 const count=description?2:1,text=Buffer.from('PRIVATE_SYNTHETIC_DESCRIPTION\0','latin1'),base=8+2+12*count+4,bytes=Buffer.alloc(base+(description?text.length:0));
 const w16=(n:number,at:number)=>bigEndian?bytes.writeUInt16BE(n,at):bytes.writeUInt16LE(n,at),w32=(n:number,at:number)=>bigEndian?bytes.writeUInt32BE(n,at):bytes.writeUInt32LE(n,at);
 bytes.write(bigEndian?'MM':'II',0,'latin1');w16(42,2);w32(8,4);w16(count,8);w16(0x0112,10);w16(3,12);w32(1,14);w16(orientation,18);
 if(description){w16(0x010e,22);w16(2,24);w32(text.length,26);w32(base,30);text.copy(bytes,base);}return bytes;
}
function jpegSegment(marker:number,payload:Buffer){const header=Buffer.from([255,marker,0,0]);header.writeUInt16BE(payload.length+2,2);return Buffer.concat([header,payload]);}
function jpegWith(marker:number,payload:Buffer){return Buffer.concat([fixtures.jpeg.subarray(0,2),jpegSegment(marker,payload),fixtures.jpeg.subarray(2)]);}
function jpegExif(payload:Buffer){return jpegWith(0xe1,Buffer.concat([Buffer.from('Exif\0\0','latin1'),payload]));}
function webpChunk(type:string|Buffer,payload:Buffer){const head=Buffer.alloc(8);(typeof type==='string'?Buffer.from(type,'latin1'):type).copy(head);head.writeUInt32LE(payload.length,4);return Buffer.concat([head,payload,...(payload.length%2?[Buffer.alloc(1)]:[])]);}
function webp(parts:Array<{type:string|Buffer;payload:Buffer}>){const content=Buffer.concat([Buffer.from('WEBP'),...parts.map(p=>webpChunk(p.type,p.payload))]),head=Buffer.from('RIFF\0\0\0\0','latin1');head.writeUInt32LE(content.length,4);return Buffer.concat([head,content]);}
function webpImage(){const n=fixtures.webp.readUInt32LE(16);return {type:fixtures.webp.toString('latin1',12,16),payload:Buffer.from(fixtures.webp.subarray(20,20+n))};}
function extendedWebp(extra:Array<{type:string;payload:Buffer}>,flags=8){const header=Buffer.alloc(10);header[0]=flags;header.writeUIntLE(15,4,3);header.writeUIntLE(15,7,3);return webp([{type:'VP8X',payload:header},webpImage(),...extra]);}

test('accepts existing real PNG/JPEG/WebP fixtures, returns only a minimal immutable-input descriptor',()=>{
 for(const [format,bytes] of Object.entries(fixtures)){const before=Buffer.from(bytes);assert.deepEqual(inspectPreparationSource(bytes),{format,width:16,height:16,orientation:1});assert.deepEqual(bytes,before);}
});
test('all eight EXIF orientations and both byte orders work in each source container; private text stays out of descriptors',()=>{
 for(const n of [1,2,3,4,5,6,7,8])for(const bigEndian of [false,true]){
  const tiff=exif(n,bigEndian,true);
  for(const bytes of [pngWith('eXIf',tiff),jpegExif(tiff),extendedWebp([{type:'EXIF',payload:tiff}]),extendedWebp([{type:'EXIF',payload:Buffer.concat([Buffer.from('Exif\0\0','latin1'),tiff])}])]){
   const parsed=inspectPreparationSource(bytes);assert.equal(parsed.orientation,n);assert.deepEqual(Object.keys(parsed).sort(),['format','height','orientation','width']);assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));
  }
 }
});
test('rejects ambiguous, malformed, oversized and cyclic EXIF rather than guessing an orientation',()=>{
 const invalid=[exif(0),exif(9),exif(65535)];
 const wrongType=exif();wrongType.writeUInt16LE(4,12);invalid.push(wrongType);
 const wrongCount=exif();wrongCount.writeUInt32LE(2,14);invalid.push(wrongCount);
 const badMagic=exif();badMagic.writeUInt16LE(43,2);invalid.push(badMagic);
 const badPointer=exif();badPointer.writeUInt32LE(0xfffffffe,4);invalid.push(badPointer);
 const nextLoop=exif();nextLoop.writeUInt32LE(8,22);invalid.push(nextLoop);
 const highEndian=exif();highEndian[0]|=128;invalid.push(highEndian);
 const overlapping=exif(1,false,true);overlapping.writeUInt32LE(10,30);invalid.push(overlapping);
 const unterminated=exif(1,false,true);unterminated[unterminated.length-1]=65;invalid.push(unterminated);
 const duplicate=exif(1,false,true);duplicate.writeUInt16LE(0x0112,22);invalid.push(duplicate);
 for(const tiff of invalid)for(const bytes of [pngWith('eXIf',tiff),jpegExif(tiff),extendedWebp([{type:'EXIF',payload:tiff}])])reject(bytes);
 reject(pngWith('eXIf',Buffer.alloc(1024*1024+1)),'PREPARATION_LIMIT_EXCEEDED');
});
test('EXIF permits bounded GPS and declared sRGB, rejects alternate profiles and nested orientation',()=>{
 function nested(childTag:number,tag:number,value:number){const bytes=Buffer.alloc(44);exif().copy(bytes);bytes.writeUInt16LE(childTag,10);bytes.writeUInt16LE(4,12);bytes.writeUInt32LE(26,18);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(tag,28);bytes.writeUInt16LE(3,30);bytes.writeUInt32LE(1,32);bytes.writeUInt16LE(value,36);return bytes;}
 assert.equal(inspectPreparationSource(jpegExif(nested(0x8769,0xa001,1))).orientation,1);
 assert.equal(inspectPreparationSource(jpegExif(nested(0x8825,1,1))).orientation,1);
 for(const bytes of [nested(0x8769,0xa001,65535),nested(0x8769,0x0112,6),nested(0x8769,0x8773,1)])reject(jpegExif(bytes));
 for(const tag of [0x8773,0x012d,0x013e,0x013f,0x0211,0x0214,0xa500,0x014a]){const bytes=exif();bytes.writeUInt16LE(tag,10);reject(jpegExif(bytes));}
});
test('rejects trailing payload, truncated containers and unknown signatures with sanitized errors',()=>{
 for(const bytes of Object.values(fixtures)){reject(Buffer.concat([bytes,Buffer.from('PRIVATE_TRAILING_PAYLOAD')]));for(const cut of [1,3,8])reject(bytes.subarray(0,bytes.length-cut));}
 reject(Buffer.from('PRIVATE_SECRET_INVALID_FORMAT'));reject(Buffer.alloc(11),'PREPARATION_INPUT_INVALID');reject(null as unknown as Buffer,'PREPARATION_INPUT_INVALID');
 assert.throws(()=>inspectPreparationSource(Buffer.from('PRIVATE_SECRET_INVALID_FORMAT')),(e:unknown)=>e instanceof Error&&!e.message.includes('PRIVATE'));
});
test('rejects oversized source bytes, dimensions and pixels before native decode',()=>{
 reject(Buffer.alloc(IMAGE_PREPARATION_POLICY.sourceMaxBytes+1),'PREPARATION_LIMIT_EXCEEDED');
 for(const [width,height] of [[0,16],[8193,1],[8192,8192],[8000,4001]]){const parts=pngChunks(fixtures.png);parts[0].payload.writeUInt32BE(width,0);parts[0].payload.writeUInt32BE(height,4);reject(png(parts),'PREPARATION_LIMIT_EXCEEDED');}
 const parts=pngChunks(fixtures.png);parts[0].payload.writeUInt32BE(8000,0);parts[0].payload.writeUInt32BE(4000,4);assert.equal(inspectPreparationSource(png(parts)).width,8000); // Header acceptance alone is intentionally not decode proof.
});
test('PNG CRC, reserved/type bytes, exact chunk order and one complete image are mandatory',()=>{
 const corrupt=Buffer.from(fixtures.png);corrupt[corrupt.length-5]^=1;reject(corrupt);
 for(const name of ['IHDR','IDAT','IEND']){const parts=pngChunks(fixtures.png),target=parts.find(p=>p.type===name)!;const high=Buffer.from(name);high[0]|=128;target.type=high.toString('latin1');reject(png(parts));}
 const parts=pngChunks(fixtures.png);reject(png([parts[1],...parts]));reject(png([parts[0],parts[0],...parts.slice(1)]));
 const data=parts.find(p=>p.type==='IDAT')!;reject(png([parts[0],data,{type:'tEXt',payload:Buffer.from('key\0text')},data,parts.at(-1)!]));
 reject(pngWith('aaab',Buffer.from('x')));reject(Buffer.concat([fixtures.png,fixtures.png]));reject(png(parts.slice(0,-1)));
});
test('PNG accepts explicit standard sRGB and ordinary text, rejects animation, ICC and uncertain color',()=>{
 const gamma=Buffer.alloc(4);gamma.writeUInt32BE(45455);assert.equal(inspectPreparationSource(pngWith('gAMA',gamma)).format,'png');
 const chromaticity=Buffer.alloc(32);[31270,32900,64000,33000,30000,60000,15000,6000].forEach((v,i)=>chromaticity.writeUInt32BE(v,i*4));assert.equal(inspectPreparationSource(pngWith('cHRM',chromaticity)).format,'png');
 assert.equal(inspectPreparationSource(pngWith('sRGB',Buffer.from([0]))).format,'png');assert.equal(inspectPreparationSource(pngWith('tEXt',Buffer.from('Comment\0PRIVATE_COMMENT'))).format,'png');
 gamma.writeUInt32BE(100000);reject(pngWith('gAMA',gamma));chromaticity.writeUInt32BE(30000);reject(pngWith('cHRM',chromaticity));
 for(const type of ['iCCP','cICP','mDCv','cLLi','acTL','fcTL','fdAT','sBIT','bKGD','unknown'])reject(pngWith(type,Buffer.from([0])));
 reject(pngWith('sRGB',Buffer.from([4])));reject(pngWith('tEXt',Buffer.from('\0PRIVATE_COMMENT')));
 for(const [depth,color,interlace] of [[16,6,0],[8,1,0],[8,6,1]]){const parts=pngChunks(fixtures.png);parts[0].payload[8]=depth;parts[0].payload[9]=color;parts[0].payload[12]=interlace;reject(png(parts));}
});
test('PNG supports bounded 8-bit grayscale/palette/transparency declarations and requires palette ordering',()=>{
 for(const color of [0,2,3,4,6]){const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=color;const parts=[{type:'IHDR',payload:header}];if(color===3)parts.push({type:'PLTE',payload:Buffer.from([255,0,0])},{type:'tRNS',payload:Buffer.from([128])});parts.push({type:'IDAT',payload:deflateSync(Buffer.alloc(color===2?4:color===6?5:color===4?3:2))},{type:'IEND',payload:Buffer.alloc(0)});assert.equal(inspectPreparationSource(png(parts)).format,'png');if(color===3){reject(png(parts.filter(p=>p.type!=='PLTE')));}}
 const parts=pngChunks(fixtures.png);parts[0].payload[9]=6;reject(png([{...parts[0]},{type:'tRNS',payload:Buffer.from([0,1])},...parts.slice(1)]));
 parts[0].payload[9]=2;reject(png([parts[0],{type:'tRNS',payload:Buffer.alloc(6)},{type:'PLTE',payload:Buffer.from([255,0,0])},...parts.slice(1)]));
});
test('JPEG accepts ordinary XMP and comments while rejecting unsupported color/component declarations',()=>{
 assert.equal(inspectPreparationSource(jpegWith(0xe1,Buffer.from('http://ns.adobe.com/xap/1.0/\0<private/>','latin1'))).format,'jpeg');
 assert.equal(inspectPreparationSource(jpegWith(0xfe,Buffer.from('PRIVATE_COMMENT'))).format,'jpeg');
 for(const [marker,payload] of [[0xe2,Buffer.from('ICC_PROFILE\0', 'latin1')],[0xed,Buffer.from('Photoshop 3.0\0','latin1')],[0xe1,Buffer.from('UNKNOWN_PROFILE')]] as const)reject(jpegWith(marker,payload));
 const adobe=Buffer.alloc(12);adobe.write('Adobe');adobe[11]=2;reject(jpegWith(0xee,adobe));
 const high=Buffer.from('Exif\0\0','latin1');high[0]|=128;reject(jpegWith(0xe1,Buffer.concat([high,exif()])));
 const copy=Buffer.from(fixtures.jpeg),sof=copy.indexOf(Buffer.from([255,192]));assert.ok(sof>0);copy[sof+9]=4;reject(copy);
 const dimension=Buffer.from(fixtures.jpeg);dimension.writeUInt16BE(8193,sof+7);reject(dimension,'PREPARATION_LIMIT_EXCEEDED');
 const highJfif=Buffer.from(fixtures.jpeg),jfif=highJfif.indexOf(Buffer.from('JFIF\0'));if(jfif>=0){highJfif[jfif]|=128;reject(highJfif);}
});
test('JPEG rejects duplicate EXIF, unterminated entropy, unsupported scans and unexpected standalone markers',()=>{
 reject(Buffer.concat([jpegExif(exif()).subarray(0,2),jpegSegment(0xe1,Buffer.concat([Buffer.from('Exif\0\0'),exif(6)])),jpegExif(exif()).subarray(2)]));
 reject(Buffer.concat([fixtures.jpeg.subarray(0,-2),Buffer.from([255])]));
 const bad=Buffer.from(fixtures.jpeg),sos=bad.indexOf(Buffer.from([255,218]));assert.ok(sos>0);const payload=sos+4,n=bad[payload];bad[payload+1+n*2]=1;reject(bad);
 reject(Buffer.concat([fixtures.jpeg.subarray(0,2),Buffer.from([255,208]),fixtures.jpeg.subarray(2)]));reject(Buffer.concat([fixtures.jpeg.subarray(0,2),Buffer.from([255,216]),fixtures.jpeg.subarray(2)]));
});
test('WebP requires exact RIFF/FourCC/size, zero pad and matching extended canvas',()=>{
 for(const at of [0,8,12]){const copy=Buffer.from(fixtures.webp);copy[at]|=128;reject(copy);}
 const size=Buffer.from(fixtures.webp);size.writeUInt32LE(size.length-9,4);reject(size);
 const good=extendedWebp([{type:'XMP ',payload:Buffer.from('x')}],4);assert.equal(inspectPreparationSource(good).format,'webp');const pad=Buffer.from(good);pad[pad.length-1]=1;reject(pad);
 const canvas=Buffer.from(good);canvas.writeUIntLE(16,24,3);reject(canvas);
 const absentFlag=extendedWebp([{type:'EXIF',payload:exif()}],0);reject(absentFlag);reject(extendedWebp([],8));
});
test('WebP rejects animations, ICC, duplicate images/metadata, invalid frame headers and unknown chunk types',()=>{
 for(const [type,payload,flags] of [['ANIM',Buffer.alloc(6),2],['ICCP',Buffer.from('profile'),32],['UNKNOWN',Buffer.alloc(1),0]] as const)reject(extendedWebp([{type,payload}],flags));
 reject(webp([webpImage(),webpImage()]));reject(extendedWebp([{type:'EXIF',payload:exif()},{type:'EXIF',payload:exif(2)}]));
 const frame=webpImage();frame.payload[0]|=1;reject(webp([frame]));
 const header=Buffer.alloc(10);header[0]=16;header.writeUIntLE(15,4,3);header.writeUIntLE(15,7,3);reject(webp([{type:'VP8X',payload:header},{type:'ALPH',payload:Buffer.from([0,1])},webpImage()]));
});
test('bounded chunk count prevents metadata-only container walks beyond policy',()=>{
 const parts=pngChunks(fixtures.png);reject(png([parts[0],...Array.from({length:IMAGE_PREPARATION_POLICY.maxContainerChunks},()=>({type:'tEXt',payload:Buffer.from('k\0v')})),...parts.slice(1)]),'PREPARATION_LIMIT_EXCEEDED');
});
