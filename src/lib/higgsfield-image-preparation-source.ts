/** Container and declared-color checks only. A successful parse is not evidence
 * of full decoding, transformation, metadata removal, or sharing authority. */
import {ImagePreparationError,preparationFail,IMAGE_PREPARATION_POLICY as policy,preparationDimensions,type PreparationSource} from './higgsfield-image-preparation-policy';

type Orientation=PreparationSource['orientation'];
const unsupported=()=>preparationFail('PREPARATION_UNSUPPORTED');
function check(value:unknown):asserts value{if(!value)unsupported();}
function span(bytes:Buffer,offset:number,length:number){check(Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&offset<=bytes.length-length);return bytes.subarray(offset,offset+length);}
function result(format:PreparationSource['format'],width:number,height:number,orientation:Orientation=1):PreparationSource{preparationDimensions(width,height);return {format,width,height,orientation};}
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}

/** Classic TIFF only: bounded directories and value spans, not BigTIFF, maker
 * note execution, profile interpretation or an EXIF-derived pixel transform.
 * GPS/text values may be discarded later; none enter the returned descriptor. */
function exifOrientation(input:Buffer,allowPrefix=false):Orientation{
 const bytes=allowPrefix&&input.subarray(0,6).equals(Buffer.from('Exif\0\0','binary'))?input.subarray(6):input;
 if(bytes.length>1024*1024)preparationFail('PREPARATION_LIMIT_EXCEEDED');
 check(bytes.length>=14);const endian=bytes.toString('latin1',0,2);check(endian==='II'||endian==='MM');
 const u16=(offset:number)=>{span(bytes,offset,2);return endian==='II'?bytes.readUInt16LE(offset):bytes.readUInt16BE(offset);};
 const u32=(offset:number)=>{span(bytes,offset,4);return endian==='II'?bytes.readUInt32LE(offset):bytes.readUInt32BE(offset);};
 check(u16(2)===42);const first=u32(4);check(first>=8&&first%2===0);
 const widths:Record<number,number>={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8};
 type Directory={offset:number;kind:'primary'|'thumbnail'|'exif'|'gps'|'interop';depth:number};
 const queue:Directory[]=[{offset:first,kind:'primary',depth:0}],visited=new Set<number>(),ranges:Array<[number,number]>=[[0,8]];
 let orientation:Orientation=1,orientationSeen=false,totalEntries=0;
 const claim=(start:number,length:number)=>{span(bytes,start,length);check(start>=8&&!ranges.some(([a,b])=>start<b&&a<start+length));ranges.push([start,start+length]);};
 while(queue.length){
  const directory=queue.shift()!;check(directory.depth<=4&&visited.size<16&&!visited.has(directory.offset));visited.add(directory.offset);
  check(directory.offset>=8&&directory.offset%2===0);const count=u16(directory.offset);totalEntries+=count;
  check(count<=256&&totalEntries<=512);claim(directory.offset,2+count*12+4);const tags=new Set<number>();
  for(let i=0;i<count;i++){
   const entry=directory.offset+2+i*12,tag=u16(entry),type=u16(entry+2),countValue=u32(entry+4),width=widths[type];
   check(width!==undefined&&countValue>0&&!tags.has(tag));tags.add(tag);
   const length=countValue*width;check(Number.isSafeInteger(length)&&length<=bytes.length);
   const offset=length<=4?entry+8:u32(entry+8);if(length>4)claim(offset,length);const value=span(bytes,offset,length);
   if(type===2)check(value[value.length-1]===0);
   if(tag===0x0112){
    check(directory.kind==='primary'&&!orientationSeen&&type===3&&countValue===1);const n=u16(offset);check(n>=1&&n<=8);orientation=n as Orientation;orientationSeen=true;
   }
   // A named non-sRGB color space, ICC data or custom tone/chromaticity mapping
   // cannot become "sRGB" merely by dropping its metadata.
   if([0x8773,0x012d,0x013e,0x013f,0x0211,0x0214,0xa500].includes(tag))unsupported();
   if(tag===0xa001)check(directory.kind==='exif'&&type===3&&countValue===1&&u16(offset)===1);
   if(directory.kind==='interop'&&tag===1)check(type===2&&value.equals(Buffer.from('R98\0','binary')));
   const child=tag===0x8769?'exif':tag===0x8825?'gps':tag===0xa005?'interop':null;
   if(child){check(type===4&&countValue===1&&u32(offset)>=8);queue.push({offset:u32(offset),kind:child,depth:directory.depth+1});}
   // SubIFDs and alternate image/profile roots are not part of this profile.
   if(tag===0x014a)unsupported();
  }
  const next=u32(directory.offset+2+count*12);
  if(next){check(directory.kind==='primary');queue.push({offset:next,kind:'thumbnail',depth:directory.depth+1});}
 }
 return orientation;
}

function png(bytes:Buffer):PreparationSource{
 let offset=8,count=0,width=0,height=0,color=-1,palette=0,data=false,dataEnded=false,orientation:Orientation=1;
 const seen=new Set<string>();
 while(offset<bytes.length){
  span(bytes,offset,12);if(++count>policy.maxContainerChunks)preparationFail('PREPARATION_LIMIT_EXCEEDED');
  const length=bytes.readUInt32BE(offset),payload=span(bytes,offset+8,length),end=offset+12+length;span(bytes,end-4,4);
  const type=bytes.toString('latin1',offset+4,offset+8);check(/^[A-Za-z]{4}$/.test(type)&&type[2]===type[2].toUpperCase());
  check(crc32(bytes.subarray(offset+4,end-4))===bytes.readUInt32BE(end-4));
  if(count===1)check(type==='IHDR');
  if(type==='IDAT'){check(!dataEnded&&length>0&&(color!==3||palette>0));data=true;}
  else if(data)dataEnded=true;
  if(!['IDAT','tEXt','zTXt','iTXt'].includes(type)){check(!seen.has(type));seen.add(type);}
  if(type==='IHDR'){
   check(count===1&&length===13);width=payload.readUInt32BE(0);height=payload.readUInt32BE(4);color=payload[9];
   check(payload[8]===8&&[0,2,3,4,6].includes(color)&&payload[10]===0&&payload[11]===0&&payload[12]===0);preparationDimensions(width,height);
  }else if(type==='PLTE'){
   check(!data&&!seen.has('tRNS')&&[2,3,6].includes(color)&&length>=3&&length<=768&&length%3===0);palette=length/3;
  }else if(type==='tRNS'){
   check(!data);
   if(color===3)check(palette>0&&length>0&&length<=palette);
   else if(color===0)check(length===2&&payload.readUInt16BE(0)<=255);
   else if(color===2)check(length===6&&[0,2,4].every(i=>payload.readUInt16BE(i)<=255));
   else unsupported();
  }else if(type==='gAMA')check(!data&&!palette&&length===4&&payload.readUInt32BE(0)===45455);
  else if(type==='cHRM')check(!data&&!palette&&length===32&&[31270,32900,64000,33000,30000,60000,15000,6000].every((v,i)=>payload.readUInt32BE(i*4)===v));
  else if(type==='sRGB')check(!data&&!palette&&length===1&&payload[0]<=3);
  else if(type==='pHYs')check(!data&&length===9&&payload[8]<=1);
  else if(type==='eXIf'){check(!data);orientation=exifOrientation(payload);}
  else if(['tEXt','zTXt','iTXt'].includes(type)){
   const endKeyword=payload.indexOf(0);check(endKeyword>=1&&endKeyword<=79);const keyword=payload.subarray(0,endKeyword);check(!keyword.some(b=>b<32||b>126&&b<161));
   if(type==='tEXt')check(payload.indexOf(0,endKeyword+1)===-1);
   else if(type==='zTXt')check(endKeyword+3<=length&&payload[endKeyword+1]===0);
   else{
    check(endKeyword+5<=length&&payload[endKeyword+1]<=1&&payload[endKeyword+2]===0);
    const languageEnd=payload.indexOf(0,endKeyword+3),translationEnd=payload.indexOf(0,languageEnd+1);check(languageEnd>=endKeyword+3&&translationEnd>=languageEnd+1);
   }
  }else if(type==='tIME')check(length===7&&payload.readUInt16BE(0)>0&&payload[2]>=1&&payload[2]<=12&&payload[3]>=1&&payload[3]<=31&&payload[4]<=23&&payload[5]<=59&&payload[6]<=60);
  else if(type==='IEND'){check(length===0&&data&&end===bytes.length);return result('png',width,height,orientation);}
  else if(type!=='IDAT')unsupported();
  offset=end;
 }
 return unsupported();
}

function jpeg(bytes:Buffer):PreparationSource{
 let offset=2,count=0,width=0,height=0,frame=0,scans=0,orientation:Orientation=1,exif=false,jfif=false,adobe:number|undefined,restart=0;
 const components=new Set<number>();
 while(offset<bytes.length){
  check(bytes[offset]===255);while(bytes[offset]===255)offset++;check(offset<bytes.length);const marker=bytes[offset++];
  if(++count>policy.maxContainerChunks)preparationFail('PREPARATION_LIMIT_EXCEEDED');
  if(marker===0xd9){check(frame&&scans&&offset===bytes.length&&!(jfif&&adobe===0));return result('jpeg',width,height,orientation);}
  check(marker!==0&&marker!==0xd8&&!(marker>=0xd0&&marker<=0xd7)&&marker!==1);
  span(bytes,offset,2);const length=bytes.readUInt16BE(offset);check(length>=2);const payload=span(bytes,offset+2,length-2);offset+=length;
  if(marker===0xc0||marker===0xc2){
   check(!frame&&payload.length===15&&payload[0]===8&&payload[5]===3);frame=marker;width=payload.readUInt16BE(3);height=payload.readUInt16BE(1);preparationDimensions(width,height);
   for(let i=6;i<15;i+=3){const sampling=payload[i+1];check(!components.has(payload[i])&&(sampling>>>4)>=1&&(sampling>>>4)<=4&&(sampling&15)>=1&&(sampling&15)<=4&&payload[i+2]<=3);components.add(payload[i]);}
   check([[1,2,3],[82,71,66]].some(ids=>ids.every(n=>components.has(n))));
  }else if(marker===0xda){
   const n=payload[0];check(frame&&n>=1&&n<=3&&payload.length===4+2*n);const selected=new Set<number>();
   for(let i=1;i<1+n*2;i+=2){check(components.has(payload[i])&&!selected.has(payload[i])&&(payload[i+1]>>>4)<=3&&(payload[i+1]&15)<=3);selected.add(payload[i]);}
   const start=payload[1+n*2],end=payload[2+n*2],high=payload[3+n*2]>>>4,low=payload[3+n*2]&15;
   if(frame===0xc0)check(start===0&&end===63&&high===0&&low===0);
   else check(start<=end&&end<=63&&(start===0?end===0:n===1)&&high<=13&&low<=13&&(high===0||high===low+1));
   let encoded=0,nextRestart=0;
   for(;;){
    check(offset<bytes.length);if(bytes[offset]!==255){offset++;encoded++;continue;}
    const mark=offset;while(bytes[offset]===255)offset++;check(offset<bytes.length);const next=bytes[offset];
    if(next===0){check(offset===mark+1);offset++;encoded++;continue;}
    if(next>=0xd0&&next<=0xd7){check(restart>0&&next===0xd0+nextRestart);nextRestart=(nextRestart+1)%8;offset++;continue;}
    check(encoded>0);offset=mark;break;
   }
   scans++;
  }else if(marker===0xdb){
   let i=0;while(i<payload.length){const info=payload[i++],size=(info>>>4)===0?64:(info>>>4)===1?128:0;check(size>0&&(info&15)<=3);span(payload,i,size);i+=size;}check(i===payload.length&&i>0);
  }else if(marker===0xc4){
   let i=0;while(i<payload.length){const info=payload[i++];check((info>>>4)<=1&&(info&15)<=3);const lengths=span(payload,i,16);i+=16;const symbols=lengths.reduce((a,b)=>a+b,0);check(symbols>0&&symbols<=256);span(payload,i,symbols);i+=symbols;}check(i===payload.length&&i>0);
  }else if(marker===0xdd){check(payload.length===2);restart=payload.readUInt16BE(0);}
  else if(marker===0xe0){
   check(!jfif&&scans===0&&payload.length>=14&&payload.subarray(0,5).equals(Buffer.from('JFIF\0','binary'))&&payload[5]===1&&payload[6]<=2&&payload[7]<=2&&payload.length===14+3*payload[12]*payload[13]);jfif=true;
  }else if(marker===0xe1){
   if(payload.subarray(0,6).equals(Buffer.from('Exif\0\0','binary'))){check(!exif&&scans===0);exif=true;orientation=exifOrientation(payload.subarray(6));}
   else check(payload.subarray(0,29).equals(Buffer.from('http://ns.adobe.com/xap/1.0/\0','binary')));
  }else if(marker===0xee){
   check(adobe===undefined&&scans===0&&payload.length===12&&payload.subarray(0,5).equals(Buffer.from('Adobe','ascii'))&&payload[11]<=1);adobe=payload[11];
  }else if(marker!==0xfe)unsupported();
 }
 return unsupported();
}

function webp(bytes:Buffer):PreparationSource{
 check(bytes.length>=20&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.length%2===0);
 let offset=12,count=0,width=0,height=0,canvasWidth=0,canvasHeight=0,flags=0,extended=false,image=false,alpha=false,alphaFlag=false,orientation:Orientation=1;
 const seen=new Set<string>();
 while(offset<bytes.length){
  span(bytes,offset,8);if(++count>policy.maxContainerChunks)preparationFail('PREPARATION_LIMIT_EXCEEDED');
  const type=bytes.toString('latin1',offset,offset+4),length=bytes.readUInt32LE(offset+4),payload=span(bytes,offset+8,length),end=offset+8+length+(length%2);span(bytes,end,0);
  if(length%2)check(bytes[end-1]===0);check(!seen.has(type));seen.add(type);
  if(type==='VP8X'){
   check(count===1&&length===10);flags=payload[0];check((flags&~0x1c)===0&&payload.subarray(1,4).every(b=>b===0));extended=true;
   canvasWidth=1+payload.readUIntLE(4,3);canvasHeight=1+payload.readUIntLE(7,3);preparationDimensions(canvasWidth,canvasHeight);
  }else if(type==='VP8 '){
   check(!image&&length>10);const tag=payload.readUIntLE(0,3);check((tag&1)===0&&((tag>>>1)&7)<=3&&(tag&16)!==0&&(tag>>>5)>0&&(tag>>>5)<=length-10&&payload.subarray(3,6).equals(Buffer.from([0x9d,1,0x2a])));
   width=payload.readUInt16LE(6);height=payload.readUInt16LE(8);check((width&0xc000)===0&&(height&0xc000)===0);alphaFlag=alpha;image=true;
  }else if(type==='VP8L'){
   check(!image&&!alpha&&length>5&&payload[0]===0x2f);const bits=payload.readUInt32LE(1);check((bits>>>29)===0);width=1+(bits&0x3fff);height=1+((bits>>>14)&0x3fff);alphaFlag=!!(bits&0x10000000);image=true;
  }else if(type==='ALPH'){
   check(extended&&!image&&(flags&16)!==0&&length>1&&(payload[0]&0xc0)===0&&((payload[0]>>>4)&3)<=1&&(payload[0]&3)<=1);
   if((payload[0]&3)===0)check(length===1+canvasWidth*canvasHeight);alpha=true;
  }else if(type==='EXIF'){check(extended&&(flags&8)!==0);orientation=exifOrientation(payload,true);}
  else if(type==='XMP ')check(extended&&(flags&4)!==0&&length>0);
  else unsupported();
  if(image){preparationDimensions(width,height);if(extended)check(width===canvasWidth&&height===canvasHeight);}
  offset=end;
 }
 check(image&&offset===bytes.length);
 if(extended)check(!!(flags&8)===seen.has('EXIF')&&!!(flags&4)===seen.has('XMP ')&&!!(flags&16)===alphaFlag);
 else check(count===1);
 return result('webp',width,height,orientation);
}

export function inspectPreparationSource(bytes:Buffer):PreparationSource{
 if(!Buffer.isBuffer(bytes)||bytes.length<12)preparationFail('PREPARATION_INPUT_INVALID');
 if(bytes.length>policy.sourceMaxBytes)preparationFail('PREPARATION_LIMIT_EXCEEDED');
 try{
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return png(bytes);
  if(bytes[0]===255&&bytes[1]===0xd8)return jpeg(bytes);
  if(bytes.toString('latin1',0,4)==='RIFF'&&bytes.toString('latin1',8,12)==='WEBP')return webp(bytes);
  return unsupported();
 }catch(error){if(error instanceof ImagePreparationError)throw error;return unsupported();}
}
