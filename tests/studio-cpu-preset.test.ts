import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {buildCpuPreset} from '../scripts/hosting/build-cpu-preset.mjs';
import {studioCpuPreset} from '../src/lib/studio-host-provisioning';

const run=promisify(execFile);
test('CPU preset builder verifies exact Git source, refuses changed files and never overwrites its output',{timeout:30000},async()=>{
 const root=process.cwd(),commit=(await run('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim(),gitDirectory=(await run('git',['rev-parse','--absolute-git-dir'],{cwd:root})).stdout.trim(),directory=await mkdtemp(join(tmpdir(),'coatria-preset-test-'));
 // A read-only Git directory reference lets the fixture use existing committed
 // blobs without making a commit, touching the index or changing the workspace.
 try{await writeFile(join(directory,'.git'),'gitdir: '+gitDirectory.replaceAll('\\','/')+'\n');for(const path of ['public/downloads/agent-worker.mjs','public/downloads/provider-adapter.mjs','scripts/hosting/run-studio-host.mjs']){const content=(await run('git',['show',commit+':'+path],{cwd:root,maxBuffer:2097152})).stdout;await mkdir(dirname(join(directory,path)),{recursive:true});await writeFile(join(directory,path),content);}
  const companyId=randomUUID(),configuration={id:'fixture-reviewed',modelId:'fixture-model',endpointId:'fixture-endpoint',maxHourlyMicrousd:100000,maxSteps:8,maxOutputTokens:8192,maxTotalTokens:80000,timeoutSeconds:600,companies:[{companyId,volumeId:'fixture-volume',dataCenterId:'US-NC-2',lifetimeAllowanceMicrousd:500000}]};
  const preset=await buildCpuPreset({root:directory,commit,configuration});assert.equal(preset.releaseCommit,commit);assert.equal(createHash('sha256').update(preset.bootstrapArgs).digest('hex'),preset.bootstrapHash);assert.equal(studioCpuPreset(companyId,{NODE_ENV:'test',COATRIA_MANAGED_CPU_PRESET:JSON.stringify(preset)}).company.companyId,companyId);assert(!JSON.stringify(preset).includes('MANAGED_RUNPOD_API_KEY'));
  const inference={mode:'coatria_broker_v1',maxJobs:12,maxHourlyMicrousd:600000,lifetimeAllowanceMicrousd:2000000},broker=await buildCpuPreset({root:directory,commit,configuration:{...configuration,inference}});assert.deepEqual(broker.inference,inference);assert.deepEqual(studioCpuPreset(companyId,{NODE_ENV:'test',COATRIA_MANAGED_CPU_PRESET:JSON.stringify(broker)}).inference,inference);assert.equal(broker.releaseCommit,preset.releaseCommit);assert.equal(broker.bootstrapHash,preset.bootstrapHash);assert(!Object.hasOwn(preset,'inference'),'Omitting inference preserves the reviewed direct transport');
  for(const patch of [{mode:'direct'},{maxJobs:0},{maxJobs:101},{maxJobs:1.5},{maxHourlyMicrousd:999},{maxHourlyMicrousd:10000001},{lifetimeAllowanceMicrousd:0},{lifetimeAllowanceMicrousd:20000001},{providerKey:'not-a-secret'},{endpointId:'unreviewed-endpoint'},{settings:{key:'not-a-secret'}}]){assert.throws(()=>studioCpuPreset(companyId,{NODE_ENV:'test',COATRIA_MANAGED_CPU_PRESET:JSON.stringify({...broker,inference:{...inference,...patch}})}),/invalid/i);await assert.rejects(buildCpuPreset({root:directory,commit,configuration:{...configuration,inference:{...inference,...patch}}}),/inference|configuration|documented/i);}
  for(const invalid of [null,[],{},'coatria_broker_v1',{mode:'coatria_broker_v1'}])await assert.rejects(buildCpuPreset({root:directory,commit,configuration:{...configuration,inference:invalid}}),/inference|configuration|documented/i);
  for(const boundary of [{maxJobs:1,maxHourlyMicrousd:1000,lifetimeAllowanceMicrousd:1},{maxJobs:100,maxHourlyMicrousd:10000000,lifetimeAllowanceMicrousd:20000000}])assert.deepEqual(studioCpuPreset(companyId,{NODE_ENV:'test',COATRIA_MANAGED_CPU_PRESET:JSON.stringify({...broker,inference:{mode:'coatria_broker_v1',...boundary}})}).inference,{mode:'coatria_broker_v1',...boundary});
  await assert.rejects(buildCpuPreset({root:directory,commit,configuration:{...configuration,providerKey:'fixture-not-a-real-key'}}),/nonsecret/);
  const input=join(directory,'configuration.json'),output=join(directory,'preset.json');await writeFile(input,JSON.stringify(configuration));const script=resolve('scripts/hosting/build-cpu-preset.mjs');await run(process.execPath,[script,commit,input,output],{cwd:directory});const first=await readFile(output,'utf8');assert.deepEqual(JSON.parse(first),preset);await assert.rejects(run(process.execPath,[script,commit,input,output],{cwd:directory}));assert.equal(await readFile(output,'utf8'),first);
  await writeFile(join(directory,'scripts/hosting/run-studio-host.mjs'),'// Unexpected changed runtime\n');await assert.rejects(buildCpuPreset({root:directory,commit,configuration}),/differs from the reviewed Git commit/);
 }finally{const child=relative(tmpdir(),directory);assert(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(directory,{recursive:true,force:true});}
});
