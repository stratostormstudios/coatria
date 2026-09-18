import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {z} from 'zod';

export const controlledRenderJobSchema = z.object({
  schemaVersion: z.literal(1), jobId: z.string().uuid(),
  profile: z.literal('coatria-product-turntable-v1'),
  frameStart: z.number().int().min(0).max(10000000).default(1),
  frameEnd: z.number().int().min(0).max(10000000).default(4),
  width: z.number().int().min(16).max(1024).default(512),
  height: z.number().int().min(16).max(1024).default(512),
  fpsNumerator: z.number().int().min(1).max(120000).default(24),
  fpsDenominator: z.number().int().min(1).max(1001).default(1),
  colorSpace: z.enum(['Linear Rec.709','ACEScg']).default('Linear Rec.709'),
  samples: z.number().int().min(1).max(64).default(16),
  timeoutSeconds: z.number().int().min(1).max(600).default(180),
}).strict().refine(j => j.frameEnd >= j.frameStart && j.frameEnd-j.frameStart<24, 'Use an ordered inclusive range of at most 24 frames.')
  .refine(j => j.fpsNumerator/j.fpsDenominator>=1&&j.fpsNumerator/j.fpsDenominator<=60,'The controlled profile supports frame rates from 1 through 60 fps.')
  .refine(j => j.width * j.height * (j.frameEnd - j.frameStart + 1) <= 8_000_000, 'The reviewed profile allows at most 8,000,000 output pixels per job.');
export type ControlledRenderJob = z.infer<typeof controlledRenderJobSchema>;
export class RenderError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'RenderError'; }
}
export type RenderFile = {kind:'scene'|'frame'|'review'; path:string; sizeBytes:number; sha256:string; width?:number; height?:number; frame?:number};
export type RenderManifest = {
  schemaVersion:1; job:ControlledRenderJob; jobSpecSha256:string; profileSha256:string;
  attempt:number; files:RenderFile[]; evidence:Record<string,unknown>; createdAt:string;
};
export type RenderResult = {schemaVersion:1; status:'succeeded'; jobId:string; attempt:number; manifestPath:string; manifestSha256:string; elapsedMs:number; replayed:boolean};
const profilePath = fileURLToPath(new URL('./product_turntable.py', import.meta.url));
const digest = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown):string { return Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}' : JSON.stringify(value); }
export const renderJobDigest = (job:unknown) => digest(canonical(controlledRenderJobSchema.parse(job)));
export async function sha256File(file:string) {
  const hash=createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function inside(root:string, target:string) { const relative=path.relative(root,target); return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative); }
async function safeFile(root:string, relative:string) {
  if(!relative||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(relative)) throw new RenderError('UNSAFE_PATH','Manifest paths must be fixed relative paths.');
  const target=path.resolve(root,relative); if(!inside(root,target)) throw new RenderError('UNSAFE_PATH','Output escaped its job directory.');
  const resolved=await realpath(target).catch(()=>{throw new RenderError('OUTPUT_MISSING',`Required output is missing: ${relative}`);});
  const stat=await lstat(target); if(stat.isSymbolicLink()||!stat.isFile()||!inside(root,resolved)) throw new RenderError('UNSAFE_PATH','Output is not a contained regular file.');
  return {target,stat};
}
export function imageDimensions(bytes:Buffer):{width:number;height:number;format:'png'|'exr'} {
  if(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR') {
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(!width||!height) throw new RenderError('OUTPUT_INVALID','PNG dimensions are invalid.');
    return {width,height,format:'png'};
  }
  if(bytes.length<12||bytes.readUInt32LE(0)!==20000630) throw new RenderError('OUTPUT_INVALID','Expected an actual PNG or OpenEXR header.');
  let offset=8;
  const string=()=>{const end=bytes.indexOf(0,offset);if(end<0||end-offset>255)throw new RenderError('OUTPUT_INVALID','Invalid OpenEXR attribute.');const value=bytes.toString('ascii',offset,end);offset=end+1;return value;};
  while(offset<bytes.length&&offset<1024*1024) {
    const name=string();if(!name)break;const type=string();if(offset+4>bytes.length)break;const size=bytes.readUInt32LE(offset);offset+=4;if(size>1024*1024||offset+size>bytes.length)break;
    if(name==='dataWindow'&&type==='box2i'&&size===16){const width=bytes.readInt32LE(offset+8)-bytes.readInt32LE(offset)+1,height=bytes.readInt32LE(offset+12)-bytes.readInt32LE(offset+4)+1;if(width<=0||height<=0)break;return {width,height,format:'exr'};}
    offset+=size;
  }
  throw new RenderError('OUTPUT_INVALID','OpenEXR dataWindow is absent or invalid.');
}
async function fileRecord(root:string, relative:string, kind:RenderFile['kind'], job:ControlledRenderJob, frame?:number):Promise<RenderFile> {
  const {target,stat}=await safeFile(root,relative);if(stat.size<32||stat.size>256*1024*1024)throw new RenderError('OUTPUT_INVALID','Output size is outside the controlled profile.');
  const file:RenderFile={kind,path:relative,sizeBytes:stat.size,sha256:await sha256File(target)};
  const handle=await open(target,'r');let head:Buffer;try {head=Buffer.alloc(Math.min(stat.size,1024*1024));await handle.read(head,0,head.length,0);}finally{await handle.close();}
  if(kind==='scene'){if(head.toString('ascii',0,7)!=='BLENDER')throw new RenderError('OUTPUT_INVALID','Native scene is not a Blender file.');}
  else {const dimensions=imageDimensions(head);if(dimensions.width!==job.width||dimensions.height!==job.height||dimensions.format!==(kind==='frame'?'exr':'png'))throw new RenderError('OUTPUT_DIMENSIONS','Rendered image dimensions or format do not match the job.');Object.assign(file,{width:dimensions.width,height:dimensions.height},frame===undefined?{}:{frame});}
  return file;
}
async function collectOutputs(root:string,job:ControlledRenderJob) {
  const entries=await readdir(path.join(root,'frames'));const expected=Array.from({length:job.frameEnd-job.frameStart+1},(_,i)=>`frame-${String(job.frameStart+i).padStart(4,'0')}.exr`);
  if(entries.length!==expected.length||entries.some(name=>!expected.includes(name)))throw new RenderError('FRAME_SET_MISMATCH','The complete exact requested frame set is required.');
  const files=[await fileRecord(root,'scene.blend','scene',job),await fileRecord(root,'review.png','review',job)];
  for(const frame of expected)files.push(await fileRecord(root,'frames/'+frame,'frame',job,Number(frame.match(/^frame-(\d+)\.exr$/)![1])));
  return files;
}
export async function verifyRenderDirectory(directory:string):Promise<RenderManifest> {
  const root=await realpath(directory), manifestFile=await safeFile(root,'manifest.json');
  if(manifestFile.stat.size>256*1024)throw new RenderError('OUTPUT_INVALID','Manifest exceeds its bounded size.');
  const manifest=JSON.parse(await readFile(manifestFile.target,'utf8')) as RenderManifest;
  const job=controlledRenderJobSchema.parse(manifest.job);
  if(manifest.schemaVersion!==1||manifest.jobSpecSha256!==renderJobDigest(job)||!Array.isArray(manifest.files))throw new RenderError('MANIFEST_INVALID','Manifest identity is invalid.');
  const actual=await collectOutputs(root,job);
  if(canonical(actual)!==canonical(manifest.files))throw new RenderError('OUTPUT_HASH_MISMATCH','An output differs from the sealed manifest.');
  return manifest;
}
function processAlive(pid:unknown) { if(!Number.isInteger(pid)||Number(pid)<1)return false;try{process.kill(Number(pid),0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';} }
function childEnvironment():NodeJS.ProcessEnv {
  const allowed=['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA','COMSPEC','LD_LIBRARY_PATH','DISPLAY','LANG'];
  const result:NodeJS.ProcessEnv={NODE_ENV:'production'};for(const key of allowed)if(process.env[key])result[key]=process.env[key];return result;
}
/** Operator-only executable/args. Job JSON can never select either. */
export async function runBoundedProcess(executable:string,args:string[],options:{cwd:string;timeoutMs:number;signal?:AbortSignal;onSpawn?:(pid:number)=>Promise<void>}) {
  if(!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>600000)throw new RenderError('INVALID_TIMEOUT','Use a bounded process timeout.');
  const child=spawn(executable,args,{cwd:options.cwd,env:childEnvironment(),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',timedOut=false,interrupted=false;
  child.stdout.on('data',data=>{stdout=(stdout+String(data)).slice(-65536);});child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-65536);});
  let timer:ReturnType<typeof setTimeout>|undefined,terminationTimer:ReturnType<typeof setTimeout>|undefined;
  let forceReject:(error:Error)=>void=()=>undefined;
  const terminate=()=>{
    if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
    if(process.platform==='win32'){
      const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
      killer.once('error',()=>child.kill('SIGKILL'));
      killer.once('exit',code=>{if(code!==0)child.kill('SIGKILL');});
    }else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    terminationTimer=setTimeout(()=>forceReject(new RenderError('PROCESS_TERMINATION_UNCERTAIN','Renderer termination could not be confirmed; retain its execution lock.')),5000);
  };
  const abort=()=>{interrupted=true;terminate();};
  try {
    const outcome=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{forceReject=reject;child.once('error',()=>reject(new RenderError('PROCESS_START_FAILED','The configured renderer could not start.')));child.once('close',(code,signal)=>resolve({code,signal}));});
    void outcome.catch(()=>undefined);
    timer=setTimeout(()=>{timedOut=true;terminate();},options.timeoutMs);
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    if(child.pid)await options.onSpawn?.(child.pid);
    const outcomeValue=await outcome;
    return {...outcomeValue,stdout,stderr,timedOut,interrupted};
  }catch(error){terminate();throw error;}
  finally{if(timer)clearTimeout(timer);if(terminationTimer)clearTimeout(terminationTimer);options.signal?.removeEventListener('abort',abort);}
}
export async function executeControlledRender(input:unknown,options:{outputRoot:string;blenderPath:string;signal?:AbortSignal}):Promise<RenderResult> {
  const job=controlledRenderJobSchema.parse(input),jobHash=renderJobDigest(job);
  if(!path.isAbsolute(options.outputRoot)||!path.isAbsolute(options.blenderPath))throw new RenderError('OPERATOR_PATH_REQUIRED','Renderer and output paths must be operator-selected absolute paths.');
  await mkdir(options.outputRoot,{recursive:true});const root=await realpath(options.outputRoot),jobDirectory=path.join(root,job.jobId);
  await mkdir(jobDirectory,{recursive:true});if((await lstat(jobDirectory)).isSymbolicLink()||!inside(root,await realpath(jobDirectory)))throw new RenderError('UNSAFE_PATH','Job directory must be owned regular storage.');
  const lockPath=path.join(jobDirectory,'.render-lock.json');let lock:Awaited<ReturnType<typeof open>>|undefined;
  const lockData={schemaVersion:1,pid:process.pid,host:hostname(),childPid:null as number|null,jobSpecSha256:jobHash,startedAt:new Date().toISOString()};
  for(let attempt=0;attempt<3&&!lock;attempt++)try{lock=await open(lockPath,'wx',0o600);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const held=await safeFile(jobDirectory,'.render-lock.json');if(held.stat.size>8192)throw new RenderError('JOB_LOCKED','Existing execution lock needs operator reconciliation.');
    const old=JSON.parse(await readFile(held.target,'utf8'));
    if(old.host!==hostname()||processAlive(old.pid)||processAlive(old.childPid))throw new RenderError('JOB_LOCKED','A live or unreconciled execution already owns this job.');
    await mkdir(path.join(jobDirectory,'recovery'),{recursive:true});await rename(lockPath,path.join(jobDirectory,'recovery',`abandoned-lock-${randomUUID()}.json`));
  }
  if(!lock)throw new RenderError('JOB_LOCKED','Could not acquire the job execution lock.');
  const persistLock=async()=>{await lock!.truncate(0);await lock!.write(JSON.stringify(lockData),0,'utf8');await lock!.sync();};
  let attemptDirectory:string|undefined;const started=Date.now();
  try {
    await persistLock();const specPath=path.join(jobDirectory,'job.json');
    try{await writeFile(specPath,JSON.stringify(job,null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await safeFile(jobDirectory,'job.json');if(renderJobDigest(JSON.parse(await readFile(specPath,'utf8')))!==jobHash)throw new RenderError('JOB_CONFLICT','This immutable job ID belongs to another specification.');}
    const resultPath=path.join(jobDirectory,'result.json');
    try{
      const existingFile=await safeFile(jobDirectory,'result.json');const result=JSON.parse(await readFile(existingFile.target,'utf8')) as RenderResult;
      if(result.jobId!==job.jobId||!/^attempts\/\d{4}\/manifest\.json$/.test(result.manifestPath))throw new RenderError('MANIFEST_INVALID','The immutable result pointer is invalid.');
      const manifestPath=await safeFile(jobDirectory,result.manifestPath);if(await sha256File(manifestPath.target)!==result.manifestSha256)throw new RenderError('OUTPUT_HASH_MISMATCH','The committed manifest changed.');
      const manifest=await verifyRenderDirectory(path.dirname(manifestPath.target));if(manifest.jobSpecSha256!==jobHash)throw new RenderError('JOB_CONFLICT','Result specification differs from this job.');return {...result,replayed:true};
    }catch(error){if(!(error instanceof RenderError)||error.code!=='OUTPUT_MISSING')throw error;if((await readdir(jobDirectory)).includes('result.json'))throw error;}
    const attemptsRoot=path.join(jobDirectory,'attempts');await mkdir(attemptsRoot,{recursive:true});
    const previous=(await readdir(attemptsRoot)).filter(name=>/^\d{4}$/.test(name)).map(Number),attempt=Math.max(0,...previous)+1;
    if(previous.length){const last=path.join(attemptsRoot,String(Math.max(...previous)).padStart(4,'0'));if(!(await readdir(last)).includes('failure.json'))throw new RenderError('JOB_RECONCILIATION_REQUIRED','An interrupted attempt has uncertain completion. Reconcile its outputs before another render.');}
    if(attempt>20)throw new RenderError('ATTEMPT_LIMIT','This job reached its operator retry limit.');
    attemptDirectory=path.join(attemptsRoot,String(attempt).padStart(4,'0'));await mkdir(attemptDirectory);
    const specFile=path.join(attemptDirectory,'input.json');await writeFile(specFile,JSON.stringify(job)+'\n',{flag:'wx',mode:0o600});
    const profileSha256=await sha256File(profilePath);
    const processResult=await runBoundedProcess(options.blenderPath,['--background','--factory-startup','--disable-autoexec','--offline-mode','--threads','2','--python-exit-code','1','--python',profilePath,'--','--spec',specFile,'--output',attemptDirectory],{cwd:attemptDirectory,timeoutMs:job.timeoutSeconds*1000,signal:options.signal,onSpawn:async pid=>{lockData.childPid=pid;await persistLock();}});
    await writeFile(path.join(attemptDirectory,'stdout.log'),processResult.stdout,{flag:'wx'});await writeFile(path.join(attemptDirectory,'stderr.log'),processResult.stderr,{flag:'wx'});
    if(processResult.timedOut)throw new RenderError('RENDER_TIMEOUT','The controlled renderer exceeded its approved timeout and was terminated.');
    if(processResult.interrupted)throw new RenderError('WORKER_INTERRUPTED','The controlled renderer was interrupted before completion.');
    if(processResult.code!==0)throw new RenderError('RENDER_FAILED','The controlled renderer failed; inspect the private attempt log.');
    const files=await collectOutputs(attemptDirectory,job),evidence=JSON.parse(await readFile((await safeFile(attemptDirectory,'blender-evidence.json')).target,'utf8'));
    if(evidence.workingColorSpace!==job.colorSpace||evidence.renderEngine!=='CYCLES'||evidence.device!=='CPU'||!evidence.ocioConfigSha256)throw new RenderError('PROFILE_MISMATCH','Renderer evidence does not match the reviewed profile.');
    const manifest:RenderManifest={schemaVersion:1,job,jobSpecSha256:jobHash,profileSha256,attempt,files,evidence,createdAt:new Date().toISOString()};
    await writeFile(path.join(attemptDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});await verifyRenderDirectory(attemptDirectory);
    const result:RenderResult={schemaVersion:1,status:'succeeded',jobId:job.jobId,attempt,manifestPath:`attempts/${String(attempt).padStart(4,'0')}/manifest.json`,manifestSha256:await sha256File(path.join(attemptDirectory,'manifest.json')),elapsedMs:Date.now()-started,replayed:false};
    await writeFile(path.join(attemptDirectory,'report.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});await writeFile(resultPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
  }catch(error){if(attemptDirectory)await writeFile(path.join(attemptDirectory,'failure.json'),JSON.stringify({status:'failed',code:error instanceof RenderError?error.code:'EXECUTION_FAILED',at:new Date().toISOString()},null,2)+'\n',{flag:'wx'}).catch(()=>undefined);throw error;}
  finally{await lock.close();if(!processAlive(lockData.childPid))await unlink(lockPath);}
}

async function main(){
  const args=process.argv.slice(2),options=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){if(!['--job','--output-root','--blender','--verify'].includes(args[i])||!args[i+1]||options.has(args[i]))throw new RenderError('USAGE','Use --job <json> --output-root <absolute directory> --blender <absolute executable>, or --verify <attempt directory>.');options.set(args[i],args[i+1]);}
  if(options.has('--verify')){if(options.size!==1)throw new RenderError('USAGE','Verification takes only --verify.');const manifest=await verifyRenderDirectory(path.resolve(options.get('--verify')!));console.log(JSON.stringify({status:'verified',jobId:manifest.job.jobId,files:manifest.files.length}));return;}
  if(options.size!==3||!options.has('--job')||!options.has('--output-root')||!options.has('--blender'))throw new RenderError('USAGE','Provide the operator-approved job, output root and Blender executable.');
  const inputFile=options.get('--job')!;if((await lstat(inputFile)).size>16384)throw new RenderError('JOB_TOO_LARGE','Job specification exceeds 16 KiB.');
  console.log(JSON.stringify(await executeControlledRender(JSON.parse(await readFile(inputFile,'utf8')),{outputRoot:path.resolve(options.get('--output-root')!),blenderPath:options.get('--blender')!})));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(JSON.stringify({status:'failed',code:error instanceof RenderError?error.code:'EXECUTION_FAILED',message:error instanceof RenderError?error.message:'The controlled render failed validation or execution.'}));process.exitCode=1;});
