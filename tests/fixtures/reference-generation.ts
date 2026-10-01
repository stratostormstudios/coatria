/** Offline control-plane fixture. Source verification, transform and multipart
 * receipts are synthetic metadata, NOT proof that bytes were decoded or stored.
 * Handoffs and adoptions are created only by the actual application services. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {database,query,transaction} from '../../src/lib/db';
import {handleApi} from '../../src/lib/api';
import {hashToken} from '../../src/lib/security';
import {dropFixtureDatabase} from './postgres-teardown';
import {createProjectStorageConnection,bindProjectStorage} from '../../src/lib/project-storage';
import * as prep from '../../src/lib/project-image-preparations';
import * as storage from '../../src/lib/project-image-preparation-storage';
import {proposeProjectImagePreparationReference} from '../../src/lib/project-image-preparation-reference';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../../src/lib/higgsfield-image-preparation';
import {runpodProjectRoot} from '../../src/lib/project-storage-runpod';
import {sealHiggsfieldSecret} from '../../src/lib/higgsfield-secrets';
import {claimAgentRun,finishAgentRun} from '../../src/lib/agent-runs';
import {executeAgentTool} from '../../src/lib/agent-tools';
import {adoptStudioReferenceGenerationInspection} from '../../src/lib/studio-reference-generation-inspection';
import {claimHiggsfieldReference,higgsfieldReferenceDigest,type HiggsfieldReferenceOptions} from '../../src/lib/higgsfield-references';
import type {HiggsfieldTool} from '../../src/lib/higgsfield-mcp';
import type {ProjectImagePreparationProcessor} from '../../src/lib/project-image-preparations-protocol';

type Row=Record<string,any>;
export async function openReferenceGenerationDatabase(){
 const saved={DATABASE_URL:process.env.DATABASE_URL,DATABASE_POOL_MAX:process.env.DATABASE_POOL_MAX,COATRIA_HOSTING_KEYRING:process.env.COATRIA_HOSTING_KEYRING},fetch=globalThis.fetch;
 const files=(await readdir('database')).filter(f=>/^\d.*\.sql$/.test(f)).sort();let stop=async()=>{},outbound=0;
 assert.equal((globalThis as {coatriaPool?:Pool}).coatriaPool,undefined,'Fixture owns an isolated application pool');
 const integration=process.env.COATRIA_TEST_EMULATOR==='1'?undefined:process.env.COATRIA_INTEGRATION_DATABASE_URL;
 try{
  if(integration){const url=new URL(integration);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Never mutate an external database');const control=new Pool({connectionString:integration,max:1}),name='coatria_reference_generation_'+randomUUID().replaceAll('-','');await control.query('CREATE DATABASE '+name);url.pathname='/'+name;process.env.DATABASE_URL=url.href;process.env.DATABASE_POOL_MAX='5';stop=async()=>{try{await dropFixtureDatabase(control,name);}finally{await control.end();}};for(const f of files)await query(await readFile('database/'+f,'utf8'));}
  else{const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();try{for(const f of files)await db.exec(await readFile('database/'+f,'utf8'));}catch(e){await db.close();throw e;}const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();process.env.DATABASE_URL='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres';process.env.DATABASE_POOL_MAX='1';stop=async()=>{try{await socket.stop();}finally{await db.close();}};}
  process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'reference-generation-fixture',keys:{'reference-generation-fixture':randomBytes(32).toString('base64')}});
  globalThis.fetch=async()=>{outbound++;throw Error('Offline reference-generation fixture forbids providers');};
 }catch(e){if((globalThis as any).coatriaPool){await database().end();delete(globalThis as any).coatriaPool;}await stop();for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;throw e;}
 return {native:Boolean(integration),outbound:()=>outbound,async close(){try{assert.equal(outbound,0,'No provider/network operation is allowed');}finally{globalThis.fetch=fetch;await database().end();delete(globalThis as any).coatriaPool;await stop();for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}}};
}

export async function referenceGenerationFixture(options:{propose?:boolean;continuations?:boolean;generatedContinuations?:boolean;providerTools?:HiggsfieldTool[]}={}){
 const company=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),project=randomUUID(),shot=randomUUID(),referenceTask=randomUUID(),referenceWork=randomUUID(),task=randomUUID(),work=randomUUID(),folder=randomUUID(),file=randomUUID(),version=randomUUID();
 const sessions={owner:randomUUID(),admin:randomUUID(),member:randomUUID()},origin='https://coatria.com';
 for(const[name,user]of Object.entries({owner,admin,member})){await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Synthetic identity',$2,'not-a-login')",[user,user+'@example.invalid']);await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),user]);}
 await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Synthetic generation continuation',$2,'blank')",[company,company]);
 await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member')",[company,owner,admin,member]);
 await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[company,owner]);
 const gates=Object.fromEntries(['brief','estimate','production'].map(key=>[key,{decision:'approved',recordedBy:owner}]));
 await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path,contract_version) VALUES($1,$2,'Synthetic image continuation','Internal','Exact original objective',$3,'allowed','production',$4,$5,'higgsfield',2)",[project,company,JSON.stringify({kind:'image',format:'png',width:96,height:64,color:{mode:'not_required'}}),JSON.stringify(gates),owner]);
 await query("INSERT INTO studio_shots(id,company_id,project_id,code,description,frame_start,frame_end,handles,disciplines,media_kind) VALUES($1,$2,$3,'SYNTHETIC','Synthetic metadata only',NULL,NULL,NULL,'[]','image')",[shot,company,project]);
 await query("INSERT INTO tasks(id,company_id,title,description,created_by,assignee_id) VALUES($1,$2,'Prepare reference','Preserve original',$3,$3)",[referenceTask,company,owner]);
 await query("INSERT INTO tasks(id,company_id,title,description,created_by) VALUES($1,$2,'Generate exact image','Use approved derived reference for this original objective',$3)",[task,company,owner]);
 await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution,shot_id) VALUES($1,$2,$3,'reference',$4,'references','ingest','agent',$5),($6,$2,$3,'generation',$7,'generation','comp','creative',$5)",[referenceWork,company,project,referenceTask,shot,work,task]);
 await query("INSERT INTO studio_role_bindings(company_id,role_key,human_id) VALUES($1,'ingest',$2)",[company,owner]);
 const actor={companyId:company,userId:owner};
 const connection=(await transaction(db=>createProjectStorageConnection(db,actor,{clientId:randomUUID(),name:'Synthetic private storage',region:'US-CA-2',volumeId:'synthetic-volume',accessKeyId:'user_syntheticaccess',secretAccessKey:'rps_syntheticsecret'}))).connection;
 const binding=(await transaction(db=>bindProjectStorage(db,actor,project,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
 await query('INSERT INTO project_storage_folders(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)',[folder,company,project,binding.id,'Prepared images',owner]);
 await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$5,$6)',[file,company,project,binding.id,'original.png',owner]);
 const sourceBytes=1000,sourceSha256=hashToken(version),objectKey=`coatria/companies/${company}/projects/${project}/objects/${version}`;
 await query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,$5,$6,'image/png',$7,$8)",[version,company,project,file,sourceBytes,sourceSha256,objectKey,owner]);
 await query("INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,$4,$5,'synthetic-etag',$6)",[company,project,version,sourceBytes,sourceSha256,randomUUID()]);
 const proposed=(await transaction(db=>prep.proposeProjectImagePreparation(db,actor,{clientId:randomUUID(),projectId:project,projectRevision:1,workItemId:referenceWork,sourceVersionId:version,sourceSha256,sourceBytes,destinationFolderId:folder,destinationName:'derivative.png',purpose:'Preserve original and create separate reference'}))).preparation;
 const processor:ProjectImagePreparationProcessor={id:randomUUID(),location:'Synthetic fixture only',qualificationSha256:'a'.repeat(64),releaseSha256:'b'.repeat(64),profileSha256:'c'.repeat(64),sourceCommit:'d'.repeat(40),closureSha256:'e'.repeat(64),transport:'linux_binary_v1',recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,expiresAt:new Date(Date.now()+3600000).toISOString()},runtime={runtime:async()=>processor};
 await transaction(db=>prep.approveProjectImagePreparation(db,{companyId:company,userId:admin},proposed.id,{clientId:randomUUID(),revision:proposed.revision,requestHash:proposed.requestHash,processorId:processor.id,qualificationSha256:processor.qualificationSha256,expiresInMinutes:30,maxCostMicrousd:10000,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true},runtime));
 const lease=await transaction(db=>prep.claimProjectImagePreparation(db,{companyId:company,projectIds:[project]},runtime));assert(lease);
 const intent=await transaction(db=>prep.beginProjectImagePreparationPhase(db,lease,'transform',runtime));
 await transaction(db=>prep.completeProjectImagePreparationPhase(db,lease,intent.actionId,{operation:'transform',sourceVersionId:version,sourceSha256,sourceBytes,source:{format:'png',width:96,height:64,orientation:1},recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,processor,output:{format:'png',width:96,height:64,bytes:250,sha256:'f'.repeat(64),pixelFormat:'rgba8',metadataRemoved:true}},runtime));
 const output=await transaction(db=>storage.reserveProjectImagePreparationOutput(db,lease,runtime));
 for(const operation of ['initiate','part','complete'] as const){const action=await transaction(db=>storage.beginProjectImagePreparationStore(db,lease,operation,runtime));const result=operation==='initiate'?{operation,descriptor:{scope:hashToken(JSON.stringify(['US-CA-2','synthetic-volume',runpodProjectRoot(company,project)])),versionId:output.versionId,uploadId:'synthetic-upload',bytes:output.bytes,partBytes:output.partBytes}}:operation==='part'?{operation,part:{partNumber:1,bytes:output.bytes,etag:'synthetic-part'},sha256:output.sha256}:{operation,versionId:output.versionId,etag:'synthetic-stored'};await transaction(db=>storage.completeProjectImagePreparationStore(db,lease,action.actionId,result,runtime));}
 const preparation=(await transaction(db=>storage.publishProjectImagePreparation(db,lease,{bytes:output.bytes,sha256:output.sha256,etag:'synthetic-stored',cleanupConfirmed:true},runtime))).preparation;
 const providerId=randomUUID();await query("INSERT INTO higgsfield_connections(company_id,id,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,'connected',$3,$4,clock_timestamp()+interval '1 hour',$5)",[company,providerId,owner,JSON.stringify(sealHiggsfieldSecret({token:{access_token:'synthetic-only'}},{companyId:company,id:providerId,purpose:'oauth-connection'})),JSON.stringify(options.providerTools??[])]);
 // Synthetic principals/configuration are ordinary fixture data; run creation,
 // finite policy, dispatch, task reservation and completion use actual services.
 async function identity(role:string,capabilities:string[]):Promise<Row>{const agentId=randomUUID(),installationId=randomUUID(),token='ca_'+randomUUID()+randomUUID();await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,$3,'custom',$4,$5,'admins',$6)",[agentId,company,'Synthetic '+role,hashToken(token),owner,JSON.stringify(capabilities)]);await query("INSERT INTO plugin_installations(id,company_id,agent_id,installed_by,client_id,request_hash,plugin_id,manifest_version,runtime_config,character) VALUES($1,$2,$3,$4,$5,$6,'runpod','1.0.0',$7,'{}')",[installationId,company,agentId,owner,randomUUID(),hashToken(agentId),JSON.stringify({providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8'})]);await query('INSERT INTO studio_role_bindings(company_id,role_key,agent_id) VALUES($1,$2,$3)',[company,role,agentId]);return {...(await query('SELECT * FROM agents WHERE id=$1',[agentId])).rows[0],installationId,token};}
 const coordinator=await identity('coordinator',['studio.read','studio.write','tasks.write']),producer=await identity('comp',['studio.read','studio.write','tasks.write','storage.read','creative.read','creative.write']);
 async function api(path:string,method='GET',body?:unknown,status=200,token=sessions.owner){const response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Origin:origin,Cookie:'coatria_session='+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split('?')[0].split('/'));const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
 const policy=(await api(`companies/${company}/studio/projects/${project}/coordination`,'PUT',{clientId:randomUUID(),revision:0,coordinatorAgentId:coordinator.id,allowedRoleKeys:['comp'],status:'active',maxRuns:3,maxConcurrentRuns:1,expiresAt:new Date(Date.now()+3600000).toISOString(),...options.continuations===false?{}:{referenceGenerationContinuations:true},...options.generatedContinuations?{generatedContinuations:true}:{}})).policy;
 const parent=(await api(`companies/${company}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:coordinator.id,prompt:'Coordinate this exact synthetic reference-to-generation request.'},201)).run;
 const parentLease=await claimAgentRun(coordinator as any,{workerId:'synthetic-coordinator',claimId:randomUUID()});assert.equal(parentLease.run!.id,parent.id);
 const dispatched=(await executeAgentTool(coordinator as any,'studio_work_dispatch',{runId:parent.id,leaseToken:parentLease.leaseToken!,requestId:randomUUID(),arguments:{projectId:project,projectRevision:1,workItemId:work,policyRevision:policy.revision}})).result as Row;
 await finishAgentRun(coordinator as any,parent.id,'complete',{clientId:randomUUID(),leaseToken:parentLease.leaseToken!,result:'Dispatched exact generation specialist; no bytes, sharing or generation performed.'});
 const sourceLease=await claimAgentRun(producer as any,{workerId:'synthetic-generation',claimId:randomUUID()});assert.equal(sourceLease.run!.id,dispatched.childRunId);
 const tool=(name:string,args:unknown,requestId=randomUUID())=>executeAgentTool(producer as any,name,{runId:sourceLease.run!.id,leaseToken:sourceLease.leaseToken!,requestId,arguments:args});
 await tool('tasks_claim',{taskId:task,revision:1});
 const agentActor={...actor,agentId:producer.id,runId:sourceLease.run!.id};
 const projectRevision=(await query('SELECT revision FROM studio_projects WHERE id=$1',[project])).rows[0].revision;
 const proposal={clientId:randomUUID(),revision:preparation.revision,projectRevision,workItemId:work,role:'image',purpose:'Exact original generation objective using verified derivative'};
 const propose=(patch:Row={})=>transaction(db=>proposeProjectImagePreparationReference(db,agentActor,preparation.id,{...proposal,...patch}));
 const result=options.propose===false?null:await propose(),reference=result?.reference??null;
 const handoff=reference?.referenceGenerationHandoff??null;
 const finishProducer=()=>finishAgentRun(producer as any,sourceLease.run!.id,'complete',{clientId:randomUUID(),leaseToken:sourceLease.leaseToken!,result:'Saved exact derivative reference. Inspection and sharing await separate human consent; no generation performed.'});
 const adoptInput=(patch:Row={})=>({clientId:randomUUID(),referenceRevision:reference!.revision,requestHash:reference!.requestHash,handoffSha256:handoff!.handoffSha256,expiresInMinutes:20,inspectionConsent:true,...patch});
 const adopt=(input:unknown=adoptInput(),userId=admin)=>transaction(db=>adoptStudioReferenceGenerationInspection(db,{companyId:company,userId},reference!.id,input));
 const inspectionOptions:HiggsfieldReferenceOptions={availability:async()=>({enabled:true,code:'FIXTURE_ONLY',message:'Synthetic metadata inspection runtime only',expiresAt:new Date(Date.now()+3600000).toISOString(),qualificationSha256:'a'.repeat(64),catalogSha256:higgsfieldReferenceDigest(options.providerTools??[])})};
 const claim=()=>transaction(db=>claimHiggsfieldReference(db,{companyId:company,projectIds:[project]},inspectionOptions));
 return {company,owner,admin,member,actor,agentActor,project,shot,referenceTask,referenceWork,task,work,folder,file,version,sourceSha256,sourceBytes,output,preparation,providerId,connection,binding,coordinator,producer,policy,projectRevision,parent,parentLease,sourceLease,tool,proposal,propose,reference,handoff,finishProducer,adoptInput,adopt,claim,inspectionOptions,api,sessions};
}
