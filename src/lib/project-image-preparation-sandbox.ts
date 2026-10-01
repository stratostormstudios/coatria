/** Production-capable local Linux transform boundary. A genuine sandbox and
 * actual binary capability check are necessary; neither is tenant execution
 * approval, processor enrollment, a host qualification receipt or storage
 * authority. No native fixture fallback or provider access exists here. */
import {constants,type Stats} from 'node:fs';
import {lstat,open,realpath,mkdtemp,rm,type FileHandle} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {crc32,deflateSync,inflateSync} from 'node:zlib';
import {isQualifiedLinuxImageMediaSandbox,MediaSandboxError,type QualifiedLinuxMediaSandbox,type QualifiedLinuxImageMediaSandbox} from './higgsfield-media-sandbox';
import {fixedImagePreparationCommand,IMAGE_PREPARATION_RECIPE_HASH,type ImagePreparationInput,type PreparedReferenceImage} from './higgsfield-image-preparation';
import {inspectPreparationSource} from './higgsfield-image-preparation-source';
import {validatePreparedPng} from './higgsfield-image-preparation-png';
import {IMAGE_PREPARATION_POLICY as policy,ImagePreparationError,preparationDigest,preparationFail as fail} from './higgsfield-image-preparation-policy';

export type QualifiedLinuxImagePreparationTransform=((input:ImagePreparationInput)=>Promise<PreparedReferenceImage>)&Readonly<{
 profileSha256:string;recipeSha256:string;
}>;
export type LinuxImagePreparationTransformOptions={sandbox:QualifiedLinuxMediaSandbox;expectedProfileSha256:string;recipeSha256:string};
const qualified=new WeakSet<object>();
export function isQualifiedLinuxImagePreparationTransform(value:unknown):value is QualifiedLinuxImagePreparationTransform {
 return typeof value==='function'&&qualified.has(value);
}
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const pathAllowed=(value:unknown):value is string=>typeof value==='string'&&isAbsolute(value)&&!value.includes('\0')&&!value.includes('\\')&&resolve(value)===value;
function stopped(signal:AbortSignal):void {if(signal.aborted)fail(signal.reason instanceof ImagePreparationError&&signal.reason.code==='PREPARATION_TIMEOUT'?'PREPARATION_TIMEOUT':'PREPARATION_ABORTED');}
async function selectedFile(path:string){
 if(!pathAllowed(path)||await realpath(path)!==path)fail('PREPARATION_INPUT_INVALID');
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)fail('PREPARATION_INPUT_INVALID');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const actual=await file.stat();if(!actual.isFile()||actual.dev!==before.dev||actual.ino!==before.ino||actual.nlink!==1)fail('PREPARATION_INPUT_INVALID');return file;}catch(error){try{await file.close();}catch{fail('PREPARATION_CLEANUP_FAILED');}throw error;}
}
async function exactBytes(file:FileHandle,input:ImagePreparationInput,signal:AbortSignal){
 stopped(signal);const before=await file.stat();if(before.size!==input.expectedBytes||before.nlink!==1)fail('PREPARATION_BYTES_CHANGED');
 const bytes=Buffer.alloc(input.expectedBytes);
 for(let offset=0;offset<bytes.length;){stopped(signal);const read=await file.read(bytes,offset,Math.min(1024**2,bytes.length-offset),offset);if(!read.bytesRead)fail('PREPARATION_BYTES_CHANGED');offset+=read.bytesRead;}
 const after=await file.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.nlink!==1||preparationDigest(bytes)!==input.expectedSha256)fail('PREPARATION_BYTES_CHANGED');stopped(signal);return bytes;
}
async function removeOwned(directory:string,identity:Stats){
 const current=await lstat(directory);if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||await realpath(directory)!==directory)fail('PREPARATION_CLEANUP_FAILED');
 await rm(directory,{recursive:true,force:false});
}
/** Cleanup mechanics only, never qualification evidence. Supervisor-owned FDs
 * can close independently; uncertain descendants or local closes retain the
 * named private input for explicit reconciliation instead of deleting it. */
export async function finishPrivateImagePreparationScratch(files:readonly(FileHandle|undefined)[],scratch:{path:string;identity:Stats}|undefined,descendantsDrained:boolean):Promise<void>{
 const closes=await Promise.allSettled(files.map(file=>file?.close()));
 if(!descendantsDrained||closes.some(item=>item.status==='rejected'))fail('PREPARATION_CLEANUP_FAILED');
 if(scratch)try{await removeOwned(scratch.path,scratch.identity);}catch{fail('PREPARATION_CLEANUP_FAILED');}
}
function mapSandboxError(error:unknown):never {
 if(error instanceof ImagePreparationError)throw error;
 if(error instanceof MediaSandboxError){
  if(error.code==='CLEANUP_FAILED')fail('PREPARATION_CLEANUP_FAILED');
  if(error.code==='ABORTED')fail('PREPARATION_ABORTED');
  if(error.code==='TIMEOUT')fail('PREPARATION_TIMEOUT');
  if(error.code==='OUTPUT_LIMIT')fail('PREPARATION_LIMIT_EXCEEDED');
  if(error.code==='PROCESS_FAILED')fail('PREPARATION_DECODE_FAILED');
  fail('PREPARATION_UNAVAILABLE');
 }fail('PREPARATION_INPUT_INVALID');
}

/** This private composition always calls the genuine sandbox's fixed operation.
 * The process receives only an immutable private-copy FD, never the source path. */
async function transform(sandbox:QualifiedLinuxImageMediaSandbox,input:ImagePreparationInput):Promise<PreparedReferenceImage>{
 if(!input||Object.keys(input).some(key=>!['path','expectedBytes','expectedSha256','signal'].includes(key))||!pathAllowed(input.path)||!Number.isSafeInteger(input.expectedBytes)||input.expectedBytes<1||!sha(input.expectedSha256)||input.signal!==undefined&&!(input.signal instanceof AbortSignal))fail('PREPARATION_INPUT_INVALID');
 if(input.expectedBytes>policy.sourceMaxBytes)fail('PREPARATION_LIMIT_EXCEEDED');
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new ImagePreparationError('PREPARATION_TIMEOUT')),policy.timeoutMs);
 const signal=AbortSignal.any([deadline.signal,...input.signal?[input.signal]:[]]),endsAt=performance.now()+policy.timeoutMs;
 let original:FileHandle|undefined,writer:FileHandle|undefined,snapshot:FileHandle|undefined,directory:string|undefined,directoryIdentity:Stats|undefined;
 let result:PreparedReferenceImage|undefined,cleanupUnconfirmed=false;
 try{
  stopped(signal);original=await selectedFile(input.path);const identity=await original.stat();
  const sourceBytes=await exactBytes(original,input,signal),source=inspectPreparationSource(sourceBytes),{size}=fixedImagePreparationCommand(source);
  const root=await realpath(tmpdir());directory=await mkdtemp(join(root,'coatria-preparation-sandbox-'));directoryIdentity=await lstat(directory);
  if(!directoryIdentity.isDirectory()||directoryIdentity.isSymbolicLink()||directoryIdentity.mode&0o077||await realpath(directory)!==directory)fail('PREPARATION_INPUT_INVALID');
  const snapshotPath=join(directory,'input');writer=await open(snapshotPath,'wx',0o600);await writer.writeFile(sourceBytes);await writer.close();writer=undefined;
  snapshot=await selectedFile(snapshotPath);await exactBytes(snapshot,input,signal);
  const remaining=Math.floor(endsAt-performance.now());if(remaining<1)fail('PREPARATION_TIMEOUT');
  const encoded=await sandbox.prepareImage({inputFd:snapshot.fd,source,recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,signal,timeoutMs:remaining});
  stopped(signal);const bytes=validatePreparedPng(encoded,size,true);
  await exactBytes(original,input,signal);await exactBytes(snapshot,input,signal);
  const pathInfo=await lstat(input.path);if(pathInfo.dev!==identity.dev||pathInfo.ino!==identity.ino||pathInfo.isSymbolicLink()||pathInfo.nlink!==1||await realpath(input.path)!==input.path)fail('PREPARATION_BYTES_CHANGED');
  if(performance.now()>=endsAt)fail('PREPARATION_TIMEOUT');stopped(signal);
  result={bytes,source,recipeHash:IMAGE_PREPARATION_RECIPE_HASH,output:{...size,sha256:preparationDigest(bytes),bytes:bytes.length,format:'png',pixelFormat:'rgba8',metadataRemoved:true}};
 }catch(error){
  // A killed timer or caller cannot hide unconfirmed descendant cleanup.
  if(error instanceof MediaSandboxError&&error.code==='CLEANUP_FAILED'||error instanceof ImagePreparationError&&error.code==='PREPARATION_CLEANUP_FAILED'){cleanupUnconfirmed=true;fail('PREPARATION_CLEANUP_FAILED');}
  if(signal.aborted)stopped(signal);return mapSandboxError(error);
 }finally{
  try{await finishPrivateImagePreparationScratch([original,writer,snapshot],directory&&directoryIdentity?{path:directory,identity:directoryIdentity}:undefined,!cleanupUnconfirmed&&(!directory||!!directoryIdentity));}
  finally{clearTimeout(timer);}
 }
 if(performance.now()>=endsAt)fail('PREPARATION_TIMEOUT');stopped(signal);if(!result)fail('PREPARATION_OUTPUT_INVALID');return result;
}

function qualificationPng(){
 const chunk=(name:string,data:Buffer)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4,'latin1');data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,12,34,56,128]))),chunk('IEND',Buffer.alloc(0))]);
}
function assertQualificationPixels(bytes:Buffer){
 const data:Buffer[]=[];for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at);if(bytes.toString('latin1',at+4,at+8)==='IDAT')data.push(bytes.subarray(at+8,at+8+length));at+=length+12;}
 const decoded=inflateSync(Buffer.concat(data),{maxOutputLength:5});
 // Every legal filter predicts zero for each channel of this one-pixel image.
 if(decoded.length!==5||decoded[0]>4||!decoded.subarray(1).equals(Buffer.from([12,34,56,128])))fail('PREPARATION_UNAVAILABLE');
}

export async function createLinuxImagePreparationTransform(options:LinuxImagePreparationTransformOptions):Promise<QualifiedLinuxImagePreparationTransform>{
 if(!options||Object.keys(options).sort().join(',')!=='expectedProfileSha256,recipeSha256,sandbox'||!isQualifiedLinuxImageMediaSandbox(options.sandbox)||!sha(options.expectedProfileSha256)||options.sandbox.profileSha256!==options.expectedProfileSha256||options.recipeSha256!==IMAGE_PREPARATION_RECIPE_HASH)fail('PREPARATION_UNAVAILABLE');
 const {sandbox,expectedProfileSha256}=options;
 let directory:string|undefined,identity:Stats|undefined,cleanupUnconfirmed=false;
 try{
  const root=await realpath(tmpdir());directory=await mkdtemp(join(root,'coatria-preparation-qualification-'));identity=await lstat(directory);
  const bytes=qualificationPng(),path=join(directory,'synthetic.png');const writer=await open(path,'wx',0o600);try{await writer.writeFile(bytes);}finally{try{await writer.close();}catch{fail('PREPARATION_CLEANUP_FAILED');}}
  const result=await transform(sandbox,{path,expectedBytes:bytes.length,expectedSha256:preparationDigest(bytes)});
  if(result.recipeHash!==IMAGE_PREPARATION_RECIPE_HASH||result.output.width!==1||result.output.height!==1)fail('PREPARATION_UNAVAILABLE');assertQualificationPixels(result.bytes);
 }catch(error){if(error instanceof ImagePreparationError&&error.code==='PREPARATION_CLEANUP_FAILED'){cleanupUnconfirmed=true;throw error;}fail('PREPARATION_UNAVAILABLE');}
 finally{await finishPrivateImagePreparationScratch([],directory&&identity?{path:directory,identity}:undefined,!cleanupUnconfirmed&&(!directory||!!identity));}
 const run=Object.freeze(Object.assign((input:ImagePreparationInput)=>transform(sandbox,input),{profileSha256:expectedProfileSha256,recipeSha256:IMAGE_PREPARATION_RECIPE_HASH}));
 qualified.add(run);return run;
}
