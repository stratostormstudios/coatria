import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import type {Membership} from '../src/lib/auth';
import {query,transaction} from '../src/lib/db';
import {setupStudio,createStudioProject} from '../src/lib/studio';
import {saveStudioCoordination} from '../src/lib/studio-coordination';
import {executeAgentTool} from '../src/lib/agent-tools';
import {createAgentRunInTransaction,claimAgentRun,heartbeatAgentRun,agentRunContext,finishAgentRun,authorizeStoredAgentRun,authorizeStoredStorageAgentRun} from '../src/lib/agent-runs';
import {authorizeStorageGrantAgent} from '../src/lib/project-storage-authority';
import {installedRuntimeContext} from '../src/lib/plugin-marketplace';
import {buildStudioInferenceRequest} from '../src/lib/studio-inference';
import {registerStudioGeneratedArtifact,loadStoredGeneratedArtifact} from '../src/lib/studio-generated-artifacts';
import {studioGeneratedFollowupAdvanceInput,studioGeneratedFollowupDispatchInput} from '../src/lib/studio-generated-followup-protocol';
import {studioCoordinationInput} from '../src/lib/studio-coordination-protocol';
import {handleApi} from '../src/lib/api';
import {studioCoordinatorObjective} from '../src/lib/studio-coordinator-objective';

const emulate=process.env.COATRIA_TEST_EMULATOR==='1',integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !emulate&&!!integration&&['127.0.0.1','localhost'].includes(new URL(integration).hostname);}catch{return false;}})();
type Row=Record<string,any>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const caps=['studio.read','studio.write','tasks.write','creative.read','creative.write','storage.read'];
const specs={image:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},video:{kind:'video',format:'mp4',width:16,height:16,codec:'h264',color:{mode:'not_required'},frameRate:{mode:'constant',numerator:24,denominator:1},audio:{mode:'none'}},audio:{kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:1}};
const denied=(error:any)=>error?.status===403||error?.status===409||error?.status===401;

test('generated continuation commands cannot supply revisions, source facts or replacement steps',()=>{
 const projectId=randomUUID(),workItemId=randomUUID(),advance={projectId,workItemId,step:'register'};
 assert(studioGeneratedFollowupAdvanceInput.safeParse(advance).success);
 for(const change of[{revision:1},{projectRevision:1},{archiveId:randomUUID()},{name:'Replacement'},{sha256:'a'.repeat(64)},{requestId:randomUUID()},{step:'generate'}])assert(!studioGeneratedFollowupAdvanceInput.safeParse({...advance,...change}).success);
 const dispatch={projectId,workItemId,archiveId:randomUUID(),projectRevision:1,policyRevision:1};assert(studioGeneratedFollowupDispatchInput.safeParse(dispatch).success);
 for(const change of[{agentId:randomUUID()},{capabilities:['*']},{retry:true},{sourceRunId:randomUUID()},{fileSha256:'a'.repeat(64)}])assert(!studioGeneratedFollowupDispatchInput.safeParse({...dispatch,...change}).success);
 const legacyPolicy=studioCoordinationInput.parse({clientId:randomUUID(),revision:0,coordinatorAgentId:randomUUID(),allowedRoleKeys:['comp'],status:'active',maxRuns:2,maxConcurrentRuns:1,expiresAt:'2099-01-01T00:00:00Z'});assert(!Object.hasOwn(legacyPolicy,'generatedContinuations'),'Omitted opt-in must not inject a field into legacy policy receipt hashes');
});

test('generated continuation executes exact leased tools against immutable synthetic verified sources',{skip:!emulate&&!localPostgres,timeout:180000},async t=>{
 const dbName='coatria_generated_followup_'+randomUUID().replaceAll('-',''),prior={pool:(globalThis as any).coatriaPool,url:process.env.DATABASE_URL,fetch:globalThis.fetch};
 let pool:Pool|undefined,control:Pool|undefined,stop:(()=>Promise<void>)|undefined,created=false,networkCalls=0;
 const insert=async(table:string,row:Row,c:{query:typeof query}={query})=>{const keys=Object.keys(row);return(await c.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(row))).rows[0];};
 const expiry=async()=>new Date((await query("SELECT clock_timestamp()+interval '1 day' AS at")).rows[0].at).toISOString();
 try{
  if(emulate){const{PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),pg=await PGlite.create();for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await pg.exec(await readFile('database/'+file,'utf8'));const socket=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://'+socket.getServerConn()+'/postgres');url.username='postgres';url.password='postgres';process.env.DATABASE_URL=url.href;pool=new Pool({connectionString:url.href,max:1});stop=async()=>{await socket.stop();await pg.close();};}
  else{control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000});await control.query('CREATE DATABASE '+dbName);created=true;const url=new URL(integration!);url.pathname='/'+dbName;process.env.DATABASE_URL=url.href;pool=new Pool({connectionString:url.href,max:6,connectionTimeoutMillis:10000,statement_timeout:15000});for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await pool.query(await readFile('database/'+file,'utf8'));}
  (globalThis as any).coatriaPool=pool;
  // A failure here proves these handlers attempted network I/O. Synthetic SQL
  // evidence is deliberately not a claim that decoding or a provider ran.
  globalThis.fetch=async()=>{networkCalls++;throw Error('Network access is forbidden in synthetic continuation tests');};

  async function fixture(kind:keyof typeof specs='image',options:{budget?:number;optIn?:boolean;reuse?:boolean;staffed?:boolean;singleAgent?:boolean}={}){
   const company=randomUUID(),producer=await insert('users',{name:'Original producer',email:randomUUID()+'@example.invalid',password_hash:'not-a-login'}),registrar=await insert('users',{name:'Continuation requester',email:randomUUID()+'@example.invalid',password_hash:'not-a-login'});
   await insert('companies',{id:company,name:'Synthetic generated continuation',slug:company,template:'blank'});for(const user of[producer,registrar])await insert('memberships',{company_id:company,user_id:user.id,role:'admin'});
   const memberA={companyId:company,userId:producer.id,role:'admin',user:producer} as Membership,memberB={companyId:company,userId:registrar.id,role:'admin',user:registrar} as Membership;
   const agents:Row[]=[];
   if(options.staffed){
    const session=randomUUID(),origin='http://localhost:4180';await insert('sessions',{token_hash:sha(session),user_id:producer.id,expires_at:await expiry()});
    async function api(path:string,method:string,body:unknown,expected=200){const response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Origin:origin,Cookie:'coatria_session='+session,'Content-Type':'application/json'},body:JSON.stringify(body)}),path.split('/')),result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;}
    const prefix=`companies/${company}/studio/staffing/proposals`,proposed=await api(prefix,'POST',{clientId:randomUUID(),templateId:'ai-production',brief:'A supervised generated-media company with reviewed specialist responsibilities.',teamSize:options.singleAgent?1:3,disciplines:['compositing'],reviewerHumanId:null,provider:{pluginId:'runpod',manifestVersion:'1.0.0',runtimeConfig:{providerId:'runpod',modelId:'Qwen/Qwen3.8-27B-FP8'}}},201),plan=proposed.proposal.plan,generation=plan.specialists.find((person:Row)=>person.roleKeys.includes('comp'));
    if(options.singleAgent){assert(generation.roleKeys.includes('coordinator'));assert(caps.every(cap=>generation.capabilities.includes(cap)));}else{assert.deepEqual(generation.roleKeys,['comp']);assert.deepEqual([...generation.capabilities].sort(),[...caps].sort());assert(!generation.capabilities.includes('storage.organize'));}assert.match(generation.character.persona,/reviewed storage.read grant/);assert(!generation.capabilities.includes('storage.write'));
    const approval={clientId:randomUUID(),revision:proposed.proposal.revision,planHash:proposed.proposal.planHash,profileRevision:proposed.proposal.profileRevision},applied=await api(prefix+'/'+proposed.proposal.id+'/apply','POST',approval,201);
    assert(applied.application.specialists.every((person:Row)=>person.status==='paused'&&person.connectionState==='unconnected'));assert.equal(applied.application.startsWorkers,false);assert.equal(applied.application.startsInference,false);assert.deepEqual((await api(prefix+'/'+proposed.proposal.id+'/apply','POST',approval)).application,applied.application);assert.equal((await query('SELECT count(*)::int n FROM agents WHERE company_id=$1',[company])).rows[0].n,options.singleAgent?1:3);assert.equal((await query('SELECT count(*)::int n FROM agent_runs WHERE company_id=$1',[company])).rows[0].n,0);
    for(const role of ['coordinator','comp']){const identity=applied.application.specialists.find((person:Row)=>person.roleKeys.includes(role));if(!agents.some(agent=>agent.id===identity.agentId))await api(`companies/${company}/plugin-installations/${identity.installationId}`,'PATCH',{revision:1,status:'active'});agents.push((await query('SELECT * FROM agents WHERE company_id=$1 AND id=$2',[company,identity.agentId])).rows[0]);}
   }else for(const name of['coordinator','specialist']){const agent=await insert('agents',{company_id:company,name,harness:'custom',created_by:producer.id,token_hash:sha(randomUUID()),capabilities:JSON.stringify(caps),invocation_access:'admins',expires_at:await expiry()});agents.push(agent);await insert('plugin_installations',{company_id:company,agent_id:agent.id,installed_by:producer.id,client_id:randomUUID(),request_hash:sha(randomUUID()),plugin_id:'runpod',manifest_version:'1.0.0',runtime_config:JSON.stringify({providerId:'runpod',modelId:'synthetic-only'}),character:'{}'});}
   const[coordinator,specialist]=agents;
   if(!options.staffed)await transaction(c=>setupStudio(c,{companyId:company,userId:producer.id},{clientId:randomUUID(),revision:0,templateId:'ai-production',templateVersion:1,assignments:[{roleKey:'coordinator',agentId:coordinator.id},{roleKey:'comp',agentId:specialist.id}]}));
   const p=(await transaction(c=>createStudioProject(c,{companyId:company,userId:producer.id},{clientId:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:'Generated '+kind,clientName:'Internal',brief:'Synthetic generation handoff; no paid outputs.',aiPolicy:'allowed',spec:specs[kind],shots:[{kind,code:'D010',description:'Synthetic exact source',...kind==='image'?{}:{durationMs:{min:999,max:1001}}}]}))).project;
   await query("UPDATE studio_projects SET gates=$3,status='production' WHERE company_id=$1 AND id=$2",[company,p.id,JSON.stringify({brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}})]);
   await query("UPDATE tasks SET status='done' WHERE company_id=$1 AND id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage NOT IN('generation','qc','delivery'))",[company,p.id]);
   const work=(await query("SELECT * FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage='generation'",[company,p.id])).rows[0];
   const projectRevision=async()=>Number((await query('SELECT revision FROM studio_projects WHERE id=$1',[p.id])).rows[0].revision);
   const task=async()=>(await query('SELECT * FROM tasks WHERE id=$1',[work.task_id])).rows[0];
   const policy=async()=>(await query('SELECT * FROM studio_coordination_policies WHERE company_id=$1 AND project_id=$2',[company,p.id])).rows[0];
   const approve=async(member:Membership,optIn:boolean,revision:number,coordinatorGeneration=Boolean(options.singleAgent))=>transaction(c=>saveStudioCoordination(c,member,p.id,{clientId:randomUUID(),revision,coordinatorAgentId:coordinator.id,allowedRoleKeys:['comp'],status:'active',maxRuns:options.budget??2,maxConcurrentRuns:1,expiresAt:new Date(Date.now()+3600000).toISOString(),...(optIn?{generatedContinuations:true}:{}),...(options.singleAgent?{coordinatorGeneration}:{})}));
   const tool=(agent:Row,lease:Row,name:string,args:Row,requestId=randomUUID())=>executeAgentTool(agent as any,name,{runId:lease.run.id,leaseToken:lease.leaseToken,requestId,arguments:args});
   const claim=(agent:Row,claimId=randomUUID())=>claimAgentRun(agent as any,{workerId:'synthetic-generated',claimId}) as Promise<Row>;
   const parent=async(member:Membership)=>{
     let runId:string;
     if(options.singleAgent){
      const session=randomUUID(),origin='http://localhost:4180';await insert('sessions',{token_hash:sha(session),user_id:member.userId,expires_at:await expiry()});
      const api=async(path:string,method:string,body:unknown,status=200)=>{const response=await handleApi(new Request(origin+'/api/'+path,{method,headers:{Origin:origin,Cookie:'coatria_session='+session,'Content-Type':'application/json'},body:JSON.stringify(body)}),path.split('/'));const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;};
      const path='companies/'+company+'/autonomy/missions',objective=studioCoordinatorObjective({id:p.id,contractVersion:2});
      const saved=await api(path,'POST',{clientId:randomUUID(),agentId:coordinator.id,name:'One-agent generated coordinator',objective,status:'paused',maxCycles:1,intervalMinutes:60},201);
      assert.equal(saved.mission.objective,objective);await api(path+'/'+saved.mission.id,'PATCH',{revision:saved.mission.revision,status:'active'});
      runId=(await api(path+'/'+saved.mission.id+'/run-now','POST',{clientId:randomUUID()},201)).runId;
     }else runId=(await transaction(c=>createAgentRunInTransaction(c,member,'commons',{clientId:randomUUID(),agentId:coordinator.id,prompt:'Coordinate the exact synthetic source.'}))).run.id;
     const lease=await claim(coordinator);assert.equal(lease.run.id,runId);return lease;
    };
   await approve(memberA,false,0,false);const firstParent=await parent(memberA);
    if(options.singleAgent){const args={projectId:p.id,workItemId:work.id,projectRevision:await projectRevision(),policyRevision:1};await assert.rejects(()=>tool(coordinator,firstParent,'studio_work_dispatch',args),(error:any)=>error.code==='COORDINATION_ROLE_REQUIRED');assert.equal((await policy()).runs_started,0);await approve(memberA,false,1,true);}
   const initial=(await tool(coordinator,firstParent,'studio_work_dispatch',{projectId:p.id,workItemId:work.id,projectRevision:await projectRevision(),policyRevision:(await policy()).revision})).result as Row;
    if(options.singleAgent){assert.equal((await claim(specialist)).run,null,'The same identity must not execute its queued child while the coordinator runs');await finishAgentRun(coordinator as any,firstParent.run.id,'complete',{clientId:randomUUID(),leaseToken:firstParent.leaseToken,result:'Queued one separate generation request; stop this coordinator cycle.'});}
    const source=await claim(specialist);assert.equal(source.run.id,initial.childRunId);
    if(options.singleAgent){assert.deepEqual([...source.run.capabilities].sort(),[...caps].sort());assert.notEqual(source.run.id,firstParent.run.id);await assert.rejects(()=>tool(specialist,source,'studio_coordination_get',{projectId:p.id}),(error:any)=>error.code==='COORDINATOR_GENERATION_SCOPE');const dispatchInput={projectId:p.id,workItemId:work.id,projectRevision:await projectRevision(),policyRevision:(await policy()).revision};await assert.rejects(()=>tool(specialist,source,'studio_work_dispatch',dispatchInput),denied);}
   await tool(specialist,source,'tasks_claim',{taskId:work.task_id,revision:(await task()).revision});
   const sourceTask=await task();let proposed:Row|undefined;const sourceConnectionId=randomUUID();
    if(options.singleAgent){
     await insert('higgsfield_connections',{company_id:company,id:sourceConnectionId,revision:1,status:'connected',connected_by:producer.id,sealed:'{}',expires_at:await expiry(),tools:JSON.stringify([{name:'generate_'+kind,description:'Synthetic official-tool fixture',inputSchema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']}}])});
     const requestId=randomUUID(),args={projectId:p.id,projectRevision:await projectRevision(),workItemId:work.id,tool:'generate_'+kind,arguments:{prompt:'Original synthetic '+kind+' for a reviewed workflow test'},note:'Await exact human credit consent; do not execute a provider.'};
     proposed=((await tool(specialist,source,'higgsfield_generation_propose',args,requestId)).result as Row).request;assert(proposed);assert.equal(proposed.status,'proposed');assert.equal(((await tool(specialist,source,'higgsfield_generation_propose',args,requestId)).result as Row).request.id,proposed.id);assert.equal(networkCalls,0);
    }
   await finishAgentRun(specialist as any,source.run.id,'complete',{clientId:randomUUID(),leaseToken:source.leaseToken,result:'Synthetic request prepared; waiting for independently approved generation and archive.'});
   if(!options.singleAgent)await finishAgentRun(coordinator as any,firstParent.run.id,'complete',{clientId:randomUUID(),leaseToken:firstParent.leaseToken,result:'Initial synthetic generation specialist stopped for human approval.'});
   const requestId=proposed?.id??randomUUID(),jobId=randomUUID(),outputId=randomUUID(),connectionId=proposed?sourceConnectionId:randomUUID(),providerJobId=randomUUID(),requestHash=proposed?.requestHash??sha(requestId),receiptHash=sha('receipt:'+requestId),identity=sha(outputId),bytes=1024,fileHash=sha('synthetic-byte-facts:'+requestId),contentType=kind==='image'?'image/png':kind==='video'?'video/mp4':'audio/wav';
   if(proposed)await query("UPDATE higgsfield_requests SET status='returned',approved_by=$2 WHERE id=$1",[requestId,registrar.id]);else await insert('higgsfield_requests',{id:requestId,company_id:company,project_id:p.id,requested_by:producer.id,agent_id:specialist.id,run_id:source.run.id,client_id:randomUUID(),project_revision:await projectRevision(),connection_id:connectionId,connection_revision:1,tool:'generate_'+kind,arguments:'{}',note:'Synthetic source request',request_hash:requestHash,status:'returned',approved_by:registrar.id,work_item_id:work.id,task_revision:sourceTask.revision,role_agent_id:specialist.id});
   await insert('higgsfield_job_receipts',{company_id:company,project_id:p.id,request_id:requestId,connection_id:connectionId,connection_revision:1,approved_by:registrar.id,request_hash:requestHash,contract:'synthetic-reviewed-contract',source_sha256:receiptHash,outcome:'jobs'});
   await insert('higgsfield_jobs',{id:jobId,company_id:company,project_id:p.id,request_id:requestId,connection_id:connectionId,provider_job_id:providerJobId,kind,status:'completed'});await insert('higgsfield_job_outputs',{id:outputId,company_id:company,project_id:p.id,job_id:jobId,kind,ordinal:0,locator_identity:identity});
   const storage=await insert('project_storage_connections',{company_id:company,name:'Synthetic verified storage',region:'US-CA-2',volume_id:'synthetic-only',secret_envelope:'{}',created_by:producer.id}),binding=await insert('project_storage_bindings',{company_id:company,project_id:p.id,connection_id:storage.id,created_by:producer.id});
   const snapshot={requestId,requestHash,receiptHash,contract:'synthetic-reviewed-contract',providerConnectionId:connectionId,requestConnectionRevision:1,providerSponsorId:producer.id,providerJobId,kind,model:null,outputId,ordinal:0,outputIdentity:identity,requestedBy:producer.id,agentId:specialist.id,runId:source.run.id,agentSponsorId:producer.id,approvedBy:registrar.id,workItemId:work.id,roleAgentId:specialist.id,roleHumanId:null,taskId:work.task_id,roleKey:work.role_key};
   const common={kind,format:specs[kind].format,bytes,sha256:fileHash,contentType,verification:'full_decode',inspectionVersion:1},color={space:null,primaries:null,transfer:null,range:null};
   const media=kind==='image'?{...common,width:16,height:16,codec:'png',color}:kind==='video'?{...common,width:16,height:16,codec:'h264',color,durationMs:1000,frameRate:{numerator:24,denominator:1},averageFrameRate:{numerator:24,denominator:1},vfr:false,frameCount:24,audio:null}:{...common,codec:'pcm_s16le',sampleRateHz:48000,channels:1,durationMs:1000,decodedSamples:48000};
   async function archive(){const currentRevision=await projectRevision(),archiveId=randomUUID(),fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID(),name='output-'+versionId+'.'+specs[kind].format;
    await insert('project_storage_files',{id:fileId,company_id:company,project_id:p.id,binding_id:binding.id,name,name_key:name,created_by:producer.id});await insert('project_storage_versions',{id:versionId,company_id:company,project_id:p.id,file_id:fileId,version:1,bytes,sha256:fileHash,content_type:contentType,object_key:`coatria/companies/${company}/projects/${p.id}/objects/${versionId}`,created_by:producer.id});
    await transaction(async c=>{await insert('higgsfield_output_archives',{id:archiveId,company_id:company,project_id:p.id,request_id:requestId,job_id:jobId,output_id:outputId,locator_identity:identity,source_snapshot:JSON.stringify(snapshot),provider_connection_id:connectionId,provider_connection_revision:1,storage_binding_id:binding.id,storage_binding_revision:binding.revision,storage_connection_id:storage.id,storage_connection_revision:storage.revision,storage_connection_snapshot:JSON.stringify({id:storage.id,region:storage.region,volumeId:storage.volume_id,sponsorId:producer.id,revision:storage.revision}),destination_name:name,destination_name_key:name,destination_ancestors:'[]',max_bytes:2048,project_revision:currentRevision,request_hash:sha(archiveId),proposed_by:registrar.id,status:'verified',approved_by:registrar.id,approved_at:'2026-01-01T00:00:00Z',expires_at:'2026-01-02T00:00:00Z',approved_project_revision:1,approved_binding_revision:binding.revision,upload_id:uploadId,version_id:versionId},c);await insert('project_storage_uploads',{id:uploadId,company_id:company,project_id:p.id,version_id:versionId,actor_key:'archive:'+archiveId,actor_user_id:registrar.id,archive_id:archiveId,client_id:randomUUID(),request_hash:sha(uploadId),status:'ready',part_bytes:67108864,provider_etag:'synthetic-etag',expires_at:'2026-01-02T00:00:00Z'},c);});
    await insert('higgsfield_archive_fetches',{company_id:company,project_id:p.id,archive_id:archiveId,locator_identity:identity,bytes,sha256:fileHash,media:JSON.stringify(media)});await insert('project_storage_verifications',{company_id:company,project_id:p.id,version_id:versionId,bytes,sha256:fileHash,provider_etag:'synthetic-etag',gateway_receipt_id:randomUUID()});return {archiveId,versionId,uploadId};
   }
   const archived=await archive();let existing:Row|undefined;if(options.reuse){const revision=await projectRevision();existing=await transaction(c=>registerStudioGeneratedArtifact(c,{companyId:company,userId:registrar.id},p.id,{clientId:randomUUID(),revision,workItemId:work.id,archiveId:archived.archiveId,name:'Existing exact generated artifact',notes:'Already registered.'}));}
   await approve(memberB,options.optIn!==false,(await policy()).revision);const parentLease=await parent(memberB);
   const dispatchArgs=async(archiveId=archived.archiveId)=>({projectId:p.id,workItemId:work.id,archiveId,projectRevision:await projectRevision(),policyRevision:(await policy()).revision});
   const dispatch=async(archiveId=archived.archiveId,requestId=randomUUID(),lease=parentLease)=>tool(coordinator,lease,'studio_generated_followup_dispatch',await dispatchArgs(archiveId),requestId).then(response=>({...response,result:(response.result as Row).continuation}));
   const advance=(lease:Row,step:'claim'|'register'|'submit',requestId=randomUUID())=>tool(specialist,lease,'studio_generated_followup_advance',{projectId:p.id,workItemId:work.id,step},requestId);
   const effects=async()=>({task:await task(),projectRevision:await projectRevision(),artifacts:(await query('SELECT id,version FROM studio_artifacts WHERE company_id=$1 AND project_id=$2 ORDER BY version',[company,p.id])).rows,contributions:(await query('SELECT id FROM contributions WHERE company_id=$1 AND task_id=$2',[company,work.task_id])).rows,policy:await policy(),followups:(await query('SELECT child_run_id FROM studio_generated_followups WHERE company_id=$1',[company])).rows});
   return {company,producer,registrar,memberA,memberB,coordinator,specialist,p,work,source,sourceTask,parentLease,parent,initial,archived,archive,snapshot,existing,storage,requestId,jobId,outputId,fileHash,tool,claim,dispatch,dispatchArgs,advance,effects,projectRevision,task,policy};
  }

  for(const singleAgent of[false,true])for(const kind of['image','video','audio'] as const)await t.test(kind+(singleAgent?' one-agent mission generation and continuation':' staffing-created specialist')+' claims, registers and submits exactly once even with new outer transport IDs',async()=>{
   const f=await fixture(kind,{staffed:true,singleAgent}),queued=(await f.dispatch()).result as Row;assert(queued.childRunId);assert.notEqual(queued.childRunId,f.source.run.id);assert.equal((await f.policy()).runs_started,2);assert.equal(((await f.dispatch()).result as Row).childRunId,queued.childRunId);
   if(singleAgent){assert.equal(f.coordinator.id,f.specialist.id);assert.equal((await f.claim(f.specialist)).run,null);await finishAgentRun(f.coordinator as any,f.parentLease.run.id,'complete',{clientId:randomUUID(),leaseToken:f.parentLease.leaseToken,result:'Queued exact verified-output continuation; end this cycle.'});}
   const claimId=randomUUID(),lease=await f.claim(f.specialist,claimId);assert.equal(lease.run.id,queued.childRunId);assert.equal(lease.run.maxAttempts,1);
   const replayedClaim=await f.claim(f.specialist,claimId);assert.equal(replayedClaim.replayed,true);assert.equal(replayedClaim.leaseToken,lease.leaseToken);assert.equal(replayedClaim.run.attempts,1);
   assert((await query('SELECT 1 FROM messages WHERE company_id=$1',[f.company])).rowCount! > 0,'Initial run completions create real conversation messages for a positive control');
   const context=await agentRunContext(f.specialist as any,lease.run.id,lease.leaseToken);assert.deepEqual(context.messages,[]);assert.deepEqual(context.generatedFollowup,{projectId:f.p.id,workItemId:f.work.id,taskId:f.work.task_id,archiveId:f.archived.archiveId,requestId:f.requestId,storageVersionId:f.archived.versionId,fileSha256:f.fileHash,specSha256:queued.specSha256,artifactId:null,nextStep:'claim',advanceTool:'studio_generated_followup_advance',serverOwnsOperationIds:true,contentInspected:false,canGenerate:false,canTransfer:false,canApprove:false});
   assert.equal((await heartbeatAgentRun(f.specialist as any,lease.run.id,{leaseToken:lease.leaseToken})).run.id,lease.run.id);
   const messagesBefore=(await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1',[f.company])).rows[0].count;
   await assert.rejects(()=>finishAgentRun(f.specialist as any,lease.run.id,'complete',{clientId:randomUUID(),leaseToken:lease.leaseToken,result:'Attempted premature completion'}),(error:any)=>error.code==='GENERATED_FOLLOWUP_INCOMPLETE');
   assert.equal((await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1',[f.company])).rows[0].count,messagesBefore);
   await assert.rejects(()=>f.advance(lease,'submit'),denied);
   for(const step of['claim','register','submit'] as const){const outer=randomUUID();await f.advance(lease,step,outer);const after=await f.effects();await f.advance(lease,step,outer);await f.advance(lease,step,randomUUID());assert.deepEqual(await f.effects(),after,'Repeating '+step+' changed durable state');}
   const state=await f.effects();assert.equal(state.task.status,'review');assert.equal(state.task.revision,f.sourceTask.revision+2);assert.equal(state.artifacts.length,1);assert.equal(state.contributions.length,1);assert.equal(state.followups.length,1);assert.equal(state.policy.runs_started,2);
   const submittedContext=await agentRunContext(f.specialist as any,lease.run.id,lease.leaseToken);assert.equal(submittedContext.generatedFollowup?.nextStep,'submitted');assert.equal(submittedContext.generatedFollowup?.artifactId,state.artifacts[0].id);assert.deepEqual(submittedContext.messages,[]);
   const artifact=await transaction(c=>loadStoredGeneratedArtifact(c,f.company,f.p.id,state.artifacts[0].id));assert.equal(artifact.artifact.mediaKind,kind);assert.equal(artifact.artifact.file.sha256,f.fileHash);assert.equal(artifact.artifact.producedBy,f.producer.id);assert.equal(artifact.artifact.producedAgentId,f.specialist.id);assert.equal(artifact.sourceSnapshot.runId,f.source.run.id);assert.equal(artifact.registeredBy,f.registrar.id);assert.equal(artifact.registeredRunId,queued.childRunId);assert.equal(artifact.artifact.reviewStatus,'pending');
   assert(!/secret_envelope|object_key|locator|https:|gateway_receipt_id/.test(artifact.manifestText));
   const stepRows=(await query('SELECT request_id,step FROM studio_generated_followup_steps WHERE company_id=$1 AND child_run_id=$2 ORDER BY step',[f.company,queued.childRunId])).rows;assert.deepEqual(stepRows.map(row=>row.step),['claim','registration','submission']);assert.equal(new Set(stepRows.map(row=>row.request_id)).size,3);assert.equal((await query('SELECT count(*)::int AS count FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id=ANY($3::uuid[])',[f.company,'agent:'+f.specialist.id,stepRows.map(row=>row.request_id)])).rows[0].count,3);
   assert.equal((await query('SELECT count(*)::int AS count FROM studio_reviews WHERE company_id=$1',[f.company])).rows[0].count,0);assert.equal((await query('SELECT count(*)::int AS count FROM higgsfield_requests WHERE company_id=$1',[f.company])).rows[0].count,1);
   const complete={clientId:randomUUID(),leaseToken:lease.leaseToken,result:'Exact synthetic archived media registered and submitted; independent review remains pending.'};await finishAgentRun(f.specialist as any,lease.run.id,'complete',complete);const finalMessages=(await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1',[f.company])).rows[0].count;assert.equal(finalMessages,messagesBefore+1);await finishAgentRun(f.specialist as any,lease.run.id,'complete',complete);assert.equal((await query('SELECT count(*)::int AS count FROM messages WHERE company_id=$1',[f.company])).rows[0].count,finalMessages);
  });

  await t.test('removing same-identity permission removes candidate eligibility without spending another run',async()=>{
   const f=await fixture('image',{staffed:true,singleAgent:true}),p=await f.policy();
   await transaction(db=>saveStudioCoordination(db,f.memberB,f.p.id,{clientId:randomUUID(),revision:p.revision,coordinatorAgentId:f.coordinator.id,allowedRoleKeys:['comp'],status:'active',maxRuns:p.max_runs,maxConcurrentRuns:p.max_concurrent_runs,expiresAt:new Date(p.expires_at).toISOString(),generatedContinuations:true,coordinatorGeneration:false}));
   const snapshot=(await f.tool(f.coordinator,f.parentLease,'studio_generated_followups_get',{projectId:f.p.id,archiveId:f.archived.archiveId})).result as Row;
   assert.equal(snapshot.candidates.length,1);assert.equal(snapshot.candidates[0].eligible,false);assert.match(snapshot.candidates[0].blocker,/coordinator identity/);
   await assert.rejects(()=>f.dispatch(),denied);assert.equal((await f.policy()).runs_started,1);
  });
  await t.test('same-identity continuation cannot begin after its coordinator cycle fails',async()=>{
   const f=await fixture('image',{staffed:true,singleAgent:true}),queued=(await f.dispatch()).result as Row;
   assert.equal((await f.claim(f.specialist)).run,null);
   await finishAgentRun(f.coordinator as any,f.parentLease.run.id,'fail',{clientId:randomUUID(),leaseToken:f.parentLease.leaseToken,error:'Synthetic coordinator failure; reconcile its queued effects.',retryable:false});
   assert.equal((await f.claim(f.specialist)).run,null);
   assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[queued.childRunId])).rows[0].status,'cancelled');
   const effects=await f.effects();assert.equal(effects.policy.runs_started,2);assert.equal(effects.artifacts.length,0);assert.equal(effects.task.agent_run_id,f.source.run.id);
  });
  await t.test('existing exact artifact is reused and not relabeled as produced by the continuation',async()=>{
   const f=await fixture('image',{reuse:true}),queued=(await f.dispatch()).result as Row,lease=await f.claim(f.specialist);assert.equal(lease.run.id,queued.childRunId);const before=await f.effects();
   for(const step of['claim','register','submit'] as const){await f.advance(lease,step);await f.advance(lease,step);}
   const after=await f.effects();assert.deepEqual(after.artifacts,before.artifacts);assert.equal(after.task.status,'review');assert.equal(after.contributions.length,1);const source=(await query('SELECT registered_by,registered_run_id FROM studio_generated_artifact_sources WHERE archive_id=$1',[f.archived.archiveId])).rows[0];assert.equal(source.registered_by,f.registrar.id);assert.equal(source.registered_run_id,null);
  });

  await t.test('scoped child cannot directly mutate tasks, generate, access files or delegate',async()=>{
   const f=await fixture(),queued=(await f.dispatch()).result as Row,lease=await f.claim(f.specialist),before=await f.effects();assert.equal(lease.run.id,queued.childRunId);
   const exact=(await f.tool(f.specialist,lease,'studio_get',{contractVersion:2,projectId:f.p.id,workItemId:f.work.id})).result as Row;assert.equal(exact.workItem.id,f.work.id);assert.equal(exact.project.contractVersion,2);
   for(const[name,args]of[
    ['tasks_claim',{taskId:f.work.task_id,revision:f.sourceTask.revision}],['tasks_submit',{taskId:f.work.task_id,revision:f.sourceTask.revision,summary:'Must not bypass advance'}],
    ['higgsfield_generation_propose',{projectId:f.p.id,projectRevision:await f.projectRevision(),workItemId:f.work.id,tool:'generate_image',arguments:{},note:'Forbidden duplicate generation'}],
    ['storage_file_access',{projectId:f.p.id,versionId:f.archived.versionId,disposition:'attachment'}],
    ['studio_generated_artifact_register',{projectId:f.p.id,revision:await f.projectRevision(),workItemId:f.work.id,archiveId:f.archived.archiveId,name:'Forbidden direct registration'}],
    ['studio_work_dispatch',{projectId:f.p.id,workItemId:f.work.id,projectRevision:await f.projectRevision(),policyRevision:(await f.policy()).revision}],
    ['studio_generated_followup_dispatch',await f.dispatchArgs()],
    ['studio_get',{contractVersion:2,projectId:f.p.id}],['studio_get',{contractVersion:2,projectId:f.p.id,workItemId:randomUUID()}],
    ['studio_generated_followup_advance',{projectId:f.p.id,workItemId:randomUUID(),step:'claim'}],['studio_generated_followup_advance',{projectId:randomUUID(),workItemId:f.work.id,step:'claim'}],
   ] as [string,Row][])await assert.rejects(()=>f.tool(f.specialist,lease,name,args),denied);
   assert.deepEqual(await f.effects(),before);assert.equal(networkCalls,0);
  });

  await t.test('a different archive of the same source cannot schedule another child or spend a budget unit',async()=>{
   const f=await fixture('image',{budget:3}),queued=(await f.dispatch()).result as Row,other=await f.archive(),before=await f.effects();await assert.rejects(()=>f.dispatch(other.archiveId),denied);assert.deepEqual(await f.effects(),before);assert.equal(((await f.dispatch()).result as Row).childRunId,queued.childRunId);
  });
  await t.test('stored inference authority remains valid while generated children are denied storage transfer authority',async()=>{
   const f=await fixture();await f.dispatch();const lease=await f.claim(f.specialist),proof=sha(lease.leaseToken),before=await f.effects();
   // The managed inference service uses this shared stored-lease entry point.
   // This is an authorization test only; no inference request is dispatched.
   const access=await transaction(client=>authorizeStoredAgentRun(client,f.specialist as any,lease.run.id,proof));assert.equal(access.run.id,lease.run.id);assert(access.capabilities.includes('storage.read'));
   await assert.rejects(()=>transaction(client=>authorizeStoredStorageAgentRun(client,f.specialist as any,lease.run.id,proof)),(error:any)=>error.status===403&&error.code==='GENERATED_FOLLOWUP_SCOPE');
   // Even an internally supplied grant with the exact current token/lease/user
   // cannot let a source-bound continuation download a file through the gateway.
   await assert.rejects(()=>transaction(client=>authorizeStorageGrantAgent(client,{company_id:f.company,agent_id:f.specialist.id,agent_token_hash:f.specialist.token_hash,run_id:lease.run.id,agent_lease_hash:proof,user_id:f.registrar.id,operation:'read'})),(error:any)=>error.status===403&&error.code==='STORAGE_ACCESS_DENIED');
   assert.deepEqual(await f.effects(),before);assert.equal(networkCalls,0);
  });
  await t.test('managed request assembly uses current exact continuation metadata without reading unrelated commons',async()=>{
   const f=await fixture();await f.dispatch();const lease=await f.claim(f.specialist),marker='Unrelated commons marker '+randomUUID();
   // Positive control: ordinary conversation rows really exist and contain a
   // unique body that would leak through the old managed-inference query.
   assert((await query('UPDATE messages SET body=$2 WHERE company_id=$1 RETURNING id',[f.company,marker])).rowCount! > 0);
   const observedMessages=(await query('SELECT id,body FROM messages WHERE company_id=$1 ORDER BY id',[f.company])).rows;assert(observedMessages.every(row=>row.body===marker));
   const state=async()=>({effects:await f.effects(),messages:(await query('SELECT id,body FROM messages WHERE company_id=$1 ORDER BY id',[f.company])).rows,inference:(await query('SELECT id FROM studio_inference_jobs WHERE company_id=$1',[f.company])).rows,reservations:(await query('SELECT inference_id FROM studio_inference_reservations WHERE company_id=$1',[f.company])).rows});
   for(const step of['claim','register','submit','submitted'] as const){
    const expected=(await agentRunContext(f.specialist as any,lease.run.id,lease.leaseToken)).generatedFollowup;assert.equal(expected?.nextStep,step);const before=await state(),assemblyQueries:string[]=[];
    const request=await transaction(async client=>{
     const access=await authorizeStoredAgentRun(client,f.specialist as any,lease.run.id,sha(lease.leaseToken)),installation=await installedRuntimeContext(client,f.company,f.specialist.id);assert(installation);
     const tracked=new Proxy(client,{get(target,key){if(key==='query')return (...args:any[])=>{const text=typeof args[0]==='string'?args[0]:args[0].text;assemblyQueries.push(text);assert(!/\b(?:FROM|JOIN)\s+(?:messages|conversations)\b/i.test(text),'Generated model request must not query or lock commons');return (target.query as any)(...args);};return Reflect.get(target,key,target);}});
     return buildStudioInferenceRequest(tracked,{...access,installation});
    });
    assert(assemblyQueries.some(sql=>sql.includes('studio_generated_followups')),'Assembly must read the actual durable continuation');assert.equal(request.model,'synthetic-only');assert.equal(request.stream,false);assert.equal(request.messages.length,2);assert.equal(request.messages[1].role,'user');
    const context=JSON.parse(request.messages[1].content);assert.deepEqual(Object.keys(context).sort(),['generatedFollowup','untrustedConversationContext','verifiedRequest']);assert.deepEqual(context.generatedFollowup,expected);assert.deepEqual(context.untrustedConversationContext,{messages:[]});assert.deepEqual(context.verifiedRequest,{id:lease.run.id,prompt:lease.run.prompt});assert(Buffer.byteLength(JSON.stringify(context.generatedFollowup))<=4096);assert(!JSON.stringify(request).includes(marker));assert(!/secret_envelope|object_key|locator_identity|claim_request_id|leaseToken/.test(request.messages[1].content));
    assert(request.tools?.some(tool=>tool.function.name==='studio_generated_followup_advance'));assert.deepEqual(await state(),before);assert.equal(networkCalls,0);
    if(step!=='submitted')await f.advance(lease,step);
   }
  });
  await t.test('explicit opt-in and remaining lifetime budget are required before queueing',async()=>{
   for(const options of[{optIn:false},{budget:1}]){const f=await fixture('image',options),before=await f.effects();await assert.rejects(()=>f.dispatch(),denied);assert.deepEqual(await f.effects(),before);}
  });
  await t.test('a coordinator requested by a different administrator cannot spend the current approver budget',async()=>{
   const f=await fixture();await finishAgentRun(f.coordinator as any,f.parentLease.run.id,'complete',{clientId:randomUUID(),leaseToken:f.parentLease.leaseToken,result:'The currently approved coordinator stopped without dispatching.'});const wrongParent=await f.parent(f.memberA),before=await f.effects();
   await assert.rejects(()=>f.dispatch(f.archived.archiveId,randomUUID(),wrongParent),(error:any)=>error.code==='COORDINATION_REQUESTER_REQUIRED');assert.deepEqual(await f.effects(),before);assert.equal((await f.policy()).runs_started,1);
  });
  await t.test('source, role, storage, policy and sponsor revocation block both old and fresh outer receipt IDs',async()=>{
   for(const revoke of[
    async(f:Awaited<ReturnType<typeof fixture>>)=>query('UPDATE higgsfield_output_archives SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1',[f.archived.archiveId,f.registrar.id]),
    async(f:Awaited<ReturnType<typeof fixture>>)=>query('UPDATE studio_role_bindings SET agent_id=NULL,human_id=$2 WHERE company_id=$1 AND role_key=\'comp\'',[f.company,f.registrar.id]),
    async(f:Awaited<ReturnType<typeof fixture>>)=>query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL WHERE id=$1",[f.storage.id]),
    async(f:Awaited<ReturnType<typeof fixture>>)=>query('UPDATE studio_coordination_policies SET revision=revision+1 WHERE company_id=$1',[f.company]),
    async(f:Awaited<ReturnType<typeof fixture>>)=>query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[f.company,f.producer.id]),
   ]){const f=await fixture(),queued=(await f.dispatch()).result as Row,claimId=randomUUID(),lease=await f.claim(f.specialist,claimId),outer=randomUUID();assert.equal(lease.run.id,queued.childRunId);await f.advance(lease,'claim',outer);await revoke(f);const before=await f.effects(),leaseBefore=(await query('SELECT lease_expires_at FROM agent_runs WHERE id=$1',[lease.run.id])).rows[0].lease_expires_at;
    await assert.rejects(()=>f.advance(lease,'claim',outer),denied);await assert.rejects(()=>f.advance(lease,'claim'),denied);await assert.rejects(()=>f.advance(lease,'register'),denied);await assert.rejects(()=>f.claim(f.specialist,claimId),denied);await assert.rejects(()=>agentRunContext(f.specialist as any,lease.run.id,lease.leaseToken),denied);await assert.rejects(()=>heartbeatAgentRun(f.specialist as any,lease.run.id,{leaseToken:lease.leaseToken}),denied);assert.deepEqual((await query('SELECT lease_expires_at FROM agent_runs WHERE id=$1',[lease.run.id])).rows[0].lease_expires_at,leaseBefore);assert.deepEqual(await f.effects(),before);}
  });
  await t.test('revocation before first claim cancels the scoped child without exposing a lease',async()=>{
   const f=await fixture(),queued=(await f.dispatch()).result as Row;await query('UPDATE studio_coordination_policies SET revision=revision+1 WHERE company_id=$1',[f.company]);assert.equal((await f.claim(f.specialist)).run,null);assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[queued.childRunId])).rows[0].status,'cancelled');assert.equal((await f.effects()).artifacts.length,0);assert.equal((await f.policy()).runs_started,2);
  });
  await t.test('failed continuation is terminal and repeated dispatch does not requeue it',async()=>{
   const f=await fixture(),queued=(await f.dispatch()).result as Row,lease=await f.claim(f.specialist);await finishAgentRun(f.specialist as any,lease.run.id,'fail',{clientId:randomUUID(),leaseToken:lease.leaseToken,error:'Synthetic uncertain harness result'});assert.equal((await query('SELECT status FROM agent_runs WHERE id=$1',[lease.run.id])).rows[0].status,'failed');assert.equal((await f.claim(f.specialist)).run,null);assert.equal(((await f.dispatch()).result as Row).childRunId,queued.childRunId);assert.equal((await f.policy()).runs_started,2);
  });
  await t.test('PostgreSQL distinct parent transactions reserve only one continuation and one budget unit',{skip:!localPostgres},async()=>{
   const f=await fixture(),proof=randomUUID()+randomUUID(),second=await transaction(c=>createAgentRunInTransaction(c,f.memberB,'commons',{clientId:randomUUID(),agentId:f.coordinator.id,prompt:'Synthetic second parent races the same exact source.'}));
   await query("UPDATE agent_runs SET status='running',worker_id='parallel-synthetic',lease_token_hash=$2,lease_expires_at=clock_timestamp()+interval '1 minute',started_at=clock_timestamp(),attempts=1 WHERE id=$1",[second.run.id,sha(proof)]);const other={run:second.run,leaseToken:proof},args=await f.dispatchArgs();
   const results=await Promise.all([f.parentLease,other].map(lease=>f.tool(f.coordinator,lease,'studio_generated_followup_dispatch',args)));assert.equal((results[0].result as Row).continuation.childRunId,(results[1].result as Row).continuation.childRunId);assert.equal((await f.effects()).followups.length,1);assert.equal((await f.policy()).runs_started,2);
  });
  await t.test('PostgreSQL concurrent fresh transport IDs serialize each canonical step without duplicate effects',{skip:!localPostgres},async()=>{
   const f=await fixture();await f.dispatch();const lease=await f.claim(f.specialist);
   for(const step of['claim','register','submit'] as const)await Promise.all([randomUUID(),randomUUID()].map(outer=>f.advance(lease,step,outer)));
   const after=await f.effects();assert.equal(after.artifacts.length,1);assert.equal(after.contributions.length,1);assert.equal(after.task.status,'review');assert.equal(after.task.revision,f.sourceTask.revision+2);assert.equal(after.policy.runs_started,2);
   assert.equal((await query('SELECT count(*)::int AS count FROM studio_requests WHERE company_id=$1 AND actor_key=$2 AND client_id IN(SELECT request_id FROM studio_generated_followup_steps WHERE company_id=$1 AND child_run_id=$3)',[f.company,'agent:'+f.specialist.id,lease.run.id])).rows[0].count,3);
  });
  await t.test('PostgreSQL cached advance cannot outlive approval while waiting for its outer receipt lock',{skip:!localPostgres,timeout:20000},async()=>{
   const f=await fixture();await f.dispatch();const lease=await f.claim(f.specialist),outer=randomUUID();await f.advance(lease,'claim',outer);
   const until=(await query("UPDATE studio_coordination_policies SET expires_at=clock_timestamp()+interval '2 seconds' WHERE company_id=$1 RETURNING expires_at",[f.company])).rows[0].expires_at,before=await f.effects(),blocker=await pool!.connect(),oldNow=Date.now;
   let pending:Promise<{error:unknown}|{value:unknown}>|undefined;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`agent-tool:${f.company}:${f.specialist.id}:${outer}`]);Date.now=()=>oldNow()-2*86400000;
    pending=f.advance(lease,'claim',outer).then(value=>({value}),error=>({error}));const waitDeadline=performance.now()+10000;
    while(!(await control!.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'",[dbName])).rowCount){if(performance.now()>waitDeadline)assert.fail('Expected actual outer receipt lock wait');await delay(20);}
    const remaining=Number((await control!.query('SELECT EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp())*1000 AS remaining',[until])).rows[0].remaining);await delay(Math.max(0,remaining)+35);await blocker.query('ROLLBACK');const result=await pending;assert('error'in result&&denied(result.error));assert.deepEqual(await f.effects(),before);
   }finally{Date.now=oldNow;await blocker.query('ROLLBACK');blocker.release();await pending;}
  });
  assert.equal(networkCalls,0);
 }finally{
  globalThis.fetch=prior.fetch;await pool?.end();await stop?.();if(prior.pool)(globalThis as any).coatriaPool=prior.pool;else delete(globalThis as any).coatriaPool;if(prior.url===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior.url;
  try{if(created){const deadline=performance.now()+10000;while((await control!.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[dbName])).rowCount){if(performance.now()>deadline)assert.fail('Disposable generated-followup DB sessions did not drain');await delay(25);}await control!.query('DROP DATABASE '+dbName);}}finally{await control?.end();}
 }
});
