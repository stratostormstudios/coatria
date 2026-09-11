'use client';

import {createContext,useCallback,useContext,useEffect,useId,useLayoutEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {ArrowDown,ArrowLeft,Bot,Check,Hash,Maximize2,MessageCircle,MessageSquare,PanelLeft,PanelRightOpen,Pencil,Search,Send,SmilePlus,Trash2,X} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import {when,type Workspace} from '@/lib/client';
import {MESSAGE_REACTIONS,type ConversationMessage} from '@/lib/conversation-protocol';
import {useConversationClient,conversationKey,emptyDraft,emptyFeed} from './useConversationClient';
import {Avatar} from './ui';
import s from './Conversations.module.css';

type ReadPosition={top:number;atBottom:boolean;ids:Set<string>;unseen:number;jumpRevision:number;prependRevision:number;height:number};
type ConversationStore=ReturnType<typeof useConversationClient>&{readPositions:Map<string,ReadPosition>;threads:Map<string,string|null>;openThread:(channel:string,id:string|null)=>void};
const ConversationContext=createContext<ConversationStore|null>(null);
export function ConversationProvider({scope,children}:{scope:string;children:ReactNode}){return <ScopedConversations key={scope}>{children}</ScopedConversations>;}
function ScopedConversations({children}:{children:ReactNode}){
 const client=useConversationClient(),readPositions=useRef(new Map<string,ReadPosition>()),[threads,setThreads]=useState(new Map<string,string|null>());
 const openThread=useCallback((channel:string,id:string|null)=>setThreads(previous=>new Map(previous).set(channel,id)),[]);
 return <ConversationContext.Provider value={{...client,readPositions:readPositions.current,threads,openThread}}>{children}</ConversationContext.Provider>;
}

export function dayLabel(value:string){
 const date=new Date(value),today=new Date();
 if(date.toDateString()===today.toDateString())return 'Today';
 today.setDate(today.getDate()-1);if(date.toDateString()===today.toDateString())return 'Yesterday';
 return date.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',...(date.getFullYear()!==new Date().getFullYear()?{year:'numeric' as const}:{})});
}

export function ConversationList({workspace,roomId,onRoom,onBack,compact=false}:{workspace:Workspace;roomId:string|null;onRoom:(id:string|null)=>void;onBack?:()=>void;compact?:boolean}){
 const [query,setQuery]=useState(''),store=useContext(ConversationContext),searchId=useId();
 useEffect(()=>store?.watch(workspace.company.id),[store?.watch,workspace.company.id]);
 const rooms=(store?.snapshot.conversations||[]).filter(room=>room.roomId&&room.name.toLowerCase().includes(query.trim().toLowerCase()));
 function channel(id:string|null,name:string){
  const key=id||'commons',last=store?.snapshot.feeds.get(key)?.messages.findLast(message=>!message.deletedAt),draft=store?.snapshot.drafts.get(key)?.draft,unread=store?.snapshot.conversations.find(item=>item.channel===key)?.unreadCount||0;
  return <button key={id||'commons'} type="button" className={s.channelButton+(roomId===id?' '+s.selected:'')} aria-label={id?'# '+name:name} aria-description={unread?unread+' unread messages':undefined} aria-current={roomId===id?'page':undefined} onClick={()=>onRoom(id)}>
   <span className={s.channelIcon} aria-hidden="true">{id?<Hash size={17}/>:<MessageCircle size={18}/>}</span><span className={s.channelText}><strong>{name}</strong><small>{draft?<span className={s.draftLabel}>Draft saved in this session</span>:last?(last.authorName?.split(' ')[0]||'Teammate')+': '+last.body:id?'Room conversation':'Everyone in the company'}</small></span>{unread>0&&<span className={s.unreadCount} aria-hidden="true">{unread>99?'99+':unread}</span>}
  </button>;
 }
 return <div className={s.list+(compact?' '+s.compactList:'')}>
  {onBack&&<button type="button" className={s.back} onClick={onBack}><ArrowLeft size={16}/> Back to workplace</button>}
  <div className={s.listTitle}><h2>Conversations</h2><MessageSquare size={18} aria-hidden="true"/></div>
  <div className={s.search}><Search size={16} aria-hidden="true"/><label className="sr-only" htmlFor={searchId}>Search conversations</label><input id={searchId} type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Find a conversation…"/>{query&&<button type="button" aria-label="Clear search conversations" onClick={()=>setQuery('')}><X size={14}/></button>}</div>
  <div className={s.channelScroll}>{channel(null,'Company commons')}<div className={s.channelSection}><span>Room conversations</span><span>{rooms.length}</span></div>{rooms.map(room=>channel(room.roomId,room.name))}{!store?.snapshot.listLoaded?<p className={s.listEmpty} role="status">Loading conversations…</p>:!rooms.length&&<p className={s.listEmpty}>{query?'No rooms match “'+query+'”.':'Your room conversations will appear here.'}</p>}{store?.snapshot.listError&&<p className={s.error} role="alert">{store.snapshot.listError}<button className={s.inlineButton} onClick={()=>void store.refreshList()}>Retry</button></p>}</div>
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
 const store=useContext(ConversationContext)!,presentation=p.presentation||'room',channel=p.roomId||'commons',threadId=store.threads.get(channel)||null,key=conversationKey(channel,threadId);
 const state=store.snapshot.drafts.get(key)||emptyDraft,data=store.snapshot.feeds.get(key)||emptyFeed,messages=data.messages,parent=threadId?store.snapshot.feeds.get(channel)?.messages.find(message=>message.id===threadId):undefined;
 const room=p.workspace.rooms.find(value=>value.id===p.roomId),name=room?.name||'Company commons',unavailable=Boolean(p.roomId&&!room)||Boolean(parent?.deletedAt);
 useEffect(()=>store.watch(p.company.id,channel,null,p.user.id),[store.watch,p.company.id,p.user.id,channel]);
 useEffect(()=>threadId?store.watch(p.company.id,channel,threadId,p.user.id):undefined,[store.watch,p.company.id,p.user.id,channel,threadId]);
 const inputId=useId(),selectorId=useId(),headingId=useId(),viewport=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),[unseen,setUnseen]=useState(0);
 const read=useRef<ReadPosition>({top:0,atBottom:true,ids:new Set(),unseen:0,jumpRevision:0,prependRevision:0,height:0});
 const tail=messages.at(-1)?.id||'',first=messages[0]?.id||'',lastSequence=messages.at(-1)?.sequence||parent?.sequence||'0';
 function acknowledge(){const element=viewport.current;if(threadId||!element||!read.current.atBottom||document.hidden)return;const rect=element.getBoundingClientRect();if(rect.bottom>0&&rect.top<innerHeight)store.markRead(channel,lastSequence);}
 function jump(){const element=viewport.current;if(element)element.scrollTop=element.scrollHeight;read.current.atBottom=true;read.current.top=element?.scrollTop||0;read.current.unseen=0;setUnseen(0);store.readPositions.set(key,{...read.current});acknowledge();}
 useLayoutEffect(()=>{
  const element=viewport.current;if(!element)return;
  const saved=store.readPositions.get(key),initial=!saved;
  read.current=saved?{...saved}:{top:0,atBottom:true,ids:new Set(),unseen:0,jumpRevision:state.jumpRevision,prependRevision:data.prependRevision,height:0};
  const added=initial?0:messages.filter(message=>!read.current.ids.has(message.id)).length,prepended=data.prependRevision>read.current.prependRevision;
  if(prepended){element.scrollTop=read.current.top+element.scrollHeight-read.current.height;}
  else if(read.current.atBottom||state.jumpRevision>read.current.jumpRevision){element.scrollTop=element.scrollHeight;read.current.atBottom=true;read.current.unseen=0;}
  else{element.scrollTop=read.current.top;read.current.unseen+=added;}
  read.current.ids=new Set(messages.map(message=>message.id));read.current.top=element.scrollTop;read.current.jumpRevision=state.jumpRevision;read.current.prependRevision=data.prependRevision;read.current.height=element.scrollHeight;
  setUnseen(read.current.unseen);store.readPositions.set(key,{...read.current});acknowledge();
  return()=>{store.readPositions.set(key,{...read.current,top:element.scrollTop});};
 },[key,first,tail,state.jumpRevision,data.prependRevision,store.readPositions]);
 useEffect(()=>{const element=viewport.current;if(!element)return;const observer=new IntersectionObserver(entries=>{if(entries[0]?.isIntersecting)acknowledge();},{threshold:.1});observer.observe(element);document.addEventListener('visibilitychange',acknowledge);return()=>{observer.disconnect();document.removeEventListener('visibilitychange',acknowledge);};},[channel,key,lastSequence]);
 useLayoutEffect(()=>{const element=textarea.current;if(!element)return;element.style.height='auto';element.style.height=Math.min(160,Math.max(52,element.scrollHeight))+'px';},[state.draft,presentation]);
 function send(event:FormEvent){event.preventDefault();if(!unavailable&&data.loaded)void store.send(channel,threadId,state.draft);}
 return <section className={s.pane+' '+s[presentation]} aria-labelledby={headingId} data-conversation-presentation={presentation}>
  <header className={s.header}>
   {p.onConversations&&<button type="button" className={s.mobileListButton+' '+s.iconButton} aria-label="Open conversations" title="Open conversations" onClick={p.onConversations}><PanelLeft size={19}/></button>}
   <span className={s.headingIcon} aria-hidden="true">{p.roomId?<Hash size={21}/>:<MessageSquare size={21}/>}</span>
   <div className={s.heading}><h2 id={headingId}>{unavailable?'Conversation unavailable':name}</h2><p>{p.roomId?'Room conversation · visible to company members':'Everyone at '+p.company.name}</p></div>
   <div className={s.headerActions}>{p.onDock&&<button type="button" className={s.iconButton} aria-label="Dock conversation" title="Keep this conversation beside your office" onClick={p.onDock}><PanelRightOpen size={19}/></button>}{p.onExpand&&<button type="button" className={s.iconButton} aria-label="Expand conversation" title="Expand conversation" onClick={p.onExpand}><Maximize2 size={18}/></button>}{p.onClose&&<button type="button" className={s.iconButton} aria-label="Close conversation panel" title="Close conversation panel" onClick={p.onClose}><X size={19}/></button>}</div>
  </header>
  {p.onRoom&&<div className={s.conversationPicker}><label className="sr-only" htmlFor={selectorId}>Choose conversation</label><select id={selectorId} value={p.roomId||''} onChange={event=>p.onRoom?.(event.target.value||null)}><option value="">Company commons</option>{p.workspace.rooms.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></div>}
  {threadId&&<div className={s.threadBar}><button type="button" onClick={()=>store.openThread(channel,null)}><ArrowLeft size={15}/> Back to conversation</button><strong>Thread</strong></div>}
  {data.error&&<div className={s.connectionNotice} role="alert"><span>{data.loaded?'Reconnecting. Messages shown may be behind. ':''}{data.error}</span><button onClick={()=>void store.reload(channel,threadId)}>Retry</button></div>}
  <div className={s.messageViewport}><div ref={viewport} className={s.messages} role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text" tabIndex={0} onScroll={()=>{const element=viewport.current;if(!element)return;read.current.top=element.scrollTop;read.current.atBottom=element.scrollHeight-element.scrollTop-element.clientHeight<64;if(read.current.atBottom){read.current.unseen=0;setUnseen(0);}store.readPositions.set(key,{...read.current});acknowledge();}}>
   {data.hasMore&&<button className={s.loadOlder} disabled={data.loadingOlder} onClick={()=>void store.loadOlder(channel,threadId)}>{data.loadingOlder?'Loading older messages…':'Load older messages'}</button>}
   {parent&&<div className={s.threadParent}><MessageRow message={parent} userId={p.user.id} channel={channel} store={store}/><span>Replies</span></div>}
   {!data.loaded?<div className={s.loading} role="status">{data.error?'Messages are unavailable.':'Loading messages…'}</div>:messages.length?<div className={s.messageHistory}>{messages.map((message,index)=><div key={message.id} data-message-id={message.id}>{(!index||new Date(messages[index-1].createdAt).toDateString()!==new Date(message.createdAt).toDateString())&&<div className={s.dateDivider}><span>{dayLabel(message.createdAt)}</span></div>}<MessageRow message={message} userId={p.user.id} channel={channel} store={store} onReply={!threadId?()=>store.openThread(channel,message.id):undefined}/></div>)}</div>:<div className={s.empty}><span aria-hidden="true">{threadId?<MessageSquare size={26}/>:p.roomId?<Hash size={26}/>:<MessageCircle size={28}/>}</span><h3>{unavailable?'This conversation is no longer available':threadId?'Add the first reply':'Start the conversation'}</h3><p>{unavailable?'Choose another conversation to continue.':threadId?'Keep the follow-up with the original message.':'Share an update, ask a question, or give your team a little context.'}</p><small>Messages here are visible to company members.</small></div>}

  </div>{unseen>0&&<button type="button" className={s.newMessages} onClick={jump}><ArrowDown size={15}/>{unseen} new {unseen===1?'message':'messages'} · Jump to latest</button>}</div>
  <form className={s.composer} onSubmit={send}><div className={s.composeBox}><label className="sr-only" htmlFor={inputId}>Your message</label><textarea ref={textarea} id={inputId} value={state.draft} onChange={event=>store.setDraft(key,event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();send(event);}}} disabled={unavailable||!data.loaded} maxLength={4000} rows={2} placeholder={threadId?'Reply in thread…':'Message '+name+'…'}/><div className={s.composeActions}><small>{state.draft.length>3500?state.draft.length+' / 4,000 characters':<><span>Enter to send</span><span className={s.newlineHint}> · Shift + Enter for a new line</span></>}</small><button className={s.send} type="submit" disabled={unavailable||!data.loaded||state.sending||!state.draft.trim()}><Send size={15} aria-hidden="true"/>{state.sending?'Sending…':'Send'}</button></div></div>
   <div className={s.messageStatus} aria-live="polite">{state.sending?'Posting your message…':state.posted?<span><Check size={13}/> Message posted</span>:state.draft&&!state.error?'Draft kept while you switch conversations.':''}</div>
   {state.error&&<div className={s.error} role="alert">{state.retry?'Delivery is unconfirmed. Your draft is kept. ':'Message not sent. Your draft is kept. '}{state.error}{state.retry&&<button type="button" className={s.inlineButton} disabled={state.sending} onClick={()=>void store.send(channel,threadId,state.retry!.original,true)}>Retry original message</button>}</div>}
  </form>
 </section>;
}

const reactionGlyphs={thumbsup:'👍',heart:'❤️',applause:'👏',laugh:'😄',idea:'💡',celebrate:'🎉'};
function MessageRow({message,userId,channel,store,onReply}:{message:ConversationMessage;userId:string;channel:string;store:ConversationStore;onReply?:()=>void}){
 const own=message.actor.kind==='human'&&message.actor.id===userId;
 const [editing,setEditing]=useState(false),[body,setBody]=useState(message.body),[revision,setRevision]=useState(message.revision),[deleting,setDeleting]=useState(false),[picker,setPicker]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function action(kind:'edit'|'delete'|'reaction',value?:string,active?:boolean){setBusy(true);setError('');try{await store.mutate(channel,kind==='edit'?{...message,revision}:message,kind,value,active);setEditing(false);setDeleting(false);setPicker(false);}catch(error){setError(error instanceof Error?error.message:'This action could not be completed.');}finally{setBusy(false);}}
 return <article className={'message '+s.message+(own?' own':'')}>
  {message.actor.kind==='agent'?<span className={s.agentAvatar} aria-hidden="true"><Bot size={19}/></span>:<Avatar name={message.authorName||'Team member'} size="small"/>}
  <div><div className={'message-meta '+s.messageMeta}><strong>{message.authorName||'Team member'}{own&&<span className={s.youLabel}>you</span>}{message.actor.kind==='agent'&&<span className={s.agentLabel}>AI agent</span>}</strong><time dateTime={message.createdAt} title={when(message.createdAt)}>{new Date(message.createdAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>{message.editedAt&&!message.deletedAt&&<span className={s.edited}>edited</span>}</div>
   {message.deletedAt?<p className={s.deleted}>Message deleted</p>:editing?<form className={s.editForm} onSubmit={event=>{event.preventDefault();void action('edit',body);}}><label className="sr-only" htmlFor={'edit-message-'+message.id}>Edit message text</label><textarea id={'edit-message-'+message.id} maxLength={4000} value={body} onChange={event=>setBody(event.target.value)} autoFocus/><div><button type="button" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button><button type="submit" disabled={busy||!body.trim()}>{busy?'Saving…':'Save changes'}</button></div></form>:<p>{message.body}</p>}
   {!message.deletedAt&&!editing&&<div className={s.messageActions}><button type="button" aria-label="Add reaction" aria-expanded={picker} disabled={busy} onClick={()=>setPicker(value=>!value)}><SmilePlus size={14}/></button>{onReply&&<button type="button" onClick={onReply}><MessageSquare size={14}/>{message.replyCount?message.replyCount+' '+(message.replyCount===1?'reply':'replies'):'Reply'}</button>}{own&&<><button type="button" aria-label="Edit message" disabled={busy} onClick={()=>{setBody(message.body);setRevision(message.revision);setEditing(true);setError('');}}><Pencil size={13}/></button><button type="button" aria-label="Delete message" disabled={busy} onClick={()=>setDeleting(true)}><Trash2 size={13}/></button></>}</div>}
   {message.deletedAt&&onReply&&message.replyCount>0&&<button className={s.inlineButton} onClick={onReply}>{message.replyCount} replies</button>}
   {picker&&!message.deletedAt&&<div className={s.reactionPicker} role="group" aria-label="Choose a reaction">{MESSAGE_REACTIONS.map(emoji=><button key={emoji} type="button" aria-label={'React with '+emoji} disabled={busy} onClick={()=>void action('reaction',emoji,!message.reactions.find(value=>value.emoji===emoji)?.mine)}>{reactionGlyphs[emoji]}</button>)}</div>}
   {!message.deletedAt&&message.reactions.length>0&&<div className={s.reactions}>{message.reactions.map(reaction=><button key={reaction.emoji} type="button" aria-label={reaction.emoji+': '+reaction.count+' reactions'} aria-pressed={reaction.mine} disabled={busy} onClick={()=>void action('reaction',reaction.emoji,!reaction.mine)}>{reactionGlyphs[reaction.emoji]} <span>{reaction.count}</span></button>)}</div>}
   {deleting&&<div className={s.deleteConfirm}><span>Delete this message?</span><button disabled={busy} onClick={()=>setDeleting(false)}>Cancel</button><button disabled={busy} onClick={()=>void action('delete')}>{busy?'Deleting…':'Delete message'}</button></div>}
   {error&&<div className={s.error} role="alert">{error}</div>}
  </div>
 </article>;
}
