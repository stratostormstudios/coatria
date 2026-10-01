/** Disposable root Linux CI only. No provider routes, worker fetch replacement,
 * TLS bypass, unit edits, drop-ins or service starts. Construct before setup so
 * cleanup remains callable after a partial failure. */
import {spawnSync} from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import {createHash,X509Certificate} from 'node:crypto';
import {archiveHostRead,archiveHostTrusted,archiveHostFileHash} from './archive-host-package.mjs';
import {readImagePreparationHostConfiguration,imagePreparationHostUnit,imagePreparationHostHash} from './image-preparation-host-package.mjs';

export const IMAGE_PREPARATION_NETWORK_CI_ORIGINS=Object.freeze(['https://coatria.com','https://imagepreparationci1-4190.proxy.runpod.net']);
const names=IMAGE_PREPARATION_NETWORK_CI_ORIGINS.map(value=>new URL(value).hostname);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{40}$/;
const env=Object.freeze({PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'});
const lockPath='/run/coatria-image-preparation-network-ci.lock',hostsPath='/etc/hosts',caBundle='/etc/ssl/certs/ca-certificates.crt';
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n'),hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
/** @returns {never} */
function fail(code='IMAGE_PREPARATION_NETWORK_CI_REJECTED'){throw Error(code);}
function check(value){if(!value)fail();}
const context=()=>({platform:process.platform,arch:process.arch,uid:process.getuid?.(),ci:process.env.CI,candidate:process.env.GITHUB_SHA});

export function imagePreparationInstalledNetworkCiPlan({host,base,candidate},runtime){
 check(runtime?.platform==='linux'&&runtime.arch==='x64'&&runtime.uid===0&&runtime.ci==='true'&&runtime.candidate===candidate&&sha.test(candidate??''));
 check(typeof base==='string'&&/^\/var\/lib\/coatria-image-preparation-enrollment-ci-[a-f0-9-]{36}$/.test(base)&&uuid.test(base.slice(-36))&&host?.commit===candidate&&uuid.test(host.scope?.serviceId??'')&&host.scope.origin===IMAGE_PREPARATION_NETWORK_CI_ORIGINS[0]&&Array.isArray(host.scope.gateways)&&host.scope.gateways.length>0&&host.scope.gateways.every(value=>value.origin===IMAGE_PREPARATION_NETWORK_CI_ORIGINS[1]));
 check(Number.isSafeInteger(host.uid)&&host.uid>0&&Number.isSafeInteger(host.gid)&&host.gid>0&&/^[a-f0-9]{64}$/.test(host.bundleSha256??'')&&host.release==='/var/lib/coatria-image-preparation-releases/'+host.bundleSha256&&host.node?.path===host.release+'/runtime/node'&&/^[a-f0-9]{64}$/.test(host.node.sha256??''));
 for(const mode of ['qualify','preflight','worker'])check(host.units?.[mode]?.name===`coatria-image-preparation-${host.scope.serviceId}-${mode}.service`&&host.units[mode].sha256===imagePreparationHostHash(imagePreparationHostUnit(mode,host.release,host.bundleSha256,host.scope.serviceId)));
 const id=host.scope.serviceId,network=base+'/network',table='coatria_image_prep_ci_'+id.replaceAll('-','');
 return {base,network,candidate,serviceId:id,uid:host.uid,gid:host.gid,table,rulesPath:network+'/firewall.nft',markerPath:base+'/installed-network-authority.json',caPath:network+'/ca.crt',keyPath:network+'/server.key',certPath:network+'/server.crt',installedCaPath:'/usr/local/share/ca-certificates/coatria-image-preparation-ci-'+id+'.crt',hostsSuffix:`127.0.0.1 ${names.join(' ')} # coatria-image-preparation-ci:${id}\n`,marker:{version:1,kind:'coatria-image-preparation-disposable-network-ci',candidate,serviceId:id,disposableHost:true}};
}
/** No broad manager environment is retained or reported. Only absent/0/1 for
 * this boolean is supported; unfamiliar preexisting values fail before changes. */
export function imagePreparationNetworkCiEnvironment(raw){
 check(typeof raw==='string'&&Buffer.byteLength(raw)<=131072);const rows=raw.trim()?raw.trim().split('\n'):[],seen=new Set();let prior=null;
 for(const row of rows){const match=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(row);check(match&&!seen.has(match[1]));seen.add(match[1]);if(match[1]==='NODE_USE_SYSTEM_CA'){check(['0','1'].includes(match[2]));prior=match[2];}if(match[1]==='NODE_TLS_REJECT_UNAUTHORIZED')fail();}
 return {prior,othersSha256:hash(rows.filter(row=>!row.startsWith('NODE_USE_SYSTEM_CA=')).sort().join('\n'))};
}
export function imagePreparationNetworkCiHosts(original,plan){
 check(Buffer.isBuffer(original)&&original.length<=1024*1024&&Buffer.from(original.toString('utf8')).equals(original));
 for(const line of original.toString('utf8').split('\n')){const fields=line.split('#',1)[0].trim().split(/\s+/).slice(1);check(!fields.some(value=>names.includes(value.toLowerCase())));}
 return Buffer.concat([original,original.length&&original.at(-1)!==10?Buffer.from('\n'):Buffer.alloc(0),Buffer.from(plan.hostsSuffix)]);
}
export function imagePreparationNetworkCiFirewall(plan){
 check(/^coatria_image_prep_ci_[a-f0-9]{32}$/.test(plan.table)&&Number.isSafeInteger(plan.uid)&&plan.uid>0);
 return `add table inet ${plan.table}\nadd chain inet ${plan.table} output { type filter hook output priority -300; policy accept; }\nadd rule inet ${plan.table} output meta skuid ${plan.uid} ip daddr 127.0.0.1 tcp dport 443 accept comment "coatria-ci-loopback-https"\nadd rule inet ${plan.table} output meta skuid ${plan.uid} counter reject with icmpx type admin-prohibited comment "coatria-ci-deny-other"\n`;
}
/** Actual kernel JSON must contain exactly our chain and two rules. The second
 * rule is family-independent and denies IPv6, DNS and every non443 destination. */
export function assertImagePreparationNetworkCiFirewall(raw,plan){
 let value;try{value=JSON.parse(raw);}catch{fail();}check(Array.isArray(value?.nftables)&&value.nftables.length<=8);
 const tables=value.nftables.filter(row=>row.table).map(row=>row.table),chains=value.nftables.filter(row=>row.chain).map(row=>row.chain),rules=value.nftables.filter(row=>row.rule).map(row=>row.rule);
 check(tables.length===1&&chains.length===1&&rules.length===2&&value.nftables.every(row=>Object.keys(row).length===1&&['metainfo','table','chain','rule'].includes(Object.keys(row)[0])));
 check(tables[0].family==='inet'&&tables[0].name===plan.table);const chain=chains[0];check(chain.family==='inet'&&chain.table===plan.table&&chain.name==='output'&&chain.type==='filter'&&chain.hook==='output'&&chain.prio===-300&&chain.policy==='accept');
 const match=(left,right)=>({match:{op:'==',left,right}}),owner=match({meta:{key:'skuid'}},plan.uid);
 for(const rule of rules)check(rule.family==='inet'&&rule.table===plan.table&&rule.chain==='output'&&Array.isArray(rule.expr));
 check(rules[0].comment==='coatria-ci-loopback-https'&&canonical(rules[0].expr)===canonical([owner,match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},443),{accept:null}]));
 // NFT_REJECT_ICMPX_ADMIN_PROHIBITED is 3; --numeric may serialize that enum.
 const deny=rules[1];check(deny.comment==='coatria-ci-deny-other'&&deny.expr.length===3&&canonical(deny.expr[0])===canonical(owner)&&exact(deny.expr[1].counter,['packets','bytes'])&&Number.isSafeInteger(deny.expr[1].counter.packets)&&deny.expr[1].counter.packets>=0&&Number.isSafeInteger(deny.expr[1].counter.bytes)&&deny.expr[1].counter.bytes>=0&&[canonical({reject:{type:'icmpx',expr:'admin-prohibited'}}),canonical({reject:{type:'icmpx',expr:3}})].includes(canonical(deny.expr[2])));
 return {packets:deny.expr[1].counter.packets,bytes:deny.expr[1].counter.bytes};
}

// Both sockets are local and already listening before UID drop. No external
// address, DNS name, HTTP client, provider endpoint or credential is involved.
const DENY_PROBE=`import net from'node:net';try{if(process.version!=='v24.19.0')throw Error();const uid=Number(process.argv[1]),gid=Number(process.argv[2]);let accepted=0;const servers=[];for(const host of ['127.0.0.1','::1']){const s=net.createServer(c=>{accepted++;c.destroy();});await new Promise((r,j)=>{s.once('error',j);s.listen({host,port:8444,ipv6Only:host==='::1'},r);});servers.push(s);}process.setgroups([]);process.setgid(gid);process.setuid(uid);const results=[];for(const host of ['127.0.0.1','::1'])results.push(await new Promise(r=>{const s=net.connect({host,port:8444}),timer=setTimeout(()=>{s.destroy();r(false);},1500);s.once('connect',()=>{clearTimeout(timer);s.destroy();r(false);});s.once('error',e=>{clearTimeout(timer);r(['EACCES','EPERM','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH'].includes(e.code));});}));await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));if(results.some(v=>!v)||accepted!==0)throw Error();console.log(JSON.stringify({blockedIPv4:true,blockedIPv6:true,acceptedConnections:0,uid:process.getuid(),gid:process.getgid(),nodeVersion:process.version}));}catch{console.error('IMAGE_PREPARATION_NETWORK_CI_PROBE_REJECTED');process.exitCode=1;}`;
const CA_PROBE=`import{getCACertificates}from'node:tls';import{X509Certificate,createHash}from'node:crypto';try{if(process.version!=='v24.19.0'||process.env.NODE_USE_SYSTEM_CA!=='1')throw Error();const expected=process.argv[1];if(!getCACertificates('system').some(p=>createHash('sha256').update(new X509Certificate(p).raw).digest('hex')===expected))throw Error();console.log(JSON.stringify({systemCaPresent:true,nodeVersion:process.version}));}catch{console.error('IMAGE_PREPARATION_NETWORK_CI_CA_REJECTED');process.exitCode=1;}`;
const safeRead=async(path,maximum)=>{await archiveHostTrusted(path);return archiveHostRead(path,maximum);};
async function verifyHost(host){const value=await readImagePreparationHostConfiguration('/etc/coatria-image-preparation/'+host.scope.serviceId+'/host.json',host.bundleSha256,{trusted:true});check(canonical(value.host)===canonical(host));check((await archiveHostFileHash(host.node.path)).sha256===host.node.sha256);}
const diagnosticErrno=value=>value===undefined||value===null?null:['EACCES','EPERM','ENOENT','EEXIST','ENOSPC','EROFS','EBUSY','EIO','EINVAL','ETIMEDOUT','ENOBUFS','EMFILE','ENFILE','EPIPE','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH'].includes(value)?value:'OTHER';
const diagnosticSignal=value=>value===undefined||value===null?null:['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGINT'].includes(value)?value:'OTHER';
const diagnosticCount=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:null;
/** The firewall batch has fixed, synthetic input. Still export only recognized
 * nft error categories and bounded stdin coordinates, never its raw stderr. */
export function imagePreparationNetworkCiNftDiagnostic(stderr){
 if(typeof stderr!=='string'||Buffer.byteLength(stderr)>131072)return {categories:['unavailable'],locations:[]};
 const rules=[['stdin-not-regular-file',/^(?:internal:0:0-0: )?(?:Error: )?Not a regular file: "\/dev\/stdin"\r?$/m],['syntax-error',/\bsyntax error\b/i],['unexpected-type',/\bunexpected type\b/i],['unexpected-newline',/\bunexpected newline\b/i],['operation-not-permitted',/\boperation not permitted\b/i],['permission-denied',/\bpermission denied\b/i],['not-supported',/\b(?:operation|protocol) not supported\b/i],['missing-object',/\bno such file or directory\b/i],['already-exists',/\bfile exists\b/i],['invalid-argument',/\binvalid argument\b/i],['out-of-memory',/\b(?:out of memory|cannot allocate memory)\b/i],['identifier-too-long',/\b(?:identifier|name) (?:is )?too long\b/i]];
 const categories=rules.filter(([,pattern])=>pattern.test(stderr)).map(([label])=>label),locations=[];
 for(const match of stderr.matchAll(/(?:\/dev\/stdin|<stdin>|stdin|-):(\d{1,3}):(\d{1,3})(?:-(\d{1,3}))?/g)){
  const line=Number(match[1]),column=Number(match[2]),endColumn=Number(match[3]??match[2]);if(line>=1&&line<=4&&column>=1&&column<=512&&endColumn>=column&&endColumn<=512&&locations.length<4)locations.push({line,column,endColumn});
 }
 return {categories:categories.length?categories:['unclassified'],locations};
}
function firewallDiagnostic(raw,plan){
 let value;try{value=JSON.parse(raw);}catch{return {jsonValid:false};}
 const rows=Array.isArray(value?.nftables)?value.nftables:[],bounded=rows.length<=8,tables=bounded?rows.filter(v=>v?.table):[],chains=bounded?rows.filter(v=>v?.chain):[],rules=bounded?rows.filter(v=>v?.rule).map(v=>v.rule):[];
 const first=Array.isArray(rules[0]?.expr)?rules[0].expr:[],second=Array.isArray(rules[1]?.expr)?rules[1].expr:[],match=(left,right)=>({match:{op:'==',left,right}}),same=(a,b)=>canonical(a)===canonical(b),owner=match({meta:{key:'skuid'}},plan.uid),reject=second[2]?.reject;
 return {jsonValid:true,arrayPresent:Array.isArray(value?.nftables),entryCount:diagnosticCount(rows.length),tableCount:bounded?tables.length:null,chainCount:bounded?chains.length:null,ruleCount:bounded?rules.length:null,allowExprCount:diagnosticCount(first.length),denyExprCount:diagnosticCount(second.length),allowOwnerMatch:same(first[0],owner),allowAddressMatch:same(first[1],match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1')),allowPortMatch:same(first[2],match({payload:{protocol:'tcp',field:'dport'}},443)),denyOwnerMatch:same(second[0],owner),rejectType:reject?.type==='icmpx'?'icmpx':reject?'other':null,rejectCode:reject?.expr===3?'numeric-3':reject?.expr==='admin-prohibited'?'admin-prohibited':reject?'other':null,counterValid:exact(second[1]?.counter,['packets','bytes'])&&Number.isSafeInteger(second[1].counter.packets)&&second[1].counter.packets>=0&&Number.isSafeInteger(second[1].counter.bytes)&&second[1].counter.bytes>=0};
}
/** Dependencies are explicit offline-test I/O only, never environment-selected. */
export function createImagePreparationInstalledNetworkCi({fs=filesystem,exec=spawnSync,runtime=context,readTrustedFile=safeRead,assertHost=verifyHost,certificateHash=bytes=>hash(new X509Certificate(bytes).raw)}={}){
 let plan,host,lock,originalHosts,originalHostsMode,appliedHosts,priorEnvironment,originalCaBundleHash,caHash,rulesIdentity,rulesCreated=false,rulesWritten=false,firewallAttempted=false,hostsAttempted=false,caAttempted=false,environmentAttempted=false,initialized=false,finished=false,busy=false;
 let phase='idle',firstFailure=null,lastCommand=null,ruleProjection=null,nftError=null;const unitProjection=new Map();
 const step=value=>{phase=value;};
 const recordFailure=error=>{firstFailure??={phase,lastCommand:lastCommand?{...lastCommand}:null,errno:diagnosticErrno(error?.code)};};
 // Fixed labels and boolean/numeric projections only. Never retain raw command
 // output, arguments, paths, manager values, certificate bytes or exception text.
 const diagnostic=()=>structuredClone({version:1,phase,failure:firstFailure,lastCommand,attempted:{firewall:firewallAttempted,hosts:hostsAttempted,ca:caAttempted,environment:environmentAttempted},initialized,finished,units:[...unitProjection.values()],firewall:ruleProjection,nftError});
 function category(program,args){if(program==='/usr/bin/systemctl')return ({show:'unit-state','show-environment':'manager-read','set-environment':'manager-set','unset-environment':'manager-unset'})[args[0]]??'other';if(program==='/usr/sbin/nft')return args[0]==='-f'?'firewall-install':args[0]==='delete'?'firewall-delete':args.includes('tables')?'firewall-list-tables':'firewall-read';if(program==='/usr/bin/pgrep')return 'uid-process-check';if(program==='/usr/bin/id')return 'uid-identity';if(program==='/usr/bin/openssl')return 'tls-openssl';if(program==='/usr/sbin/update-ca-certificates')return 'system-ca-update';if(program===host?.node.path)return args[2]===DENY_PROBE?'uid-denial-probe':args[2]===CA_PROBE?'system-ca-probe':'other';return 'other';}
 function command(program,args,{input,stdio,timeout=15000,maxBuffer=131072,extraEnv={},acceptStatus=[]}={}){
  let value;lastCommand={phase,category:category(program,args),status:null,signal:null,errno:null};
  try{value=exec(program,args,{shell:false,env:{...env,...extraEnv},encoding:'utf8',timeout,maxBuffer,input,...(stdio?{stdio}:{}),killSignal:'SIGKILL',windowsHide:true});}
  catch(error){lastCommand.errno=diagnosticErrno(error?.code);recordFailure(error);fail();}
  lastCommand={...lastCommand,status:Number.isInteger(value?.status)&&value.status>=0&&value.status<=255?value.status:null,signal:diagnosticSignal(value?.signal),errno:diagnosticErrno(value?.error?.code)};
  try{check(value&&!value.error&&!value.signal&&([0,...acceptStatus].includes(value.status))&&typeof value.stdout==='string'&&typeof value.stderr==='string'&&Buffer.byteLength(value.stdout)+Buffer.byteLength(value.stderr)<=maxBuffer);}
  catch(error){if(lastCommand.category==='firewall-install')nftError=imagePreparationNetworkCiNftDiagnostic(value?.stderr);recordFailure(value?.error??error);throw error;}
  return value;
 }
 const manager=()=>imagePreparationNetworkCiEnvironment(command('/usr/bin/systemctl',['show-environment']).stdout);
 const firewall=()=>{const raw=command('/usr/sbin/nft',['--numeric','--json','list','table','inet',plan.table]).stdout;ruleProjection=firewallDiagnostic(raw,plan);return assertImagePreparationNetworkCiFirewall(raw,plan);};
 async function absent(path){try{await fs.lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}fail();}
 function privateRulesFile(info){check(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.uid===0&&info.gid===0&&(info.mode&0o7777)===0o600);}
 async function verifyRulesFile(complete=true){
  await trustedBase(plan.network);check(((await fs.lstat(plan.network)).mode&0o7777)===0o700);
  const info=await fs.lstat(plan.rulesPath);privateRulesFile(info);check(rulesIdentity&&info.dev===rulesIdentity.dev&&info.ino===rulesIdentity.ino&&await fs.realpath(plan.rulesPath)===plan.rulesPath);
  const bytes=await readTrustedFile(plan.rulesPath,4096);if(complete)check(bytes.equals(Buffer.from(imagePreparationNetworkCiFirewall(plan))));
 }
 async function writeRulesFile(){
  await trustedBase(plan.network);check(((await fs.lstat(plan.network)).mode&0o7777)===0o700);
  const file=await fs.open(plan.rulesPath,'wx',0o600);rulesCreated=true;
  try{rulesIdentity=await file.stat();privateRulesFile(rulesIdentity);await file.writeFile(Buffer.from(imagePreparationNetworkCiFirewall(plan)));rulesWritten=true;await file.sync();}finally{await file.close();}
  const directory=await fs.open(plan.network,'r');try{await directory.sync();}finally{await directory.close();}
  await verifyRulesFile();
 }
 async function stopped(all=false){
  for(const mode of all?['qualify','preflight','worker']:['preflight','worker']){const output=command('/usr/bin/systemctl',['show',host.units[mode].name,'--property=ActiveState,SubState,MainPID,ControlPID,Job']).stdout,lines=output.trim().split('\n');const state={};for(const line of lines){const at=line.indexOf('=');check(at>0&&!Object.hasOwn(state,line.slice(0,at)));state[line.slice(0,at)]=line.slice(at+1);}unitProjection.set(mode,{mode,activeState:['inactive','failed','active','activating','deactivating'].includes(state.ActiveState)?state.ActiveState:'other',subState:['dead','failed','running','exited','start','stop'].includes(state.SubState)?state.SubState:'other',mainPidZero:state.MainPID==='0',controlPidZero:state.ControlPID==='0',jobPresent:state.Job!==''});check(exact(state,['ActiveState','SubState','MainPID','ControlPID','Job'])&&['inactive','failed'].includes(state.ActiveState)&&['dead','failed'].includes(state.SubState)&&state.MainPID==='0'&&state.ControlPID==='0'&&state.Job==='');}
  const processes=command('/usr/bin/pgrep',['-u',String(host.uid)],{acceptStatus:[1]});check(processes.status===1&&!processes.stdout.trim()&&!processes.stderr.trim());
 }
 async function replaceHosts(expected,bytes){
  check(hash(await readTrustedFile(hostsPath,1024*1024))===hash(expected));const temporary='/etc/.coatria-image-preparation-'+plan.serviceId+'.hosts';await absent(temporary);let file;
  try{file=await fs.open(temporary,'wx',originalHostsMode);await file.writeFile(bytes);await file.sync();await file.close();file=undefined;await fs.chmod(temporary,originalHostsMode);check(hash(await readTrustedFile(hostsPath,1024*1024))===hash(expected));await fs.rename(temporary,hostsPath);const directory=await fs.open('/etc','r');try{await directory.sync();}finally{await directory.close();}check(hash(await readTrustedFile(hostsPath,1024*1024))===hash(bytes));}finally{await file?.close();try{await fs.unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
 }
 async function cleanup(){
  if(finished)return {restored:true,firewallRemoved:true};if(busy)fail();busy=true;let failed=false;
  try{
   step('cleanup-admission');if(!initialized){finished=true;step('cleanup-complete');return {restored:true,firewallRemoved:true};}
   // A live worker must never regain real DNS/provider routes on cleanup.
   step('cleanup-marker');await absent('/etc/coatria-image-preparation/'+host.scope.serviceId+'/worker-enabled');step('cleanup-units');await stopped(true);
   if(hostsAttempted)try{step('cleanup-hosts');const current=await readTrustedFile(hostsPath,1024*1024);if(hash(current)===hash(appliedHosts))await replaceHosts(appliedHosts,originalHosts);else check(hash(current)===hash(originalHosts));}catch(error){recordFailure(error);failed=true;}
   if(environmentAttempted)try{step('cleanup-manager');const current=manager();check(current.prior==='1'||current.prior===priorEnvironment.prior);if(current.prior!==priorEnvironment.prior)command('/usr/bin/systemctl',priorEnvironment.prior===null?['unset-environment','NODE_USE_SYSTEM_CA=1']:['set-environment','NODE_USE_SYSTEM_CA='+priorEnvironment.prior]);const restored=manager();check(restored.prior===priorEnvironment.prior&&restored.othersSha256===current.othersSha256);}catch(error){recordFailure(error);failed=true;}
   if(caAttempted)try{step('cleanup-ca');let bytes;try{bytes=await readTrustedFile(plan.installedCaPath,65536);}catch(error){if(error.code!=='ENOENT')throw error;}if(bytes){check(hash(bytes)===caHash);await fs.unlink(plan.installedCaPath);}command('/usr/sbin/update-ca-certificates',[],{timeout:60000});check(hash(await readTrustedFile(caBundle,4*1024*1024))===originalCaBundleHash);}catch(error){recordFailure(error);failed=true;}
   // Keep the UID block if any restoration failed. Disposable CI then fails;
   // there is no automatic repeat setup, service retry or broadened egress.
   if(!failed&&firewallAttempted)try{step('cleanup-firewall');const before=JSON.parse(command('/usr/sbin/nft',['--numeric','--json','list','tables']).stdout);check(Array.isArray(before.nftables));if(before.nftables.some(row=>row.table?.family==='inet'&&row.table.name===plan.table)){firewall();command('/usr/sbin/nft',['delete','table','inet',plan.table]);}const tables=JSON.parse(command('/usr/sbin/nft',['--numeric','--json','list','tables']).stdout);check(Array.isArray(tables.nftables)&&!tables.nftables.some(row=>row.table?.family==='inet'&&row.table.name===plan.table));}catch(error){recordFailure(error);failed=true;}
   if(!failed){step('cleanup-private-files');if(rulesCreated)try{await verifyRulesFile(rulesWritten);await fs.unlink(plan.rulesPath);rulesCreated=false;}catch(error){recordFailure(error);failed=true;}for(const name of ['ca.key','server.key','server.csr'])try{await fs.unlink(plan.network+'/'+name);}catch(error){if(error.code!=='ENOENT'){recordFailure(error);failed=true;}}}
   if(failed)fail('IMAGE_PREPARATION_NETWORK_CI_CLEANUP_FAILED');
   step('cleanup-receipt');await fs.writeFile(plan.network+'/cleanup.json',json({version:1,candidate:plan.candidate,serviceId:plan.serviceId,restored:true,firewallRemoved:true,workerStarted:false,remoteConnections:0}),{flag:'wx',mode:0o600});
   step('cleanup-lock');await lock?.close();lock=undefined;await fs.unlink(lockPath);finished=true;step('cleanup-complete');return {restored:true,firewallRemoved:true};
  }catch(error){recordFailure(error);fail('IMAGE_PREPARATION_NETWORK_CI_CLEANUP_FAILED');}finally{busy=false;}
 }
 return {cleanup,diagnostic,setup:async input=>{
  if(initialized||busy||finished)fail();busy=true;
  try{
   step('setup-admission');plan=imagePreparationInstalledNetworkCiPlan(input,runtime());host=structuredClone(input.host);step('setup-installed-host');await assertHost(host);step('setup-base');await trustedBase(plan.base);
   step('setup-marker');const marker=await readTrustedFile(plan.markerPath,4096);check(canonical(JSON.parse(marker))===canonical(plan.marker));const markerInfo=await fs.lstat(plan.markerPath);check(markerInfo.uid===0&&markerInfo.gid===0&&(markerInfo.mode&0o7777)===0o600);
   step('setup-empty-paths');await absent(plan.network);await absent(plan.installedCaPath);step('setup-units');await stopped();step('setup-uid');check(command('/usr/bin/id',['-u','coatria-image-preparation']).stdout.trim()===String(host.uid)&&command('/usr/bin/id',['-g','coatria-image-preparation']).stdout.trim()===String(host.gid));
   step('setup-manager-snapshot');priorEnvironment=manager();step('setup-hosts-snapshot');originalHosts=await readTrustedFile(hostsPath,1024*1024);const hostsInfo=await fs.lstat(hostsPath);check(hostsInfo.uid===0&&hostsInfo.gid===0);originalHostsMode=hostsInfo.mode&0o7777;appliedHosts=imagePreparationNetworkCiHosts(originalHosts,plan);step('setup-ca-snapshot');originalCaBundleHash=hash(await readTrustedFile(caBundle,4*1024*1024));
   step('setup-firewall-baseline');const tables=JSON.parse(command('/usr/sbin/nft',['--numeric','--json','list','tables']).stdout);check(Array.isArray(tables.nftables)&&!tables.nftables.some(row=>row.table?.family==='inet'&&row.table.name===plan.table));
   step('setup-intent');lock=await fs.open(lockPath,'wx',0o600);initialized=true;await lock.writeFile(json(plan.marker));await lock.sync();await fs.mkdir(plan.network,{mode:0o700});await fs.writeFile(plan.network+'/intent.json',json({...plan.marker,hostsBeforeSha256:hash(originalHosts),caBundleBeforeSha256:originalCaBundleHash,managerValueWasSet:priorEnvironment.prior!==null}),{flag:'wx',mode:0o600});
   // Node's Unix stdio pipes are sockets; Noble nft rejects that file type for
   // /dev/stdin. Keep the exact policy in a verified private regular file.
   step('setup-firewall-file');await writeRulesFile();
   step('setup-firewall-install');firewallAttempted=true;command('/usr/sbin/nft',['-f',plan.rulesPath],{stdio:['ignore','pipe','pipe']});step('setup-firewall-verify');const before=firewall();
   step('setup-denial-probe');let probe;try{probe=JSON.parse(command(host.node.path,['--input-type=module','-e',DENY_PROBE,String(host.uid),String(host.gid)]).stdout);}catch{fail();}check(exact(probe,['blockedIPv4','blockedIPv6','acceptedConnections','uid','gid','nodeVersion'])&&probe.blockedIPv4===true&&probe.blockedIPv6===true&&probe.acceptedConnections===0&&probe.uid===host.uid&&probe.gid===host.gid&&probe.nodeVersion==='v24.19.0');step('setup-denial-counter');const after=firewall();check(after.packets-before.packets>=2&&after.packets-before.packets<=20);
   step('setup-ca-generate');
   command('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-sha256','-keyout',plan.network+'/ca.key','-out',plan.caPath,'-subj','/CN=Coatria disposable image preparation CI CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],{timeout:30000});
   step('setup-leaf-generate');command('/usr/bin/openssl',['req','-newkey','rsa:2048','-nodes','-sha256','-keyout',plan.keyPath,'-out',plan.network+'/server.csr','-subj','/CN=coatria.com'],{timeout:30000});
   const extensions='basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName='+names.map(name=>'DNS:'+name).join(',')+'\n';await fs.writeFile(plan.network+'/server.ext',extensions,{flag:'wx',mode:0o600});
   step('setup-leaf-sign');command('/usr/bin/openssl',['x509','-req','-in',plan.network+'/server.csr','-CA',plan.caPath,'-CAkey',plan.network+'/ca.key','-set_serial','1','-days','1','-sha256','-extfile',plan.network+'/server.ext','-out',plan.certPath],{timeout:30000});for(const name of ['ca.key','server.key'])await fs.chmod(plan.network+'/'+name,0o600);
   step('setup-ca-install');const ca=await readTrustedFile(plan.caPath,65536);caHash=hash(ca);caAttempted=true;await fs.writeFile(plan.installedCaPath,ca,{flag:'wx',mode:0o644});step('setup-ca-update');command('/usr/sbin/update-ca-certificates',[],{timeout:60000});
   step('setup-tls-hostnames');for(const name of names)command('/usr/bin/openssl',['verify','-purpose','sslserver','-verify_hostname',name,plan.certPath]);
   step('setup-system-ca');let trusted;try{trusted=JSON.parse(command(host.node.path,['--input-type=module','-e',CA_PROBE,certificateHash(ca)],{extraEnv:{NODE_USE_SYSTEM_CA:'1'}}).stdout);}catch{fail();}check(exact(trusted,['systemCaPresent','nodeVersion'])&&trusted.systemCaPresent===true&&trusted.nodeVersion==='v24.19.0');
   step('setup-hosts-install');hostsAttempted=true;await replaceHosts(originalHosts,appliedHosts);
   // v255 systemctl.xml show-environment/set-environment and systemd.exec.xml
   // explicitly document propagation into all manager-spawned services. No
   // daemon-reload/manager config is needed. Node v24.19.0 cli.md documents the
   // boolean system CA flag. Native installed HTTPS success is separate proof.
   // https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml
   // https://github.com/nodejs/node/blob/v24.19.0/doc/api/cli.md
   step('setup-manager-check');const current=manager();check(canonical(current)===canonical(priorEnvironment));step('setup-manager-set');environmentAttempted=true;command('/usr/bin/systemctl',['set-environment','NODE_USE_SYSTEM_CA=1']);step('setup-manager-verify');const updated=manager();check(updated.prior==='1'&&updated.othersSha256===priorEnvironment.othersSha256);
   step('setup-proof');const proof={version:1,kind:'coatria-image-preparation-ci-network',candidate:plan.candidate,serviceId:plan.serviceId,uid:host.uid,origins:[...IMAGE_PREPARATION_NETWORK_CI_ORIGINS],listener:'127.0.0.1:443',workerIpv4OtherDenied:true,workerIpv6Denied:true,deniedLocalProbePackets:after.packets-before.packets,remoteConnectionAttempts:0,tlsVerificationDisabled:false,systemCaPresent:true,nodeVersion:'v24.19.0',managerSystemCaConfigured:true,unitBytesChanged:false,hostsBeforeSha256:hash(originalHosts),hostsAppliedSha256:hash(appliedHosts),caSha256:caHash,certificateSha256:hash(await readTrustedFile(plan.certPath,65536)),acceptanceAuthority:false};await fs.writeFile(plan.network+'/setup.json',json(proof),{flag:'wx',mode:0o600});step('setup-complete');return {certPath:plan.certPath,keyPath:plan.keyPath,caPath:plan.caPath,proof,cleanup};
  }catch(error){recordFailure(error);fail();}finally{busy=false;}
 }};
 async function trustedBase(path){const info=await fs.lstat(path);check(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0&&info.gid===0&&!(info.mode&0o022)&&await fs.realpath(path)===path);}
}
