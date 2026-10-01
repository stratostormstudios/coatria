/** A separate Firecracker boundary. Candidate execution is deliberately not
 * production qualification. The trusted controller retains every credential,
 * source locator, lease, spending reservation and storage mutation. */
import {createHash,randomUUID} from 'node:crypto';
import {constants,fstatSync,readSync} from 'node:fs';
import {access,lstat,open,realpath,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {MediaSandboxError,type MediaSandboxRun} from './higgsfield-media-sandbox';

export const VERCEL_MEDIA_IMAGE='vercel/sandbox/universal@sha256:112a1b3ad9ae53b6f9a6afbd9a102b62bcc3017db0b8465fa35fe1e3aa386b6d';
export const VERCEL_MEDIA_CHECKS=['seven-formats','malformed-media','network-denied','external-secrets-denied','resource-output-bounds','normal-descendant-cleanup','abort-descendant-cleanup','ttl-controller-loss','ambiguous-create-reconciliation','identity-drift-rejected'] as const;
export type VercelMediaLimits=Readonly<{maxInputBytes:number;maxClosureBytes:number;timeoutMs:number;maxOutputBytes:number;maxStderrBytes:number}>;
export type VercelMediaClosure={root:string;files:ReadonlyArray<{path:string;bytes:number;sha256:string}>;loader?:string;libraryDirectories?:readonly string[]};
export type VercelMediaIntent=Readonly<{id:string;name:string;teamId:string;projectId:string;region:'iad1';image:string;closureSha256:string;inputSha256:string;inputBytes:number;tool:'ffprobe'|'ffmpeg';ttlMs:number;vcpus:2;memoryMiB:4096}>;
export type VercelMediaJournalEvent=Readonly<{type:'created'|'create-unknown'|'cleanup-intent'|'terminal'|'cleanup-unknown';intentId:string;name:string;sessionId?:string;status?:string}>;
export type VercelMediaSandboxOptions={teamId:string;projectId:string;region:'iad1';token:()=>Promise<string>;closure:VercelMediaClosure;limits:VercelMediaLimits;journal:{reserve:(intent:VercelMediaIntent)=>Promise<void>;record:(event:VercelMediaJournalEvent)=>Promise<void>;authorize:(intent:VercelMediaIntent)=>Promise<void>}};
export type VercelMediaQualificationBinding=Readonly<{teamId:string;projectId:string;region:'iad1';image:string;closureSha256:string;limits:VercelMediaLimits}>;
export type VercelMediaQualification=VercelMediaQualificationBinding&{version:1;backend:'vercel-firecracker';mode:'live-provider';issuedAtMs:number;expiresAtMs:number;checks:Record<typeof VERCEL_MEDIA_CHECKS[number],true>;evidence:ReadonlyArray<{sessionId:string;sha256:string}>};
export type VercelMediaSandboxCandidate=Readonly<{run:(input:MediaSandboxRun)=>Promise<string>;qualificationBinding:VercelMediaQualificationBinding}>;
export type QualifiedVercelMediaSandbox=VercelMediaSandboxCandidate;
const qualified=new WeakSet<object>();
export const isQualifiedVercelMediaSandbox=(value:unknown):value is QualifiedVercelMediaSandbox=>!!value&&typeof value==='object'&&qualified.has(value);
const nativeFetch=globalThis.fetch.bind(globalThis);
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:object,expected:readonly string[])=>Object.keys(v).length===expected.length&&Object.keys(v).every(k=>expected.includes(k));
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
function fail(code:ConstructorParameters<typeof MediaSandboxError>[0]):never{throw new MediaSandboxError(code);}
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const sessionId=(v:unknown):v is string=>identifier(v)&&v.startsWith('sbx_');
const relative=(v:unknown):v is string=>typeof v==='string'&&v.length<=70&&/^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(v)&&!v.split('/').some(x=>x==='.'||x==='..');
const terminal=(v:unknown)=>v==='stopped'||v==='failed'||v==='aborted';
/** Only the inspector's decoder vocabulary is accepted. Even trusted callers
 * cannot accidentally place a source URL, bearer value or local filename into
 * a guest command. fd: is the sole input and null/stdout the sole output. */
function decoderArgs(tool:'ffmpeg'|'ffprobe',args:readonly string[]){
 const numeric=new Set(['-max_alloc','-max_pixels','-probesize','-analyzeduration']);
 const fixed:Record<string,readonly string[]>={'-v':['warning','error'],'-threads':['1'],'-filter_threads':['1'],'-filter_complex_threads':['1'],'-protocol_whitelist':['fd'],'-fd':['0'],'-enable_drefs':['0'],'-use_absolute_path':['0'],'-err_detect':['explode'],'-guess_layout_max':['0'],'-map':['0:v?','0:a?'],'-of':['json'],'-i':['fd:'],'-f':['png_pipe','jpeg_pipe','webp_pipe','mov','wav','mp3','null'],'-format_whitelist':['png_pipe','jpeg_pipe','webp_pipe','mov','wav','mp3']};
 const switches=new Set(['-nostdin','-xerror','-show_frames','-show_format']);let fd=0,protocol=0,inputs=0,outputs=0;
 for(let i=0;i<args.length;i++){
  const name=args[i];if(name==='fd:'&&tool==='ffprobe'&&i===args.length-1){inputs++;continue;}if(name==='-'&&tool==='ffmpeg'&&i===args.length-1){outputs++;continue;}
  if(switches.has(name))continue;const value=args[++i];if(typeof value!=='string')fail('INPUT_INVALID');
  if(Object.hasOwn(fixed,name)){if(!fixed[name].includes(value))fail('INPUT_INVALID');}
  else if(numeric.has(name)){if(!/^[1-9][0-9]{0,9}$/.test(value)||Number(value)>1024**3)fail('INPUT_INVALID');}
  else if(name==='-codec_whitelist'){const allowed=new Set(['png','mjpeg','webp','h264','hevc','av1','mpeg4','prores','libdav1d','libaom-av1','aac','mp3','mp3float','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','pcm_u8']);if(!value.split(',').every(v=>allowed.has(v)))fail('INPUT_INVALID');}
  else if(name==='-show_entries'){const allowed=new Set(['stream','format','frame','index','codec_type','codec_name','width','height','sample_rate','channels','time_base','avg_frame_rate','duration','color_space','color_primaries','color_transfer','color_range','media_type','best_effort_timestamp','pkt_duration','nb_samples']);if(!value.split(/[=:,]/).every(v=>allowed.has(v)))fail('INPUT_INVALID');}
  else fail('INPUT_INVALID');
  if(name==='-protocol_whitelist')protocol++;if(name==='-fd')fd++;if(name==='-i')inputs++;
 }
 if(fd!==1||protocol!==1||inputs!==1||tool==='ffmpeg'&&(outputs!==1||args.at(-3)!=='-f'||args.at(-2)!=='null'))fail('INPUT_INVALID');
}
function limits(value:unknown):VercelMediaLimits{
 if(!object(value)||!keys(value,['maxInputBytes','maxClosureBytes','timeoutMs','maxOutputBytes','maxStderrBytes'])||!integer(value.maxInputBytes,1,128*1024**2)||!integer(value.maxClosureBytes,1,256*1024**2)||!integer(value.timeoutMs,1000,120000)||!integer(value.maxOutputBytes,1,64*1024**2)||!integer(value.maxStderrBytes,1,65536))fail('INVALID_PROFILE');
 return Object.freeze({...value}) as VercelMediaLimits;
}
/** Operator acceptance is hash-pinned evidence, not remote attestation. This
 * parser cannot brand an executor or establish that a live test happened. */
export function parseVercelMediaQualification(value:unknown,binding:VercelMediaQualificationBinding,now=Date.now()):VercelMediaQualification{
 if(!object(value)||!keys(value,['version','backend','mode','teamId','projectId','region','image','closureSha256','limits','issuedAtMs','expiresAtMs','checks','evidence'])||value.version!==1||value.backend!=='vercel-firecracker'||value.mode!=='live-provider'||['teamId','projectId','region','image','closureSha256'].some(k=>value[k]!==binding[k as keyof VercelMediaQualificationBinding]))fail('INVALID_PROFILE');
 const l=limits(value.limits);if(Object.keys(l).some(k=>l[k as keyof VercelMediaLimits]!==binding.limits[k as keyof VercelMediaLimits]))fail('INVALID_PROFILE');
 if(!integer(value.issuedAtMs,1,now)||!integer(value.expiresAtMs,now+1,value.issuedAtMs+7*86400000)||!object(value.checks)||!keys(value.checks,VERCEL_MEDIA_CHECKS)||!VERCEL_MEDIA_CHECKS.every(k=>value.checks&&object(value.checks)&&value.checks[k]===true)||!Array.isArray(value.evidence)||value.evidence.length<1||value.evidence.length>64)fail('INVALID_PROFILE');
 const seen=new Set<string>();const evidence=value.evidence.map(e=>{if(!object(e)||!keys(e,['sessionId','sha256'])||!sessionId(e.sessionId)||!sha(e.sha256)||seen.has(e.sessionId))fail('INVALID_PROFILE');seen.add(e.sessionId);return Object.freeze({sessionId:e.sessionId,sha256:e.sha256});});
 return Object.freeze({...binding,limits:l,version:1,backend:'vercel-firecracker',mode:'live-provider',issuedAtMs:value.issuedAtMs,expiresAtMs:value.expiresAtMs,checks:Object.freeze({...value.checks}),evidence:Object.freeze(evidence)}) as VercelMediaQualification;
}

async function immutable(path:string,directory=false){
 if(await realpath(path)!==resolve(path))fail('INVALID_PROFILE');
 let current=resolve(path),first=true;
 for(;;){const s=await lstat(current);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)||(first?!directory&&(!s.isFile()||s.nlink!==1)||directory&&!s.isDirectory():!s.isDirectory()))fail('INVALID_PROFILE');
  try{await access(current,constants.W_OK);fail('INVALID_PROFILE');}catch(e){if(e instanceof MediaSandboxError)throw e;if(!['EACCES','EROFS'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
  const parent=dirname(current);if(parent===current)break;current=parent;first=false;
 }
}
type ClosureFile={path:string;bytes:number;sha256:string;content:Buffer};
async function loadClosure(value:VercelMediaClosure,maxBytes:number,production:boolean){
 if(!value||typeof value.root!=='string'||resolve(value.root)!==value.root||!Array.isArray(value.files)||value.files.length<2||value.files.length>64)fail('INVALID_PROFILE');
 if(production)await immutable(value.root,true);
 const seen=new Set<string>(),files:ClosureFile[]=[];let total=0;
 for(const entry of value.files){
  if(!entry||!keys(entry,['path','bytes','sha256'])||!relative(entry.path)||!sha(entry.sha256)||!integer(entry.bytes,1,maxBytes)||seen.has(entry.path))fail('INVALID_PROFILE');seen.add(entry.path);total+=entry.bytes;if(total>maxBytes)fail('INVALID_PROFILE');
  const path=join(value.root,entry.path);if(await realpath(path)!==path)fail('INVALID_PROFILE');if(production)await immutable(path);
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.size!==entry.bytes)fail('INVALID_PROFILE');const content=await f.readFile();if(content.length!==entry.bytes||hash(content)!==entry.sha256)fail('INVALID_PROFILE');files.push({...entry,content});}finally{await f.close();}
 }
 if(!seen.has('bin/ffmpeg')||!seen.has('bin/ffprobe')||value.loader!==undefined&&(!relative(value.loader)||!seen.has(value.loader)))fail('INVALID_PROFILE');
 const libraryDirectories=[...(value.libraryDirectories??[])];if(libraryDirectories.length>16||libraryDirectories.some(d=>!relative(d)||!files.some(f=>f.path.startsWith(d+'/'))))fail('INVALID_PROFILE');
 if(!value.loader&&libraryDirectories.length)fail('INVALID_PROFILE');
 const manifest=Object.freeze({files:Object.freeze(files.map(({path,bytes,sha256})=>Object.freeze({path,bytes,sha256}))),loader:value.loader??null,libraryDirectories:Object.freeze(libraryDirectories)});
 return {files,manifest,sha256:hash(JSON.stringify(manifest))};
}

// Only these fixed files and manifest-validated closure entries enter the tar.
function tar(files:ReadonlyArray<{path:string;content:Buffer;mode:number}>):Buffer{
 const blocks:Buffer[]=[];
 for(const f of files){if(f.path.length>100)fail('INVALID_PROFILE');const h=Buffer.alloc(512);h.write(f.path,0,100,'ascii');
  const oct=(offset:number,len:number,n:number)=>h.write(n.toString(8).padStart(len-1,'0')+'\0',offset,len,'ascii');
  oct(100,8,f.mode);oct(108,8,0);oct(116,8,0);oct(124,12,f.content.length);oct(136,12,0);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257,6,'ascii');h.write('00',263,2,'ascii');oct(148,8,h.reduce((a,b)=>a+b,0));blocks.push(h,f.content,Buffer.alloc((512-f.content.length%512)%512));
 }blocks.push(Buffer.alloc(1024));return Buffer.concat(blocks);
}

/** Fixed launcher: no shell, URLs, user filenames, inherited environment or
 * storage/provider credentials. The microVM is still the security boundary. */
const launcher=String.raw`'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const root='/vercel/coatria',j=JSON.parse(fs.readFileSync(root+'/job.json','utf8'));
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function checked(path,bytes,sha){const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size!==bytes)throw Error('pin');const b=fs.readFileSync(path);if(digest(b)!==sha)throw Error('pin');}
try{
 for(const f of j.closure.files)checked(root+'/runtime/'+f.path,f.bytes,f.sha256);
 checked(root+'/input.bin',j.inputBytes,j.inputSha256);
 const binary=root+'/runtime/bin/'+j.tool,loader=j.closure.loader&&root+'/runtime/'+j.closure.loader;
 const args=loader?['--library-path',j.closure.libraryDirectories.map(x=>root+'/runtime/'+x).join(':'),binary,...j.args]:j.args;
 const fd=fs.openSync(root+'/input.bin',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 const child=cp.spawn(loader||binary,args,{shell:false,cwd:root,env:{LANG:'C',LC_ALL:'C'},detached:true,stdio:[fd,'pipe','pipe']});
 fs.closeSync(fd);let bytes=0,errors=0,failed=false;const chunks=[];
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
 const timer=setTimeout(()=>{failed=true;kill();},j.timeoutMs);
 child.stdout.on('data',b=>{bytes+=b.length;if(bytes>j.maxOutputBytes){failed=true;kill();}else chunks.push(b);});
 child.stderr.on('data',b=>{errors+=b.length;if(errors>j.maxStderrBytes){failed=true;kill();}});
 child.on('error',()=>{failed=true;kill();});
 child.on('exit',()=>kill());
 child.on('close',code=>{clearTimeout(timer);kill();if(failed||code!==0||errors){process.exitCode=1;return;}
 process.stdout.write(JSON.stringify({version:1,inputBytes:j.inputBytes,inputSha256:j.inputSha256,stdout:Buffer.concat(chunks).toString('base64')})+'\n');});
}catch{process.exitCode=1;}
`;

async function bytes(response:Response,max:number):Promise<Buffer>{
 if(!response.body)fail('PROCESS_FAILED');const reader=response.body.getReader(),parts:Buffer[]=[];let n=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>max)fail('OUTPUT_LIMIT');parts.push(Buffer.from(value));}return Buffer.concat(parts);}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function withSignal<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();let onAbort:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
 try{return await Promise.race([work,aborted]);}finally{signal.removeEventListener('abort',onAbort);}
}
async function json(response:Response,max=1024*1024):Promise<Record<string,unknown>>{
 if(!response.ok){await response.body?.cancel().catch(()=>{});fail('SANDBOX_UNAVAILABLE');}
 let value:unknown;try{value=JSON.parse((await bytes(response,max)).toString('utf8'));}catch(e){if(e instanceof MediaSandboxError)throw e;fail('PROCESS_FAILED');}if(!object(value))fail('PROCESS_FAILED');return value;
}
function inputFile(fd:number,max:number,signal:AbortSignal){
 const before=fstatSync(fd);if(!before.isFile()||before.size<1||before.size>max)fail('INPUT_INVALID');const content=Buffer.alloc(before.size);let position=0;
 while(position<content.length){signal.throwIfAborted();const n=readSync(fd,content,position,Math.min(1024*1024,content.length-position),position);if(!n)fail('INPUT_INVALID');position+=n;}
 const after=fstatSync(fd);if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('INPUT_INVALID');return content;
}

/** Unbranded candidate for an explicitly authorized qualification run. Injected
 * transport is test-only and cannot create an inspector-accepted executor. */
export async function createVercelMediaSandboxCandidate(options:VercelMediaSandboxOptions,testOnly?:{fetch:typeof fetch}):Promise<VercelMediaSandboxCandidate>{
 if(testOnly&&process.env.NODE_ENV==='production')fail('INVALID_PROFILE');return construct(options,testOnly?.fetch??nativeFetch,false);
}
export async function createVercelMediaSandbox(options:VercelMediaSandboxOptions,qualification:{receiptPath:string;sha256:string}):Promise<QualifiedVercelMediaSandbox>{
 if(process.platform!=='linux'||process.arch!=='x64'||!process.getuid||process.getuid()===0||!qualification||!sha(qualification.sha256))fail('INVALID_PROFILE');
 await immutable(qualification.receiptPath);if((await lstat(qualification.receiptPath)).size>65536)fail('INVALID_PROFILE');const receiptBytes=await readFile(qualification.receiptPath);if(receiptBytes.length>65536||hash(receiptBytes)!==qualification.sha256)fail('INVALID_PROFILE');
 let acceptedUntil=0;const candidate=await construct(options,nativeFetch,true,()=>{if(Date.now()>=acceptedUntil)fail('INVALID_PROFILE');});
 let receipt:unknown;try{receipt=JSON.parse(receiptBytes.toString('utf8'));}catch{fail('INVALID_PROFILE');}
 acceptedUntil=parseVercelMediaQualification(receipt,candidate.qualificationBinding).expiresAtMs;qualified.add(candidate);return candidate;
}

async function construct(options:VercelMediaSandboxOptions,fetcher:typeof fetch,production:boolean,checkQualification=()=>{}):Promise<VercelMediaSandboxCandidate>{
 if(!identifier(options.teamId)||!identifier(options.projectId)||options.region!=='iad1'||typeof options.token!=='function'||!options.journal||['reserve','record','authorize'].some(k=>typeof options.journal[k as keyof typeof options.journal]!=='function'))fail('INVALID_PROFILE');
 const bounds=limits(options.limits),closure=await loadClosure(options.closure,bounds.maxClosureBytes,production),teamId=options.teamId,projectId=options.projectId,region=options.region;
 const token=options.token,reserve=options.journal.reserve,record=options.journal.record,authorize=options.journal.authorize;
 const binding=Object.freeze({teamId,projectId,region,image:VERCEL_MEDIA_IMAGE,closureSha256:hash(JSON.stringify({closureSha256:closure.sha256,launcherSha256:hash(launcher)})),limits:bounds});let busy=false,poisoned=false;
 const api=async(path:string,signal:AbortSignal,init:RequestInit={})=>{
  const auth=await withSignal(token(),signal);if(typeof auth!=='string'||auth.length<8||auth.length>4096||/[\r\n]/.test(auth))fail('SANDBOX_UNAVAILABLE');signal.throwIfAborted();
  const url=new URL('https://api.vercel.com'+path);url.searchParams.set('teamId',teamId);
  return fetcher(url,{...init,redirect:'error',signal,headers:{'content-type':'application/json',...init.headers,authorization:'Bearer '+auth}});
 };
 const run=async(value:MediaSandboxRun):Promise<string>=>{
  checkQualification();if(busy||poisoned)fail('SANDBOX_UNAVAILABLE');
  const args=Array.isArray(value.args)?[...value.args]:[];
  if(!['ffmpeg','ffprobe'].includes(value.tool)||!Array.isArray(value.args)||args.length>256||args.some(a=>typeof a!=='string'||a.includes('\0')||a.length>8192)||args.reduce((n,a)=>n+a.length,0)>32768||!integer(value.inputFd,0,2**31-1)||!integer(value.timeoutMs,1,bounds.timeoutMs)||!integer(value.maxOutputBytes,1,bounds.maxOutputBytes)||!integer(value.maxStderrBytes,1,bounds.maxStderrBytes))fail('INPUT_INVALID');
  decoderArgs(value.tool,args);if(value.signal?.aborted)fail('ABORTED');busy=true;
  const deadline=AbortSignal.timeout(value.timeoutMs),signal=AbortSignal.any([deadline,...value.signal?[value.signal]:[]]);let intent:VercelMediaIntent|undefined,session:string|undefined,createAttempted=false,result='',failure:unknown;
  const event=(type:VercelMediaJournalEvent['type'],status?:string)=>withSignal(record(Object.freeze({type,intentId:intent!.id,name:intent!.name,...session?{sessionId:session}:{},...status?{status}:{}})),AbortSignal.timeout(3000));
  const authorized=()=>withSignal(authorize(intent!),signal);
  const ownedSession=(payload:Record<string,unknown>):string|undefined=>{
   const s=payload.session,b=payload.sandbox;
   if(!object(s)||!sessionId(s.id)||!object(b)||b.name!==intent!.name||b.currentSessionId!==s.id||b.projectId!==undefined&&b.projectId!==projectId||b.teamId!==undefined&&b.teamId!==teamId||s.projectId!==undefined&&s.projectId!==projectId||s.teamId!==undefined&&s.teamId!==teamId)return;
   return s.id;
  };
  const reconcile=async()=>{
   poisoned=true;try{await event('create-unknown');}catch{/* Failed journaling must not suppress a scoped cleanup lookup. */}
   try{const found=await json(await api('/v2/sandboxes/'+encodeURIComponent(intent!.name)+'?projectId='+encodeURIComponent(projectId)+'&resume=false',AbortSignal.timeout(5000)));session=ownedSession(found);}catch{/* Durable reserved intent remains for controller reconciliation. */}
  };
  const identity=(payload:Record<string,unknown>,name:string)=>{
   const s=payload.session,b=payload.sandbox;if(!object(s)||!sessionId(s.id)||!object(b)||b.name!==name||b.currentSessionId!==s.id||b.persistent!==false||b.image!==VERCEL_MEDIA_IMAGE||b.region!==region||b.timeout!==bounds.timeoutMs||b.vcpus!==2||b.memory!==4096||b.currentSnapshotId!==undefined||!Array.isArray(b.failoverRegions)||b.failoverRegions.length||!object(b.networkPolicy)||!keys(b.networkPolicy,['mode'])||b.networkPolicy.mode!=='deny-all'||!Array.isArray(payload.routes)||payload.routes.length||payload.resumed!==undefined&&payload.resumed!==false||b.projectId!==undefined&&b.projectId!==projectId||b.teamId!==undefined&&b.teamId!==teamId||s.projectId!==undefined&&s.projectId!==projectId||s.teamId!==undefined&&s.teamId!==teamId)fail('SANDBOX_UNAVAILABLE');
   if(s.status!=='running'||s.vcpus!==2||s.memory!==4096||s.region!==region||s.timeout!==bounds.timeoutMs||!object(s.networkPolicy)||!keys(s.networkPolicy,['mode'])||s.networkPolicy.mode!=='deny-all'||!integer(s.startedAt,Date.now()-bounds.timeoutMs,Date.now()+5000)||s.sourceSnapshotId!==undefined)fail('SANDBOX_UNAVAILABLE');return s.id;
  };
  try{
   const input=inputFile(value.inputFd,bounds.maxInputBytes,signal),inputSha256=hash(input),id=randomUUID();
   intent=Object.freeze({id,name:'coatria-media-'+id,teamId,projectId,region,image:VERCEL_MEDIA_IMAGE,closureSha256:binding.closureSha256,inputSha256,inputBytes:input.length,tool:value.tool,ttlMs:bounds.timeoutMs,vcpus:2,memoryMiB:4096});
   await withSignal(reserve(intent),signal);await authorized();signal.throwIfAborted();checkQualification();
   const request={name:intent.name,projectId,image:VERCEL_MEDIA_IMAGE,resources:{vcpus:2},timeout:bounds.timeoutMs,persistent:false,networkPolicy:{mode:'deny-all'},ports:[],env:{},region,failoverRegions:[]};createAttempted=true;
   let created:Record<string,unknown>;
   try{created=await json(await api('/v3/sandboxes',signal,{method:'POST',body:JSON.stringify(request)}));}
   catch{
    // Never repeat create. Even 404 after an uncertain create is not proof that
    // an asynchronous resource will not appear; retain the reservation.
    await reconcile();
    fail('SANDBOX_UNAVAILABLE');
   }
   // Only an ownership-proven handle may be stopped. Policy mismatch on our
   // own session still gets cleaned up; a foreign handle never gets mutated.
   session=ownedSession(created);if(!session){await reconcile();fail('SANDBOX_UNAVAILABLE');}
   await event('created');identity(created,intent.name);
   signal.throwIfAborted();await authorized();checkQualification();
   // Bind qualification to the full bundle, but transfer only this command's
   // executable plus shared dependencies. Never transfer the unused decoder.
   const otherTool=value.tool==='ffmpeg'?'bin/ffprobe':'bin/ffmpeg',selectedFiles=closure.files.filter(f=>f.path!==otherTool);
   const invocationClosure={...closure.manifest,files:closure.manifest.files.filter(f=>f.path!==otherTool)};
   const job={tool:value.tool,args,inputBytes:input.length,inputSha256,closure:invocationClosure,maxOutputBytes:value.maxOutputBytes,maxStderrBytes:value.maxStderrBytes,timeoutMs:Math.min(value.timeoutMs,bounds.timeoutMs)};
   const archive=tar([...selectedFiles.map(f=>({path:'coatria/runtime/'+f.path,content:f.content,mode:0o555})),{path:'coatria/launcher.cjs',content:Buffer.from(launcher),mode:0o444},{path:'coatria/job.json',content:Buffer.from(JSON.stringify(job)),mode:0o444},{path:'coatria/input.bin',content:input,mode:0o444}]);
   const compressed=gzipSync(archive,{level:1});if(archive.length>bounds.maxClosureBytes+bounds.maxInputBytes+256*1024||compressed.length>archive.length+65536)fail('INPUT_INVALID');signal.throwIfAborted();
   await json(await api('/v2/sandboxes/sessions/'+session+'/fs/write',signal,{method:'POST',headers:{'content-type':'application/gzip','x-cwd':'/vercel'},body:compressed as unknown as BodyInit}));
   await authorized();checkQualification();signal.throwIfAborted();
   const command=await json(await api('/v2/sandboxes/sessions/'+session+'/cmd',signal,{method:'POST',body:JSON.stringify({command:'/usr/bin/env',args:['-i','PATH=/usr/local/bin:/usr/bin:/bin','node','/vercel/coatria/launcher.cjs'],cwd:'/vercel',env:{},sudo:false,timeout:Math.min(value.timeoutMs,bounds.timeoutMs)})}));
   if(!object(command.command)||!identifier(command.command.id)||command.command.sessionId!==session)fail('PROCESS_FAILED');const commandId=command.command.id;
   const finished=await json(await api('/v2/sandboxes/sessions/'+session+'/cmd/'+commandId+'?wait=true',signal));
   if(!object(finished.command)||finished.command.id!==commandId||finished.command.sessionId!==session||finished.command.exitCode!==0)fail('PROCESS_FAILED');
   const logResponse=await api('/v2/sandboxes/sessions/'+session+'/cmd/'+commandId+'/logs',signal);if(!logResponse.ok||!logResponse.headers.get('content-type')?.startsWith('application/x-ndjson'))fail('PROCESS_FAILED');
   const logs=(await bytes(logResponse,Math.ceil(value.maxOutputBytes*2)+65536)).toString('utf8');let envelope='';
   for(const line of logs.split('\n')){if(!line.trim())continue;let part:unknown;try{part=JSON.parse(line);}catch{fail('PROCESS_FAILED');}if(!object(part)||part.stream!=='stdout'||typeof part.data!=='string')fail('PROCESS_FAILED');envelope+=part.data;if(Buffer.byteLength(envelope)>Math.ceil(value.maxOutputBytes*4/3)+1024)fail('OUTPUT_LIMIT');}
   let output:unknown;try{output=JSON.parse(envelope);}catch{fail('PROCESS_FAILED');}
   if(!object(output)||!keys(output,['version','inputBytes','inputSha256','stdout'])||output.version!==1||output.inputBytes!==input.length||output.inputSha256!==inputSha256||typeof output.stdout!=='string')fail('PROCESS_FAILED');
   const decoded=Buffer.from(output.stdout,'base64');if(decoded.length>value.maxOutputBytes)fail('OUTPUT_LIMIT');if(decoded.toString('base64')!==output.stdout)fail('PROCESS_FAILED');result=decoded.toString('utf8');
   await authorized();checkQualification();signal.throwIfAborted();
  }catch(e){failure=e;}
  finally{
   if(session&&intent){
    // Cleanup has its own deadline. Cancellation and authorization withdrawal
    // cannot suppress destruction of an already-created guest.
    const cleanup=AbortSignal.timeout(15000);let cleanupJournalFailed=false;
    try{await event('cleanup-intent');}catch{cleanupJournalFailed=true;}
    try{
     try{await json(await api('/v2/sandboxes/sessions/'+session+'/stop',cleanup,{method:'POST'}));}catch{/* One stop attempt; read status may prove it completed. */}
     let stopped=false;while(!cleanup.aborted){const status=await json(await api('/v2/sandboxes/sessions/'+session,cleanup));if(!object(status.session)||status.session.id!==session)fail('CLEANUP_FAILED');if(terminal(status.session.status)){stopped=true;await event('terminal',String(status.session.status));break;}await delay(100,undefined,{signal:cleanup});}
     if(!stopped||cleanupJournalFailed)fail('CLEANUP_FAILED');
    }catch{poisoned=true;failure=new MediaSandboxError('CLEANUP_FAILED');try{await event('cleanup-unknown');}catch{/* Existing durable intent retains its reservation. */}}
   }else if(createAttempted){poisoned=true;failure=new MediaSandboxError('CLEANUP_FAILED');try{await event('cleanup-unknown');}catch{/* Reserved intent remains unresolved. */}}
   busy=false;
  }
  if(value.signal?.aborted&&!(failure instanceof MediaSandboxError&&failure.code==='CLEANUP_FAILED'))fail('ABORTED');
  if(deadline.aborted&&!(failure instanceof MediaSandboxError&&failure.code==='CLEANUP_FAILED'))fail('TIMEOUT');
  if(failure)throw failure instanceof MediaSandboxError?failure:new MediaSandboxError('SANDBOX_UNAVAILABLE');
  try{await authorized();checkQualification();signal.throwIfAborted();}catch{if(value.signal?.aborted)fail('ABORTED');if(deadline.aborted)fail('TIMEOUT');fail('SANDBOX_UNAVAILABLE');}return result;
 };
 return Object.freeze({run,qualificationBinding:binding});
}
