import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {transaction} from './db';
import {requireMembership,requireUser,type User} from './auth';
import {memberMutation} from './company';
import {ApiError,assertOrigin,body,fail,hashToken,id,json,rateLimit} from './security';
import {canonicalStudioMedia,createStudioMediaProvider,type StudioMediaProvider} from './studio-media';
import {studioProjectDetail} from './studio';
import {STUDIO_CLIENT_DELIVERY_MAX_DAYS,STUDIO_CLIENT_DELIVERY_MAX_FILES,studioClientDeliveryCreateInput,studioClientDeliveryRevokeInput,studioClientDeliveryAccessInput,studioClientDeliveryResponseInput,studioClientDeliveryListInput,type StudioClientPackage,type StudioClientDeliveryFile} from './studio-client-delivery-protocol';

type Row=Record<string,any>;
const providerDefault=createStudioMediaProvider();
const digest=(value:unknown)=>hashToken(canonicalStudioMedia(value));
const iso=(value:string|Date)=>new Date(value).toISOString();
const columns=`s.id,s.project_id AS "projectId",s.delivery_id AS "deliveryId",s.recipient_user_id AS "recipientUserId",s.recipient_name AS "recipientName",s.identity_basis AS "identityBasis",s.email_verified_at_creation AS "emailVerifiedAtCreation",s.status,s.revision,s.expires_at AS "expiresAt",s.created_at AS "createdAt",s.created_by AS "createdBy",s.package_hash AS "packageSha256",s.source_manifest_hash AS "sourceManifestSha256",s.expires_at<=clock_timestamp() AS expired,jsonb_array_length(s.package_snapshot->'files') AS "fileCount"`;
async function shareView(client:PoolClient,companyId:string,shareId:string){
 const share=(await client.query(`SELECT ${columns} FROM studio_client_deliveries s WHERE s.company_id=$1 AND s.id=$2`,[companyId,shareId])).rows[0];if(!share)fail(404,'Client delivery not found.');
 const counts=(await client.query("SELECT kind,count(*)::int AS count FROM studio_client_delivery_receipts WHERE company_id=$1 AND share_id=$2 GROUP BY kind",[companyId,shareId])).rows;
 const count=(kind:string)=>counts.find(row=>row.kind===kind)?.count??0;
 return {...share,expiresAt:iso(share.expiresAt),createdAt:iso(share.createdAt),invitationPath:`/delivery/${shareId}`,transferStatus:'not_observed',response:count('acknowledged')?'acknowledged':count('changes_requested')?'changes_requested':'awaiting_response',receiptSummary:{portalOpened:count('portal_opened'),downloadAccessIssued:count('download_access_issued'),clientAcknowledged:count('acknowledged'),changesRequested:count('changes_requested')}};
}
async function once(client:PoolClient,companyId:string,userId:string,clientId:string,operation:string,data:unknown,run:()=>Promise<Row>){
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`studio-client-delivery:${companyId}:${userId}:${clientId}`]);
 const requestHash=digest({operation,data}),prior=(await client.query('SELECT request_hash,response FROM studio_client_delivery_requests WHERE company_id=$1 AND actor_user_id=$2 AND client_id=$3',[companyId,userId,clientId])).rows[0];
 if(prior){if(prior.request_hash!==requestHash)fail(409,'This request ID was already used for different data.','IDEMPOTENCY_CONFLICT');return {...prior.response,replayed:true};}
 const result=await run();await client.query('INSERT INTO studio_client_delivery_requests(company_id,actor_user_id,client_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[companyId,userId,clientId,requestHash,JSON.stringify(result)]);return {...result,replayed:false};
}
async function externalAccount(client:PoolClient,companyId:string,userId:string){
 // Joining a company takes this same advisory lock, including when there is no
 // membership row yet. An invited teammate cannot race an external-client act.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`invite:${companyId}:${userId}`]);
 const user=(await client.query('SELECT id,name,(email_verified_at IS NOT NULL) AS verified FROM users WHERE id=$1',[userId])).rows[0];
 if(!user||(await client.query('SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=$2',[companyId,userId])).rowCount)fail(403,'Use a separate external client account that has not belonged to this company.','CLIENT_IDENTITY_REQUIRED');
 return user;
}
async function activeGrant(client:PoolClient,user:User,shareId:string,options:{write?:boolean;project?:boolean}={}){
 // Locate only a grant belonging to this authenticated account. The locator is
 // not sufficient to disclose even the company name to a different account.
 const located=(await client.query('SELECT company_id,project_id FROM studio_client_deliveries WHERE id=$1 AND recipient_user_id=$2',[shareId,user.id])).rows[0];if(!located)fail(404,'Client delivery not found for this account.');
 await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[located.company_id]);
 await externalAccount(client,located.company_id,user.id);
 // Sponsor permission loss fences every new access without changing old receipts.
 const sponsor=(await client.query("SELECT m.user_id FROM studio_client_deliveries s JOIN memberships m ON m.company_id=s.company_id AND m.user_id=s.created_by WHERE s.id=$1 AND m.role IN ('owner','admin') FOR SHARE OF m",[shareId])).rows[0];if(!sponsor)fail(403,'The studio must renew client access through an active administrator.','CLIENT_GRANT_UNAVAILABLE');
 if(options.project)await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[located.company_id,located.project_id]);
 const grant=(await client.query(`SELECT * FROM studio_client_deliveries WHERE id=$1 AND recipient_user_id=$2 FOR ${options.write?'UPDATE':'SHARE'}`,[shareId,user.id])).rows[0];
 if(!grant||grant.status!=='active'||new Date(grant.expires_at).getTime()<=Date.now())fail(410,'This client delivery access has expired or been revoked.','CLIENT_GRANT_UNAVAILABLE');
 return grant;
}
async function eligibleDelivery(client:PoolClient,companyId:string,projectId:string,deliveryId:string){
 const delivery=(await client.query('SELECT * FROM studio_deliveries WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,projectId,deliveryId])).rows[0];if(!delivery)fail(404,'Delivery package not found.');
 const detail=await studioProjectDetail(client,companyId,projectId);
 if(detail.project.gates.production?.decision!=='approved'||detail.workItems.some(work=>work.status!=='done'))fail(409,'Production and independent delivery-handoff review must be complete before client delivery.','CLIENT_DELIVERY_NOT_READY');
 const selected=delivery.manifest?.artifacts;
 if(!Array.isArray(selected)||!selected.length||selected.length>100||new Set(selected.map((a:Row)=>a.id)).size!==selected.length)fail(409,'This delivery package has no valid approved artifact snapshot.','CLIENT_PACKAGE_UNAVAILABLE');
 for(const a of selected){const current=detail.artifacts.find(item=>item.id===a.id);if(!current||current.sha256!==a.sha256||current.version!==a.version||current.reviewStatus!=='approved'||detail.artifacts.some(item=>item.workItemId===current.workItemId&&item.version>current.version))fail(409,'This package no longer matches the latest independently approved versions.','CLIENT_PACKAGE_SUPERSEDED');}
 const finalWork=detail.workItems.filter(work=>work.stage==='qc').flatMap(work=>work.dependencies);if(finalWork.some(workId=>!selected.some((a:Row)=>a.workItemId===workId)))fail(409,'This package does not cover every final shot.','CLIENT_PACKAGE_UNAVAILABLE');
 return {delivery,detail};
}
async function packageSnapshot(client:PoolClient,companyId:string,projectId:string,delivery:Row,recipientUserId:string):Promise<StudioClientPackage>{
 const files:StudioClientDeliveryFile[]=[],artifacts:StudioClientPackage['artifacts']=[];
 if(delivery.created_by===recipientUserId)fail(403,'The package preparer cannot act as its external client.','CLIENT_IDENTITY_REQUIRED');
 for(const snapshot of delivery.manifest.artifacts){
  const source=(await client.query('SELECT a.*,p.manifest_text,p.manifest_sha256 FROM studio_artifacts a JOIN studio_media_promotions p ON p.company_id=a.company_id AND p.project_id=a.project_id AND p.artifact_id=a.id WHERE a.company_id=$1 AND a.project_id=$2 AND a.id=$3',[companyId,projectId,snapshot.id])).rows[0];
  if(!source||source.sha256!==snapshot.sha256||source.manifest_sha256!==source.sha256||hashToken(source.manifest_text)!==source.sha256)fail(409,'Client delivery requires approved artifacts backed by verified private files. External URLs alone cannot be delivered by this portal.','CLIENT_PRIVATE_MEDIA_REQUIRED');
  if([source.produced_by,source.agent_sponsor_id,source.metadata?.executionProvenance?.connectorSponsorId].includes(recipientUserId))fail(403,'A producer or sponsor cannot act as the external client.','CLIENT_IDENTITY_REQUIRED');
  let sequence:Row;try{sequence=JSON.parse(source.manifest_text);}catch{fail(409,'The verified sequence manifest is unavailable.','CLIENT_PACKAGE_UNAVAILABLE');}
  if(sequence.kind!=='verified_image_sequence'||!Array.isArray(sequence.frames)||!sequence.frames.length||sequence.frames.length>STUDIO_CLIENT_DELIVERY_MAX_FILES)fail(409,'A complete verified image sequence is required.','CLIENT_PACKAGE_UNAVAILABLE');
  artifacts.push({id:source.id,name:source.name,version:source.version,sha256:source.sha256});
  if(sequence.frames.some((frame:Row)=>!z.string().uuid().safeParse(frame.fileId).success))fail(409,'The verified sequence contains an invalid file reference.','CLIENT_PACKAGE_UNAVAILABLE');
  const verified=(await client.query('SELECT f.id,f.output_path,f.frame,f.sha256,f.bytes::float8 AS bytes,f.content_type FROM studio_media_files f JOIN studio_media_verifications v ON v.company_id=f.company_id AND v.file_id=f.id AND v.sha256=f.sha256 AND v.bytes=f.bytes WHERE f.company_id=$1 AND f.project_id=$2 AND f.job_id=$3 AND f.id=ANY($4::uuid[])',[companyId,projectId,sequence.jobId,sequence.frames.map((frame:Row)=>frame.fileId)])).rows;
  const verifiedById=new Map(verified.map(file=>[file.id,file]));
  for(const frame of sequence.frames){
   const file=verifiedById.get(frame.fileId);
   if(!file||file.sha256!==frame.sha256||file.bytes!==frame.bytes||file.frame!==frame.frame||file.output_path!==frame.path)fail(409,'Every package frame must have matching stored-byte verification.','CLIENT_PRIVATE_MEDIA_REQUIRED');
   files.push({fileId:file.id,artifactId:source.id,path:file.output_path,frame:file.frame,sha256:file.sha256,bytes:file.bytes,contentType:file.content_type});
   if(files.length>STUDIO_CLIENT_DELIVERY_MAX_FILES)fail(409,'This package exceeds the client portal file limit.','CLIENT_PACKAGE_TOO_LARGE');
  }
 }
 if(new Set(files.map(file=>file.fileId)).size!==files.length)fail(409,'A client package must contain each physical file once.','CLIENT_PACKAGE_UNAVAILABLE');
 return {schemaVersion:1,delivery:{id:delivery.id,name:delivery.name,preparedAt:iso(delivery.created_at)},project:{id:projectId,name:delivery.manifest.project.name,clientName:delivery.manifest.project.clientName,spec:delivery.manifest.project.spec},sourceManifestSha256:digest(delivery.manifest),reviewBasis:'independently_approved',artifacts,files};
}
async function createShare(client:PoolClient,companyId:string,actorId:string,projectId:string,data:z.infer<typeof studioClientDeliveryCreateInput>){
 const recipient=await externalAccount(client,companyId,data.recipientUserId);
 const result=await once(client,companyId,actorId,data.clientId,'create:'+projectId,data,async()=>{
  const project=(await client.query('SELECT revision,status,created_by FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,projectId])).rows[0];if(!project)fail(404,'Studio project not found.');if(project.revision!==data.revision)fail(409,'The studio project changed. Refresh before sharing.','STUDIO_REVISION_CONFLICT');
  if(project.status==='delivered')fail(409,'Create follow-up work for a project already accepted by the client.','CLIENT_DELIVERY_CLOSED');
  const until=Date.parse(data.expiresAt);if(until<=Date.now()||until>Date.now()+STUDIO_CLIENT_DELIVERY_MAX_DAYS*86400000)fail(400,'Client access must expire within 30 days.','CLIENT_EXPIRY_INVALID');
  if(data.recipientUserId===actorId||data.recipientUserId===project.created_by)fail(403,'The studio operator cannot act as the external client.','CLIENT_IDENTITY_REQUIRED');
  if(Number((await client.query('SELECT count(*) FROM studio_client_deliveries WHERE company_id=$1 AND project_id=$2',[companyId,projectId])).rows[0].count)>=100)fail(409,'This project reached its client invitation limit.');
  const {delivery}=await eligibleDelivery(client,companyId,projectId,data.deliveryId);if(delivery.status!=='prepared')fail(409,'Use an unacknowledged delivery package.','CLIENT_DELIVERY_CLOSED');
  const snapshot=await packageSnapshot(client,companyId,projectId,delivery,data.recipientUserId),shareId=randomUUID();
  await client.query("INSERT INTO studio_client_deliveries(id,company_id,project_id,delivery_id,recipient_user_id,recipient_name,identity_basis,email_verified_at_creation,created_by,expires_at,source_manifest_hash,package_hash,package_snapshot) VALUES($1,$2,$3,$4,$5,$6,'account_confirmed_out_of_band',$7,$8,$9,$10,$11,$12)",[shareId,companyId,projectId,delivery.id,recipient.id,recipient.name,recipient.verified,actorId,data.expiresAt,snapshot.sourceManifestSha256,digest(snapshot),JSON.stringify(snapshot)]);
  await client.query('INSERT INTO studio_client_delivery_files(company_id,project_id,share_id,file_id,artifact_id) SELECT $1,$2,$3,files.file_id,files.artifact_id FROM unnest($4::uuid[],$5::uuid[]) AS files(file_id,artifact_id)',[companyId,projectId,shareId,snapshot.files.map(file=>file.fileId),snapshot.files.map(file=>file.artifactId)]);
  await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[companyId,actorId,'studio.client_access_created','An administrator granted one externally confirmed client account access to an exact approved package. No invitation was sent and no download was observed.']);return {shareId};
 });return {share:await shareView(client,companyId,result.shareId),replayed:result.replayed};
}
export async function studioClientDeliveryList(client:PoolClient,companyId:string,projectId:string,input:z.infer<typeof studioClientDeliveryListInput>){
 if(!(await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,projectId])).rowCount)fail(404,'Studio project not found.');
 if(input.after&&!(await client.query('SELECT id FROM studio_client_deliveries WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,projectId,input.after])).rowCount)fail(404,'Client delivery page cursor not found.');
 const rows=(await client.query('SELECT id FROM studio_client_deliveries WHERE company_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',[companyId,projectId,input.after??null,input.limit+1])).rows,shares=[];
 for(const row of rows.slice(0,input.limit))shares.push(await shareView(client,companyId,row.id));return {shares,page:{hasMore:rows.length>input.limit,nextAfter:rows.length>input.limit?shares.at(-1)!.id:null,limit:input.limit}};
}
async function receipt(client:PoolClient,grant:Row,userId:string,kind:string,note:string|null=null,fileId:string|null=null){
 if(['portal_opened','download_access_issued'].includes(kind)&&Number((await client.query("SELECT count(*) FROM studio_client_delivery_receipts WHERE company_id=$1 AND share_id=$2 AND kind IN ('portal_opened','download_access_issued')",[grant.company_id,grant.id])).rows[0].count)>=5000)fail(409,'This invitation reached its access-receipt limit. Ask the studio to issue a replacement.');
 return (await client.query('INSERT INTO studio_client_delivery_receipts(company_id,share_id,actor_user_id,kind,file_id,note,package_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,kind,actor_user_id AS "actorUserId",file_id AS "fileId",note,package_hash AS "packageSha256",created_at AS "createdAt"',[grant.company_id,grant.id,userId,kind,fileId,note,grant.package_hash])).rows[0];
}
function queryInput(request:Request){const params=new URL(request.url).searchParams;if(new Set(params.keys()).size!==[...params.keys()].length)fail(400,'Duplicate page parameters.');const input=studioClientDeliveryListInput.safeParse(Object.fromEntries(params));if(!input.success)fail(400,'Use valid delivery page parameters.');return input.data;}
async function detail(client:PoolClient,user:User,shareId:string,input:z.infer<typeof studioClientDeliveryListInput>){
 const grant=await activeGrant(client,user,shareId),share=await shareView(client,grant.company_id,grant.id);
 if(input.after&&!(await client.query('SELECT id FROM studio_client_delivery_receipts WHERE company_id=$1 AND share_id=$2 AND id=$3',[grant.company_id,grant.id,input.after])).rowCount)fail(404,'Receipt page cursor not found.');
 const rows=(await client.query('SELECT id,kind,actor_user_id AS "actorUserId",file_id AS "fileId",note,package_hash AS "packageSha256",created_at AS "createdAt" FROM studio_client_delivery_receipts WHERE company_id=$1 AND share_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',[grant.company_id,grant.id,input.after??null,input.limit+1])).rows;
 let responseBlockedReason:string|null=share.response!=='awaiting_response'?'Your response to this exact package is already recorded. Ask the studio for a new version if further changes are needed.':null;
 if(!responseBlockedReason){try{const ready=await eligibleDelivery(client,grant.company_id,grant.project_id,grant.delivery_id);if(ready.detail.project.status==='delivered')responseBlockedReason='This project already has recorded acceptance. Ask the studio for follow-up work.';}catch(error){if(!(error instanceof ApiError)||error.status>=500)throw error;responseBlockedReason=error.message;}}
 return {share,package:grant.package_snapshot,receipts:rows.slice(0,input.limit),receiptPage:{hasMore:rows.length>input.limit,nextAfter:rows.length>input.limit?rows[input.limit-1].id:null,limit:input.limit},canRespond:responseBlockedReason===null,responseBlockedReason,identity:{userId:user.id,name:user.name,emailVerified:user.emailVerified}};
}
async function recordClientResponse(client:PoolClient,user:User,shareId:string,data:z.infer<typeof studioClientDeliveryResponseInput>){
 const grant=await activeGrant(client,user,shareId,{write:true,project:true});
 return once(client,grant.company_id,user.id,data.clientId,'respond:'+shareId,data,async()=>{
  if(grant.revision!==data.revision)fail(409,'Client delivery access changed. Refresh before responding.','CLIENT_DELIVERY_REVISION_CONFLICT');
  if((await client.query("SELECT id FROM studio_client_delivery_receipts WHERE company_id=$1 AND share_id=$2 AND kind IN ('acknowledged','changes_requested')",[grant.company_id,grant.id])).rowCount)fail(409,'Your response to this package is already recorded.','CLIENT_RESPONSE_RECORDED');
  const project=(await client.query('SELECT * FROM studio_projects WHERE company_id=$1 AND id=$2',[grant.company_id,grant.project_id])).rows[0];
  if(project.status==='delivered')fail(409,'A client acceptance is already recorded for this project. Ask the studio for follow-up work.','CLIENT_DELIVERY_CLOSED');
  const {delivery}=await eligibleDelivery(client,grant.company_id,grant.project_id,grant.delivery_id);if(digest(delivery.manifest)!==grant.source_manifest_hash)fail(409,'This package no longer matches its immutable invitation snapshot.','CLIENT_PACKAGE_UNAVAILABLE');
  const result=await receipt(client,grant,user.id,data.decision,data.note),gate={decision:data.decision==='acknowledged'?'approved':'changes_requested',note:data.note,recordedBy:user.id,at:new Date().toISOString(),deliveryId:grant.delivery_id,source:'authenticated_external_client',clientDeliveryId:grant.id,clientReceiptId:result.id,packageSha256:grant.package_hash};
  await client.query('INSERT INTO studio_gate_events(company_id,project_id,gate,decision,note,recorded_by,delivery_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[grant.company_id,grant.project_id,'client_acceptance',gate.decision,data.note,user.id,grant.delivery_id]);
  await client.query('UPDATE studio_projects SET gates=$3,status=$4,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[grant.company_id,grant.project_id,JSON.stringify({...project.gates,client_acceptance:gate}),data.decision==='acknowledged'?'delivered':'review']);
  if(data.decision==='acknowledged')await client.query("UPDATE studio_deliveries SET status='acknowledged' WHERE company_id=$1 AND project_id=$2 AND id=$3",[grant.company_id,grant.project_id,grant.delivery_id]);
  await client.query('UPDATE studio_client_deliveries SET revision=revision+1 WHERE id=$1',[grant.id]);
  await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)',[grant.company_id,user.id,'studio.client_response',data.decision==='acknowledged'?'The designated authenticated external client acknowledged the exact approved delivery package. This is a client attestation, not proof that every file was downloaded.':'The designated authenticated external client requested changes to the exact delivery package. Existing versions remain immutable.']);
  return {receipt:result,share:await shareView(client,grant.company_id,grant.id),project:{id:grant.project_id,revision:project.revision+1,status:data.decision==='acknowledged'?'delivered':'review'}};
 });
}
export async function studioClientDeliveryRoute(request:Request,parts:string[],method:string,provider:StudioMediaProvider=providerDefault):Promise<Response|null>{
 const companyRoute=parts[0]==='companies'&&parts[2]==='studio'&&parts[3]==='projects'&&parts[5]==='client-deliveries';
 const clientRoute=parts[0]==='client-deliveries';if(!companyRoute&&!clientRoute)return null;
 if(method!=='GET')assertOrigin(request);
 if(companyRoute){
  const companyId=id(parts[1]),projectId=id(parts[4]),member=await requireMembership(request,companyId,method!=='GET');
  if(parts.length===6&&method==='GET')return json(await memberMutation(member,false,client=>studioClientDeliveryList(client,companyId,projectId,queryInput(request))));
  if(parts.length===6&&method==='POST'){const data=await body(request,studioClientDeliveryCreateInput),result=await memberMutation(member,true,client=>createShare(client,companyId,member.userId,projectId,data));return json(result,result.replayed?200:201);}
  if(parts.length===8&&parts[7]==='revoke'&&method==='POST'){
   const shareId=id(parts[6]),data=await body(request,studioClientDeliveryRevokeInput),result=await memberMutation(member,true,async client=>{
    return once(client,companyId,member.userId,data.clientId,'revoke:'+shareId,data,async()=>{await client.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,projectId]);const grant=(await client.query('SELECT * FROM studio_client_deliveries WHERE company_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[companyId,projectId,shareId])).rows[0];if(!grant)fail(404,'Client delivery not found.');if(grant.revision!==data.revision)fail(409,'Client access changed. Refresh before revoking.','CLIENT_DELIVERY_REVISION_CONFLICT');if(grant.status==='active'){await client.query("UPDATE studio_client_deliveries SET status='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=$1",[shareId]);await receipt(client,grant,member.userId,'revoked');}return {share:await shareView(client,companyId,shareId)};});
   });return json(result);
  }
  return null;
 }
 const user=await requireUser(request);
 if(parts.length===2&&parts[1]==='identity'&&method==='GET')return json({user:{id:user.id,name:user.name,email:user.email,emailVerified:user.emailVerified},identityBasis:'authenticated_account',instructions:'Give your account ID directly to the studio through your existing trusted communication channel. An email address or display name alone is not verified identity.'});
 if(parts.length<2)return null;const shareId=id(parts[1]);
 if(parts.length===2&&method==='GET')return json(await transaction(client=>detail(client,user,shareId,queryInput(request))));
 if(parts.length===3&&parts[2]==='manifest'&&method==='GET'){
  const grant=await transaction(client=>activeGrant(client,user,shareId));return new Response(canonicalStudioMedia(grant.package_snapshot),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="coatria-delivery-manifest.json"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Content-SHA256':grant.package_hash}});
 }
 if(parts.length===3&&parts[2]==='open'&&method==='POST'){
  const data=await body(request,studioClientDeliveryAccessInput);await rateLimit(`client-delivery-open:${user.id}`,60,60);return json(await transaction(async client=>{const grant=await activeGrant(client,user,shareId,{write:true});return once(client,grant.company_id,user.id,data.clientId,'open:'+shareId,data,async()=>({receipt:await receipt(client,grant,user.id,'portal_opened')}));}));
 }
 if(parts.length===5&&parts[2]==='files'&&parts[4]==='access'&&method==='POST'){
  const fileId=id(parts[3]),data=await body(request,studioClientDeliveryAccessInput);await rateLimit(`client-delivery-file:${user.id}`,120,60);
  const prepared=await transaction(async client=>{const grant=await activeGrant(client,user,shareId);const file=(await client.query('SELECT f.* FROM studio_client_delivery_files g JOIN studio_media_files f ON f.company_id=g.company_id AND f.id=g.file_id JOIN studio_media_verifications v ON v.company_id=f.company_id AND v.file_id=f.id AND v.sha256=f.sha256 AND v.bytes=f.bytes WHERE g.company_id=$1 AND g.share_id=$2 AND g.file_id=$3',[grant.company_id,grant.id,fileId])).rows[0];if(!file)fail(404,'This file is not in your approved delivery package.');return {file,expiresAt:Math.min(Date.now()+60000,new Date(grant.expires_at).getTime())};});
  let url:string;try{url=await provider.signRead(prepared.file.blob_pathname,prepared.expiresAt);}catch{fail(503,'Private file access is temporarily unavailable. Retry without changing the package.','CLIENT_MEDIA_UNAVAILABLE');}
  const result=await transaction(async client=>{const grant=await activeGrant(client,user,shareId,{write:true});if(prepared.expiresAt<=Date.now())fail(410,'The file access window expired. Request access again.','CLIENT_GRANT_UNAVAILABLE');return once(client,grant.company_id,user.id,data.clientId,'file:'+shareId+':'+fileId,data,async()=>({receipt:await receipt(client,grant,user.id,'download_access_issued',null,fileId)}));});
  return json({...result,access:{url,expiresAt:new Date(prepared.expiresAt).toISOString(),status:'download_access_issued',bytesReceivedByClient:'not_observed'}},200,{'Referrer-Policy':'no-referrer'});
 }
 if(parts.length===3&&parts[2]==='responses'&&method==='POST'){const data=await body(request,studioClientDeliveryResponseInput),result=await transaction(client=>recordClientResponse(client,user,shareId,data));return json(result,result.replayed?200:201);}
 return null;
}
