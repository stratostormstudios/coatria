import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, posix, resolve, sep} from 'node:path';
import {runInNewContext} from 'node:vm';
import {buildRunpodBootstrap, nodeImage} from '../scripts/hosting/build-runpod-bootstrap.mjs';

const commit='a'.repeat(40);
const paths=['public/downloads/agent-worker.mjs','public/downloads/provider-adapter.mjs','scripts/hosting/run-company-worker.mjs'];
const published=new Map(paths.map((path,index)=>[path,Buffer.from(`export const fixture${index}=true;\n`)]));
type Entry={kind:'file'|'directory'|'symlink';uid:number;mode:number;dev:number;bytes?:Buffer};
const directory=(dev=1):Entry=>({kind:'directory',uid:0,mode:0o755,dev});
const file=(bytes:Buffer):Entry=>({kind:'file',uid:0,mode:0o444,dev:1,bytes});
const missing=()=>Object.assign(new Error('missing'),{code:'ENOENT'});

async function artifact() {
  const temporary=await mkdtemp(join(tmpdir(),'coatria-bootstrap-test-'));
  try {
    for(const [path,bytes] of published){
      await mkdir(dirname(join(temporary,path)),{recursive:true});
      await writeFile(join(temporary,path),bytes.toString().replaceAll('\n','\r\n'));
    }
    return await buildRunpodBootstrap({commit,root:temporary});
  } finally {
    // Only remove the exact unique fixture directory created under the OS temp root.
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir())+sep));
    await rm(temporary,{recursive:true,force:true});
  }
}

async function boot(options:{existing?:Partial<Entry>;hashMismatch?:boolean;oversize?:boolean;mount?:Entry;expiry?:string;reuse?:boolean}={}) {
  const result=await artifact();
  const encoded=/data:text\/javascript;base64,([^']+)/.exec(result.args)?.[1];
  assert.ok(encoded);
  const source=Buffer.from(encoded,'base64').toString().replace(/^import .*;$/gm,'');
  const fs=new Map<string,Entry>([['/',directory()],['/state',options.mount??directory(2)]]);
  if(options.reuse||options.existing){
    fs.set('/state/avery',{...directory(2),uid:1000,mode:0o700});
    for(const [path,bytes] of published)fs.set('/opt/coatria/'+path,{...file(bytes),...options.existing});
  }
  const fetches:Array<{url:string;init:any}>=[],writes:string[]=[],logs:string[]=[],groups:number[][]=[];
  const spawns:Array<{command:string;args:string[];options:any}>=[];
  const handlers=new Map<string,(...args:any[])=>void>();
  const childHandlers=new Map<string,(...args:any[])=>void>();
  const kills:string[]=[];
  let cancelled=false,exitCode:number|undefined;
  const companyId='00000000-0000-4000-8000-000000000001',agentId='00000000-0000-4000-8000-000000000002';
  const env={COATRIA_HOST_EXPIRES_AT:options.expiry??new Date(Date.now()+60_000).toISOString(),COATRIA_HOST_COMPANY_ID:companyId,COATRIA_HOST_AGENT_ID:agentId,COATRIA_AGENT_TOKEN:'fixture-token',RUNPOD_API_KEY:'fixture-provider',COATRIA_URL:'https://coatria.com',COATRIA_RUNPOD_ENDPOINT_ID:'fixture-endpoint',UNRELATED_FLEET_SECRET:'must-not-pass',NODE_OPTIONS:'--inspect=0.0.0.0:9229'};
  const inspect=async(path:string)=>{
    const value=fs.get(path);if(!value)throw missing();
    return {...value,size:value.bytes?.byteLength??0,isDirectory:()=>value.kind==='directory',isFile:()=>value.kind==='file',isSymbolicLink:()=>value.kind==='symlink'};
  };
  const context={
    Buffer,AbortSignal,createHash,dirname:posix.dirname,
    process:{env,setgroups:(ids:number[])=>groups.push(ids),on:(event:string,handler:(...args:any[])=>void)=>handlers.set(event,handler),exit:(code:number)=>{exitCode=code;throw new Error('fixture process exit');}},
    console:{log:(value:string)=>logs.push(value),error:(value:string)=>logs.push(value)},
    lstat:inspect,stat:inspect,
    mkdir:async(path:string,config:any)=>{if(fs.has(path)&&!config.recursive)throw Object.assign(new Error('exists'),{code:'EEXIST'});if(!fs.has(path))fs.set(path,{...directory(path.startsWith('/state')?2:1),mode:config.mode});},
    chown:async(path:string,uid:number)=>{fs.get(path)!.uid=uid;},
    chmod:async(path:string,mode:number)=>{fs.get(path)!.mode=mode;},
    readFile:async(path:string)=>{const entry=fs.get(path);if(!entry)throw missing();return entry.bytes;},
    writeFile:async(path:string,bytes:Buffer,config:any)=>{assert.equal(config.flag,'wx');if(fs.has(path))throw Object.assign(new Error('exists'),{code:'EEXIST'});writes.push(path);fs.set(path,{...file(bytes),mode:config.mode});},
    fetch:async(url:string,init:any)=>{
      fetches.push({url,init});
      const prefix=`https://raw.githubusercontent.com/stratostormstudios/coatria/${commit}/`;
      assert.ok(url.startsWith(prefix));
      const bytes=published.get(url.slice(prefix.length));assert.ok(bytes);
      const chunks=options.oversize?[Buffer.alloc(1_048_576),Buffer.alloc(1)]:[options.hashMismatch?Buffer.from('unreviewed source'):bytes];
      let index=0;
      return {ok:true,body:{getReader:()=>({read:async()=>index<chunks.length?{done:false,value:chunks[index++]}:{done:true},cancel:async()=>{cancelled=true;}})}};
    },
    spawn:(command:string,args:string[],config:any)=>{spawns.push({command,args,options:config});return {on:(event:string,handler:(...args:any[])=>void)=>childHandlers.set(event,handler),kill:(signal:string)=>kills.push(signal)};},
  };
  try {await runInNewContext(`(async()=>{${source}\n})()`,context,{timeout:1000});}
  catch(error){if(exitCode===undefined)throw error;}
  return {result,fs,fetches,writes,logs,groups,spawns,handlers,childHandlers,kills,cancelled,exitCode,companyId,agentId};
}

test('bootstrap pins the image, full commit and exactly three LF-normalized source hashes',async()=>{
  await assert.rejects(buildRunpodBootstrap({commit:'main',root:'unused'}),/full reviewed commit/);
  const result=await artifact();
  assert.match(nodeImage,/^node@sha256:[a-f0-9]{64}$/);
  assert.equal(result.image,nodeImage);
  assert.deepEqual(result.manifest,paths.map(path=>({path,sha256:createHash('sha256').update(published.get(path)!).digest('hex')})));
  assert.ok(!result.args.includes('fixture-token'));
});

test('verified bootstrap launches only the fixed unprivileged worker with a private state directory and allowlisted env',async()=>{
  const actual=await boot();
  assert.equal(actual.exitCode,undefined);
  assert.equal(actual.fetches.length,3);
  assert.equal(actual.writes.length,3);
  for(const request of actual.fetches){assert.equal(request.init.redirect,'error');assert.ok(request.init.signal instanceof AbortSignal);}
  assert.equal(actual.fs.get('/state/avery')?.uid,1000);
  assert.equal(actual.fs.get('/state/avery')?.mode,0o700);
  assert.equal(actual.groups.length,1);assert.equal(actual.groups[0].length,0);
  assert.equal(actual.spawns.length,1);
  const spawn=actual.spawns[0];
  assert.equal(spawn.command,'/usr/local/bin/node');
  assert.equal(spawn.args.join(','),'/opt/coatria/scripts/hosting/run-company-worker.mjs');
  assert.equal(spawn.options.uid,1000);assert.equal(spawn.options.gid,1000);
  assert.equal(spawn.options.env.COATRIA_HOST_COMPANY_ID,actual.companyId);
  assert.equal(spawn.options.env.COATRIA_HOST_AGENT_ID,actual.agentId);
  assert.equal(spawn.options.env.COATRIA_HOST_STATE_DIR,'/state/avery');
  assert.equal(spawn.options.env.NODE_OPTIONS,undefined);
  assert.equal(spawn.options.env.UNRELATED_FLEET_SECRET,undefined);
  assert.equal(spawn.options.env.RUNPOD_API_KEY,'fixture-provider');
  assert.ok(!actual.logs.join('\n').includes('fixture-provider'));
  actual.handlers.get('SIGTERM')!();assert.deepEqual(actual.kills,['SIGTERM']);
});

test('a restarted Pod reuses only unchanged reviewed root-owned source',async()=>{
  const actual=await boot({reuse:true});
  assert.equal(actual.exitCode,undefined);
  assert.equal(actual.fetches.length,0);assert.equal(actual.writes.length,0);assert.equal(actual.spawns.length,1);
});

test('existing writable, non-root, linked or modified source is never executed or overwritten',async(t)=>{
  for(const [name,existing] of Object.entries({writable:{mode:0o666},owner:{uid:1000},symlink:{kind:'symlink'},modified:{bytes:Buffer.from('modified')}})){
    await t.test(name,async()=>{
      const actual=await boot({existing:existing as Partial<Entry>});
      assert.equal(actual.exitCode,1);assert.equal(actual.spawns.length,0);assert.equal(actual.writes.length,0);assert.equal(actual.fetches.length,0);
    });
  }
});

test('unexpected source and oversized downloads fail closed before writing or spawning',async(t)=>{
  for(const options of [{hashMismatch:true},{oversize:true}])await t.test(Object.keys(options)[0],async()=>{
    const actual=await boot(options);
    assert.equal(actual.exitCode,1);assert.equal(actual.spawns.length,0);assert.equal(actual.writes.length,0);
    if(options.oversize)assert.equal(actual.cancelled,true);
    assert.deepEqual(actual.logs,['COATRIA_BOOTSTRAP_FAILED']);
  });
});

test('expired host, ordinary disk and linked volume fail before download or execution',async(t)=>{
  for(const [name,options] of Object.entries({expired:{expiry:new Date(Date.now()-1_000).toISOString()},tooLong:{expiry:new Date(Date.now()+86_500_000).toISOString()},ordinaryDisk:{mount:directory(1)},symlink:{mount:{...directory(2),kind:'symlink' as const}}}))await t.test(name,async()=>{
    const actual=await boot(options);
    assert.equal(actual.exitCode,1);assert.equal(actual.spawns.length,0);assert.equal(actual.fetches.length,0);
    assert.deepEqual(actual.logs,['COATRIA_BOOTSTRAP_REJECTED']);
  });
});
