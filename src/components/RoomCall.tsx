'use client';
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, MonitorUp, PhoneOff, Radio } from 'lucide-react';

type PeerInfo={id:string;userId:string;name:string};
type Signal={id:string;senderId:string;payload:{type:'description';description:RTCSessionDescriptionInit}|{type:'candidate';candidate:RTCIceCandidateInit}};
type Connection={pc:RTCPeerConnection;info:PeerInfo;makingOffer:boolean;ignoreOffer:boolean;settingAnswer:boolean;candidates:RTCIceCandidateInit[];stream:MediaStream};
type Remote={id:string;name:string;stream:MediaStream};
type CallSession={active:boolean;closed:boolean;registered:boolean;userId:string;peerId:string;roomId:string;endpoint:string;stream:MediaStream|null;screen:MediaStream|null;peers:Map<string,Connection>;iceServers:RTCIceServer[];cursor:string;timer:ReturnType<typeof setTimeout>|null;watchdog:ReturnType<typeof setInterval>|null;heartbeat:number;authorizedAt:number;screenSenders:Map<string,RTCRtpSender>;sharePending:boolean};
class CallError extends Error { constructor(public status:number,message:string){super(message);} }
async function callRequest<T>(url:string,body?:Record<string,unknown>,userId?:string):Promise<T>{
  const headers:Record<string,string>={};if(body)headers['Content-Type']='application/json';if(userId)headers['X-Coatria-User']=userId;
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  const data=await response.json().catch(()=>({error:'The call service returned an unreadable response.'}));
  if(data.code==='SESSION_CHANGED')window.dispatchEvent(new Event('coatria:session-changed'));
  if(!response.ok)throw new CallError(response.status,data.error||'The call service could not complete this request.');
  return data as T;
}

function RemoteMedia({remote}:{remote:Remote}) {
  const ref=useRef<HTMLVideoElement>(null);
  useEffect(()=>{const video=ref.current;if(video){video.srcObject=remote.stream;void video.play().catch(()=>{});}return()=>{if(video)video.srcObject=null;};},[remote.stream]);
  return <figure className="call-remote"><video ref={ref} autoPlay playsInline controls aria-label={`${remote.name}'s room audio and shared screen`}/><figcaption>{remote.name}</figcaption></figure>;
}

export default function RoomCall({companyId,roomId,user}:{companyId:string;roomId:string;user:{id:string;name:string}}) {
  const [joined,setJoined]=useState(false),[busy,setBusy]=useState(false),[muted,setMuted]=useState(false),[sharing,setSharing]=useState(false),[shareBusy,setShareBusy]=useState(false),[error,setError]=useState(''),[remotes,setRemotes]=useState<Remote[]>([]),[peerCount,setPeerCount]=useState(0),[hasRelay,setHasRelay]=useState(true);
  const state=useRef<CallSession|null>(null),mounted=useRef(true);
  const endpoint=`/api/companies/${companyId}/signals`;
  const current=(s:CallSession)=>state.current===s&&!s.closed;
  const post=(s:CallSession,action:string,extra:Record<string,unknown>={})=>callRequest<{ok:boolean;iceServers?:RTCIceServer[];turnConfigured?:boolean}>(s.endpoint,{action,roomId:s.roomId,peerId:s.peerId,...extra},s.userId);

  function stopScreen(s:CallSession) {
    s.screen?.getTracks().forEach(t=>{t.onended=null;t.stop();});s.screen=null;
    for(const [id,sender] of s.screenSenders){try{s.peers.get(id)?.pc.removeTrack(sender);}catch{}}
    s.screenSenders.clear();if(state.current===s&&mounted.current)setSharing(false);
  }
  function closePeer(s:CallSession,id:string){
    const peer=s.peers.get(id);if(!peer)return;
    peer.pc.onnegotiationneeded=null;peer.pc.onicecandidate=null;peer.pc.ontrack=null;peer.pc.onconnectionstatechange=null;
    peer.stream.getTracks().forEach(track=>{track.onended=null;track.onmute=null;track.onunmute=null;track.stop();});peer.pc.close();
    s.peers.delete(id);s.screenSenders.delete(id);
    if(current(s)&&mounted.current)setRemotes(old=>old.filter(remote=>remote.id!==id));
  }
  async function leave(session=state.current) {
    if(!session||session.closed)return;
    const s=session;s.closed=true;s.active=false;
    if(s.timer)clearTimeout(s.timer);if(s.watchdog)clearInterval(s.watchdog);s.timer=null;s.watchdog=null;
    s.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});s.stream=null;stopScreen(s);
    for(const id of [...s.peers.keys()])closePeer(s,id);
    if(state.current===s){state.current=null;if(mounted.current){setRemotes([]);setPeerCount(0);setJoined(false);setMuted(false);setBusy(false);setShareBusy(false);}}
    if(s.registered)await post(s,'leave').catch(()=>{});
  }
  useEffect(()=>{
    mounted.current=true;
    setJoined(false);setBusy(false);setShareBusy(false);setSharing(false);setMuted(false);setRemotes([]);setPeerCount(0);setError('');
    const end=()=>{void leave();};window.addEventListener('pagehide',end);
    return()=>{mounted.current=false;window.removeEventListener('pagehide',end);void leave();};
  },[companyId,roomId,user.id]); // A pending picker belongs to this exact audience.

  function failure(s:CallSession,cause:unknown,fatal=false){
    if(!current(s)||!mounted.current)return;
    const terminal=fatal||(cause instanceof CallError&&[401,403,404,409].includes(cause.status));
    setError(cause instanceof Error?cause.message:'Could not reach the call service.');
    if(terminal)void leave(s);
  }
  async function sendSignal(s:CallSession,id:string,payload:Signal['payload']){
    if(!current(s)||!s.active)return;
    try{await post(s,'signal',{recipientId:id,payload});}
    catch(cause){if(cause instanceof CallError&&cause.status===404)closePeer(s,id);else failure(s,cause);}
  }

  function connect(s:CallSession,info:PeerInfo):Connection {
    const existing=s.peers.get(info.id);if(existing)return existing;
    const pc=new RTCPeerConnection({iceServers:s.iceServers});
    const peer:Connection={pc,info,makingOffer:false,ignoreOffer:false,settingAnswer:false,candidates:[],stream:new MediaStream()};s.peers.set(info.id,peer);
    pc.onicecandidate=event=>{if(event.candidate&&current(s)&&s.active)void sendSignal(s,info.id,{type:'candidate',candidate:event.candidate.toJSON()});};
    pc.ontrack=event=>{
      if(!current(s))return;
      const track=event.track;
      const publish=()=>{
        if(!current(s)||s.peers.get(info.id)!==peer)return;
        const stream=new MediaStream(peer.stream.getTracks());
        setRemotes(old=>[...old.filter(remote=>remote.id!==info.id),{id:info.id,name:info.name,stream}]);
      };
      const attach=()=>{if(!peer.stream.getTrackById(track.id))peer.stream.addTrack(track);publish();};
      const detach=()=>{peer.stream.removeTrack(track);publish();};
      track.onended=detach;
      // Removed screen tracks become muted on renegotiation. Remove their stale
      // frame, and restore the track if the remote side resumes it later.
      if(track.kind==='video'){track.onmute=detach;track.onunmute=attach;}
      attach();
    };
    pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'&&current(s))setError('A participant could not connect. Rejoin the call; restricted networks may require a configured relay.');};
    pc.onnegotiationneeded=async()=>{
      if(!current(s)||!s.active)return;
      try{peer.makingOffer=true;await pc.setLocalDescription();if(current(s)&&pc.localDescription)await sendSignal(s,info.id,{type:'description',description:pc.localDescription.toJSON()});}
      catch{if(current(s))setError('Call negotiation was interrupted. Rejoin to retry.');}finally{peer.makingOffer=false;}
    };
    for(const track of s.stream?.getTracks()||[])pc.addTrack(track,s.stream!);
    for(const track of s.screen?.getVideoTracks()||[])s.screenSenders.set(info.id,pc.addTrack(track,s.screen!));
    return peer;
  }
  async function receive(s:CallSession,signal:Signal,info:PeerInfo) {
    if(!current(s))return;
    const peer=connect(s,info),pc=peer.pc;
    if(signal.payload.type==='description'){
      const description=signal.payload.description;
      const ready=!peer.makingOffer&&(pc.signalingState==='stable'||peer.settingAnswer);
      const collision=description.type==='offer'&&!ready;
      const polite=s.peerId.localeCompare(info.id)>0;
      peer.ignoreOffer=!polite&&collision;if(peer.ignoreOffer){peer.candidates=[];return;}
      peer.settingAnswer=description.type==='answer';
      try{await pc.setRemoteDescription(description);}finally{peer.settingAnswer=false;}
      if(!current(s))return;
      const queued=peer.candidates.splice(0);for(const candidate of queued){try{await pc.addIceCandidate(candidate);}catch{/* An ICE generation from a rolled-back offer may be obsolete. */}}
      if(description.type==='offer'){await pc.setLocalDescription();if(pc.localDescription)await sendSignal(s,info.id,{type:'description',description:pc.localDescription.toJSON()});}
    }else if(!peer.ignoreOffer){if(pc.remoteDescription)await pc.addIceCandidate(signal.payload.candidate);else if(peer.candidates.length<100)peer.candidates.push(signal.payload.candidate);}
  }
  async function poll(s:CallSession) {
    if(!current(s)||!s.active)return;
    try{
      if(Date.now()-s.heartbeat>12000){await post(s,'heartbeat');s.heartbeat=Date.now();s.authorizedAt=Date.now();}
      if(!current(s))return;
      const data=await callRequest<{peers:PeerInfo[];signals:Signal[]}>(`${s.endpoint}?roomId=${s.roomId}&peerId=${s.peerId}&after=${s.cursor}`,undefined,s.userId);
      if(!current(s)||!s.active)return;s.authorizedAt=Date.now();
      setPeerCount(data.peers.length);
      const peerIds=new Set(data.peers.map(p=>p.id));
      for(const id of [...s.peers.keys()])if(!peerIds.has(id))closePeer(s,id);
      // Both sides may discover at once. The perfect-negotiation role resolves offers deterministically.
      for(const info of data.peers)connect(s,info);
      for(const signal of data.signals){
        if(!current(s))return;
        const info=data.peers.find(p=>p.id===signal.senderId);
        try{if(info)await receive(s,signal,info);}catch{if(current(s))setError('A participant sent an invalid call update. Other call updates will continue.');}
        finally{s.cursor=signal.id;} // One malformed/replayed message must not block the room.
      }
    }catch(cause){failure(s,cause);}
    finally{if(current(s)&&s.active)s.timer=setTimeout(()=>void poll(s),1500);}
  }
  async function join() {
    if(state.current)return;
    setBusy(true);setError('');
    const s:CallSession={active:false,closed:false,registered:false,userId:user.id,peerId:crypto.randomUUID(),roomId,endpoint,stream:null,screen:null,peers:new Map(),iceServers:[],cursor:'0',timer:null,watchdog:null,heartbeat:0,authorizedAt:Date.now(),screenSenders:new Map(),sharePending:false};state.current=s;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Room audio requires HTTPS and a browser with microphone support.');
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(!current(s)){stream.getTracks().forEach(t=>t.stop());return;}
      s.stream=stream;
      const result=await post(s,'join');s.registered=true;
      if(!current(s)){stream.getTracks().forEach(t=>t.stop());await post(s,'leave').catch(()=>{});return;}
      s.iceServers=result.iceServers||[];s.active=true;s.heartbeat=Date.now();s.authorizedAt=Date.now();
      stream.getAudioTracks().forEach(track=>{track.onended=()=>failure(s,new Error('The microphone disconnected. Rejoin the room to choose it again.'),true);});
      s.watchdog=setInterval(()=>{if(current(s)&&Date.now()-s.authorizedAt>45000)failure(s,new Error('Call access could not be refreshed. Audio and screen sharing have stopped. Rejoin when your connection returns.'),true);},1000);
      setHasRelay(Boolean(result.turnConfigured));setJoined(true);setMuted(false);void poll(s);
    }catch(cause){if(current(s)){failure(s,cause,true);}}
    finally{if(current(s)&&mounted.current)setBusy(false);}
  }
  async function share() {
    const s=state.current;if(!s||!s.active||s.closed||s.sharePending)return;
    if(s.screen){stopScreen(s);return;}
    s.sharePending=true;setShareBusy(true);setError('');
    try{
      if(!navigator.mediaDevices?.getDisplayMedia)throw new Error('Screen sharing is unavailable in this browser.');
      const screen=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:10},audio:false});
      if(!current(s)||!s.active){screen.getTracks().forEach(t=>t.stop());return;}
      const track=screen.getVideoTracks()[0];if(!track){screen.getTracks().forEach(t=>t.stop());throw new Error('No screen was selected.');}
      s.screen=screen;track.onended=()=>stopScreen(s);
      for(const [id,peer] of s.peers)s.screenSenders.set(id,peer.pc.addTrack(track,screen));setSharing(true);
    }catch(cause){if(current(s)){stopScreen(s);if(!(cause instanceof DOMException&&cause.name==='NotAllowedError'))setError(cause instanceof Error?cause.message:'Your browser could not start screen sharing.');}}
    finally{s.sharePending=false;if(current(s)&&mounted.current)setShareBusy(false);}
  }
  return <section className="call-panel" aria-label="Room call">
    <div className="call-heading"><Radio size={18}/><div><strong>{joined?'You’re in the room':'Meet in this room'}</strong><p>{joined?`${peerCount+1} participant${peerCount?'s':''} · ${muted?'Microphone muted':'Microphone on'}`:'Join audio when you’re ready. Up to six people per call.'}</p></div></div>
    <div className="call-actions">{!joined?<button className="button primary" onClick={()=>void join()} disabled={busy}><Mic size={16}/>{busy?'Connecting…':'Join room audio'}</button>:<>
      <button className="button secondary" aria-pressed={muted} onClick={()=>{safelyToggle();}}>{muted?<MicOff size={16}/>:<Mic size={16}/>} {muted?'Unmute':'Mute'}</button>
      <button className="button secondary" aria-pressed={sharing} disabled={shareBusy} onClick={()=>void share()}><MonitorUp size={16}/>{shareBusy?'Choose a screen…':sharing?'Stop sharing':'Share screen'}</button>
      <button className="button danger" onClick={()=>void leave()}><PhoneOff size={16}/>Leave call</button></>}
    </div>
    {sharing&&<p className="call-sharing" role="status">Your selected screen is visible to everyone in this room call.</p>}
    {joined&&!hasRelay&&<p className="call-note">Direct connection mode. Some office networks need a TURN relay; an administrator can configure one for reliable calls.</p>}
    {error&&<p role="alert" className="call-error">{error}</p>}
    {remotes.length>0&&<div className="call-media-grid">{remotes.map(r=><RemoteMedia key={r.id} remote={r}/>)}</div>}
    <style jsx>{`
      .call-panel{padding:20px;border:1px solid #dce2d6;border-radius:18px;background:#fff;margin-top:20px}.call-heading{display:flex;gap:12px;align-items:center;color:#284132}.call-heading p{font-size:13px;color:#5b6e60;margin:4px 0 0}.call-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.call-actions button{display:inline-flex;align-items:center;gap:7px;padding:10px 13px;border-radius:9px;border:1px solid #dce2d6;cursor:pointer;background:#f5f6ef;color:#284132}.call-actions .primary{background:#294735;color:white}.call-actions .danger{color:#a4443b;background:#fff1ed}.call-note,.call-sharing,.call-error{font-size:13px;line-height:1.5;margin:12px 0 0}.call-note{color:#5b6e60}.call-sharing{color:#294735}.call-error{color:#a4443b}.call-media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}.call-panel :global(.call-remote){margin:0;background:#182722;border-radius:10px;overflow:hidden}.call-panel :global(.call-remote video){width:100%;max-height:320px;display:block;object-fit:contain}.call-panel :global(.call-remote figcaption){padding:8px 12px;font-size:12px;color:#fff}
    `}</style>
  </section>;
  function safelyToggle(){setMuted(previous=>{state.current?.stream?.getAudioTracks().forEach(track=>track.enabled=previous);return !previous;});}
}
