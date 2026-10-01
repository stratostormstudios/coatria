import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {assertImagePreparationRegistrarEnvironment,imagePreparationRegistrarFailureResult,imagePreparationRegistrarLogin,parseImagePreparationRegistrarArguments,parseImagePreparationRegistrarConnectionInput,readImagePreparationRegistrarConnectionInput,registerImagePreparationHost} from '../scripts/hosting/register-image-preparation-host.mjs';
import {ImagePreparationHostEnrollmentError} from '../scripts/hosting/image-preparation-host-enrollment.mjs';

const rejected='IMAGE_PREPARATION_HOST_ENROLLMENT_REJECTED',secret='synthetic-only-do-not-reflect';
const role='coatria_image_preparation_registrar_v1';
const base=['--host','/etc/coatria-image-preparation/00000000-0000-4000-8000-000000000099/host.json','--bundle','a'.repeat(64),'--registrar-bundle','b'.repeat(64)];
const plan=[...base,'--scope','/root/reviewed/scope.json','--scope-sha256','c'.repeat(64)];
// Construct synthetic input through URL fields, as in the registrar database fixtures.
const fixtureUrl=new URL('postgresql://ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require&channel_binding=require');
fixtureUrl.username=role;fixtureUrl.password=secret;const url=fixtureUrl.href;
const input={connectionString:url};
const fixed=(error:unknown)=>error instanceof ImagePreparationHostEnrollmentError&&error.message===rejected&&!String(error).includes(secret);
const request={} as Parameters<typeof imagePreparationRegistrarLogin>[2]; // Transport ownership only; real request validation belongs to the transaction tests.

test('registrar defaults to plan; explicit modes require exact ordered nonsecret arguments',()=>{
 assert.equal(parseImagePreparationRegistrarArguments(plan).mode,'plan');
 assert.deepEqual(parseImagePreparationRegistrarArguments(['plan',...plan]),parseImagePreparationRegistrarArguments(plan));
 assert.equal(parseImagePreparationRegistrarArguments(['enroll',...plan]).mode,'enroll');
 assert.deepEqual(parseImagePreparationRegistrarArguments(['reconcile',...base]),{mode:'reconcile',hostPath:base[1],bundleSha256:base[3],registrarBundleSha256:base[5]});
 for(const args of [[],['activate',...plan],['enroll',...base],['reconcile',...plan],[...plan,'--token',secret],['--bundle',base[3],...plan.slice(2)],plan.map((v,i)=>i===1?v.replace('/etc/','/tmp/'):v),plan.map((v,i)=>i===1?v.replace('4000','zzzz'):v),plan.map((v,i)=>i===7?'/root/../scope.json':v),plan.map((v,i)=>i===7?'relative.json':v),plan.map((v,i)=>i===7?'/root\\scope.json':v),plan.map((v,i)=>i===3?'A'.repeat(64):v),plan.map((v,i)=>i===9?'c'.repeat(63):v),plan.map((v,i)=>i===7?'/root/scope\n.json':v)])assert.throws(()=>parseImagePreparationRegistrarArguments(args),fixed);
});

test('registrar input projects an exact direct LOGIN into verified TLS fields without URL options',()=>{
 const parsed=parseImagePreparationRegistrarConnectionInput(input);
 assert.equal(parsed.user,role);assert.equal(parsed.password,secret);assert.equal(parsed.host,'ep-fixture.us-east-2.aws.neon.tech');
 assert.deepEqual(parsed.ssl,{rejectUnauthorized:true});assert.equal(parsed.enableChannelBinding,true);assert.equal(parsed.port,5432);
 assert.equal('connectionString'in parsed,false);assert.equal('options'in parsed,false);
 assert.equal(parsed.application_name,'coatria-image-preparation-host-registrar');assert.equal(parsed.connectionTimeoutMillis,10000);assert.equal(parsed.query_timeout,15000);
 for(const local of ['localhost','127.0.0.1','[::1]']){
  const localUrl=new URL(`postgres://${local}:5439/local?sslmode=disable`);localUrl.username=role;localUrl.password='fixture';
  const p=parseImagePreparationRegistrarConnectionInput({connectionString:localUrl.href});
  assert.equal(p.ssl,false);assert.equal(p.port,5439);
 }
 assert.deepEqual(parseImagePreparationRegistrarConnectionInput({connectionString:url.replace('require&','verify-full&')}).ssl,{rejectUnauthorized:true});
});

test('registrar rejects wrong roles, poolers, remote non-Neon targets, unsafe URL options and malformed inputs without reflection',()=>{
 const urls=[url.replace(role,'coatria_runtime_v1'),url.replace('ep-fixture.','ep-fixture-pooler.'),url.replace('neon.tech','example.test'),url.replace('postgresql:','https:'),url.replace(secret,''),url.replace('/db?','/?'),url+'#fragment',url+'&options=-c%20role%3Downer',url+'&sslmode=require',url+'&sslrootcert=/tmp/cert',url.replace('sslmode=require','sslmode=disable'),url.replace('channel_binding=require','channel_binding=disable'),url.replace(secret,'%0A'+secret),url.replace('/db?','/one%2ftwo?'),url.replace(secret,'%zz'),url.replace('/db?','/db%00?'),url+'\n'];
 for(const connectionString of urls)assert.throws(()=>parseImagePreparationRegistrarConnectionInput({connectionString}),fixed);
 for(const value of [null,[],url,{connectionString:url,password:secret},{connectionString:123},{connectionString:'x'.repeat(16001)}])assert.throws(()=>parseImagePreparationRegistrarConnectionInput(value),fixed);
});

test('registrar rejects ambient database, keyring, credential, proxy and runtime injection settings',()=>{
 assert.doesNotThrow(()=>assertImagePreparationRegistrarEnvironment({PATH:'/usr/bin:/bin',LANG:'C',HOME:'/root',PGHOST:''}));
 for(const key of ['PGHOST','PGPORT','PGSERVICE','PGSSLMODE','DATABASE_URL','COATRIA_KEYRING','AWS_PROFILE','AWS_CONFIG_FILE','GOOGLE_APPLICATION_CREDENTIALS','NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','HTTPS_PROXY','COATRIA_IMAGE_PREPARATION_TOKEN','SECRET'])assert.throws(()=>assertImagePreparationRegistrarEnvironment({[key]:secret}),fixed,key);
});

test('bounded stdin accepts split JSON and does not retain or modify caller chunks',async()=>{
 const bytes=Buffer.from(JSON.stringify(input)),before=Buffer.from(bytes),stream=Readable.from([bytes.subarray(0,7),bytes.subarray(7)]);
 const parsed=await readImagePreparationRegistrarConnectionInput(stream);assert.equal(parsed.password,secret);assert.deepEqual(bytes,before);assert.equal(stream.destroyed,true);
});

test('bounded stdin rejects malformed/oversized/multibyte input and owns failure cleanup',async()=>{
 for(const bytes of [Buffer.from('{'+secret),Buffer.from(JSON.stringify({...input,extra:true})),Buffer.alloc(16385,32),Buffer.from('é'.repeat(8193))]){
  const stream=Readable.from([bytes]);await assert.rejects(readImagePreparationRegistrarConnectionInput(stream),fixed);assert.equal(stream.destroyed,true);
 }
 const tty=Readable.from([]) as Readable&{isTTY?:boolean};tty.isTTY=true;await assert.rejects(readImagePreparationRegistrarConnectionInput(tty),fixed);tty.destroy();
 const stream=new Readable({read(){}});await assert.rejects(readImagePreparationRegistrarConnectionInput(stream,10),fixed);assert.equal(stream.destroyed,true);
});

test('fresh LOGIN closes before returning and uses a distinct client for every callback',async t=>{
 const connected:pg.Client[]=[],closed:pg.Client[]=[];let releaseClose!:()=>void;
 const closeGate=new Promise<void>(resolve=>{releaseClose=resolve;});
 t.mock.method(pg.Client.prototype,'connect',async function(this:pg.Client){connected.push(this);});
 t.mock.method(pg.Client.prototype,'end',async function(this:pg.Client){closed.push(this);if(closed.length===1)await closeGate;});
 let settled=false;const connection=parseImagePreparationRegistrarConnectionInput(input);
 const first=imagePreparationRegistrarLogin(connection,async(db,r)=>{assert.equal(db,connected[0]);assert.equal(r,request);return 'first';},request).then(value=>{settled=true;return value;});
 await nextTurn();assert.equal(closed.length,1);assert.equal(settled,false);releaseClose();assert.equal(await first,'first');
 assert.equal(await imagePreparationRegistrarLogin(connection,async()=> 'second',request),'second');
 assert.equal(connected.length,2);assert.equal(closed.length,2);assert.notEqual(connected[0],connected[1]);
});

test('unknown transaction outcome is preserved, closed and never retried even if close also fails',async t=>{
 let connects=0,ends=0,operations=0;const unknown=new Error('IMAGE_PREPARATION_ENROLLMENT_COMMIT_UNKNOWN');
 t.mock.method(pg.Client.prototype,'connect',async()=>{connects++;});
 t.mock.method(pg.Client.prototype,'end',async()=>{ends++;throw new Error(secret);});
 await assert.rejects(imagePreparationRegistrarLogin(parseImagePreparationRegistrarConnectionInput(input),async()=>{operations++;throw unknown;},request),error=>error===unknown);
 assert.deepEqual({connects,ends,operations},{connects:1,ends:1,operations:1});
 assert.equal(JSON.stringify(imagePreparationRegistrarFailureResult(unknown)).includes(secret),false);
});

test('failed connect still closes its dedicated client and invokes no transaction',async t=>{
 let ends=0,operations=0;const failure=new Error(secret);
 t.mock.method(pg.Client.prototype,'connect',async()=>{throw failure;});t.mock.method(pg.Client.prototype,'end',async()=>{ends++;});
 await assert.rejects(imagePreparationRegistrarLogin(parseImagePreparationRegistrarConnectionInput(input),async()=>{operations++;},request),error=>error===failure);
 assert.deepEqual({ends,operations},{ends:1,operations:0});
 assert.equal(imagePreparationRegistrarFailureResult(failure).code,rejected);
});

test('invalid or uninstalled plan never requests stdin or opens database connections',async t=>{
 let connects=0,reads=0;t.mock.method(pg.Client.prototype,'connect',async()=>{connects++;});
 t.mock.method(process.stdin,Symbol.asyncIterator,()=>{reads++;throw new Error('stdin must not be read');});
 await assert.rejects(registerImagePreparationHost([]),fixed);
 // The source CLI is not the pinned installed registrar, on either platform.
 await assert.rejects(registerImagePreparationHost(plan));assert.deepEqual({connects,reads},{connects:0,reads:0});
});

test('failure projection accepts only fixed typed codes and never reflects driver, token or unknown-code text',()=>{
 assert.equal(imagePreparationRegistrarFailureResult(new ImagePreparationHostEnrollmentError('IMAGE_PREPARATION_HOST_ENROLLMENT_OUTCOME_UNKNOWN')).code,'IMAGE_PREPARATION_HOST_ENROLLMENT_OUTCOME_UNKNOWN');
 for(const error of [new Error(secret),{code:'IMAGE_PREPARATION_HOST_ENROLLMENT_BUSY',message:secret},new ImagePreparationHostEnrollmentError(secret),new ImagePreparationHostEnrollmentError('IMAGE_PREPARATION_HOST_ENROLLMENT_'+secret),null])assert.deepEqual(imagePreparationRegistrarFailureResult(error),{event:'image-preparation-host-enrollment-stopped',code:rejected,workerEnabled:false});
});

test('source entrypoint rejects unconfigured execution with exactly one sanitized event',()=>{
 const path=fileURLToPath(new URL('../scripts/hosting/register-image-preparation-host.mts',import.meta.url));
 const result=spawnSync(process.execPath,['--import','tsx',path],{encoding:'utf8',timeout:15000,maxBuffer:16384});
 assert.ifError(result.error);assert.equal(result.status,1);assert.equal(result.stdout,'');
 const lines=result.stderr.trim().split(/\r?\n/);assert.equal(lines.length,1);assert.deepEqual(JSON.parse(lines[0]),{event:'image-preparation-host-enrollment-stopped',code:rejected,workerEnabled:false});
});
