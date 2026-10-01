/** Offline service metadata fixture. Stored bytes, provider and qualification
 * identities are synthetic; these rows are not a runtime qualification proof. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {dropFixtureDatabase} from './postgres-teardown';
import {createProjectStorageConnection,bindProjectStorage} from '../../src/lib/project-storage';
import {trustedServiceHash} from '../../src/lib/trusted-service-config';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../../src/lib/higgsfield-image-preparation';
import {enrollImagePreparationService} from '../../src/lib/project-image-preparation-enrollment';
import {parseImagePreparationEnrollmentRequest} from '../../src/lib/project-image-preparation-enrollment-contract.mjs';
import {resolveProjectImagePreparationProcessor} from '../../src/lib/project-image-preparation-service-authority';
import * as preparations from '../../src/lib/project-image-preparations';
import {hashToken} from '../../src/lib/security';

export async function openImagePreparationServiceDatabase(){
 const files=(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort();
 const integration=process.env.COATRIA_TEST_EMULATOR==='1'?undefined:process.env.COATRIA_INTEGRATION_DATABASE_URL;
 if(integration){
  const url=new URL(integration);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
  const control=new Pool({connectionString:integration,max:1}),name='coatria_preparation_service_'+randomUUID().replaceAll('-','');await control.query('CREATE DATABASE '+name);url.pathname='/'+name;
  const pool=new Pool({connectionString:url.href,max:3});
  try{await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY)');for(const file of files){await pool.query(await readFile('database/'+file,'utf8'));await pool.query('INSERT INTO schema_migrations VALUES($1)',[file]);}}
  catch(error){await pool.end();await dropFixtureDatabase(control,name);await control.end();throw error;}
  return {native:true,db:pool as unknown as PoolClient,connectionString:url.href,control,exec:(sql:string)=>pool.query(sql),
   async tx<T>(run:(db:PoolClient)=>Promise<T>){const db=await pool.connect();try{await db.query('BEGIN');const result=await run(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}},
   async close(){await pool.end();try{await dropFixtureDatabase(control,name);}finally{await control.end();}}};
 }
 const {PGlite}=await import('@electric-sql/pglite'),raw=await PGlite.create();
 try{await raw.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY)');for(const file of files){await raw.exec(await readFile('database/'+file,'utf8'));await raw.query('INSERT INTO schema_migrations VALUES($1)',[file]);}}catch(e){await raw.close();throw e;}
 const wrap=(db:{query:(sql:string,values?:unknown[])=>Promise<any>})=>({query:async(sql:string,values?:unknown[])=>{const r=await db.query(sql,values);return {...r,rowCount:r.rows.length||r.affectedRows};}} as unknown as PoolClient);
 return {native:false,db:wrap(raw),connectionString:undefined,control:undefined,exec:(sql:string)=>raw.exec(sql),
  tx:<T>(run:(db:PoolClient)=>Promise<T>)=>raw.transaction(db=>run(wrap(db))),close:()=>raw.close()};
}
export async function imagePreparationServiceFixture(db:PoolClient,options:{enroll?:boolean;propose?:boolean;sourceBytes?:Buffer;storageKeyring?:string}={}){
 const companyId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),workItemId=randomUUID(),taskId=randomUUID(),fileId=randomUUID(),versionId=randomUUID();
 const storageKeyring=options.storageKeyring??JSON.stringify({activeKeyId:'synthetic-preparation',keys:{'synthetic-preparation':randomBytes(32).toString('base64')}});
 const sourceLength=options.sourceBytes?.length??100,sourceSha256=options.sourceBytes?createHash('sha256').update(options.sourceBytes).digest('hex'):'a'.repeat(64);
 const previous=process.env.COATRIA_HOSTING_KEYRING;process.env.COATRIA_HOSTING_KEYRING=storageKeyring;
 let connection:Awaited<ReturnType<typeof createProjectStorageConnection>>['connection'],binding:Awaited<ReturnType<typeof bindProjectStorage>>['binding'];
 try{
  await db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic service fixture',$2,'not-a-login')",[userId,userId+'@example.invalid']);
  await db.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic preparation service',$2,'blank')",[companyId,companyId]);
  await db.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,userId]);
  await db.query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[companyId,userId]);
  await db.query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Synthetic image','Internal','Exact fixture only',$3,'allowed','production',$4,$5,'higgsfield',2)",[projectId,companyId,JSON.stringify({kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}}),JSON.stringify(Object.fromEntries(['brief','estimate','production'].map(g=>[g,{decision:'approved',recordedBy:userId}]))),userId]);
  await db.query("INSERT INTO tasks(id,company_id,title,created_by) VALUES($1,$2,'Prepare image',$3)",[taskId,companyId,userId]);
  await db.query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'original',$4,'references','ingest','agent')",[workItemId,companyId,projectId,taskId]);
  await db.query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)",[companyId,userId]);
  connection=(await createProjectStorageConnection(db,{companyId,userId},{clientId:randomUUID(),name:'Synthetic storage',region:'US-CA-2',volumeId:'synthetic-volume',accessKeyId:'user_synthetic',secretAccessKey:'rps_synthetic'})).connection;
  binding=(await bindProjectStorage(db,{companyId,userId},projectId,{clientId:randomUUID(),revision:0,connectionId:connection.id})).binding;
 }finally{if(previous===undefined)delete process.env.COATRIA_HOSTING_KEYRING;else process.env.COATRIA_HOSTING_KEYRING=previous;}
 await db.query("INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,'original.png','original.png',$5)",[fileId,companyId,projectId,binding.id,userId]);
 await db.query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$8,$5,'image/png',$6,$7)",[versionId,companyId,projectId,fileId,sourceSha256,`coatria/companies/${companyId}/projects/${projectId}/objects/${versionId}`,userId,sourceLength]);
 await db.query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$6,$4,'synthetic-source-etag',$5)",[companyId,projectId,versionId,sourceSha256,randomUUID(),sourceLength]);
 const now=Date.now(),expiresAt=new Date(now+600000).toISOString(),gatewayExpiry=new Date(now+1200000).toISOString(),provisionId=randomUUID(),gatewayBindingId=randomUUID();
 const configuration={version:1,companyId,projectIds:[projectId],sourceCommit:'b'.repeat(40),expiresAt:gatewayExpiry,appOrigin:'https://coatria.com',host:'0.0.0.0',port:4190,maxTransfers:8,verifierConcurrency:1};
 const preset={service:'gateway',companyId,projectIds:[projectId],releaseCommit:configuration.sourceCommit,expiresAt:gatewayExpiry,configuration,configurationHash:trustedServiceHash(configuration)},plan={preset:{hash:trustedServiceHash(preset)}};
 await db.query("INSERT INTO trusted_service_provisions(id,company_id,service,created_by,client_id,request_hash,preset,plan,plan_hash,pod_name,pod_id,expires_at,phase,provider_status,last_reconciled_at) VALUES($1,$2,'gateway',$3,$4,$5,$6,$7,$8,$9,$10,$11,'running','RUNNING',clock_timestamp())",[provisionId,companyId,userId,randomUUID(),'c'.repeat(64),JSON.stringify(preset),JSON.stringify(plan),trustedServiceHash(plan),'synthetic-'+provisionId,provisionId.replaceAll('-',''),gatewayExpiry]);
 const origin=`https://${provisionId.replaceAll('-','')}-4190.proxy.runpod.net`;
 await db.query('INSERT INTO project_gateway_bindings(id,company_id,project_id,provision_id,configuration_hash,origin,verified_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[gatewayBindingId,companyId,projectId,provisionId,preset.configurationHash,origin,userId,gatewayExpiry]);
 const joinedAt=(await db.query(`SELECT to_char(joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS epoch FROM memberships WHERE company_id=$1 AND user_id=$2`,[companyId,userId])).rows[0].epoch;
 const serviceId=randomUUID(),token='ips_'+randomBytes(32).toString('base64url');
 const enrollment=parseImagePreparationEnrollmentRequest({version:1,requestId:randomUUID(),serviceId,companyId,enrolledBy:userId,enroller:{role:'owner',joinedAt},tokenHash:hashToken(token),origin:'https://coatria.com',location:'Synthetic service fixture, not qualified',releaseSha256:'b'.repeat(64),qualificationSha256:'c'.repeat(64),profileSha256:'d'.repeat(64),sourceCommit:'e'.repeat(40),closureSha256:'f'.repeat(64),recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,transport:'linux_binary_v1',expiresAt,
  projects:[{projectId,projectRevision:1,storageBindingId:binding.id,storageBindingRevision:binding.revision,storageConnectionId:connection.id,storageConnectionRevision:connection.revision,gateway:{bindingId:gatewayBindingId,provisionId,configurationSha256:preset.configurationHash,origin,expiresAt:gatewayExpiry}}],
  qualification:{kind:'coatria-image-preparation-qualification-v1',sourceCommit:'e'.repeat(40),sourceTree:'a'.repeat(40),bundleSha256:'b'.repeat(64),hostConfigurationSha256:'c'.repeat(64),configurationSha256:'d'.repeat(64),qualifierSha256:'e'.repeat(64),conformanceProfileSha256:'f'.repeat(64),bootId:randomUUID(),uid:1234,gid:1234,qualifierInvocationId:'a'.repeat(32),evidenceSha256:'b'.repeat(64),reportSha256:'c'.repeat(64),acceptedAt:new Date(now-1000).toISOString()}});
 if(options.enroll!==false)await enrollImagePreparationService(db,enrollment);
 const actor={companyId,userId},runtime={runtime:resolveProjectImagePreparationProcessor};
 const proposed=options.propose===false?null:(await preparations.proposeProjectImagePreparation(db,actor,{clientId:randomUUID(),projectId,projectRevision:1,workItemId,sourceVersionId:versionId,sourceSha256,sourceBytes:sourceLength,destinationFolderId:null,destinationName:'prepared.png',purpose:'Synthetic service metadata only'})).preparation;
 return {companyId,userId,projectId,workItemId,taskId,fileId,versionId,serviceId,token,enrollment,proposed,actor,runtime,connection,binding,storageKeyring,sourceLength,sourceSha256,gateway:{bindingId:gatewayBindingId,provisionId,origin,expiresAt:gatewayExpiry,configurationHash:preset.configurationHash},
  async approve(client:PoolClient){assert(proposed);return preparations.approveProjectImagePreparation(client,actor,proposed.id,{clientId:randomUUID(),revision:proposed.revision,requestHash:proposed.requestHash,processorId:serviceId,qualificationSha256:enrollment.qualificationSha256,expiresInMinutes:5,maxCostMicrousd:0,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true},runtime);},
  async claim(client:PoolClient){const lease=await preparations.claimProjectImagePreparation(client,{companyId,projectIds:[projectId]},runtime);assert(lease);await client.query('INSERT INTO project_image_preparation_service_leases(service_id,company_id,project_id,preparation_id,lease_id,request_hash,lease) VALUES($1,$2,$3,$4,$5,$6,$7)',[serviceId,companyId,projectId,lease.preparationId,lease.leaseId,lease.requestHash,JSON.stringify(lease)]);return lease;}};
}
