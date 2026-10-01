import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {compileTrustedService} from '../scripts/hosting/build-trusted-service-bundle.mjs';

test('actual standalone preparation worker has no database or storage driver and rejects unqualified launch',async t=>{
 const built=await compileTrustedService({root:process.cwd(),service:'image-preparation'});
 assert.equal(built.deployable,false);
 assert(built.inputs.some((v:{path:string})=>v.path==='scripts/hosting/run-image-preparation-worker.mts'));
 assert.equal(built.inputs.some((v:{path:string})=>/(?:^|\/)(?:pg|pg-native|@aws-sdk)(?:\/|$)/.test(v.path)),false);
 const directory=await mkdtemp(join(tmpdir(),'coatria-preparation-worker-bundle-'));
 t.after(async()=>{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.match(directory.split(/[\\/]/).at(-1)!,/^coatria-preparation-worker-bundle-/);await rm(directory,{recursive:true,force:true});});
 const file=join(directory,'runtime.mjs');await writeFile(file,built.runtime,{flag:'wx'});
 const result=spawnSync(process.execPath,[file,'--preflight'],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,NODE_ENV:'production'}});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.deepEqual(JSON.parse(result.stderr.trim()),{event:'image-preparation-worker-stopped',code:'IMAGE_PREPARATION_RUNNER_UNAVAILABLE'});
});
