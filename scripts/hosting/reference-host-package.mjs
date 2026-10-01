/** Reference-only immutable package. Integrity is not native qualification or enrollment. */
import {isIP} from 'node:net';
import {join,resolve} from 'node:path';
import {ARCHIVE_HOST_PINS,ARCHIVE_RUNTIME_EMPTY_DIRECTORIES,archiveHostHash,archiveHostRead,archiveHostTrusted,archiveHostRelative,verifyArchiveTree,archiveHostProfiles} from './archive-host-package.mjs';

export const REFERENCE_HOST_RELEASES='/var/lib/coatria-reference-releases';
export const REFERENCE_HOST_CONFIG='/etc/coatria-reference';
export const REFERENCE_HOST_STATE='/var/lib/coatria-reference-worker';
export const REFERENCE_HOST_SERVICE_USER='coatria-reference';
export const REFERENCE_HOST_PINS=ARCHIVE_HOST_PINS;
export const referenceHostHash=archiveHostHash;
export function referenceHostFailure(){throw Error('REFERENCE_HOST_PACKAGE_REJECTED');}
const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),gitId=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const json=v=>JSON.stringify(v,null,2)+'\n';
const host=v=>typeof v==='string'&&v.length<=253&&v===v.toLowerCase()&&!isIP(v)&&v.includes('.')&&!v.endsWith('.localhost')&&v.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const REFERENCE_HOST_SOURCE_FILES=Object.freeze([
 'package.json','package-lock.json',
 ...['media-sandbox-launch.c','media-sandbox-probe.c','prepare-media-sandbox-ci.mjs','run-media-sandbox-ci.mjs','media-sandbox-linux-canary.mts','media-sandbox-startup-diagnostic.mts','prepare-media-apparmor-ci.mjs','collect-media-apparmor-ci.mjs','reference-worker-linux-canary.mts','image-preparation-linux-canary.mts','media-sandbox-source-files.mjs','media-sandbox-cgroup-observer.mjs'].map(p=>'scripts/hosting/'+p),
 ...['higgsfield-media-sandbox.ts','higgsfield-media-inspection.ts','higgsfield-reference-worker.ts','higgsfield-references-protocol.ts','higgsfield-reference-transport.ts','higgsfield-image-preparation.ts','higgsfield-image-preparation-policy.ts','higgsfield-image-preparation-source.ts','higgsfield-image-preparation-png.ts','project-image-preparation-sandbox.ts'].map(p=>'src/lib/'+p),
 ...['png','jpeg','webp','mp4','mov','wav','mp3'].map(e=>'tests/fixtures/media/synthetic.'+e)
]);
function files(value){
 if(!Array.isArray(value)||!value.length||value.length>10000)referenceHostFailure();const seen=new Set();let size=0;
 return value.map(f=>{if(!exact(f,['path','bytes','sha256','mode'])||!archiveHostRelative(f.path)||seen.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>512*1024**2||!sha(f.sha256)||![0o444,0o555].includes(f.mode))referenceHostFailure();seen.add(f.path);size+=f.bytes;if(size>1024**3)referenceHostFailure();return {...f};});
}
function directories(value,expected){if(!Array.isArray(value)||value.length!==expected.length||new Set(value.map(v=>v.path)).size!==value.length||value.some(v=>!exact(v,['path','mode'])||!expected.some(e=>same(e,v))))referenceHostFailure();return value.map(v=>({...v}));}
function nativeRuntime(v){
 if(!exact(v,['version','platform','pins','sourceHashes','packageLockSha256','bubblewrapSha256','files','emptyDirectories'])||v.version!==1||v.platform!=='linux-x64'||!same(v.pins,REFERENCE_HOST_PINS)||!exact(v.sourceHashes,['launcher','probe'])||!sha(v.sourceHashes.launcher)||!sha(v.sourceHashes.probe)||!sha(v.packageLockSha256)||!sha(v.bubblewrapSha256))referenceHostFailure();
 const entries=files(v.files),map=new Map(entries.map(f=>[f.path,f]));
 for(const path of ['node','media-sandbox-launch','media/real/bin/ffmpeg','media/real/bin/ffprobe','media/conformance/bin/ffmpeg','media/conformance/bin/ffprobe'])if(!map.has(path))referenceHostFailure();
 for(const f of entries){if(!['node','media-sandbox-launch'].includes(f.path)&&!/^media\/(?:real|conformance)\/(?:bin\/ff(?:mpeg|probe)|lib(?:64|\/x86_64-linux-gnu)\/[A-Za-z0-9_.+-]+)$/.test(f.path))referenceHostFailure();const executable=['node','media-sandbox-launch'].includes(f.path)||/\/(?:bin\/ff(?:mpeg|probe)|lib64\/ld-linux-x86-64.so.2)$/.test(f.path);if(f.mode!==(executable?0o555:0o444))referenceHostFailure();}
 for(const kind of ['real','conformance'])if(entries.filter(f=>f.path.startsWith('media/'+kind+'/')).length>64)referenceHostFailure();
 if(map.get('media/conformance/bin/ffmpeg').sha256!==map.get('media/conformance/bin/ffprobe').sha256)referenceHostFailure();
 return {...v,files:entries,emptyDirectories:directories(v.emptyDirectories,ARCHIVE_RUNTIME_EMPTY_DIRECTORIES)};
}
export function parseReferenceServiceBundle(v,service){
 if(!exact(v,['version','kind','service','sourceCommit','sourceTree','image','nodeVersion','compiler','packageLockSha256','inputs','runtime','deployable','qualified'])||v.version!==1||v.kind!=='coatria-trusted-service-bundle'||v.service!==service||!['reference','reference-qualification'].includes(service)||!gitId(v.sourceCommit)||!gitId(v.sourceTree)||v.image!==REFERENCE_HOST_PINS.nodeImage||v.nodeVersion!==REFERENCE_HOST_PINS.nodeVersion||!exact(v.compiler,['name','version','packageIntegrity'])||v.compiler.name!=='esbuild'||v.compiler.version!=='0.28.2'||!/^sha512-[A-Za-z0-9+/=]+$/.test(v.compiler.packageIntegrity??'')||!sha(v.packageLockSha256)||v.deployable!==true||v.qualified!==false||!exact(v.runtime,['path','bytes','sha256'])||v.runtime.path!=='runtime.mjs'||!Number.isSafeInteger(v.runtime.bytes)||v.runtime.bytes<1||v.runtime.bytes>8*1024**2||!sha(v.runtime.sha256)||!Array.isArray(v.inputs)||!v.inputs.length||v.inputs.length>2000)referenceHostFailure();
 const seen=new Set();for(const input of v.inputs){if(!exact(input,['path','bytes','sha256','kind'])||!archiveHostRelative(input.path)||seen.has(input.path)||!sha(input.sha256)||!Number.isSafeInteger(input.bytes)||input.bytes<0||input.bytes>16*1024**2||!['source','dependency'].includes(input.kind)||(input.kind==='dependency')!==input.path.startsWith('node_modules/')||input.path.split('/').some(p=>p.startsWith('.'))||/(?:^|\/)(?:pg|pg-native|@aws-sdk)(?:\/|$)/.test(input.path))referenceHostFailure();seen.add(input.path);}
 const entry=service==='reference'?'scripts/hosting/run-reference-worker.mts':'scripts/hosting/qualify-reference-host.mts';if(!v.inputs.some(i=>i.path===entry&&i.kind==='source'))referenceHostFailure();return v;
}
export function parseReferenceHostBundle(v){
 if(!exact(v,['version','kind','commit','tree','runtimeInputSha256','runtime','worker','qualifier','files','emptyDirectories'])||v.version!==1||v.kind!=='coatria-reference-host'||!gitId(v.commit)||!gitId(v.tree)||!sha(v.runtimeInputSha256))referenceHostFailure();const runtime=nativeRuntime(v.runtime),entries=files(v.files),map=new Map(entries.map(f=>[f.path,f])),expected=new Map();
 const expect=f=>{const actual=map.get(f.path);if(!actual||!same(actual,f))referenceHostFailure();expected.set(f.path,f);};
 for(const f of runtime.files)expect({...f,path:'runtime/'+f.path});
 for(const [key,service]of [['worker','reference'],['qualifier','reference-qualification']]){const part=v[key];if(!exact(part,['bundleSha256','bundle'])||!sha(part.bundleSha256))referenceHostFailure();const b=parseReferenceServiceBundle(part.bundle,service),raw=json(b);if(b.sourceCommit!==v.commit||b.sourceTree!==v.tree||b.packageLockSha256!==runtime.packageLockSha256||archiveHostHash(raw)!==part.bundleSha256)referenceHostFailure();expect({path:key+'/bundle.json',bytes:Buffer.byteLength(raw),sha256:part.bundleSha256,mode:0o444});expect({path:key+'/runtime.mjs',bytes:b.runtime.bytes,sha256:b.runtime.sha256,mode:0o444});}
 const sourcePaths=new Set([...REFERENCE_HOST_SOURCE_FILES,...v.worker.bundle.inputs,...v.qualifier.bundle.inputs].map(p=>typeof p==='string'?p:p.kind==='source'?p.path:null).filter(Boolean));
 for(const p of sourcePaths){const f=map.get('source/'+p);if(!f||f.mode!==0o444)referenceHostFailure();expected.set(f.path,f);}
 if(entries.length!==expected.size||map.get('source/package-lock.json')?.sha256!==runtime.packageLockSha256||map.get('source/scripts/hosting/media-sandbox-launch.c')?.sha256!==runtime.sourceHashes.launcher||map.get('source/scripts/hosting/media-sandbox-probe.c')?.sha256!==runtime.sourceHashes.probe)referenceHostFailure();
 for(const b of [v.worker.bundle,v.qualifier.bundle])for(const input of b.inputs.filter(i=>i.kind==='source')){const f=map.get('source/'+input.path);if(f?.sha256!==input.sha256||f.bytes!==input.bytes)referenceHostFailure();}
 return {...v,runtime,files:entries,emptyDirectories:directories(v.emptyDirectories,runtime.emptyDirectories.map(d=>({...d,path:'runtime/'+d.path})))};
}
export function parseReferenceHostScope(raw,now=Date.now()){
 if(!exact(raw,['version','serviceId','companyId','projectIds','origin','expiresAt','uploadHosts'])||raw.version!==1||!uuid(raw.serviceId)||!uuid(raw.companyId)||!Array.isArray(raw.projectIds)||!raw.projectIds.length||raw.projectIds.length>32||raw.projectIds.some(p=>!uuid(p))||new Set(raw.projectIds).size!==raw.projectIds.length||!Array.isArray(raw.uploadHosts)||!raw.uploadHosts.length||raw.uploadHosts.length>32||raw.uploadHosts.some(h=>!host(h))||new Set(raw.uploadHosts).size!==raw.uploadHosts.length||typeof raw.expiresAt!=='string'||!Number.isFinite(now)||!Number.isFinite(Date.parse(raw.expiresAt))||new Date(raw.expiresAt).toISOString()!==raw.expiresAt||Date.parse(raw.expiresAt)<=now||Date.parse(raw.expiresAt)>now+3600000)referenceHostFailure();
 let u;try{u=new URL(raw.origin);}catch{referenceHostFailure();}if(u.protocol!=='https:'||u.origin!==raw.origin||u.username||u.password||u.port||!host(u.hostname))referenceHostFailure();
 const {version,...scope}=raw;return {...scope,projectIds:[...scope.projectIds],uploadHosts:[...scope.uploadHosts]};
}
export function referenceHostUnitName(serviceId,mode){if(!uuid(serviceId)||!['qualify','preflight','worker'].includes(mode))referenceHostFailure();return `coatria-reference-${serviceId}-${mode}.service`;}
export function referenceHostUnit(mode,release,bundleSha256,serviceId){
 referenceHostUnitName(serviceId,mode);if(!sha(bundleSha256)||release!==REFERENCE_HOST_RELEASES+'/'+bundleSha256)referenceHostFailure();const config=REFERENCE_HOST_CONFIG+'/'+serviceId,gated=mode!=='qualify',program=mode==='qualify'?'qualifier':'worker';
 return `[Unit]\nDescription=Coatria reference ${mode}\nAfter=network-online.target\n${gated?'ConditionPathExists='+config+'/qualified.json\n':''}${mode==='worker'?'ConditionPathExists='+config+'/worker-enabled\n':''}\n[Service]\nType=${mode==='worker'?'simple':'oneshot'}\n${mode==='qualify'?'RemainAfterExit=yes\n':''}User=${REFERENCE_HOST_SERVICE_USER}\nGroup=${REFERENCE_HOST_SERVICE_USER}\nWorkingDirectory=${release}\nExecStart=${release}/runtime/node ${release}/${program}/runtime.mjs --host ${config}/host.json --bundle ${bundleSha256}${mode==='preflight'?' --preflight':''}\nEnvironment=NODE_ENV=production\nEnvironment=LANG=C\nEnvironment=LC_ALL=C\nEnvironment=PATH=/usr/bin:/bin\n${gated?'EnvironmentFile='+config+'/worker.env\n':''}UnsetEnvironment=DATABASE_URL COATRIA_HOSTING_KEYRING RUNPOD_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY PGPASSWORD NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH${gated?'':' COATRIA_REFERENCE_SERVICE_TOKEN'}\nDelegate=cpu memory pids\nDelegateSubgroup=supervisor\nMemoryMax=2G\nMemorySwapMax=0\nTasksMax=256\nCPUQuota=200%\nCPUQuotaPeriodSec=100ms\nLimitNOFILE=1024\nUMask=0077\nNoNewPrivileges=yes\nProtectSystem=full\nProtectHome=yes\nPrivateTmp=yes\nKillMode=control-group\nTimeoutStartSec=${mode==='qualify'?'300':'60'}\n${mode==='worker'?'RuntimeMaxSec=3600\n':''}TimeoutStopSec=45\nSendSIGKILL=yes\nRestart=no\n# No install target: activation requires separate reviewed qualification and enrollment.\n`;
}
export function referenceHostProfiles(bundle,release){parseReferenceHostBundle(bundle);if(!new RegExp('^'+REFERENCE_HOST_RELEASES+'/[a-f0-9]{64}$').test(release))referenceHostFailure();return archiveHostProfiles(bundle,release);}
export function referenceHostInstallPlan(bundle,bundleSha256,scope){
 parseReferenceHostBundle(bundle);if(!sha(bundleSha256)||referenceHostHash(json(bundle))!==bundleSha256)referenceHostFailure();const release=REFERENCE_HOST_RELEASES+'/'+bundleSha256;parseReferenceHostScope({version:1,...scope});
 return {version:1,commit:bundle.commit,tree:bundle.tree,bundleSha256,release,serviceUser:REFERENCE_HOST_SERVICE_USER,configuration:REFERENCE_HOST_CONFIG+'/'+scope.serviceId,state:REFERENCE_HOST_STATE+'/'+scope.serviceId,units:['qualify','preflight','worker'].map(mode=>({name:referenceHostUnitName(scope.serviceId,mode),content:referenceHostUnit(mode,release,bundleSha256,scope.serviceId)})),packagesInstalled:false,profilesActivated:false,servicesEnabled:false,servicesStarted:false,credentialsIncluded:false,qualified:false};
}
export function createReferenceHostConfiguration(bundle,bundleSha256,scope,{uid,gid}){
 const plan=referenceHostInstallPlan(bundle,bundleSha256,scope);if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(gid)||gid<1)referenceHostFailure();
 return {version:1,bundleSha256,commit:bundle.commit,tree:bundle.tree,release:plan.release,uid,gid,scope,profiles:Object.fromEntries(Object.entries(referenceHostProfiles(bundle,plan.release)).map(([kind,p])=>[kind,{profilePath:plan.configuration+'/'+kind+'.json',expectedProfileSha256:archiveHostHash(json(p))}])),worker:{path:plan.release+'/worker/runtime.mjs',sha256:bundle.worker.bundle.runtime.sha256},qualifier:{path:plan.release+'/qualifier/runtime.mjs',sha256:bundle.qualifier.bundle.runtime.sha256},units:Object.fromEntries(plan.units.map((u,i)=>[['qualify','preflight','worker'][i],{name:u.name,sha256:archiveHostHash(u.content)}]))};
}
/** @returns {import('./reference-runner-configuration.mts').ReferenceHostConfiguration} */
export function parseReferenceHostConfiguration(value,bundle){
 if(!exact(value,['version','bundleSha256','commit','tree','release','uid','gid','scope','profiles','worker','qualifier','units'])||value.version!==1||!bundle)referenceHostFailure();
 const scope=parseReferenceHostScope({version:1,...value.scope}),expected=createReferenceHostConfiguration(bundle,value.bundleSha256,scope,{uid:value.uid,gid:value.gid});if(!same(value,expected))referenceHostFailure();return /** @type {import('./reference-runner-configuration.mts').ReferenceHostConfiguration} */(expected);
}
export async function inspectReferenceHostBundle(path,bundleSha256,{trusted=true}={}){
 if(!sha(bundleSha256))referenceHostFailure();path=resolve(path);if(trusted)await archiveHostTrusted(path,true);const raw=await archiveHostRead(join(path,'bundle.json'));if(archiveHostHash(raw)!==bundleSha256)referenceHostFailure();if(trusted)await archiveHostTrusted(join(path,'bundle.json'));const bundle=parseReferenceHostBundle(JSON.parse(raw));if(!Buffer.from(json(bundle)).equals(raw))referenceHostFailure();await verifyArchiveTree(path,bundle.files,{trusted,extra:['bundle.json'],emptyDirectories:bundle.emptyDirectories});return bundle;
}
export async function readReferenceHostConfiguration(hostPath,bundleSha256,{trusted=true}={}){
 if(typeof hostPath!=='string'||!new RegExp('^'+REFERENCE_HOST_CONFIG+'/[a-f0-9-]{36}/host\\.json$').test(hostPath)||!sha(bundleSha256))referenceHostFailure();if(trusted)await archiveHostTrusted(hostPath);const hostBytes=await archiveHostRead(hostPath,65536),value=JSON.parse(hostBytes);if(value.bundleSha256!==bundleSha256||hostPath!==REFERENCE_HOST_CONFIG+'/'+value.scope?.serviceId+'/host.json')referenceHostFailure();
 const bundle=await inspectReferenceHostBundle(REFERENCE_HOST_RELEASES+'/'+bundleSha256,bundleSha256,{trusted}),host=parseReferenceHostConfiguration(value,bundle);if(!Buffer.from(json(host)).equals(hostBytes))referenceHostFailure();
 for(const [kind,p]of Object.entries(referenceHostProfiles(bundle,host.release))){const path=host.profiles[kind].profilePath;if(trusted)await archiveHostTrusted(path);if(!Buffer.from(json(p)).equals(await archiveHostRead(path,65536)))referenceHostFailure();}
 for(const mode of ['qualify','preflight','worker']){const path='/etc/systemd/system/'+host.units[mode].name;if(trusted)await archiveHostTrusted(path);if(!Buffer.from(referenceHostUnit(mode,host.release,bundleSha256,host.scope.serviceId)).equals(await archiveHostRead(path,16384)))referenceHostFailure();}
 return {host,bundle,hostBytes};
}
