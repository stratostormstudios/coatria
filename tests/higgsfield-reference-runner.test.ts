import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseReferenceRunnerConfiguration,assertReferenceRunnerReceipt,referenceRunnerConfigurationHash,deriveReferenceRunnerConfiguration,referenceRunnerToken,assertReferenceRunnerScratchEmpty,runReferenceWorkerLoop,runReferenceWorker,ReferenceRunnerError} from '../scripts/hosting/run-reference-worker.mjs';
import type {ReferenceHostConfiguration} from '../scripts/hosting/reference-runner-configuration.mts';
import {referenceHostDelegatedPath,assertReferenceHostUnitState} from '../scripts/hosting/reference-host-delegation.mjs';

function fixture(){
 const serviceId=randomUUID(),companyId=randomUUID(),projectIds=[randomUUID()],bootId=randomUUID(),expiresAt=new Date(Date.now()+60000).toISOString(),bundleSha256='a'.repeat(64),release='/var/lib/coatria-reference-releases/'+bundleSha256;
 const units=Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,{name:`coatria-reference-${serviceId}-${mode}.service`,sha256:'b'.repeat(64)}])) as ReferenceHostConfiguration['units'];
 const installed:ReferenceHostConfiguration={version:1,bundleSha256,commit:'c'.repeat(40),tree:'d'.repeat(40),release,uid:1001,gid:1002,scope:{serviceId,companyId,projectIds,origin:'https://coatria.example',expiresAt,uploadHosts:['uploads.example']},profiles:{real:{profilePath:`/etc/coatria-reference/${serviceId}/real.json`,expectedProfileSha256:'e'.repeat(64)},conformance:{profilePath:`/etc/coatria-reference/${serviceId}/conformance.json`,expectedProfileSha256:'f'.repeat(64)}},worker:{path:release+'/worker/runtime.mjs',sha256:'1'.repeat(64)},qualifier:{path:release+'/qualifier/runtime.mjs',sha256:'2'.repeat(64)},units};
 const config=deriveReferenceRunnerConfiguration(installed,'3'.repeat(64)),host={bootId,uid:1001,gid:1002,hostConfigurationSha256:'4'.repeat(64),host:installed};
 const receipt={version:2,kind:'coatria-reference-worker-qualification',serviceId,companyId,projectIds,sourceCommit:installed.commit,sourceTree:installed.tree,bundleSha256,releaseSha256:config.releaseSha256,qualifierSha256:installed.qualifier.sha256,profileSha256:config.profileSha256,conformanceProfileSha256:installed.profiles.conformance.expectedProfileSha256,configurationSha256:referenceRunnerConfigurationHash(config),hostConfigurationSha256:host.hostConfigurationSha256,bootId,uid:1001,gid:1002,expiresAt,units,qualifierInvocationId:'5'.repeat(32),serviceRoot:'/sys/fs/cgroup/system.slice/'+units.qualify.name,evidenceSha256:'6'.repeat(64),reportSha256:'7'.repeat(64),acceptedAt:new Date(Date.now()-1000).toISOString(),qualified:true,checks:{isolation:true,resourceLimits:true,descendantCleanup:true,preparedImages:true}};
 return {config,receipt,host};
}
test('configuration is finite, exact and does not authorize archive identity or caller-selected commands',()=>{
 const f=fixture();assert.deepEqual(parseReferenceRunnerConfiguration(f.config),f.config);
 for(const patch of [{expiresAt:new Date(Date.now()-1).toISOString()},{expiresAt:new Date(Date.now()+2*86400000).toISOString()},{projectIds:[]},{scratchRoot:'/tmp/shared'},{runtimePath:'/opt/coatria-reference/source.ts'},{uploadHosts:['*.example']},{origin:'http://localhost:4180'},{nativeFallback:true},{command:'ffmpeg'}])assert.throws(()=>parseReferenceRunnerConfiguration({...f.config,...patch}));
});
test('reference receipt is bound to service, source, profile, current boot, UID and finite scope',()=>{
 const f=fixture();assert.equal(assertReferenceRunnerReceipt(f.receipt,f.config,f.host).qualified,true);
 for(const patch of [{version:1},{kind:'coatria-archive-qualification'},{serviceId:randomUUID()},{companyId:randomUUID()},{projectIds:[randomUUID()]},{profileSha256:'f'.repeat(64)},{releaseSha256:'e'.repeat(64)},{sourceCommit:'0'.repeat(40)},{sourceTree:'0'.repeat(40)},{hostConfigurationSha256:'0'.repeat(64)},{qualifierSha256:'0'.repeat(64)},{bootId:randomUUID()},{uid:1002},{gid:1001},{serviceRoot:f.config.cgroupRoot},{units:{...f.receipt.units,worker:{...f.receipt.units.worker,sha256:'0'.repeat(64)}}},{acceptedAt:new Date(Date.now()+10000).toISOString()},{qualified:false},{checks:{...f.receipt.checks,preparedImages:false}},{expiresAt:new Date(Date.now()+1000).toISOString()}])assert.throws(()=>assertReferenceRunnerReceipt({...f.receipt,...patch},f.config,f.host),ReferenceRunnerError);
 for(const change of [{uploadHosts:['new-upload.example']},{cgroupRoot:'/sys/fs/cgroup/another/decoders'},{origin:'https://another.example'},{scratchRoot:'/var/lib/other/scratch'}])assert.throws(()=>assertReferenceRunnerReceipt(f.receipt,{...f.config,...change},f.host),ReferenceRunnerError);
});

test('receipt location is excluded without excluding host scope, unit or native identity',()=>{
 const f=fixture();assert.equal(referenceRunnerConfigurationHash(deriveReferenceRunnerConfiguration(f.host.host,'0'.repeat(64))),referenceRunnerConfigurationHash(f.config));
 for(const scope of [{...f.host.host.scope,companyId:randomUUID()},{...f.host.host.scope,projectIds:[randomUUID()]},{...f.host.host.scope,uploadHosts:['different.example']}])assert.notEqual(referenceRunnerConfigurationHash(deriveReferenceRunnerConfiguration({...f.host.host,scope},'0'.repeat(64))),referenceRunnerConfigurationHash(f.config));
});

test('delegation accepts only the actual current unit and forbids drop-ins, reloads and other processes',()=>{
 const f=fixture(),id=f.config.serviceId,name=`coatria-reference-${id}-qualify.service`,root='/system.slice/'+name,invocation='8'.repeat(32);
 assert.deepEqual(referenceHostDelegatedPath(`0::${root}/supervisor\n`,id,'qualify'),{serviceRoot:'/sys/fs/cgroup'+root,supervisorGroup:'/sys/fs/cgroup'+root+'/supervisor',cgroupRoot:'/sys/fs/cgroup'+root+'/decoders'});
 for(const path of [`0::${root}\n`,`0::${root}/supervisor/child\n`,`0::/other.slice/${name}/supervisor\n`,`0::${root}/supervisor\n0::/other\n`])assert.throws(()=>referenceHostDelegatedPath(path,id,'qualify'));
 const state={FragmentPath:'/etc/systemd/system/'+name,DropInPaths:'',NeedDaemonReload:'no',Transient:'no',ControlGroup:root,User:'coatria-reference',Group:'coatria-reference',InvocationID:invocation,MainPID:'1234',UnitFileState:'static'},raw=(value:Record<string,string>)=>Object.entries(value).map(([k,v])=>k+'='+v).join('\n');
 assert.equal(assertReferenceHostUnitState(raw(state),id,'qualify',1234,invocation),invocation);
 for(const patch of [{FragmentPath:'/run/systemd/system/'+name},{DropInPaths:'/etc/systemd/system/service.d/override.conf'},{NeedDaemonReload:'yes'},{Transient:'yes'},{ControlGroup:'/other'},{User:'root'},{Group:'root'},{InvocationID:'9'.repeat(32)},{MainPID:'0'},{UnitFileState:'enabled'}])assert.throws(()=>assertReferenceHostUnitState(raw({...state,...patch}),id,'qualify',1234,invocation));
 assert.throws(()=>assertReferenceHostUnitState(raw(state)+'\nMainPID=1234',id,'qualify',1234,invocation));
});
test('runner accepts only dedicated opaque token and refuses inherited broad credentials or injection',()=>{
 const token='rfs_'+'x'.repeat(43);assert.equal(referenceRunnerToken({COATRIA_REFERENCE_SERVICE_TOKEN:token,PATH:'/usr/bin',LANG:'C'}),token);
 for(const name of ['DATABASE_URL','COATRIA_HOSTING_KEYRING','RUNPOD_API_KEY','COATRIA_VERCEL_MEDIA_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_USE_ENV_PROXY','SSL_CERT_FILE','HTTPS_PROXY','https_proxy','LD_PRELOAD'])assert.throws(()=>referenceRunnerToken({COATRIA_REFERENCE_SERVICE_TOKEN:token,[name]:'must-not-reach-worker'}),ReferenceRunnerError);
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
 for(const args of [['--config','/nonexistent/reference.json','--sha256','a'.repeat(64),'--preflight'],['--host','/nonexistent/host.json','--bundle','a'.repeat(64),'--preflight']])await assert.rejects(runReferenceWorker(args,{COATRIA_REFERENCE_SERVICE_TOKEN:'rfs_'+'x'.repeat(43)}));
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
