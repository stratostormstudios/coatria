import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {database,query,transaction} from '../src/lib/db';
import {hashToken} from '../src/lib/security';
import {sealHiggsfieldSecret} from '../src/lib/higgsfield-secrets';
import {recordHiggsfieldSubmission} from '../src/lib/higgsfield-jobs';
import {createProjectStorageConnection,bindProjectStorage} from '../src/lib/project-storage';
import {proposeHiggsfieldArchive,listHiggsfieldArchives,getHiggsfieldArchive,approveHiggsfieldArchive,revokeHiggsfieldArchive,authorizeHiggsfieldArchive} from '../src/lib/higgsfield-archives';
import {higgsfieldArchiveProposalInput,higgsfieldArchiveApproveInput,type HiggsfieldArchiveActor} from '../src/lib/higgsfield-archive-protocol';

test('archive proposals and finite human authority pin the actual source and project storage',{timeout:120000},async t=>{
 const previous={url:process.env.DATABASE_URL,pool:process.env.DATABASE_POOL_MAX,key:process.env.COATRIA_HOSTING_KEYRING,enabled:process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED,fetch:globalThis.fetch,savedPool:(globalThis as any).coatriaPool};
 const {PGlite}=await import('@electric-sql/pglite'),{PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),db=await PGlite.create();
 for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort())await db.exec(await readFile('database/'+file,'utf8'));
 const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();
 delete(globalThis as any).coatriaPool;process.env.DATABASE_URL='postgresql://postgres:postgres@'+server.getServerConn()+'/postgres';process.env.DATABASE_POOL_MAX='1';process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED='true';process.env.COATRIA_HOSTING_KEYRING=JSON.stringify({activeKeyId:'test',keys:{test:randomBytes(32).toString('base64')}});
 let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('No external calls in archive control tests');};
 async function fixture(sourceAgent=false){
  const company=randomUUID(),owner=randomUUID(),admin=randomUUID(),member=randomUUID(),outsider=randomUUID(),project=randomUUID(),connectionId=randomUUID(),task=randomUUID(),work=randomUUID(),request=randomUUID(),providerJob=randomUUID(),root=randomUUID(),parent=randomUUID();
  const sessions={owner:randomUUID(),admin:randomUUID(),member:randomUUID(),outsider:randomUUID()},users={owner,admin,member,outsider};
  for(const user of Object.values(users))await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Archive fixture',$2,'not-a-login')",[user,user+'@example.invalid']);
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Archive fixture',$2,'blank')",[company,company]);
  await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member')",[company,owner,admin,member]);
  for(const [name,user]of Object.entries(users))await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[hashToken(sessions[name as keyof typeof sessions]),user]);
  await query("INSERT INTO studio_profiles(company_id,template_id,template_version,created_by) VALUES($1,'ai-production',1,$2)",[company,owner]);
  const gates=Object.fromEntries(['brief','estimate','production'].map(gate=>[gate,{decision:'approved',recordedBy:admin}]));
  await query("INSERT INTO studio_projects(id,company_id,name,client_name,brief,spec,ai_policy,status,gates,created_by,production_path) VALUES($1,$2,'Original image','Internal','Synthetic approved original production','{}','allowed','production',$3,$4,'higgsfield')",[project,company,JSON.stringify(gates),owner]);
  const actor={companyId:company,userId:owner},adminActor={companyId:company,userId:admin},memberActor={companyId:company,userId:member};
  async function agent(caps=['creative.write','storage.read']){
   const agentId=randomUUID(),runId=randomUUID(),conversation=randomUUID();
   await query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,invocation_access,capabilities) VALUES($1,$2,'Archive proposer','custom',$3,$4,'admins',$5)",[agentId,company,hashToken(randomUUID()),owner,JSON.stringify(caps)]);
   await query('INSERT INTO conversations(id,company_id) VALUES($1,$2)',[conversation,company]);
   await query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities,status,worker_id,lease_token_hash,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic archive proposal',$8,'running','fixture',$9,clock_timestamp()+interval '1 hour')",[runId,company,agentId,owner,conversation,randomUUID(),'1'.repeat(64),JSON.stringify(caps),'2'.repeat(64)]);
   return {...actor,agentId,runId};
  }
  const producer=sourceAgent?await agent():null;
  await query("INSERT INTO tasks(id,company_id,title,created_by,assignee_id) VALUES($1,$2,'Generate original image',$3,$4)",[task,company,owner,sourceAgent?null:owner]);
  await query("INSERT INTO studio_work_items(id,company_id,project_id,logical_key,task_id,stage,role_key,execution) VALUES($1,$2,$3,'generation',$4,'generation','comp','creative')",[work,company,project,task]);
  await query("INSERT INTO studio_role_bindings(company_id,role_key,agent_id,human_id) VALUES($1,'comp',$2,$3)",[company,producer?.agentId??null,sourceAgent?null:owner]);
  const providerSecret='synthetic-provider-secret-'+randomUUID(),locator='https://media.reviewed.example/original.png?signature='+randomUUID();
  await query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,1,'connected',$3,$4,clock_timestamp()+interval '1 hour','[]')",[company,connectionId,owner,JSON.stringify(sealHiggsfieldSecret({token:{access_token:providerSecret}},{companyId:company,id:connectionId,purpose:'oauth-connection'}))]);
  const r=(await query("INSERT INTO higgsfield_requests(id,company_id,project_id,requested_by,agent_id,run_id,client_id,project_revision,connection_id,connection_revision,tool,arguments,note,request_hash,status,approved_by,dispatched_at,work_item_id,task_revision,role_agent_id,role_human_id) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,1,'generate_image','{}','Approved fixture',$9,'returned',$10,clock_timestamp(),$11,1,$5,$12) RETURNING *",[request,company,project,owner,producer?.agentId??null,producer?.runId??null,randomUUID(),connectionId,hashToken(request),admin,work,sourceAgent?null:owner])).rows[0];
  await transaction(client=>recordHiggsfieldSubmission(client,r,{content:[],structuredContent:{results:[{id:providerJob,type:'image',model:'synthetic-model',params:{prompt:'Original synthetic concept'},status:'completed',results:{rawUrl:locator}}]}}));
  const job=(await query('SELECT * FROM higgsfield_jobs WHERE request_id=$1',[request])).rows[0],output=(await query('SELECT * FROM higgsfield_job_outputs WHERE job_id=$1',[job.id])).rows[0];assert(output);
  const credentials={accessKeyId:'user_syntheticaccess',secretAccessKey:'rps_syntheticsecret'};
  const connection=(await transaction(client=>createProjectStorageConnection(client,actor,{clientId:randomUUID(),name:'Private studio storage',region:'US-CA-2',volumeId:'fixture-volume',...credentials}))).connection;
  const binding=(await transaction(client=>bindProjectStorage(client,actor,project,{clientId:randomUUID(),revision:0,connectionId:connection.id}))).binding;
  for(const [folderId,parentId,name]of[[root,null,'Delivery'],[parent,root,'Approved']])await query('INSERT INTO project_storage_folders(id,company_id,project_id,binding_id,parent_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[folderId,company,project,binding.id,parentId,name,String(name).toLowerCase(),owner]);
  const input=(patch:Record<string,unknown>={})=>({clientId:randomUUID(),projectId:project,projectRevision:1,jobId:job.id,outputId:output.id,outputIdentity:output.locator_identity,bindingId:binding.id,bindingRevision:1,parentId:parent,name:'original.png',maxBytes:100000,...patch});
  const propose=(data=input(),who:HiggsfieldArchiveActor=actor)=>transaction(client=>proposeHiggsfieldArchive(client,who,data));
  const approval=(archive:any,patch:Record<string,unknown>={})=>({clientId:randomUUID(),revision:archive.revision,requestHash:archive.requestHash,projectRevision:1,bindingRevision:1,expiresInHours:24,archiveConsent:true,...patch});
  const approve=(archive:any,data=approval(archive),who:HiggsfieldArchiveActor=adminActor)=>transaction(client=>approveHiggsfieldArchive(client,who,archive.id,data));
  const authorized=(archiveId:string,leaseId?:string)=>transaction(client=>authorizeHiggsfieldArchive(client,company,archiveId,{leaseId}));
  const approved=async()=>{const proposal=await propose();return (await approve(proposal.archive)).archive;};
  const get=(archiveId:string)=>transaction(client=>getHiggsfieldArchive(client,actor,archiveId));
  return {company,owner,admin,member,outsider,project,connectionId,task,work,request,providerJob,root,parent,sessions,actor,adminActor,memberActor,producer,agent,providerSecret,locator,credentials,job,output,connection,binding,input,propose,approval,approve,authorized,approved,get};
 }
 try{
  await t.test('proposal is honest, scoped, idempotent, bounded and secret-free',async()=>{
   const f=await fixture(),input=f.input(),result=await f.propose(input),a=result.archive;
   assert.equal(a.status,'proposed');assert.equal(a.bytesVerified,false);assert.equal(a.fetched,null);assert.equal(a.approvedBy,null);assert.equal(a.versionId,null);assert.equal(a.sourceAttribution.requestedBy,f.owner);assert.equal(a.sourceAttribution.approvedBy,f.admin);assert.deepEqual(a.destination.ancestors.map((item:any)=>item.name),['Delivery','Approved']);
   for(const value of[f.locator,f.providerSecret,f.credentials.secretAccessKey,'sealed','lease_id'])assert(!JSON.stringify(result).includes(value));
   assert.equal((await f.propose(input)).replayed,true);await assert.rejects(()=>f.propose({...input,name:'changed.png'}),{code:'IDEMPOTENCY_CONFLICT'});
   await assert.rejects(()=>f.authorized(a.id),{code:'HIGGSFIELD_ARCHIVE_AUTHORITY_ENDED'});
   for(const patch of[{maxBytes:0},{maxBytes:100*1024**3+1},{name:'../outside.png'},{locator:f.locator},{approvedBy:f.owner}])assert.equal(higgsfieldArchiveProposalInput.safeParse(f.input(patch)).success,false);
   const saved=(await query('SELECT * FROM higgsfield_output_archives WHERE id=$1',[a.id])).rows[0];assert.equal(saved.source_snapshot.requestHash,hashToken(f.request));assert.equal(saved.source_snapshot.providerJobId,f.providerJob);assert.equal(saved.storage_connection_snapshot.sponsorId,f.owner);
  });
  await t.test('only a current human administrator can approve exact reviewed revisions and finite consent',async()=>{
   const f=await fixture(),a=(await f.propose()).archive;
   await assert.rejects(()=>f.approve(a,undefined,f.memberActor));const agent=await f.agent();await assert.rejects(()=>f.approve(a,undefined,agent));
   for(const patch of[{requestHash:'0'.repeat(64)},{revision:2},{projectRevision:2},{bindingRevision:2}])await assert.rejects(()=>f.approve(a,f.approval(a,patch)),{code:'HIGGSFIELD_ARCHIVE_REVISION_CONFLICT'});
   for(const patch of[{archiveConsent:false},{expiresInHours:0},{expiresInHours:25}])assert.equal(higgsfieldArchiveApproveInput.safeParse(f.approval(a,patch)).success,false);
   const input=f.approval(a),approved=await f.approve(a,input);assert.equal(approved.archive.status,'queued');assert.equal(approved.archive.revision,2);assert.equal(+new Date(approved.archive.expiresAt)-+new Date(approved.archive.approvedAt),24*3600*1000);assert.equal((await f.approve(a,input)).replayed,true);
   await f.authorized(a.id);assert.equal((await query('SELECT count(*)::int count FROM higgsfield_archive_receipts WHERE archive_id=$1',[a.id])).rows[0].count,1);assert.equal((await query('SELECT count(*)::int count FROM project_storage_uploads WHERE company_id=$1',[f.company])).rows[0].count,0);
  });
  await t.test('foreign projects, jobs, outputs, folders, bindings, file identities and cursors cannot be substituted',async()=>{
   const a=await fixture(),b=await fixture();
   for(const patch of[{projectId:b.project},{jobId:b.job.id},{outputId:b.output.id},{outputIdentity:'0'.repeat(64)},{bindingId:b.binding.id},{parentId:b.parent},{fileId:randomUUID()}])await assert.rejects(()=>a.propose(a.input(patch)));
   const saved=(await a.propose()).archive;await assert.rejects(()=>transaction(client=>getHiggsfieldArchive(client,b.actor,saved.id)));await assert.rejects(()=>transaction(client=>listHiggsfieldArchives(client,a.actor,{projectId:b.project})));await assert.rejects(()=>transaction(client=>listHiggsfieldArchives(client,a.actor,{projectId:a.project,after:randomUUID()})));
   await a.propose();const page=await transaction(client=>listHiggsfieldArchives(client,a.actor,{projectId:a.project,limit:1}));assert.equal(page.archives.length,1);assert.equal(page.hasMore,true);const next=await transaction(client=>listHiggsfieldArchives(client,a.actor,{projectId:a.project,limit:1,after:page.nextAfter}));assert.notEqual(next.archives[0].id,page.archives[0].id);
  });
  await t.test('operational gate blocks new approvals without hiding reviewed requests, revocation or exact old receipts',async()=>{
   const f=await fixture(),a=(await f.propose()).archive,input=f.approval(a);delete process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED;
   try{
    await assert.rejects(()=>f.approve(a,input),{code:'HIGGSFIELD_ARCHIVE_UNAVAILABLE'});assert.equal((await f.get(a.id)).archive.status,'proposed');await f.propose();
    process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED='true';await f.approve(a,input);delete process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED;assert.equal((await f.approve(a,input)).replayed,true);
    assert.equal((await transaction(client=>revokeHiggsfieldArchive(client,f.adminActor,a.id,{clientId:randomUUID(),revision:2}))).archive.status,'cancelled');
   }finally{process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED='true';}
  });
  await t.test('agent proposal revalidates explicit capabilities and current run but approved archive outlives source/proposal leases',async()=>{
   const f=await fixture(true),agent=f.producer!;
   await assert.rejects(()=>f.propose(f.input(),{...agent,runId:undefined}),{code:'AGENT_RUN_REQUIRED'});
   for(const [table,column,where]of[['agents','capabilities','id'],['agent_runs','capabilities','id']]){
    const id=table==='agents'?agent.agentId:agent.runId;await query(`UPDATE ${table} SET ${column}='["storage.read"]' WHERE ${where}=$1`,[id]);await assert.rejects(()=>f.propose(f.input(),agent),{code:'AGENT_CAPABILITY_REQUIRED'});await query(`UPDATE ${table} SET ${column}='["storage.read","creative.write"]' WHERE ${where}=$1`,[id]);
   }
   await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[agent.runId]);await assert.rejects(()=>f.propose(f.input(),agent),{code:'AGENT_CAPABILITY_REQUIRED'});await query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[agent.runId]);
   const a=(await f.propose(f.input(),agent)).archive;assert.equal(a.proposedAgentId,agent.agentId);assert.equal(a.sourceAttribution.agentId,agent.agentId);assert.equal(a.sourceAttribution.agentSponsorId,f.owner);
   await f.approve(a);await query("UPDATE agent_runs SET status='succeeded',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL WHERE id=$1",[agent.runId]);await query("UPDATE agents SET status='revoked' WHERE id=$1",[agent.agentId]);await f.authorized(a.id);
  });
  await t.test('source, account, sponsor, task role and destination semantic changes immediately end archive authority',async()=>{
   const changes:Array<(f:Awaited<ReturnType<typeof fixture>>)=>Promise<unknown>>=[
    f=>query("UPDATE memberships SET role='member' WHERE company_id=$1 AND user_id=$2",[f.company,f.admin]),
    f=>query("UPDATE higgsfield_connections SET status='disconnected',sealed=NULL WHERE company_id=$1",[f.company]),
    f=>query('UPDATE higgsfield_connections SET id=$2 WHERE company_id=$1',[f.company,randomUUID()]),
    f=>query('UPDATE higgsfield_connections SET connected_by=$2 WHERE company_id=$1',[f.company,f.admin]),
    f=>query("UPDATE higgsfield_requests SET status='uncertain' WHERE id=$1",[f.request]),
    f=>query('UPDATE higgsfield_job_receipts SET connection_revision=connection_revision+1 WHERE request_id=$1',[f.request]),
    f=>query("UPDATE higgsfield_jobs SET status='conflict' WHERE id=$1",[f.job.id]),
    f=>query('UPDATE higgsfield_job_outputs SET locator_identity=$2 WHERE id=$1',[f.output.id,'0'.repeat(64)]),
    f=>query("UPDATE studio_role_bindings SET human_id=$2 WHERE company_id=$1 AND role_key='comp'",[f.company,f.admin]),
    f=>query('UPDATE project_storage_connections SET revision=revision+1 WHERE id=$1',[f.connection.id]),
    f=>query("UPDATE project_storage_connections SET status='revoked',secret_envelope=NULL WHERE id=$1",[f.connection.id]),
    f=>query('UPDATE project_storage_connections SET created_by=$2 WHERE id=$1',[f.connection.id,f.admin]),
    f=>query("UPDATE project_storage_connections SET volume_id='different-volume' WHERE id=$1",[f.connection.id]),
    f=>query("UPDATE project_storage_folders SET name='Changed',name_key='changed' WHERE id=$1",[f.root]),
    f=>query('UPDATE project_storage_folders SET parent_id=NULL WHERE id=$1',[f.parent]),
    f=>query("UPDATE studio_projects SET gates='{}' WHERE id=$1",[f.project]),
    f=>query("UPDATE studio_projects SET ai_policy='restricted' WHERE id=$1",[f.project]),
    f=>query("UPDATE studio_projects SET status='delivered' WHERE id=$1",[f.project]),
   ];
   for(const change of changes){const f=await fixture(),a=await f.approved();await change(f);await assert.rejects(()=>f.authorized(a.id));}
  });
  await t.test('unrelated catalog/project/binding revisions can be freshly reviewed and do not end approved authority',async()=>{
   const f=await fixture(),a=(await f.propose()).archive;
   await query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[f.project]);await query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[f.binding.id]);await query('UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[f.company]);
   await assert.rejects(()=>f.approve(a),{code:'HIGGSFIELD_ARCHIVE_REVISION_CONFLICT'});const approved=(await f.approve(a,f.approval(a,{projectRevision:2,bindingRevision:2}))).archive;assert.equal(approved.approvedProjectRevision,2);assert.equal(approved.approvedBindingRevision,2);
   await query('UPDATE studio_projects SET revision=revision+1 WHERE id=$1',[f.project]);await query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[f.binding.id]);await query('UPDATE higgsfield_connections SET revision=revision+1 WHERE company_id=$1',[f.company]);await f.authorized(a.id);
  });
  await t.test('leases, expiry and explicit human revocation fence worker authority without claiming byte deletion',async()=>{
   const f=await fixture(),a=await f.approved(),lease=randomUUID();await f.authorized(a.id);await assert.rejects(()=>f.authorized(a.id,''));await assert.rejects(()=>f.authorized(a.id,lease),{code:'HIGGSFIELD_ARCHIVE_LEASE_ENDED'});
   await query("UPDATE higgsfield_output_archives SET status='fetching',lease_id=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[a.id,lease]);await f.authorized(a.id,lease);await assert.rejects(()=>f.authorized(a.id,randomUUID()),{code:'HIGGSFIELD_ARCHIVE_LEASE_ENDED'});
   await query("UPDATE higgsfield_output_archives SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[a.id]);await assert.rejects(()=>f.authorized(a.id,lease),{code:'HIGGSFIELD_ARCHIVE_LEASE_ENDED'});await f.authorized(a.id);
   const input={clientId:randomUUID(),revision:a.revision,note:'Stop this archive'};
   await assert.rejects(()=>transaction(client=>revokeHiggsfieldArchive(client,f.memberActor,a.id,input)));const revoked=await transaction(client=>revokeHiggsfieldArchive(client,f.adminActor,a.id,input));assert.equal(revoked.archive.status,'cancelled');assert.equal(revoked.storedBytesDeleted,false);assert.equal((await transaction(client=>revokeHiggsfieldArchive(client,f.adminActor,a.id,input))).replayed,true);await assert.rejects(()=>f.authorized(a.id),{code:'HIGGSFIELD_ARCHIVE_AUTHORITY_ENDED'});
   const next=await f.approved();await query("UPDATE higgsfield_output_archives SET approved_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[next.id]);await assert.rejects(()=>f.authorized(next.id),{code:'HIGGSFIELD_ARCHIVE_AUTHORITY_ENDED'});
  });
  await t.test('worker allocation is its own archive principal, preserves the approved path and needs actual verification evidence',async()=>{
   const f=await fixture(),a=await f.approved(),file=randomUUID(),version=randomUUID(),upload=randomUUID(),sha=hashToken('synthetic');
   await transaction(async client=>{
    await client.query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,parent_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[file,f.company,f.project,f.binding.id,f.parent,a.destination.name,a.destination.name.toLowerCase(),f.admin]);
    await client.query("INSERT INTO project_storage_versions(id,company_id,project_id,file_id,version,bytes,sha256,content_type,object_key,created_by) VALUES($1,$2,$3,$4,1,9,$5,'image/png',$6,$7)",[version,f.company,f.project,file,sha,`coatria/companies/${f.company}/projects/${f.project}/objects/${version}`,f.admin]);
    await client.query('INSERT INTO project_storage_uploads(id,company_id,project_id,version_id,actor_key,actor_user_id,client_id,request_hash,part_bytes,expires_at,archive_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,67108864,clock_timestamp()+interval \'1 hour\',$9)',[upload,f.company,f.project,version,'archive:'+a.id,f.admin,randomUUID(),a.requestHash,a.id]);
    await client.query("UPDATE higgsfield_output_archives SET status='uploading',version_id=$2,upload_id=$3 WHERE id=$1",[a.id,version,upload]);await client.query('UPDATE project_storage_bindings SET revision=revision+1 WHERE id=$1',[f.binding.id]);
   });
   await f.authorized(a.id);assert.equal((await f.get(a.id)).archive.destination.fileId,null);assert.equal((await f.get(a.id)).archive.bytesVerified,false);
   await query("UPDATE project_storage_files SET name='Moved.png',name_key='moved.png' WHERE id=$1",[file]);await assert.rejects(()=>f.authorized(a.id),{code:'HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED'});await query('UPDATE project_storage_files SET name=$2,name_key=$3 WHERE id=$1',[file,a.destination.name,a.destination.name.toLowerCase()]);
   await query('INSERT INTO higgsfield_archive_fetches(company_id,project_id,archive_id,locator_identity,bytes,sha256,media) VALUES($1,$2,$3,$4,9,$5,$6)',[f.company,f.project,a.id,a.outputIdentity,sha,JSON.stringify({kind:'image',contentType:'image/png'})]);
   await query("UPDATE higgsfield_output_archives SET status='verified' WHERE id=$1",[a.id]);await query("UPDATE project_storage_uploads SET status='ready' WHERE id=$1",[upload]);assert.equal((await f.get(a.id)).archive.bytesVerified,false);
   await query('INSERT INTO project_storage_verifications(company_id,project_id,version_id,bytes,sha256,provider_etag,gateway_receipt_id) VALUES($1,$2,$3,9,$4,\'synthetic-etag\',$5)',[f.company,f.project,version,sha,randomUUID()]);assert.equal((await f.get(a.id)).archive.bytesVerified,true);assert.deepEqual((await f.get(a.id)).archive.fetched,{bytes:9,sha256:sha});
   await assert.rejects(()=>transaction(client=>client.query("UPDATE project_storage_uploads SET actor_key='human:'||actor_user_id::text WHERE id=$1",[upload])),{code:'23514'});
   const revoked=await transaction(client=>revokeHiggsfieldArchive(client,f.adminActor,a.id,{clientId:randomUUID(),revision:a.revision}));assert.equal(revoked.archive.status,'verified');assert(revoked.archive.revokedAt);assert.equal(revoked.archive.bytesVerified,true);assert.equal(revoked.storedBytesDeleted,false);
   await query('DELETE FROM companies WHERE id=$1',[f.company]);for(const table of['higgsfield_output_archives','higgsfield_archive_fetches','higgsfield_archive_receipts','project_storage_uploads','project_storage_versions','project_storage_verifications'])assert.equal((await query(`SELECT count(*)::int count FROM ${table} WHERE company_id=$1`,[f.company])).rows[0].count,0);
  });
  await t.test('existing destination files are explicit, exact and cannot be replaced by another same-name identity',async()=>{
   const f=await fixture(),file=randomUUID();await query('INSERT INTO project_storage_files(id,company_id,project_id,binding_id,parent_id,name,name_key,created_by) VALUES($1,$2,$3,$4,$5,\'original.png\',\'original.png\',$6)',[file,f.company,f.project,f.binding.id,f.parent,f.owner]);
   await assert.rejects(()=>f.propose(),{code:'HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED'});const a=(await f.propose(f.input({fileId:file}))).archive;await f.approve(a);await f.authorized(a.id);await query('UPDATE project_storage_files SET parent_id=NULL WHERE id=$1',[file]);await assert.rejects(()=>f.authorized(a.id),{code:'HIGGSFIELD_ARCHIVE_DESTINATION_CHANGED'});
  });
  await t.test('actual HTTP routes enforce origin/member/admin boundaries and return no source transport or worker lease',async()=>{
   const {handleApi}=await import('../src/lib/api'),f=await fixture(),prefix=`companies/${f.company}/higgsfield/archives`;
   async function call(path:string,method:string,payload:unknown,who:keyof typeof f.sessions,expected:number,origin='https://coatria.com'){
    const response=await handleApi(new Request('https://coatria.com/api/'+path,{method,headers:{Origin:origin,Cookie:'coatria_session='+f.sessions[who],'Content-Type':'application/json'},...payload===undefined?{}:{body:JSON.stringify(payload)}}),path.split('?')[0].split('/'));const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));for(const text of[f.locator,f.providerSecret,'sealed','lease_id','leaseId',f.credentials.secretAccessKey])assert(!JSON.stringify(value).includes(text));return value;
   }
   await call(prefix,'POST',f.input(),'member',403,'https://attacker.example');const proposal=await call(prefix,'POST',f.input(),'member',201);await call(prefix+'/'+proposal.archive.id+'/approve','POST',f.approval(proposal.archive),'member',403);const approved=await call(prefix+'/'+proposal.archive.id+'/approve','POST',f.approval(proposal.archive),'admin',200);assert.equal(approved.archive.status,'queued');await call(prefix+'/'+proposal.archive.id,'GET',undefined,'outsider',404);
   const lease=randomUUID();await query("UPDATE higgsfield_output_archives SET lease_id=$2,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[proposal.archive.id,lease]);const view=await call(prefix+'/'+proposal.archive.id,'GET',undefined,'member',200);assert(!JSON.stringify(view).includes(lease));const list=await call(prefix+'?projectId='+f.project,'GET',undefined,'member',200);assert.equal(list.archives.length,1);
  });
  await t.test('company removal deletes archive dependency evidence without deleting shared user identities',async()=>{
   const f=await fixture(),a=await f.approved();await query('DELETE FROM companies WHERE id=$1',[f.company]);for(const table of['higgsfield_output_archives','higgsfield_archive_fetches','higgsfield_archive_receipts','higgsfield_archive_requests'])assert.equal((await query(`SELECT count(*)::int count FROM ${table} WHERE company_id=$1`,[f.company])).rows[0].count,0);assert.equal((await query('SELECT count(*)::int count FROM users WHERE id=$1',[f.owner])).rows[0].count,1);assert(a.id);
  });
  assert.equal(outbound,0);
 }finally{
  globalThis.fetch=previous.fetch;await database().end();if(previous.savedPool)(globalThis as any).coatriaPool=previous.savedPool;else delete(globalThis as any).coatriaPool;await server.stop();await db.close();
  for(const[key,value]of Object.entries({DATABASE_URL:previous.url,DATABASE_POOL_MAX:previous.pool,COATRIA_HOSTING_KEYRING:previous.key,COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:previous.enabled})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
