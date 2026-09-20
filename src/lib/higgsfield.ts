import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {query,transaction} from './db';
import {requireMembership,type Membership} from './auth';
import {memberMutation} from './company';
import {body,fail,hashToken,id,json,rateLimit,secret} from './security';
import {sealHiggsfieldSecret,openHiggsfieldSecret} from './higgsfield-secrets';
import {higgsfieldProposalInput,higgsfieldReadInput,higgsfieldExecuteInput,higgsfieldEstimateInput,HIGGSFIELD_READ_TOOLS,HIGGSFIELD_GENERATION_TOOLS} from './higgsfield-protocol';
import {discoverHiggsfield,registerHiggsfield,higgsfieldAuthorizationUrl,exchangeHiggsfieldCode,refreshHiggsfieldToken,listHiggsfieldTools,callHiggsfieldTool,HIGGSFIELD_MCP_ENDPOINT,type HiggsfieldMetadata,type HiggsfieldClient,type HiggsfieldToken} from './higgsfield-mcp';
import type {StudioActor} from './studio';
import {higgsfieldProposalWork,assertHiggsfieldWorkForDispatch} from './higgsfield-work';
import {recordHiggsfieldSubmission,listHiggsfieldJobs,higgsfieldJobsInput} from './higgsfield-jobs';

const callback='https://coatria.com/api/higgsfield/callback';
type Credentials={metadata:HiggsfieldMetadata;client:HiggsfieldClient;token:HiggsfieldToken};
type Pending={metadata:HiggsfieldMetadata;client:HiggsfieldClient;verifier:string};
type Row=Record<string,any>;
const allowed=new Set<string>([...HIGGSFIELD_READ_TOOLS,...HIGGSFIELD_GENERATION_TOOLS]);
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(value);
const digest=(value:unknown)=>hashToken(canonical(value));
const plain=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const projectColumns=`id,revision,ai_policy,gates,status,production_path`;
const requestColumns=`id,project_id AS "projectId",work_item_id AS "workItemId",task_revision AS "taskRevision",tool,arguments,note,request_hash AS "requestHash",status,created_at AS "createdAt",result,error_code AS "errorCode"`;
const transport={timeoutMs:8000};
const parse=<T>(schema:z.ZodType<T>,value:unknown)=>{const p=schema.safeParse(value);if(!p.success)fail(400,p.error.issues.map(i=>i.message).slice(0,3).join(' '));return p.data;};
async function connection(client:PoolClient,companyId:string,exclusive=false){
 const row=(await client.query(`SELECT * FROM higgsfield_connections WHERE company_id=$1 FOR ${exclusive?'UPDATE':'SHARE'}`,[companyId])).rows[0];
 if(!row||row.status!=='connected')fail(409,'Connect the company Higgsfield account first.','HIGGSFIELD_NOT_CONNECTED');
 if(!(await client.query("SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",[companyId,row.connected_by])).rowCount)fail(403,'The Higgsfield connection sponsor no longer has administrator access. Reconnect it.','HIGGSFIELD_SPONSOR_UNAVAILABLE');
 return row;
}
export async function higgsfieldConnectionView(client:PoolClient,companyId:string){
 const row=(await client.query('SELECT c.status,c.revision,c.expires_at,c.connected_at,c.tools,m.role FROM higgsfield_connections c LEFT JOIN memberships m ON m.company_id=c.company_id AND m.user_id=c.connected_by WHERE c.company_id=$1',[companyId])).rows[0];
 if(!row)return {status:'disconnected',revision:0,officialEndpoint:HIGGSFIELD_MCP_ENDPOINT,toolCount:0,tools:[]};
 const usable=row.status==='connected'&&['owner','admin'].includes(row.role);
 return plain({status:usable?'connected':row.status==='disconnected'?'disconnected':'reconnect_required',revision:row.revision,connectedAt:row.connected_at,expiresAt:row.expires_at,officialEndpoint:HIGGSFIELD_MCP_ENDPOINT,toolCount:usable?row.tools.length:0,tools:usable?row.tools:[]});
}
export async function higgsfieldAgentConnection(client:PoolClient,companyId:string,toolName?:string){
 const view=await higgsfieldConnectionView(client,companyId);
 if(!toolName)return {...view,tools:view.tools.map((tool:Row)=>({name:tool.name,description:tool.description.slice(0,400),schemaAvailable:true}))};
 const selected=view.tools.find((tool:Row)=>tool.name===toolName);if(!selected)fail(404,'Tool not available in the official company connection.');
 if(Buffer.byteLength(JSON.stringify(selected))>48000)fail(413,'This provider schema needs administrator review outside the bounded agent context.');return {...view,tools:[selected]};
}
async function refreshCatalog(member:Membership){
 await rateLimit(`higgsfield-catalog:${member.companyId}`,5,60);
 const saved=await higgsfieldCredential(member);if('error'in saved)fail(409,'Reconnect Higgsfield.','HIGGSFIELD_RECONNECT_REQUIRED');
 const tools=(await listHiggsfieldTools(saved.token,transport)).filter(tool=>allowed.has(tool.name)).map(({name,description,inputSchema,outputSchema})=>({name,description,inputSchema,...outputSchema?{outputSchema}:{}}));
 if(!tools.some(tool=>HIGGSFIELD_GENERATION_TOOLS.includes(tool.name as typeof HIGGSFIELD_GENERATION_TOOLS[number])))fail(409,'The official account exposes no supported generation tools.','HIGGSFIELD_CATALOG_UNSUPPORTED');
 return memberMutation(member,true,async db=>{
  const current=await connection(db,member.companyId,true);
  if(current.id!==saved.row.id||current.revision!==saved.row.revision)fail(409,'The connection changed while discovering tools. Refresh again.');
  const changed=digest(current.tools)!==digest(tools);
  if(changed)await db.query('UPDATE higgsfield_connections SET tools=$2,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1',[member.companyId,JSON.stringify(tools)]);
  return {...await higgsfieldConnectionView(db,member.companyId),catalogChanged:changed,existingProposalsNeedReview:changed};
 });
}
async function begin(member:Membership){
 await rateLimit(`higgsfield-connect:${member.userId}`,5,3600);
 const state=secret(),verifier=secret(),attemptId=randomUUID();
 // Check vault availability before a provider registration. No provider credential is exposed.
 sealHiggsfieldSecret({}, {companyId:member.companyId,id:attemptId,purpose:'oauth-pending'});
 const metadata=await discoverHiggsfield(transport),client=await registerHiggsfield(metadata,callback,transport);
 await memberMutation(member,true,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`higgsfield-control:${member.companyId}`]);
  const current=(await db.query('SELECT revision FROM higgsfield_connections WHERE company_id=$1',[member.companyId])).rows[0];
  await db.query('INSERT INTO higgsfield_oauth_attempts(id,company_id,user_id,state_hash,sealed,expected_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval \'10 minutes\')',[attemptId,member.companyId,member.userId,hashToken(state),JSON.stringify(sealHiggsfieldSecret({metadata,client,verifier},{companyId:member.companyId,id:attemptId,purpose:'oauth-pending'})),current?.revision??0]);
 });
 return {authorizationUrl:higgsfieldAuthorizationUrl(metadata,client,callback,state,verifier)};
}
async function finish(request:Request){
 const url=new URL(request.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
 if(!state||state.length>200||code&&code.length>8192)fail(400,'The Higgsfield authorization response is invalid.');
 const hint=(await query('SELECT company_id FROM higgsfield_oauth_attempts WHERE state_hash=$1',[hashToken(state)])).rows[0];if(!hint)fail(400,'This connection attempt is unknown or expired.');
 const member=await requireMembership(request,hint.company_id,true);
 const attempt=await memberMutation(member,true,async db=>{
  const row=(await db.query('SELECT * FROM higgsfield_oauth_attempts WHERE state_hash=$1 AND company_id=$2 AND user_id=$3 FOR UPDATE',[hashToken(state),member.companyId,member.userId])).rows[0];
  if(!row||row.consumed_at||+new Date(row.expires_at)<=Date.now())fail(409,'This connection attempt ended. Start a new Higgsfield connection.');
  await db.query('UPDATE higgsfield_oauth_attempts SET consumed_at=clock_timestamp() WHERE id=$1',[row.id]);return row;
 });
 if(url.searchParams.has('error')||!code)return new Response(null,{status:303,headers:{Location:'https://coatria.com/#plugins','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 const saved=openHiggsfieldSecret<Pending>(attempt.sealed,{companyId:member.companyId,id:attempt.id,purpose:'oauth-pending'});
 if(url.searchParams.has('iss')&&url.searchParams.get('iss')!==saved.metadata.issuer)fail(400,'The authorization issuer does not match Higgsfield.');
 const token=await exchangeHiggsfieldCode(saved.metadata,saved.client,callback,code,saved.verifier,transport);
 const tools=(await listHiggsfieldTools(token.access_token,transport)).filter(tool=>allowed.has(tool.name)).map(({name,description,inputSchema,outputSchema})=>({name,description,inputSchema,...outputSchema?{outputSchema}:{}}));
 if(!tools.some(tool=>HIGGSFIELD_GENERATION_TOOLS.includes(tool.name as typeof HIGGSFIELD_GENERATION_TOOLS[number])))fail(409,'The official account exposes no supported generation tools. Its catalog needs a compatibility review.','HIGGSFIELD_CATALOG_UNSUPPORTED');
 await memberMutation(member,true,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`higgsfield-control:${member.companyId}`]);
  const current=(await db.query('SELECT revision FROM higgsfield_connections WHERE company_id=$1 FOR UPDATE',[member.companyId])).rows[0];
  if((current?.revision??0)!==attempt.expected_revision)fail(409,'Another administrator changed this connection. Reconnect against the current settings.');
  const connectionId=randomUUID(),sealed=sealHiggsfieldSecret({metadata:saved.metadata,client:saved.client,token},{companyId:member.companyId,id:connectionId,purpose:'oauth-connection'});
  await db.query("INSERT INTO higgsfield_connections(company_id,id,revision,status,connected_by,sealed,expires_at,tools) VALUES($1,$2,$3,'connected',$4,$5,$6,$7) ON CONFLICT(company_id) DO UPDATE SET id=EXCLUDED.id,revision=EXCLUDED.revision,status='connected',connected_by=EXCLUDED.connected_by,sealed=EXCLUDED.sealed,expires_at=EXCLUDED.expires_at,tools=EXCLUDED.tools,connected_at=clock_timestamp(),updated_at=clock_timestamp()",[member.companyId,connectionId,attempt.expected_revision+1,member.userId,JSON.stringify(sealed),new Date(Date.now()+token.expires_in*1000).toISOString(),JSON.stringify(tools)]);
 });
 return new Response(null,{status:303,headers:{Location:'https://coatria.com/#plugins','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
export async function higgsfieldCredential(member:Membership){
 // Commit an unusable, secret-free fence before the rotating-token POST. A
 // crash after provider rotation must not leave the old refresh token reusable.
 const prepared=await memberMutation(member,true,async db=>{
  const row=await connection(db,member.companyId,true),context={companyId:member.companyId,id:row.id,purpose:'oauth-connection' as const};
  const saved=openHiggsfieldSecret<Credentials>(row.sealed,context);
  if(+new Date(row.expires_at)>Date.now()+30000)return {ready:{row,token:saved.token.access_token}};
  if(!saved.token.refresh_token){await db.query("UPDATE higgsfield_connections SET status='reconnect_required',sealed=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1",[member.companyId]);return {error:'HIGGSFIELD_RECONNECT_REQUIRED' as const};}
  await db.query("UPDATE higgsfield_connections SET status='reconnect_required',sealed=NULL,updated_at=clock_timestamp() WHERE company_id=$1",[member.companyId]);
  return {refresh:{row,saved,context}};
 });
 if(prepared.ready)return prepared.ready;
 if(!prepared.refresh)return {error:'HIGGSFIELD_RECONNECT_REQUIRED' as const};
 const {row,saved,context}=prepared.refresh;
 try{
  const fresh=await refreshHiggsfieldToken(saved.metadata,saved.client,saved.token.refresh_token!,transport);
  saved.token={...fresh,refresh_token:fresh.refresh_token??saved.token.refresh_token};
  return await memberMutation(member,true,async db=>{
   const current=(await db.query('SELECT * FROM higgsfield_connections WHERE company_id=$1 FOR UPDATE',[member.companyId])).rows[0];
   if(!current||current.id!==row.id||current.revision!==row.revision||current.status!=='reconnect_required'||current.sealed!==null||current.connected_by!==row.connected_by)return {error:'HIGGSFIELD_RECONNECT_REQUIRED' as const};
   if(!(await db.query("SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",[member.companyId,current.connected_by])).rowCount)return {error:'HIGGSFIELD_RECONNECT_REQUIRED' as const};
   const expiresAt=new Date(Date.now()+fresh.expires_in*1000).toISOString();
   await db.query("UPDATE higgsfield_connections SET status='connected',sealed=$2,expires_at=$3,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$4 AND revision=$5 AND status='reconnect_required' AND sealed IS NULL",[member.companyId,JSON.stringify(sealHiggsfieldSecret(saved,context)),expiresAt,row.id,row.revision]);
   // A successful routine refresh preserves reviewed generation proposals.
   return {row:{...current,status:'connected',expires_at:expiresAt},token:fresh.access_token};
  });
 }catch{
  // Never undo the committed fence or overwrite a simultaneous reconnection.
  // A response or commit may be uncertain; only a new user connection recovers it.
  return {error:'HIGGSFIELD_RECONNECT_REQUIRED' as const};
 }
}
export async function proposeHiggsfieldRequest(client:PoolClient,actor:StudioActor,input:unknown){
 const data=parse(higgsfieldProposalInput,input),requestHash=digest(data);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`higgsfield-request:${actor.companyId}:${actor.userId}:${data.clientId}`]);
 const old=(await client.query(`SELECT ${requestColumns},agent_id FROM higgsfield_requests WHERE company_id=$1 AND requested_by=$2 AND client_id=$3`,[actor.companyId,actor.userId,data.clientId])).rows[0];
 if(old){if(old.requestHash!==requestHash||old.agent_id!==(actor.agentId??null))fail(409,'This request ID was already used with different generation details.','IDEMPOTENCY_CONFLICT');delete old.agent_id;return {request:plain(old),replayed:true};}
 const project=(await client.query(`SELECT ${projectColumns} FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE`,[actor.companyId,data.projectId])).rows[0];
 if(!project)fail(404,'Project not found.');if(project.revision!==data.projectRevision)fail(409,'Refresh the changed project before proposing a generation.');
 if(project.status==='delivered')fail(409,'Delivered projects are closed. Create follow-up work.','STUDIO_PROJECT_CLOSED');
 if(project.ai_policy!=='allowed')fail(409,'Confirm the project permits AI generation first.');
 const work=await higgsfieldProposalWork(client,actor,project,data.workItemId);
 const connected=await connection(client,actor.companyId);
 if(!connected.tools.some((tool:Row)=>tool.name===data.tool))fail(409,'This tool is not available in the connected official Higgsfield account.');
 if(Number((await client.query('SELECT count(*) FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2',[actor.companyId,data.projectId])).rows[0].count)>=200)fail(409,'This project reached its 200 generation-request pilot limit.');
 const row=(await client.query(`INSERT INTO higgsfield_requests(company_id,project_id,requested_by,agent_id,run_id,client_id,project_revision,connection_revision,tool,arguments,note,request_hash,work_item_id,task_revision,role_agent_id,role_human_id,connection_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${requestColumns}`,[actor.companyId,data.projectId,actor.userId,actor.agentId??null,actor.runId??null,data.clientId,data.projectRevision,connected.revision,data.tool,JSON.stringify(data.arguments),data.note,requestHash,work?.workItemId??null,work?.taskRevision??null,work?.roleAgentId??null,work?.roleHumanId??null,connected.id])).rows[0];
 return {request:plain(row),replayed:false};
}
export async function listHiggsfieldRequests(client:PoolClient,companyId:string,projectId:string,options:{after?:string;requestId?:string;limit?:number}={}){
 if(!(await client.query('SELECT 1 FROM studio_projects WHERE company_id=$1 AND id=$2',[companyId,id(projectId)])).rowCount)fail(404,'Project not found.');
 if(options.requestId){const row=(await client.query(`SELECT ${requestColumns} FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2 AND id=$3`,[companyId,projectId,id(options.requestId)])).rows[0];if(!row)fail(404,'Generation request not found.');return {request:plain(row)};}
 const limit=options.limit??20;if(!Number.isInteger(limit)||limit<1||limit>50)fail(400,'Use a request page limit from 1 to 50.');
 if(options.after&&!(await client.query('SELECT 1 FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,projectId,id(options.after)])).rowCount)fail(404,'Request cursor not found.');
 const rows=(await client.query(`SELECT id,project_id AS "projectId",work_item_id AS "workItemId",task_revision AS "taskRevision",tool,note,request_hash AS "requestHash",status,created_at AS "createdAt",error_code AS "errorCode",result IS NOT NULL AS "hasReceipt" FROM higgsfield_requests WHERE company_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,[companyId,projectId,options.after??null,limit+1])).rows;
 return {requests:plain(rows.slice(0,limit)),hasMore:rows.length>limit,nextAfter:rows.length>limit?rows[limit-1].id:null};
}
export async function higgsfieldAgentRequests(client:PoolClient,companyId:string,input:{projectId:string;after?:string;requestId?:string;limit?:number}){
 const result=await listHiggsfieldRequests(client,companyId,input.projectId,input);if(!('request' in result))return result;
 const {result:receipt,...request}=result.request;const serialized=JSON.stringify(receipt);return {request:{...request,...serialized&&Buffer.byteLength(serialized)<=48000?{result:receipt}:{resultPreview:serialized?.slice(0,8000),resultTruncated:true}},providerResponseIsNotMediaCompletion:true};
}
async function execute(member:Membership,requestId:string,input:unknown){
 const data=parse(higgsfieldExecuteInput,input),credentialResult=await higgsfieldCredential(member);
 if('error' in credentialResult)fail(409,'Sign in to Higgsfield again before continuing.','HIGGSFIELD_RECONNECT_REQUIRED');
 const {row:connected,token}=credentialResult;
 const prepared=await memberMutation(member,true,async db=>{
  const row=(await db.query(`SELECT * FROM higgsfield_requests WHERE company_id=$1 AND id=$2 FOR UPDATE`,[member.companyId,id(requestId)])).rows[0];if(!row)fail(404,'Generation request not found.');
  if(row.request_hash!==data.requestHash)fail(409,'The reviewed request does not match.');
  if(row.status!=='proposed')return {replayed:true,row};
  const current=await connection(db,member.companyId);
  if(current.id!==connected.id||row.connection_id!==current.id||current.revision!==connected.revision||row.connection_revision!==current.revision)fail(409,'The Higgsfield connection changed. Prepare a new request.');
  const project=(await db.query(`SELECT ${projectColumns} FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE`,[member.companyId,row.project_id])).rows[0];
  if(!project||project.status==='delivered'||project.revision!==row.project_revision||project.ai_policy!=='allowed'||['brief','estimate','production'].some(gate=>project.gates[gate]?.decision!=='approved'))fail(409,'Approve the brief, estimate and production gates, then propose against the current project revision.');
  await assertHiggsfieldWorkForDispatch(db,member.companyId,project,row);
  if(!current.tools.some((tool:Row)=>tool.name===row.tool))fail(409,'The exact official tool is no longer available.');
  await db.query("UPDATE higgsfield_requests SET status='dispatching',approved_by=$3,dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[member.companyId,row.id,member.userId]);return {replayed:false,row:{...row,approved_by:member.userId}};
 });
 if(prepared.replayed)return {replayed:true,requestId,status:prepared.row.status};
 // This durable intent is never automatically retried. A timeout can still mean charged provider work.
 let result:unknown,status='returned',errorCode:string|null=null;
 try{result=await callHiggsfieldTool(token,prepared.row.tool,prepared.row.arguments,{timeoutMs:25000});if(Buffer.byteLength(JSON.stringify(result))>262144)throw Error('Result limit');}
 catch{status='uncertain';errorCode='HIGGSFIELD_OUTCOME_UNCERTAIN';result=null;}
 await transaction(async db=>{
  const current=(await db.query("SELECT * FROM higgsfield_requests WHERE company_id=$1 AND id=$2 AND status='dispatching' FOR UPDATE",[member.companyId,requestId])).rows[0];
  if(!current)return;
  if(status==='returned'){
   await db.query("UPDATE higgsfield_requests SET status='returned' WHERE company_id=$1 AND id=$2",[member.companyId,requestId]);
   result=await recordHiggsfieldSubmission(db,{...current,status:'returned'},result);
  }
  await db.query("UPDATE higgsfield_requests SET status=$3,result=$4,error_code=$5,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND status IN ('dispatching','returned')",[member.companyId,requestId,status,JSON.stringify(result),errorCode]);
 });
 return {requestId,status,result,errorCode,replayed:false,mediaCompleted:false};
}
async function estimate(member:Membership,requestId:string,input:unknown){
 const data=parse(higgsfieldEstimateInput,input);await rateLimit(`higgsfield-estimate:${member.companyId}`,10,60);
 const saved=await higgsfieldCredential(member);if('error'in saved)fail(409,'Reconnect Higgsfield.','HIGGSFIELD_RECONNECT_REQUIRED');
 const prepared=await memberMutation(member,true,async db=>{
  const row=(await db.query('SELECT * FROM higgsfield_requests WHERE company_id=$1 AND id=$2',[member.companyId,id(requestId)])).rows[0];
  if(!row)fail(404,'Generation request not found.');
  if(row.request_hash!==data.requestHash||row.status!=='proposed')fail(409,'Estimate the exact unsent request.');
  const current=await connection(db,member.companyId);
  if(current.id!==saved.row.id||row.connection_id!==current.id||current.revision!==saved.row.revision||row.connection_revision!==current.revision)fail(409,'The connection or catalog changed. Prepare a new request.');
  const project=(await db.query(`SELECT ${projectColumns} FROM studio_projects WHERE company_id=$1 AND id=$2 FOR UPDATE`,[member.companyId,row.project_id])).rows[0];
  if(!project||project.status==='delivered'||project.revision!==row.project_revision||project.ai_policy!=='allowed')fail(409,'Refresh the project and its AI-use permission.');
  await assertHiggsfieldWorkForDispatch(db,member.companyId,project,row);
  const tool=current.tools.find((entry:Row)=>entry.name===row.tool),paramsSchema=tool?.inputSchema?.properties?.params;
  const alternatives=[paramsSchema,...(Array.isArray(paramsSchema?.anyOf)?paramsSchema.anyOf:[])];
  if(!alternatives.some(schema=>schema?.type==='object'&&schema.properties?.get_cost?.type==='boolean'))fail(409,'The connected tool does not advertise a supported read-only cost preflight.','HIGGSFIELD_ESTIMATE_UNAVAILABLE');
  const params=row.arguments.params;
  if(!params||typeof params!=='object'||Array.isArray(params))fail(409,'Use an object-valued params argument from the official schema before estimating.');
  // Never forward caller-controlled flags or serialized params to a paid tool.
  return {tool:row.tool,arguments:{params:{...params,get_cost:true}}};
 });
 return {requestId,requestHash:data.requestHash,estimateOnly:true,spendingAuthorized:false,priceGuaranteed:false,result:await callHiggsfieldTool(saved.token,prepared.tool,prepared.arguments,{timeoutMs:20000})};
}
export async function higgsfieldRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts.join('/')==='higgsfield/callback'&&method==='GET')return finish(request);
 if(parts[0]!=='companies'||parts[2]!=='higgsfield')return null;
 const companyId=id(parts[1]),member=await requireMembership(request,companyId,method!=='GET');
 if(parts.length===3&&method==='GET')return json(await memberMutation(member,false,db=>higgsfieldConnectionView(db,companyId)));
 if(parts.length===4&&parts[3]==='connect'&&method==='POST'){await body(request,z.object({}).strict());return json(await begin(member));}
 if(parts.length===4&&parts[3]==='catalog'&&method==='POST'){await body(request,z.object({}).strict());return json(await refreshCatalog(member));}
 if(parts.length===4&&parts[3]==='disconnect'&&method==='POST'){
  const data=await body(request,z.object({revision:z.number().int().positive()}).strict());
  await memberMutation(member,true,async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`higgsfield-control:${companyId}`]);const r=await db.query("UPDATE higgsfield_connections SET status='disconnected',sealed=NULL,revision=revision+1,tools='[]',updated_at=clock_timestamp() WHERE company_id=$1 AND revision=$2",[companyId,data.revision]);if(!r.rowCount)fail(409,'The connection changed. Refresh first.');});return json({disconnected:true,providerJobsCancelled:false});
 }
 if(parts.length===4&&parts[3]==='read'&&method==='POST'){
  const data=await body(request,higgsfieldReadInput);await rateLimit(`higgsfield-read:${companyId}`,30,60);const saved=await higgsfieldCredential(member);if('error'in saved)fail(409,'Reconnect Higgsfield.','HIGGSFIELD_RECONNECT_REQUIRED');
  if(!saved.row.tools.some((tool:Row)=>tool.name===data.tool))fail(409,'This tool is unavailable in the official connection.');return json({result:await callHiggsfieldTool(saved.token,data.tool,data.arguments,{timeoutMs:20000})});
 }
 if(parts.length===4&&parts[3]==='jobs'&&method==='GET'){const data=parse(higgsfieldJobsInput,Object.fromEntries(new URL(request.url).searchParams));return json(await memberMutation(member,false,db=>listHiggsfieldJobs(db,companyId,data)));}
 if(parts.length===4&&parts[3]==='requests'&&method==='GET'){const p=parse(z.object({projectId:z.string().uuid(),after:z.string().uuid().optional(),requestId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().refine(v=>!(v.after&&v.requestId),'Choose a page or exact request.'),Object.fromEntries(new URL(request.url).searchParams));return json(await memberMutation(member,false,db=>listHiggsfieldRequests(db,companyId,p.projectId,p)));}
 if(parts.length===4&&parts[3]==='requests'&&method==='POST'){const data=await body(request,higgsfieldProposalInput);return json(await memberMutation(member,true,db=>proposeHiggsfieldRequest(db,{companyId,userId:member.userId},data)),201);}
 if(parts.length===6&&parts[3]==='requests'&&parts[5]==='execute'&&method==='POST'){const data=await body(request,higgsfieldExecuteInput);return json(await execute(member,id(parts[4]),data));}
 if(parts.length===6&&parts[3]==='requests'&&parts[5]==='estimate'&&method==='POST'){const data=await body(request,higgsfieldEstimateInput);return json(await estimate(member,id(parts[4]),data));}
 return null;
}
