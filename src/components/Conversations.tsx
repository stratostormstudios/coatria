'use client';

import {createContext,useCallback,useContext,useEffect,useId,useLayoutEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {ArrowDown,ArrowLeft,Check,Hash,Maximize2,MessageCircle,MessageSquare,PanelLeft,PanelRightOpen,Search,Send,X} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import {api,when,type Workspace} from '@/lib/client';
import {Avatar} from './ui';
import s from './Conversations.module.css';

type ChannelState={draft:string;sending:boolean;error:string;posted:boolean;refreshError:string;jumpRevision:number};
type ReadPosition={top:number;atBottom:boolean;ids:Set<string>;unseen:number;jumpRevision:number};
type SendRequest={channel:string;roomId:string|null;companyId:string;body:string;refresh:()=>Promise<void>};
type ConversationStore={channels:Map<string,ChannelState>;readPositions:Map<string,ReadPosition>;setDraft:(channel:string,body:string)=>void;send:(request:SendRequest)=>Promise<void>};
const emptyChannel:ChannelState={draft:'',sending:false,error:'',posted:false,refreshError:'',jumpRevision:0};
const ConversationContext=createContext<ConversationStore|null>(null);

/** The keyed boundary drops private drafts and aborts pending requests when its scope changes. */
export function ConversationProvider({scope,children}:{scope:string;children:ReactNode}){
 return <ScopedConversations key={scope}>{children}</ScopedConversations>;
}
function ScopedConversations({children}:{children:ReactNode}){
 const [channels,setChannels]=useState(()=>new Map<string,ChannelState>());
 const readPositions=useRef(new Map<string,ReadPosition>()),pending=useRef(new Map<string,AbortController>()),active=useRef(true);
 useEffect(()=>{active.current=true;return()=>{active.current=false;for(const controller of pending.current.values())controller.abort();pending.current.clear();readPositions.current.clear();};},[]);
 const update=useCallback((channel:string,change:(current:ChannelState)=>ChannelState)=>{if(active.current)setChannels(previous=>{const next=new Map(previous);next.set(channel,change(previous.get(channel)||emptyChannel));return next;});},[]);
 const setDraft=useCallback((channel:string,draft:string)=>update(channel,current=>({...current,draft,posted:false,refreshError:''})),[update]);
 const send=useCallback(async({channel,roomId,companyId,body,refresh}:SendRequest)=>{
  if(!body.trim()||pending.current.has(channel)||!active.current)return;
  const controller=new AbortController();pending.current.set(channel,controller);
  const current=()=>active.current&&!controller.signal.aborted&&pending.current.get(channel)===controller;
  update(channel,value=>({...value,sending:true,error:'',posted:false,refreshError:''}));
  try{
   await api('/api/companies/'+companyId+'/messages','POST',{body:body.trim(),roomId},{signal:controller.signal});
   if(!current())return;
   update(channel,value=>({...value,draft:value.draft===body?'':value.draft,posted:true,jumpRevision:value.jumpRevision+1}));
   // A successful POST must never be presented as a failed send when refreshing is interrupted.
   try{await refresh();}catch{if(current())update(channel,value=>({...value,refreshError:'Your message was posted. The conversation will update when the connection returns.'}));}
  }catch(error){if(current())update(channel,value=>({...value,error:error instanceof Error?error.message:'Please try again.'}));}
  finally{if(current())update(channel,value=>({...value,sending:false}));if(pending.current.get(channel)===controller)pending.current.delete(channel);}
 },[update]);
 return <ConversationContext.Provider value={{channels,readPositions:readPositions.current,setDraft,send}}>{children}</ConversationContext.Provider>;
}

export function dayLabel(value:string){
 const date=new Date(value),today=new Date();
 if(date.toDateString()===today.toDateString())return 'Today';
 today.setDate(today.getDate()-1);if(date.toDateString()===today.toDateString())return 'Yesterday';
 return date.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',...(date.getFullYear()!==new Date().getFullYear()?{year:'numeric' as const}:{})});
}

export function ConversationList({workspace,roomId,onRoom,onBack,compact=false}:{workspace:Workspace;roomId:string|null;onRoom:(id:string|null)=>void;onBack?:()=>void;compact?:boolean}){
 const [query,setQuery]=useState(''),store=useContext(ConversationContext),searchId=useId();
 const rooms=workspace.rooms.filter(room=>room.name.toLowerCase().includes(query.trim().toLowerCase()));
 function channel(id:string|null,name:string){
  const last=workspace.messages.findLast(message=>(message.roomId||null)===id),draft=store?.channels.get(id||'commons')?.draft;
  return <button key={id||'commons'} type="button" className={s.channelButton+(roomId===id?' '+s.selected:'')} aria-label={id?'# '+name:name} aria-current={roomId===id?'page':undefined} onClick={()=>onRoom(id)}>
   <span className={s.channelIcon} aria-hidden="true">{id?<Hash size={17}/>:<MessageCircle size={18}/>}</span><span className={s.channelText}><strong>{name}</strong><small>{draft?<span className={s.draftLabel}>Draft saved in this session</span>:last?(last.authorName?.split(' ')[0]||'Teammate')+': '+last.body:id?'Room conversation':'Everyone in the company'}</small></span>
  </button>;
 }
 return <div className={s.list+(compact?' '+s.compactList:'')}>
  {onBack&&<button type="button" className={s.back} onClick={onBack}><ArrowLeft size={16}/> Back to workplace</button>}
  <div className={s.listTitle}><h2>Conversations</h2><MessageSquare size={18} aria-hidden="true"/></div>
  <div className={s.search}><Search size={16} aria-hidden="true"/><label className="sr-only" htmlFor={searchId}>Search conversations</label><input id={searchId} type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Find a conversation…"/>{query&&<button type="button" aria-label="Clear search conversations" onClick={()=>setQuery('')}><X size={14}/></button>}</div>
  <div className={s.channelScroll}>{channel(null,'Company commons')}<div className={s.channelSection}><span>Room conversations</span><span>{rooms.length}</span></div>{rooms.map(room=>channel(room.id,room.name))}{!rooms.length&&<p className={s.listEmpty}>{query?'No rooms match “'+query+'”.':'Your room conversations will appear here.'}</p>}</div>
  <p className={s.listFootnote}>Reading a conversation doesn’t move you into its room.</p>
 </div>;
}

export type ChatPaneProps=WorkspaceProps&{roomId:string|null;presentation?:'full'|'dock'|'room';onRoom?:(id:string|null)=>void;onExpand?:()=>void;onClose?:()=>void;onConversations?:()=>void;onDock?:()=>void};
export function ChatPane(p:ChatPaneProps){
 const store=useContext(ConversationContext);
 // Room-only consumers remain usable outside the shared shell; the main shell provides the persistent store.
 if(!store)return <ConversationProvider scope={p.user.id+':'+p.company.id}><ConversationPane {...p}/></ConversationProvider>;
 return <ConversationPane {...p}/>;
}
function ConversationPane(p:ChatPaneProps){
 const store=useContext(ConversationContext)!,presentation=p.presentation||'room',channel=p.roomId||'commons';
 const state=store.channels.get(channel)||emptyChannel,messages=p.workspace.messages.filter(message=>(message.roomId||null)===(p.roomId||null));
 const room=p.workspace.rooms.find(value=>value.id===p.roomId),name=room?.name||'Company commons',unavailable=Boolean(p.roomId&&!room);
 const inputId=useId(),selectorId=useId(),headingId=useId(),viewport=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),[unseen,setUnseen]=useState(0);
 const read=useRef<ReadPosition>({top:0,atBottom:true,ids:new Set(),unseen:0,jumpRevision:0});
 const tail=messages.at(-1)?.id||'',first=messages[0]?.id||'';
 function jump(){const element=viewport.current;if(element)element.scrollTop=element.scrollHeight;read.current.atBottom=true;read.current.top=element?.scrollTop||0;read.current.unseen=0;setUnseen(0);store.readPositions.set(channel,{...read.current});}
 useLayoutEffect(()=>{
  const element=viewport.current;if(!element)return;
  const saved=store.readPositions.get(channel),initial=!saved;
  read.current=saved?{...saved}:{top:0,atBottom:true,ids:new Set(),unseen:0,jumpRevision:state.jumpRevision};
  const added=initial?0:messages.filter(message=>!read.current.ids.has(message.id)).length;
  if(read.current.atBottom||state.jumpRevision>read.current.jumpRevision){element.scrollTop=element.scrollHeight;read.current.atBottom=true;read.current.unseen=0;}
  else{element.scrollTop=read.current.top;read.current.unseen+=added;}
  read.current.ids=new Set(messages.map(message=>message.id));read.current.top=element.scrollTop;read.current.jumpRevision=state.jumpRevision;
  setUnseen(read.current.unseen);store.readPositions.set(channel,{...read.current});
  return()=>{store.readPositions.set(channel,{...read.current,top:element.scrollTop});};
 },[channel,first,tail,state.jumpRevision,store.readPositions]);
 useLayoutEffect(()=>{const element=textarea.current;if(!element)return;element.style.height='auto';element.style.height=Math.min(160,Math.max(52,element.scrollHeight))+'px';},[state.draft,presentation]);
 function send(event:FormEvent){event.preventDefault();if(!unavailable)void store.send({channel,roomId:p.roomId,companyId:p.company.id,body:state.draft,refresh:p.refresh});}
 return <section className={s.pane+' '+s[presentation]} aria-labelledby={headingId} data-conversation-presentation={presentation}>
  <header className={s.header}>
   {p.onConversations&&<button type="button" className={s.mobileListButton+' '+s.iconButton} aria-label="Open conversations" title="Open conversations" onClick={p.onConversations}><PanelLeft size={19}/></button>}
   <span className={s.headingIcon} aria-hidden="true">{p.roomId?<Hash size={21}/>:<MessageSquare size={21}/>}</span>
   <div className={s.heading}><h2 id={headingId}>{unavailable?'Conversation unavailable':name}</h2><p>{p.roomId?'Room conversation · visible to company members':'Everyone at '+p.company.name}</p></div>
   <div className={s.headerActions}>{p.onDock&&<button type="button" className={s.iconButton} aria-label="Dock conversation" title="Keep this conversation beside your office" onClick={p.onDock}><PanelRightOpen size={19}/></button>}{p.onExpand&&<button type="button" className={s.iconButton} aria-label="Expand conversation" title="Expand conversation" onClick={p.onExpand}><Maximize2 size={18}/></button>}{p.onClose&&<button type="button" className={s.iconButton} aria-label="Close conversation panel" title="Close conversation panel" onClick={p.onClose}><X size={19}/></button>}</div>
  </header>
  {p.onRoom&&<div className={s.conversationPicker}><label className="sr-only" htmlFor={selectorId}>Choose conversation</label><select id={selectorId} value={p.roomId||''} onChange={event=>p.onRoom?.(event.target.value||null)}><option value="">Company commons</option>{p.workspace.rooms.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></div>}
  <div className={s.messageViewport}><div ref={viewport} className={s.messages} role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text" tabIndex={0} onScroll={()=>{const element=viewport.current;if(!element)return;read.current.top=element.scrollTop;read.current.atBottom=element.scrollHeight-element.scrollTop-element.clientHeight<64;if(read.current.atBottom){read.current.unseen=0;setUnseen(0);}store.readPositions.set(channel,{...read.current});}}>
   {messages.length?<div className={s.messageHistory}><p className={s.historyNote}>Recent history · latest 100 messages across company conversations</p>{messages.map((message,index)=><div key={message.id} data-message-id={message.id}>{(!index||new Date(messages[index-1].createdAt).toDateString()!==new Date(message.createdAt).toDateString())&&<div className={s.dateDivider}><span>{dayLabel(message.createdAt)}</span></div>}<article className={'message '+s.message+(message.userId===p.user.id?' own':'')}><Avatar name={message.authorName||'Team member'} size="small"/><div><div className={'message-meta '+s.messageMeta}><strong>{message.authorName||'Team member'}{message.userId===p.user.id&&<span className={s.youLabel}>you</span>}</strong><time dateTime={message.createdAt} title={when(message.createdAt)}>{new Date(message.createdAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time></div><p>{message.body}</p></div></article></div>)}</div>:<div className={s.empty}><span aria-hidden="true">{p.roomId?<Hash size={26}/>:<MessageCircle size={28}/>}</span><h3>{unavailable?'This room is no longer available':'Start the conversation'}</h3><p>{unavailable?'Choose another conversation to continue.':'Share an update, ask a question, or give your team a little context.'}</p><small>{p.roomId?'Messages here are visible to company members.':'This is a shared conversation for your whole company.'}</small></div>}
  </div>{unseen>0&&<button type="button" className={s.newMessages} onClick={jump}><ArrowDown size={15}/>{unseen} new {unseen===1?'message':'messages'} · Jump to latest</button>}</div>
  <form className={s.composer} onSubmit={send}><div className={s.composeBox}><label className="sr-only" htmlFor={inputId}>Your message</label><textarea ref={textarea} id={inputId} value={state.draft} onChange={event=>store.setDraft(channel,event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();send(event);}}} disabled={unavailable} maxLength={4000} rows={2} placeholder={'Message '+name+'…'}/><div className={s.composeActions}><small>{state.draft.length>3500?state.draft.length+' / 4,000 characters':<><span>Enter to send</span><span className={s.newlineHint}> · Shift + Enter for a new line</span></>}</small><button className={s.send} type="submit" disabled={unavailable||state.sending||!state.draft.trim()}><Send size={15} aria-hidden="true"/>{state.sending?'Sending…':'Send'}</button></div></div>
   <div className={s.messageStatus} aria-live="polite">{state.sending?'Posting your message…':state.posted?<span><Check size={13}/> Message posted</span>:state.draft&&!state.error?'Draft kept while you switch conversations.':''}</div>
   {state.error&&<p className={s.error} role="alert">Not sent. Your draft is kept. {state.error} Use Send to try again.</p>}{state.refreshError&&<p className={s.error} role="status">{state.refreshError}</p>}
  </form>
 </section>;
}
