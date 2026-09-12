import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {transaction} from './db';
import {fail,hashToken,id,uuid} from './security';
import {MESSAGE_REACTIONS,type ConversationActorView,type ConversationEvent,type ConversationHistory,type ConversationMessage,type ConversationSummary,type ConversationSync} from './conversation-protocol';

/** Construct only after cookie/bearer authentication. The transaction rechecks all mutable authority. */
export type ConversationActor={companyId:string;kind:'human';userId:string}|{companyId:string;kind:'agent';userId:string;agentId:string;tokenHash:string};
export const conversationSendInput=z.object({clientId:uuid,body:z.string().trim().min(1).max(4000),parentId:uuid.nullable().optional()}).strict();
export const conversationEditInput=z.object({body:z.string().trim().min(1).max(4000),revision:z.number().int().positive().max(2147483646)}).strict();
export const conversationDeleteInput=z.object({revision:z.number().int().positive().max(2147483646)}).strict();
export const conversationReactionInput=z.object({emoji:z.enum(MESSAGE_REACTIONS),active:z.boolean()}).strict();
const sequenceInput=z.string().refine(value=>/^(0|[1-9]\d{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n,'Use a nonnegative decimal sequence.');
export const conversationReadInput=z.object({sequence:sequenceInput}).strict();
const historyInput=z.object({before:sequenceInput.optional(),limit:z.number().int().min(1).max(100).optional(),parentId:uuid.nullable().optional()}).strict();
const syncInput=z.object({after:sequenceInput,limit:z.number().int().min(1).max(100).optional()}).strict();
type ChannelRow={id:string;company_id:string;room_id:string|null;last_sequence:string;name:string};
type Context={client:PoolClient;actor:ConversationActor;actorId:string;view:ConversationActorView};
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)fail(400,result.error.issues.slice(0,3).map(issue=>`${issue.path.join('.')||'input'}: ${issue.message}`).join('; '),'VALIDATION_ERROR');return result.data;}
function roomFor(channel:string){return channel==='commons'?null:id(channel);}
async function authorized<T>(actor:ConversationActor,run:(context:Context)=>Promise<T>,write=false):Promise<T>{
 id(actor.companyId);id(actor.userId);if(actor.kind==='agent')id(actor.agentId);
 return transaction(async client=>{
  if(!(await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[actor.companyId])).rowCount)fail(404,'Workspace not found.');
  const member=(await client.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE',[actor.companyId,actor.userId])).rows[0];
  if(!member||member.role==='removed')fail(403,'Your company access has ended.');
  let view:ConversationActorView;
  if(actor.kind==='agent'){
   if(!['owner','admin'].includes(member.role))fail(401,'Agent sponsor access ended.');
   const agent=(await client.query("SELECT id,name,conversation_access FROM agents WHERE company_id=$1 AND id=$2 AND created_by=$3 AND token_hash=$4 AND status='active' AND expires_at>clock_timestamp() FOR SHARE",[actor.companyId,actor.agentId,actor.userId,actor.tokenHash])).rows[0];
   if(!agent)fail(401,'Agent access ended.');
   if(agent.conversation_access==='none'||write&&agent.conversation_access!=='write')fail(403,'This agent does not have the required conversation access.','AGENT_CONVERSATION_ACCESS');
   view={kind:'agent',id:agent.id,name:agent.name,avatarColor:null};
  }else{const user=(await client.query('SELECT name,avatar_color FROM users WHERE id=$1',[actor.userId])).rows[0];if(!user)fail(401,'Sign in to continue.');view={kind:'human',id:actor.userId,name:user.name,avatarColor:user.avatar_color};}
  return run({client,actor,actorId:view.id,view});
 });
}
async function ensureChannel(context:Context,channel:string,write:boolean):Promise<ChannelRow>{
 const {client,actor}=context,roomId=roomFor(channel);
 if(roomId&&!(await client.query('SELECT id FROM rooms WHERE company_id=$1 AND id=$2 FOR KEY SHARE',[actor.companyId,roomId])).rowCount)fail(404,'Conversation not found.');
 await client.query('INSERT INTO conversations(company_id,room_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.companyId,roomId]);
 return (await client.query(`SELECT c.*,COALESCE(r.name,'Company commons') AS name FROM conversations c LEFT JOIN rooms r ON r.company_id=c.company_id AND r.id=c.room_id WHERE c.company_id=$1 AND c.room_id IS NOT DISTINCT FROM $2::uuid FOR ${write?'UPDATE':'SHARE'} OF c`,[actor.companyId,roomId])).rows[0];
}
async function summary(context:Context,channel:ChannelRow):Promise<ConversationSummary>{
 const {client,actor,actorId}=context;
 const read=(await client.query('SELECT sequence FROM conversation_reads WHERE conversation_id=$1 AND actor_kind=$2 AND actor_id=$3',[channel.id,actor.kind,actorId])).rows[0]?.sequence||'0';
 const unread=(await client.query("SELECT count(*)::int AS count FROM messages WHERE company_id=$1 AND conversation_id=$2 AND parent_id IS NULL AND sequence>$3 AND deleted_at IS NULL AND NOT(actor_kind=$4 AND COALESCE(user_id,agent_id)=$5)",[actor.companyId,channel.id,read,actor.kind,actorId])).rows[0].count;
 return{id:channel.id,channel:channel.room_id||'commons',roomId:channel.room_id,name:channel.name,lastSequence:channel.last_sequence,readSequence:read,unreadCount:unread};
}
const messageColumns=`m.id,m.conversation_id AS "conversationId",m.room_id AS "roomId",m.parent_id AS "parentId",m.client_id AS "clientId",m.sequence::text AS sequence,m.last_event_sequence::text AS "lastEventSequence",m.body,m.created_at AS "createdAt",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt",m.revision,m.user_id AS "userId",m.agent_id AS "agentId",COALESCE(u.name,a.name,'Former teammate') AS "authorName",
 json_build_object('kind',m.actor_kind,'id',COALESCE(m.user_id,m.agent_id),'name',COALESCE(u.name,a.name,'Former teammate'),'avatarColor',CASE WHEN m.actor_kind='human' THEN u.avatar_color ELSE NULL END) AS actor,
 (SELECT count(*)::int FROM messages reply WHERE reply.company_id=m.company_id AND reply.conversation_id=m.conversation_id AND reply.parent_id=m.id) AS "replyCount"`;
async function messages(context:Context,channelId:string,filter:string,values:unknown[]):Promise<ConversationMessage[]>{
 const {client,actor,actorId}=context;
 const rows=(await client.query(`SELECT ${messageColumns} FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agents a ON a.id=m.agent_id AND a.company_id=m.company_id WHERE m.company_id=$1 AND m.conversation_id=$2 ${filter}`,[actor.companyId,channelId,...values])).rows as ConversationMessage[];
 if(!rows.length)return rows;
 const reactions=(await client.query(`SELECT message_id,emoji,count(*)::int AS count,bool_or(actor_kind=$3 AND actor_id=$4) AS mine FROM message_reactions WHERE company_id=$1 AND message_id=ANY($2::uuid[]) GROUP BY message_id,emoji ORDER BY emoji`,[actor.companyId,rows.map(row=>row.id),actor.kind,actorId])).rows;
 for(const row of rows)row.reactions=row.deletedAt?[]:reactions.filter(reaction=>reaction.message_id===row.id).map(({emoji,count,mine})=>({emoji,count,mine}));
 return rows;
}
async function oneMessage(context:Context,channelId:string,messageId:string){const message=(await messages(context,channelId,'AND m.id=$3',[id(messageId)]))[0];if(!message)fail(404,'Message not found.');return message;}
async function nextEvent(context:Context,channel:ChannelRow,kind:ConversationEvent['type'],messageId:string|null,readSequence:string|null=null){
 const {client,actor,actorId}=context;
 const sequence=(await client.query('UPDATE conversations SET last_sequence=last_sequence+1 WHERE company_id=$1 AND id=$2 RETURNING last_sequence::text AS sequence',[actor.companyId,channel.id])).rows[0].sequence as string;
 await client.query('INSERT INTO conversation_events(company_id,conversation_id,sequence,kind,message_id,actor_kind,actor_id,read_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[actor.companyId,channel.id,sequence,kind,messageId,actor.kind,actorId,readSequence]);
 channel.last_sequence=sequence;return sequence;
}

export async function listConversations(actor:ConversationActor){return authorized(actor,async context=>{
 const {client}=context;
 await client.query('INSERT INTO conversations(company_id) VALUES($1) ON CONFLICT DO NOTHING',[actor.companyId]);
 await client.query('INSERT INTO conversations(company_id,room_id) SELECT company_id,id FROM rooms WHERE company_id=$1 ORDER BY id ON CONFLICT DO NOTHING',[actor.companyId]);
 // One SQL statement gives every summary the same MVCC snapshot without locking
 // all channels or performing a pair of round trips per room.
 const summaries=(await client.query(`SELECT c.id,COALESCE(c.room_id::text,'commons') AS channel,c.room_id AS "roomId",COALESCE(r.name,'Company commons') AS name,c.last_sequence::text AS "lastSequence",COALESCE(cr.sequence,0)::text AS "readSequence",
 (SELECT count(*)::int FROM messages m WHERE m.company_id=c.company_id AND m.conversation_id=c.id AND m.parent_id IS NULL AND m.sequence>COALESCE(cr.sequence,0) AND m.deleted_at IS NULL AND NOT(m.actor_kind=$2 AND COALESCE(m.user_id,m.agent_id)=$3)) AS "unreadCount"
 FROM conversations c LEFT JOIN rooms r ON r.company_id=c.company_id AND r.id=c.room_id LEFT JOIN conversation_reads cr ON cr.company_id=c.company_id AND cr.conversation_id=c.id AND cr.actor_kind=$2 AND cr.actor_id=$3
 WHERE c.company_id=$1 ORDER BY c.room_id IS NOT NULL,COALESCE(r.name,'Company commons'),c.id`,[actor.companyId,actor.kind,context.actorId])).rows as ConversationSummary[];
 return{conversations:summaries};
});}
export async function conversationHistory(actor:ConversationActor,selector:string,input:unknown={}):Promise<ConversationHistory>{
 const options=parse(historyInput,input);return authorized(actor,async context=>{
  const channel=await ensureChannel(context,selector,false),limit=options.limit||50;
  if(options.parentId){const parent=await oneMessage(context,channel.id,options.parentId);if(parent.parentId)fail(400,'Replies can only belong to a top-level message.');}
  const rows=await messages(context,channel.id,'AND m.parent_id IS NOT DISTINCT FROM $3::uuid AND ($4::bigint IS NULL OR m.sequence<$4::bigint) ORDER BY m.sequence DESC LIMIT $5',[options.parentId||null,options.before||null,limit+1]);
  const hasMore=rows.length>limit,page=rows.slice(0,limit);
  return{conversation:await summary(context,channel),messages:page.reverse(),nextBefore:hasMore?page[0]?.sequence||null:null,hasMore};
 });
}
export async function conversationSync(actor:ConversationActor,selector:string,input:unknown):Promise<ConversationSync>{
 const options=parse(syncInput,input);return authorized(actor,async context=>{
  const channel=await ensureChannel(context,selector,false),limit=options.limit||100,last=BigInt(channel.last_sequence),after=BigInt(options.after);
  if(after>last)fail(409,'The conversation cursor is ahead of this stream. Reload its history.','CURSOR_INVALID');
  const rows=(await context.client.query(`SELECT e.sequence::text AS sequence,e.kind AS type,e.message_id AS "messageId",e.read_sequence::text AS "readSequence",e.created_at AS "createdAt",e.actor_kind,e.actor_id,COALESCE(u.name,a.name,'Former teammate') AS name,u.avatar_color FROM conversation_events e LEFT JOIN users u ON e.actor_kind='human' AND u.id=e.actor_id LEFT JOIN agents a ON e.actor_kind='agent' AND a.id=e.actor_id AND a.company_id=e.company_id WHERE e.company_id=$1 AND e.conversation_id=$2 AND e.sequence>$3 ORDER BY e.sequence LIMIT $4`,[actor.companyId,channel.id,options.after,limit+1])).rows;
  const hasMore=rows.length>limit,page=rows.slice(0,limit),ids=page.map(row=>row.messageId).filter(Boolean);
  const snapshots=ids.length?await messages(context,channel.id,'AND (m.id=ANY($3::uuid[]) OR m.id IN (SELECT parent_id FROM messages WHERE company_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[])))',[ids]):[];
  const byId=new Map(snapshots.map(message=>[message.id,message]));
  const events:ConversationEvent[]=page.map(row=>{const message=byId.get(row.messageId)||null;return{sequence:row.sequence,type:row.type,messageId:row.messageId,message,...(message?.parentId?{parentMessage:byId.get(message.parentId)||null}:{}),...(row.type==='read.updated'&&row.actor_kind===actor.kind&&row.actor_id===context.actorId?{read:{actor:{kind:row.actor_kind,id:row.actor_id,name:row.name,avatarColor:row.actor_kind==='human'?row.avatar_color:null},sequence:row.readSequence}}:{}),createdAt:row.createdAt};});
  return{events,cursor:page.at(-1)?.sequence||options.after,lastSequence:channel.last_sequence,hasMore,resetRequired:false};
 });
}
export async function sendConversationMessage(actor:ConversationActor,selector:string,input:unknown){
 const data=parse(conversationSendInput,input);
 return authorized(actor,context=>insertMessage(context,selector,data),true);
}
/** Server-only: caller must already hold and validate this run's agent/requester authority and live lease. */
export async function sendRunConversationMessage(client:PoolClient,actor:Extract<ConversationActor,{kind:'agent'}>,selector:string,input:unknown){
 const data=parse(conversationSendInput,input);
 const agent=(await client.query('SELECT name FROM agents WHERE company_id=$1 AND id=$2',[actor.companyId,actor.agentId])).rows[0];
 if(!agent)fail(401,'Agent access ended.');
 return insertMessage({client,actor,actorId:actor.agentId,view:{kind:'agent',id:actor.agentId,name:agent.name,avatarColor:null}},selector,data);
}
async function insertMessage(context:Context,selector:string,data:z.infer<typeof conversationSendInput>){
  const {actor}=context,roomId=roomFor(selector);
  const {client,actorId}=context;
  // A retry key spans channels for this actor/company, so lock before the channel.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`conversation-request:${actor.companyId}:${actor.kind}:${actorId}:${data.clientId}`]);
  const payloadHash=hashToken(JSON.stringify({roomId,parentId:data.parentId||null,body:data.body}));
  const previous=(await client.query('SELECT payload_hash,conversation_id,message_id FROM conversation_requests WHERE company_id=$1 AND actor_kind=$2 AND actor_id=$3 AND client_id=$4',[actor.companyId,actor.kind,actorId,data.clientId])).rows[0];
  if(previous&&previous.payload_hash!==payloadHash)fail(409,'This send key was already used for different content.','IDEMPOTENCY_CONFLICT');
  const channel=await ensureChannel(context,selector,true);
  if(previous)return{message:await oneMessage(context,channel.id,previous.message_id),replayed:true};
  if(data.parentId){const parent=await oneMessage(context,channel.id,data.parentId);if(parent.parentId)fail(400,'Replies can only belong to a top-level message.');if(parent.deletedAt)fail(409,'This message has been deleted.','MESSAGE_DELETED');}
  const messageId=randomUUID();
  // Insert the message before its event FK, using the next row-locked sequence.
  const sequence=(BigInt(channel.last_sequence)+1n).toString();
  await client.query('INSERT INTO messages(id,company_id,conversation_id,room_id,user_id,agent_id,actor_kind,body,parent_id,sequence,last_event_sequence,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)',[messageId,actor.companyId,channel.id,roomId,actor.kind==='human'?actor.userId:null,actor.kind==='agent'?actor.agentId:null,actor.kind,data.body,data.parentId||null,sequence,data.clientId]);
  await nextEvent(context,channel,'message.created',messageId);
  await client.query('INSERT INTO conversation_requests(company_id,actor_kind,actor_id,client_id,payload_hash,conversation_id,message_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[actor.companyId,actor.kind,actorId,data.clientId,payloadHash,channel.id,messageId]);
  return{message:await oneMessage(context,channel.id,messageId),replayed:false};
}
function ownMessage(context:Context,message:ConversationMessage,revision:number){
 if(message.actor.kind!==context.actor.kind||message.actor.id!==context.actorId)fail(403,'Only the author can change this message.');
 if(message.revision!==revision)fail(409,'This message changed. Reload it before saving.','MESSAGE_CONFLICT');
 if(message.deletedAt)fail(409,'This message has been deleted.','MESSAGE_DELETED');
}
export async function editConversationMessage(actor:ConversationActor,selector:string,messageId:string,input:unknown){
 const data=parse(conversationEditInput,input);return authorized(actor,async context=>{
  const channel=await ensureChannel(context,selector,true),message=await oneMessage(context,channel.id,messageId);ownMessage(context,message,data.revision);
  if(message.body===data.body)return{message};
  const sequence=await nextEvent(context,channel,'message.edited',message.id);
  await context.client.query('UPDATE messages SET body=$3,revision=revision+1,edited_at=clock_timestamp(),last_event_sequence=$4 WHERE company_id=$1 AND id=$2',[actor.companyId,message.id,data.body,sequence]);
  return{message:await oneMessage(context,channel.id,message.id)};
 },true);
}
export async function deleteConversationMessage(actor:ConversationActor,selector:string,messageId:string,input:unknown){
 const data=parse(conversationDeleteInput,input);return authorized(actor,async context=>{
  const channel=await ensureChannel(context,selector,true),message=await oneMessage(context,channel.id,messageId);ownMessage(context,message,data.revision);
  const sequence=await nextEvent(context,channel,'message.deleted',message.id);
  await context.client.query("UPDATE messages SET body='',deleted_at=clock_timestamp(),revision=revision+1,last_event_sequence=$3 WHERE company_id=$1 AND id=$2",[actor.companyId,message.id,sequence]);
  await context.client.query('DELETE FROM message_reactions WHERE company_id=$1 AND message_id=$2',[actor.companyId,message.id]);
  return{message:await oneMessage(context,channel.id,message.id)};
 },true);
}
export async function reactToConversationMessage(actor:ConversationActor,selector:string,messageId:string,input:unknown){
 const data=parse(conversationReactionInput,input);return authorized(actor,async context=>{
  const channel=await ensureChannel(context,selector,true),message=await oneMessage(context,channel.id,messageId);if(message.deletedAt)fail(409,'This message has been deleted.','MESSAGE_DELETED');
  const values=[actor.companyId,channel.id,message.id,actor.kind,context.actorId,data.emoji];
  const result=data.active?await context.client.query('INSERT INTO message_reactions(company_id,conversation_id,message_id,actor_kind,actor_id,emoji) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',values):await context.client.query('DELETE FROM message_reactions WHERE company_id=$1 AND conversation_id=$2 AND message_id=$3 AND actor_kind=$4 AND actor_id=$5 AND emoji=$6',values);
  if(result.rowCount){const sequence=await nextEvent(context,channel,'reaction.changed',message.id);await context.client.query('UPDATE messages SET last_event_sequence=$3 WHERE company_id=$1 AND id=$2',[actor.companyId,message.id,sequence]);}
  return{message:await oneMessage(context,channel.id,message.id)};
 },true);
}
export async function markConversationRead(actor:ConversationActor,selector:string,input:unknown){
 const data=parse(conversationReadInput,input);return authorized(actor,async context=>{
  const channel=await ensureChannel(context,selector,true);if(BigInt(data.sequence)>BigInt(channel.last_sequence))fail(400,'Read position cannot exceed the conversation cursor.');
  const result=await context.client.query('INSERT INTO conversation_reads(company_id,conversation_id,actor_kind,actor_id,sequence) VALUES($1,$2,$3,$4,$5) ON CONFLICT(conversation_id,actor_kind,actor_id) DO UPDATE SET sequence=EXCLUDED.sequence,updated_at=clock_timestamp() WHERE conversation_reads.sequence<EXCLUDED.sequence RETURNING sequence::text AS sequence',[actor.companyId,channel.id,actor.kind,context.actorId,data.sequence]);
  if(result.rowCount&&data.sequence!=='0')await nextEvent(context,channel,'read.updated',null,data.sequence);
  return{conversation:await summary(context,channel)};
 },true);
}
