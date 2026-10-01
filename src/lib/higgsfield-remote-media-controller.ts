/** Trusted controller composition only. No HTTP routes, provider calls, token
 * loading or guest execution. Reservations never refund or authorize recreate. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {transaction} from './db';
import {authorizeHiggsfieldArchive} from './higgsfield-archives';
import type {ArchiveInspectionContext} from './higgsfield-archive-worker';
import {VERCEL_MEDIA_IMAGE,type VercelMediaIntent,type VercelMediaJournalEvent,type VercelMediaQualificationBinding} from './higgsfield-vercel-media-sandbox';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const digest=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid(),identity=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),integer=(max:number)=>z.number().int().min(1).max(max);
const contextSchema=z.object({companyId:uuid,projectId:uuid,archiveId:uuid,leaseId:uuid,locatorIdentity:digest,requestHash:digest,expectedBytes:integer(128*1024**2),expectedSha256:digest,expectedKind:z.enum(['image','video','audio'])}).strict();
const limitsSchema=z.object({maxInputBytes:integer(128*1024**2),maxClosureBytes:integer(256*1024**2),timeoutMs:z.number().int().min(1000).max(120000),maxOutputBytes:integer(64*1024**2),maxStderrBytes:integer(65536)}).strict();
const bindingSchema=z.object({teamId:identity,projectId:identity,region:z.literal('iad1'),image:z.literal(VERCEL_MEDIA_IMAGE),closureSha256:digest,limits:limitsSchema}).strict();
const policySchema=z.object({pilotId:uuid,companyId:uuid,projectIds:z.array(uuid).min(1).max(100),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),expiresAt:z.iso.datetime(),maxLaunches:integer(1000),binding:bindingSchema}).strict();
const intentSchema=z.object({id:uuid,name:identity,teamId:identity,projectId:identity,region:z.literal('iad1'),image:z.literal(VERCEL_MEDIA_IMAGE),closureSha256:digest,inputSha256:digest,inputBytes:integer(128*1024**2),tool:z.enum(['ffprobe','ffmpeg']),ttlMs:z.number().int().min(1000).max(120000),vcpus:z.literal(2),memoryMiB:z.literal(4096)}).strict();
const eventSchema=z.object({type:z.enum(['created','create-unknown','cleanup-intent','terminal','cleanup-unknown']),intentId:uuid,name:identity,sessionId:z.string().regex(/^sbx_[A-Za-z0-9_-]{1,96}$/).optional(),status:z.enum(['stopped','failed','aborted']).optional()}).strict();
const reserveOperation='remote-media.reserve',eventPrefix='remote-media.';
type Code='REMOTE_MEDIA_POLICY_INVALID'|'REMOTE_MEDIA_BINDING_CHANGED'|'REMOTE_MEDIA_AUTHORITY_ENDED'|'REMOTE_MEDIA_PILOT_EXPIRED'|'REMOTE_MEDIA_BUDGET_EXHAUSTED'|'REMOTE_MEDIA_RECOVERY_REQUIRED'|'REMOTE_MEDIA_ALREADY_RESERVED'|'REMOTE_MEDIA_EVENT_CONFLICT'|'REMOTE_MEDIA_INTENT_MISSING';
export class RemoteMediaControllerError extends Error{constructor(readonly code:Code){super(code);this.name='RemoteMediaControllerError';}}
function fail(code:Code):never{throw new RemoteMediaControllerError(code);}
function parsed<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)fail('REMOTE_MEDIA_POLICY_INVALID');return result.data;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}

export type RemoteMediaControllerPolicy=Readonly<{pilotId:string;companyId:string;projectIds:readonly string[];sourceCommit:string;expiresAt:string;maxLaunches:number;binding:VercelMediaQualificationBinding}>;
export function parseRemoteMediaControllerPolicy(value:unknown):RemoteMediaControllerPolicy{const raw=parsed(policySchema,value);if(new Set(raw.projectIds).size!==raw.projectIds.length)fail('REMOTE_MEDIA_POLICY_INVALID');return freeze({...raw,projectIds:[...raw.projectIds].sort()});}
type Reservation={version:1;pilotId:string;policyHash:string;policy:RemoteMediaControllerPolicy;context:ArchiveInspectionContext;intent:VercelMediaIntent};
type EventDetail={version:1;pilotId:string;policyHash:string;intentId:string;event:VercelMediaJournalEvent};
export type RemoteMediaRecovery=Readonly<{policy:RemoteMediaControllerPolicy;context:ArchiveInspectionContext;intent:VercelMediaIntent;events:readonly VercelMediaJournalEvent[];reservedAt:string}>;
type Receipt={company_id:string;project_id:string;archive_id:string;action_id:string;operation:string;phase:string;detail:Reservation|EventDetail;created_at:Date|string};
const eventPhase=(type:VercelMediaJournalEvent['type'])=>type==='cleanup-intent'?'intent':type==='created'||type==='terminal'?'returned':'uncertain';
/** A distinct stable UUID for each event, because operation is not part of the
 * receipt unique key. Never reuse the reserve intent UUID for cleanup intent. */
function eventAction(intentId:string,type:string){const hex=hash('coatria-remote-media-v1:'+intentId+':'+type).slice(0,32).split('');hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].map(v=>v.join('')).join('-');}

export function createHiggsfieldRemoteMediaController(input:RemoteMediaControllerPolicy){
 const policy=parseRemoteMediaControllerPolicy(input),policyHash=hash(canonical(policy));
 // Renewal is new spending authority, not evidence that a previous guest was
 // destroyed. Admission and old-controller cleanup serialize at company scope.
 const lock=async(db:PoolClient)=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`remote-media-company:${policy.companyId}`]);};
 function checkedContext(value:ArchiveInspectionContext,scope=policy){const context=freeze(parsed(contextSchema,value));if(context.companyId!==scope.companyId||!scope.projectIds.includes(context.projectId)||context.expectedBytes>scope.binding.limits.maxInputBytes)fail('REMOTE_MEDIA_BINDING_CHANGED');return context;}
 function checkedIntent(value:VercelMediaIntent,context:ArchiveInspectionContext,scope=policy){
  const intent=freeze(parsed(intentSchema,value)),binding=scope.binding;
  if(intent.name!=='coatria-media-'+intent.id||intent.teamId!==binding.teamId||intent.projectId!==binding.projectId||intent.region!==binding.region||intent.image!==binding.image||intent.closureSha256!==binding.closureSha256||intent.ttlMs!==binding.limits.timeoutMs||intent.inputSha256!==context.expectedSha256||intent.inputBytes!==context.expectedBytes)fail('REMOTE_MEDIA_BINDING_CHANGED');return intent;
 }
 async function deadline(db:PoolClient,remainingMs=0){const valid=(await db.query('SELECT $1::timestamptz>clock_timestamp()+($2::double precision * interval \'1 millisecond\') AS valid',[policy.expiresAt,remainingMs])).rows[0];if(valid?.valid!==true)fail('REMOTE_MEDIA_PILOT_EXPIRED');}
 async function authority(db:PoolClient,context:ArchiveInspectionContext){
  let current;try{current=await authorizeHiggsfieldArchive(db,context.companyId,context.archiveId,{leaseId:context.leaseId});}catch{fail('REMOTE_MEDIA_AUTHORITY_ENDED');}
  if(current.project_id!==context.projectId||current.locator_identity!==context.locatorIdentity||current.request_hash!==context.requestHash||current.output.kind!==context.expectedKind||Number(current.max_bytes)<context.expectedBytes)fail('REMOTE_MEDIA_BINDING_CHANGED');
  const previous=(await db.query('SELECT bytes,sha256,locator_identity FROM higgsfield_archive_fetches WHERE company_id=$1 AND archive_id=$2',[context.companyId,context.archiveId])).rows[0];
  if(previous&&(Number(previous.bytes)!==context.expectedBytes||previous.sha256!==context.expectedSha256||previous.locator_identity!==context.locatorIdentity))fail('REMOTE_MEDIA_BINDING_CHANGED');
  // Pin the first inspected source bytes across retries and renewed pilot IDs,
  // even if the inspection failed before publishing immutable fetch evidence.
  const sources=(await db.query('SELECT detail FROM higgsfield_archive_receipts WHERE company_id=$1 AND archive_id=$2 AND operation=$3 AND phase=\'intent\'',[context.companyId,context.archiveId,reserveOperation])).rows;
  if(sources.some(row=>row.detail?.context?.expectedSha256!==context.expectedSha256||row.detail?.context?.expectedBytes!==context.expectedBytes||row.detail?.context?.locatorIdentity!==context.locatorIdentity||row.detail?.context?.requestHash!==context.requestHash))fail('REMOTE_MEDIA_BINDING_CHANGED');
 }
 async function receipts(db:PoolClient):Promise<Receipt[]>{
  // Explicit pilot safety ceiling across company history. Reaching it requires
  // operator recovery/history handling; it must never truncate away an old guest.
  const rows=(await db.query('SELECT company_id,project_id,archive_id,action_id,operation,phase,detail,created_at FROM higgsfield_archive_receipts WHERE company_id=$1 AND operation LIKE \'remote-media.%\' ORDER BY created_at,id LIMIT 6001',[policy.companyId])).rows as Receipt[];
  if(rows.length>6000)fail('REMOTE_MEDIA_RECOVERY_REQUIRED');return rows;
 }
 function ledger(rows:Receipt[]){
  const reservations=new Map<string,{saved:Reservation;row:Receipt;events:VercelMediaJournalEvent[]}>(),policies=new Map([[policy.pilotId,policyHash]]);
  for(const row of rows.filter(row=>row.operation===reserveOperation)){
   const saved=row.detail as Reservation,savedPolicy=parseRemoteMediaControllerPolicy(saved.policy),savedHash=hash(canonical(savedPolicy));
   if(saved.version!==1||saved.pilotId!==savedPolicy.pilotId||savedPolicy.companyId!==policy.companyId||saved.policyHash!==savedHash||canonical(saved.policy)!==canonical(savedPolicy)||policies.has(saved.pilotId)&&policies.get(saved.pilotId)!==savedHash)fail('REMOTE_MEDIA_BINDING_CHANGED');
   policies.set(saved.pilotId,savedHash);
   const context=checkedContext(saved.context,savedPolicy),intent=checkedIntent(saved.intent,context,savedPolicy);
   if(row.phase!=='intent'||row.action_id!==intent.id||row.company_id!==context.companyId||row.project_id!==context.projectId||row.archive_id!==context.archiveId||reservations.has(intent.id))fail('REMOTE_MEDIA_EVENT_CONFLICT');
   reservations.set(intent.id,{saved:{...saved,policy:savedPolicy,context,intent},row,events:[]});
  }
  for(const row of rows.filter(row=>row.operation!==reserveOperation)){
   const detail=row.detail as EventDetail,event=parsed(eventSchema,detail.event),parent=reservations.get(detail.intentId);
   if(!parent||detail.version!==1||detail.pilotId!==parent.saved.pilotId||detail.policyHash!==parent.saved.policyHash||event.intentId!==detail.intentId||row.company_id!==parent.saved.context.companyId||row.project_id!==parent.saved.context.projectId||row.archive_id!==parent.saved.context.archiveId||row.operation!==eventPrefix+event.type||row.action_id!==eventAction(event.intentId,event.type)||row.phase!==eventPhase(event.type))fail('REMOTE_MEDIA_EVENT_CONFLICT');
   validateEvent(event,parent.saved.intent,parent.events);parent.events.push(event);
  }
  return reservations;
 }
 function validateEvent(event:VercelMediaJournalEvent,intent:VercelMediaIntent,previous:VercelMediaJournalEvent[]){
  if(event.intentId!==intent.id||event.name!==intent.name||event.type==='terminal'&&(!event.sessionId||!event.status)||event.type!=='terminal'&&event.status!==undefined||event.type==='created'&&!event.sessionId)fail('REMOTE_MEDIA_EVENT_CONFLICT');
  const session=previous.find(item=>item.sessionId)?.sessionId;if(session&&event.sessionId&&session!==event.sessionId)fail('REMOTE_MEDIA_EVENT_CONFLICT');
  const duplicate=previous.find(item=>item.type===event.type);if(duplicate&&canonical(duplicate)!==canonical(event))fail('REMOTE_MEDIA_EVENT_CONFLICT');
 }
 async function insert(db:PoolClient,context:ArchiveInspectionContext,actionId:string,operation:string,phase:string,detail:Reservation|EventDetail){
  const prior=(await db.query('SELECT operation,detail FROM higgsfield_archive_receipts WHERE company_id=$1 AND archive_id=$2 AND action_id=$3 AND phase=$4',[context.companyId,context.archiveId,actionId,phase])).rows[0];
  if(prior){if(prior.operation!==operation||canonical(prior.detail)!==canonical(detail))fail('REMOTE_MEDIA_EVENT_CONFLICT');return;}
  await db.query('INSERT INTO higgsfield_archive_receipts(company_id,project_id,archive_id,action_id,operation,phase,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',[context.companyId,context.projectId,context.archiveId,actionId,operation,phase,JSON.stringify(detail)]);
 }
 function forArchive(value:ArchiveInspectionContext){
  const context=checkedContext(value);
  return Object.freeze({
   async reserve(value:VercelMediaIntent){const intent=checkedIntent(value,context);await transaction(async db=>{
    await lock(db);const saved=ledger(await receipts(db));
    const same=saved.get(intent.id);if(same){if(canonical(same.saved.context)!==canonical(context)||canonical(same.saved.intent)!==canonical(intent))fail('REMOTE_MEDIA_EVENT_CONFLICT');fail('REMOTE_MEDIA_ALREADY_RESERVED');}
    if([...saved.values()].some(item=>!item.events.some(event=>event.type==='terminal')))fail('REMOTE_MEDIA_RECOVERY_REQUIRED');
    if([...saved.values()].filter(item=>item.saved.pilotId===policy.pilotId).length>=policy.maxLaunches)fail('REMOTE_MEDIA_BUDGET_EXHAUSTED');
    await authority(db,context);await deadline(db,intent.ttlMs);
    await insert(db,context,intent.id,reserveOperation,'intent',{version:1,pilotId:policy.pilotId,policyHash,policy,context,intent});
   });},
   async authorize(value:VercelMediaIntent){const intent=checkedIntent(value,context);await transaction(async db=>{
    await lock(db);const saved=ledger(await receipts(db)).get(intent.id);if(!saved)fail('REMOTE_MEDIA_INTENT_MISSING');
    if(saved.saved.pilotId!==policy.pilotId||canonical(saved.saved.context)!==canonical(context)||canonical(saved.saved.intent)!==canonical(intent))fail('REMOTE_MEDIA_BINDING_CHANGED');
    await authority(db,context);await deadline(db);
   });},
   async record(value:VercelMediaJournalEvent){const event=freeze(parsed(eventSchema,value));await transaction(async db=>{
    await lock(db);const saved=ledger(await receipts(db)).get(event.intentId);if(!saved)fail('REMOTE_MEDIA_INTENT_MISSING');
    if(saved.saved.pilotId!==policy.pilotId||canonical(saved.saved.context)!==canonical(context))fail('REMOTE_MEDIA_BINDING_CHANGED');validateEvent(event,saved.saved.intent,saved.events);
    // Deliberately no live-lease/deadline gate: revoked business authority must
    // never suppress the destruction and durable reconciliation of a guest.
    await insert(db,context,eventAction(event.intentId,event.type),eventPrefix+event.type,eventPhase(event.type),{version:1,pilotId:policy.pilotId,policyHash,intentId:event.intentId,event});
   });}
  });
 }
 return Object.freeze({forArchive,
  async assertAdmission(requiredLaunches=1){if(!Number.isSafeInteger(requiredLaunches)||requiredLaunches<1||requiredLaunches>1000)fail('REMOTE_MEDIA_POLICY_INVALID');return transaction(async db=>{await lock(db);const saved=[...ledger(await receipts(db)).values()];if(saved.some(item=>!item.events.some(event=>event.type==='terminal')))fail('REMOTE_MEDIA_RECOVERY_REQUIRED');const reserved=saved.filter(item=>item.saved.pilotId===policy.pilotId).length;if(policy.maxLaunches-reserved<requiredLaunches)fail('REMOTE_MEDIA_BUDGET_EXHAUSTED');await deadline(db,policy.binding.limits.timeoutMs);return {reserved,remaining:policy.maxLaunches-reserved};});},
  async scanRecovery():Promise<readonly RemoteMediaRecovery[]>{return transaction(async db=>{await lock(db);return [...ledger(await receipts(db)).values()].filter(item=>!item.events.some(event=>event.type==='terminal')).map(item=>freeze({policy:item.saved.policy,context:item.saved.context,intent:item.saved.intent,events:item.events,reservedAt:new Date(item.row.created_at).toISOString()}));});}
 });
}
