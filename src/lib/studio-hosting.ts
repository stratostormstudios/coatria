import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {query,transaction} from './db';
import {requireMembership,lockMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {bearer,body,fail,hashToken,id,json,rateLimit,secret} from './security';
import {PLUGIN_CATALOG} from './plugin-catalog';
import {pluginInstallInput} from './plugin-marketplace';
import {studioHostRegisterInput,studioHostEnrollInput,studioHostRevokeInput,studioHostCredentialsInput,STUDIO_HOST_LEASE_SECONDS,type StudioHost,type StudioHostBinding,type StudioHostCredentials,type StudioHostCredential} from './studio-hosting-protocol';

const hostColumns=`h.id,h.company_id AS "companyId",h.name,h.status,h.revision,h.max_agents AS "maxAgents",h.provider_ids AS "providerIds",h.expires_at AS "expiresAt",h.created_by AS "createdBy",h.created_at AS "createdAt",h.last_seen_at AS "lastSeenAt",h.lease_epoch AS "leaseEpoch",h.lease_expires_at AS "leaseExpiresAt"`;
const parse=<T>(schema:z.ZodType<T>,input:unknown)=>{const result=schema.safeParse(input);if(!result.success)fail(400,result.error.issues.map(issue=>issue.message).slice(0,3).join(' '),'VALIDATION_ERROR');return result.data;};
function canonical(value:unknown):string{if(value instanceof Date)return JSON.stringify(value.toISOString());return Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);}
const digest=(value:unknown)=>hashToken(canonical(value));
const plain=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

/** Append to every agent authority query, including checks inside transactions. */
export function managedAgentAuthoritySql(alias='a'){
 if(!/^[a-z][a-z0-9_]*$/.test(alias))throw new Error('Use a fixed SQL table alias.');
 return `(${alias}.managed_token_hash IS NULL OR ${alias}.managed_token_hash<>${alias}.token_hash OR EXISTS(SELECT 1 FROM studio_host_credentials hc JOIN studio_managed_hosts mh ON mh.company_id=hc.company_id AND mh.id=hc.host_id JOIN plugin_installations hi ON hi.company_id=hc.company_id AND hi.id=hc.installation_id AND hi.agent_id=hc.agent_id JOIN memberships hm ON hm.company_id=mh.company_id AND hm.user_id=mh.created_by JOIN memberships he ON he.company_id=hc.company_id AND he.user_id=hc.enrolled_by WHERE hc.company_id=${alias}.company_id AND hc.agent_id=${alias}.id AND hc.token_hash=${alias}.token_hash AND hc.revoked_at IS NULL AND hc.expires_at>clock_timestamp() AND mh.status='active' AND mh.expires_at>clock_timestamp() AND mh.lease_expires_at>clock_timestamp() AND mh.lease_epoch=hc.host_epoch AND hi.revision=hc.installation_revision AND hm.role IN ('owner','admin') AND he.role IN ('owner','admin')))`;
}
/** Merge these principals into the caller's sorted membership locks before its agent lock. */
export async function managedAgentAuthorityPrincipals(client:PoolClient,companyId:string,agentId:string):Promise<string[]>{
 // Rehosting uses the exclusive form before changing the binding. Keep its
 // principals stable until the caller's membership and agent checks commit.
 await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`studio-host-control:${companyId}`]);
 const rows=(await client.query('SELECT h.created_by,c.enrolled_by FROM agents a JOIN studio_host_credentials c ON c.company_id=a.company_id AND c.agent_id=a.id AND c.token_hash=a.token_hash JOIN studio_managed_hosts h ON h.company_id=c.company_id AND h.id=c.host_id WHERE a.company_id=$1 AND a.id=$2 AND a.managed_token_hash=a.token_hash',[companyId,agentId])).rows;
 return [...new Set(rows.flatMap(row=>[row.created_by,row.enrolled_by]))].sort();
}

const ringSchema=z.object({activeKeyId:z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),keys:z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),z.string().max(100))}).strict();
function keyring(){
 let parsed:unknown;try{parsed=JSON.parse(process.env.COATRIA_HOSTING_KEYRING||'');}catch{fail(503,'Managed credential encryption is not configured.','HOSTING_KEY_UNAVAILABLE');}
 const result=ringSchema.safeParse(parsed);if(!result.success||Object.keys(result.data.keys).length<1||Object.keys(result.data.keys).length>5)fail(503,'Managed credential encryption is unavailable.','HOSTING_KEY_UNAVAILABLE');
 const keys=new Map<string,Buffer>();for(const[keyId,value]of Object.entries(result.data.keys)){const key=Buffer.from(value,'base64');if(key.length!==32||key.toString('base64')!==value)fail(503,'Managed credential encryption is unavailable.','HOSTING_KEY_UNAVAILABLE');keys.set(keyId,key);}
 if(!keys.has(result.data.activeKeyId))fail(503,'Managed credential encryption is unavailable.','HOSTING_KEY_UNAVAILABLE');return {activeKeyId:result.data.activeKeyId,keys};
}
export function hostingEncryptionConfigured(){try{keyring();return true;}catch{return false;}}
type Aad={companyId:string;hostId:string;agentId:string;version:number;installationId:string;installationRevision:number;hostEpoch:number;configurationHash:string};
type Sealed={keyId:string;nonce:string;authTag:string;ciphertext:string};
export function sealHostedAgentToken(token:string,aad:Aad):Sealed{
 if(!/^ca_[A-Za-z0-9_-]{43}$/.test(token))throw new Error('Expected a generated agent credential.');
 const ring=keyring(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',ring.keys.get(ring.activeKeyId)!,nonce);cipher.setAAD(Buffer.from(canonical(aad)));
 const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
 return {keyId:ring.activeKeyId,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),authTag:cipher.getAuthTag().toString('base64')};
}
export function openHostedAgentToken(sealed:Sealed,aad:Aad){
 const key=keyring().keys.get(sealed.keyId);if(!key)fail(503,'An enrolled credential encryption key is unavailable.','HOSTING_KEY_UNAVAILABLE');
 try{const nonce=Buffer.from(sealed.nonce,'base64'),tag=Buffer.from(sealed.authTag,'base64');if(nonce.length!==12||tag.length!==16)throw Error();const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(Buffer.from(canonical(aad)));decipher.setAuthTag(tag);const token=Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext,'base64')),decipher.final()]).toString('utf8');if(!/^ca_[A-Za-z0-9_-]{43}$/.test(token))throw Error();return token;}catch{fail(503,'An enrolled credential failed its integrity check. Re-enroll it after administrator review.','HOST_CREDENTIAL_INTEGRITY');}
}
async function admin(client:PoolClient,companyId:string,userId:string){if(!(await client.query("SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",[companyId,userId])).rowCount)fail(403,'A host or agent administrator no longer has company access.','HOST_SPONSOR_UNAVAILABLE');}
async function hostProjection(client:PoolClient,companyId:string,hostId:string):Promise<StudioHost>{const h=(await client.query(`SELECT ${hostColumns},(SELECT count(*)::int FROM studio_host_credentials c WHERE c.company_id=h.company_id AND c.host_id=h.id AND c.revoked_at IS NULL) AS "bindingCount" FROM studio_managed_hosts h WHERE h.company_id=$1 AND h.id=$2`,[companyId,hostId])).rows[0];if(!h)fail(404,'Managed host not found.');return plain(h);}
async function hostRow(client:PoolClient,companyId:string,hostId:string){const h=(await client.query('SELECT * FROM studio_managed_hosts WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,hostId])).rows[0];if(!h)fail(404,'Managed host not found.');return h;}
function activeHost(h:Record<string,any>){if(h.status!=='active'||+new Date(h.expires_at)<=Date.now())fail(401,'This managed host is revoked or expired.','HOST_UNAVAILABLE');}
async function cancelRuns(client:PoolClient,companyId:string,agentIds:string[],reason:string){if(!agentIds.length)return;await client.query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error=$3 WHERE company_id=$1 AND agent_id=ANY($2::uuid[]) AND status IN ('queued','running')",[companyId,agentIds,reason]);}
async function configuration(client:PoolClient,companyId:string,installationId:string){
 const row=(await client.query(`SELECT p.id AS "installationId",p.revision,p.agent_id AS "agentId",p.plugin_id AS "pluginId",p.manifest_version AS "manifestVersion",p.runtime_config AS "runtimeConfig",p.character,a.name,a.status,a.created_by AS "agentSponsorId",a.capabilities,a.invocation_access AS "invocationAccess",a.conversation_access AS "conversationAccess",a.token_hash AS "tokenHash",a.expires_at AS "expiresAt" FROM plugin_installations p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2`,[companyId,installationId])).rows[0];if(!row)fail(404,'Choose a plugin installation in this company.');return plain(row);
}
function configData(row:Record<string,any>){return {installationId:row.installationId,pluginId:row.pluginId,manifestVersion:row.manifestVersion,runtimeConfig:row.runtimeConfig,character:row.character,name:row.name,agentSponsorId:row.agentSponsorId,capabilities:row.capabilities,invocationAccess:row.invocationAccess,conversationAccess:row.conversationAccess};}
function validateRuntime(row:Record<string,any>,h:Record<string,any>){
 const entry=PLUGIN_CATALOG.find(plugin=>plugin.id===row.pluginId&&plugin.version===row.manifestVersion);
 if(!entry||!['chat-completions','responses','anthropic-messages'].includes(entry.runtime))fail(409,'This pilot host supports curated HTTP provider adapters. CLI workers need a separately provisioned runtime.','HOST_RUNTIME_UNSUPPORTED');
 const normalized=parse(pluginInstallInput,{clientId:row.installationId,pluginId:row.pluginId,manifestVersion:row.manifestVersion,name:row.name,runtimeConfig:row.runtimeConfig,character:row.character,capabilities:row.capabilities,invocationAccess:row.invocationAccess});
 const provider=entry.providers.find(p=>p.id===normalized.runtimeConfig.providerId);
 if(!provider||!provider.allowCustomModel&&!provider.models.some(model=>model.id===normalized.runtimeConfig.modelId)||!h.provider_ids.includes(normalized.runtimeConfig.providerId)||normalized.capabilities.some(capability=>!entry.capabilities.includes(capability)))fail(409,'The installation provider, model or grants are not supported by this reviewed host.','HOST_RUNTIME_UNSUPPORTED');
 if(row.status==='revoked'||row.invocationAccess==='none')fail(409,'The installation is revoked or invocation is disabled. Review it in Plugins.','HOST_AGENT_UNAVAILABLE');
}
async function metadata(client:PoolClient,companyId:string,hostId:string):Promise<StudioHostBinding[]>{return plain((await client.query(`SELECT c.agent_id AS "agentId",c.installation_id AS "installationId",a.name,c.version AS "credentialVersion",c.installation_revision AS "installationRevision",c.expires_at AS "expiresAt",a.status,a.capabilities,c.enrolled_by AS "enrolledBy",CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN a.token_hash<>c.token_hash THEN 'credential_rotated' WHEN p.revision<>c.installation_revision THEN 'configuration_changed' WHEN a.status<>'active' THEN a.status WHEN c.expires_at<=clock_timestamp() THEN 'expired' ELSE 'enrolled' END AS "credentialState" FROM studio_host_credentials c JOIN agents a ON a.company_id=c.company_id AND a.id=c.agent_id JOIN plugin_installations p ON p.company_id=c.company_id AND p.id=c.installation_id WHERE c.company_id=$1 AND c.host_id=$2 ORDER BY a.name,c.agent_id`,[companyId,hostId])).rows);}
async function recordRequest(client:PoolClient,member:Membership,hostId:string,operation:string,clientId:string,requestHash:string,response:unknown){await client.query('INSERT INTO studio_host_requests(company_id,user_id,client_id,host_id,operation,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[member.companyId,member.userId,clientId,hostId,operation,requestHash,JSON.stringify(response)]);}
async function replayRequest(client:PoolClient,member:Membership,clientId:string,requestHash:string){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-host-request:${member.companyId}:${member.userId}:${clientId}`]);const old=(await client.query('SELECT request_hash,response FROM studio_host_requests WHERE company_id=$1 AND user_id=$2 AND client_id=$3',[member.companyId,member.userId,clientId])).rows[0];if(old&&old.request_hash!==requestHash)fail(409,'This host request ID was used for another action.','IDEMPOTENCY_CONFLICT');return old?.response;}
async function lockHostActors(client:PoolClient,companyId:string,hostId:string,extraAgentIds:string[]=[]){
 // Enrollment, rehosting, revocation and lease takeover share a short control
 // lock, keeping the binding set stable before we acquire sorted agent locks.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-host-control:${companyId}`]);
 const h=(await client.query('SELECT created_by FROM studio_managed_hosts WHERE company_id=$1 AND id=$2',[companyId,hostId])).rows[0];if(!h)fail(404,'Managed host not found.');
 const bound=(await client.query('SELECT agent_id,enrolled_by FROM studio_host_credentials WHERE company_id=$1 AND host_id=$2',[companyId,hostId])).rows;
 const agentIds=[...new Set([...extraAgentIds,...bound.map(b=>b.agent_id)])].sort(),sponsors=agentIds.length?(await client.query('SELECT created_by FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[])',[companyId,agentIds])).rows.map(a=>a.created_by):[];
 const memberIds=[...new Set([h.created_by,...bound.map(b=>b.enrolled_by),...sponsors])].sort();await client.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[companyId,memberIds]);
 if(agentIds.length)await client.query('SELECT id FROM agents WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[companyId,agentIds]);
 return h;
}
async function saveCredential(client:PoolClient,h:Record<string,any>,row:Record<string,any>,enrolledBy:string,version:number,epoch:number){
 const token=secret('ca_'),tokenHash=hashToken(token),nextRevision=row.revision+1,configuration=configData(row),configurationHash=digest(configuration);
 const aad={companyId:h.company_id,hostId:h.id,agentId:row.agentId,version,installationId:row.installationId,installationRevision:nextRevision,hostEpoch:epoch,configurationHash},sealed=sealHostedAgentToken(token,aad);
 await client.query("UPDATE agents SET token_hash=$3,managed_token_hash=$3,status='active',expires_at=$4 WHERE company_id=$1 AND id=$2",[h.company_id,row.agentId,tokenHash,h.expires_at]);
 await client.query('UPDATE plugin_installations SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[h.company_id,row.installationId]);
 await client.query(`INSERT INTO studio_host_credentials(company_id,agent_id,host_id,installation_id,version,installation_revision,host_epoch,token_hash,key_id,nonce,auth_tag,ciphertext,configuration,configuration_hash,enrolled_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(company_id,agent_id) DO UPDATE SET host_id=EXCLUDED.host_id,installation_id=EXCLUDED.installation_id,version=EXCLUDED.version,installation_revision=EXCLUDED.installation_revision,host_epoch=EXCLUDED.host_epoch,token_hash=EXCLUDED.token_hash,key_id=EXCLUDED.key_id,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,ciphertext=EXCLUDED.ciphertext,configuration=EXCLUDED.configuration,configuration_hash=EXCLUDED.configuration_hash,enrolled_by=EXCLUDED.enrolled_by,expires_at=EXCLUDED.expires_at,revoked_at=NULL,updated_at=clock_timestamp()`,[h.company_id,row.agentId,h.id,row.installationId,version,nextRevision,epoch,tokenHash,sealed.keyId,sealed.nonce,sealed.authTag,sealed.ciphertext,JSON.stringify(configuration),configurationHash,enrolledBy,h.expires_at]);
 return {token,version,installationRevision:nextRevision};
}

export async function registerStudioHost(client:PoolClient,member:Membership,input:unknown){
 await lockMembership(client,member,true);const data=parse(studioHostRegisterInput,input),hash=digest(data);keyring();
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-host-register:${member.companyId}`]);
 const old=(await client.query('SELECT id,request_hash FROM studio_managed_hosts WHERE company_id=$1 AND created_by=$2 AND client_id=$3',[member.companyId,member.userId,data.clientId])).rows[0];
 if(old){if(old.request_hash!==hash)fail(409,'This host registration ID belongs to another configuration.','IDEMPOTENCY_CONFLICT');return {host:await hostProjection(client,member.companyId,old.id),hostToken:null,replayed:true};}
 const lifetime=Date.parse(data.expiresAt)-Date.now();if(lifetime<60_000||lifetime>24*60*60*1000)fail(400,'Choose an absolute host expiry from one minute to 24 hours from now.','HOST_EXPIRY_INVALID');
 if(Number((await client.query("SELECT count(*) FROM studio_managed_hosts WHERE company_id=$1 AND status='active' AND expires_at>clock_timestamp()",[member.companyId])).rows[0].count)>=3)fail(409,'This pilot company can have three active managed hosts.','HOST_LIMIT_REACHED');
 const token=secret('ch_'),h=(await client.query('INSERT INTO studio_managed_hosts(company_id,created_by,client_id,request_hash,token_hash,name,max_agents,provider_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[member.companyId,member.userId,data.clientId,hash,hashToken(token),data.name,data.maxAgents,JSON.stringify(data.providerIds),data.expiresAt])).rows[0];
 await client.query("INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,'studio.host_registered','An administrator registered a bounded managed host identity; no compute was provisioned.')",[member.companyId,member.userId]);return {host:await hostProjection(client,member.companyId,h.id),hostToken:token,replayed:false};
}
export async function enrollStudioHost(client:PoolClient,member:Membership,hostId:string,input:unknown){
 id(hostId);await lockMembership(client,member,true);const data=parse(studioHostEnrollInput,input),hash=digest({hostId,operation:'enroll',...data}),replay=await replayRequest(client,member,data.clientId,hash);if(replay)return {...replay,replayed:true};keyring();
 const ids=data.installations.map(i=>i.installationId),previews=(await client.query('SELECT agent_id FROM plugin_installations WHERE company_id=$1 AND id=ANY($2::uuid[])',[member.companyId,ids])).rows;if(previews.length!==ids.length)fail(404,'Choose plugin installations in this company.');
 await lockHostActors(client,member.companyId,hostId,previews.map(p=>p.agent_id));const h=await hostRow(client,member.companyId,hostId);activeHost(h);await admin(client,member.companyId,h.created_by);if(h.revision!==data.revision)fail(409,'The reviewed host changed. Reload before enrollment.','HOST_REVISION_CONFLICT');
 const bound=(await client.query('SELECT c.agent_id FROM studio_host_credentials c JOIN agents a ON a.company_id=c.company_id AND a.id=c.agent_id AND a.token_hash=c.token_hash WHERE c.company_id=$1 AND c.host_id=$2 AND c.revoked_at IS NULL',[member.companyId,hostId])).rows.map(c=>c.agent_id);
 if(new Set([...bound,...previews.map(p=>p.agent_id)]).size>h.max_agents)fail(409,'This enrollment exceeds the reviewed host capacity.','HOST_CAPACITY_EXCEEDED');
 const prepared=[];for(const selected of data.installations){const row=await configuration(client,member.companyId,selected.installationId);if(row.revision!==selected.revision)fail(409,'An installation changed. Review its current configuration before enrollment.','HOST_INSTALLATION_CHANGED');await admin(client,member.companyId,row.agentSponsorId);validateRuntime(row,h);prepared.push(row);}
 for(const row of prepared){const old=(await client.query('SELECT version FROM studio_host_credentials WHERE company_id=$1 AND agent_id=$2 FOR UPDATE',[member.companyId,row.agentId])).rows[0];await saveCredential(client,h,row,member.userId,(old?.version??0)+1,h.lease_epoch);}
 await cancelRuns(client,member.companyId,prepared.map(row=>row.agentId),'Agent enrolled on a reviewed managed host; previous credentials rotated.');
 await client.query('UPDATE studio_managed_hosts SET revision=revision+1 WHERE company_id=$1 AND id=$2',[member.companyId,hostId]);
 const result={host:await hostProjection(client,member.companyId,hostId),bindings:await metadata(client,member.companyId,hostId),startsWorkers:false,startsInference:false};await recordRequest(client,member,hostId,'enroll',data.clientId,hash,result);
 await client.query("INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,'studio.host_enrolled',$3)",[member.companyId,member.userId,`${prepared.length} reviewed plugin identities were activated and enrolled with encrypted credentials; no compute was provisioned.`]);return {...result,replayed:false};
}
export async function revokeStudioHost(client:PoolClient,member:Membership,hostId:string,input:unknown){
 id(hostId);await lockMembership(client,member,true);const data=parse(studioHostRevokeInput,input),hash=digest({hostId,operation:'revoke',...data}),replay=await replayRequest(client,member,data.clientId,hash);if(replay)return {...replay,replayed:true};
 await lockHostActors(client,member.companyId,hostId);const h=await hostRow(client,member.companyId,hostId);if(h.revision!==data.revision)fail(409,'The host changed. Reload before revoking it.','HOST_REVISION_CONFLICT');
 const current=(await client.query('SELECT c.agent_id,c.installation_id FROM studio_host_credentials c JOIN agents a ON a.company_id=c.company_id AND a.id=c.agent_id AND a.token_hash=c.token_hash WHERE c.company_id=$1 AND c.host_id=$2 AND c.revoked_at IS NULL FOR UPDATE OF c',[member.companyId,hostId])).rows;
 for(const c of current){await client.query("UPDATE agents SET token_hash=$3,status='paused',expires_at=LEAST(expires_at,clock_timestamp()) WHERE company_id=$1 AND id=$2",[member.companyId,c.agent_id,hashToken(secret('ca_'))]);await client.query('UPDATE plugin_installations SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[member.companyId,c.installation_id]);}
 await cancelRuns(client,member.companyId,current.map(c=>c.agent_id),'Managed host revoked by an administrator.');await client.query('UPDATE studio_host_credentials SET revoked_at=clock_timestamp() WHERE company_id=$1 AND host_id=$2',[member.companyId,hostId]);
 await client.query("UPDATE studio_managed_hosts SET status='revoked',revision=revision+1,revoked_at=clock_timestamp(),lease_epoch=lease_epoch+1,lease_owner=NULL,lease_expires_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[member.companyId,hostId]);
 const result={host:await hostProjection(client,member.companyId,hostId),invalidatedAgentCount:current.length};await recordRequest(client,member,hostId,'revoke',data.clientId,hash,result);await client.query("INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,'studio.host_revoked','A managed host was revoked; matching issued agent credentials and active requests were invalidated.')",[member.companyId,member.userId]);return {...result,replayed:false};
}
async function authenticateHost(request:Request){const token=bearer(request);if(!/^ch_[A-Za-z0-9_-]{43}$/.test(token))fail(401,'A scoped host credential is required.','HOST_UNAVAILABLE');const h=(await query("SELECT h.* FROM studio_managed_hosts h JOIN memberships m ON m.company_id=h.company_id AND m.user_id=h.created_by WHERE h.token_hash=$1 AND h.status='active' AND h.expires_at>clock_timestamp() AND m.role IN ('owner','admin')",[hashToken(token)])).rows[0];if(!h)fail(401,'This host credential is invalid, expired, revoked, or its sponsor lost access.','HOST_UNAVAILABLE');await rateLimit(`studio-host:${h.id}`,120,60);return h;}
async function credentialRows(client:PoolClient,h:Record<string,any>){return (await client.query('SELECT * FROM studio_host_credentials WHERE company_id=$1 AND host_id=$2 AND revoked_at IS NULL ORDER BY agent_id FOR UPDATE',[h.company_id,h.id])).rows;}
async function credentialValid(client:PoolClient,h:Record<string,any>,c:Record<string,any>,row:Record<string,any>){
 if(c.token_hash!==row.tokenHash)return 'credential_rotated';if(row.revision!==c.installation_revision||digest(configData(row))!==c.configuration_hash)return 'configuration_changed';if(row.status!=='active')return row.status;if(+new Date(row.expiresAt)<=Date.now()||+new Date(c.expires_at)<=Date.now())return 'expired';
 const count=(await client.query("SELECT count(*)::int count FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) AND role IN ('owner','admin')",[h.company_id,[...new Set([c.enrolled_by,row.agentSponsorId])]])).rows[0].count;
 if(count!==new Set([c.enrolled_by,row.agentSponsorId]).size)return 'sponsor_unavailable';try{validateRuntime(row,h);}catch{return 'runtime_unavailable';}return null;
}
export async function readStudioHostCredentials(request:Request,input:unknown):Promise<StudioHostCredentials>{
 const identity=await authenticateHost(request),data=parse(studioHostCredentialsInput,input);keyring();
 return transaction(async client=>{
  await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[identity.company_id]);await lockHostActors(client,identity.company_id,identity.id);const h=await hostRow(client,identity.company_id,identity.id);activeHost(h);if(h.token_hash!==identity.token_hash)fail(401,'Host credential rotated.','HOST_UNAVAILABLE');await admin(client,h.company_id,h.created_by);
  const live=h.lease_expires_at&&+new Date(h.lease_expires_at)>Date.now();if(live&&h.lease_owner!==data.supervisorId)fail(409,'Another supervisor owns this host lease.','HOST_LEASE_HELD');if(live&&data.leaseEpoch!==undefined&&data.leaseEpoch!==h.lease_epoch)fail(409,'The supervisor lease epoch changed.','HOST_LEASE_LOST');
  const epoch=live?h.lease_epoch:h.lease_epoch+1,rows=await credentialRows(client,h),credentials:StudioHostCredential[]=[],unavailable:Array<{agentId:string;reason:string}>=[],rotated:string[]=[];
  for(const c of rows){const row=await configuration(client,h.company_id,c.installation_id),reason=await credentialValid(client,h,c,row);if(reason){unavailable.push({agentId:c.agent_id,reason});continue;}
   if(digest(c.configuration)!==c.configuration_hash)fail(503,'Enrolled configuration failed its integrity check.','HOST_CREDENTIAL_INTEGRITY');
   const aad={companyId:h.company_id,hostId:h.id,agentId:c.agent_id,version:c.version,installationId:c.installation_id,installationRevision:c.installation_revision,hostEpoch:c.host_epoch,configurationHash:c.configuration_hash};
   let token=openHostedAgentToken({keyId:c.key_id,nonce:c.nonce,authTag:c.auth_tag,ciphertext:c.ciphertext},aad),version=c.version,installationRevision=c.installation_revision;if(hashToken(token)!==c.token_hash)fail(503,'Enrolled credential failed its integrity check.','HOST_CREDENTIAL_INTEGRITY');
   if(c.host_epoch!==epoch){const next=await saveCredential(client,h,row,c.enrolled_by,c.version+1,epoch);token=next.token;version=next.version;installationRevision=next.installationRevision;rotated.push(c.agent_id);}
   credentials.push({agentId:c.agent_id,installationId:c.installation_id,name:row.name,credentialVersion:version,installationRevision,agentToken:token,expiresAt:new Date(h.expires_at).toISOString(),capabilities:row.capabilities,runtime:{pluginId:row.pluginId,manifestVersion:row.manifestVersion,runtimeConfig:row.runtimeConfig,character:row.character}});
  }
  await cancelRuns(client,h.company_id,rotated,'Managed host supervisor lease changed; old credentials were fenced.');
  const lease=(await client.query("UPDATE studio_managed_hosts SET lease_owner=$3,lease_epoch=$4,lease_expires_at=LEAST(expires_at,clock_timestamp()+$5*interval '1 second'),last_seen_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING lease_expires_at",[h.company_id,h.id,data.supervisorId,epoch,STUDIO_HOST_LEASE_SECONDS])).rows[0];
  return {host:await hostProjection(client,h.company_id,h.id),supervisor:{id:data.supervisorId,epoch,expiresAt:new Date(lease.lease_expires_at).toISOString()},credentials,unavailable,pollAfterSeconds:20};
 });
}

export async function studioHostingRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts.join('/')==='host/identity'&&method==='GET'){const h=await authenticateHost(request);return json(await transaction(async client=>({host:await hostProjection(client,h.company_id,h.id),serverTime:new Date().toISOString()})));}
 if(parts.join('/')==='host/credentials'&&method==='POST')return json(await readStudioHostCredentials(request,await body(request,studioHostCredentialsInput,2000)));
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='hosts'||parts.length<4||parts.length>6)return null;
 const member=await requireMembership(request,id(parts[1]),true);
 if(parts.length===4&&method==='GET')return json(await memberMutation(member,true,async client=>({hosts:plain((await client.query(`SELECT ${hostColumns},(SELECT count(*)::int FROM studio_host_credentials c WHERE c.company_id=h.company_id AND c.host_id=h.id AND c.revoked_at IS NULL) AS "bindingCount" FROM studio_managed_hosts h WHERE h.company_id=$1 ORDER BY h.created_at DESC LIMIT 50`,[member.companyId])).rows),encryptionConfigured:hostingEncryptionConfigured()})));
 if(parts.length===5&&method==='GET')return json(await memberMutation(member,true,async client=>({host:await hostProjection(client,member.companyId,id(parts[4])),bindings:await metadata(client,member.companyId,parts[4])})));
 if(parts.length===4&&method==='POST'){await rateLimit(`host-register:${member.userId}`,20,3600);const input=await body(request,studioHostRegisterInput,3000),result=await memberMutation(member,true,client=>registerStudioHost(client,member,input));return json(result,result.replayed?200:201);}
 if(parts.length===6&&parts[5]==='enroll'&&method==='POST'){await rateLimit(`host-enroll:${member.userId}`,40,3600);const input=await body(request,studioHostEnrollInput,6000),result=await memberMutation(member,true,client=>enrollStudioHost(client,member,id(parts[4]),input));return json(result,result.replayed?200:201);}
 if(parts.length===6&&parts[5]==='revoke'&&method==='POST'){const input=await body(request,studioHostRevokeInput,2000),result=await memberMutation(member,true,client=>revokeStudioHost(client,member,id(parts[4]),input));return json(result,result.replayed?200:201);}
 return null;
}
