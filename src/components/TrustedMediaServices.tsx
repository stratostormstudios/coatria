'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,Check,RefreshCw,Server,Square} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import {api} from '@/lib/client';
import {trustedServicePlanInput,trustedServiceStartInput,trustedServiceStopInput,type TrustedServiceKind} from '@/lib/trusted-service-protocol';
import {Loading} from './ui';
import {useStudioResource} from './studio-hooks';
import {TrustedProjectGateway} from './TrustedProjectGateway';
import s from './StudioWorkspace.module.css';

type Readiness={configured:boolean;code:string|null;serviceVerified:false};
export type MediaServiceProvision={id:string;service:TrustedServiceKind;revision:number;phase:string;planHash:string;expiresAt:string;providerStatus:string|null;podId:string|null;submittedAt:string|null;stopRequestedAt:string|null;lastReconciledAt:string|null;errorCode:string|null;computeStopped:boolean;readiness:Readiness;plan:{reviewExpiresAt:string;preset:{id:string;releaseCommit:string;dataCenterId:string;cpuTypeId:string;vcpuCount:number;memoryGb:number};reservation:{cpuMicrousd:number;previouslyReservedMicrousd:number;lifetimeAllowanceMicrousd:number;billingCapGuaranteed:false}}};
type Provision=MediaServiceProvision;
type Listing={provisions:Provision[];readiness:Record<TrustedServiceKind,Readiness>};
type Attempt={operation:'plan'|'start'|'stop'|'reconcile';service:TrustedServiceKind;provisionId:string|null;createdAt:number;body:Record<string,unknown>};
const names={archive:'Media archive',gateway:'File gateway'};
const activePhases=new Set(['approved','submitting','uncertain','provisioning','running','stopping','needs_attention']);
const money=(value:number)=>(value/1e6).toLocaleString(undefined,{style:'currency',currency:'USD',minimumFractionDigits:3,maximumFractionDigits:6});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validAttempt(value:unknown):value is Attempt{
 if(!value||typeof value!=='object')return false;const a=value as Attempt;
 if(!['plan','start','stop','reconcile'].includes(a.operation)||!Object.hasOwn(names,a.service)||!Number.isFinite(a.createdAt)||!a.body||typeof a.body!=='object')return false;
 if(a.operation==='plan')return a.provisionId===null&&trustedServicePlanInput.safeParse(a.body).success&&a.body.service===a.service;
 if(!uuid.test(a.provisionId??''))return false;
 return a.operation==='start'?trustedServiceStartInput.safeParse(a.body).success:a.operation==='stop'?trustedServiceStopInput.safeParse(a.body).success:Object.keys(a.body).length===1&&uuid.test(String(a.body.clientId));
}

export function TrustedMediaServices({p,onBack}:{p:WorkspaceProps;onBack:()=>void}){
 if(!['owner','admin'].includes(p.company.role))return <p>Only a company owner or administrator can manage media services.</p>;
 return <MediaServices key={`${p.user.id}:${p.company.id}`} p={p} onBack={onBack}/>;
}
function MediaServices({p,onBack}:{p:WorkspaceProps;onBack:()=>void}){
 const base=`/api/companies/${p.company.id}/studio/trusted-services`,storageKey=`coatria:media-service-attempt:${p.user.id}:${p.company.id}`;
 const resource=useStudioResource<Listing>(base),[review,setReview]=useState<Provision|null>(null),[confirmed,setConfirmed]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<Attempt|null>(null),[journalReady,setJournalReady]=useState(false),[now,setNow]=useState(Date.now());
 const mounted=useRef(true),inFlight=useRef(false),controller=useRef<AbortController|null>(null);
 useEffect(()=>{mounted.current=true;try{const raw=sessionStorage.getItem(storageKey);if(raw){const saved:unknown=JSON.parse(raw);if(!validAttempt(saved))throw Error();setPending(saved);}setJournalReady(true);}catch{setError('The saved request could not be read. Keep this tab open and ask an administrator to reconcile service history before starting compute.');}const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{mounted.current=false;controller.current?.abort();clearInterval(timer);};},[storageKey]);
 const listed=review&&resource.data?.provisions.find(item=>item.id===review.id);
 const current=listed&&review&&listed.revision>review.revision?listed:review;
 const key=current?`${current.id}:${current.revision}:${current.planHash}`:null;
 const stale=!!current&&(Date.parse(current.plan.reviewExpiresAt)<=now||Date.parse(current.expiresAt)<=now+60_000);
 const overBudget=!!current&&current.plan.reservation.previouslyReservedMicrousd+current.plan.reservation.cpuMicrousd>current.plan.reservation.lifetimeAllowanceMicrousd;
 const blocked=busy||!journalReady||!!pending||!!resource.error||!resource.data;
 useEffect(()=>setConfirmed(null),[key,stale]);
 function clearAttempt(){sessionStorage.removeItem(storageKey);if(mounted.current)setPending(null);}
 // A read can establish the durable result of a lost response; it never retries
 // a mutation. Plan creation has no public clientId projection, so its exact
 // request can only be resolved by an explicit same-key replay below.
 useEffect(()=>{
  if(!pending||busy||resource.error)return;const row=resource.data?.provisions.find(item=>item.id===pending.provisionId);if(!row)return;
  const resolved=pending.operation==='start'&&row.phase!=='planned'||pending.operation==='stop'&&(!!row.stopRequestedAt||row.computeStopped)||pending.operation==='reconcile'&&Date.parse(row.lastReconciledAt??'')>=pending.createdAt;
  if(resolved){try{clearAttempt();setError('');}catch{setError('Service state was refreshed, but the saved request could not be cleared.');}}
 },[pending,busy,resource.data,resource.error]);
 async function send(attempt:Attempt){
  if(inFlight.current||!validAttempt(attempt))return;inFlight.current=true;setBusy(true);setError('');setConfirmed(null);
  const abort=new AbortController();controller.current=abort;const timeout=setTimeout(()=>abort.abort(),55_000);let sent=false;
  try{
   sessionStorage.setItem(storageKey,JSON.stringify(attempt));setPending(attempt);
   const path=attempt.operation==='plan'?base:`${base}/${attempt.provisionId}/${attempt.operation}`;sent=true;
   const result=await api<{provision:Provision}>(path,'POST',attempt.body,{signal:abort.signal});
   if(!result.provision||!uuid.test(result.provision.id)||result.provision.service!==attempt.service||attempt.provisionId&&result.provision.id!==attempt.provisionId)throw Error('The service response could not be verified.');
   clearAttempt();if(mounted.current){setReview(attempt.operation==='plan'?result.provision:null);await resource.reload();}
  }catch(cause){
   const e=cause as {status?:number;code?:string;message?:string};
   // Membership may end during provider I/O, after the durable paid effect.
   const unknown=sent&&(!e.status||e.status>=500||[401,403,408].includes(e.status)||e.code==='SESSION_CHANGED');
   if(!unknown){try{clearAttempt();}catch{/* Retain the journal if local storage is unavailable. */}}
   if(mounted.current)setError(unknown?'The outcome is unknown. Refresh service history before any new request. Nothing will be retried automatically.':e.message||'The service request could not be completed.');
  }finally{clearTimeout(timeout);inFlight.current=false;if(controller.current===abort)controller.current=null;if(mounted.current)setBusy(false);}
 }
 function act(operation:Attempt['operation'],service:TrustedServiceKind,row?:Provision){
  if(blocked)return;
  if(operation==='start'&&(!row||confirmed!==`${row.id}:${row.revision}:${row.planHash}`||stale||overBudget||!row.readiness.configured||!resource.data?.readiness[service].configured))return;
  const body:Record<string,unknown>={clientId:crypto.randomUUID(),...(operation==='plan'?{service}:operation==='start'?{revision:row!.revision,planHash:row!.planHash,acknowledgeCharges:true}:operation==='stop'?{revision:row!.revision}:{})};
  void send({operation,service,provisionId:row?.id??null,createdAt:Date.now(),body});
 }
 async function inspect(row:Provision){
  if(busy)return;setBusy(true);setConfirmed(null);setError('');try{const result=await api<{provision:Provision}>(`${base}/${row.id}`,'GET',undefined,{signal:AbortSignal.timeout(20_000)});if(mounted.current)setReview(result.provision);}catch{if(mounted.current)setError('This plan could not be refreshed. Check your access and try reading it again.');}finally{if(mounted.current)setBusy(false);}
 }
 return <div className={s.formSection} style={{overflowWrap:'anywhere'}}>
  <button className={s.back} disabled={busy} onClick={onBack}><ArrowLeft size={14}/> All agent hosts</button>
  <div className={s.heading}><div><h3>Trusted media services</h3><p>Run the reviewed media archive and file gateway for a finite session.</p></div><button className="icon-button" aria-label="Refresh media services" disabled={busy} onClick={()=>void resource.reload()}><RefreshCw size={16}/></button></div>
  <p className={s.notice}>Preparing a plan starts no compute. Starting a reviewed plan creates a paid CPU service. A running container does not prove media verification, storage access or billing cessation.</p>
  {error&&<p className="error-message" role="alert">{error}</p>}{resource.error&&<p className="error-message" role="alert">{resource.error}</p>}
  {pending&&!busy&&<div className={s.notice}><div><strong>Resolve the existing request first</strong><p>{names[pending.service]} · {pending.operation} · request {String(pending.body.clientId)}</p><p>Refresh history first. If its outcome is still unknown, retrieve the result using the identical request ID and reviewed body. This does not authorize a different plan.</p><button className="button secondary small" disabled={!journalReady||!!resource.error} onClick={()=>void send(pending)}>Resolve same request</button></div></div>}
  {resource.loading?<Loading label="Loading trusted media services"/>:<>
   <div className={s.formGrid}>{(['archive','gateway'] as const).map(service=><section className={s.section} key={service}><h4>{names[service]}</h4><p>{service==='archive'?'Archives approved generation outputs and verifies media through the reviewed decoder.':'Serves authorized project files and verifies bounded transfers.'}</p><p>{resource.data?.readiness[service].configured?'Operator configuration available.':'Operator setup required.'}</p>{resource.data?.readiness[service].code&&<p className={s.muted}>{resource.data.readiness[service].code.replaceAll('_',' ').toLowerCase()}</p>}<button className="button secondary small" disabled={blocked||!resource.data?.readiness[service].configured||resource.data.provisions.some(row=>row.service===service&&activePhases.has(row.phase))} onClick={()=>act('plan',service)}><Server size={14}/> Prepare {service} plan</button></section>)}</div>
   {current?.phase==='planned'&&<section className={s.section} aria-label="Review media service plan"><h3>Review {names[current.service].toLowerCase()} plan</h3><dl className={s.summaryRows}><div><dt>Service request</dt><dd>{current.id}</dd></div><div><dt>Reviewed preset</dt><dd>{current.plan.preset.id}</dd></div><div><dt>Release</dt><dd>{current.plan.preset.releaseCommit.slice(0,7)}</dd></div><div><dt>Resources</dt><dd>{current.plan.preset.vcpuCount} vCPU · {current.plan.preset.memoryGb} GB · {current.plan.preset.dataCenterId}</dd></div><div><dt>Stops admitting work at</dt><dd>{new Date(current.expiresAt).toLocaleString()}</dd></div><div><dt>Plan review expires</dt><dd>{new Date(current.plan.reviewExpiresAt).toLocaleString()}</dd></div><div><dt>CPU reservation for this start</dt><dd>{money(current.plan.reservation.cpuMicrousd)}</dd></div><div><dt>Previously reserved</dt><dd>{money(current.plan.reservation.previouslyReservedMicrousd)}</dd></div><div><dt>Service lifetime allowance</dt><dd>{money(current.plan.reservation.lifetimeAllowanceMicrousd)}</dd></div></dl><p>Storage, decoder and inference charges are separate. The reservation is not a provider spending cap. Operator setup determines whether this release performs a preflight or runs the service.</p>{(stale||overBudget||!current.readiness.configured)&&<p className="error-message" role="alert">{stale?'This plan expired. Prepare and review a new plan.':overBudget?'This plan exceeds the remaining service allowance.':'The service configuration is not ready.'}</p>}<label className={s.checkbox}><input type="checkbox" checked={confirmed===key} disabled={blocked||stale||overBudget||!current.readiness.configured} onChange={event=>setConfirmed(event.target.checked?key:null)}/>I reviewed this exact service plan and authorize its CPU charges.</label><div className={s.actions}><button className="button secondary" disabled={busy} onClick={()=>{setReview(null);setConfirmed(null);}}>Close plan</button><button className="button primary" disabled={blocked||stale||overBudget||confirmed!==key||!current.readiness.configured||!resource.data?.readiness[current.service].configured} onClick={()=>act('start',current.service,current)}><Check size={14}/> Start reviewed media service</button></div></section>}
   <section className={s.section}><h3>Service history</h3>{!resource.data?.provisions.length?<p>No media service requests yet.</p>:resource.data.provisions.map(row=><div className={s.section} key={row.id}><div className={s.heading}><strong>{names[row.service]} · {row.id.slice(0,8)}</strong><span className={s.status}>{row.phase.replaceAll('_',' ')}</span></div><p>Deadline {new Date(row.expiresAt).toLocaleString()}{row.providerStatus?` · Provider ${row.providerStatus}`:''}</p>{row.errorCode&&<p className={s.notice}>{row.phase==='failed'&&!row.podId&&row.errorCode==='SERVICE_SUPPORT_CONFIRMED_NOT_CREATED'?'Runpod support confirmed that this request created no server. This attempt is closed; its history is retained.':<>Needs attention: {row.errorCode}. Preserve this request and check provider state.</>}</p>}{row.computeStopped&&<p>{row.submittedAt||row.podId?'Provider compute stopped.':'Closed before compute submission.'} Billing and service verification remain separate.</p>}<div className={s.actions}>{row.phase==='planned'&&<button className="button secondary small" disabled={busy||!!pending} onClick={()=>void inspect(row)}>Review media plan</button>}{activePhases.has(row.phase)&&<><button className="button secondary small" disabled={blocked} onClick={()=>act('reconcile',row.service,row)}><RefreshCw size={13}/> Reconcile service</button><button className="button secondary small" disabled={blocked||!!row.stopRequestedAt} onClick={()=>act('stop',row.service,row)}><Square size={13}/>{row.stopRequestedAt?'Stop requested':'Stop media service'}</button></>}</div></div>)}</section>
   <TrustedProjectGateway p={p} provisions={resource.data?.provisions??[]} servicesUnavailable={blocked}/>
  </>}
 </div>;
}
