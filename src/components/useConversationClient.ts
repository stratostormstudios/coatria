'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '@/lib/client';
import {startPolling} from '@/lib/polling';
import type {ConversationHistory,ConversationMessage,ConversationSummary,ConversationSync,MessageReaction} from '@/lib/conversation-protocol';

export type ConversationDraft={draft:string;sending:boolean;error:string;posted:boolean;jumpRevision:number;retry?:{clientId:string;body:string;original:string;parentId:string|null;uncertain?:boolean}};
export type ConversationFeed={messages:ConversationMessage[];loaded:boolean;loading:boolean;loadingOlder:boolean;error:string;hasMore:boolean;nextBefore:string|null;cursor:string;prependRevision:number};
type Snapshot={feeds:Map<string,ConversationFeed>;drafts:Map<string,ConversationDraft>;conversations:ConversationSummary[];listLoaded:boolean;listError:string};
export const emptyDraft:ConversationDraft={draft:'',sending:false,error:'',posted:false,jumpRevision:0};
export const emptyFeed:ConversationFeed={messages:[],loaded:false,loading:false,loadingOlder:false,error:'',hasMore:false,nextBefore:null,cursor:'0',prependRevision:0};
export const conversationKey=(channel:string,parentId:string|null=null)=>parentId?channel+':'+parentId:channel;
const sequence=(value:string)=>/^\d+$/.test(value)?BigInt(value):BigInt(0);
const maximum=(a:string,b:string)=>sequence(a)>=sequence(b)?a:b;
function mergeSummary(old:ConversationSummary|undefined,value:ConversationSummary):ConversationSummary{if(!old)return value;const stale=sequence(value.lastSequence)<sequence(old.lastSequence)||sequence(value.readSequence)<sequence(old.readSequence);return{...value,lastSequence:maximum(old.lastSequence,value.lastSequence),readSequence:maximum(old.readSequence,value.readSequence),unreadCount:stale?old.unreadCount:value.unreadCount};}
async function request<T>(path:string,method:string,body:unknown,options:{signal:AbortSignal}):Promise<T>{
 const scope=options.signal,deadline=new AbortController();let timedOut=false;
 const abort=()=>deadline.abort(scope.reason);scope.addEventListener('abort',abort,{once:true});if(scope.aborted)abort();
 const timer=setTimeout(()=>{timedOut=true;deadline.abort();},20000);
 try{return await api<T>(path,method,body,{signal:deadline.signal});}
 catch(error){if(timedOut&&!scope.aborted)throw Object.assign(new Error(method==='POST'?'The request timed out. Delivery may still have completed; retrying the original message is safe.':'The request timed out. Please try again.'),{name:'TimeoutError'});throw error;}
 finally{clearTimeout(timer);scope.removeEventListener('abort',abort);}
}
const merge=(current:ConversationMessage[],incoming:ConversationMessage[])=>{const values=new Map(current.map(message=>[message.id,message]));for(const message of incoming){const old=values.get(message.id);if(!old||sequence(message.lastEventSequence)>=sequence(old.lastEventSequence))values.set(message.id,message);}return [...values.values()].sort((a,b)=>sequence(a.sequence)<sequence(b.sequence)?-1:sequence(a.sequence)>sequence(b.sequence)?1:0);};

/** One tenant-bound cache and request lifetime, independent of dock/full component mounts. */
export function useConversationClient(){
 const [snapshot,setSnapshot]=useState<Snapshot>(()=>({feeds:new Map(),drafts:new Map(),conversations:[],listLoaded:false,listError:''}));
 const latest=useRef(snapshot),bound=useRef<{companyId:string;userId?:string}|null>(null),controller=useRef(new AbortController()),alive=useRef(true),flights=useRef(new Map<string,Promise<unknown>>()),generations=useRef(new Map<string,number>()),watchers=useRef(new Map<string,number>()),reads=useRef(new Map<string,string>()),reading=useRef(new Map<string,string>()),lastList=useRef(0),wake=useRef<()=>void>(()=>{}),running=useRef(false),backoff=useRef({until:0,rateUntil:0,failures:0,version:0});
 const change=useCallback((fn:(previous:Snapshot)=>Snapshot)=>{if(!alive.current)return;latest.current=fn(latest.current);setSnapshot(latest.current);},[]);
 const feed=useCallback((key:string,fn:(value:ConversationFeed)=>ConversationFeed)=>change(previous=>{const feeds=new Map(previous.feeds);feeds.set(key,fn(feeds.get(key)||emptyFeed));return{...previous,feeds};}),[change]);
 const draft=useCallback((key:string,fn:(value:ConversationDraft)=>ConversationDraft)=>change(previous=>{const drafts=new Map(previous.drafts);drafts.set(key,fn(drafts.get(key)||emptyDraft));return{...previous,drafts};}),[change]);
 function endpoint(channel?:string){return '/api/companies/'+bound.current!.companyId+'/conversations'+(channel?'/'+encodeURIComponent(channel):'');}
 function failed(error:unknown){const value=error as {status?:number;retryAfter?:number};if(value.status===429||!value.status||value.status>=500){backoff.current.failures++;backoff.current.version++;const delay=value.status===429?(value.retryAfter||30)*1000:Math.min(30000,2000*2**Math.min(backoff.current.failures,4));backoff.current.until=Math.max(backoff.current.until,Date.now()+delay);if(value.status===429)backoff.current.rateUntil=Math.max(backoff.current.rateUntil,Date.now()+delay);}}
 function valid(signal:AbortSignal){return alive.current&&!signal.aborted;}
 function single<T>(key:string,task:()=>Promise<T>):Promise<T>{const pending=flights.current.get(key);if(pending)return pending as Promise<T>;const request=task().finally(()=>{if(flights.current.get(key)===request)flights.current.delete(key);});flights.current.set(key,request);return request;}
 function summary(value:ConversationSummary){change(previous=>({ ...previous,conversations:[...previous.conversations.filter(item=>item.channel!==value.channel),mergeSummary(previous.conversations.find(item=>item.channel===value.channel),value)]}));}
 function delivered(messages:ConversationMessage[]){for(const message of messages){if(!message.clientId||message.actor.kind!=='human'||message.actor.id!==bound.current?.userId)continue;const key=conversationKey(message.roomId||'commons',message.parentId);const current=latest.current.drafts.get(key);if(current?.retry?.clientId===message.clientId)draft(key,value=>({...value,draft:value.draft===value.retry?.original?'':value.draft,retry:undefined,error:'',posted:true,jumpRevision:value.jumpRevision+1}));}}
 function ingest(channel:string,messages:ConversationMessage[]){
  change(previous=>{const feeds=new Map(previous.feeds);for(const message of messages){const key=conversationKey(channel,message.parentId),current=feeds.get(key);if(current?.loaded)feeds.set(key,{...current,messages:merge(current.messages,[message])});}return{...previous,feeds};});delivered(messages);
 }
 async function list(){if(!bound.current)return;const signal=controller.current.signal;return single('list',async()=>{try{const value=await request<{conversations:ConversationSummary[]}>(endpoint(),'GET',undefined,{signal});if(valid(signal)){change(previous=>({...previous,conversations:value.conversations.map(item=>mergeSummary(previous.conversations.find(old=>old.channel===item.channel),item)),listLoaded:true,listError:''}));lastList.current=Date.now();}}catch(error){if(valid(signal)){failed(error);change(previous=>({...previous,listError:error instanceof Error?error.message:'Conversations could not be loaded.'}));}}});}
 async function history(channel:string,parentId:string|null=null,older=false,reset=false){
  const key=conversationKey(channel,parentId),initial=latest.current.feeds.get(key)||emptyFeed;
  if(!bound.current||parentId&&latest.current.feeds.get(channel)?.loading||older&&(!initial.hasMore||!initial.nextBefore))return;
  const signal=controller.current.signal;
  return single('history:'+key+(reset?':reset':older?':older':':latest'),async()=>{
   if(reset&&!parentId){generations.current.set(channel,(generations.current.get(channel)||0)+1);for(const flight of flights.current.keys())if(flight.startsWith('history:'+channel+':'))flights.current.delete(flight);change(previous=>{const feeds=new Map(previous.feeds);for(const [feedKey,value]of feeds)if(feedKey.startsWith(channel+':'))feeds.set(feedKey,{...emptyFeed,prependRevision:value.prependRevision});return{...previous,feeds};});}
   const generation=generations.current.get(channel)||0,currentGeneration=()=>generation===(generations.current.get(channel)||0);
   feed(key,value=>({...value,loading:!older,loadingOlder:older,error:''}));
   try{const query=new URLSearchParams({limit:'50'});if(parentId)query.set('parentId',parentId);if(older&&initial.nextBefore)query.set('before',initial.nextBefore);
    const value=await request<ConversationHistory>(endpoint(channel)+'/messages?'+query,'GET',undefined,{signal});if(!valid(signal)||!currentGeneration())return;
    feed(key,current=>({...current,messages:reset?value.messages:merge(current.messages,value.messages),loaded:true,loading:false,loadingOlder:false,error:'',hasMore:value.hasMore,nextBefore:value.nextBefore,cursor:!parentId&&!older?value.conversation.lastSequence:current.cursor,prependRevision:current.prependRevision+(older?1:0)}));
    summary(value.conversation);delivered(value.messages);
   }catch(error){if(valid(signal)&&currentGeneration()){failed(error);feed(key,value=>({...value,loading:false,loadingOlder:false,error:error instanceof Error?error.message:'Messages could not be loaded.'}));}}
  });
 }
 async function sync(channel:string){
  const signal=controller.current.signal;return single('sync:'+channel,async()=>{
   let current=latest.current.feeds.get(channel),requestGeneration=generations.current.get(channel)||0;if(current?.loading)return;if(!current?.loaded){await history(channel);return;}
   try{for(let page=0;page<8&&valid(signal);page++){
    current=latest.current.feeds.get(channel)!;if(current.loading)return;requestGeneration=generations.current.get(channel)||0;const value=await request<ConversationSync>(endpoint(channel)+'/events?after='+encodeURIComponent(current.cursor)+'&limit=100','GET',undefined,{signal});if(!valid(signal)||requestGeneration!==(generations.current.get(channel)||0))return;
    let cursor=sequence(current.cursor),gap=false;for(const event of value.events){if(sequence(event.sequence)<=cursor)continue;if(sequence(event.sequence)!==cursor+BigInt(1)){gap=true;break;}cursor=sequence(event.sequence);}
    if(value.resetRequired||gap||sequence(value.cursor)!==cursor){await history(channel,null,false,true);for(const key of watchers.current.keys())if(key.startsWith(channel+':'))await history(channel,key.slice(channel.length+1),false,true);return;}
    ingest(channel,value.events.flatMap(event=>[...(event.message?[event.message]:[]),...(event.parentMessage?[event.parentMessage]:[])]));
    feed(channel,old=>({...old,cursor:value.cursor,error:''}));if(value.events.length)lastList.current=0;
    for(const event of value.events)if(event.read?.actor.kind==='human'&&event.read.actor.id===bound.current?.userId)change(previous=>({...previous,conversations:previous.conversations.map(item=>item.channel===channel?{...item,readSequence:maximum(item.readSequence,event.read!.sequence)}:item)}));
    if(!value.hasMore)break;
   }}catch(error){if(valid(signal)&&requestGeneration===(generations.current.get(channel)||0)){failed(error);if((error as {code?:string}).code==='CURSOR_INVALID')await history(channel,null,false,true);else feed(channel,value=>({...value,error:error instanceof Error?error.message:'Reconnecting to the conversation…'}));}}
  });
 }
 async function flushRead(channel:string){return single('read:'+channel,async()=>{while(reads.current.has(channel)&&alive.current&&Date.now()>=backoff.current.until){const value=reads.current.get(channel)!;reads.current.delete(channel);const known=latest.current.conversations.find(item=>item.channel===channel)?.readSequence||'0';if(sequence(value)<=sequence(known))continue;const signal=controller.current.signal;reading.current.set(channel,value);try{const result=await request<{conversation:ConversationSummary}>(endpoint(channel)+'/read','PUT',{sequence:value},{signal});if(valid(signal))summary(result.conversation);}catch(error){if(valid(signal)){failed(error);reads.current.set(channel,maximum(reads.current.get(channel)||'0',value));}break;}finally{reading.current.delete(channel);}}});}
 async function run(){
  const paused=()=>!alive.current||document.hidden||Date.now()<backoff.current.until;
  if(running.current||!bound.current||!watchers.current.size||paused())return;running.current=true;const version=backoff.current.version;
  try{
   if(Date.now()-lastList.current>12000)await list();if(paused())return;
   const channels=new Set([...watchers.current.keys()].filter(key=>key!=='list').map(key=>key.split(':')[0]));
   for(const channel of channels){await sync(channel);if(paused())return;}
   for(const key of watchers.current.keys())if(key!=='list'&&!latest.current.feeds.get(key)?.loaded){const [channel,parentId]=key.split(':');await history(channel,parentId||null);if(paused())return;}
   for(const channel of [...reads.current.keys()]){await flushRead(channel);if(paused())return;}
  }finally{running.current=false;if(backoff.current.version===version)backoff.current.failures=0;}
 }
 wake.current=()=>void run();
 useEffect(()=>{alive.current=true;if(controller.current.signal.aborted)controller.current=new AbortController();const stop=startPolling(()=>run(),{intervalMs:2000,active:()=>!document.hidden});const resume=()=>{if(!document.hidden){lastList.current=0;wake.current();}};window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);return()=>{alive.current=false;stop();controller.current.abort();flights.current.clear();window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};},[]);
 const watch=useCallback((companyId:string,channel?:string,parentId:string|null=null,userId?:string)=>{
  if(bound.current&&bound.current.companyId!==companyId)throw new Error('Conversation scope must change with the company.');bound.current={companyId,userId:userId||bound.current?.userId};const key=channel?conversationKey(channel,parentId):'list';watchers.current.set(key,(watchers.current.get(key)||0)+1);queueMicrotask(()=>wake.current());return()=>{const count=(watchers.current.get(key)||1)-1;if(count)watchers.current.set(key,count);else watchers.current.delete(key);};
 },[]);
 const setDraft=useCallback((key:string,value:string)=>draft(key,current=>({...current,draft:value,posted:false})),[draft]);
 async function send(channel:string,parentId:string|null,body:string,retryOriginal=false){
  const key=conversationKey(channel,parentId);if(!bound.current||flights.current.has('send:'+key)||!body.trim())return;
  const previous=latest.current.drafts.get(key)||emptyDraft;
  if(Date.now()<backoff.current.rateUntil){draft(key,value=>({...value,error:'Please wait '+Math.ceil((backoff.current.rateUntil-Date.now())/1000)+' seconds before trying to send again.'}));return;}
  if(previous.retry&&!retryOriginal&&previous.retry.body!==body.trim()){draft(key,value=>({...value,error:'Retry the earlier message first. Your new draft is kept.'}));return;}
  const attempt=previous.retry||{clientId:crypto.randomUUID(),body:body.trim(),original:body,parentId},signal=controller.current.signal;
  draft(key,value=>({...value,sending:true,error:'',posted:false,retry:attempt}));
  return single('send:'+key,async()=>{try{const result=await request<{message:ConversationMessage;replayed:boolean}>(endpoint(channel)+'/messages','POST',{clientId:attempt.clientId,body:attempt.body,...(parentId?{parentId}: {})},{signal});if(!valid(signal))return;ingest(channel,[result.message]);delivered([result.message]);lastList.current=0;void sync(channel);}catch(error){if(valid(signal)){failed(error);if(latest.current.drafts.get(key)?.retry?.clientId===attempt.clientId){const status=(error as {status?:number}).status;const rejected=!attempt.uncertain&&[400,401,403,404,413,415,429].includes(status||0);draft(key,value=>({...value,retry:rejected?undefined:{...attempt,uncertain:true},error:error instanceof Error?error.message:'Delivery could not be confirmed. Retry safely.'}));}}}finally{if(valid(signal))draft(key,value=>({...value,sending:false}));}});
 }
 async function mutate(channel:string,message:ConversationMessage,kind:'edit'|'delete'|'reaction',value?:string,active?:boolean){const signal=controller.current.signal;const path=endpoint(channel)+'/messages/'+encodeURIComponent(message.id)+(kind==='reaction'?'/reactions':'');try{const result=await request<{message:ConversationMessage}>(path,kind==='edit'?'PATCH':kind==='delete'?'DELETE':'PUT',kind==='edit'?{body:value,revision:message.revision}:kind==='delete'?{revision:message.revision}:{emoji:value as MessageReaction,active},{signal});if(valid(signal)){ingest(channel,[result.message]);void sync(channel);}return result.message;}catch(error){if(valid(signal)&&(error as {code?:string}).code==='MESSAGE_CONFLICT')await history(channel,message.parentId,false,true);throw error;}}
 function markRead(channel:string,value:string){if(!bound.current||document.hidden)return;const current=maximum(latest.current.conversations.find(item=>item.channel===channel)?.readSequence||'0',reading.current.get(channel)||'0');if(sequence(value)<=sequence(current))return;const old=reads.current.get(channel);if(!old||sequence(value)>sequence(old))reads.current.set(channel,value);void flushRead(channel);}
 return {snapshot,watch,setDraft,send,mutate,markRead,loadOlder:(channel:string,parentId:string|null=null)=>history(channel,parentId,true),reload:(channel:string,parentId:string|null=null)=>history(channel,parentId,false,true),refreshList:list};
}
