import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {compileTrustedService} from '../scripts/hosting/build-trusted-service-bundle.mjs';

test('standalone image registrar contains its SQL transaction and rejects unconfigured execution without credential output',async t=>{
 const built=await compileTrustedService({root:process.cwd(),service:'image-preparation-registrar'});
 assert.equal(built.deployable,false);
 assert.equal(built.entry,'scripts/hosting/register-image-preparation-host.mts');
 const paths=new Set(built.inputs.map((item:{path:string})=>item.path));
 for(const path of ['scripts/hosting/image-preparation-host-enrollment.mjs','scripts/hosting/image-preparation-enrollment-transaction.mjs','src/lib/project-image-preparation-enrollment.ts','src/lib/project-image-preparation-database.mjs','node_modules/pg/lib/client.js','forbidden:pg-native'])assert(paths.has(path),path);
 assert.equal([...paths].some(path=>path.startsWith('node_modules/@aws-sdk/')),false,'The registrar must not contain a storage-provider client');
 for(const path of ['src/lib/project-image-preparation-broker-db.ts','scripts/hosting/run-image-preparation-worker.mts'])assert.equal(paths.has(path),false,path);
 // The verifier shares source modules with application routes. Their unused
 // ordinary-pool composition must not survive into the executable registrar.
 assert.doesNotMatch(built.runtime.toString('utf8'),/DATABASE_URL is not configured\.|globalDb\.coatriaPool/);
 const directory=await mkdtemp(join(tmpdir(),'coatria-image-registrar-bundle-'));
 t.after(async()=>{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.match(directory.split(/[\\/]/).at(-1)!,/^coatria-image-registrar-bundle-/);await rm(directory,{recursive:true,force:true});});
 const file=join(directory,'runtime.mjs');await writeFile(file,built.runtime,{flag:'wx'});
 const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,NODE_ENV:'production'};
 const syntax=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:15000,env:environment});assert.equal(syntax.status,0,syntax.stderr);
 // A parser failure must not even consume or echo the synthetic stdin payload.
 for(const args of [[],['--preflight'],['plan','--host','/tmp/untrusted/host.json']]){
  const result=spawnSync(process.execPath,[file,...args],{encoding:'utf8',input:'{"connectionString":"SYNTHETIC_PRIVATE_STDIN_MARKER"}',timeout:15000,env:environment});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(result.stderr.trim()),{event:'image-preparation-host-enrollment-stopped',code:'IMAGE_PREPARATION_HOST_ENROLLMENT_REJECTED',workerEnabled:false});
 }
});
