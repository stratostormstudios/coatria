/** Server-only scoped executor vault. Never serialize a resolved credential. */
import {createCipheriv,createDecipheriv,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Membership} from './auth';
import {fail,hashToken,id} from './security';
import {loadCompanyRuntimeConfiguration,lockCompanyRuntimeControl,requirePlatformRuntimeOperator,requestCompanyRuntimeStop} from './company-runtime-config';
import {parseRemoteArchiveConfiguration} from './higgsfield-remote-archive-config';
import {trustedServiceHash,type TrustedServicePreset} from './company-runtime-preset';
import {z} from 'zod';

type Settings=Readonly<Record<string,string|undefined>>;
type Envelope={keyId:string;nonce:string;tag:string;ciphertext:string};
export const executorCredentialInput=z.object({clientId:z.uuid(),expectedCredentialId:z.uuid().nullable(),token:z.string().min(100).max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)}).strict();
function unavailable():never{return fail(503,'The scoped executor credential is unavailable.','EXECUTOR_CREDENTIAL_UNAVAILABLE');}
function invalid():never{return fail(400,'Use a valid Vercel OIDC token for this reviewed project and deadline.','EXECUTOR_CREDENTIAL_INVALID');}
function keyring(settings:Settings){
 try{const raw=JSON.parse(settings.COATRIA_HOSTING_KEYRING||''),keys=new Map<string,Buffer>();if(!/^[\w-]{1,40}$/.test(raw.activeKeyId)||!raw.keys||Object.keys(raw.keys).length>5)throw Error();for(const[k,v]of Object.entries(raw.keys)){if(!/^[\w-]{1,40}$/.test(k)||typeof v!=='string')throw Error();const bytes=Buffer.from(v,'base64');if(bytes.length!==32||bytes.toString('base64')!==v)throw Error();keys.set(k,bytes);}if(!keys.has(raw.activeKeyId))throw Error();return {id:raw.activeKeyId as string,keys};}catch{unavailable();}
}
const aad=(companyId:string,configurationId:string,credentialId:string,expiresAt:string)=>Buffer.from(JSON.stringify(['coatria:archive-executor:v1',companyId,configurationId,credentialId,expiresAt]));
function seal(token:string,context:Buffer,settings:Settings):Envelope{const ring=keyring(settings),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',ring.keys.get(ring.id)!,nonce);cipher.setAAD(context);const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return {keyId:ring.id,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};}
function open(value:Envelope,context:Buffer,settings:Settings){try{const key=keyring(settings).keys.get(value.keyId),nonce=Buffer.from(value.nonce,'base64'),tag=Buffer.from(value.tag,'base64');if(!key||nonce.length!==12||tag.length!==16||value.ciphertext.length>6000)throw Error();const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(context);decipher.setAuthTag(tag);const token=Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]).toString('utf8');if(!executorCredentialInput.shape.token.safeParse(token).success)throw Error();return token;}catch{unavailable();}}

/** Verify signature at Vercel's fixed HTTPS origin, then project/team/time claims.
 * No token, bearer header or caller-controlled host is sent to the key endpoint. */
export async function verifyArchiveExecutorToken(token:string,preset:TrustedServicePreset,options:{fetch?:typeof fetch;now?:number}={}){
 try{
  if(!executorCredentialInput.shape.token.safeParse(token).success||preset.service!=='archive')invalid();
  const parts=token.split('.'),header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  const binding=parseRemoteArchiveConfiguration(preset.configuration).policy.binding,slug=/^[a-z0-9][a-z0-9-]{0,99}$/;
  if(header.alg!=='RS256'||header.typ!=='JWT'||typeof header.kid!=='string'||header.kid.length>200||header.crit!==undefined||!slug.test(claims.owner)||typeof claims.project!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(claims.project)||!['development','preview','production'].includes(claims.environment))invalid();
  const issuer='https://oidc.vercel.com'+(claims.iss==='https://oidc.vercel.com'?'':'/'+claims.owner);
  if(claims.iss!==issuer||claims.aud!=='https://vercel.com/'+claims.owner||claims.sub!==`owner:${claims.owner}:project:${claims.project}:environment:${claims.environment}`||claims.owner_id!==binding.teamId||claims.project_id!==binding.projectId)invalid();
  const now=options.now??Date.now();if(!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat)||claims.iat*1000>now+30000||claims.iat>=claims.exp||claims.exp*1000<Date.parse(preset.expiresAt)+60000||claims.exp*1000<=now+60000||claims.exp*1000>now+86400000||claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf*1000>now+30000))invalid();
  const response=await(options.fetch??fetch)(issuer+'/.well-known/jwks',{redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'},cache:'no-store'});
  if(!response.ok||Number(response.headers.get('content-length')||0)>65536||!response.body)invalid();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>65536)invalid();chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const keys=JSON.parse(Buffer.concat(chunks).toString('utf8')).keys;if(!Array.isArray(keys)||keys.length>50)invalid();
  const matches=keys.filter((key:Record<string,any>)=>key&&key.kid===header.kid&&key.kty==='RSA'&&(!key.alg||key.alg==='RS256')&&(!key.use||key.use==='sig')&&(!key.key_ops||Array.isArray(key.key_ops)&&key.key_ops.includes('verify')));if(matches.length!==1)invalid();
  const key=createPublicKey({key:matches[0],format:'jwk'});if((key.asymmetricKeyDetails?.modulusLength??0)<2048||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))invalid();
  return {expiresAt:new Date(claims.exp*1000).toISOString()};
 }catch{invalid();}
}
const iso=(value:Date|string)=>new Date(value).toISOString();
const summary=(row:any)=>row?{id:row.id,configurationId:row.configuration_id,expiresAt:iso(row.expires_at),createdAt:iso(row.created_at),revokedAt:row.revoked_at?iso(row.revoked_at):null}:null;
async function policy(db:PoolClient,companyId:string,configurationId:string){const selected=await loadCompanyRuntimeConfiguration(db,companyId,'archive');if(!selected?.enabled||selected.configurationId!==configurationId)unavailable();return selected.preset as TrustedServicePreset;}
async function authority(db:PoolClient,member:Membership){await lockCompanyRuntimeControl(db,member.companyId,'archive');await requirePlatformRuntimeOperator(db,member);}
export async function getArchiveExecutorCredential(db:PoolClient,member:Membership,configurationId:string){id(configurationId);await authority(db,member);return {credential:summary((await db.query('SELECT id,configuration_id,expires_at,created_at,revoked_at FROM company_runtime_executor_credentials WHERE company_id=$1 AND configuration_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[member.companyId,configurationId])).rows[0])};}
export async function saveArchiveExecutorCredential(db:PoolClient,member:Membership,configurationId:string,input:unknown,options:{fetch?:typeof fetch;settings?:Settings}={}){
 id(configurationId);const parsed=executorCredentialInput.safeParse(input);if(!parsed.success)invalid();const data=parsed.data,requestHash=trustedServiceHash({configurationId,clientId:data.clientId,expectedCredentialId:data.expectedCredentialId,tokenHash:hashToken(data.token)});await authority(db,member);
 const old=(await db.query('SELECT * FROM company_runtime_executor_credentials WHERE company_id=$1 AND configuration_id=$2 AND client_id=$3',[member.companyId,configurationId,data.clientId])).rows[0];
 if(old){if(old.created_by!==member.userId||old.request_hash!==requestHash)fail(409,'This request ID was used for another credential.','IDEMPOTENCY_CONFLICT');return {credential:summary(old),replayed:true};}
 const preset=await policy(db,member.companyId,configurationId);
 if((await db.query("SELECT id FROM trusted_service_provisions WHERE company_id=$1 AND service='archive' AND phase=ANY($2::text[]) LIMIT 1",[member.companyId,['approved','submitting','uncertain','provisioning','running','stopping','needs_attention']])).rowCount)fail(409,'Stop and reconcile archive services before changing their executor credential.','RUNTIME_PROVISION_ACTIVE');
 const active=(await db.query('SELECT id FROM company_runtime_executor_credentials WHERE company_id=$1 AND configuration_id=$2 AND revoked_at IS NULL',[member.companyId,configurationId])).rows[0];if((active?.id??null)!==data.expectedCredentialId)fail(409,'The executor credential changed. Refresh its metadata.','EXECUTOR_CREDENTIAL_CONFLICT');
 const verificationNow=+new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);
 const verified=await verifyArchiveExecutorToken(data.token,preset,{fetch:options.fetch,now:verificationNow}),credentialId=randomUUID();await requirePlatformRuntimeOperator(db,member);await policy(db,member.companyId,configurationId);
 const now=+new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);if(Date.parse(verified.expiresAt)<=now+60000)invalid();
 const sealed=seal(data.token,aad(member.companyId,configurationId,credentialId,verified.expiresAt),options.settings??process.env);
 if(active)await db.query('UPDATE company_runtime_executor_credentials SET revoked_at=clock_timestamp(),revoked_by=$3 WHERE company_id=$1 AND id=$2 AND revoked_at IS NULL',[member.companyId,active.id,member.userId]);
 const row=(await db.query('INSERT INTO company_runtime_executor_credentials(id,company_id,configuration_id,client_id,token_hash,sealed,expires_at,created_by,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,configuration_id,expires_at,created_at,revoked_at',[credentialId,member.companyId,configurationId,data.clientId,hashToken(data.token),JSON.stringify(sealed),verified.expiresAt,member.userId,requestHash])).rows[0];return {credential:summary(row),replayed:false};
}
export async function revokeArchiveExecutorCredential(db:PoolClient,member:Membership,configurationId:string,credentialId:string){
 id(configurationId);id(credentialId);await authority(db,member);const row=(await db.query('SELECT id FROM company_runtime_executor_credentials WHERE company_id=$1 AND configuration_id=$2 AND id=$3',[member.companyId,configurationId,credentialId])).rows[0];if(!row)fail(404,'Executor credential not found.');
 const changed=await db.query('UPDATE company_runtime_executor_credentials SET revoked_at=clock_timestamp(),revoked_by=$4 WHERE company_id=$1 AND configuration_id=$2 AND id=$3 AND revoked_at IS NULL',[member.companyId,configurationId,credentialId,member.userId]);
 // Replaying an old revocation must not stop a later replacement credential.
 if(changed.rowCount)await requestCompanyRuntimeStop(db,member.companyId,'archive',configurationId);
 return {revoked:true};
}
export async function resolveCompanyArchiveExecutor(db:PoolClient,companyId:string,configurationId:string,preset:TrustedServicePreset,settings:Settings=process.env){
 const current=await policy(db,companyId,configurationId);if(trustedServiceHash(current)!==trustedServiceHash(preset))unavailable();
 const row=(await db.query('SELECT * FROM company_runtime_executor_credentials WHERE company_id=$1 AND configuration_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()+interval \'1 minute\' FOR SHARE',[companyId,configurationId])).rows[0];if(!row||+new Date(row.expires_at)<Date.parse(preset.expiresAt)+60000)unavailable();
 const now=+new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);if(+new Date(row.expires_at)<=now+60000||Date.parse(preset.expiresAt)<=now)unavailable();
 const expiresAt=iso(row.expires_at),token=open(row.sealed,aad(companyId,configurationId,row.id,expiresAt),settings);if(hashToken(token)!==row.token_hash)unavailable();return {token,expiresAt};
}
