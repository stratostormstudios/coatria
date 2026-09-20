import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,link,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {ARCHIVE_HOST_PINS,archiveHostHash,parseArchiveRuntime,parseArchiveBundle,verifyArchiveTree,archiveHostProfiles,archiveHostReceiptCurrent,archiveHostDelegatedPath} from '../scripts/hosting/archive-host-package.mjs';
import {ARCHIVE_HOST_SOURCE_FILES,buildArchiveHostBundle} from '../scripts/hosting/build-archive-host-bundle.mjs';
import {archiveHostUnit,inspectArchiveHostBundle} from '../scripts/hosting/install-archive-host.mjs';
import {createArchiveHostCiCommand,ArchiveHostCiCommandError} from '../scripts/hosting/archive-host-ci-command.mjs';
import {createArchiveNpmEnvironment,ArchiveRuntimeExportError} from '../scripts/hosting/export-archive-host-runtime.mjs';
import {ArchiveHostRunError,archiveHostCanarySummary,archiveHostJournalFailure} from '../scripts/hosting/archive-host-diagnostics.mjs';

const git=(cwd:string,args:string[])=>{const result=spawnSync('git',['-c','core.autocrlf=false','-c','user.name=Archive Fixture','-c','user.email=archive-fixture@example.invalid','-C',cwd,...args],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
async function fixture(){
 const temp=await mkdtemp(join(tmpdir(),'coatria-archive-package-')),repo=join(temp,'repo'),runtime=join(temp,'runtime');await mkdir(repo);await mkdir(runtime);
 const files=new Map<string,Buffer>();for(const path of ['scripts/higgsfield-archive-worker.ts',...ARCHIVE_HOST_SOURCE_FILES.map((p:string)=>'scripts/hosting/'+p)])files.set(path,await readFile(resolve(path)));
 for(const ext of ['png','jpeg','webp','mp4','mov','wav','mp3'])files.set('tests/fixtures/media/synthetic.'+ext,await readFile(resolve('tests/fixtures/media/synthetic.'+ext)));
 files.set('src/lib/minimal.ts',Buffer.from('export const fixture = true;\n'));files.set('package.json',Buffer.from('{"name":"original-offline-package-fixture"}\n'));files.set('package-lock.json',Buffer.from('{"lockfileVersion":3,"packages":{}}\n'));
 for(const [path,bytes]of files){await mkdir(dirname(join(repo,path)),{recursive:true});await writeFile(join(repo,path),bytes);}
 git(repo,['init','--quiet']);git(repo,['add','.']);git(repo,['commit','--quiet','-m','Original isolated package fixture']);const commit=git(repo,['rev-parse','HEAD']);
 const entries=[];for(const path of ['node','media-sandbox-launch','media/real/bin/ffmpeg','media/real/bin/ffprobe','media/conformance/bin/ffmpeg','media/conformance/bin/ffprobe','node_modules/tsx/package.json','node_modules/pg/package.json']){
  // These are original test bytes, deliberately not executable Linux runtimes.
  const bytes=Buffer.from(path.includes('conformance')?'original conformance bytes':path+' synthetic fixture'),mode=path.endsWith('.json')?0o444:0o555;await mkdir(dirname(join(runtime,path)),{recursive:true});await writeFile(join(runtime,path),bytes);entries.push({path,bytes:bytes.length,sha256:archiveHostHash(bytes),mode});
 }
 const manifest=parseArchiveRuntime({version:1,platform:'linux-x64',pins:ARCHIVE_HOST_PINS,sourceHashes:{launcher:archiveHostHash(files.get('scripts/hosting/media-sandbox-launch.c')!),probe:archiveHostHash(files.get('scripts/hosting/media-sandbox-probe.c')!)},packageLockSha256:archiveHostHash(files.get('package-lock.json')!),bubblewrapSha256:'a'.repeat(64),files:entries});const bytes=JSON.stringify(manifest)+'\n';await writeFile(join(runtime,'runtime-manifest.json'),bytes);return {temp,repo,runtime,commit,manifest,runtimeHash:archiveHostHash(bytes),files};
}

test('archive bundle pins Git bytes, runtime inputs and ordinary ESM module layout without secrets',async t=>{
 const f=await fixture();t.after(()=>rm(f.temp,{recursive:true,force:true}));await writeFile(join(f.repo,'src/lib/minimal.ts'),'uncommitted change');await writeFile(join(f.repo,'.env.private'),'original canary outside the allowlisted source');
 const result=await buildArchiveHostBundle({sourceRoot:f.repo,commit:f.commit,runtimeRoot:f.runtime,runtimeManifestSha256:f.runtimeHash,output:join(f.temp,'bundle')});assert.equal(result.qualified,false);assert.equal(result.servicesEnabled,false);assert.equal(result.providerCalls,false);
 const bundle=await inspectArchiveHostBundle(result.output,result.bundleSha256);assert.equal(bundle.commit,f.commit);assert.equal((await readFile(join(result.output,'app/src/lib/minimal.ts'),'utf8')),'export const fixture = true;\n');assert.ok(!bundle.files.some((file:{path:string})=>file.path.includes('.env')));
 assert.ok(bundle.files.some((file:{path:string})=>file.path==='app/node_modules/tsx/package.json'));assert.ok(!bundle.files.some((file:{path:string})=>file.path==='runtime/node_modules/tsx/package.json'));
 const profiles=archiveHostProfiles(bundle,'/var/lib/coatria-archive-releases/'+result.bundleSha256);assert.equal(profiles.real.bubblewrap.path,'/usr/bin/bwrap');assert.equal(profiles.real.runtimeRoot,'/var/lib/coatria-archive-releases/'+result.bundleSha256+'/runtime/media/real');assert.equal(profiles.conformance.limits.memoryBytes,64*1024**2);
 const modified=structuredClone(bundle);modified.runtime.sourceHashes.launcher='b'.repeat(64);modified.runtimeManifestSha256=archiveHostHash(JSON.stringify(modified.runtime)+'\n');assert.throws(()=>parseArchiveBundle(modified),/ARCHIVE_HOST_PACKAGE_REJECTED/);
 await writeFile(join(result.output,'unexpected.env'),'excluded');await assert.rejects(inspectArchiveHostBundle(result.output,result.bundleSha256),/ARCHIVE_HOST_PACKAGE_REJECTED/);
});
test('offline builder rejects output containment, unreviewed digest and linked runtime files',async t=>{
 const f=await fixture();t.after(()=>rm(f.temp,{recursive:true,force:true}));const input={sourceRoot:f.repo,commit:f.commit,runtimeRoot:f.runtime,runtimeManifestSha256:f.runtimeHash};
 for(const output of [join(f.repo,'nested-output'),join(f.runtime,'nested-output')])await assert.rejects(buildArchiveHostBundle({...input,output}),/ARCHIVE_HOST_PACKAGE_REJECTED/);
 await assert.rejects(buildArchiveHostBundle({...input,runtimeManifestSha256:'0'.repeat(64),output:join(f.temp,'wrong-pin')}),/ARCHIVE_HOST_PACKAGE_REJECTED/);
 await link(join(f.runtime,'node'),join(f.temp,'node-hardlink'));await assert.rejects(verifyArchiveTree(f.runtime,f.manifest.files,{extra:['runtime-manifest.json']}),/ARCHIVE_HOST_PACKAGE_REJECTED/);
});
test('Git symlink blobs are rejected even when the allowlisted suffix looks like source',async t=>{
 const f=await fixture();t.after(()=>rm(f.temp,{recursive:true,force:true}));const blob=git(f.repo,['rev-parse','HEAD:src/lib/minimal.ts']);git(f.repo,['update-index','--cacheinfo','120000,'+blob+',src/lib/minimal.ts']);git(f.repo,['commit','--quiet','-m','Synthetic symlink index mode']);const commit=git(f.repo,['rev-parse','HEAD']);
 await assert.rejects(buildArchiveHostBundle({sourceRoot:f.repo,commit,runtimeRoot:f.runtime,runtimeManifestSha256:f.runtimeHash,output:join(f.temp,'symlink-source')}),/ARCHIVE_HOST_PACKAGE_REJECTED/);
});
test('Git replacement refs cannot substitute source underneath the reviewed commit identity',async t=>{
 const f=await fixture();t.after(()=>rm(f.temp,{recursive:true,force:true}));await writeFile(join(f.repo,'src/lib/minimal.ts'),'export const replacement = true;\n');git(f.repo,['add','src/lib/minimal.ts']);git(f.repo,['commit','--quiet','-m','Original alternate source fixture']);const other=git(f.repo,['rev-parse','HEAD']);git(f.repo,['replace',f.commit,other]);
 const built=await buildArchiveHostBundle({sourceRoot:f.repo,commit:f.commit,runtimeRoot:f.runtime,runtimeManifestSha256:f.runtimeHash,output:join(f.temp,'replace-resistant')});assert.equal(await readFile(join(built.output,'app/src/lib/minimal.ts'),'utf8'),'export const fixture = true;\n');assert.equal(built.commit,f.commit);
});
test('strict runtime format rejects escapes, duplicates, unpinned code and executable shared libraries',async t=>{
 const f=await fixture();t.after(()=>rm(f.temp,{recursive:true,force:true}));
 const nextChunk=structuredClone(f.manifest);nextChunk.files.push({path:'node_modules/next/dist/bundle-analyzer/_next/static/chunks/03~yq9q893hmn.js',bytes:1,sha256:'1'.repeat(64),mode:0o444});assert.doesNotThrow(()=>parseArchiveRuntime(nextChunk));
 for(const change of [(v:any)=>v.files[0].path='../node',(v:any)=>v.files.push({...v.files[0]}),(v:any)=>v.pins.nodeVersion='latest',(v:any)=>v.credentials={},(v:any)=>v.files.push({path:'media/real/lib64/arbitrary.so',bytes:1,sha256:'1'.repeat(64),mode:0o555})]){const value=structuredClone(f.manifest);change(value);assert.throws(()=>parseArchiveRuntime(value),/ARCHIVE_HOST_PACKAGE_REJECTED/);}
});
test('disabled systemd service delegates only its own subtree with bounded resource and stop policy',()=>{
 const sha='a'.repeat(64),release='/var/lib/coatria-archive-releases/'+sha;
 for(const mode of ['qualify','preflight','worker']){const unit=archiveHostUnit(mode,release,sha);assert.match(unit,/^User=coatria-archive$/m);assert.match(unit,/^Delegate=cpu memory pids$/m);assert.match(unit,/^DelegateSubgroup=supervisor$/m);assert.match(unit,/^KillMode=control-group$/m);assert.match(unit,/^Restart=no$/m);assert.match(unit,/^NoNewPrivileges=yes$/m);assert.match(unit,/^MemoryMax=2G$/m);assert.match(unit,/^MemorySwapMax=0$/m);assert.match(unit,/^TasksMax=256$/m);assert.doesNotMatch(unit,/^\[Install\]|^WantedBy=|^User=root|^ExecStart=.*(?:curl|wget|npm|docker|sudo)|^ProtectControlGroups=yes/m);}
 const worker=archiveHostUnit('worker',release,sha);assert.match(worker,/^ConditionPathExists=\/etc\/coatria-archive\/worker-enabled$/m);assert.match(worker,/^EnvironmentFile=\/etc\/coatria-archive\/worker.env$/m);assert.doesNotMatch(archiveHostUnit('qualify',release,sha),/^EnvironmentFile=/m);assert.throws(()=>archiveHostUnit('worker','/tmp/unreviewed',sha));
 const p=archiveHostDelegatedPath('0::/system.slice/coatria-archive-qualify.service/supervisor\n','qualify');assert.equal(p.cgroupRoot,'/sys/fs/cgroup/system.slice/coatria-archive-qualify.service/decoders');
 for(const value of ['0::/','0::/system.slice/other.service/supervisor','0::/system.slice/coatria-archive-worker.service/supervisor','0::/system.slice/../coatria-archive-qualify.service/supervisor'])assert.throws(()=>archiveHostDelegatedPath(value,'qualify'));
 const receipt={version:1,bundleSha256:sha,bootId:'current-boot'};assert.equal(archiveHostReceiptCurrent(receipt,sha,'current-boot'),true);assert.equal(archiveHostReceiptCurrent(receipt,sha,'new-boot'),false);assert.equal(archiveHostReceiptCurrent(receipt,'b'.repeat(64),'current-boot'),false);
});
test('CI account setup uses the Ubuntu administrative executable and reports only bounded failure facts',()=>{
 const calls:unknown[][]=[],privateText='synthetic-private-command-material';
 const command=createArchiveHostCiCommand(((...args:unknown[])=>{calls.push(args);return {status:null,error:{code:'ENOENT',message:privateText},stdout:privateText,stderr:privateText};}) as unknown as typeof spawnSync);
 assert.throws(()=>command('create_service_user',[privateText]),(error:unknown)=>{assert.ok(error instanceof ArchiveHostCiCommandError);assert.deepEqual(error.diagnostic,{operation:'create_service_user',status:null,errorCode:'ENOENT'});assert.equal(error.message,'ARCHIVE_HOST_CI_COMMAND_FAILED');assert.ok(!JSON.stringify(error).includes(privateText));return true;});
 assert.equal(calls[0][0],'/usr/sbin/useradd');assert.equal((calls[0][2] as {shell:boolean}).shell,false);
 assert.throws(()=>command(privateText,[]));assert.equal(calls.length,1,'unknown operation must not spawn');
});
test('CI command diagnostics retain numeric status and redact unknown error codes',()=>{
 const command=createArchiveHostCiCommand((()=>({status:12,error:{code:'synthetic-private-errno'},stdout:'private',stderr:'private'})) as unknown as typeof spawnSync);
 assert.throws(()=>command('install_acl',[]),(error:unknown)=>{assert.ok(error instanceof ArchiveHostCiCommandError);assert.deepEqual(error.diagnostic,{operation:'install_acl',status:12,errorCode:'UNKNOWN'});return true;});
 const success=createArchiveHostCiCommand((()=>({status:0,stdout:' inactive\n'})) as unknown as typeof spawnSync);assert.equal(success('read_unit_state',[]),'inactive');
});
test('offline npm uses distinct empty configuration sources instead of loading one source twice',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'coatria-archive-npm-'));t.after(()=>rm(temp,{recursive:true,force:true}));const env=await createArchiveNpmEnvironment(temp);
 assert.notEqual(env.NPM_CONFIG_USERCONFIG,env.NPM_CONFIG_GLOBALCONFIG);assert.equal(dirname(env.NPM_CONFIG_USERCONFIG),temp);assert.equal(dirname(env.NPM_CONFIG_GLOBALCONFIG),temp);assert.equal((await readFile(env.NPM_CONFIG_USERCONFIG)).length,0);assert.equal((await readFile(env.NPM_CONFIG_GLOBALCONFIG)).length,0);assert.equal(env.HOME,temp);assert.ok(!('DATABASE_URL'in env));
 await assert.rejects(createArchiveNpmEnvironment(temp),(error:unknown)=>(error as NodeJS.ErrnoException).code==='EEXIST','existing reviewed config must never be overwritten');
});
test('runtime export failures disclose only allowlisted stage and command outcome facts',()=>{
 const privateText='synthetic-private-path-and-output';const error=new ArchiveRuntimeExportError('npm_install',{code:'ENOENT',message:privateText,stderr:privateText},'npm_ci_offline',1);
 assert.deepEqual(error.diagnostic,{stage:'npm_install',code:'COMMAND_FAILED',operation:'npm_ci_offline',status:1,errorCode:'ENOENT'});assert.ok(!JSON.stringify(error).includes(privateText));
 const unknown=new ArchiveRuntimeExportError(privateText,{code:privateText,message:privateText},privateText,999);assert.deepEqual(unknown.diagnostic,{stage:'unknown_stage',code:'COMMAND_FAILED',operation:'unknown_operation',status:null,errorCode:'UNKNOWN'});
});
test('host startup failures preserve only static stages, known error codes and bounded canary counts',()=>{
 const privateText='synthetic-private-path-and-output';const summary=archiveHostCanarySummary({qualified:false,failureCode:'PROCESS_FAILED',tests:[{passed:true,name:privateText},{passed:false}],realFormats:[{path:privateText}],privateText});
 const error=new ArchiveHostRunError('qualification_canary',{code:'EACCES',message:privateText,stderr:privateText},summary);
 assert.deepEqual(error.diagnostic,{event:'archive-host-failed',code:'ARCHIVE_HOST_PRECONDITION_OR_QUALIFICATION_FAILED',stage:'qualification_canary',errorCode:'EACCES',canary:{failureCode:'PROCESS_FAILED',testsPassed:1,formatsPassed:1}});assert.ok(!JSON.stringify(error).includes(privateText));
 assert.equal(new ArchiveHostRunError('delegation_cpu_limit',{message:'ARCHIVE_HOST_PACKAGE_REJECTED'}).diagnostic.errorCode,'CHECK_FAILED');
 assert.equal(new ArchiveHostRunError(privateText,{code:privateText,message:privateText}).diagnostic.stage,'unknown_stage');assert.equal(new ArchiveHostRunError('host_identity',{code:privateText}).diagnostic.errorCode,'UNKNOWN');
 assert.equal(archiveHostCanarySummary({qualified:false,tests:Array(11).fill({passed:true}),realFormats:[]}),null);assert.equal(archiveHostCanarySummary({qualified:true,tests:[],realFormats:[]}),null);
});
test('CI failure evidence accepts fixed JSON only from the latest service invocation',()=>{
 const current='a'.repeat(32),previous='b'.repeat(32),privateText='synthetic-private-journal-material';const diagnostic=new ArchiveHostRunError('delegation_enable',{code:'EPERM'}).diagnostic;
 const row=(id:string,message:unknown)=>JSON.stringify({_SYSTEMD_INVOCATION_ID:id,MESSAGE:typeof message==='string'?message:JSON.stringify(message),unrelated:privateText});
 const journal=[row(previous,new ArchiveHostRunError('host_identity',{code:'EACCES'}).diagnostic),row(current,privateText),row(current,{...diagnostic,privateText}),row(current,{...diagnostic,stage:privateText})].join('\n');
 assert.deepEqual(archiveHostJournalFailure(journal,current),diagnostic);assert.ok(!JSON.stringify(archiveHostJournalFailure(journal,current)).includes(privateText));assert.equal(archiveHostJournalFailure(row(previous,diagnostic),current),null);assert.equal(archiveHostJournalFailure(journal,privateText),null);
 const calls:unknown[][]=[];const command=createArchiveHostCiCommand(((...args:unknown[])=>{calls.push(args);return {status:0,stdout:journal};}) as unknown as typeof spawnSync);assert.equal(command('read_qualifier_diagnostics',['--no-pager']),journal);assert.equal(calls[0][0],'/usr/bin/journalctl');
});
