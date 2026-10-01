'use client';
import {useEffect,useRef,useState} from 'react';
import type {WorkspaceProps} from '@/app/page';
import {api} from '@/lib/client';
import type {MediaServiceProvision} from './TrustedMediaServices';
import {useStudioResource} from './studio-hooks';
import s from './StudioWorkspace.module.css';

type Gateway={bindingId:string;provisionId:string;expiresAt:string;configurationHash:string;origin:string};
type Attempt={provisionId:string;expectedBindingId:string|null};
type Projects={projects:{id:string;name:string}[];hasMore:boolean;nextAfter:string|null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validAttempt(value:unknown):value is Attempt{if(!value||typeof value!=='object')return false;const a=value as Attempt;return Object.keys(a).length===2&&uuid.test(a.provisionId)&&(a.expectedBindingId===null||uuid.test(a.expectedBindingId));}
function available(row:MediaServiceProvision,now:number){return row.service==='gateway'&&row.phase==='running'&&row.providerStatus==='RUNNING'&&!!row.podId&&!row.stopRequestedAt&&!row.computeStopped&&Date.parse(row.expiresAt)>now&&!!row.lastReconciledAt&&Date.parse(row.lastReconciledAt)>=now-120000;}

/** The owner chooses an existing project and provision; the server derives the
 * address and challenges its pinned identity before granting project access. */
export function TrustedProjectGateway({p,provisions,servicesUnavailable}:{p:WorkspaceProps;provisions:MediaServiceProvision[];servicesUnavailable:boolean}){
 const [projectId,setProjectId]=useState(''),[after,setAfter]=useState<string|null>(null),[history,setHistory]=useState<(string|null)[]>([]);
 const projects=useStudioResource<Projects>(`/api/companies/${p.company.id}/studio?contractVersion=2${after?'&after='+encodeURIComponent(after):''}`);
 return <section className={s.section} aria-label="Project file gateway"><h3>Connect a project to its file gateway</h3><p>A running container must pass identity verification for the selected project before file transfers become available. This connection starts no compute.</p>
  {projects.error&&<p className="error-message" role="alert">{projects.error}</p>}
  <label>Project<select aria-label="Gateway project" value={projectId} disabled={projects.loading||!!projects.error} onChange={event=>setProjectId(event.target.value)}><option value="">Choose a project</option>{projects.data?.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
  {(projects.data?.hasMore||history.length>0)&&<div className={s.actions}><button className="button secondary small" disabled={!history.length} onClick={()=>{setProjectId('');setAfter(history.at(-1)??null);setHistory(history.slice(0,-1));}}>Previous projects</button><button className="button secondary small" disabled={!projects.data?.hasMore||!projects.data.nextAfter} onClick={()=>{setProjectId('');setHistory([...history,after]);setAfter(projects.data!.nextAfter);}}>Next projects</button></div>}
  {projectId&&projects.data?.projects.some(project=>project.id===projectId)&&<ProjectBinding key={`${p.user.id}:${p.company.id}:${projectId}`} p={p} projectId={projectId} provisions={provisions} unavailable={servicesUnavailable||!!projects.error}/>}
 </section>;
}

function ProjectBinding({p,projectId,provisions,unavailable}:{p:WorkspaceProps;projectId:string;provisions:MediaServiceProvision[];unavailable:boolean}){
 const path=`/api/companies/${p.company.id}/studio/projects/${projectId}/gateway`,storageKey=`coatria:project-gateway-attempt:${p.user.id}:${p.company.id}:${projectId}`;
 const resource=useStudioResource<{gateway:Gateway|null}>(path),[selected,setSelected]=useState(''),[confirmed,setConfirmed]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<Attempt|null>(null),[journalReady,setJournalReady]=useState(false),[now,setNow]=useState(Date.now());
 const active=useRef(true),inFlight=useRef(false),request=useRef<AbortController|null>(null);
 useEffect(()=>{active.current=true;try{const raw=sessionStorage.getItem(storageKey);if(raw){const saved:unknown=JSON.parse(raw);if(!validAttempt(saved))throw Error();setPending(saved);}setJournalReady(true);}catch{setError('The previous verification could not be read. Refresh project access with an administrator before changing this connection.');}const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{active.current=false;request.current?.abort();clearInterval(timer);};},[storageKey]);
 const current=resource.data?.gateway,candidates=provisions.filter(row=>available(row,now)),candidate=candidates.find(row=>row.id===selected);
 const bindingId=current?.bindingId??null,confirmationKey=JSON.stringify([projectId,selected,bindingId]);
 useEffect(()=>setConfirmed(null),[bindingId,selected]);
 function clearAttempt(){sessionStorage.removeItem(storageKey);if(active.current)setPending(null);}
 useEffect(()=>{if(pending&&!busy&&!resource.error&&current?.provisionId===pending.provisionId){try{clearAttempt();setError('');}catch{setError('The connection was read, but the saved verification could not be cleared.');}}},[pending,busy,current,resource.error]);
 const blocked=unavailable||busy||!journalReady||resource.loading||!!resource.error||!resource.data;
 async function verify(attempt:Attempt){
  if(inFlight.current||!validAttempt(attempt))return;inFlight.current=true;setBusy(true);setConfirmed(null);setError('');
  const controller=new AbortController();request.current=controller;const timeout=setTimeout(()=>controller.abort(),20_000);let sent=false;
  try{
   sessionStorage.setItem(storageKey,JSON.stringify(attempt));setPending(attempt);sent=true;
   const result=await api<{gateway:Gateway|null}>(path,'POST',attempt,{signal:controller.signal});
   if(!result.gateway||!uuid.test(result.gateway.bindingId)||result.gateway.provisionId!==attempt.provisionId)throw Error('The verified connection could not be read.');
   clearAttempt();if(active.current)await resource.reload();
  }catch(cause){
   const e=cause as {status?:number;code?:string;message?:string};const unknown=sent&&(!e.status||e.status>=500||[401,403,408].includes(e.status)||e.code==='SESSION_CHANGED');
   if(!unknown){try{clearAttempt();}catch{/* Preserve unresolved local state. */}}
   if(active.current){setError(unknown?'The verification outcome is unknown. Refresh the current project connection; no verification is retried automatically.':e.message||'The gateway could not be verified.');if(!unknown)await resource.reload();}
  }finally{clearTimeout(timeout);inFlight.current=false;if(request.current===controller)request.current=null;if(active.current)setBusy(false);}
 }
 return <div className={s.formSection} style={{overflowWrap:'anywhere'}}>
  {resource.error&&<p className="error-message" role="alert">{resource.error}</p>}{error&&<p className="error-message" role="alert">{error}</p>}
  <button className="button secondary small" disabled={busy} onClick={()=>{setConfirmed(null);void resource.reload();}}>Refresh project gateway</button>
  {current&&Date.parse(current.expiresAt)>now?<div className={s.notice}><div><strong>Verified project gateway</strong><p>Provision {current.provisionId} · Expires {new Date(current.expiresAt).toLocaleString()}</p><p>Reload this page before uploading or downloading through this connection, so the browser receives its updated security policy. Storage credentials and file permissions are checked separately.</p><button className="button secondary small" disabled={busy} onClick={()=>window.location.reload()}>Reload for file transfers</button></div></div>:resource.data&&!resource.error&&<p>No verified live gateway is connected to this project.</p>}
  {pending?<div className={s.notice}><div><strong>Resolve the existing verification first</strong><p>Refresh the connection first. If its outcome is still unknown, the same provision and original binding can be checked again. A changed binding will require a new review.</p><button className="button secondary small" disabled={blocked} onClick={()=>void verify(pending)}>Resolve same verification</button></div></div>:<>
   <label>Running file gateway<select aria-label="Running file gateway" value={selected} disabled={blocked} onChange={event=>setSelected(event.target.value)}><option value="">Choose a running gateway</option>{candidates.map(row=><option key={row.id} value={row.id}>{row.id.slice(0,8)} · {row.plan.preset.id}</option>)}</select></label>
   {!candidates.length&&<p>Start and reconcile a file gateway service first. Only unexpired, recently reconciled running services can be selected.</p>}
   <label className={s.checkbox}><input type="checkbox" checked={confirmed===confirmationKey} disabled={blocked||!candidate||current?.provisionId===selected} onChange={event=>setConfirmed(event.target.checked?confirmationKey:null)}/>Verify this gateway and use it for this project’s file transfers.</label>
   <button className="button primary" disabled={blocked||!candidate||confirmed!==confirmationKey||current?.provisionId===selected} onClick={()=>{if(!blocked&&candidate&&confirmed===confirmationKey)void verify({provisionId:selected,expectedBindingId:bindingId});}}>Verify and connect gateway</button>
  </>}
 </div>;
}
