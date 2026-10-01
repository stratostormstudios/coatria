/** Immutable operator configuration for the separate remote archive service. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access,lstat,open,realpath} from 'node:fs/promises';
import {dirname,posix,resolve} from 'node:path';
import {isIP} from 'node:net';
import {z} from 'zod';
import {parseRemoteMediaControllerPolicy,type RemoteMediaControllerPolicy} from './higgsfield-remote-media-controller';
import type {VercelMediaClosure} from './higgsfield-vercel-media-sandbox';

export class RemoteArchiveConfigurationError extends Error{readonly code='REMOTE_ARCHIVE_CONFIGURATION_INVALID';constructor(){super('Remote archive configuration is invalid or not immutable.');this.name='RemoteArchiveConfigurationError';}}
function fail():never{throw new RemoteArchiveConfigurationError();}
const absolute=z.string().min(2).max(1024).refine(path=>path.startsWith('/')&&!path.startsWith('//')&&!path.includes('\\')&&!path.includes('\0')&&posix.normalize(path)===path&&path!=='/');
const relative=z.string().max(70).regex(/^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/).refine(path=>!path.split('/').some(part=>part==='.'||part==='..'));
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const closureSchema=z.object({root:absolute,files:z.array(z.object({path:relative,bytes:z.number().int().min(1).max(256*1024**2),sha256:digest}).strict()).min(2).max(64),loader:relative.optional(),libraryDirectories:z.array(relative).max(16).optional()}).strict();
const schema=z.object({version:z.literal(1),policy:z.unknown(),closure:closureSchema,qualification:z.object({receiptPath:absolute,sha256:digest}).strict(),scratchRoot:absolute,outputHosts:z.array(z.string().min(3).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)).min(1).max(20),operationDeadlineMs:z.number().int().min(1000).max(7200000),inspection:z.object({timeoutMs:z.number().int().min(1000).max(300000),sandboxTimeoutMs:z.number().int().min(1000).max(120000)}).strict()}).strict();
export type RemoteArchiveConfiguration=Readonly<{version:1;policy:RemoteMediaControllerPolicy;closure:VercelMediaClosure;qualification:{receiptPath:string;sha256:string};scratchRoot:string;outputHosts:readonly string[];operationDeadlineMs:number;inspection:{timeoutMs:number;sandboxTimeoutMs:number}}>;
const frozen=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const item of Object.values(value))frozen(item);Object.freeze(value);}return value;};
export function parseRemoteArchiveConfiguration(value:unknown):RemoteArchiveConfiguration{
 const parsed=schema.safeParse(value);if(!parsed.success)fail();const raw=parsed.data;let policy:RemoteMediaControllerPolicy;try{policy=parseRemoteMediaControllerPolicy(raw.policy);}catch{fail();}
 const fileNames=new Set(raw.closure.files.map(file=>file.path)),limits=policy.binding.limits;
 if(fileNames.size!==raw.closure.files.length||!fileNames.has('bin/ffmpeg')||!fileNames.has('bin/ffprobe')||raw.closure.files.reduce((sum,file)=>sum+file.bytes,0)>limits.maxClosureBytes||raw.closure.loader&&!fileNames.has(raw.closure.loader)||!raw.closure.loader&&raw.closure.libraryDirectories?.length||raw.closure.libraryDirectories?.some(dir=>!raw.closure.files.some(file=>file.path.startsWith(dir+'/'))))fail();
 if(new Set(raw.outputHosts).size!==raw.outputHosts.length||raw.outputHosts.some(host=>isIP(host)||!host.includes('.')||host.includes('..')||host.split('.').some(label=>!label||label.length>63||label.startsWith('-')||label.endsWith('-'))))fail();
 if(policy.maxLaunches<3||limits.maxStderrBytes!==65536||raw.inspection.sandboxTimeoutMs>limits.timeoutMs||raw.inspection.sandboxTimeoutMs>raw.inspection.timeoutMs||raw.inspection.timeoutMs>raw.operationDeadlineMs||raw.scratchRoot===raw.closure.root||raw.scratchRoot.startsWith(raw.closure.root+'/')||raw.closure.root.startsWith(raw.scratchRoot+'/')||raw.qualification.receiptPath.startsWith(raw.scratchRoot+'/'))fail();
 return frozen({...raw,policy});
}
export function parseRemoteArchiveArguments(args:readonly string[]){
 let path:string|undefined,sha256:string|undefined,preflight=false;
 for(let i=0;i<args.length;i++){if(args[i]==='--config'&&path===undefined)path=args[++i];else if(args[i]==='--sha256'&&sha256===undefined)sha256=args[++i];else if(args[i]==='--preflight'&&!preflight)preflight=true;else fail();}
 if(!path||!absolute.safeParse(path).success||!sha256||!digest.safeParse(sha256).success)fail();return {path,sha256,preflight};
}
/** Check both mode bits and effective access (including ACLs), every ancestor,
 * symlinks and hardlinks. Production always requires this real filesystem gate. */
export async function assertRemoteArchiveImmutableFile(path:string){
 if(process.platform!=='linux'||process.arch!=='x64'||!process.getuid||process.getuid()===0||!absolute.safeParse(path).success||await realpath(path)!==resolve(path))fail();
 let current=resolve(path),first=true;
 for(;;){const stat=await lstat(current);if(stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022)||(first?!stat.isFile()||stat.nlink!==1:!stat.isDirectory()))fail();try{await access(current,constants.W_OK);fail();}catch(error){if(error instanceof RemoteArchiveConfigurationError)throw error;if(!['EACCES','EROFS'].includes((error as NodeJS.ErrnoException).code??''))throw error;}const parent=dirname(current);if(parent===current)break;current=parent;first=false;}
}
export async function loadRemoteArchiveConfiguration(path:string,sha256:string){
 if(!digest.safeParse(sha256).success)fail();await assertRemoteArchiveImmutableFile(path);
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await file.stat();if(!before.isFile()||before.uid!==0||before.nlink!==1||before.size<1||before.size>512*1024)fail();const bytes=await file.readFile(),after=await file.stat();if(bytes.length!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||createHash('sha256').update(bytes).digest('hex')!==sha256)fail();let json:unknown;try{json=JSON.parse(bytes.toString('utf8'));}catch{fail();}return parseRemoteArchiveConfiguration(json);}finally{await file.close();}
}
