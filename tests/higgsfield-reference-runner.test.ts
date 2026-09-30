import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseReferenceRunnerConfiguration,assertReferenceRunnerReceipt,referenceRunnerConfigurationHash,referenceRunnerToken,assertReferenceRunnerScratchEmpty,runReferenceWorkerLoop,runReferenceWorker,ReferenceRunnerError} from '../scripts/hosting/run-reference-worker.mjs';

function fixture(){const serviceId=randomUUID(),companyId=randomUUID(),projectIds=[randomUUID()],bootId=randomUUID(),expiresAt=new Date(Date.now()+60000).toISOString();const config={version:1 as const,serviceId,companyId,projectIds,origin:'https://coatria.example',sourceCommit:'a'.repeat(40),releaseSha256:'b'.repeat(64),runtimePath:'/opt/coatria-reference/runtime.mjs',expiresAt,scratchRoot:`/var/lib/coatria-reference-worker/${serviceId}/scratch`,profilePath:'/etc/coatria-reference/profile.json',profileSha256:'c'.repeat(64),cgroupRoot:'/sys/fs/cgroup/coatria-reference/decoders',uploadHosts:['uploads.example'],qualification:{path:'/etc/coatria-reference/qualified.json',sha256:'d'.repeat(64)}};const receipt={version:1,kind:'coatria-reference-worker-qualification',serviceId,companyId,projectIds,sourceCommit:config.sourceCommit,releaseSha256:config.releaseSha256,profileSha256:config.profileSha256,configurationSha256:referenceRunnerConfigurationHash(config),bootId,uid:1001,expiresAt,qualified:true,checks:{isolation:true,resourceLimits:true,descendantCleanup:true,preparedImages:true}};return {config,receipt,host:{bootId,uid:1001}};}
test('configuration is finite, exact and does not authorize archive identity or caller-selected commands',()=>{
 const f=fixture();assert.deepEqual(parseReferenceRunnerConfiguration(f.config),f.config);
 for(const patch of [{expiresAt:new Date(Date.now()-1).toISOString()},{expiresAt:new Date(Date.now()+2*86400000).toISOString()},{projectIds:[]},{scratchRoot:'/tmp/shared'},{runtimePath:'/opt/coatria-reference/source.ts'},{uploadHosts:['*.example']},{origin:'http://localhost:4180'},{nativeFallback:true},{command:'ffmpeg'}])assert.throws(()=>parseReferenceRunnerConfiguration({...f.config,...patch}));
});
test('reference receipt is bound to service, source, profile, current boot, UID and finite scope',()=>{
 const f=fixture();assert.equal(assertReferenceRunnerReceipt(f.receipt,f.config,f.host).qualified,true);
 for(const patch of [{kind:'coatria-archive-qualification'},{serviceId:randomUUID()},{companyId:randomUUID()},{projectIds:[randomUUID()]},{profileSha256:'f'.repeat(64)},{releaseSha256:'e'.repeat(64)},{sourceCommit:'0'.repeat(40)},{bootId:randomUUID()},{uid:1002},{qualified:false},{checks:{...f.receipt.checks,preparedImages:false}},{expiresAt:new Date(Date.now()+1000).toISOString()}])assert.throws(()=>assertReferenceRunnerReceipt({...f.receipt,...patch},f.config,f.host),ReferenceRunnerError);
 for(const change of [{uploadHosts:['new-upload.example']},{cgroupRoot:'/sys/fs/cgroup/another/decoders'},{origin:'https://another.example'},{scratchRoot:'/var/lib/other/scratch'}])assert.throws(()=>assertReferenceRunnerReceipt(f.receipt,{...f.config,...change},f.host),ReferenceRunnerError);
});
test('runner accepts only dedicated opaque token and refuses inherited broad credentials or injection',()=>{
 const token='rfs_'+'x'.repeat(43);assert.equal(referenceRunnerToken({COATRIA_REFERENCE_SERVICE_TOKEN:token,PATH:'/usr/bin',LANG:'C'}),token);
 for(const name of ['DATABASE_URL','COATRIA_HOSTING_KEYRING','RUNPOD_API_KEY','COATRIA_VERCEL_MEDIA_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','NODE_OPTIONS','NODE_PATH','LD_PRELOAD'])assert.throws(()=>referenceRunnerToken({COATRIA_REFERENCE_SERVICE_TOKEN:token,[name]:'must-not-reach-worker'}),ReferenceRunnerError);
 assert.throws(()=>referenceRunnerToken({COATRIA_REFERENCE_SERVICE_TOKEN:'rfs_short'}));
});
test('admission is sequential and awaits current cleanup before stopping',async()=>{
 const stop=new AbortController();let active=0,max=0,calls=0,cleaned=false;await runReferenceWorkerLoop({async runNext({signal}){calls++;active++;max=Math.max(max,active);assert.equal(signal,stop.signal);await new Promise(r=>setTimeout(r,5));stop.abort();await new Promise(r=>setTimeout(r,5));cleaned=true;active--;return {processed:true,status:'awaiting_approval'};}},{signal:stop.signal,idleMs:1});assert.equal(calls,1);assert.equal(max,1);assert(cleaned);
});
test('unknown claims, uncertain phases and blocked work stop instead of replaying',async()=>{
 for(const status of ['disabled','uncertain','blocked','failed'] as const){let calls=0;await assert.rejects(runReferenceWorkerLoop({async runNext(){calls++;return {processed:status!=='disabled',status};}},{signal:new AbortController().signal,idleMs:1}),ReferenceRunnerError);assert.equal(calls,1);}
 let calls=0;await assert.rejects(runReferenceWorkerLoop({async runNext(){calls++;throw Error('lost claim');}},{signal:new AbortController().signal,idleMs:1}));assert.equal(calls,1);
});
test('preflight cannot bypass immutable Linux host and actual sandbox qualification',async()=>{
 await assert.rejects(runReferenceWorker(['--config','/nonexistent/reference.json','--sha256','a'.repeat(64),'--preflight'],{COATRIA_REFERENCE_SERVICE_TOKEN:'rfs_'+'x'.repeat(43)}));
});

test('restart refuses all leftover scratch without listing or deleting private contents',async t=>{
 const root=await mkdtemp(join(tmpdir(),'coatria-reference-startup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const empty=join(root,'empty'),fileScratch=join(root,'file-scratch'),attemptScratch=join(root,'attempt-scratch');for(const path of [empty,fileScratch,attemptScratch])await mkdir(path);
 await assertReferenceRunnerScratchEmpty(empty);assert.deepEqual(await readdir(empty),[]);
 const privateName='private-original-image.png',privateBytes=Buffer.from('original private fixture bytes');await writeFile(join(fileScratch,privateName),privateBytes);await mkdir(join(attemptScratch,'unfinished-attempt'));
 const rejected=(error:unknown)=>error instanceof ReferenceRunnerError&&error.code==='REFERENCE_RUNNER_UNQUALIFIED'&&!String(error).includes(root)&&!String(error).includes(privateName);
 for(const path of [fileScratch,attemptScratch,join(root,'missing'),join(fileScratch,privateName)])await assert.rejects(assertReferenceRunnerScratchEmpty(path),rejected);
 assert.deepEqual(await readdir(fileScratch),[privateName]);assert.deepEqual(await readFile(join(fileScratch,privateName)),privateBytes);assert.deepEqual(await readdir(attemptScratch),['unfinished-attempt']);assert.deepEqual(await readdir(join(attemptScratch,'unfinished-attempt')),[]);
});
