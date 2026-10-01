import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../src/lib/higgsfield-image-preparation';
import {ImagePreparationRunnerError,parseImagePreparationHostConfiguration,parseImagePreparationRunnerConfiguration,deriveImagePreparationRunnerConfiguration,assertImagePreparationRunnerReceipt,imagePreparationRunnerConfigurationHash,parseImagePreparationRunnerToken,imagePreparationRunnerProcessor,type ImagePreparationHostConfiguration} from '../scripts/hosting/image-preparation-runner-configuration.mjs';
import {assertImagePreparationRunnerEnvironment,assertImagePreparationRunnerActivation,assertImagePreparationRunnerScratchEmpty,drainImagePreparationRunnerClients,preflightImagePreparationRunnerClient,runImagePreparationWorkerLoop,runImagePreparationWorker} from '../scripts/hosting/run-image-preparation-worker.mjs';
import {imagePreparationHostDelegatedPath,assertImagePreparationHostUnitState} from '../scripts/hosting/image-preparation-host-delegation.mjs';

/** Contract fixtures are synthetic metadata only, never accepted host evidence. */
function fixture(){
 const now=Date.now(),serviceId=randomUUID(),companyId=randomUUID(),projectIds=[randomUUID()],bootId=randomUUID(),expiresAt=new Date(now+60000).toISOString(),bundleSha256='a'.repeat(64),release='/var/lib/coatria-image-preparation-releases/'+bundleSha256;
 const units=Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,{name:`coatria-image-preparation-${serviceId}-${mode}.service`,sha256:'b'.repeat(64)}])) as ImagePreparationHostConfiguration['units'];
 const host:ImagePreparationHostConfiguration={version:1,bundleSha256,commit:'c'.repeat(40),tree:'d'.repeat(40),release,closureSha256:'e'.repeat(64),recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,uid:1001,gid:1002,scope:{serviceId,companyId,projectIds,origin:'https://coatria.example',location:'synthetic Linux fixture',expiresAt,gateways:[{projectId:projectIds[0],origin:'https://gateway.example'}]},profiles:{real:{profilePath:`/etc/coatria-image-preparation/${serviceId}/real.json`,expectedProfileSha256:'f'.repeat(64)},conformance:{profilePath:`/etc/coatria-image-preparation/${serviceId}/conformance.json`,expectedProfileSha256:'0'.repeat(64)}},worker:{path:release+'/worker/runtime.mjs',sha256:'1'.repeat(64)},qualifier:{path:release+'/qualifier/runtime.mjs',sha256:'2'.repeat(64)},node:{path:release+'/runtime/node',sha256:'3'.repeat(64)},units};
 const hostConfigurationSha256='4'.repeat(64),config=deriveImagePreparationRunnerConfiguration(host,hostConfigurationSha256,'5'.repeat(64)),identity={host,hostConfigurationSha256,bootId,uid:host.uid,gid:host.gid};
 const receipt={version:1,kind:'coatria-image-preparation-qualification-v1',serviceId,companyId,projectIds,sourceCommit:host.commit,sourceTree:host.tree,bundleSha256,releaseSha256:config.releaseSha256,closureSha256:config.closureSha256,recipeSha256:config.recipeSha256,qualifierSha256:host.qualifier.sha256,configurationSha256:imagePreparationRunnerConfigurationHash(config),hostConfigurationSha256,profileSha256:config.profileSha256,conformanceProfileSha256:config.conformanceProfileSha256,bootId,uid:host.uid,gid:host.gid,expiresAt,units,qualifierInvocationId:'6'.repeat(32),serviceRoot:'/sys/fs/cgroup/system.slice/'+units.qualify.name,evidenceSha256:'7'.repeat(64),reportSha256:'8'.repeat(64),acceptedAt:new Date(now-1000).toISOString(),qualified:true,checks:{isolation:true,resourceLimits:true,descendantCleanup:true,imagePreparation:true}};
 return {now,config,identity,receipt};
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('finite configuration binds distinct image scope, exact paths, gateways, recipe and process identity',()=>{
 const f=fixture();assert.deepEqual(parseImagePreparationHostConfiguration(f.identity.host,f.now),f.identity.host);assert.deepEqual(parseImagePreparationRunnerConfiguration(f.config,f.now),f.config);
 for(const change of [{expiresAt:new Date(f.now).toISOString()},{expiresAt:new Date(f.now+3600001).toISOString()},{projectIds:[]},{projectIds:[...f.config.projectIds,...f.config.projectIds]},{gateways:[]},{gateways:[{projectId:randomUUID(),origin:'https://gateway.example'}]},{gateways:[{projectId:f.config.projectIds[0],origin:'http://gateway.example'}]},{origin:'https://coatria.example/redirect'},{scratchRoot:'/tmp/shared'},{temporaryRoot:'/tmp'},{runtimePath:'/opt/caller.mjs'},{node:{...f.config.node,path:'/usr/bin/node'}},{profilePath:'/etc/reference/real.json'},{cgroupRoot:'/sys/fs/cgroup/decoders'},{qualification:{...f.config.qualification,path:'/tmp/qualified.json'}},{recipeSha256:'0'.repeat(64)},{uid:0},{providerCredential:'no'},{nativeFallback:true},{command:'ffmpeg'}])assert.throws(()=>parseImagePreparationRunnerConfiguration({...f.config,...change},f.now),ImagePreparationRunnerError);
 for(const change of [{release:'/var/lib/other'},{worker:{...f.identity.host.worker,path:'/usr/bin/node'}},{profiles:{...f.identity.host.profiles,real:{...f.identity.host.profiles.real,profilePath:'/tmp/profile.json'}}}])assert.throws(()=>parseImagePreparationHostConfiguration({...f.identity.host,...change},f.now));
});
test('accepted receipt must bind exact current boot, source, units, profiles, closure and finite configuration',()=>{
 const f=fixture();assert.equal(assertImagePreparationRunnerReceipt(f.receipt,f.config,f.identity,f.now).qualified,true);
 for(const patch of [{version:2},{kind:'coatria-reference-worker-qualification'},{kind:'image-preparation-transform'},{serviceId:randomUUID()},{companyId:randomUUID()},{projectIds:[randomUUID()]},{sourceCommit:'0'.repeat(40)},{sourceTree:'0'.repeat(40)},{bundleSha256:'0'.repeat(64)},{releaseSha256:'0'.repeat(64)},{closureSha256:'0'.repeat(64)},{recipeSha256:'0'.repeat(64)},{qualifierSha256:'0'.repeat(64)},{configurationSha256:'0'.repeat(64)},{hostConfigurationSha256:'0'.repeat(64)},{profileSha256:'0'.repeat(64)},{conformanceProfileSha256:'1'.repeat(64)},{bootId:randomUUID()},{uid:1002},{gid:1001},{qualifierInvocationId:'0'.repeat(32)},{serviceRoot:f.config.cgroupRoot},{units:{...f.receipt.units,worker:{...f.receipt.units.worker,sha256:'0'.repeat(64)}}},{acceptedAt:new Date(f.now+1).toISOString()},{qualified:false},{checks:{...f.receipt.checks,imagePreparation:false}},{checks:{...f.receipt.checks,descendantCleanup:false}},{expiresAt:new Date(f.now+1000).toISOString()}])assert.throws(()=>assertImagePreparationRunnerReceipt({...f.receipt,...patch},f.config,f.identity,f.now),ImagePreparationRunnerError);
 for(const change of [{origin:'https://other.example'},{location:'elsewhere'},{gateways:[{...f.config.gateways[0],origin:'https://other.example'}]},{node:{...f.config.node,sha256:'0'.repeat(64)}}])assert.throws(()=>assertImagePreparationRunnerReceipt(f.receipt,{...f.config,...change},f.identity,f.now));
});
test('configuration digest excludes only qualification locator/hash and processor maps exact enrollment pins',()=>{
 const f=fixture(),digest=imagePreparationRunnerConfigurationHash(f.config);
 assert.equal(imagePreparationRunnerConfigurationHash({...f.config,qualification:{path:'/unused/locator',sha256:'0'.repeat(64)}}),digest);
 for(const patch of [{hostConfigurationSha256:'0'.repeat(64)},{closureSha256:'0'.repeat(64)},{releaseSha256:'0'.repeat(64)},{sourceCommit:'0'.repeat(40)},{sourceTree:'0'.repeat(40)},{profileSha256:'0'.repeat(64)},{recipeSha256:'0'.repeat(64)},{companyId:randomUUID()},{projectIds:[randomUUID()]},{temporaryRoot:'/tmp/other'},{expiresAt:new Date(f.now+50000).toISOString()},{units:{...f.config.units,worker:{...f.config.units.worker,sha256:'0'.repeat(64)}}}])assert.notEqual(imagePreparationRunnerConfigurationHash({...f.config,...patch}),digest);
 assert.deepEqual(imagePreparationRunnerProcessor(f.config),{id:f.config.serviceId,location:f.config.location,transport:'linux_binary_v1',qualificationSha256:f.config.qualification.sha256,releaseSha256:f.config.releaseSha256,profileSha256:f.config.profileSha256,sourceCommit:f.config.sourceCommit,closureSha256:f.config.closureSha256,recipeSha256:f.config.recipeSha256,expiresAt:f.config.expiresAt});
});
test('protected token and activation metadata are exact; inherited credentials and injection are rejected',()=>{
 const f=fixture(),token='ips_'+'x'.repeat(43),payload={version:1,serviceId:f.config.serviceId,configurationSha256:imagePreparationRunnerConfigurationHash(f.config),expiresAt:f.config.expiresAt,token};
 assert.equal(parseImagePreparationRunnerToken(payload,f.config),token);
 for(const patch of [{serviceId:randomUUID()},{configurationSha256:'0'.repeat(64)},{expiresAt:new Date(f.now+10000).toISOString()},{token:'ipt_'+'x'.repeat(43)},{token:'ips_short'},{databaseUrl:'must-not-reach-worker'}])assert.throws(()=>parseImagePreparationRunnerToken({...payload,...patch},f.config));
 const {token:_token,...base}=payload,marker={...base,qualificationSha256:f.config.qualification.sha256};assertImagePreparationRunnerActivation(marker,f.config);
 for(const patch of [{qualificationSha256:'0'.repeat(64)},{serviceId:randomUUID()},{enabled:true},{token}])assert.throws(()=>assertImagePreparationRunnerActivation({...marker,...patch},f.config));
 assertImagePreparationRunnerEnvironment({PATH:'/usr/bin',LANG:'C',INVOCATION_ID:'6'.repeat(32)});
 for(const name of ['DATABASE_URL','PGPASSWORD','COATRIA_HOSTING_KEYRING','RUNPOD_API_KEY','COATRIA_IMAGE_PREPARATION_SERVICE_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_USE_ENV_PROXY','SSL_CERT_FILE','HTTPS_PROXY','https_proxy','LD_PRELOAD'])assert.throws(()=>assertImagePreparationRunnerEnvironment({[name]:'must-not-reach-worker'}),ImagePreparationRunnerError);
});
test('delegation requires actual dedicated loaded unit, invocation, process and exact cgroup',()=>{
 const f=fixture(),id=f.config.serviceId,name=f.config.units.qualify.name,root='/system.slice/'+name,invocation='8'.repeat(32);
 assert.deepEqual(imagePreparationHostDelegatedPath(`0::${root}/supervisor\n`,id,'qualify'),{serviceRoot:'/sys/fs/cgroup'+root,supervisorGroup:'/sys/fs/cgroup'+root+'/supervisor',cgroupRoot:'/sys/fs/cgroup'+root+'/decoders'});
 for(const path of [`0::${root}\n`,`0::${root}/supervisor/child\n`,`0::/other.slice/${name}/supervisor\n`,`0::${root}/supervisor\n0::/other\n`])assert.throws(()=>imagePreparationHostDelegatedPath(path,id,'qualify'));
 const state={FragmentPath:'/etc/systemd/system/'+name,DropInPaths:'',NeedDaemonReload:'no',Transient:'no',ControlGroup:root,User:'coatria-image-preparation',Group:'coatria-image-preparation',InvocationID:invocation,MainPID:'1234',UnitFileState:'static'},raw=(value:Record<string,string>)=>Object.entries(value).map(([k,v])=>k+'='+v).join('\n');
 assert.equal(assertImagePreparationHostUnitState(raw(state),id,'qualify',1234,invocation),invocation);
 for(const patch of [{FragmentPath:'/run/systemd/system/'+name},{DropInPaths:'/etc/systemd/system/service.d/override.conf'},{NeedDaemonReload:'yes'},{Transient:'yes'},{ControlGroup:'/other'},{User:'coatria-reference'},{Group:'root'},{InvocationID:'9'.repeat(32)},{MainPID:'0'},{UnitFileState:'enabled'}])assert.throws(()=>assertImagePreparationHostUnitState(raw({...state,...patch}),id,'qualify',1234,invocation));
 assert.throws(()=>assertImagePreparationHostUnitState(raw(state)+'\nMainPID=1234',id,'qualify',1234,invocation));
});
test('preflight invokes readiness only and settles actual cleanup before returning',async()=>{
 const signal=new AbortController().signal,held=deferred(),events:string[]=[];let returned=false;
 const client={async readiness(actual?:AbortSignal){assert.equal(actual,signal);events.push('readiness');return {} as never;},close(){events.push('close');},async drain(){events.push('drain');await held.promise;events.push('drained');},control:{claim(){assert.fail('preflight must never claim');}}};
 const result=preflightImagePreparationRunnerClient(client,signal).then(()=>{returned=true;});await new Promise(r=>setImmediate(r));assert.deepEqual(events,['readiness','close','drain']);assert.equal(returned,false);held.resolve();await result;assert.deepEqual(events,['readiness','close','drain','drained']);
});
test('preflight failure or cancellation still drains and never admits work',async()=>{
 for(const cancelled of [false,true]){const stop=new AbortController(),events:string[]=[];if(cancelled)stop.abort();await assert.rejects(preflightImagePreparationRunnerClient({async readiness(){events.push('readiness');throw Error('fixed rejection');},close(){events.push('close');},async drain(){events.push('drained');}},stop.signal));assert.deepEqual(events,cancelled?['close','drained']:['readiness','close','drained']);}
 const stop=new AbortController();await assert.rejects(preflightImagePreparationRunnerClient({async readiness(){stop.abort();return {} as never;},close(){},async drain(){}},stop.signal),ImagePreparationRunnerError);
});
test('runner admits only sequential attempts after their actual drain',async()=>{
 const stop=new AbortController(),held=deferred(),events:string[]=[];let calls=0;
 const loop=runImagePreparationWorkerLoop({async runNext(){calls++;events.push('claim'+calls);if(calls===2)stop.abort();return {processed:false,status:'idle'};}},{signal:stop.signal,idleMs:1,async afterAttempt(){events.push('drain'+calls);if(calls===1)await held.promise;events.push('drained'+calls);}});
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);held.resolve();await loop;assert.deepEqual(events,['claim1','drain1','drained1','claim2','drain2','drained2']);
});
test('unknown claims and uncertain/blocked/failed work stop once after cleanup without replay',async()=>{
 for(const status of ['disabled','uncertain','blocked','failed'] as const){let calls=0,drains=0;await assert.rejects(runImagePreparationWorkerLoop({async runNext(){calls++;return {processed:status!=='disabled',status};}},{signal:new AbortController().signal,idleMs:1,async afterAttempt(){drains++;}}),ImagePreparationRunnerError);assert.equal(calls,1);assert.equal(drains,1);}
 let calls=0,drains=0;await assert.rejects(runImagePreparationWorkerLoop({async runNext(){calls++;throw Error('claim response lost');}},{signal:new AbortController().signal,idleMs:1,async afterAttempt(){drains++;}}));assert.equal(calls,1);assert.equal(drains,1);
});
test('cancellation waits for current attempt and cleanup; cleanup failure prevents any successor',async()=>{
 const stop=new AbortController(),operation=deferred(),cleanup=deferred();let settled=false,calls=0;
 const loop=runImagePreparationWorkerLoop({async runNext(){calls++;await operation.promise;return {processed:false,status:'idle'};}},{signal:stop.signal,idleMs:1,afterAttempt:()=>cleanup.promise}).then(()=>{settled=true;});stop.abort();await new Promise(r=>setImmediate(r));assert.equal(settled,false);operation.resolve();await new Promise(r=>setImmediate(r));assert.equal(settled,false);cleanup.resolve();await loop;assert.equal(calls,1);
 calls=0;await assert.rejects(runImagePreparationWorkerLoop({async runNext(){calls++;return {processed:true,status:'ready'};}},{signal:new AbortController().signal,idleMs:1,async afterAttempt(){throw new ImagePreparationRunnerError('IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');}}),(error:unknown)=>error instanceof ImagePreparationRunnerError&&error.code==='IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED');assert.equal(calls,1);
});
test('client cleanup failure retains ownership and still drains every other client',async()=>{
 const events:string[]=[],clients=new Set([{close(){events.push('close1');throw Error('unsafe private detail');},async drain(){events.push('drain1');}},{close(){events.push('close2');},async drain(){events.push('drain2');throw Error('unsafe private detail');}}]);
 await assert.rejects(drainImagePreparationRunnerClients(clients),(e:unknown)=>e instanceof ImagePreparationRunnerError&&e.code==='IMAGE_PREPARATION_RUNNER_CLEANUP_FAILED'&&!String(e).includes('private detail'));assert.equal(clients.size,2);assert.deepEqual(events,['close1','close2','drain1','drain2']);
 const healthy=new Set([{close(){},async drain(){}}]);await drainImagePreparationRunnerClients(healthy);assert.equal(healthy.size,0);
});
test('restart refuses leftover bytes or directories without deleting or reflecting their names',async t=>{
 const root=await mkdtemp(join(tmpdir(),'image-preparation-runner-'));t.after(()=>rm(root,{recursive:true,force:true}));const empty=join(root,'empty'),files=join(root,'files'),attempts=join(root,'attempts');for(const path of [empty,files,attempts])await mkdir(path);
 const name='private-source.png',bytes=Buffer.from('private original fixture');await writeFile(join(files,name),bytes);await mkdir(join(attempts,'unconfirmed-attempt'));await assertImagePreparationRunnerScratchEmpty(empty);
 for(const path of [files,attempts,join(root,'missing'),join(files,name)])await assert.rejects(assertImagePreparationRunnerScratchEmpty(path),(e:unknown)=>e instanceof ImagePreparationRunnerError&&e.code==='IMAGE_PREPARATION_RUNNER_UNQUALIFIED'&&!String(e).includes(name)&&!String(e).includes(root));
 assert.deepEqual(await readdir(files),[name]);assert.deepEqual(await readFile(join(files,name)),bytes);assert.deepEqual(await readdir(attempts),['unconfirmed-attempt']);
});
test('entrypoint rejects unconfigured or noncanonical preflight without a provider call or fake qualification',async()=>{
 await assert.rejects(runImagePreparationWorker(['--host','/nonexistent/host.json','--bundle','a'.repeat(64),'--preflight'],{}));
 const entry=fileURLToPath(new URL('../scripts/hosting/run-image-preparation-worker.mts',import.meta.url)),result=spawnSync(process.execPath,['--import','tsx',entry],{encoding:'utf8',timeout:15000,windowsHide:true});
 assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.deepEqual(result.stderr.trim().split(/\r?\n/).map(line=>JSON.parse(line)),[{event:'image-preparation-worker-stopped',code:'IMAGE_PREPARATION_RUNNER_UNAVAILABLE'}]);
});
