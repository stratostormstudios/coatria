import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseRemoteArchiveArguments,parseRemoteArchiveConfiguration,loadRemoteArchiveConfiguration} from '../src/lib/higgsfield-remote-archive-config';
import {drainRemoteArchiveInspections} from '../scripts/higgsfield-remote-archive-worker';
import {VERCEL_MEDIA_IMAGE} from '../src/lib/higgsfield-vercel-media-sandbox';

const rejected={code:'REMOTE_ARCHIVE_CONFIGURATION_INVALID'},sha='a'.repeat(64);
const config=()=>({version:1,policy:{pilotId:randomUUID(),companyId:randomUUID(),projectIds:[randomUUID()],sourceCommit:'b'.repeat(40),expiresAt:new Date(Date.now()+3600000).toISOString(),maxLaunches:9,binding:{teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1',image:VERCEL_MEDIA_IMAGE,closureSha256:'c'.repeat(64),limits:{maxInputBytes:128*1024**2,maxClosureBytes:256*1024**2,timeoutMs:120000,maxOutputBytes:16*1024**2,maxStderrBytes:65536}}},closure:{root:'/opt/coatria/decoder',files:[{path:'bin/ffmpeg',bytes:123000000,sha256:sha},{path:'bin/ffprobe',bytes:107988064,sha256:sha}]},qualification:{receiptPath:'/etc/coatria/remote-qualified.json',sha256:sha},scratchRoot:'/state/scratch',outputHosts:['media.reviewed.example'],operationDeadlineMs:600000,inspection:{timeoutMs:300000,sandboxTimeoutMs:90000}});

test('remote entry requires one explicit immutable path/hash and never accepts command/token overrides',()=>{
 assert.deepEqual(parseRemoteArchiveArguments(['--config','/etc/coatria/remote.json','--sha256',sha,'--preflight']),{path:'/etc/coatria/remote.json',sha256:sha,preflight:true});
 for(const args of [[],['--config','./remote.json','--sha256',sha],['--config','/etc/coatria/../remote.json','--sha256',sha],['--config','/etc/coatria/remote.json','--sha256','bad'],['--config','/etc/coatria/remote.json','--sha256',sha,'--token','synthetic'],['--config','/etc/coatria/remote.json','--sha256',sha,'--config','/tmp/other'],['--config','/etc/coatria/remote.json','--sha256',sha,'--preflight','--preflight']])assert.throws(()=>parseRemoteArchiveArguments(args),rejected);
});
test('configuration pins approved scope, 256 MiB closure, 128 MiB input, separate deadlines and immutable copies',()=>{
 const original=config(),parsed=parseRemoteArchiveConfiguration(original);assert.equal(parsed.closure.files.reduce((sum,file)=>sum+file.bytes,0),230988064);assert.equal(parsed.inspection.sandboxTimeoutMs,90000);assert.equal(parsed.inspection.timeoutMs,300000);assert(Object.isFrozen(parsed));assert(Object.isFrozen(parsed.policy.binding.limits));assert(Object.isFrozen(parsed.closure.files));original.outputHosts[0]='changed.example';assert.equal(parsed.outputHosts[0],'media.reviewed.example');
});
test('unknown secrets, insufficient launch allowance, mutable closure paths and incompatible resource settings are rejected',()=>{
 const changes:Array<(c:ReturnType<typeof config>)=>unknown>=[
  c=>({...c,token:'synthetic-secret'}),c=>({...c,policy:{...c.policy,maxLaunches:2}}),c=>({...c,policy:{...c.policy,projectIds:[]}}),c=>({...c,policy:{...c.policy,binding:{...c.policy.binding,limits:{...c.policy.binding.limits,maxInputBytes:128*1024**2+1}}}}),
  c=>({...c,closure:{...c.closure,files:[...c.closure.files,c.closure.files[0]]}}),c=>({...c,closure:{...c.closure,files:[{...c.closure.files[0],path:'../escape'},c.closure.files[1]]}}),c=>({...c,closure:{...c.closure,loader:'lib/missing'}}),c=>({...c,closure:{...c.closure,libraryDirectories:['lib']}}),
  c=>({...c,scratchRoot:'/opt/coatria/decoder/writable'}),c=>({...c,qualification:{...c.qualification,receiptPath:'/state/scratch/receipt'}}),c=>({...c,inspection:{...c.inspection,sandboxTimeoutMs:120001}}),c=>({...c,inspection:{...c.inspection,sandboxTimeoutMs:100000,timeoutMs:90000}}),c=>({...c,operationDeadlineMs:10000}),c=>({...c,policy:{...c.policy,binding:{...c.policy.binding,limits:{...c.policy.binding.limits,maxStderrBytes:1}}}})
 ];for(const change of changes)assert.throws(()=>parseRemoteArchiveConfiguration(change(config())),rejected);
 for(const host of ['localhost','127.0.0.1','https://media.example','*.example.com','media.example:443','evil@media.example','a..example','media.EXAMPLE'])assert.throws(()=>parseRemoteArchiveConfiguration({...config(),outputHosts:[host]}),rejected);
});
test('a writable/user-owned file cannot become production configuration by supplying its correct digest',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'coatria-remote-config-'));try{const file=join(directory,'config.json'),bytes=JSON.stringify(config());await writeFile(file,bytes,{mode:0o600});await assert.rejects(loadRemoteArchiveConfiguration(file,createHash('sha256').update(bytes).digest('hex')),rejected);}finally{await rm(directory,{recursive:true,force:true});}
});
test('cleanup drain retains pending journals until settled and is bounded for an unresponsive inspection',async()=>{
 let finish!:()=>void;const promise=new Promise<void>(resolve=>{finish=resolve;}),pending=new Set<Promise<unknown>>([promise]);let ended=false;const drain=drainRemoteArchiveInspections(pending,1000).then(result=>{ended=true;return result;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(ended,false);finish();assert.equal(await drain,true);assert.equal(await drainRemoteArchiveInspections(new Set([Promise.reject(new Error('Synthetic cleanup rejection'))]),100),true);assert.equal(await drainRemoteArchiveInspections(new Set([new Promise(()=>{})]),20),false);await assert.rejects(drainRemoteArchiveInspections(new Set(),30001),rejected);
});
test('CLI rejection exposes only a fixed diagnostic, even with synthetic secret-bearing environment',async()=>{
 const marker='synthetic-do-not-log-'+randomUUID();let stdout='',stderr='';try{await promisify(execFile)(process.execPath,['--import','tsx',resolve('scripts/higgsfield-remote-archive-worker.ts'),'--config','/nonexistent-coatria-config.json','--sha256',sha,'--preflight'],{cwd:process.cwd(),windowsHide:true,timeout:20000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'production',DATABASE_URL:marker,COATRIA_HOSTING_KEYRING:marker,COATRIA_VERCEL_MEDIA_TOKEN:marker},maxBuffer:65536});assert.fail('Missing immutable configuration must not start');}catch(error){const result=error as Error&{code?:number;stdout?:string;stderr?:string};assert.equal(result.code,1);stdout=result.stdout??'';stderr=result.stderr??'';}assert.equal(stdout,'');assert(!stderr.includes(marker));assert.deepEqual(JSON.parse(stderr.trim()),{event:'remote-archive-worker-stopped',code:'REMOTE_ARCHIVE_CONFIGURATION_INVALID'});
});
