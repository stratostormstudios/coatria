/** Disposable acceptance fixture: real SQL/control/byte handlers and signed SDK,
 * synthetic S3 bytes only. This is never an installed service or provider. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {createServer,type Server} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {TLSSocket} from 'node:tls';
import type {Duplex} from 'node:stream';
import type {PoolClient} from 'pg';
import {createImagePreparationControlService} from '../../src/lib/project-image-preparation-service.js';
import {createProjectImagePreparationServiceHttpHandler} from '../../src/lib/project-image-preparation-service-http.js';
import {createImagePreparationByteGateway} from '../../src/lib/project-image-preparation-byte-gateway.js';
import {authorizeImagePreparationService,authorizeImagePreparationServiceProject} from '../../src/lib/project-image-preparation-service-authority.js';
import {openProjectStorageCredentials} from '../../src/lib/project-storage.js';
import {preparationServiceRequests,preparationServiceToken,preparationServiceUuid,preparationServiceOrigin,PREPARATION_SERVICE_MAX_JSON_BYTES} from '../../src/lib/project-image-preparation-service-protocol.js';
import {projectImagePreparationProcessorSchema,type ProjectImagePreparationProcessor} from '../../src/lib/project-image-preparations-protocol.js';
import {imagePreparationEnrollmentCanonical as canonical} from '../../src/lib/project-image-preparation-enrollment-contract.mjs';
type Transaction=<T>(run:(db:PoolClient)=>Promise<T>)=>Promise<T>;
export type InstalledImagePreparationScenario='success'|'lost-initiation-response'|'changed-readback';
export type InstalledImagePreparationSource={projectId:string;versionId:string;bytes:Buffer;etag:string};
export type InstalledImagePreparationFixtureOptions={transaction?:Transaction;controlTransaction?:Transaction;gatewayTransaction?:Transaction;
 identity:{serviceId:string;companyId:string;projectIds:string[];origin:string;expiresAt:string;processor:ProjectImagePreparationProcessor;token:string};
 gateway:{origin:string;provisionId:string;configurationHash:string;sourceCommit:string;expiresAt:string};storageKeyring:string;sources:InstalledImagePreparationSource[];scenario?:InstalledImagePreparationScenario};
const SOURCE_MAX=32*1024**2,OUTPUT_MAX=10*1024**2,TOTAL_MAX=64*1024**2,ENDPOINT='https://s3api-us-ca-2.runpod.io';
const ACCESS='user_synthetic',SECRET='rps_synthetic';
const scenarios=['success','lost-initiation-response','changed-readback'];
const METADATA_STATUSES=['200','400','401','403','404','405','408','409','413','415','429','499','503','other'] as const;
const METADATA_ERROR_STATUS:Readonly<Record<string,number>>=Object.freeze({PREPARATION_SERVICE_REQUEST_INVALID:400,PREPARATION_SERVICE_NOT_FOUND:404,PREPARATION_SERVICE_METHOD_INVALID:405,PREPARATION_SERVICE_UNAUTHORIZED:401,PREPARATION_SERVICE_FORBIDDEN:403,PREPARATION_SERVICE_TOO_LARGE:413,PREPARATION_SERVICE_MEDIA_TYPE_INVALID:415,PREPARATION_SERVICE_CONFLICT:409,PREPARATION_SERVICE_RATE_LIMITED:429,PREPARATION_SERVICE_TIMEOUT:408,PREPARATION_SERVICE_ABORTED:499,PREPARATION_SERVICE_UNAVAILABLE:503,IMAGE_PREPARATION_SERVICE_OUTCOME_UNKNOWN:503});
const METADATA_CODES=['none','unknown',...Object.keys(METADATA_ERROR_STATUS)],METADATA_DIAGNOSTIC_MAX=1024,METADATA_COUNT_MAX=100000;
/** Fixed diagnostic projection only: arbitrary error text, identifiers and
 * unrecognized codes must never become audit keys or values. */
export function imagePreparationInstalledMetadataResponseDiagnostic(status:number,body?:string){
 const statusKey=METADATA_STATUSES.find(value=>value===String(status))??'other';let code=status<400?'none':'unknown';
 if(status>=400&&typeof body==='string'&&Buffer.byteLength(body)<=METADATA_DIAGNOSTIC_MAX)try{const parsed:unknown=JSON.parse(body);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&'code' in parsed&&typeof parsed.code==='string'&&Object.hasOwn(METADATA_ERROR_STATUS,parsed.code)&&METADATA_ERROR_STATUS[parsed.code]===status)code=parsed.code;}catch{/* Unknown is the only retained parse result. */}
 return {status:statusKey,code};
}
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex'),same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const etag=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f<>&,]/.test(v)&&v!=='*'&&!v.startsWith('W/');
function fail():never{throw new Error('IMAGE_PREPARATION_INSTALLED_FIXTURE_REJECTED');}
function check(v:unknown):asserts v{if(!v)fail();}
function setKeyring(value:string|undefined){if(value===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=value;}
const errorResponse=(status:number)=>new Response('{"error":"Synthetic fixture request rejected."}',{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const encode=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
type ObjectEntry={projectId:string;versionId:string;bytes:Buffer;etag:string};
type Upload={projectId:string;versionId:string;uploadId:string;bytes:number;sha256:string;scenario:InstalledImagePreparationScenario;part:Buffer|null;completed:boolean};
let installed:object|undefined,creating=false;

/** A cryptographic check of the actual SDK wire request, not a regex assertion
 * that a caller supplied an Authorization-looking header. */
function verifySignature(url:URL,method:string,headers:Headers,body:Buffer){
 const match=/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/US-CA-2\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(headers.get('authorization')??'');
 check(match&&match[1]===ACCESS);const names=match[3].split(';');check(names.length<=32&&same(names,[...new Set(names)].sort())&&names.includes('host')&&names.includes('x-amz-date'));
 const date=headers.get('x-amz-date');check(date&&/^\d{8}T\d{6}Z$/.test(date)&&date.startsWith(match[2]));check(headers.get('host')===url.host);
 const payload=headers.get('x-amz-content-sha256');check(payload===hash(body)||payload==='UNSIGNED-PAYLOAD'&&body.length===0);
 const query=[...url.searchParams.entries()].map(([k,v])=>[encode(k),encode(v)]).sort(([ak,av],[bk,bv])=>ak===bk?av.localeCompare(bv):ak.localeCompare(bk)).map(([k,v])=>k+'='+v).join('&');
 const canonicalHeaders=names.map(name=>{const value=headers.get(name);check(value!==null);return name+':'+value.trim().replace(/\s+/g,' ')+'\n';}).join('');
 const request=[method,url.pathname,query,canonicalHeaders,match[3],payload].join('\n'),scope=match[2]+'/US-CA-2/s3/aws4_request',toSign=['AWS4-HMAC-SHA256',date,scope,hash(request)].join('\n');
 const hmac=(key:string|Buffer,value:string)=>createHmac('sha256',key).update(value).digest();
 const signing=hmac(hmac(hmac(hmac('AWS4'+SECRET,match[2]),'US-CA-2'),'s3'),'aws4_request'),signature=hmac(signing,toSign);
 check(timingSafeEqual(signature,Buffer.from(match[4],'hex')));
}

export async function createImagePreparationInstalledFixture(options:InstalledImagePreparationFixtureOptions){
 check(!creating&&!installed);creating=true;
 const identity=structuredClone(options.identity),gatewayIdentity=structuredClone(options.gateway),controlTransaction=options.controlTransaction??options.transaction,gatewayTransaction=options.gatewayTransaction??options.transaction;
 const sources=new Map<string,ObjectEntry>(),uploads=new Map<string,Upload>(),outputs=new Map<string,ObjectEntry>(),storage=new Map<string,{volumeId:string;connectionId:string}>();
 const pending=new Set<Promise<unknown>>(),requestControllers=new Set<AbortController>(),servers=new Set<{close:()=>void;drain:()=>Promise<void>}>();let closed=false,drained=false,drainFailed=false,scenario=options.scenario??'success',retainedBytes=0,transportFailureStage:string|null=null;
 const owner={},counts={metadata:0,bytes:0,readSource:0,initiate:0,part:0,complete:0,readOutput:0,signatureVerified:0,rejectedEgress:0,transportRejected:0,lostInitiation:0,changedReadback:0,httpRejected:0};
 const metadataCounts=Object.fromEntries(Object.keys(preparationServiceRequests).map(k=>[k,0])) as Record<string,number>;
 const metadataResponses=Object.fromEntries([...Object.keys(preparationServiceRequests),'unknown'].map(operation=>[operation,{completed:0,statuses:Object.fromEntries(METADATA_STATUSES.map(status=>[status,0])),codes:Object.fromEntries(METADATA_CODES.map(code=>[code,0]))}]));let metadataResponseOverflow=false;
 function countMetadataResponse(operation:string,response:Response,body?:string){const row=metadataResponses[Object.hasOwn(preparationServiceRequests,operation)?operation:'unknown'],projection=imagePreparationInstalledMetadataResponseDiagnostic(response.status,body);const add=(value:number)=>{if(value>=METADATA_COUNT_MAX){metadataResponseOverflow=true;return value;}return value+1;};row.completed=add(row.completed);row.statuses[projection.status]=add(row.statuses[projection.status]);row.codes[projection.code]=add(row.codes[projection.code]);}
 async function observeMetadataResponse(operation:string,response:Response){
  let body:string|undefined;
  // Only the real metadata HTTP handler returns here. Its response is a fully
  // materialized, bounded JSON string. Never inspect success bodies (which can
  // contain byte tokens), nor clone/read any gateway response stream.
  const length=response.headers.get('content-length');
  if(response.status>=400&&response.headers.get('content-type')==='application/json; charset=utf-8'&&length!==null&&/^[1-9]\d*$/.test(length)&&Number(length)<=METADATA_DIAGNOSTIC_MAX)try{body=await response.clone().text();}catch{/* Observation cannot change the handler result. */}
  countMetadataResponse(operation,response,body);return response;
 }
 const track=<T,>(p:Promise<T>)=>{pending.add(p);void p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
 const increment=(key:keyof typeof counts)=>{check(counts[key]<100000);counts[key]++;};
 try{
  check(typeof controlTransaction==='function'&&typeof gatewayTransaction==='function'&&scenarios.includes(scenario)&&typeof options.storageKeyring==='string'&&options.storageKeyring.length<=16384);
  check(preparationServiceUuid.safeParse(identity.serviceId).success&&preparationServiceUuid.safeParse(identity.companyId).success&&preparationServiceToken.safeParse(identity.token).success&&preparationServiceOrigin.safeParse(identity.origin).success&&identity.origin==='https://coatria.com'&&Array.isArray(identity.projectIds)&&identity.projectIds.length>0&&identity.projectIds.length<=32&&new Set(identity.projectIds).size===identity.projectIds.length&&identity.projectIds.every(id=>preparationServiceUuid.safeParse(id).success)&&Date.parse(identity.expiresAt)>Date.now());
  check(gatewayIdentity.origin==='https://imagepreparationci1-4190.proxy.runpod.net'&&preparationServiceUuid.safeParse(gatewayIdentity.provisionId).success&&sha(gatewayIdentity.configurationHash)&&/^[a-f0-9]{40}$/.test(gatewayIdentity.sourceCommit)&&Date.parse(gatewayIdentity.expiresAt)>=Date.parse(identity.expiresAt));
  const processor=projectImagePreparationProcessorSchema.parse(identity.processor);check(processor.id===identity.serviceId&&processor.expiresAt===identity.expiresAt);
  await controlTransaction(async db=>{
   const current=await authorizeImagePreparationService(db,identity.serviceId,{tokenHash:hash(identity.token)});check(current.service.company_id===identity.companyId&&same(current.processor,processor)&&current.enrollment.origin===identity.origin&&same([...current.projects.map(p=>p.project_id)].sort(),[...identity.projectIds].sort()));
   const provision=(await db.query('SELECT preset FROM trusted_service_provisions WHERE company_id=$1 AND id=$2',[identity.companyId,gatewayIdentity.provisionId])).rows[0];check(provision?.preset?.configuration?.sourceCommit===gatewayIdentity.sourceCommit&&same(provision.preset.configuration.projectIds,identity.projectIds));
   for(const projectId of identity.projectIds){const project=await authorizeImagePreparationServiceProject(db,current,projectId);check(project.gateway.origin===gatewayIdentity.origin&&project.gateway.provisionId===gatewayIdentity.provisionId&&project.gateway.configurationHash===gatewayIdentity.configurationHash&&project.gateway.expiresAt===gatewayIdentity.expiresAt);storage.set(projectId,{volumeId:'',connectionId:project.storage_connection_id});}
  });
  const previous=process.env.COATRIA_HOSTING_KEYRING;setKeyring(options.storageKeyring);
  try{await gatewayTransaction(async db=>{for(const [projectId,pin] of storage){const value=await openProjectStorageCredentials(db,identity.companyId,pin.connectionId);check(value.connection.region==='US-CA-2'&&['synthetic-volume','synthetic-fixture-volume'].includes(value.connection.volumeId)&&value.accessKeyId===ACCESS&&value.secretAccessKey===SECRET);storage.set(projectId,{...pin,volumeId:value.connection.volumeId});}});}finally{setKeyring(previous);}
  check(Array.isArray(options.sources)&&options.sources.length>0&&options.sources.length<=32);
 }finally{creating=false;}
 async function addSource(source:InstalledImagePreparationSource){
  check(!closed&&identity.projectIds.includes(source.projectId)&&preparationServiceUuid.safeParse(source.versionId).success&&Buffer.isBuffer(source.bytes)&&source.bytes.length>0&&source.bytes.length<=SOURCE_MAX&&etag(source.etag)&&!sources.has(source.versionId)&&!outputs.has(source.versionId)&&sources.size<32&&retainedBytes+source.bytes.length<=TOTAL_MAX);
  const bytes=Buffer.from(source.bytes),digest=hash(bytes);
  await controlTransaction!(async db=>{const row=(await db.query(`SELECT v.bytes,v.sha256,v.content_type,v.object_key,f.project_id,x.provider_etag FROM project_storage_versions v JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id) JOIN project_storage_verifications x ON (x.company_id,x.project_id,x.version_id)=(v.company_id,v.project_id,v.id) WHERE v.company_id=$1 AND v.project_id=$2 AND v.id=$3`,[identity.companyId,source.projectId,source.versionId])).rows[0];check(row&&Number(row.bytes)===bytes.length&&row.sha256===digest&&row.content_type==='image/png'&&row.provider_etag===source.etag&&row.object_key===`coatria/companies/${identity.companyId}/projects/${source.projectId}/objects/${source.versionId}`);});
  sources.set(source.versionId,{projectId:source.projectId,versionId:source.versionId,bytes,etag:source.etag});retainedBytes+=bytes.length;
 }
 for(const source of options.sources)await addSource(source);
 const service=createImagePreparationControlService({transaction:controlTransaction!}),http=createProjectImagePreparationServiceHttpHandler({origin:identity.origin,execute:service.execute});
 const gateway=createImagePreparationByteGateway({transaction:gatewayTransaction!,identity:{version:1,companyId:identity.companyId,projectIds:identity.projectIds,provisionId:gatewayIdentity.provisionId,configurationHash:gatewayIdentity.configurationHash,sourceCommit:gatewayIdentity.sourceCommit,expiresAt:gatewayIdentity.expiresAt}});
 const object=(entry:ObjectEntry,changed=false)=>{const bytes=Buffer.from(entry.bytes);if(changed)bytes[bytes.length-1]^=1;return new Response(new Uint8Array(bytes),{headers:{'content-type':'image/png','content-length':String(bytes.length),etag:entry.etag}});};
 async function syntheticFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
  let stage='request';
  try{
   check(!closed&&installed===owner&&!(input instanceof Request)&&init?.signal&&!init.signal.aborted&&init.redirect==='error'&&init.cache==='no-store');const url=new URL(String(input)),method=init.method??'GET',headers=new Headers(init.headers);
   if(url.origin!==ENDPOINT){increment('rejectedEgress');fail();}check(!url.username&&!url.password&&!url.hash&&!headers.has('range')&&!headers.has('x-amz-security-token')&&headers.get('accept-encoding')==='identity');
   const match=/^\/([-a-z0-9]+)\/coatria\/companies\/([a-f0-9-]{36})\/projects\/([a-f0-9-]{36})\/objects\/([a-f0-9-]{36})$/.exec(url.pathname);check(match&&match[2]===identity.companyId&&storage.get(match[3])?.volumeId===match[1]&&preparationServiceUuid.safeParse(match[4]).success);const projectId=match[3],versionId=match[4],keys=[...url.searchParams.keys()];check(new Set(keys).size===keys.length);
   stage='operation';const marker=url.searchParams.get('x-id'),isRead=method==='GET'&&keys.length===1&&marker==='GetObject',isInitiate=method==='POST'&&keys.every(k=>['uploads','x-id'].includes(k))&&url.searchParams.get('uploads')===''&&(marker===null||marker==='CreateMultipartUpload'),isPart=method==='PUT'&&keys.every(k=>['partNumber','uploadId','x-id'].includes(k))&&url.searchParams.get('partNumber')==='1'&&url.searchParams.has('uploadId')&&(marker===null||marker==='UploadPart'),isComplete=method==='POST'&&keys.every(k=>['uploadId','x-id'].includes(k))&&url.searchParams.has('uploadId')&&(marker===null||marker==='CompleteMultipartUpload');check([isRead,isInitiate,isPart,isComplete].filter(Boolean).length===1);
   stage='body';check(init.body===undefined||typeof init.body==='string'||init.body instanceof Uint8Array);const body=init.body===undefined?Buffer.alloc(0):Buffer.from(init.body as string|Uint8Array);check(body.length<=(isPart?OUTPUT_MAX:65536));stage='signature';verifySignature(url,method,headers,body);increment('signatureVerified');check(!init.signal.aborted);
   stage='read';if(isRead){check(body.length===0);const source=sources.get(versionId),output=outputs.get(versionId),entry=source??output;check(entry&&entry.projectId===projectId&&headers.get('if-match')===entry.etag);if(source){increment('readSource');return object(source);}increment('readOutput');const changed=uploads.get(versionId)?.scenario==='changed-readback';if(changed)increment('changedReadback');return object(entry,changed);}
   check(!sources.has(versionId));
   stage='allocation';const allocation=await gatewayTransaction!(async db=>(await db.query('SELECT output_bytes,output_sha256 FROM project_image_preparation_allocations WHERE company_id=$1 AND project_id=$2 AND version_id=$3',[identity.companyId,projectId,versionId])).rows[0]);check(allocation&&Number(allocation.output_bytes)>0&&Number(allocation.output_bytes)<=OUTPUT_MAX&&sha(allocation.output_sha256)&&!init.signal.aborted);
   const key=url.pathname.slice(match[1].length+2),xml=(value:string)=>new Response(value,{headers:{'content-type':'application/xml'}});
   stage='initiate';if(isInitiate){check(!uploads.has(versionId)&&uploads.size<32&&body.length===0&&headers.get('content-type')==='image/png');increment('initiate');const uploadId='synthetic-upload-'+versionId;uploads.set(versionId,{projectId,versionId,uploadId,bytes:Number(allocation.output_bytes),sha256:allocation.output_sha256,scenario,part:null,completed:false});if(scenario==='lost-initiation-response'){increment('lostInitiation');stage='synthetic-lost-response';throw Error('IMAGE_PREPARATION_SYNTHETIC_LOST_RESPONSE');}return xml(`<InitiateMultipartUploadResult><Bucket>${match[1]}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);}
   const upload=uploads.get(versionId);check(upload&&upload.projectId===projectId&&upload.uploadId===url.searchParams.get('uploadId')&&upload.bytes===Number(allocation.output_bytes)&&upload.sha256===allocation.output_sha256&&!upload.completed);
   stage='part';if(isPart){check(upload.part===null&&body.length===upload.bytes&&hash(body)===upload.sha256&&retainedBytes+body.length<=TOTAL_MAX);increment('part');upload.part=Buffer.from(body);retainedBytes+=body.length;return new Response(null,{headers:{etag:'synthetic-part-etag'}});}
   stage='complete';check(upload.part&&body.toString('utf8').includes('<PartNumber>1</PartNumber>')&&body.toString('utf8').includes('<ETag>synthetic-part-etag</ETag>')&&!body.toString('utf8').includes('<PartNumber>2</PartNumber>'));increment('complete');upload.completed=true;outputs.set(versionId,{projectId,versionId,bytes:upload.part,etag:'synthetic-stored-etag'});return xml(`<CompleteMultipartUploadResult><Bucket>${match[1]}</Bucket><Key>${key}</Key><ETag>synthetic-stored-etag</ETag></CompleteMultipartUploadResult>`);
  }catch{transportFailureStage=stage;increment('transportRejected');throw Error('IMAGE_PREPARATION_SYNTHETIC_TRANSPORT_REJECTED');}
 }
 const fetchAdapter:typeof fetch=(input,init)=>track(syntheticFetch(input,init));
 const handle=(request:Request)=>track((async()=>{
  if(closed||installed!==owner||globalThis.fetch!==fetchAdapter)return errorResponse(503);const controller=new AbortController(),abort=()=>controller.abort();requestControllers.add(controller);request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
  try{const scoped=new Request(request,{signal:controller.signal}),url=new URL(scoped.url);if(url.origin===identity.origin&&url.pathname.startsWith('/api/internal/image-preparation-services/'+identity.serviceId+'/')){increment('metadata');const operation=url.pathname.split('/').at(-1)!;if(Object.hasOwn(metadataCounts,operation))metadataCounts[operation]++;return await observeMetadataResponse(operation,await http(scoped));}
   if(url.origin===gatewayIdentity.origin&&url.pathname.startsWith('/v1/image-preparations/capabilities/')){increment('bytes');return await gateway.handle(scoped);}increment('httpRejected');return errorResponse(421);
  }finally{request.signal.removeEventListener('abort',abort);requestControllers.delete(controller);}
 })());
 function installSyntheticS3Fetch(){check(!closed&&!installed);const previousFetch=globalThis.fetch,previousKeyring=process.env.COATRIA_HOSTING_KEYRING;installed=owner;setKeyring(options.storageKeyring);globalThis.fetch=fetchAdapter;return()=>{check(closed&&drained&&pending.size===0&&installed===owner&&globalThis.fetch===fetchAdapter);globalThis.fetch=previousFetch;setKeyring(previousKeyring);installed=undefined;};}
 async function startServer({tls,port=443,host='127.0.0.1'}:{tls:{key:Buffer;cert:Buffer};port?:0|443;host?:'127.0.0.1'}){
  check(!closed&&installed===owner&&servers.size===0&&host==='127.0.0.1'&&(port===0||port===443)&&Buffer.isBuffer(tls.key)&&Buffer.isBuffer(tls.cert)&&tls.key.length>0&&tls.key.length<=65536&&tls.cert.length>0&&tls.cert.length<=65536);
  const sockets=new Set<Duplex>(),socketClosures=new Map<Duplex,Promise<void>>(),requests=new Set<Promise<void>>(),controllers=new Set<AbortController>();let stopped=false,serverFailed=false,serverClosed:Promise<void>|undefined;
  const origins=new Map([identity.origin,gatewayIdentity.origin].map(origin=>[new URL(origin).hostname,origin]));
  async function serve(incoming:IncomingMessage,outgoing:ServerResponse){
   const controller=new AbortController();controllers.add(controller);const abort=()=>controller.abort(),disconnect=()=>{if(!outgoing.writableFinished)abort();};incoming.on('aborted',abort);outgoing.on('close',disconnect);outgoing.on('error',abort);const timer=setTimeout(()=>{abort();incoming.destroy();outgoing.destroy();},35000);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
   try{
    const servername=(incoming.socket as TLSSocket).servername,hostHeader=incoming.headers.host;
    if(stopped||typeof servername!=='string'||!origins.has(servername)||hostHeader!==servername||incoming.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()==='host').length!==1||!incoming.url?.startsWith('/')||incoming.url.startsWith('//')||incoming.url.length>2048){increment('httpRejected');incoming.resume();outgoing.writeHead(421,{'content-type':'application/json','connection':'close'});outgoing.end('{"error":"Synthetic fixture request rejected."}');return;}
    const url=new URL(incoming.url,origins.get(servername));check(url.origin===origins.get(servername));const headers=new Headers();for(const [key,value]of Object.entries(incoming.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
    const maximum=identity.origin===url.origin?PREPARATION_SERVICE_MAX_JSON_BYTES:OUTPUT_MAX,length=headers.get('content-length');check(length===null||/^(0|[1-9]\d*)$/.test(length)&&Number(length)<=maximum);let consumed=0,finished=false;const iterator=incoming[Symbol.asyncIterator]();
    const body=['GET','HEAD'].includes(incoming.method??'GET')?undefined:new ReadableStream<Uint8Array>({async pull(c){try{const result=await iterator.next();if(controller.signal.aborted)throw Error();if(result.done){finished=true;c.close();return;}const bytes=Buffer.from(result.value);consumed+=bytes.length;check(consumed<=maximum);c.enqueue(bytes);}catch{controller.abort();c.error(Error('IMAGE_PREPARATION_FIXTURE_BODY_REJECTED'));}},async cancel(){if(!finished){incoming.destroy();await iterator.return?.();}}},{highWaterMark:0});
    const request=new Request(url,{method:incoming.method,headers,body,duplex:'half',signal:controller.signal} as RequestInit),response=await handle(request);check(!controller.signal.aborted);outgoing.statusCode=response.status;response.headers.forEach((value,key)=>outgoing.setHeader(key,value));outgoing.setHeader('connection','close');
    if(response.body){reader=response.body.getReader();for(;;){const part=await reader.read();if(controller.signal.aborted)throw Error();if(part.done)break;await new Promise<void>((res,rej)=>outgoing.write(part.value,error=>error?rej(error):res()));}}
    await new Promise<void>((res,rej)=>outgoing.end((error?:Error)=>error?rej(error):res()));
   }catch{increment('httpRejected');if(!outgoing.headersSent&&!outgoing.destroyed){outgoing.writeHead(503,{'content-type':'application/json','connection':'close'});outgoing.end('{"error":"Synthetic fixture request rejected."}');}else outgoing.destroy();}
   finally{try{await reader?.cancel();reader?.releaseLock();}catch{serverFailed=true;}clearTimeout(timer);incoming.off('aborted',abort);outgoing.off('close',disconnect);outgoing.off('error',abort);controllers.delete(controller);}
  }
  const server:Server=createServer({key:tls.key,cert:tls.cert,minVersion:'TLSv1.2'},(request,response)=>{const promise=serve(request,response);requests.add(promise);void promise.then(()=>requests.delete(promise),()=>{serverFailed=true;requests.delete(promise);});});server.maxConnections=16;server.maxHeadersCount=32;server.headersTimeout=10000;server.requestTimeout=35000;server.on('error',()=>{serverFailed=true;});
  server.on('connection',socket=>{sockets.add(socket);socketClosures.set(socket,new Promise(res=>socket.once('close',()=>{sockets.delete(socket);socketClosures.delete(socket);res();})));socket.on('error',()=>{});});server.on('tlsClientError',()=>{increment('httpRejected');});
  const close=()=>{if(stopped)return;stopped=true;serverClosed=new Promise<void>((res,rej)=>server.close(error=>error?rej(Error('IMAGE_PREPARATION_FIXTURE_SERVER_CLOSE_FAILED')):res()));for(const controller of controllers)controller.abort();for(const socket of sockets)socket.destroy();};
  const drain=async()=>{check(stopped);while(requests.size)await Promise.allSettled([...requests]);await serverClosed;await Promise.all([...socketClosures.values()]);check(sockets.size===0&&!serverFailed);};const owned={close,drain};servers.add(owned);
  try{await new Promise<void>((res,rej)=>{server.once('error',rej);server.listen(port,host,()=>{server.off('error',rej);res();});});}catch{close();await drain();servers.delete(owned);fail();}
  const address=server.address();check(address&&typeof address==='object'&&address.address===host);return {address:{host,port:address.port},close,drain};
 }
 return {handle,addSource,startServer,installSyntheticS3Fetch,
  setScenario(next:InstalledImagePreparationScenario){check(!closed&&scenarios.includes(next));scenario=next;},
  objects(){return {sources:[...sources.values()].map(v=>({...v,bytes:Buffer.from(v.bytes)})),outputs:[...outputs.values()].map(v=>({...v,bytes:Buffer.from(v.bytes)}))};},
  audit(){return {version:1,syntheticProvider:true,scenario,counts:{...counts},transportFailureStage,metadataOperations:{...metadataCounts},metadataResponses:structuredClone(metadataResponses),metadataResponseOverflow,sources:[...sources.values()].map(v=>({bytes:v.bytes.length,sha256:hash(v.bytes)})),outputs:[...outputs.values()].map(v=>({bytes:v.bytes.length,sha256:hash(v.bytes)})),unconfirmedUploads:[...uploads.values()].filter(v=>!v.completed).length,activeOperations:pending.size};},
  close(){closed=true;for(const controller of requestControllers)controller.abort();for(const server of servers)server.close();gateway.close();},
  async drain(){check(closed);let failed=drainFailed;for(const server of servers)try{await server.drain();}catch{failed=true;}while(pending.size)await Promise.allSettled([...pending]);try{await gateway.drain();}catch{failed=true;}if(failed){drainFailed=true;drained=false;throw Error('IMAGE_PREPARATION_INSTALLED_FIXTURE_DRAIN_FAILED');}drained=true;}
 };
}
