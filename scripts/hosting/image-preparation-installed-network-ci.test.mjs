import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,lstat,unlink,rmdir} from 'node:fs/promises';
import {createImagePreparationInstalledNetworkCi,imagePreparationInstalledNetworkCiPlan,imagePreparationNetworkCiEnvironment,imagePreparationNetworkCiHosts,imagePreparationNetworkCiFirewall,assertImagePreparationNetworkCiFirewall,imagePreparationNetworkCiNftDiagnostic} from './image-preparation-installed-network-ci.mjs';
import {imagePreparationHostUnit,imagePreparationHostHash} from './image-preparation-host-package.mjs';

const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const rejected=error=>error instanceof Error&&/^IMAGE_PREPARATION_NETWORK_CI_(?:REJECTED|CLEANUP_FAILED)$/.test(error.message);
const nativeCi=process.platform==='linux'&&process.getuid?.()===0&&process.env.CI==='true';
test('native nft compares stdin with private regular-file input and validates unchanged policy without applying it',{skip:nativeCi?false:'Requires disposable root Linux CI with nftables'},async()=>{
 assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''),'Requires exact CI source commit');
 const plan={uid:1000,table:'coatria_image_prep_ci_'+randomUUID().replaceAll('-','')};
 const privateDirectory='/var/lib/coatria-image-preparation-network-precheck-'+randomUUID(),policy=imagePreparationNetworkCiFirewall(plan),sha=bytes=>createHash('sha256').update(bytes).digest('hex');let directoryCreated=false,cleanupFailed=false;
 const report={version:1,kind:'image-preparation-network-native-precheck',sourceCommit:process.env.GITHUB_SHA,nodeVersion:process.version,passed:false,checkOnly:true,noProviderCalls:true,policySha256:sha(policy),sourceHashes:{},checks:[],privateFilesRemoved:false};
 const settings={env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'},shell:false,encoding:'utf8',timeout:15000,maxBuffer:131072,killSignal:'SIGKILL',windowsHide:true};
 const run=(args,input)=>spawnSync('/usr/sbin/nft',args,{...settings,...input===undefined?{stdio:['ignore','pipe','pipe']}:{input}});
 const absent=()=>{const value=run(['--numeric','--json','list','tables']);assert(!value.error&&!value.signal&&value.status===0,'Native nft table observation failed');const rows=JSON.parse(value.stdout).nftables;assert(Array.isArray(rows)&&!rows.some(row=>row.table?.family==='inet'&&row.table.name===plan.table),'Dry-run table must remain absent');};
 // --check validates the transaction with the real parser/kernel but does not
 // apply it. No live UID rule, host mapping, certificate or provider is changed.
 // https://netfilter.org/projects/nftables/manpage.html
 try{
  for(const file of ['scripts/hosting/image-preparation-installed-network-ci.mjs','scripts/hosting/image-preparation-installed-network-ci.test.mjs','.github/workflows/ci.yml'])report.sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  absent();
  const witness=spawnSync(process.execPath,['--input-type=module','-e',"import{fstatSync}from'node:fs';const s=fstatSync(0);console.log(JSON.stringify({socket:s.isSocket(),fifo:s.isFIFO(),regular:s.isFile()}));"],{...settings,input:'synthetic'});
  assert(!witness.error&&!witness.signal&&witness.status===0,'Native stdin descriptor witness failed');const kind=JSON.parse(witness.stdout);assert(Object.keys(kind).sort().join(',')==='fifo,regular,socket'&&Object.values(kind).every(value=>typeof value==='boolean'));report.stdinDescriptor=kind;
  const retain=(transport,valid,input,value)=>{const check={transport,validBatch:valid,policySha256:sha(input),status:Number.isInteger(value.status)&&value.status>=0&&value.status<=255?value.status:null,processError:Boolean(value.error),signaled:Boolean(value.signal),tableRemainedAbsent:false,diagnostic:value.status===0?null:imagePreparationNetworkCiNftDiagnostic(value.stderr)};report.checks.push(check);absent();check.tableRemainedAbsent=true;return check;};
  const previous=run(['--check','--file','-'],policy),comparison=retain('stdin',true,policy,previous);assert(!previous.error&&!previous.signal&&[0,1].includes(previous.status),'Native stdin comparison did not finish');report.stdinRejectedAsNonRegular=previous.status===1&&comparison.diagnostic.categories.includes('stdin-not-regular-file');
  await mkdir(privateDirectory,{mode:0o700});directoryCreated=true;
  for(const [valid,input,name]of [[true,policy,'valid.nft'],[false,policy.replace('meta skuid','meta invalid_ci_key'),'malformed.nft']]){
   const path=privateDirectory+'/'+name;await writeFile(path,input,{flag:'wx',mode:0o600});const info=await lstat(path);assert(info.isFile()&&!info.isSymbolicLink()&&info.uid===0&&info.gid===0&&(info.mode&0o7777)===0o600,'Expected private regular policy file');assert.equal((await readFile(path)).toString(),input);
   const value=run(['--check','--file',path]),check=retain('regular-file',valid,input,value),diagnostic=check.diagnostic;
   assert(!value.error&&!value.signal,'Native nft validation did not finish');
   assert.equal(value.status,valid?0:1,JSON.stringify({kind:'image-preparation-network-native-check',validBatch:valid,diagnostic}));
   if(!valid)assert(diagnostic.categories.includes('syntax-error'),'Malformed batch must reach the parser');
  }
  report.passed=true;
 }finally{
  if(directoryCreated){for(const name of ['valid.nft','malformed.nft'])try{await unlink(privateDirectory+'/'+name);}catch(error){if(error.code!=='ENOENT')cleanupFailed=true;}try{await rmdir(privateDirectory);}catch{cleanupFailed=true;}}
  report.privateFilesRemoved=!cleanupFailed;report.passed=report.passed&&!cleanupFailed;await mkdir('.devdata/media-sandbox-linux/evidence',{recursive:true});await writeFile('.devdata/media-sandbox-linux/evidence/image-preparation-network-precheck.json',JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o444});if(cleanupFailed)throw Error('Native nft private input cleanup failed');
 }
});
function kernelTable(plan,packets=0){
 const match=(left,right)=>({match:{op:'==',left,right}}),owner=match({meta:{key:'skuid'}},plan.uid),rule=(expr,comment)=>({rule:{family:'inet',table:plan.table,chain:'output',expr,comment,handle:4}});
 return {nftables:[{metainfo:{version:'1.0.9',json_schema_version:1}},{table:{family:'inet',name:plan.table,handle:1}},{chain:{family:'inet',table:plan.table,name:'output',handle:2,type:'filter',hook:'output',prio:-300,policy:'accept'}},rule([owner,match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},443),{accept:null}],'coatria-ci-loopback-https'),rule([owner,{counter:{packets,bytes:packets*60}},{reject:{type:'icmpx',expr:'admin-prohibited'}}],'coatria-ci-deny-other')]};
}
function fixture({prior=null}={}){
 const id=randomUUID(),candidate='a'.repeat(40),bundleSha256='b'.repeat(64),release='/var/lib/coatria-image-preparation-releases/'+bundleSha256,base='/var/lib/coatria-image-preparation-enrollment-ci-'+randomUUID(),host={commit:candidate,bundleSha256,release,uid:2211,gid:2212,node:{path:release+'/runtime/node',sha256:'c'.repeat(64)},scope:{serviceId:id,origin:'https://coatria.com',gateways:[{projectId:randomUUID(),origin:'https://imagepreparationci1-4190.proxy.runpod.net'}]},units:Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,{name:`coatria-image-preparation-${id}-${mode}.service`,sha256:imagePreparationHostHash(imagePreparationHostUnit(mode,release,bundleSha256,id))}]))};
 const input={host,base,candidate},runtime={platform:'linux',arch:'x64',uid:0,ci:'true',candidate},plan=imagePreparationInstalledNetworkCiPlan(input,runtime),events=[],files=new Map(),metadata=new Map();let nextInode=100;
 const set=(path,value,mode=0o644,directory=false)=>{files.set(path,Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(value));metadata.set(path,{uid:0,gid:0,mode,directory,dev:1,ino:metadata.get(path)?.ino??nextInode++});};
 set(base,'',0o755,true);set('/etc','',0o755,true);set(plan.markerPath,json(plan.marker),0o600);const hosts=Buffer.from('127.0.0.1 localhost\n::1 localhost\n'),caBundle=Buffer.from('existing-public-ca\n');set('/etc/hosts',hosts);set('/etc/ssl/certs/ca-certificates.crt',caBundle);
 const missing=()=>Object.assign(Error('synthetic missing'),{code:'ENOENT'});
 const fs={
  lstat:async path=>{if(!files.has(path))throw missing();const m=metadata.get(path);return {...m,nlink:1,isFile:()=>!m.directory,isDirectory:()=>m.directory,isSymbolicLink:()=>false};},realpath:async path=>path,
  mkdir:async(path,options)=>{assert(!files.has(path));events.push(['mkdir',path]);set(path,'',options.mode,true);},
  writeFile:async(path,bytes,options)=>{if(options?.flag==='wx')assert(!files.has(path));events.push(['write',path]);set(path,bytes,options?.mode??0o644);},
  open:async(path,flags,mode)=>{if(flags==='wx'){assert(!files.has(path));set(path,'',mode);}else if(!files.has(path))throw missing();events.push(['open',path]);return {stat:async()=>{const m=metadata.get(path);return {...m,nlink:1,isFile:()=>!m.directory,isSymbolicLink:()=>false};},writeFile:async bytes=>set(path,bytes,mode??metadata.get(path).mode),sync:async()=>{},close:async()=>{events.push(['close',path]);}};},
  rename:async(from,to)=>{assert(files.has(from));events.push(['rename',to]);files.set(to,files.get(from));metadata.set(to,metadata.get(from));files.delete(from);metadata.delete(from);},
  unlink:async path=>{if(!files.has(path))throw missing();events.push(['unlink',path]);files.delete(path);metadata.delete(path);},chmod:async(path,mode)=>{metadata.get(path).mode=mode;}
 };
 let managerValue=prior,firewall=false,packets=0,qualifierRunning=false,pendingJob='',failedCommand=null,mutateProbe=false;
 const options={fs,runtime:()=>runtime,assertHost:async()=>{events.push(['verify-host']);},readTrustedFile:async(path,maximum)=>{if(!files.has(path))throw missing();const bytes=files.get(path);assert(bytes.length<=maximum);return Buffer.from(bytes);},certificateHash:()=> 'd'.repeat(64),exec:(program,args,settings)=>{
  events.push(['exec',program,args,settings]);if(failedCommand?.(program,args))return {status:1,stdout:'',stderr:'private synthetic diagnostic'};
  let stdout='',status=0;
  if(program==='/usr/bin/systemctl'){
   if(args[0]==='show-environment')stdout='LANG=C\nPRIVATE_TEST_VALUE=not-returned\n'+(managerValue===null?'':'NODE_USE_SYSTEM_CA='+managerValue+'\n');
   else if(args[0]==='set-environment')managerValue=args[1].split('=')[1];else if(args[0]==='unset-environment')managerValue=null;
   else if(args[0]==='show')stdout=`ActiveState=${qualifierRunning&&args[1].endsWith('-qualify.service')?'active':'inactive'}\nSubState=${qualifierRunning&&args[1].endsWith('-qualify.service')?'exited':'dead'}\nMainPID=0\nControlPID=0\nJob=${pendingJob}\n`;
   else assert.fail('unexpected systemctl operation');
  }else if(program==='/usr/bin/id')stdout=String(args[0]==='-u'?host.uid:host.gid)+'\n';
  else if(program==='/usr/bin/pgrep')status=1;
  else if(program==='/usr/sbin/nft'){
   if(args[0]==='-f'){assert.deepEqual(args,['-f',plan.rulesPath]);assert.equal(settings.input,undefined);assert.deepEqual(settings.stdio,['ignore','pipe','pipe']);assert.equal(files.get(plan.rulesPath).toString(),imagePreparationNetworkCiFirewall(plan));firewall=true;}
   else if(args.includes('tables'))stdout=JSON.stringify({nftables:firewall?[{table:{family:'inet',name:plan.table}}]:[]});
   else if(args[0]==='delete')firewall=false;else stdout=JSON.stringify(kernelTable(plan,packets));
  }else if(program==='/usr/bin/openssl'){
   if(args[0]!=='verify'){const output=args[args.indexOf('-out')+1];set(output,output.endsWith('ca.crt')?'synthetic-public-ca':'synthetic-public-certificate');if(args.includes('-keyout'))set(args[args.indexOf('-keyout')+1],'synthetic-test-key',0o600);}
  }else if(program==='/usr/sbin/update-ca-certificates')set('/etc/ssl/certs/ca-certificates.crt',files.has(plan.installedCaPath)?Buffer.concat([caBundle,files.get(plan.installedCaPath)]):caBundle);
  else if(program===host.node.path){if(args[2].includes('blockedIPv4')){assert(firewall);packets+=mutateProbe?0:2;stdout=JSON.stringify({blockedIPv4:true,blockedIPv6:true,acceptedConnections:0,uid:host.uid,gid:host.gid,nodeVersion:'v24.19.0'});}else stdout=JSON.stringify({systemCaPresent:true,nodeVersion:'v24.19.0'});}
  else assert.fail('unexpected program '+program);
  return {status,stdout,stderr:''};
 }};
 return {input,runtime,plan,host,events,files,metadata,hosts,caBundle,options,controller:createImagePreparationInstalledNetworkCi(options),getFirewall:()=>firewall,getManager:()=>managerValue,setQualifierRunning:value=>{qualifierRunning=value;},setPendingJob:value=>{pendingJob=value;},failCommand:fn=>{failedCommand=fn;},fakeProbe:()=>{mutateProbe=true;}};
}

test('default entry is inert and setup refuses this non-CI host before any command',async()=>{
 let calls=0;const controller=createImagePreparationInstalledNetworkCi({runtime:()=>({platform:'win32',arch:'x64',uid:0,ci:'true',candidate:'a'.repeat(40)}),exec:()=>{calls++;throw Error('must not execute');}});await assert.rejects(controller.setup(fixture().input),rejected);assert.equal(calls,0);
});
test('plan requires exact disposable marker scope, installed source and both fixed HTTPS origins',()=>{
 const f=fixture();assert.equal(f.plan.marker.disposableHost,true);assert.equal(f.plan.marker.candidate,f.input.candidate);
 for(const runtime of [{...f.runtime,ci:'false'},{...f.runtime,uid:1000},{...f.runtime,candidate:'e'.repeat(40)},{...f.runtime,platform:'darwin'}])assert.throws(()=>imagePreparationInstalledNetworkCiPlan(f.input,runtime),rejected);
 for(const change of [{base:'/tmp/arbitrary'},{candidate:'e'.repeat(40)},{host:{...f.host,scope:{...f.host.scope,origin:'https://other.example'}}},{host:{...f.host,scope:{...f.host.scope,gateways:[{origin:'https://imagepreparationci1-8080.proxy.runpod.net'}]}}},{host:{...f.host,units:{...f.host.units,worker:{...f.host.units.worker,sha256:'0'.repeat(64)}}}}])assert.throws(()=>imagePreparationInstalledNetworkCiPlan({...f.input,...change},f.runtime),rejected);
});
test('hosts preserves original bytes and only adds fixed IPv4 names; prior mappings and malformed bytes reject',()=>{
 const f=fixture(),next=imagePreparationNetworkCiHosts(Buffer.from('127.0.0.1 localhost'),f.plan);assert.equal(next.toString(),'127.0.0.1 localhost\n'+f.plan.hostsSuffix);assert(!f.plan.hostsSuffix.includes('::1'));assert.throws(()=>imagePreparationNetworkCiHosts(Buffer.from('10.0.0.1 COATRIA.COM\n'),f.plan),rejected);assert.throws(()=>imagePreparationNetworkCiHosts(Buffer.from([0xff]),f.plan),rejected);
});
test('manager projection never returns other values and rejects ambiguous or insecure TLS settings',()=>{
 assert.equal(imagePreparationNetworkCiEnvironment('LANG=C\nPRIVATE_TEST_VALUE=hidden\nNODE_USE_SYSTEM_CA=0\n').prior,'0');assert(!JSON.stringify(imagePreparationNetworkCiEnvironment('PRIVATE_TEST_VALUE=hidden\n')).includes('hidden'));
 for(const raw of ['NODE_USE_SYSTEM_CA=0\nNODE_USE_SYSTEM_CA=1\n','NODE_USE_SYSTEM_CA=unexpected\n','NODE_TLS_REJECT_UNAUTHORIZED=0\n','broken','x'.repeat(131073)])assert.throws(()=>imagePreparationNetworkCiEnvironment(raw),rejected);
});
test('kernel rule proof requires family-wide denial, exact UID, single loopback endpoint and counter',()=>{
 const f=fixture();assert.deepEqual(assertImagePreparationNetworkCiFirewall(JSON.stringify(kernelTable(f.plan,2)),f.plan),{packets:2,bytes:120});
 for(const mutate of [v=>{v.nftables[2].chain.hook='input';},v=>{v.nftables[3].rule.expr[0].match.right++;},v=>{v.nftables[3].rule.expr[1].match.right='0.0.0.0';},v=>{v.nftables[3].rule.expr[2].match.right=8444;},v=>{v.nftables[4].rule.expr.pop();},v=>{v.nftables[4].rule.expr[2]={accept:null};},v=>{v.nftables[4].rule.expr[1].counter.packets=-1;},v=>{v.nftables.push(v.nftables[3]);}]){const value=kernelTable(f.plan);mutate(value);assert.throws(()=>assertImagePreparationNetworkCiFirewall(JSON.stringify(value),f.plan),rejected);}
});
test('synthetic I/O lifecycle fences UID before mappings, verifies TLS flags and restores owned state exactly',async()=>{
 for(const prior of [null,'0','1']){const f=fixture({prior}),result=await f.controller.setup(f.input);assert.equal(result.keyPath,f.plan.keyPath);assert.equal(result.proof.remoteConnectionAttempts,0);assert.equal(result.proof.tlsVerificationDisabled,false);assert.equal(result.proof.acceptanceAuthority,false);assert.equal(f.getManager(),'1');assert(f.getFirewall());assert(!JSON.stringify(result.proof).includes('not-returned'));
  const block=f.events.findIndex(e=>e[0]==='exec'&&e[1]==='/usr/sbin/nft'&&e[2][0]==='-f'),map=f.events.findIndex(e=>e[0]==='rename'&&e[1]==='/etc/hosts');assert(block>=0&&map>block);
  for(const event of f.events.filter(e=>e[0]==='exec')){const [,program,args,options]=event;assert.equal(options.shell,false);assert(Number(options.timeout)<=60000);assert(!args.some(arg=>['enable','start','daemon-reload','daemon-reexec'].includes(arg)));assert(!Object.hasOwn(options.env,'NODE_TLS_REJECT_UNAUTHORIZED'));assert(!JSON.stringify(options.env).includes('not-returned'));if(program===f.host.node.path&&args[2].includes('blockedIPv4')){assert(args[2].includes("['127.0.0.1','::1']"));assert(!args[2].includes('https://'));}}
  assert.deepEqual(await f.controller.cleanup(),{restored:true,firewallRemoved:true});assert(f.files.get('/etc/hosts').equals(f.hosts));assert(f.files.get('/etc/ssl/certs/ca-certificates.crt').equals(f.caBundle));assert.equal(f.getManager(),prior);assert.equal(f.getFirewall(),false);assert.equal(f.files.has(f.plan.keyPath),false);assert.equal(f.files.has(f.plan.installedCaPath),false);assert.equal(f.files.has(f.plan.rulesPath),false);await assert.rejects(f.controller.setup(f.input),rejected);
 }
});
test('missing exact marker and counterfeit network-denial counters cannot enable mapping',async()=>{
 const f=fixture();f.files.set(f.plan.markerPath,json({...f.plan.marker,disposableHost:false}));await assert.rejects(f.controller.setup(f.input),rejected);assert(!f.events.some(e=>e[0]==='exec'));assert.equal(f.getFirewall(),false);
 const g=fixture();g.fakeProbe();await assert.rejects(g.controller.setup(g.input),rejected);assert(g.getFirewall());assert(g.files.get('/etc/hosts').equals(g.hosts));assert.equal(g.getManager(),null);await g.controller.cleanup();assert.equal(g.getFirewall(),false);
});
test('partial setup remains cleanable, while live units or hosts drift retain egress block',async()=>{
 const f=fixture();f.failCommand((program,args)=>program==='/usr/bin/openssl'&&args[0]==='req');await assert.rejects(f.controller.setup(f.input),rejected);assert(f.getFirewall());f.failCommand(null);await f.controller.cleanup();assert.equal(f.getFirewall(),false);
 const g=fixture();await g.controller.setup(g.input);g.setQualifierRunning(true);await assert.rejects(g.controller.cleanup(),rejected);assert(g.getFirewall());assert.equal(g.getManager(),'1');g.setQualifierRunning(false);g.files.set('/etc/hosts',Buffer.from('unrelated changed hosts\n'));await assert.rejects(g.controller.cleanup(),rejected);assert(g.getFirewall());assert.equal(g.files.get('/etc/hosts').toString(),'unrelated changed hosts\n');
});
test('teardown refuses a retained activation marker or queued unit start before restoring any network state',async()=>{
 for(const marker of [true,false]){const f=fixture();await f.controller.setup(f.input);if(marker)f.files.set('/etc/coatria-image-preparation/'+f.host.scope.serviceId+'/worker-enabled',Buffer.from('synthetic marker'));else f.setPendingJob('42');const count=f.events.length;await assert.rejects(f.controller.cleanup(),rejected);assert(f.getFirewall());assert.equal(f.getManager(),'1');assert(f.files.get('/etc/hosts').equals(imagePreparationNetworkCiHosts(f.hosts,f.plan)));assert(!f.events.slice(count).some(event=>event[0]==='exec'&&['delete','unset-environment','set-environment'].includes(event[2][0])));}
});

test('diagnostic identifies pre-mutation validation without exposing retained bytes and keeps first failure',async()=>{
 const f=fixture(),initial=f.controller.diagnostic();assert.equal(initial.phase,'idle');assert.equal(initial.failure,null);assert.equal(initial.lastCommand,null);assert.deepEqual(initial.attempted,{firewall:false,hosts:false,ca:false,environment:false});
 f.files.set(f.plan.markerPath,json({...f.plan.marker,privateField:'PRIVATE_MARKER_BYTES'}));await assert.rejects(f.controller.setup(f.input),rejected);
 const before=f.controller.diagnostic();assert.equal(before.failure.phase,'setup-marker');assert.equal(before.failure.lastCommand,null);assert.equal(before.initialized,false);assert.deepEqual(before.attempted,initial.attempted);
 await f.controller.cleanup();const after=f.controller.diagnostic();assert.equal(after.phase,'cleanup-complete');assert.equal(after.finished,true);assert.deepEqual(after.failure,before.failure);
 for(const text of ['PRIVATE_MARKER_BYTES',f.host.scope.serviceId,f.plan.base])assert(!JSON.stringify(after).includes(text));
 before.failure.phase='caller-change';assert.equal(f.controller.diagnostic().failure.phase,'setup-marker');
});

test('diagnostic fixes command category/status and first failure through failed and successful cleanup',async()=>{
 const f=fixture();f.failCommand((program,args)=>program==='/usr/bin/openssl'&&args[0]==='req');await assert.rejects(f.controller.setup(f.input),rejected);
 const before=f.controller.diagnostic();assert.equal(before.failure.phase,'setup-ca-generate');assert.deepEqual(before.failure.lastCommand,{phase:'setup-ca-generate',category:'tls-openssl',status:1,signal:null,errno:null});assert.deepEqual(before.attempted,{firewall:true,hosts:false,ca:false,environment:false});assert.equal(before.firewall.counterValid,true);
 f.failCommand(null);f.setPendingJob('PRIVATE_QUEUED_JOB');await assert.rejects(f.controller.cleanup(),rejected);const blocked=f.controller.diagnostic();assert.equal(blocked.phase,'cleanup-units');assert(blocked.units.some(unit=>unit.jobPresent));assert.deepEqual(blocked.failure,before.failure);assert(f.getFirewall());
 f.setPendingJob('');await f.controller.cleanup();const after=f.controller.diagnostic();assert.equal(after.finished,true);assert.deepEqual(after.failure,before.failure);assert(after.units.every(unit=>!unit.jobPresent));assert.equal(after.lastCommand.category,'firewall-list-tables');
 const serialized=JSON.stringify([before,blocked,after]);for(const text of ['PRIVATE_QUEUED_JOB','private synthetic diagnostic','not-returned','synthetic-test-key',f.plan.table,f.host.node.path])assert(!serialized.includes(text));assert(serialized.length<10000);
});

test('diagnostic limits thrown and returned exec errors to safe errno/signal values',async()=>{
 for(const kind of ['thrown','returned','unknown']){const f=fixture(),normal=f.options.exec;const controller=createImagePreparationInstalledNetworkCi({...f.options,exec:(program,args,options)=>{
  if(program==='/usr/sbin/nft'&&args[0]==='-f'){const error=Object.assign(Error('PRIVATE_EXEC_MESSAGE'),{code:kind==='unknown'?'PRIVATE_CODE':'ETIMEDOUT'});if(kind==='thrown')throw error;return {status:null,signal:kind==='unknown'?'PRIVATE_SIGNAL':'SIGKILL',error,stdout:'PRIVATE_STDOUT',stderr:'PRIVATE_STDERR'};}return normal(program,args,options);
 }});await assert.rejects(controller.setup(f.input),rejected);const value=controller.diagnostic();assert.equal(value.failure.phase,'setup-firewall-install');assert.equal(value.failure.errno,kind==='unknown'?'OTHER':'ETIMEDOUT');assert.equal(value.failure.lastCommand.category,'firewall-install');assert.equal(value.failure.lastCommand.errno,kind==='unknown'?'OTHER':'ETIMEDOUT');assert.equal(value.failure.lastCommand.signal,kind==='thrown'?null:kind==='unknown'?'OTHER':'SIGKILL');assert(!JSON.stringify(value).includes('PRIVATE'));assert(value.attempted.firewall);await controller.cleanup();assert.deepEqual(controller.diagnostic().failure,value.failure);}
});

test('diagnostic projects kernel mismatches as fixed booleans without relaxing firewall validation',async()=>{
 const f=fixture(),normal=f.options.exec;let malformed=true;
 const controller=createImagePreparationInstalledNetworkCi({...f.options,exec:(program,args,options)=>{const result=normal(program,args,options);if(malformed&&program==='/usr/sbin/nft'&&args.includes('table')&&args.includes('list')){const value=kernelTable(f.plan);value.nftables[3].rule.expr[0]={match:{op:'==',left:{meta:{key:'skuid'}},right:'PRIVATE_UID_TEXT'}};value.nftables[3].rule.comment='PRIVATE_RULE_COMMENT';return {...result,stdout:JSON.stringify(value)};}return result;}});
 await assert.rejects(controller.setup(f.input),rejected);const value=controller.diagnostic();assert.equal(value.failure.phase,'setup-firewall-verify');assert.equal(value.firewall.jsonValid,true);assert.equal(value.firewall.ruleCount,2);assert.equal(value.firewall.allowOwnerMatch,false);assert.equal(value.firewall.denyOwnerMatch,true);assert.equal(value.firewall.rejectCode,'admin-prohibited');assert(!JSON.stringify(value).includes('PRIVATE'));assert(f.getFirewall());assert(f.files.get('/etc/hosts').equals(f.hosts));malformed=false;await controller.cleanup();assert.deepEqual(controller.diagnostic().failure,value.failure);
});

test('successful pgrep no-match is not a failure and unavailable unit fields project safely',async()=>{
 const f=fixture(),normal=f.options.exec;const controller=createImagePreparationInstalledNetworkCi({...f.options,exec:(program,args,options)=>{const result=normal(program,args,options);if(program==='/usr/bin/systemctl'&&args[0]==='show')return {...result,stdout:'ActiveState=PRIVATE_ACTIVE\nSubState=PRIVATE_SUB\nMainPID=PRIVATE_PID\nControlPID=0\nJob=PRIVATE_JOB\n'};return result;}});
 await assert.rejects(controller.setup(f.input),rejected);const rejectedState=controller.diagnostic();assert.equal(rejectedState.failure.phase,'setup-units');assert.deepEqual(rejectedState.units,[{mode:'preflight',activeState:'other',subState:'other',mainPidZero:false,controlPidZero:true,jobPresent:true}]);assert(!JSON.stringify(rejectedState).includes('PRIVATE'));
 const good=fixture();await good.controller.setup(good.input);assert.equal(good.controller.diagnostic().failure,null);assert.equal(good.controller.diagnostic().phase,'setup-complete');await good.controller.cleanup();assert.equal(good.controller.diagnostic().failure,null);
});

test('nft diagnostic keeps only fixed error categories and bounded stdin coordinates',()=>{
 const raw='/dev/stdin:4:107-110: Error: syntax error, unexpected type\nPRIVATE_CREDENTIAL PRIVATE_PATH PRIVATE_TABLE\n';
 assert.deepEqual(imagePreparationNetworkCiNftDiagnostic(raw),{categories:['syntax-error','unexpected-type'],locations:[{line:4,column:107,endColumn:110}]});
 assert.deepEqual(imagePreparationNetworkCiNftDiagnostic('PRIVATE_ERROR -:999:900-999: operation not permitted'),{categories:['operation-not-permitted'],locations:[]});
 assert.deepEqual(imagePreparationNetworkCiNftDiagnostic('Error: Could not process rule: No such file or directory'),{categories:['missing-object'],locations:[]});
 assert.deepEqual(imagePreparationNetworkCiNftDiagnostic('Error: Not a regular file: "/dev/stdin"\n'),{categories:['stdin-not-regular-file'],locations:[]});
 assert.deepEqual(imagePreparationNetworkCiNftDiagnostic('internal:0:0-0: Error: Not a regular file: "/dev/stdin"\n'),{categories:['stdin-not-regular-file'],locations:[]});
 assert.deepEqual(imagePreparationNetworkCiNftDiagnostic('PRIVATE_UNKNOWN'),{categories:['unclassified'],locations:[]});
 assert.deepEqual(imagePreparationNetworkCiNftDiagnostic('x'.repeat(131073)),{categories:['unavailable'],locations:[]});
});

test('private rule input is exclusive and is verified before the firewall command',async()=>{
 const f=fixture();f.files.set(f.plan.rulesPath,Buffer.from('PRIVATE_EXISTING_FILE'));f.metadata.set(f.plan.rulesPath,{uid:0,gid:0,mode:0o600,directory:false});
 await assert.rejects(f.controller.setup(f.input),rejected);assert(!f.events.some(event=>event[0]==='exec'&&event[1]==='/usr/sbin/nft'&&event[2][0]==='-f'));await f.controller.cleanup();assert.equal(f.files.get(f.plan.rulesPath).toString(),'PRIVATE_EXISTING_FILE');
 const g=fixture(),read=g.options.readTrustedFile,controller=createImagePreparationInstalledNetworkCi({...g.options,readTrustedFile:async(path,maximum)=>path===g.plan.rulesPath?Buffer.from('PRIVATE_CHANGED_RULE'):read(path,maximum)});
 await assert.rejects(controller.setup(g.input),rejected);assert(!g.events.some(event=>event[0]==='exec'&&event[1]==='/usr/sbin/nft'&&event[2][0]==='-f'));assert.equal(g.getFirewall(),false);assert(!JSON.stringify(controller.diagnostic()).includes('PRIVATE'));
 await assert.rejects(controller.cleanup(),rejected);assert(g.files.has(g.plan.rulesPath));
});

test('failed nft installation preserves the sanitized rejection reason across restoration',async()=>{
 const f=fixture(),normal=f.options.exec,controller=createImagePreparationInstalledNetworkCi({...f.options,exec:(program,args,options)=>{
  if(program==='/usr/sbin/nft'&&args[0]==='-f')return {status:1,stdout:'PRIVATE_STDOUT',stderr:'-:4:1-3: Error: Operation not supported\nPRIVATE_STDERR'};
  return normal(program,args,options);
 }});
 await assert.rejects(controller.setup(f.input),rejected);const before=controller.diagnostic();assert.deepEqual(before.nftError,{categories:['not-supported'],locations:[{line:4,column:1,endColumn:3}]});assert.equal(before.failure.phase,'setup-firewall-install');assert(!JSON.stringify(before).includes('PRIVATE'));
 await controller.cleanup();assert.deepEqual(controller.diagnostic().nftError,before.nftError);assert.deepEqual(controller.diagnostic().failure,before.failure);assert.equal(controller.diagnostic().finished,true);
});
