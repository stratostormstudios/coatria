import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseTrustedServiceBootstrap,trustedServiceChildEnvironment,trustedServiceRelease,superviseTrustedService,trustedServiceArtifactHeaders,TRUSTED_PRIVATE_ARTIFACT_HOST} from '../scripts/hosting/trusted-service-bootstrap-runtime.mjs';
import {compileTrustedService,buildTrustedServiceBundle} from '../scripts/hosting/build-trusted-service-bundle.mjs';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const commit='a'.repeat(40),company='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222';
function fixture(service='gateway'){
 const expiresAt='2026-09-23T12:00:00.000Z',release=trustedServiceRelease(service,commit),files=[{path:'runtime.mjs',bytes:20,sha256:'b'.repeat(64)},{path:'bundle.json',bytes:100,sha256:'c'.repeat(64)}];
 if(service==='archive')files.push({path:'qualification.json',bytes:100,sha256:'d'.repeat(64)},{path:'closure/bin/ffmpeg',bytes:200,sha256:'e'.repeat(64)},{path:'closure/bin/ffprobe',bytes:200,sha256:'f'.repeat(64)});
 const scope={companyId:company,projectIds:[project],sourceCommit:commit,expiresAt},configuration=service==='gateway'?{version:1,...scope,host:'0.0.0.0',port:4190,appOrigin:'https://coatria.com',maxTransfers:8,verifierConcurrency:1}:{version:1,policy:scope,closure:{root:release+'/closure'},qualification:{receiptPath:release+'/qualification.json',sha256:'d'.repeat(64)},scratchRoot:'/var/lib/coatria-archive-scratch'};
 const configurationHash=sha(canonical(configuration)),manifest={version:1,service,sourceCommit:commit,configurationHash,expiresAt,assetsBaseUrl:'https://coatria.com/downloads/synthetic/',files,mode:'preflight'};
 const settings={COATRIA_SERVICE_CONFIGURATION:JSON.stringify(configuration),COATRIA_SERVICE_CONFIGURATION_SHA256:configurationHash,COATRIA_SERVICE_KIND:service,COATRIA_SERVICE_SOURCE_COMMIT:commit,COATRIA_SERVICE_EXPIRES_AT:expiresAt,DATABASE_URL:`postgresql://${service==='archive'?'coatria_higgsfield_archive_worker_v1':'coatria_storage_gateway_v1'}:synthetic-password@synthetic.neon.tech/coatria?sslmode=require`,COATRIA_HOSTING_KEYRING:JSON.stringify({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,9).toString('base64')}}),COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:'true',COATRIA_VERCEL_MEDIA_TOKEN:'synthetic-vercel-token',MANAGED_RUNPOD_API_KEY:'synthetic-lifecycle-secret',NODE_OPTIONS:'--require malicious.cjs',HTTP_PROXY:'https://synthetic.invalid'};
 return {manifest,settings:{...settings,COATRIA_SERVICE_PROVISION_ID:'33333333-3333-4333-8333-333333333333'},configuration};
}
test('trusted bootstrap freezes exact artifact identity and rejects paths, secret URLs and widened services',()=>{
 const {manifest}=fixture(),parsed=parseTrustedServiceBootstrap(manifest);manifest.files[0].sha256='e'.repeat(64);assert.equal(parsed.files[0].sha256,'b'.repeat(64));assert.ok(Object.isFrozen(parsed.files[0]));
 for(const mutate of [(v:any)=>v.files.push({...v.files[0],path:'../runtime.mjs'}),(v:any)=>v.files[0].path='closure/../../runtime.mjs',(v:any)=>v.files[0].url='https://asset.invalid/file?secret=value',(v:any)=>v.files[0].url='http://asset.invalid/file',(v:any)=>v.files[0].url='https://user:password@asset.invalid/file',(v:any)=>v.files.push({path:'qualification.json',bytes:1,sha256:'f'.repeat(64)}),(v:any)=>v.files[0].bytes=9*1024**2,(v:any)=>v.assetsBaseUrl='https://127.0.0.1/',(v:any)=>v.extra='credential']){const value=fixture().manifest;mutate(value);assert.throws(()=>parseTrustedServiceBootstrap(value),/BOOTSTRAP_FAILED/);}
});
test('gateway child receives its dedicated role and vault, never Vercel or lifecycle credentials',()=>{
 const {manifest,settings}=fixture(),result=trustedServiceChildEnvironment(manifest,settings);assert.deepEqual(Object.keys(result.env).sort(),['APP_URL','COATRIA_HOSTING_KEYRING','COATRIA_SERVICE_PROVISION_ID','DATABASE_URL','HOME','HOST','LANG','NODE_ENV','PATH','PORT'].sort());assert.equal(result.env.DATABASE_URL,settings.DATABASE_URL);assert.equal(result.env.COATRIA_SERVICE_PROVISION_ID,settings.COATRIA_SERVICE_PROVISION_ID);assert.doesNotMatch(JSON.stringify(result.env),/synthetic-vercel-token|synthetic-lifecycle-secret|NODE_OPTIONS|HTTP_PROXY/);
 for(const provisionId of [undefined,'foreign','../../another-project'])assert.throws(()=>trustedServiceChildEnvironment(manifest,{...settings,COATRIA_SERVICE_PROVISION_ID:provisionId}));
 const wrong={...settings,DATABASE_URL:settings.DATABASE_URL.replace('coatria_storage_gateway_v1','database_owner')};assert.throws(()=>trustedServiceChildEnvironment(manifest,wrong));assert.throws(()=>trustedServiceChildEnvironment(manifest,{...settings,COATRIA_SERVICE_SOURCE_COMMIT:'0'.repeat(40)}));
});
test('archive child receives only required remote control credentials and pinned paths',()=>{
 const {manifest,settings}=fixture('archive'),result=trustedServiceChildEnvironment(manifest,settings);assert.equal(result.env.COATRIA_VERCEL_MEDIA_TOKEN,settings.COATRIA_VERCEL_MEDIA_TOKEN);assert.equal(result.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED,'true');assert.equal(result.env.MANAGED_RUNPOD_API_KEY,undefined);assert.equal(result.env.NODE_OPTIONS,undefined);
 const bad=JSON.parse(settings.COATRIA_SERVICE_CONFIGURATION);bad.closure.root='/tmp/mutable';const changed={...settings,COATRIA_SERVICE_CONFIGURATION:JSON.stringify(bad),COATRIA_SERVICE_CONFIGURATION_SHA256:sha(canonical(bad))};assert.throws(()=>trustedServiceChildEnvironment({...manifest,configurationHash:changed.COATRIA_SERVICE_CONFIGURATION_SHA256},changed));
});
test('supervisor gracefully stops the whole service group on expiry and bounds a hung shutdown',async()=>{
 const make=()=>Object.assign(new EventEmitter(),{pid:4321,exitCode:null,signalCode:null,kill(){throw Error('group must be used');}});
 for(const cooperative of [true,false]){let alive=true;const child=make(),control=new AbortController(),signals:string[]=[],result=superviseTrustedService(child,control.signal,{graceMs:10,killMs:10,groupExists:()=>alive,killGroup:(pid:number,signal:string)=>{assert.equal(pid,4321);signals.push(signal);if(cooperative)queueMicrotask(()=>{alive=false;child.emit('exit',0,null);});}});control.abort();const observed=await result;assert.deepEqual(signals,cooperative?['SIGTERM']:['SIGTERM','SIGKILL']);assert.equal(observed.terminationConfirmed,cooperative);assert.equal(observed.forced,!cooperative);}
});
test('leader exit cannot clear the deadline while a descendant remains in the owned process group',async()=>{
 const child=Object.assign(new EventEmitter(),{pid:4321,exitCode:null,signalCode:null,kill(){throw Error('group must be used');}}),control=new AbortController(),signals:string[]=[];let alive=true;
 const waiting=superviseTrustedService(child,control.signal,{graceMs:10,killMs:10,groupExists:()=>alive,killGroup:(_pid:number,signal:string)=>{signals.push(signal);if(signal==='SIGKILL')alive=false;}});child.emit('exit',0,null);const result=await waiting;assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(result.terminationConfirmed,true);assert.equal(result.forced,true);assert.equal(result.code,1);
});
test('private decoder authorization is confined to the exact archive Blob store and never gateway assets',()=>{
 const file={path:'closure/bin/ffmpeg',url:'https://'+TRUSTED_PRIVATE_ARTIFACT_HOST+'/runtime/synthetic/ffmpeg',auth:'vercel-project-oidc'},settings={COATRIA_VERCEL_MEDIA_TOKEN:'synthetic-project-token'};
 assert.deepEqual(trustedServiceArtifactHeaders(file,'archive',settings),{Authorization:'Bearer synthetic-project-token'});assert.deepEqual(trustedServiceArtifactHeaders({path:'runtime.mjs'},'gateway',settings),{});
 for(const [entry,service] of [[file,'gateway'],[{...file,url:'https://other.private.blob.vercel-storage.com/file'},'archive'],[{...file,path:'runtime.mjs'},'archive'],[{...file,url:file.url+'?secret=value'},'archive']] as const)assert.throws(()=>trustedServiceArtifactHeaders(entry,service,settings));
});
test('both actual service bundles have fully enumerated inputs, no external packages and fail closed without configuration',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'coatria-trusted-bundle-'));
 try{for(const service of ['archive','gateway','media-qualification']){const result=await compileTrustedService({root:process.cwd(),service});assert.equal(result.deployable,false);if(service!=='media-qualification'){assert.ok(result.inputs.some((item:any)=>item.path==='forbidden:pg-native'));assert.ok(result.inputs.some((item:any)=>item.path.startsWith('node_modules/pg/')));}assert.ok(result.inputs.some((item:any)=>item.path.startsWith('src/lib/')));assert.ok(result.runtime.length<8*1024**2);const path=join(directory,service+'.mjs');await writeFile(path,result.runtime);const syntax=spawnSync(process.execPath,['--check',path],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,NODE_ENV:'test'}});assert.equal(syntax.status,0,syntax.stderr);const guarded=spawnSync(process.execPath,[path,'--preflight'],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,NODE_ENV:'production'}});assert.equal(guarded.status,1);assert.match(guarded.stderr,/CONFIGURATION_INVALID/);assert.doesNotMatch(guarded.stderr,/synthetic-password|Bearer/);}}
 finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});}
});
test('production package rejects a source commit that does not contain the reviewed entry and bootstrap',async()=>{await assert.rejects(buildTrustedServiceBundle({root:process.cwd(),commit:'0'.repeat(40),service:'archive',output:join(tmpdir(),'coatria-not-created-'+Date.now())}),/BUNDLE_REJECTED/);});
