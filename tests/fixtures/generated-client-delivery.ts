import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {hashToken} from '../../src/lib/security';

type Row=Record<string,any>;
export type GeneratedFixtureKind='image'|'video'|'audio';
export const generatedClientSpecs={image:{kind:'image',format:'png',width:16,height:16,color:{mode:'not_required'}},video:{kind:'video',format:'mp4',codec:'h264',width:16,height:16,color:{mode:'not_required'},frameRate:{mode:'constant',numerator:24,denominator:1},audio:{mode:'none'}},audio:{kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:1}};
const insert=async(db:Pick<PoolClient,'query'>,table:string,value:Row)=>{const keys=Object.keys(value);return(await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING *`,Object.values(value))).rows[0];};

/** Synthetic verified database evidence only. No decoder, provider, gateway or
 * production data is used. Call inside one transaction for deferred archive FKs. */
export async function seedGeneratedClientSource(db:Pick<PoolClient,'query'>,options:{companyId:string;projectId:string;workItemId:string;taskId:string;producerId:string;approverId:string;kind:GeneratedFixtureKind;storage?:{storageId:string;bindingId:string}}){
 const {companyId:company,projectId,workItemId,taskId,producerId:producer,approverId:approver,kind}=options,spec=generatedClientSpecs[kind];
 const connectionId=randomUUID(),requestId=randomUUID(),providerJobId=randomUUID(),jobId=randomUUID(),outputId=randomUUID(),archiveId=randomUUID(),storageId=options.storage?.storageId??randomUUID(),bindingId=options.storage?.bindingId??randomUUID(),fileId=randomUUID(),versionId=randomUUID(),uploadId=randomUUID();
 const destinationName='stored-'+versionId+'.'+spec.format,body=Buffer.from('Synthetic generated client media '+versionId),bytes=body.length,fileHash=hashToken(body.toString()),requestHash=hashToken(requestId),receiptHash=hashToken('receipt:'+requestId),identity=hashToken(outputId),contentType=kind==='image'?'image/png':kind==='video'?'video/mp4':'audio/wav';
 await insert(db,'higgsfield_requests',{id:requestId,company_id:company,project_id:projectId,requested_by:producer,client_id:randomUUID(),project_revision:1,connection_id:connectionId,connection_revision:1,tool:'generate_'+kind,arguments:'{}',note:'Synthetic media evidence, no provider operation',request_hash:requestHash,status:'returned',approved_by:approver,work_item_id:workItemId,task_revision:1,role_human_id:producer});
 await insert(db,'higgsfield_job_receipts',{request_id:requestId,company_id:company,project_id:projectId,connection_id:connectionId,connection_revision:1,approved_by:approver,request_hash:requestHash,contract:'synthetic-reviewed-contract',source_sha256:receiptHash,outcome:'jobs'});
 await insert(db,'higgsfield_jobs',{id:jobId,company_id:company,project_id:projectId,request_id:requestId,connection_id:connectionId,provider_job_id:providerJobId,kind,status:'completed'});
 await insert(db,'higgsfield_job_outputs',{id:outputId,company_id:company,project_id:projectId,job_id:jobId,ordinal:0,kind,locator_identity:identity});
 if(!options.storage){
  await insert(db,'project_storage_connections',{id:storageId,company_id:company,name:'Synthetic client storage',region:'US-CA-2',volume_id:'synthetic-client-volume',secret_envelope:'{}',created_by:producer});
  await insert(db,'project_storage_bindings',{id:bindingId,company_id:company,project_id:projectId,connection_id:storageId,created_by:producer});
 }
 await insert(db,'project_storage_files',{id:fileId,company_id:company,project_id:projectId,binding_id:bindingId,name:destinationName,name_key:destinationName,created_by:producer});
 await insert(db,'project_storage_versions',{id:versionId,company_id:company,project_id:projectId,file_id:fileId,version:1,bytes,sha256:fileHash,content_type:contentType,object_key:`coatria/companies/${company}/projects/${projectId}/objects/${versionId}`,created_by:producer});
 const sourceSnapshot={requestId,requestHash,receiptHash,contract:'synthetic-reviewed-contract',providerConnectionId:connectionId,requestConnectionRevision:1,providerSponsorId:producer,providerJobId,kind,model:null,outputId,ordinal:0,outputIdentity:identity,requestedBy:producer,agentId:null,runId:null,agentSponsorId:null,approvedBy:approver,workItemId,roleAgentId:null,roleHumanId:producer,taskId,roleKey:'comp'};
 const common={kind,format:spec.format,bytes,sha256:fileHash,contentType,verification:'full_decode',inspectionVersion:1},color={space:null,primaries:null,transfer:null,range:null};
 const media=kind==='image'?{...common,width:16,height:16,codec:'png',color}:kind==='video'?{...common,width:16,height:16,codec:'h264',color,durationMs:1000,frameRate:{numerator:24,denominator:1},averageFrameRate:{numerator:24,denominator:1},vfr:false,frameCount:24,audio:null}:{...common,codec:'pcm_s16le',sampleRateHz:48000,channels:1,durationMs:1000,decodedSamples:48000};
 await insert(db,'higgsfield_output_archives',{id:archiveId,company_id:company,project_id:projectId,request_id:requestId,job_id:jobId,output_id:outputId,locator_identity:identity,source_snapshot:JSON.stringify(sourceSnapshot),provider_connection_id:connectionId,provider_connection_revision:1,storage_binding_id:bindingId,storage_binding_revision:1,storage_connection_id:storageId,storage_connection_revision:1,storage_connection_snapshot:JSON.stringify({id:storageId,region:'US-CA-2',volumeId:'synthetic-client-volume',sponsorId:producer,revision:1}),destination_name:destinationName,destination_name_key:destinationName,destination_ancestors:'[]',max_bytes:2048,project_revision:1,request_hash:hashToken(archiveId),proposed_by:producer,status:'verified',approved_by:approver,approved_at:'2026-01-01T00:00:00Z',expires_at:'2026-01-02T00:00:00Z',approved_project_revision:1,approved_binding_revision:1,upload_id:uploadId,version_id:versionId});
 await insert(db,'project_storage_uploads',{id:uploadId,company_id:company,project_id:projectId,version_id:versionId,actor_key:'archive:'+archiveId,actor_user_id:approver,archive_id:archiveId,client_id:randomUUID(),request_hash:hashToken(uploadId),status:'ready',part_bytes:67108864,provider_etag:'"synthetic-etag"',expires_at:'2026-01-02T00:00:00Z'});
 await insert(db,'higgsfield_archive_fetches',{company_id:company,project_id:projectId,archive_id:archiveId,locator_identity:identity,bytes,sha256:fileHash,media:JSON.stringify(media)});
 await insert(db,'project_storage_verifications',{company_id:company,project_id:projectId,version_id:versionId,bytes,sha256:fileHash,provider_etag:'"synthetic-etag"',gateway_receipt_id:randomUUID()});
 return{archiveId,versionId,fileId,storageId,bindingId,requestId,jobId,outputId,uploadId,connectionId,sourceSnapshot,media,body,fileHash,bytes,contentType};
}

type FixtureCall=(path:string,method:string,payload:unknown,actor:'owner'|'registrar'|'reviewer',expected?:number)=>Promise<Row>;
export async function makeGeneratedClientPackageFixture(options:{db:Pick<PoolClient,'query'>;transaction:<T>(run:(client:PoolClient)=>Promise<T>)=>Promise<T>;call:FixtureCall;companyId:string;users:{owner:string;registrar:string;reviewer:string}},kind:GeneratedFixtureKind='image'){
 const {db,transaction,call,companyId,users}=options,prefix=`companies/${companyId}/studio/projects`;
 const made=await call(prefix,'POST',{clientId:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:'Synthetic generated '+kind+' '+randomUUID().slice(0,6),clientName:'Synthetic external client',brief:'Isolated generated package authority fixture. No actual media quality or client business decision.',aiPolicy:'allowed',spec:generatedClientSpecs[kind],shots:[{kind,code:'MEDIA010',description:'Synthetic generated deliverable',...kind==='image'?{}:{durationMs:{min:999,max:1001}}}]},'owner',201),projectId=made.project.id;
 const work=(await db.query("SELECT id,task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage='generation'",[companyId,projectId])).rows[0];
 await db.query("UPDATE tasks SET status='done' WHERE id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2 AND stage IN('estimate','breakdown','references'))",[companyId,projectId]);
 await db.query('UPDATE studio_projects SET gates=$3 WHERE company_id=$1 AND id=$2',[companyId,projectId,JSON.stringify({brief:{decision:'approved'},estimate:{decision:'approved'},production:{decision:'approved'}})]);
 const source=await transaction(client=>seedGeneratedClientSource(client,{companyId,projectId,workItemId:work.id,taskId:work.task_id,producerId:users.owner,approverId:users.owner,kind}));
 const registered=await call(`${prefix}/${projectId}/generated-artifacts`,'POST',{clientId:randomUUID(),revision:made.project.revision,workItemId:work.id,archiveId:source.archiveId,name:'Approved generated '+kind,notes:'Synthetic source evidence only'},'registrar',201);
 const reviewed=await call(`${prefix}/${projectId}/reviews`,'POST',{clientId:randomUUID(),revision:registered.project.revision,artifactId:registered.artifact.id,decision:'approved',note:'Synthetic independent media QC attestation',technicalQc:true},'reviewer',201);
 await db.query("UPDATE tasks SET status='done' WHERE id IN(SELECT task_id FROM studio_work_items WHERE company_id=$1 AND project_id=$2)",[companyId,projectId]);
 const packaged=await call(`${prefix}/${projectId}/deliveries`,'POST',{clientId:randomUUID(),revision:reviewed.project.revision,name:'Client package '+kind,artifactIds:[registered.artifact.id],note:'Exact synthetic approved package'},'owner',201);
 return{...source,projectId,workItemId:work.id,taskId:work.task_id,artifactId:registered.artifact.id,reviewId:reviewed.review.id,delivery:packaged.delivery,revision:packaged.project.revision};
}
