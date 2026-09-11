import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireMembership} from './auth';
import {authenticateAgent} from './integrations';
import {body,fail,id,json,rateLimit,uuid} from './security';
import {conversationDeleteInput,conversationEditInput,conversationHistory,conversationReactionInput,conversationReadInput,conversationSendInput,conversationSync,deleteConversationMessage,editConversationMessage,listConversations,markConversationRead,reactToConversationMessage,sendConversationMessage,type ConversationActor} from './conversations';

/** Both transports call the same transactional service. A bearer actor never inherits a human identity. */
export async function conversationRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 const human=parts[0]==='companies'&&parts[2]==='conversations';
 const agent=parts[0]==='agent'&&parts[1]==='conversations';
 if(!human&&!agent)return null;
 let actor:ConversationActor;
 if(agent){const identity=await authenticateAgent(request);actor={kind:'agent',companyId:identity.company_id,userId:identity.created_by,agentId:identity.id,tokenHash:identity.token_hash};}
 else{const member=await requireMembership(request,id(parts[1]));actor={kind:'human',companyId:member.companyId,userId:member.userId};await rateLimit(`conversation-read:${member.companyId}:${member.userId}`,180,60);}
 const tail=parts.slice(human?3:2),url=new URL(request.url);
 if(tail.length===0&&method==='GET')return json(await listConversations(actor));
 if(!tail[0])return null;
 const channel=tail[0]==='commons'?'commons':id(tail[0]);
 if(method==='GET'){
  const params:Record<string,unknown>={};
  for(const [key,value] of url.searchParams){if(key in params)fail(400,'Query parameters must not be repeated.');params[key]=key==='limit'?Number(value):value;}
  if(tail.length===2&&tail[1]==='messages')return json(await conversationHistory(actor,channel,params));
  if(tail.length===2&&tail[1]==='events')return json(await conversationSync(actor,channel,params));
 }
 if(tail.length===2&&tail[1]==='messages'&&method==='POST'){
  await rateLimit(`conversation-send:${actor.companyId}:${actor.kind}:${actor.kind==='human'?actor.userId:actor.agentId}`,60,60);
  const result=await sendConversationMessage(actor,channel,await body(request,conversationSendInput));
  return json(result,result.replayed?200:201);
 }
 if(tail.length===3&&tail[1]==='messages'){
  const messageId=id(tail[2]);
  if(method==='PATCH')return json(await editConversationMessage(actor,channel,messageId,await body(request,conversationEditInput)));
  if(method==='DELETE')return json(await deleteConversationMessage(actor,channel,messageId,await body(request,conversationDeleteInput)));
 }
 if(tail.length===4&&tail[1]==='messages'&&tail[3]==='reactions'&&method==='PUT')return json(await reactToConversationMessage(actor,channel,id(tail[2]),await body(request,conversationReactionInput)));
 if(tail.length===2&&tail[1]==='read'&&method==='PUT')return json(await markConversationRead(actor,channel,await body(request,conversationReadInput)));
 return null;
}

/** Compatibility for already-open clients. New integrations must supply their own clientId. */
export async function legacyConversationSend(request:Request,companyId:string){
 const member=await requireMembership(request,companyId);
 await rateLimit(`chat:${companyId}:${member.userId}`,60,60);
 const data=await body(request,z.object({roomId:uuid.nullable().optional(),body:z.string().trim().min(1).max(4000),clientId:uuid.optional()}).strict());
 // Preserve the old validation response for foreign room IDs.
 const {existingRoom}=await import('./company');
 const {database}=await import('./db');
 const client=await database().connect();try{await existingRoom(client,companyId,data.roomId);}finally{client.release();}
 const result=await sendConversationMessage({kind:'human',companyId,userId:member.userId},data.roomId||'commons',{body:data.body,clientId:data.clientId||randomUUID()});
 return json(result,result.replayed?200:201,{'Deprecation':'true','Link':'</api/conversations/openapi>; rel="service-desc"'});
}
