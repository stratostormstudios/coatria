'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,Check,GitBranch,Plus,RefreshCw,ShieldCheck} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import type {StudioGeneratedProjectDetail} from '@/lib/studio-protocol';
import type {StudioGeneratedRevisionPlan,StudioGeneratedRevisionPlanSummary,StudioGeneratedRevisionSnapshot,StudioGeneratedRevisionSourceDetail} from '@/lib/studio-generated-revision-protocol';
import {api,when} from '@/lib/client';
import {generatedProjectPath} from '@/lib/generated-media-ui';
import {Badge,Field,Loading,Modal} from './ui';
import {useStudioMutation} from './studio-hooks';
import s from './GeneratedRevisionPlan.module.css';

type Props={p:WorkspaceProps;detail:StudioGeneratedProjectDetail;onReload:()=>void|Promise<void>};
type DraftBody={projectRevision:number;shareId:string;receiptId:string;packageSha256:string;summary:string;items:Array<{unitId:string;action:'carry'}|{unitId:string;action:'regenerate';instructions:string}>};
const sameSource=(plan:StudioGeneratedRevisionPlan,source:StudioGeneratedRevisionSourceDetail|null)=>!!source&&plan.source.shareId===source.source.shareId&&plan.source.receiptId===source.source.receiptId&&plan.source.packageSha256===source.source.packageSha256&&plan.source.roundId===source.source.roundId;
const message=(error:unknown)=>error instanceof Error?error.message:'The revision could not be loaded.';

export function GeneratedRevisionPlan(props:Props){return <RevisionPanel key={`${props.p.user.id}:${props.p.company.id}:${props.p.company.role}:${props.detail.project.id}`} {...props}/>;}

function RevisionPanel({p,detail,onReload}:Props){
 const path=generatedProjectPath(p.company.id,detail.project.id)+'/generated-revisions';
 const [snapshot,setSnapshot]=useState<StudioGeneratedRevisionSnapshot|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[draft,setDraft]=useState(false),[selected,setSelected]=useState<StudioGeneratedRevisionPlan|null>(null);
 const generation=useRef(0),active=useRef(true),request=useRef<AbortController|null>(null),admin=['owner','admin'].includes(p.company.role);
 const read=useCallback(async(query='',append=false)=>{
  request.current?.abort();const ticket=++generation.current,controller=new AbortController();request.current=controller;setLoading(true);
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{const next=await api<StudioGeneratedRevisionSnapshot>(path+query,'GET',undefined,{signal:controller.signal});if(active.current&&ticket===generation.current&&!controller.signal.aborted){if(!query.startsWith('?planId='))setSnapshot(previous=>append&&previous?{...next,plans:[...previous.plans,...next.plans.filter(plan=>!previous.plans.some(old=>old.id===plan.id))]}:next);setError('');return next;}}
  catch(caught){if(active.current&&ticket===generation.current)setError(message(caught));}
  finally{clearTimeout(timer);if(request.current===controller)request.current=null;if(active.current&&ticket===generation.current)setLoading(false);}
  return null;
 },[path]);
 useEffect(()=>{active.current=true;void read();const changed=()=>{generation.current++;request.current?.abort();setSnapshot(null);setSelected(null);setDraft(false);setError('Your account changed. Refresh the project to continue.');setLoading(false);};window.addEventListener('coatria:session-changed',changed);return()=>{active.current=false;generation.current++;request.current?.abort();window.removeEventListener('coatria:session-changed',changed);};},[read,detail.project.revision]);
 const saved=async()=>{setDraft(false);setSelected(null);await onReload();if(active.current)await read();};
 const fresh=!!snapshot&&!loading&&!error&&snapshot.projectRevision===detail.project.revision;
 const canDraft=admin&&fresh&&!!snapshot.source&&detail.project.status!=='delivered';
 const source=snapshot?.source,round=snapshot?.currentRound;
 async function review(plan:StudioGeneratedRevisionPlanSummary){const next=await read('?planId='+encodeURIComponent(plan.id));if(next){if(next.projectRevision!==snapshot?.projectRevision){setError('The project changed while loading this plan. Refresh the project before reviewing it.');return;}if(next.plan?.id===plan.id&&next.plan.planSha256===plan.planSha256)setSelected(next.plan);else setError('This exact revision plan is unavailable. Refresh before continuing.');}}
 return <section className={s.panel} aria-label="Creative revision planning" id="generated-revision-planning" tabIndex={-1}>
  <header className={s.heading}><div><span className={s.eyebrow}>CLIENT FEEDBACK → NEW WORK</span><h3>Revise the work. Preserve the record.</h3><p>Choose what changes and what stays. Earlier files, approvals and client responses remain unchanged.</p></div><button type="button" className="icon-button" aria-label="Refresh revision plans" onClick={()=>void read()} disabled={loading}><RefreshCw size={16}/></button></header>
  {loading&&!snapshot?<Loading label="Loading client feedback and revision plans"/>:<>
   {round&&<p className={s.round}><GitBranch size={16}/><strong>Revision round {round.number}</strong><span>Studio approved {when(round.createdAt)}</span></p>}
   {source?<section className={s.feedback} aria-label="Client change request"><div className={s.heading}><h4>Changes requested by the client</h4><Badge tone="warning">Exact package response</Badge></div><p className={s.note}>{source.source.note}</p><SourceEvidence source={source.source}/>{admin&&<button className="button primary small" disabled={!canDraft} onClick={()=>setDraft(true)}><Plus size={15}/> Draft revision plan</button>}</section>:<p className={s.muted}>{snapshot?.sourceBlockedReason??'A revision starts with the designated client’s change request against an approved package.'}</p>}
   {snapshot&&snapshot.projectRevision!==detail.project.revision&&<p className={s.notice}>The project and revision history changed. Refresh the project before drafting or approving work.</p>}
   {!admin&&source&&<p className={s.muted}>A company administrator can prepare and approve the next revision. Authorized agents can propose drafts through the API; only a human administrator can apply one.</p>}
   {!!snapshot?.plans.length&&<div className={s.plans}><h4>Revision plans</h4>{snapshot.plans.map(plan=><article className={s.plan} key={plan.id}><div className={s.heading}><div><h5>{plan.summary}</h5><p>{plan.changedCount} to regenerate · {plan.carryCount} kept unchanged</p><small>{plan.createdAgentId?'Agent-proposed draft':'Human-proposed draft'} · {when(plan.createdAt)}</small></div><Badge>{plan.appliedRoundId?'Applied':'Draft'}</Badge></div><button className="button secondary small" disabled={loading} onClick={()=>void review(plan)}>{plan.appliedRoundId?'View preserved plan':admin?'Review revision plan':'View revision plan'} <ArrowRight size={14}/></button></article>)}</div>}
   {snapshot?.page.hasMore&&snapshot.page.nextAfter&&<button className="button secondary small" disabled={loading} onClick={()=>void read('?after='+encodeURIComponent(snapshot.page.nextAfter!),true)}>Load more revision plans</button>}
  </>}
  {error&&<p role="alert" className="error-message">{error}</p>}
  <p className={s.notice}><ShieldCheck size={17}/><span>Applying a plan creates new production work. It starts no generation or transfer and does not approve spending. The technical specification and deliverable set stay fixed.</span></p>
  {draft&&snapshot?.source&&<DraftEditor key={snapshot.source.source.receiptId} path={path} source={snapshot.source} projectRevision={snapshot.projectRevision} currentRevision={detail.project.revision} currentSource={source??null} readBlocked={!fresh} onClose={()=>setDraft(false)} onSaved={saved}/>}
  {selected&&snapshot&&<PlanEditor path={path} plan={selected} snapshot={snapshot} currentRevision={detail.project.revision} admin={admin} readBlocked={!!error||loading} onClose={()=>{setSelected(null);void read();}} onSaved={saved}/>}
 </section>;
}

function SourceEvidence({source}:{source:StudioGeneratedRevisionPlan['source']}){return <details className={s.evidence}><summary>Client response and original package</summary><dl><dt>Client account</dt><dd>{source.clientUserId}</dd><dt>Invitation</dt><dd>{source.shareId}</dd><dt>Response receipt</dt><dd>{source.receiptId}</dd><dt>Original delivery</dt><dd>{source.deliveryId}</dd><dt>Package SHA-256</dt><dd>{source.packageSha256}</dd></dl></details>;}
function BaseEvidence({item}:{item:StudioGeneratedRevisionSourceDetail['items'][number]}){return <details className={s.evidence}><summary>Preserved source version</summary><dl><dt>Artifact</dt><dd>{item.base.artifactId}</dd><dt>Independent review</dt><dd>{item.base.reviewId}</dd><dt>Storage version</dt><dd>{item.base.storageVersionId}</dd><dt>File SHA-256</dt><dd>{item.base.fileSha256}</dd><dt>Manifest SHA-256</dt><dd>{item.base.manifestSha256}</dd></dl></details>;}
function RetryNote({error}:{error:string}){return error?<><p className="error-message" role="alert">{error}</p><p className={s.muted}>The response was not confirmed. Retry preserves the exact reviewed plan and request ID. Before changing details, close this dialog and refresh to check whether it was recorded.</p></>:null;}

function DraftEditor({path,source,projectRevision,currentRevision,currentSource,readBlocked,onClose,onSaved}:{path:string;source:StudioGeneratedRevisionSourceDetail;projectRevision:number;currentRevision:number;currentSource:StudioGeneratedRevisionSourceDetail|null;readBlocked:boolean;onClose:()=>void;onSaved:()=>void|Promise<void>}){
 const [pinned]=useState(()=>structuredClone(source)),[revision]=useState(projectRevision),[summary,setSummary]=useState(''),[items,setItems]=useState(()=>source.items.map(item=>({unitId:item.unitId,action:'carry' as 'carry'|'regenerate',instructions:''}))),[attempt,setAttempt]=useState<DraftBody|null>(null);
 const mutation=useStudioMutation(),stale=currentRevision!==revision||currentSource?.source.receiptId!==pinned.source.receiptId||currentSource.source.packageSha256!==pinned.source.packageSha256;
 const overBudget=new TextEncoder().encode(summary.trim()+items.filter(item=>item.action==='regenerate').map(item=>item.instructions.trim()).join('')).byteLength>24576;
 const valid=!overBudget&&!!summary.trim()&&items.some(item=>item.action==='regenerate')&&items.every(item=>item.action==='carry'||!!item.instructions.trim());
 const change=(unitId:string,value:Partial<(typeof items)[number]>)=>setItems(previous=>previous.map(item=>item.unitId===unitId?{...item,...value}:item));
 return <Modal title="Draft a creative revision" description="Translate the client’s exact request into selective new work. Keep the approved technical specification." wide onClose={()=>{if(!mutation.busy)onClose();}}><form className="form" onSubmit={event=>{event.preventDefault();if(!attempt&&(!valid||stale||readBlocked))return;const body=attempt??{projectRevision:revision,shareId:pinned.source.shareId,receiptId:pinned.source.receiptId,packageSha256:pinned.source.packageSha256,summary:summary.trim(),items:items.map(item=>item.action==='carry'?{unitId:item.unitId,action:'carry' as const}:{unitId:item.unitId,action:'regenerate' as const,instructions:item.instructions.trim()})};setAttempt(body);void mutation.mutate(path,body,onSaved);}}>
  <section className={s.feedback}><h3>Client’s original request</h3><p className={s.note}>{pinned.source.note}</p><SourceEvidence source={pinned.source}/></section>
  <fieldset disabled={mutation.busy||!!attempt} className={s.fields}><Field label="Revision summary" hint="Describe the creative changes the studio will make. This is an internal proposal, not client agreement or a provider order."><textarea required maxLength={4000} rows={3} value={summary} onChange={event=>setSummary(event.target.value)}/></Field>
   {pinned.items.map(item=>{const chosen=items.find(value=>value.unitId===item.unitId)!;return <section className={s.item} key={item.unitId}><h3>{item.code} · {item.mediaKind}</h3><p>{item.description}</p><Field label={`${item.code} revision action`}><select value={chosen.action} onChange={event=>change(item.unitId,{action:event.target.value as typeof chosen.action})}><option value="carry">Keep approved version</option><option value="regenerate">Regenerate with corrections</option></select></Field>{chosen.action==='regenerate'?<Field label={`${item.code} creative corrections`} hint="Describe what should change and what must remain. Generation prompts, references and credit consent are reviewed separately."><textarea required rows={4} maxLength={4000} value={chosen.instructions} onChange={event=>change(item.unitId,{instructions:event.target.value})}/></Field>:<p className={s.muted}>Its exact stored bytes and independent review are carried into the replacement package.</p>}<BaseEvidence item={item}/></section>;})}
  </fieldset>
  {!items.some(item=>item.action==='regenerate')&&<p className={s.muted}>Choose at least one deliverable to regenerate.</p>}
  {overBudget&&<p className="error-message">Keep the combined summary and correction instructions within 24 KiB.</p>}
  {stale&&!attempt&&<p className={s.notice}>The source or project changed. Close this draft and refresh before preparing a new plan.</p>}
  <RetryNote error={mutation.error}/><button type="submit" className="button primary" disabled={mutation.busy||!attempt&&(!valid||stale||readBlocked)}>{mutation.busy?'Saving draft…':attempt?'Retry exact draft':'Save revision draft'} <ArrowRight size={15}/></button>
 </form></Modal>;
}

function PlanEditor({path,plan,snapshot,currentRevision,admin,readBlocked,onClose,onSaved}:{path:string;plan:StudioGeneratedRevisionPlan;snapshot:StudioGeneratedRevisionSnapshot;currentRevision:number;admin:boolean;readBlocked:boolean;onClose:()=>void;onSaved:()=>void|Promise<void>}){
 const [pinned]=useState(()=>structuredClone(plan)),[revision]=useState(snapshot.projectRevision),[confirmed,setConfirmed]=useState(false),[attempt,setAttempt]=useState<{projectRevision:number;planSha256:string}|null>(null),mutation=useStudioMutation();
 const stale=pinned.projectRevision!==revision||currentRevision!==revision||snapshot.projectRevision!==revision||!sameSource(pinned,snapshot.source),changed=pinned.items.filter(item=>item.action==='regenerate').length;
 return <Modal title={pinned.appliedRoundId?'Preserved revision plan':'Review the exact revision plan'} description={pinned.appliedRoundId?'This plan and its original source are immutable.':'Approve the creative work structure. Production and provider spending keep their separate approvals.'} wide onClose={()=>{if(!mutation.busy)onClose();}}>
  <form className="form" onSubmit={event=>{event.preventDefault();if(!admin||pinned.appliedRoundId||!attempt&&(!confirmed||stale||readBlocked))return;const body=attempt??{projectRevision:revision,planSha256:pinned.planSha256};setAttempt(body);void mutation.mutate(path+'/'+pinned.id+'/apply',body,onSaved);}}>
   <section className={s.feedback}><h3>Client’s original request</h3><p className={s.note}>{pinned.source.note}</p><SourceEvidence source={pinned.source}/></section>
   <div className={s.summary}><h3>{pinned.summary}</h3><p><strong>{changed}</strong> to regenerate · <strong>{pinned.items.length-changed}</strong> kept unchanged</p><p>New generation and independent QC work for each changed deliverable, followed by a new delivery handoff. Earlier accepted work stays closed.</p></div>
   <div className={s.items}>{pinned.items.map(item=><section className={s.item} key={item.unitId}><div className={s.heading}><h3>{item.code} · {item.mediaKind}</h3><Badge tone={item.action==='regenerate'?'warning':''}>{item.action==='regenerate'?'Regenerate':'Keep exact version'}</Badge></div><p>{item.description}</p>{item.action==='regenerate'&&<p className={s.note}>{item.instructions}</p>}<BaseEvidence item={item}/></section>)}</div>
   <details className={s.evidence}><summary>Immutable plan identity</summary><dl><dt>Plan</dt><dd>{pinned.id}</dd><dt>Plan SHA-256</dt><dd>{pinned.planSha256}</dd><dt>Proposed by</dt><dd>{pinned.createdBy}{pinned.createdAgentId&&` · Agent ${pinned.createdAgentId}`}</dd>{pinned.appliedRoundId&&<><dt>Applied round</dt><dd>{pinned.appliedRoundId}</dd></>}</dl></details>
   {!pinned.appliedRoundId&&<>
    <p className={s.notice}><ShieldCheck size={17}/><span>This is a studio approval, not a new client acknowledgement. Review the renewed production gates and coordination policy before execution. It starts no paid generation or file transfer.</span></p>
    {admin?<><label className={s.confirm}><input type="checkbox" checked={confirmed} disabled={mutation.busy||!!attempt} onChange={event=>setConfirmed(event.target.checked)}/><span>I reviewed this exact plan, its original client response and every kept or regenerated deliverable.</span></label>{stale&&!attempt&&<p className={s.notice}>The project or source response changed after this draft. Its evidence stays readable; close this dialog, refresh and prepare a new draft for approval.</p>}<RetryNote error={mutation.error}/><button className="button primary" disabled={mutation.busy||!attempt&&(!confirmed||stale||readBlocked)}><Check size={15}/>{mutation.busy?'Applying revision…':attempt?'Retry exact plan approval':'Approve & create revision work'}</button></>:<p className={s.muted}>Only a human company administrator can apply this plan.</p>}
   </>}
  </form>
 </Modal>;
}
