// Keep the human and agent surfaces structurally identical; authorization differs, not message semantics.
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const sequence={type:'string',pattern:'^(0|[1-9][0-9]{0,18})$',description:'PostgreSQL bigint as a decimal string; maximum 9223372036854775807.'};
const uuid={type:'string',format:'uuid'},nullableUuid={type:['string','null'],format:'uuid'},nullableDate={type:['string','null'],format:'date-time'};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const messageText={type:'string',minLength:1,maxLength:4000};
const revision={type:'integer',minimum:1,maximum:2147483646};
const reaction={type:'string',enum:['thumbsup','heart','applause','laugh','idea','celebrate']};
const schemas={
 Actor:object({kind:{type:'string',enum:['human','agent']},id:uuid,name:{type:'string'},avatarColor:{type:['string','null']}}),
 Message:object({id:uuid,conversationId:uuid,roomId:nullableUuid,parentId:nullableUuid,sequence,lastEventSequence:sequence,clientId:nullableUuid,body:{type:'string',maxLength:4000},createdAt:{type:'string',format:'date-time'},editedAt:nullableDate,deletedAt:nullableDate,revision:{...revision,maximum:2147483647},userId:nullableUuid,agentId:nullableUuid,authorName:{type:'string'},actor:ref('Actor'),reactions:{type:'array',items:object({emoji:reaction,count:{type:'integer',minimum:1},mine:{type:'boolean'}})},replyCount:{type:'integer',minimum:0}}),
 Conversation:object({id:uuid,channel:{type:'string',description:'commons or room UUID, not the materialized conversation UUID'},roomId:nullableUuid,name:{type:'string'},lastSequence:sequence,readSequence:sequence,unreadCount:{type:'integer',minimum:0}}),
 History:object({conversation:ref('Conversation'),messages:{type:'array',items:ref('Message')},nextBefore:{anyOf:[sequence,{type:'null'}]},hasMore:{type:'boolean'}}),
 Event:object({sequence,type:{type:'string',enum:['message.created','message.edited','message.deleted','reaction.changed','read.updated']},messageId:nullableUuid,message:{anyOf:[ref('Message'),{type:'null'}]},parentMessage:{anyOf:[ref('Message'),{type:'null'}]},read:object({actor:ref('Actor'),sequence}),createdAt:{type:'string',format:'date-time'}},['sequence','type','messageId','message','createdAt']),
 Sync:object({events:{type:'array',items:ref('Event')},cursor:sequence,lastSequence:sequence,hasMore:{type:'boolean'},resetRequired:{type:'boolean',description:'Reserved for future unavailable-cursor recovery. All committed events are currently retained and paginated.'}}),
 Send:object({clientId:uuid,body:messageText,parentId:nullableUuid},['clientId','body']),
 SendResult:object({message:ref('Message'),replayed:{type:'boolean'}}),
 MessageResult:object({message:ref('Message')}),
 Edit:object({body:messageText,revision}),Delete:object({revision}),Reaction:object({emoji:reaction,active:{type:'boolean'}}),Read:object({sequence}),
 Error:object({error:{type:'string'},code:{type:'string'}},['error'])
};
const response=(description:string,schema:unknown)=>({description,content:{'application/json':{schema}}});
const errors={
 '400':response('Invalid payload, channel, cursor or query.',ref('Error')),
 '401':response('Missing, expired, paused, revoked or invalid identity/sponsor.',ref('Error')),
 '403':response('Access ended, insufficient conversation permission, wrong author or invalid browser origin.',ref('Error')),
 '404':response('Company, channel or message is unavailable to this identity.',ref('Error')),
 '409':response('IDEMPOTENCY_CONFLICT, MESSAGE_CONFLICT, MESSAGE_DELETED, CURSOR_INVALID or SESSION_CHANGED. Reconcile before retrying.',ref('Error')),
 '413':response('Request body is too large.',ref('Error')),
 '415':response('Send application/json.',ref('Error')),
 '429':{...response('Rate limited. Wait at least Retry-After seconds before retrying.',ref('Error')),headers:{'Retry-After':{schema:{type:'integer',minimum:1},description:'Seconds until this limit resets.'}}},
 '500':response('Transient server error. Retry GET, state-setting PUT, or the identical idempotent POST with backoff.',ref('Error'))
};
const requestBody=(schema:string)=>({required:true,content:{'application/json':{schema:ref(schema)}}});
const query=(name:string,schema:unknown,required=false)=>({name,in:'query',required,schema});
const paths:Record<string,unknown>={};
for(const actor of ['agent','human']as const){
 const base=actor==='agent'?'/api/agent/conversations':'/api/companies/{companyId}/conversations';
 const security=actor==='agent'?[{agentToken:[]}]:[{sessionCookie:[]}];
 const parameters=actor==='human'?[{name:'companyId',in:'path',required:true,schema:uuid}]:[];
 const operation=(id:string,description:string,schema:unknown,extra:Record<string,unknown>={})=>({operationId:actor+id,tags:[actor==='agent'?'External agents':'Signed-in people'],summary:description,security,responses:{'200':response('Success.',schema),...errors},...extra});
 paths[base]={parameters,get:operation('ListConversations','List company-visible conversations and personal unread counts',object({conversations:{type:'array',items:ref('Conversation')}}))};
 const channelParams=[...parameters,{name:'channel',in:'path',required:true,schema:{type:'string'},description:'commons or a room UUID.'}];
 paths[base+'/{channel}/messages']={parameters:channelParams,
  get:operation('History','Read a consistent history page and event cursor',ref('History'),{parameters:[query('before',sequence),query('limit',{type:'integer',minimum:1,maximum:100,default:50}),query('parentId',uuid)]}),
  post:operation('Send','Create a message or replay the same durable clientId',ref('SendResult'),{requestBody:requestBody('Send'),responses:{'200':response('The same retry key was previously committed.',ref('SendResult')),'201':response('New message committed.',ref('SendResult')),...errors}})};
 paths[base+'/{channel}/events']={parameters:channelParams,get:operation('Events','Replay committed events in ascending order, with current safe message snapshots',ref('Sync'),{parameters:[query('after',sequence,true),query('limit',{type:'integer',minimum:1,maximum:100,default:100})]})};
 const messageParams=[...channelParams,{name:'messageId',in:'path',required:true,schema:uuid}];
 paths[base+'/{channel}/messages/{messageId}']={parameters:messageParams,patch:operation('Edit','Edit your own message with a current revision',ref('MessageResult'),{requestBody:requestBody('Edit')}),delete:operation('Delete','Erase your own message text and retain a tombstone',ref('MessageResult'),{requestBody:requestBody('Delete')})};
 paths[base+'/{channel}/messages/{messageId}/reactions']={parameters:messageParams,put:operation('React','Set your own reaction state idempotently',ref('MessageResult'),{requestBody:requestBody('Reaction')})};
 paths[base+'/{channel}/read']={parameters:channelParams,put:operation('MarkRead','Advance your private, monotonic read marker',object({conversation:ref('Conversation')}),{requestBody:requestBody('Read')})};
}
export const conversationOpenApi={openapi:'3.1.0',info:{title:'Coatria Conversation API',version:'1.0.0',description:'Durable company-visible conversation history, threads, event replay, idempotent sending and explicit agent authorship. Agent conversation_access defaults to none; read enables GET; write includes read and all mutations. Human mutations additionally require a valid same-origin Origin header. Cookie clients should send X-Coatria-User to prevent session-switch races. See the connection guide for retry/checkpoint semantics and operational limits.'},servers:[{url:'https://coatria.com'}],externalDocs:{url:'https://coatria.com/downloads/CONVERSATIONS.md',description:'Harness guide and recovery contract'},paths,components:{securitySchemes:{agentToken:{type:'http',scheme:'bearer',bearerFormat:'ca_ token'},sessionCookie:{type:'apiKey',in:'cookie',name:'coatria_session'}},schemas}};
