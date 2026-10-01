/** Bounded privileged registrar connection; never used by the worker process. */
import type {Readable} from 'node:stream';
import pg from 'pg';
import {assertImagePreparationHostQualificationEnvironment} from './image-preparation-host-qualification.mjs';
import {ImagePreparationHostEnrollmentError} from './image-preparation-host-enrollment.mjs';
import type {ImagePreparationEnrollmentRequest} from '../../src/lib/project-image-preparation-enrollment-contract.mjs';
const ROLE='coatria_image_preparation_registrar_v1',rejected='IMAGE_PREPARATION_HOST_ENROLLMENT_REJECTED';
function fail():never{throw new ImagePreparationHostEnrollmentError(rejected);}

/** URL options are validated then discarded. Only explicit pg fields survive;
 * nonlocal connections always verify TLS, including sslmode=require input. */
export function parseImagePreparationRegistrarConnectionInput(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!('connectionString'in value)||typeof value.connectionString!=='string'||Buffer.byteLength(value.connectionString)>16000||/[\u0000-\u001f\u007f]/.test(value.connectionString))fail();
 let url:URL;try{url=new URL(value.connectionString);}catch{fail();}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash||!url.username||!url.password||url.pathname.length<2)fail();
 const hostname=url.hostname.toLowerCase(),local=['localhost','127.0.0.1','[::1]'].includes(hostname);
 if(!local&&(!hostname.endsWith('.neon.tech')||hostname.split('.')[0].endsWith('-pooler')))fail();
 for(const key of url.searchParams.keys())if(!['sslmode','channel_binding'].includes(key)||url.searchParams.getAll(key).length!==1)fail();
 const sslmode=url.searchParams.get('sslmode'),binding=url.searchParams.get('channel_binding');
 if(sslmode&&!['require','verify-ca','verify-full',...local?['disable']:[]].includes(sslmode)||binding&&!['require','prefer'].includes(binding))fail();
 let user:string,password:string,database:string;try{user=decodeURIComponent(url.username);password=decodeURIComponent(url.password);database=decodeURIComponent(url.pathname.slice(1));}catch{fail();}
 if(user!==ROLE||!password||!database||[user,password,database].some(v=>/[\u0000-\u001f\u007f]/.test(v))||database.includes('/'))fail();
 const port=url.port?Number(url.port):5432;if(!Number.isSafeInteger(port)||port<1||port>65535)fail();
 return {host:hostname==='[::1]'?'::1':hostname,port,user,password,database,ssl:local&&(!sslmode||sslmode==='disable')?false:{rejectUnauthorized:true},enableChannelBinding:true,application_name:'coatria-image-preparation-host-registrar',connectionTimeoutMillis:10000,statement_timeout:10000,query_timeout:15000};
}
export function assertImagePreparationRegistrarEnvironment(settings:Readonly<Record<string,string|undefined>>){
 try{assertImagePreparationHostQualificationEnvironment(settings);}catch{fail();}
 if(Object.entries(settings).some(([key,value])=>value&&(/^PG[A-Z_]*$/.test(key)||/(?:CREDENTIAL|AWS_PROFILE|AWS_CONFIG_FILE)/i.test(key))))fail();
}

/** Own and destroy the stream on every failure; never leave a detached read. */
export async function readImagePreparationRegistrarConnectionInput(stream:Readable&{isTTY?:boolean}=process.stdin,timeoutMs=10000){
 if(stream.isTTY||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail();
 let length=0,expired=false;const chunks:Buffer[]=[];let joined:Buffer|undefined;
 const timer=setTimeout(()=>{expired=true;stream.destroy(new ImagePreparationHostEnrollmentError(rejected));},timeoutMs);
 try{
  for await(const chunk of stream){if(expired)fail();if(!Buffer.isBuffer(chunk)&&typeof chunk!=='string')fail();length+=Buffer.byteLength(chunk);if(length>16384)fail();chunks.push(Buffer.from(chunk));}
  if(expired)fail();joined=Buffer.concat(chunks);let value:unknown;try{value=JSON.parse(joined.toString('utf8'));}catch{fail();}
  return parseImagePreparationRegistrarConnectionInput(value);
 }catch{stream.destroy();fail();}finally{clearTimeout(timer);joined?.fill(0);for(const chunk of chunks)chunk.fill(0);}
}

/** Deliberately constructs a new physical client for each callback. Even an
 * unknown COMMIT cannot return its connection to a pool or trigger a retry. */
export async function imagePreparationRegistrarLogin<T>(connection:ReturnType<typeof parseImagePreparationRegistrarConnectionInput>,operation:(db:pg.Client,request:ImagePreparationEnrollmentRequest)=>Promise<T>,request:ImagePreparationEnrollmentRequest):Promise<T>{
 const client=new pg.Client(connection);client.on('error',()=>{});let result:T|undefined,primary:unknown,failed=false;
 try{await client.connect();result=await operation(client,request);}catch(error){failed=true;primary=error;}
 try{await client.end();}catch(error){if(!failed){failed=true;primary=error;}}
 if(failed)throw primary;return result as T;
}
