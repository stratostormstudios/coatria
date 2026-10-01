/** Real local HTTP/stream lifecycle and isolated SQL preflight. Handler fixtures
 * here are synthetic; byte/provider correctness lives in the composed suite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseTrustedServiceGatewayConfiguration,trustedServiceHash} from '../src/lib/trusted-service-config';
import {createStorageGatewayNodeServer} from '../src/lib/project-storage-gateway-startup';
import {assertStorageGatewayStartupDatabase} from '../src/lib/project-storage-gateway-database';
import {assertTrustedServiceDatabase} from '../src/lib/trusted-service-provisioning';

const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const config=()=>({version:1 as const,companyId:randomUUID(),projectIds:[randomUUID()],sourceCommit:'a'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString(),appOrigin:'https://coatria.com' as const,host:'0.0.0.0' as const,port:4190 as const,maxTransfers:8 as const,verifierConcurrency:1 as const});
function endpoint(runtime:ReturnType<typeof createStorageGatewayNodeServer>){const address=runtime.address();assert(address&&typeof address!=='string');return 'http://127.0.0.1:'+address.port;}
function raw(origin:string,path:string,headers:Record<string,string>={}){const url=new URL(origin);return new Promise<{status:number;body:string}>((resolve,reject)=>{const req=httpRequest({hostname:url.hostname,port:url.port,method:'GET',path,headers},response=>{let body='';response.setEncoding('utf8');response.on('data',data=>{body+=data;});response.on('end',()=>resolve({status:response.statusCode!,body}));response.on('error',reject);});req.on('error',reject);req.end();});}

test('gateway preparation configuration is explicit, bounded and changes only opted-in hashes',()=>{
 const before=config(),parsed=parseTrustedServiceGatewayConfiguration(before);assert.deepEqual(parsed,before);assert.equal(trustedServiceHash(parsed),trustedServiceHash(before));assert(!Object.hasOwn(parsed,'imagePreparation'));
 const enabled={...before,imagePreparation:{version:1,maxTransfers:2}},result=parseTrustedServiceGatewayConfiguration(enabled);assert.deepEqual(result,enabled);assert.notEqual(trustedServiceHash(result),trustedServiceHash(before));
 for(const value of [true,false,{},null,{version:2,maxTransfers:2},{version:1,maxTransfers:0},{version:1,maxTransfers:9},{version:1,maxTransfers:1.5},{version:1,maxTransfers:2,origin:'https://attacker.invalid'},{version:1,maxTransfers:2,companyId:randomUUID()}])assert.throws(()=>parseTrustedServiceGatewayConfiguration({...before,imagePreparation:value}));
 for(const change of [{sourceCommit:undefined},{companyId:undefined},{projectIds:[]},{projectIds:[before.projectIds[0],before.projectIds[0]]},{expiresAt:undefined}])assert.throws(()=>parseTrustedServiceGatewayConfiguration({...enabled,...change}));
});

test('startup chooses the exact preflight only from the parsed opt-in configuration',{timeout:120000},async()=>{
 const {PGlite}=await import('@electric-sql/pglite'),db=await PGlite.create(),role='coatria_storage_gateway_v1';
 try{
  await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY)');for(const file of (await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort()){await db.exec(await readFile('database/'+file,'utf8'));await db.query('INSERT INTO schema_migrations VALUES($1)',[file]);}
  await db.exec('CREATE ROLE '+role+' LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');await db.exec(await readFile('database/storage-gateway-permissions.sql','utf8'));
  const base=config(),enabled=parseTrustedServiceGatewayConfiguration({...base,imagePreparation:{version:1,maxTransfers:2}}),check=async(value?:ReturnType<typeof parseTrustedServiceGatewayConfiguration>)=>{await db.exec('SET SESSION AUTHORIZATION '+role);try{return await assertStorageGatewayStartupDatabase(db,value);}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}};
  await db.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic startup',$2,'blank')",[base.companyId,base.companyId]);
  const admission=async(value:unknown,companyId=base.companyId)=>{await db.exec('SET SESSION AUTHORIZATION '+role);try{await assertTrustedServiceDatabase(db,'gateway',companyId,value);}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}};
  assert.equal((await check()).contractVersion,2);assert.equal((await check(base)).contractVersion,2);await assert.rejects(check(enabled),{code:'STORAGE_DB_PRIVILEGES'});
  await admission(base);await assert.rejects(admission(enabled),{code:'STORAGE_DB_PRIVILEGES'});await assert.rejects(admission(base,randomUUID()),{message:'SERVICE_DATABASE_SCOPE'});
  await db.exec(await readFile('database/image-preparation-gateway-permissions.sql','utf8'));assert.equal((await check(enabled)).migrationFloor,50);await assert.rejects(check(),{code:'STORAGE_DB_PRIVILEGES'});await assert.rejects(check(base),{code:'STORAGE_DB_PRIVILEGES'});
  await admission(enabled);await assert.rejects(admission(base),{code:'STORAGE_DB_PRIVILEGES'});
 }finally{await db.close();}
});

test('fixed HTTP routing ignores caller hosts and cannot enable the byte handler',async()=>{
 const generic:string[]=[],prepared:string[]=[];let closed=0,poolClosed=0;
 const gateway={async handle(request:Request){generic.push(request.url);return new Response('ordinary');},async verifyNext(){}},preparation={async handle(request:Request){prepared.push(request.url);return new Response('prepared');},close(){closed++;},async drain(){}};
 const ordinary=createStorageGatewayNodeServer({gateway,host:'127.0.0.1',port:0,closePool:async()=>{poolClosed++;},onVerificationError(){},onShutdownError(){assert.fail();}});
 try{await ordinary.listen();const origin=endpoint(ordinary);assert.equal((await raw(origin,'/v1/image-preparations/capabilities/'+randomUUID()+'/read-source',{host:'attacker.invalid','x-forwarded-host':'attacker.invalid','x-coatria-image-preparation':'true'})).status,404);assert.equal(prepared.length,0);assert.equal(generic.length,0);assert.equal((await raw(origin,'/health',{host:'attacker.invalid'})).body,'ordinary');assert.equal(new URL(generic[0]).hostname,'127.0.0.1');}finally{await ordinary.stop();}
 const enabled=createStorageGatewayNodeServer({gateway,preparation,host:'127.0.0.1',port:0,closePool:async()=>{poolClosed++;},onVerificationError(){},onShutdownError(){assert.fail();}});
 try{await enabled.listen();const origin=endpoint(enabled),path='/v1/image-preparations/capabilities/'+randomUUID()+'/read-source';assert.equal((await raw(origin,path,{host:'elsewhere.invalid','x-forwarded-proto':'https'})).body,'prepared');assert.equal(new URL(prepared[0]).hostname,'127.0.0.1');for(const target of ['https://attacker.invalid'+path,'//attacker.invalid'+path,'/v1\\image-preparations'])assert.equal((await raw(origin,target)).status,400);assert.equal(prepared.length,1);assert.equal((await raw(origin,'/v1/image-preparations-other')).body,'ordinary');}finally{await enabled.stop();}
 assert.equal(closed,1);assert.equal(poolClosed,2);
});

test('shutdown aborts admission but retains the pool until byte work and drain actually settle',async()=>{
 const entered=deferred(),release=deferred(),drainEntered=deferred(),drainRelease=deferred();let signal:AbortSignal|undefined,poolClosed=0,closed=0,settled=false;
 const runtime=createStorageGatewayNodeServer({gateway:{async handle(){return new Response('generic');},async verifyNext(){}},preparation:{async handle(request){signal=request.signal;entered.resolve();await release.promise;return new Response('late bytes');},close(){closed++;},async drain(){drainEntered.resolve();await drainRelease.promise;}},host:'127.0.0.1',port:0,closePool:async()=>{poolClosed++;},onVerificationError(){},onShutdownError(){assert.fail();}});
 let response:Promise<unknown>|undefined,stop:Promise<void>|undefined;
 try{await runtime.listen();response=fetch(endpoint(runtime)+'/v1/image-preparations/wait').catch(()=>null);await entered.promise;stop=runtime.stop().then(()=>{settled=true;});assert.equal(runtime.stop(),runtime.stop());await drainEntered.promise;assert.equal(signal!.aborted,true);assert.equal(closed,1);await delay(30);assert.equal(poolClosed,0);assert.equal(settled,false);release.resolve();await delay(10);assert.equal(poolClosed,0);drainRelease.resolve();await stop;assert.equal(poolClosed,1);assert.equal(settled,true);}finally{release.resolve();drainRelease.resolve();await stop;await response;await runtime.stop();}
});

test('cleanup rejection is not converted into a pool close or clean shutdown',async()=>{
 let poolClosed=0;const runtime=createStorageGatewayNodeServer({gateway:{async handle(){return new Response();},async verifyNext(){}},preparation:{async handle(){return new Response();},close(){},async drain(){throw Error('Synthetic raw I/O not confirmed');}},host:'127.0.0.1',port:0,closePool:async()=>{poolClosed++;},onVerificationError(){},onShutdownError(){}});
 await runtime.listen();await assert.rejects(runtime.stop(),{message:'STORAGE_GATEWAY_CLEANUP_UNCONFIRMED'});assert.equal(poolClosed,0);await assert.rejects(runtime.stop(),{message:'STORAGE_GATEWAY_CLEANUP_UNCONFIRMED'});
});

test('absolute expiry closes admission and awaits genuine cleanup',async()=>{
 const drainEntered=deferred(),release=deferred(),pool=deferred();let closed=0;
 const runtime=createStorageGatewayNodeServer({gateway:{async handle(){return new Response();},async verifyNext(){}},preparation:{async handle(){return new Response();},close(){closed++;},async drain(){drainEntered.resolve();await release.promise;}},host:'127.0.0.1',port:0,expiresAt:new Date(Date.now()+100).toISOString(),closePool:async()=>{pool.resolve();},onVerificationError(){},onShutdownError(){assert.fail();}});
 try{await runtime.listen();await drainEntered.promise;assert.equal(closed,1);release.resolve();await pool.promise;await runtime.stop();}finally{release.resolve();await runtime.stop();}
});

test('active generic verification settles before its shared pool is closed',async()=>{
 const entered=deferred(),release=deferred();let poolClosed=0,settled=false;
 const runtime=createStorageGatewayNodeServer({gateway:{async handle(){return new Response();},async verifyNext(){entered.resolve();await release.promise;}},host:'127.0.0.1',port:0,closePool:async()=>{poolClosed++;},onVerificationError(){assert.fail();},onShutdownError(){assert.fail();}});
 try{await runtime.listen();await entered.promise;const stopping=runtime.stop().then(()=>{settled=true;});await delay(20);assert.equal(settled,false);assert.equal(poolClosed,0);release.resolve();await stopping;assert.equal(poolClosed,1);}finally{release.resolve();await runtime.stop();}
});
