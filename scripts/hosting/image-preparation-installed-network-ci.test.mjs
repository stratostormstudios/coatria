import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createImagePreparationInstalledNetworkCi,imagePreparationInstalledNetworkCiPlan,imagePreparationNetworkCiEnvironment,imagePreparationNetworkCiHosts,imagePreparationNetworkCiFirewall,assertImagePreparationNetworkCiFirewall} from './image-preparation-installed-network-ci.mjs';
import {imagePreparationHostUnit,imagePreparationHostHash} from './image-preparation-host-package.mjs';

const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const rejected=error=>error instanceof Error&&/^IMAGE_PREPARATION_NETWORK_CI_(?:REJECTED|CLEANUP_FAILED)$/.test(error.message);
function kernelTable(plan,packets=0){
 const match=(left,right)=>({match:{op:'==',left,right}}),owner=match({meta:{key:'skuid'}},plan.uid),rule=(expr,comment)=>({rule:{family:'inet',table:plan.table,chain:'output',expr,comment,handle:4}});
 return {nftables:[{metainfo:{version:'1.0.9',json_schema_version:1}},{table:{family:'inet',name:plan.table,handle:1}},{chain:{family:'inet',table:plan.table,name:'output',handle:2,type:'filter',hook:'output',prio:-300,policy:'accept'}},rule([owner,match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},443),{accept:null}],'coatria-ci-loopback-https'),rule([owner,{counter:{packets,bytes:packets*60}},{reject:{type:'icmpx',expr:'admin-prohibited'}}],'coatria-ci-deny-other')]};
}
function fixture({prior=null}={}){
 const id=randomUUID(),candidate='a'.repeat(40),bundleSha256='b'.repeat(64),release='/var/lib/coatria-image-preparation-releases/'+bundleSha256,base='/var/lib/coatria-image-preparation-enrollment-ci-'+randomUUID(),host={commit:candidate,bundleSha256,release,uid:2211,gid:2212,node:{path:release+'/runtime/node',sha256:'c'.repeat(64)},scope:{serviceId:id,origin:'https://coatria.com',gateways:[{projectId:randomUUID(),origin:'https://imagepreparationci1-4190.proxy.runpod.net'}]},units:Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,{name:`coatria-image-preparation-${id}-${mode}.service`,sha256:imagePreparationHostHash(imagePreparationHostUnit(mode,release,bundleSha256,id))}]))};
 const input={host,base,candidate},runtime={platform:'linux',arch:'x64',uid:0,ci:'true',candidate},plan=imagePreparationInstalledNetworkCiPlan(input,runtime),events=[],files=new Map(),metadata=new Map();
 const set=(path,value,mode=0o644,directory=false)=>{files.set(path,Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(value));metadata.set(path,{uid:0,gid:0,mode,directory});};
 set(base,'',0o755,true);set('/etc','',0o755,true);set(plan.markerPath,json(plan.marker),0o600);const hosts=Buffer.from('127.0.0.1 localhost\n::1 localhost\n'),caBundle=Buffer.from('existing-public-ca\n');set('/etc/hosts',hosts);set('/etc/ssl/certs/ca-certificates.crt',caBundle);
 const missing=()=>Object.assign(Error('synthetic missing'),{code:'ENOENT'});
 const fs={
  lstat:async path=>{if(!files.has(path))throw missing();const m=metadata.get(path);return {...m,isDirectory:()=>m.directory,isSymbolicLink:()=>false};},realpath:async path=>path,
  mkdir:async(path,options)=>{assert(!files.has(path));events.push(['mkdir',path]);set(path,'',options.mode,true);},
  writeFile:async(path,bytes,options)=>{if(options?.flag==='wx')assert(!files.has(path));events.push(['write',path]);set(path,bytes,options?.mode??0o644);},
  open:async(path,flags,mode)=>{if(flags==='wx'){assert(!files.has(path));set(path,'',mode);}else if(!files.has(path))throw missing();events.push(['open',path]);return {writeFile:async bytes=>set(path,bytes,mode??metadata.get(path).mode),sync:async()=>{},close:async()=>{events.push(['close',path]);}};},
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
   if(args[0]==='-f'){firewall=true;assert.equal(settings.input,imagePreparationNetworkCiFirewall(plan));}
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
  assert.deepEqual(await f.controller.cleanup(),{restored:true,firewallRemoved:true});assert(f.files.get('/etc/hosts').equals(f.hosts));assert(f.files.get('/etc/ssl/certs/ca-certificates.crt').equals(f.caBundle));assert.equal(f.getManager(),prior);assert.equal(f.getFirewall(),false);assert.equal(f.files.has(f.plan.keyPath),false);assert.equal(f.files.has(f.plan.installedCaPath),false);await assert.rejects(f.controller.setup(f.input),rejected);
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
