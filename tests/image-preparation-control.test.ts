import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {compileTrustedService} from '../scripts/hosting/build-trusted-service-bundle.mjs';
import {parseImagePreparationControlArguments,imagePreparationControlAuthority,controlImagePreparationHost,imagePreparationControlFailureResult} from '../scripts/hosting/control-image-preparation-host.mjs';

const base=['--host','/etc/coatria-image-preparation/00000000-0000-4000-8000-000000000099/host.json','--bundle','a'.repeat(64),'--controller-bundle','b'.repeat(64)];
const rejected='IMAGE_PREPARATION_HOST_CONTROL_REJECTED';
test('operator defaults to a read-only plan; start, stop and reconcile have exact nonsecret arguments',()=>{
 assert.equal(parseImagePreparationControlArguments(base).mode,'plan');
 for(const mode of ['plan','start','stop','reconcile'] as const)assert.deepEqual(parseImagePreparationControlArguments([mode,...base]),{mode,hostPath:base[1],bundleSha256:base[3],controllerBundleSha256:base[5]});
 for(const args of [[],['restart',...base],['enable',...base],[...base,'--token','fixture-private'],base.slice(0,4),base.map((v,i)=>i===1?v.replace('/etc/','/tmp/'):v),base.map((v,i)=>i===3?'A'.repeat(64):v),base.map((v,i)=>i===1?v+'\n':v)])assert.throws(()=>parseImagePreparationControlArguments(args),{message:rejected});
});

test('fresh authority projection rejects a different enrollment, revocation, absence or ambiguous fields',()=>{
 const expected={serviceId:'00000000-0000-4000-8000-000000000099',requestId:'00000000-0000-4000-8000-000000000098',requestHash:'c'.repeat(64)},value={...expected,status:'committed',active:true};
 assert.deepEqual(imagePreparationControlAuthority(value,expected),{status:'committed',active:true,serviceId:expected.serviceId});
 for(const patch of [{active:false},{active:1},{status:'absent'},{serviceId:expected.requestId},{requestId:expected.serviceId},{requestHash:'d'.repeat(64)},{reason:'revoked'},{raw:'private detail'}])assert.throws(()=>imagePreparationControlAuthority({...value,...patch},expected),{message:rejected});
 for(const value of [null,[],true,{}])assert.throws(()=>imagePreparationControlAuthority(value,expected),{message:rejected});
});

test('uninstalled control modes never request a credential, connect or start a host',async t=>{
 let connects=0,reads=0;
 t.mock.method(pg.Client.prototype,'connect',async()=>{connects++;});
 t.mock.method(process.stdin,Symbol.asyncIterator,()=>{reads++;throw new Error('stdin must not be read');});
 for(const mode of ['plan','start','reconcile','stop'])await assert.rejects(controlImagePreparationHost([mode,...base]));
 assert.deepEqual({connects,reads},{connects:0,reads:0});
});

test('source control entrypoint reports an unconfirmed outcome with one sanitized record',()=>{
 const entry=fileURLToPath(new URL('../scripts/hosting/control-image-preparation-host.mts',import.meta.url));
 const result=spawnSync(process.execPath,['--import','tsx',entry],{encoding:'utf8',timeout:15000,maxBuffer:16384,windowsHide:true});
 assert.ifError(result.error);assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.deepEqual(result.stderr.trim().split(/\r?\n/).map(line=>JSON.parse(line)),[imagePreparationControlFailureResult()]);
 assert.deepEqual(imagePreparationControlFailureResult(),{event:'image-preparation-host-control-stopped',code:rejected,outcome:'unconfirmed'});
});

test('compiled controller executes only its own entrypoint and carries no registrar command side effects',async t=>{
 const root=fileURLToPath(new URL('..',import.meta.url)),compiled=await compileTrustedService({root,service:'image-preparation-control'});
 assert.equal(compiled.deployable,false);assert.equal(compiled.service,'image-preparation-control');
 const temporary=await mkdtemp(join(tmpdir(),'coatria-control-entry-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
 const entry=join(temporary,'runtime.mjs');await writeFile(entry,compiled.runtime,{flag:'wx'});
 const result=spawnSync(process.execPath,[entry],{encoding:'utf8',timeout:15000,maxBuffer:16384,windowsHide:true});
 assert.ifError(result.error);assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.deepEqual(result.stderr.trim().split(/\r?\n/).map(line=>JSON.parse(line)),[imagePreparationControlFailureResult()]);
 assert.equal(compiled.inputs.some((item:{path:string})=>item.path==='scripts/hosting/register-image-preparation-host.mts'),false);
 assert.equal(compiled.inputs.some((item:{path:string})=>item.path==='scripts/hosting/image-preparation-registrar-connection.mts'),true);
});
