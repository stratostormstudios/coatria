/** Trusted archive-worker inspection only. No URLs, shell, network or runtime downloads.
 * Requires configured FFmpeg/ffprobe with the seekable fd protocol (tested with 8.1.1).
 * Host MUST additionally isolate this decoder process with aggregate memory/CPU limits;
 * max_alloc bounds individual allocations, not the complete decoder address space. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,realpath,stat,type FileHandle} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';

type Kind='image'|'video'|'audio';
type Rational={numerator:number;denominator:number};
type Color={space:string|null;primaries:string|null;transfer:string|null;range:string|null};
type AudioFacts={codec:string;sampleRateHz:number;channels:number};
type Common={format:'png'|'jpeg'|'webp'|'mp4'|'mov'|'wav'|'mp3';contentType:string;bytes:number;sha256:string;verification:'full_decode';inspectionVersion:1};
export type HiggsfieldMediaDescriptor=Common&(
 |{kind:'image';width:number;height:number;codec:string;color:Color}
 |{kind:'video';width:number;height:number;codec:string;color:Color;durationMs:number;frameRate:Rational|null;averageFrameRate:Rational|null;vfr:boolean|null;frameCount:number;audio:AudioFacts|null}
 |{kind:'audio';durationMs:number;sampleRateHz:number;channels:number;codec:string;decodedSamples:number}
);
export type HiggsfieldArchiveMediaInput={path:string;expectedKind:Kind;expectedBytes:number;expectedSha256:string;signal?:AbortSignal};
export type HiggsfieldMediaInspectionLimits={timeoutMs:number;maxBytes:number;maxDimension:number;maxPixels:number;maxDurationMs:number;maxVideoFrames:number;maxDecodedPixels:number;maxDecodedSamples:number;maxProbeBytes:number;maxAllocationBytes:number};
export type HiggsfieldMediaInspectionOptions={ffprobePath?:string;ffmpegPath?:string;limits?:Partial<HiggsfieldMediaInspectionLimits>};
export type HiggsfieldMediaInspectionCode='MEDIA_INSPECTOR_UNAVAILABLE'|'MEDIA_INPUT_INVALID'|'MEDIA_BYTES_CHANGED'|'MEDIA_UNSUPPORTED'|'MEDIA_KIND_MISMATCH'|'MEDIA_LIMIT_EXCEEDED'|'MEDIA_DECODE_FAILED'|'MEDIA_INSPECTION_ABORTED'|'MEDIA_INSPECTION_TIMEOUT';
const messages:Record<HiggsfieldMediaInspectionCode,string>={MEDIA_INSPECTOR_UNAVAILABLE:'The configured media decoder is unavailable or unsupported.',MEDIA_INPUT_INVALID:'Use one trusted regular local scratch file with exact byte evidence.',MEDIA_BYTES_CHANGED:'The scratch file no longer matches its expected bytes.',MEDIA_UNSUPPORTED:'This media format or stream layout is unsupported.',MEDIA_KIND_MISMATCH:'Decoded media does not match the expected output kind.',MEDIA_LIMIT_EXCEEDED:'The media exceeds the configured inspection limits.',MEDIA_DECODE_FAILED:'The complete media could not be decoded and verified.',MEDIA_INSPECTION_ABORTED:'Media inspection was stopped.',MEDIA_INSPECTION_TIMEOUT:'Media inspection exceeded its time limit.'};
export class HiggsfieldMediaInspectionError extends Error{constructor(readonly code:HiggsfieldMediaInspectionCode){super(messages[code]);this.name='HiggsfieldMediaInspectionError';}}
function fail(code:HiggsfieldMediaInspectionCode):never{throw new HiggsfieldMediaInspectionError(code);}
const defaults:HiggsfieldMediaInspectionLimits={timeoutMs:60000,maxBytes:512*1024**2,maxDimension:8192,maxPixels:32*1024**2,maxDurationMs:300000,maxVideoFrames:18000,maxDecodedPixels:2_000_000_000,maxDecodedSamples:128_000_000,maxProbeBytes:16*1024**2,maxAllocationBytes:64*1024**2};
const ceilings:HiggsfieldMediaInspectionLimits={timeoutMs:300000,maxBytes:100*1024**3,maxDimension:16384,maxPixels:64*1024**2,maxDurationMs:3600000,maxVideoFrames:120000,maxDecodedPixels:100_000_000_000,maxDecodedSamples:2_000_000_000,maxProbeBytes:64*1024**2,maxAllocationBytes:256*1024**2};
type Sniff={format:Common['format'];mime:string;kind:Kind;demuxer:string};
function sniff(b:Buffer):Sniff{
 if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {format:'png',mime:'image/png',kind:'image',demuxer:'png_pipe'};
 if(b[0]===255&&b[1]===216&&b[2]===255)return {format:'jpeg',mime:'image/jpeg',kind:'image',demuxer:'jpeg_pipe'};
 if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return {format:'webp',mime:'image/webp',kind:'image',demuxer:'webp_pipe'};
 if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE')return {format:'wav',mime:'audio/wav',kind:'audio',demuxer:'wav'};
 if(b.toString('ascii',0,3)==='ID3'||b[0]===255&&(b[1]&0xe0)===0xe0)return {format:'mp3',mime:'audio/mpeg',kind:'audio',demuxer:'mp3'};
 if(b.toString('ascii',4,8)==='ftyp'){
  const brand=b.toString('ascii',8,12);if(brand==='qt  ')return {format:'mov',mime:'video/quicktime',kind:'video',demuxer:'mov'};
  if(['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','M4V '].includes(brand))return {format:'mp4',mime:'video/mp4',kind:'video',demuxer:'mov'};
 }
 return fail('MEDIA_UNSUPPORTED');
}
const normalizedPath=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
async function trustedFile(path:string){
 if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0')||/^[\\/]{2}/.test(path)||process.platform==='win32'&&path.slice(2).includes(':'))fail('MEDIA_INPUT_INVALID');
 const resolved=resolve(path);if(normalizedPath(await realpath(path))!==normalizedPath(resolved))fail('MEDIA_INPUT_INVALID');
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)fail('MEDIA_INPUT_INVALID');
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const current=await file.stat();
 if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino){await file.close();fail('MEDIA_INPUT_INVALID');}return file;
}
async function executable(value:string|undefined){if(!value||!isAbsolute(value)||value.includes('\0'))fail('MEDIA_INSPECTOR_UNAVAILABLE');try{const path=await realpath(value);if(!(await stat(path)).isFile())fail('MEDIA_INSPECTOR_UNAVAILABLE');return path;}catch{return fail('MEDIA_INSPECTOR_UNAVAILABLE');}}
async function hashFile(file:FileHandle,expected:HiggsfieldArchiveMediaInput,signal:AbortSignal){
 const before=await file.stat();if(before.size!==expected.expectedBytes)fail('MEDIA_BYTES_CHANGED');
 const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),prefix=Buffer.alloc(64);let position=0;
 while(position<before.size){signal.throwIfAborted();const read=await file.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!read.bytesRead)fail('MEDIA_BYTES_CHANGED');if(position===0)buffer.copy(prefix,0,0,Math.min(prefix.length,read.bytesRead));hash.update(buffer.subarray(0,read.bytesRead));position+=read.bytesRead;}
 const after=await file.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||hash.digest('hex')!==expected.expectedSha256)fail('MEDIA_BYTES_CHANGED');return {prefix,dev:before.dev,ino:before.ino};
}

// The MP3 decoder can conceal an incomplete last frame without a warning. Walk
// the bounded Layer III framing as well as decoding; never certify that prefix.
async function completeMp3Frames(file:FileHandle,size:number,limits:HiggsfieldMediaInspectionLimits,signal:AbortSignal){
 const header=Buffer.alloc(10);const read=async(position:number,length:number)=>{signal.throwIfAborted();if((await file.read(header,0,length,position)).bytesRead!==length)fail('MEDIA_DECODE_FAILED');};
 await read(0,Math.min(size,10));let offset=0,frames=0;
 if(header.toString('ascii',0,3)==='ID3'){
  if(size<10||![2,3,4].includes(header[3])||header.subarray(6,10).some(n=>n>127))fail('MEDIA_DECODE_FAILED');
  const tagBytes=header[6]*2**21+header[7]*2**14+header[8]*2**7+header[9];offset=10+tagBytes+(header[3]===4&&(header[5]&16)?10:0);if(offset>=size)fail('MEDIA_DECODE_FAILED');
 }
 const mpeg1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],mpeg2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
 while(offset<size){
  if(size-offset<4)fail('MEDIA_DECODE_FAILED');await read(offset,4);
  if(size-offset===128&&header.toString('ascii',0,3)==='TAG'){offset=size;break;}
  const bits=header.readUInt32BE(0),version=(bits>>>19)&3,layer=(bits>>>17)&3,rate=(bits>>>10)&3,bitrate=(bits>>>12)&15;
  if(bits>>>21!==2047||version===1||layer!==1||rate===3||bitrate===0||bitrate===15)fail('MEDIA_DECODE_FAILED');
  const sampleRate=[44100,48000,32000][rate]/(version===3?1:version===2?2:4),kbps=(version===3?mpeg1:mpeg2)[bitrate];
  const length=Math.floor((version===3?144:72)*kbps*1000/sampleRate)+((bits>>>9)&1);if(length>size-offset||length<6)fail('MEDIA_DECODE_FAILED');offset+=length;
  if(++frames>Math.ceil(limits.maxDecodedSamples/576)+4)fail('MEDIA_LIMIT_EXCEEDED');
 }
 if(!frames)fail('MEDIA_DECODE_FAILED');
}
type Json=Record<string,any>;
function integer(value:unknown,max:number){const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1||n>max)fail('MEDIA_LIMIT_EXCEEDED');return n;}
function rational(value:unknown):Rational|null{if(typeof value!=='string'||!/^\d+\/\d+$/.test(value))return null;const[n,d]=value.split('/').map(Number);if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||n<1||d<1)return null;const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a,g=gcd(n,d);return {numerator:n/g,denominator:d/g};}
const tag=(value:unknown)=>typeof value==='string'&&value.length<=80&&!['unknown','unspecified','reserved','N/A'].includes(value)&&/^[A-Za-z0-9_. -]+$/.test(value)?value:null;
const color=(stream:Json):Color=>({space:tag(stream.color_space),primaries:tag(stream.color_primaries),transfer:tag(stream.color_transfer),range:tag(stream.color_range)});
const videoCodecs=new Set(['h264','hevc','av1','mpeg4','prores']);
const audioCodecs=new Set(['aac','mp3','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','pcm_u8']);
// Decoder names can differ from the codec names reported in stream metadata.
const audioDecoders=[...audioCodecs,'mp3float'];
const videoDecoders=[...videoCodecs,'libdav1d','libaom-av1'];
function audioFacts(stream:Json):AudioFacts{if(!audioCodecs.has(stream.codec_name))fail('MEDIA_UNSUPPORTED');return {codec:stream.codec_name,sampleRateHz:integer(stream.sample_rate,384000),channels:integer(stream.channels,8)};}
function dimensions(stream:Json,limits:HiggsfieldMediaInspectionLimits){const width=integer(stream.width,limits.maxDimension),height=integer(stream.height,limits.maxDimension);if(width*height>limits.maxPixels)fail('MEDIA_LIMIT_EXCEEDED');return {width,height};}
function duration(value:unknown,limits:HiggsfieldMediaInspectionLimits){const n=typeof value==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(value)?Number(value):NaN;if(!Number.isFinite(n)||n<=0)fail('MEDIA_DECODE_FAILED');if(n*1000>limits.maxDurationMs)fail('MEDIA_LIMIT_EXCEEDED');return Math.round(n*1000);}

/** Every child gets only the already-validated file as seekable stdin. No filename,
 * URL, company credentials or inherited provider environment reaches the decoder. */
async function run(binary:string,args:string[],input:HiggsfieldArchiveMediaInput,identity:{dev:number;ino:number},limits:HiggsfieldMediaInspectionLimits,signal:AbortSignal){
 signal.throwIfAborted();const file=await trustedFile(input.path);try{
  const info=await file.stat();if(info.dev!==identity.dev||info.ino!==identity.ino||info.size!==input.expectedBytes)fail('MEDIA_BYTES_CHANGED');
  return await new Promise<string>((done,reject)=>{
   const child=spawn(binary,args,{shell:false,windowsHide:true,cwd:dirname(input.path),stdio:[file.fd,'pipe','pipe'],env:{NODE_ENV:'production',LANG:'C',LC_ALL:'C',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})}});
   const chunks:Buffer[]=[];let bytes=0,stderr=0,reason:HiggsfieldMediaInspectionCode|undefined;
   const kill=(code:HiggsfieldMediaInspectionCode)=>{reason??=code;child.kill('SIGKILL');};
   const abort=()=>kill(signal.reason instanceof HiggsfieldMediaInspectionError?signal.reason.code:'MEDIA_INSPECTION_ABORTED');
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   child.stdout!.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limits.maxProbeBytes)kill('MEDIA_LIMIT_EXCEEDED');else chunks.push(chunk);});
   child.stderr!.on('data',(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>64*1024)kill('MEDIA_LIMIT_EXCEEDED');});
   child.on('error',()=>{reason='MEDIA_INSPECTOR_UNAVAILABLE';});
   child.on('close',code=>{signal.removeEventListener('abort',abort);if(reason)return reject(new HiggsfieldMediaInspectionError(reason));if(code!==0||stderr)return reject(new HiggsfieldMediaInspectionError('MEDIA_DECODE_FAILED'));done(Buffer.concat(chunks).toString('utf8'));});
  });
 }finally{await file.close();}
}

export async function inspectHiggsfieldArchiveMedia(input:HiggsfieldArchiveMediaInput,options:HiggsfieldMediaInspectionOptions={}):Promise<HiggsfieldMediaDescriptor>{
 const limits={...defaults,...options.limits};for(const key of Object.keys(defaults) as (keyof HiggsfieldMediaInspectionLimits)[])if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>ceilings[key])fail('MEDIA_INPUT_INVALID');
 if(!['image','video','audio'].includes(input.expectedKind)||!Number.isSafeInteger(input.expectedBytes)||input.expectedBytes<1||input.expectedBytes>limits.maxBytes||!/^[a-f0-9]{64}$/.test(input.expectedSha256))fail('MEDIA_INPUT_INVALID');
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(new HiggsfieldMediaInspectionError('MEDIA_INSPECTION_TIMEOUT')),limits.timeoutMs),signal=AbortSignal.any([abort.signal,...input.signal?[input.signal]:[]]);let file:FileHandle|undefined;
 try{
  signal.throwIfAborted();const ffprobe=await executable(options.ffprobePath??process.env.COATRIA_FFPROBE_PATH),ffmpeg=await executable(options.ffmpegPath??process.env.COATRIA_FFMPEG_PATH);
  file=await trustedFile(input.path);const identity=await hashFile(file,input,signal),type=sniff(identity.prefix);if(type.kind!==input.expectedKind)fail('MEDIA_KIND_MISMATCH');
  if(type.format==='mp3')await completeMp3Frames(file,input.expectedBytes,limits,signal);
  const decoder=type.format==='png'?'png':type.format==='jpeg'?'mjpeg':type.format==='webp'?'webp':null;
  const codecList=decoder?[decoder]:type.kind==='audio'?audioDecoders:[...videoDecoders,...audioDecoders];
  // Fail closed on decoder warnings as well: e.g. truncated MP3 may otherwise
  // decode a valid prefix and return exit 0. Explicit demuxers avoid guess warnings.
  const common=['-v','warning','-max_alloc',String(limits.maxAllocationBytes),'-threads','1','-max_pixels',String(limits.maxPixels),'-protocol_whitelist','fd','-format_whitelist',type.demuxer,'-codec_whitelist',codecList.join(','),'-probesize','5242880','-analyzeduration','5000000','-f',type.demuxer,...type.demuxer==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[],'-fd','0'];
  const fields='stream=index,codec_type,codec_name,width,height,sample_rate,channels,time_base,avg_frame_rate,duration,color_space,color_primaries,color_transfer,color_range:format=duration';
  const parse=(text:string):Json=>{try{const value=JSON.parse(text);if(!value||typeof value!=='object'||!Array.isArray(value.streams))fail('MEDIA_DECODE_FAILED');return value;}catch{return fail('MEDIA_DECODE_FAILED');}};
  const metadata=parse(await run(ffprobe,[...common,'-show_entries',fields,'-of','json','fd:'],input,identity,limits,signal));
  const streams=metadata.streams as Json[],video=streams.filter(s=>s.codec_type==='video'),audio=streams.filter(s=>s.codec_type==='audio');
  if(streams.length!==video.length+audio.length||video.length>1||audio.length>1||!streams.length)fail('MEDIA_UNSUPPORTED');
  if(type.kind==='image'&&(video.length!==1||audio.length)||type.kind==='video'&&video.length!==1||type.kind==='audio'&&(audio.length!==1||video.length))fail('MEDIA_KIND_MISMATCH');
  const visual=video[0],sound=audio[0];if(visual){dimensions(visual,limits);if(decoder?visual.codec_name!==decoder:!videoCodecs.has(visual.codec_name))fail('MEDIA_UNSUPPORTED');}if(sound)audioFacts(sound);
  if(type.kind!=='image')duration(metadata.format?.duration??(type.kind==='audio'?sound:visual).duration,limits);
  await run(ffmpeg,['-nostdin',...common,'-err_detect','explode','-xerror','-guess_layout_max','0','-i','fd:','-map','0:v?','-map','0:a?','-threads','1','-filter_threads','1','-filter_complex_threads','1','-f','null','-'],input,identity,limits,signal);
  const decoded=parse(await run(ffprobe,[...common,'-err_detect','explode','-show_frames','-show_entries',fields+':frame=media_type,best_effort_timestamp,duration,pkt_duration,width,height,nb_samples','-of','json','fd:'],input,identity,limits,signal));
  if(!Array.isArray(decoded.frames))fail('MEDIA_DECODE_FAILED');const frames=decoded.frames as Json[],visualFrames=frames.filter(f=>f.media_type==='video'),audioFrames=frames.filter(f=>f.media_type==='audio');
  if(frames.length!==visualFrames.length+audioFrames.length||visualFrames.length>limits.maxVideoFrames)fail('MEDIA_LIMIT_EXCEEDED');
  let pixels=0,samples=0;for(const frame of visualFrames){const size=dimensions(frame,limits);if(size.width!==visual.width||size.height!==visual.height)fail('MEDIA_UNSUPPORTED');pixels+=size.width*size.height;if(pixels>limits.maxDecodedPixels)fail('MEDIA_LIMIT_EXCEEDED');}
  for(const frame of audioFrames){samples+=integer(frame.nb_samples,limits.maxDecodedSamples);if(samples*(sound?.channels??1)>limits.maxDecodedSamples)fail('MEDIA_LIMIT_EXCEEDED');}
  if(sound&&samples/audioFacts(sound).sampleRateHz*1000>limits.maxDurationMs)fail('MEDIA_LIMIT_EXCEEDED');
  const finalIdentity=await hashFile(file,input,signal),pathInfo=await lstat(input.path);if(finalIdentity.dev!==identity.dev||finalIdentity.ino!==identity.ino||pathInfo.dev!==identity.dev||pathInfo.ino!==identity.ino||pathInfo.isSymbolicLink())fail('MEDIA_BYTES_CHANGED');
  const base:Common={format:type.format,contentType:type.mime,bytes:input.expectedBytes,sha256:input.expectedSha256,verification:'full_decode',inspectionVersion:1};
  if(type.kind==='image'){if(visualFrames.length!==1)fail('MEDIA_UNSUPPORTED');return {...base,kind:'image',...dimensions(visual,limits),codec:visual.codec_name,color:color(visual)};}
  if(type.kind==='audio'){if(!samples)fail('MEDIA_DECODE_FAILED');const facts=audioFacts(sound),durationMs=Math.round(samples/facts.sampleRateHz*1000);if(!durationMs||durationMs>limits.maxDurationMs)fail('MEDIA_LIMIT_EXCEEDED');return {...base,kind:'audio',...facts,durationMs,decodedSamples:samples};}
  if(!visualFrames.length||sound&&!samples)fail('MEDIA_DECODE_FAILED');
  const timebase=rational(visual.time_base),pts=visualFrames.map(f=>f.best_effort_timestamp),validPts=pts.every(p=>typeof p==='number'&&Number.isSafeInteger(p));let vfr:boolean|null=null,frameRate:Rational|null=null;
  if(!validPts||!timebase)fail('MEDIA_DECODE_FAILED');
  const intervals=pts.slice(1).map((p,i)=>p-pts[i]);if(intervals.some(n=>n<=0))fail('MEDIA_DECODE_FAILED');
  if(pts.length>=3){vfr=intervals.some(n=>n!==intervals[0]);if(!vfr)frameRate=rational(`${timebase.denominator}/${timebase.numerator*intervals[0]}`);}
  // Measure the decoded visual timeline, rather than trusting a container's
  // claimed duration. Missing terminal-frame timing cannot establish this fact.
  const last=visualFrames[visualFrames.length-1],lastDuration=last.duration??last.pkt_duration;
  if(typeof lastDuration!=='number'||!Number.isSafeInteger(lastDuration)||lastDuration<1)fail('MEDIA_DECODE_FAILED');
  const span=pts[pts.length-1]-pts[0]+lastDuration;if(!Number.isSafeInteger(span)||span<1)fail('MEDIA_DECODE_FAILED');
  const durationMs=Math.round(span*timebase.numerator/timebase.denominator*1000);if(durationMs<1||durationMs>limits.maxDurationMs)fail('MEDIA_LIMIT_EXCEEDED');
  return {...base,kind:'video',...dimensions(visual,limits),codec:visual.codec_name,color:color(visual),durationMs,frameRate,averageFrameRate:rational(visual.avg_frame_rate),vfr,frameCount:visualFrames.length,audio:sound?audioFacts(sound):null};
 }catch(error){if(signal.aborted)throw signal.reason instanceof HiggsfieldMediaInspectionError?signal.reason:new HiggsfieldMediaInspectionError('MEDIA_INSPECTION_ABORTED');if(error instanceof HiggsfieldMediaInspectionError)throw error;throw new HiggsfieldMediaInspectionError('MEDIA_INPUT_INVALID');}
 finally{clearTimeout(timer);await file?.close();}
}
