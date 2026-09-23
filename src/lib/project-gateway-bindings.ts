/** Server-only project routing. Provider addresses are derived, never supplied. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {lockMembership,type Membership} from './auth';
import {fail,id} from './security';
import {storageGatewayOrigin} from './project-storage-config';
import {parseTrustedServiceGatewayConfiguration,trustedServiceHash} from './trusted-service-config';
import {boundedGatewayJson,createGatewayChallenge,verifyGatewayAnswer,type GatewayIdentity} from './project-gateway-identity';
type Row=Record<string,any>;
export type VerifiedProjectGateway={origin:string;expiresAt:string;bindingId:string;provisionId:string;configurationHash:string};
export const verifyProjectGatewayInput=z.object({provisionId:z.uuid(),expectedBindingId:z.uuid().nullable()}).strict();
export const revokeProjectGatewayInput=z.object({bindingId:z.uuid()}).strict();
const unavailable=():never=>fail(503,'A verified live gateway is required for this project.','STORAGE_GATEWAY_UNAVAILABLE');
const control=(db:PoolClient,companyId:string,projectId:string)=>db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`project-gateway:${companyId}:${projectId}`]);
export function projectGatewayServiceIdentity(row:Row,projectId:string,now:number):{origin:string;identity:GatewayIdentity}|null{
 try{
  const preset=row.preset,config=parseTrustedServiceGatewayConfiguration(preset.configuration);
  if(row.service!=='gateway'||row.phase!=='running'||row.provider_status!=='RUNNING'||row.stop_requested_at||!row.pod_id||!/^[a-z0-9-]{1,100}$/.test(row.pod_id)||+new Date(row.expires_at)<=now||!row.last_reconciled_at||+new Date(row.last_reconciled_at)<now-120000||preset.service!=='gateway'||preset.companyId!==row.company_id||config.companyId!==row.company_id||!preset.projectIds.includes(projectId)||!config.projectIds.includes(projectId)||config.sourceCommit!==preset.releaseCommit||config.expiresAt!==preset.expiresAt||Date.parse(config.expiresAt)!==+new Date(row.expires_at)||trustedServiceHash(config)!==preset.configurationHash||trustedServiceHash(row.plan)!==row.plan_hash||trustedServiceHash(preset)!==row.plan?.preset?.hash)return null;
  return {origin:`https://${row.pod_id}-4190.proxy.runpod.net`,identity:{version:1,companyId:row.company_id,projectIds:config.projectIds,provisionId:row.id,configurationHash:preset.configurationHash,sourceCommit:config.sourceCommit,expiresAt:config.expiresAt}};
 }catch{return null;}
}
const serviceColumns='p.id,p.company_id,p.service,p.phase,p.provider_status,p.stop_requested_at,p.pod_id,p.expires_at,p.last_reconciled_at,p.preset,p.plan,p.plan_hash';
const runtimeColumns='s.configuration_id AS selection_id,s.revision AS selection_revision,s.state AS selection_state,c.configuration_hash AS selection_hash,c.expires_at AS selection_expires_at';
const runtimeJoins="LEFT JOIN company_runtime_selections s ON s.company_id=p.company_id AND s.kind='gateway' LEFT JOIN company_runtime_configurations c ON c.company_id=s.company_id AND c.kind=s.kind AND c.id=s.configuration_id";
function runtimeCurrent(row:Row){const pin=row.plan?.runtimeConfiguration;if(!pin)return !row.selection_id;return row.selection_id===pin.configurationId&&row.selection_revision===pin.selectionRevision&&row.selection_state==='active'&&row.selection_hash===pin.configurationHash&&+new Date(row.selection_expires_at)===Date.parse(pin.expiresAt)&&+new Date(row.selection_expires_at)>+new Date(row.now);}
async function service(db:PoolClient,companyId:string,provisionId:string,projectId:string){
 const row=(await db.query(`SELECT ${serviceColumns},${runtimeColumns},clock_timestamp() AS now FROM trusted_service_provisions p ${runtimeJoins} WHERE p.company_id=$1 AND p.id=$2 AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=p.company_id AND m.user_id=p.created_by AND m.role IN ('owner','admin'))`,[companyId,provisionId])).rows[0];
 return row&&runtimeCurrent(row)?projectGatewayServiceIdentity(row,projectId,+new Date(row.now)):null;
}
/** Returns only managed, live, verified bindings. It never invokes legacy fallback. */
export async function verifiedProjectGateway(db:PoolClient,companyId:string,projectId:string):Promise<VerifiedProjectGateway|null>{
 const binding=(await db.query("SELECT b.id,b.provision_id,b.configuration_hash,b.origin,b.expires_at FROM project_gateway_bindings b WHERE b.company_id=$1 AND b.project_id=$2 AND b.revoked_at IS NULL AND b.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=b.company_id AND m.user_id=b.verified_by AND m.role IN ('owner','admin'))",[companyId,projectId])).rows[0];if(!binding)return null;
 const active=await service(db,companyId,binding.provision_id,projectId);if(!active||active.origin!==binding.origin||active.identity.configurationHash!==binding.configuration_hash)return null;
 return {origin:binding.origin,expiresAt:new Date(Math.min(+new Date(binding.expires_at),Date.parse(active.identity.expiresAt))).toISOString(),bindingId:binding.id,provisionId:binding.provision_id,configurationHash:binding.configuration_hash};
}
/** CSP callers receive only origins reachable by this authenticated principal. */
export async function verifiedGatewayOriginsForUser(db:PoolClient,userId:string):Promise<string[]>{
 const rows=(await db.query(`SELECT DISTINCT ON (p.id) ${serviceColumns},${runtimeColumns},b.project_id,b.origin,b.configuration_hash,clock_timestamp() AS now FROM project_gateway_bindings b JOIN trusted_service_provisions p ON p.company_id=b.company_id AND p.id=b.provision_id ${runtimeJoins}
 WHERE b.revoked_at IS NULL AND b.expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=b.company_id AND m.user_id=b.verified_by AND m.role IN ('owner','admin'))
 AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=p.company_id AND m.user_id=p.created_by AND m.role IN ('owner','admin'))
 AND (EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=b.company_id AND m.user_id=$1 AND m.role<>'removed') OR EXISTS(SELECT 1 FROM studio_client_deliveries d WHERE d.company_id=b.company_id AND d.project_id=b.project_id AND d.recipient_user_id=$1 AND d.status='active' AND d.expires_at>clock_timestamp())) ORDER BY p.id,b.project_id LIMIT 101`,[userId])).rows;
 if(rows.length>100)fail(503,'Too many active gateway origins for one browser policy.','GATEWAY_ORIGIN_LIMIT');
 const origins=new Set<string>();for(const row of rows){const gateway=runtimeCurrent(row)?projectGatewayServiceIdentity(row,row.project_id,+new Date(row.now)):null;if(gateway&&gateway.origin===row.origin&&gateway.identity.configurationHash===row.configuration_hash)origins.add(gateway.origin);}
 const legacy=storageGatewayOrigin();if(legacy&&(await db.query(`SELECT 1 FROM studio_projects p WHERE
 (EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=p.company_id AND m.user_id=$1 AND m.role<>'removed') OR EXISTS(SELECT 1 FROM studio_client_deliveries d WHERE d.company_id=p.company_id AND d.project_id=p.id AND d.recipient_user_id=$1 AND d.status='active' AND d.expires_at>clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM company_runtime_selections s WHERE s.company_id=p.company_id AND s.kind='gateway')
 AND NOT EXISTS(SELECT 1 FROM project_gateway_bindings b WHERE b.company_id=p.company_id AND b.project_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM trusted_service_provisions t WHERE t.company_id=p.company_id AND t.service='gateway' AND t.preset->'projectIds' ? p.id::text) LIMIT 1`,[userId])).rowCount)origins.add(legacy);
 return [...origins].sort();
}
/** A stopped, revoked, expired or merely planned managed service never falls
 * through to the global legacy gateway. Historical bindings are retained. */
export async function hasProjectGatewayConfiguration(db:PoolClient,companyId:string,projectId:string){return Boolean((await db.query("SELECT 1 FROM project_gateway_bindings WHERE company_id=$1 AND project_id=$2 UNION ALL SELECT 1 FROM trusted_service_provisions WHERE company_id=$1 AND service='gateway' AND preset->'projectIds' ? $2::text UNION ALL SELECT 1 FROM company_runtime_selections WHERE company_id=$1 AND kind='gateway' LIMIT 1",[companyId,projectId])).rowCount);}
export async function resolveProjectGateway(db:PoolClient,companyId:string,projectId:string):Promise<(Omit<VerifiedProjectGateway,'bindingId'|'provisionId'|'configurationHash'|'expiresAt'>&{bindingId:string|null;provisionId:string|null;configurationHash:string|null;expiresAt:string|null})|null>{
 const verified=await verifiedProjectGateway(db,companyId,projectId);if(verified)return verified;if(await hasProjectGatewayConfiguration(db,companyId,projectId))return null;
 const origin=storageGatewayOrigin();return origin?{origin,bindingId:null,provisionId:null,configurationHash:null,expiresAt:null}:null;
}
/** Rechecked before every transfer and by the active stream authority reader. */
export async function authorizeProjectGatewayGrant(db:PoolClient,grant:Row,identity?:GatewayIdentity){
 const bindingId=grant.service_binding_id,provisionId=grant.service_provision_id;
 if(!bindingId&&!provisionId){if(identity||await hasProjectGatewayConfiguration(db,grant.company_id,grant.project_id))fail(403,'The file access gateway changed. Request new access.','STORAGE_ACCESS_DENIED');return;}
 const gateway=await verifiedProjectGateway(db,grant.company_id,grant.project_id);
 if(!gateway||gateway.bindingId!==bindingId||gateway.provisionId!==provisionId||!identity||identity.provisionId!==provisionId||identity.companyId!==grant.company_id||!identity.projectIds.includes(grant.project_id)||identity.configurationHash!==gateway.configurationHash)fail(403,'The verified file access gateway ended or changed.','STORAGE_ACCESS_DENIED');
}
export async function verifyAndBindProjectGateway(db:PoolClient,member:Membership,projectId:string,input:unknown,transport:typeof fetch=fetch){
 const parsed=verifyProjectGatewayInput.safeParse(input);if(!parsed.success)fail(400,'Choose the current gateway provision and binding.');const data=parsed.data;
 await lockMembership(db,member,true);await control(db,member.companyId,projectId);
 if(!(await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2',[member.companyId,id(projectId)])).rowCount)fail(404,'Project not found.');
 const previous=await verifiedProjectGateway(db,member.companyId,projectId);
 if((previous?.bindingId??null)!==data.expectedBindingId)fail(409,'The gateway binding changed. Refresh before verifying.','GATEWAY_BINDING_CONFLICT');
 const selected=await service(db,member.companyId,data.provisionId,projectId);if(!selected)return unavailable();
 const challenge=createGatewayChallenge(selected.identity),response=await transport(selected.origin+'/v1/identity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(challenge),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
 if(!response.ok){await response.body?.cancel().catch(()=>{});return unavailable();}verifyGatewayAnswer(await boundedGatewayJson(response.body),challenge);
 // Time, provider status, stop intent and authority may change during I/O.
 const current=await service(db,member.companyId,data.provisionId,projectId);if(!current||current.origin!==selected.origin||trustedServiceHash(current.identity)!==trustedServiceHash(selected.identity))return unavailable();await lockMembership(db,member,true);
 await db.query('UPDATE project_gateway_bindings SET revoked_at=clock_timestamp() WHERE company_id=$1 AND project_id=$2 AND revoked_at IS NULL',[member.companyId,projectId]);
 const bindingId=randomUUID();await db.query('INSERT INTO project_gateway_bindings(id,company_id,project_id,provision_id,configuration_hash,origin,verified_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[bindingId,member.companyId,projectId,data.provisionId,current.identity.configurationHash,current.origin,member.userId,current.identity.expiresAt]);
 return {gateway:await verifiedProjectGateway(db,member.companyId,projectId)};
}
export async function revokeProjectGateway(db:PoolClient,member:Membership,projectId:string,input:unknown){const parsed=revokeProjectGatewayInput.safeParse(input);if(!parsed.success)fail(400,'Choose the current gateway binding.');await lockMembership(db,member,true);await control(db,member.companyId,projectId);const row=(await db.query('UPDATE project_gateway_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE company_id=$1 AND project_id=$2 AND id=$3 RETURNING id',[member.companyId,projectId,parsed.data.bindingId])).rows[0];if(!row)fail(404,'Gateway binding not found.');return {bindingId:row.id,revoked:true};}
