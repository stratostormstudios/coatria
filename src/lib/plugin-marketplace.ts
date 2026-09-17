import {z} from 'zod';
import type {PoolClient} from 'pg';
import {requireMembership,type Membership} from './auth';
import {memberMutation,recordActivity} from './company';
import {body,fail,hashToken,id,json,rateLimit,secret,uuid} from './security';
import {AGENT_CAPABILITIES} from './agent-policy';
import {PLUGIN_CATALOG,PLUGIN_CATALOG_VERSION,type PluginCatalogEntry} from './plugin-catalog';

const capabilitiesInput=z.array(z.enum(AGENT_CAPABILITIES)).max(AGENT_CAPABILITIES.length).refine(values=>new Set(values).size===values.length,'Capabilities must be unique.').transform(values=>values.sort());
const runtimeInput=z.object({
 providerId:z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
 modelId:z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
 maxSteps:z.number().int().min(1).max(20).default(8),
 maxOutputTokens:z.number().int().min(256).max(8192).default(2048),
 maxTotalTokens:z.number().int().min(2000).max(100000).default(24000),
 timeoutSeconds:z.number().int().min(30).max(600).default(180),
}).strict().refine(value=>value.maxOutputTokens<=value.maxTotalTokens,'Output token limit cannot exceed the total token limit.');
const characterInput=z.object({roleTitle:z.string().trim().max(80).default(''),persona:z.string().trim().max(1600).default(''),workStyle:z.enum(['collaborative','independent','methodical']).default('collaborative')}).strict();
const installInput=z.object({
 clientId:uuid,pluginId:z.string().min(1).max(80),manifestVersion:z.string().min(1).max(40),name:z.string().trim().min(1).max(80),
 invocationAccess:z.enum(['none','members','admins']).default('none'),capabilities:capabilitiesInput.default([]),
 runtimeConfig:runtimeInput,character:characterInput.default({roleTitle:'',persona:'',workStyle:'collaborative'}),
 expiresInDays:z.number().int().min(1).max(365).default(90),
}).strict();
const patchInput=z.object({
 revision:z.number().int().min(1).max(2147483646),name:z.string().trim().min(1).max(80).optional(),
 status:z.enum(['active','paused','revoked']).optional(),invocationAccess:z.enum(['none','members','admins']).optional(),capabilities:capabilitiesInput.optional(),
 runtimeConfig:runtimeInput.optional(),character:characterInput.optional(),
}).strict().refine(value=>Object.keys(value).length>1,'Provide an installation change.');
export {installInput as pluginInstallInput,patchInput as pluginPatchInput};
const installationColumns=`p.id,p.company_id AS "companyId",p.agent_id AS "agentId",p.plugin_id AS "pluginId",p.manifest_version AS "manifestVersion",p.revision,p.runtime_config AS "runtimeConfig",p.character,p.created_at AS "createdAt",p.updated_at AS "updatedAt",p.installed_by AS "installedBy",a.name,a.status,a.invocation_access AS "invocationAccess",a.capabilities,a.last_seen_at AS "lastSeenAt",a.expires_at AS "expiresAt",CASE WHEN a.status='revoked' THEN 'revoked' WHEN a.status='paused' THEN 'paused' WHEN a.expires_at<=clock_timestamp() THEN 'expired' WHEN NOT EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=a.company_id AND m.user_id=a.created_by AND m.role IN ('owner','admin')) THEN 'sponsor_unavailable' WHEN a.last_seen_at IS NULL THEN 'installed' WHEN a.last_seen_at>clock_timestamp()-interval '2 minutes' THEN 'worker_contact' ELSE 'worker_offline' END AS "connectionState"`;

function manifest(pluginId:string,version:string):PluginCatalogEntry{
 const entry=PLUGIN_CATALOG.find(plugin=>plugin.id===pluginId&&plugin.version===version);
 if(!entry)fail(400,'Choose a current curated plugin and its exact manifest version.','PLUGIN_MANIFEST_UNAVAILABLE');
 return entry;
}
function validateConfig(entry:PluginCatalogEntry,config:z.infer<typeof runtimeInput>,capabilities:readonly string[]){
 const provider=entry.providers.find(provider=>provider.id===config.providerId);
 if(!provider||!provider.models.some(model=>model.id===config.modelId)&&!provider.allowCustomModel)fail(400,'This provider or model is not offered by the selected plugin.','PLUGIN_MODEL_UNAVAILABLE');
 if(capabilities.some(capability=>!(entry.capabilities as readonly string[]).includes(capability)))fail(400,'The selected plugin does not support one of these capabilities.','PLUGIN_CAPABILITY_UNAVAILABLE');
}
async function project(client:PoolClient,companyId:string,installationId:string){
 const row=(await client.query(`SELECT ${installationColumns} FROM plugin_installations p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2`,[companyId,installationId])).rows[0];
 if(!row)fail(404,'Plugin installation not found.');return row;
}
async function lockedInstallation(client:PoolClient,member:Membership,installationId:string){
 const preview=(await client.query('SELECT agent_id FROM plugin_installations WHERE company_id=$1 AND id=$2',[member.companyId,installationId])).rows[0];if(!preview)fail(404,'Plugin installation not found.');
 // Match the worker lock order. No installation lock is held while waiting for
 // its agent; a live lease can never race an install configuration change.
 const agent=(await client.query('SELECT * FROM agents WHERE company_id=$1 AND id=$2 FOR UPDATE',[member.companyId,preview.agent_id])).rows[0];
 const installation=(await client.query('SELECT * FROM plugin_installations WHERE company_id=$1 AND id=$2 FOR UPDATE',[member.companyId,installationId])).rows[0];
 if(!agent||!installation)fail(404,'Plugin installation not found.');return{agent,installation};
}
async function cancelRuns(client:PoolClient,companyId:string,agentId:string,reason:string){
 await client.query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error=$3 WHERE company_id=$1 AND agent_id=$2 AND status IN ('queued','running')",[companyId,agentId,reason]);
}

/** Public metadata is also available during first-time database setup. */
export function pluginCatalogResponse(){return json({version:PLUGIN_CATALOG_VERSION,plugins:PLUGIN_CATALOG});}

/** Called only after authorizeRunTool has locked the company, agent and run. */
export async function installedRuntimeContext(client:PoolClient,companyId:string,agentId:string){
 const row=(await client.query('SELECT plugin_id AS "pluginId",manifest_version AS "manifestVersion",runtime_config AS "runtimeConfig",character,revision FROM plugin_installations WHERE company_id=$1 AND agent_id=$2',[companyId,agentId])).rows[0];
 if(!row)return null;
 const entry=manifest(row.pluginId,row.manifestVersion),config=runtimeInput.safeParse(row.runtimeConfig),character=characterInput.safeParse(row.character);
 if(!config.success||!character.success)fail(409,'The installed runtime configuration needs administrator review.','PLUGIN_CONFIG_INVALID');
 validateConfig(entry,config.data,[]);return{...row,runtimeConfig:config.data,character:character.data};
}

export async function pluginMarketplaceRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts.join('/')==='plugins/catalog'&&method==='GET')return pluginCatalogResponse();
 if(parts[0]!=='companies'||parts[2]!=='plugin-installations'||parts.length<3||parts.length>5)return null;
 const companyId=id(parts[1]),member=await requireMembership(request,companyId,method!=='GET');
 if(parts.length===3&&method==='GET'){
  const url=new URL(request.url),limit=Number(url.searchParams.get('limit')||50),after=url.searchParams.get('after');
  if(!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Choose a limit from 1 to 100.');if(after)id(after);
  return json(await memberMutation(member,false,async client=>{
   if(after&&!(await client.query('SELECT id FROM plugin_installations WHERE company_id=$1 AND id=$2',[companyId,after])).rowCount)fail(404,'Installation cursor not found.');
   const rows=(await client.query(`SELECT ${installationColumns} FROM plugin_installations p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND ($2::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM plugin_installations WHERE company_id=$1 AND id=$2)) ORDER BY p.created_at DESC,p.id DESC LIMIT $3`,[companyId,after,limit+1])).rows;
   const items=rows.slice(0,limit);return{installations:items,hasMore:rows.length>limit,nextAfter:rows.length>limit?items.at(-1)?.id:null};
  }));
 }
 if(parts.length===3&&method==='POST'){
  await rateLimit(`plugin-install:${member.userId}`,20,3600);
  const data=await body(request,installInput,16000),entry=manifest(data.pluginId,data.manifestVersion);validateConfig(entry,data.runtimeConfig,data.capabilities);
  const requestHash=hashToken(JSON.stringify(data));
  const result=await memberMutation(member,true,async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${companyId}:agent-quota`]);
   const prior=(await client.query('SELECT id,request_hash FROM plugin_installations WHERE company_id=$1 AND installed_by=$2 AND client_id=$3',[companyId,member.userId,data.clientId])).rows[0];
   if(prior){if(prior.request_hash!==requestHash)fail(409,'This installation key was used for a different configuration.','IDEMPOTENCY_CONFLICT');return{installation:await project(client,companyId,prior.id),token:null,replayed:true};}
   if(Number((await client.query("SELECT count(*) FROM agents WHERE company_id=$1 AND status<>'revoked'",[companyId])).rows[0].count)>=100)fail(409,'This company has reached the limit of 100 active or paused agents.','AGENT_LIMIT_REACHED');
   const token=secret('ca_');
   const agent=(await client.query("INSERT INTO agents(company_id,name,harness,description,token_hash,created_by,conversation_access,invocation_access,capabilities,expires_at) VALUES($1,$2,$3,$4,$5,$6,'none',$7,$8,clock_timestamp()+$9*interval '1 day') RETURNING id",[companyId,data.name,entry.harness,entry.description,hashToken(token),member.userId,data.invocationAccess,JSON.stringify(data.capabilities),data.expiresInDays])).rows[0];
   const installed=(await client.query('INSERT INTO plugin_installations(company_id,agent_id,installed_by,client_id,request_hash,plugin_id,manifest_version,runtime_config,character) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[companyId,agent.id,member.userId,data.clientId,requestHash,data.pluginId,data.manifestVersion,JSON.stringify(data.runtimeConfig),JSON.stringify(data.character)])).rows[0];
   await recordActivity(client,member,'plugin.installed',`${member.user.name} installed ${entry.name} as ${data.name} with reviewed agent grants.`);
   return{installation:await project(client,companyId,installed.id),token,replayed:false};
  });return json(result,result.replayed?200:201);
 }
 if(parts.length===4&&method==='GET')return json(await memberMutation(member,false,async client=>({installation:await project(client,companyId,id(parts[3]))})));
 if(parts.length===4&&method==='PATCH'){
  const installationId=id(parts[3]),data=await body(request,patchInput,16000);
  return json(await memberMutation(member,true,async client=>{
   const{agent,installation}=await lockedInstallation(client,member,installationId);
   if(installation.revision!==data.revision)fail(409,'This installation changed. Reload its current settings.','PLUGIN_REVISION_CONFLICT');
   if(agent.status==='revoked')fail(409,'Revoked installations cannot be changed. Install a new plugin.','PLUGIN_REVOKED');
   const config=data.runtimeConfig??installation.runtime_config,capabilities=data.capabilities??agent.capabilities;
   // Lifecycle kill switches remain available if a manifest is retired or its
   // stored configuration is invalid. Other changes still require full review.
   const lifecycleOnly=['paused','revoked'].includes(data.status??'')&&Object.keys(data).every(key=>['revision','status'].includes(key));
   if(!lifecycleOnly)validateConfig(manifest(installation.plugin_id,installation.manifest_version),config,capabilities);
   await client.query('UPDATE agents SET name=$3,status=$4,invocation_access=$5,capabilities=$6 WHERE company_id=$1 AND id=$2',[companyId,agent.id,data.name??agent.name,data.status??agent.status,data.invocationAccess??agent.invocation_access,JSON.stringify(capabilities)]);
   await client.query('UPDATE plugin_installations SET runtime_config=$3,character=$4,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[companyId,installationId,JSON.stringify(config),JSON.stringify(data.character??installation.character)]);
   await cancelRuns(client,companyId,agent.id,'Plugin configuration or permissions changed. Request new work after reviewing the installation.');
   await recordActivity(client,member,data.status==='revoked'?'plugin.revoked':'plugin.updated',`${member.user.name} ${data.status==='revoked'?'revoked':'updated'} ${data.name??agent.name}'s plugin installation.`);
   return{installation:await project(client,companyId,installationId)};
  }));
 }
 if(parts.length===5&&parts[4]==='rotate'&&method==='POST'){
  const installationId=id(parts[3]),data=await body(request,z.object({revision:z.number().int().min(1).max(2147483646),expiresInDays:z.number().int().min(1).max(365).default(90)}).strict()),token=secret('ca_');
  return json(await memberMutation(member,true,async client=>{
   const{agent,installation}=await lockedInstallation(client,member,installationId);
   if(installation.revision!==data.revision)fail(409,'This installation changed. Reload its current settings.','PLUGIN_REVISION_CONFLICT');if(agent.status==='revoked')fail(409,'Install a new plugin instead of rotating a revoked credential.','PLUGIN_REVOKED');
   await client.query('UPDATE agents SET token_hash=$3,expires_at=clock_timestamp()+$4*interval \'1 day\',last_seen_at=NULL WHERE company_id=$1 AND id=$2',[companyId,agent.id,hashToken(token),data.expiresInDays]);
   await client.query('UPDATE plugin_installations SET revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[companyId,installationId]);
   await cancelRuns(client,companyId,agent.id,'Plugin worker credential rotated.');
   await recordActivity(client,member,'plugin.credential_rotated',`${member.user.name} rotated ${agent.name}'s plugin worker credential.`);
   return{installation:await project(client,companyId,installationId),token};
  }));
 }
 if(parts.length===5&&parts[4]==='connection-test'&&method==='POST'){
  const{createAgentRun}=await import('./agent-runs');
  const data=await body(request,z.object({clientId:uuid}).strict());
  await rateLimit(`plugin-test:${member.userId}`,12,3600);
  const installed=await memberMutation(member,true,client=>project(client,companyId,id(parts[3])));
  const result=await createAgentRun(member,'commons',{clientId:data.clientId,agentId:installed.agentId,prompt:'Run a connection check. Do not call any tools, read additional workspace information, or change any data. Reply in one short sentence confirming that your model received this request and returned a response, using your configured character and company role.'},{purpose:'connection_test'});
  return json(result,result.replayed?200:201);
 }
 return null;
}
