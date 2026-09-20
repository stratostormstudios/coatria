'use client';

import {useState,type FormEvent} from 'react';
import {ArrowRight,Check,Pause,RefreshCw,Settings2,ShieldCheck} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import type {StudioProjectDetail} from '@/lib/studio-protocol';
import type {StudioReviewPolicy,StudioReviewPolicySnapshot} from '@/lib/studio-review-policy-protocol';
import {STUDIO_MACHINE_REVIEW_STAGES} from '@/lib/studio-review-policy-protocol';
import {Field,Loading,Modal} from './ui';
import {AgentRunDetail} from './AgentRuns';
import {useStudioMutation,useStudioResource} from './studio-hooks';
import s from './StudioWorkspace.module.css';

type Props={p:WorkspaceProps;detail:StudioProjectDetail};
const label=(value:string)=>value.replaceAll('_',' ');

export function StudioPlanningReviewPanel({p,detail}:Props){
 const path=`/api/companies/${p.company.id}/studio/projects/${detail.project.id}/review-policy`;
 const resource=useStudioResource<StudioReviewPolicySnapshot>(path),mutation=useStudioMutation(),[editing,setEditing]=useState(false),[selectedRun,setSelectedRun]=useState<string|null>(null);
 const policy=resource.data?.policy,admin=['owner','admin'].includes(p.company.role);
 const name=(id:string)=>p.workspace.agents.find(agent=>agent.id===id)?.name||'Unavailable agent';
 return <section className={s.section}>
  <div className={s.heading}><div><h2>A second agent checks the planning.</h2><p>Keep routine work moving with a separate reviewer and a finite review allowance.</p></div><button className="icon-button" aria-label="Refresh planning reviews" onClick={()=>void resource.reload()}><RefreshCw size={16}/></button></div>
  {resource.loading?<Loading label="Loading planning review policy"/>:resource.data&&<>
   <div className={s.metrics}>
    <div className={s.metric}><span>Planning review</span><strong style={{fontSize:20,textTransform:'capitalize'}}>{label(policy?.effectiveStatus||'human review')}</strong><small>{policy?name(policy.reviewerAgentId):'Machine review is optional'}</small></div>
    <div className={s.metric}><span>Reviewer runs remaining</span><strong>{policy?.remainingReviews??'—'}</strong><small>{policy?.reviewsStarted??0} started; failed reviews also count</small></div>
   </div>
   {policy?.blocker&&<p className={s.notice}>{policy.blocker}</p>}
   {policy&&<p className={s.muted}>Coordinator: {name(policy.coordinatorAgentId)}. Stages: {policy.allowedStages.map(label).join(', ')}. Expires {new Date(policy.expiresAt).toLocaleString()}. {policy.allowSharedSponsor?'Different agents may share a sponsoring administrator.':'Reviewer and producer must have different sponsoring administrators.'}</p>}
   <div className={s.notice}><ShieldCheck size={17}/><p>Machine acceptance is labeled in the work history. It never approves a commercial estimate, authorizes production, inspects rendered media, or records client acceptance. A reviewer cannot accept work it produced.</p></div>
   <div className={s.actions} style={{marginTop:16}}>
    {admin&&detail.project.status!=='delivered'&&<button className="button secondary small" onClick={()=>setEditing(true)}><Settings2 size={14}/>{policy?'Review planning policy':'Set planning review policy'}</button>}
    {admin&&policy?.status==='active'&&<button className="button secondary small" disabled={mutation.busy} onClick={()=>void mutation.mutate(path,{revision:policy.revision,coordinatorAgentId:policy.coordinatorAgentId,reviewerAgentId:policy.reviewerAgentId,allowedStages:policy.allowedStages,allowSharedSponsor:policy.allowSharedSponsor,maxReviews:policy.maxReviews,status:'paused',expiresAt:policy.expiresAt},async()=>{await resource.reload();p.notify('Planning review paused. Pending reviewer requests lose authority at their next API check.');},'PUT')}><Pause size={14}/>{mutation.busy?'Pausing…':'Pause machine review'}</button>}
   </div>
   <h3 style={{marginTop:24}}>Planning review history</h3>
   {!resource.data.reviews.length?<p className={s.muted}>No machine reviews yet. The coordinator can request one review for each exact submitted planning revision.</p>:<ol className={s.history}>{resource.data.reviews.map(review=><li key={review.id}><strong>{detail.workItems.find(work=>work.id===review.workItemId)?.title||'Planning submission'}</strong><small>{name(review.reviewerAgentId)} · {review.decision?label(review.decision.decision):label(review.runStatus)} · {new Date(review.createdAt).toLocaleString()}</small>{review.decision&&<p>{review.decision.note}</p>}{admin&&<button type="button" className="text-button" onClick={()=>setSelectedRun(review.reviewerRunId)}>Inspect reviewer request and committed actions <ArrowRight size={13}/></button>}<details><summary>Review identifiers and checksum</summary><p>Submission revision: {review.taskRevision}<br/>Policy revision: {review.policyRevision}<br/>Reviewer request: {review.reviewerRunId}<br/>Submission SHA-256: <span style={{overflowWrap:'anywhere'}}>{review.submissionSha256}</span></p></details></li>)}</ol>}
  </>}
  {(resource.error||mutation.error)&&<p className="error-message" role="alert">{resource.error||mutation.error}</p>}
  {editing&&resource.data&&<ReviewEditor p={p} detail={detail} initial={resource.data.policy} path={path} onClose={()=>setEditing(false)} onSaved={async()=>{setEditing(false);await resource.reload();p.notify('Planning review policy saved. No worker or inference request was started.');}}/>}
  {selectedRun&&admin&&<AgentRunDetail companyId={p.company.id} runId={selectedRun} user={p.user} role={p.company.role} onClose={()=>setSelectedRun(null)}/>}
 </section>;
}

function ReviewEditor({p,detail,initial,path,onClose,onSaved}:Props&{initial:StudioReviewPolicy|null;path:string;onClose:()=>void;onSaved:()=>Promise<void>}){
 const mutation=useStudioMutation();
 const live=p.workspace.agents.filter(agent=>agent.status==='active'&&agent.pluginInstallationId&&agent.invocationAccess!=='none'&&(!agent.expiresAt||Date.parse(agent.expiresAt)>Date.now()));
 const coordinators=live.filter(agent=>['studio.read','studio.write','tasks.write'].every(cap=>agent.capabilities?.includes(cap))&&detail.roles.some(role=>['producer','coordinator'].includes(role.key)&&role.agentId===agent.id));
 const [coordinatorAgentId,setCoordinator]=useState(initial?.coordinatorAgentId||coordinators[0]?.id||''),[reviewerAgentId,setReviewer]=useState(initial?.reviewerAgentId||'');
 const reviewers=live.filter(agent=>agent.id!==coordinatorAgentId&&['studio.read','studio.review'].every(cap=>agent.capabilities?.includes(cap)));
 const [allowedStages,setStages]=useState(initial?.allowedStages||['estimate','breakdown']),[allowSharedSponsor,setShared]=useState(initial?.allowSharedSponsor||false),[maxReviews,setMax]=useState(initial?.maxReviews||5);
 const [status,setStatus]=useState<'active'|'paused'>(initial?.status||'paused'),[expiresAt,setExpiry]=useState(initial?.expiresAt||new Date(Date.now()+3600000).toISOString()),[duration,setDuration]=useState(''),[reviewed,setReviewed]=useState(false);
 const changed=()=>setReviewed(false),valid=coordinators.some(agent=>agent.id===coordinatorAgentId)&&reviewers.some(agent=>agent.id===reviewerAgentId);
 async function submit(event:FormEvent){event.preventDefault();await mutation.mutate(path,{revision:initial?.revision||0,coordinatorAgentId,reviewerAgentId,allowedStages,allowSharedSponsor,maxReviews,status,expiresAt},onSaved,'PUT');}
 return <Modal title="Review the planning policy" description="Authorize a different agent to accept exact planning submissions within this project." onClose={()=>{if(!mutation.busy)onClose();}} wide><form className="form" onSubmit={submit}><fieldset disabled={mutation.busy}>
  <Field label="Coordinator"><select required value={coordinatorAgentId} onChange={event=>{setCoordinator(event.target.value);setReviewer('');changed();}}><option value="">Choose an active producer or coordinator</option>{coordinators.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
  <Field label="Separate planning reviewer" hint="Create an optional separate planning reviewer in Build an AI team, then enroll it through Agent hosts. An existing dedicated plugin agent needs studio.read and studio.review; this policy grants no permissions."><select required value={reviewerAgentId} onChange={event=>{setReviewer(event.target.value);changed();}}><option value="">Choose a reviewer with studio.review</option>{reviewers.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
  <fieldset className={s.disciplines}><legend>Planning stages this reviewer may accept</legend>{STUDIO_MACHINE_REVIEW_STAGES.map(stage=><label key={stage}><input type="checkbox" checked={allowedStages.includes(stage)} onChange={event=>{setStages(event.target.checked?[...allowedStages,stage]:allowedStages.filter(value=>value!==stage));changed();}}/>{stage==='estimate'?'Scope & estimate draft':stage==='breakdown'?'Shot breakdown & schedule':stage==='ingest'?'Agent-assigned ingest provenance':'Reference planning & provenance'}</label>)}</fieldset>
  <p className={s.muted}>Estimate review accepts the planning contribution; commercial approval remains a human decision. Ingest and reference review cover explicitly agent-assigned planning and provenance only. Opting into reference planning does not approve image quality, sharing media with Higgsfield, paid generation, or client delivery.</p>
  <label className={s.checkbox}><input type="checkbox" checked={allowSharedSponsor} onChange={event=>{setShared(event.target.checked);changed();}}/>Allow the separate reviewer and producer to share a sponsoring administrator. Reviews remain labeled as machine reviews.</label>
  <div className={s.formGrid}><Field label="Lifetime reviewer run allowance" hint={`${initial?.reviewsStarted||0} started. Policy edits do not reset usage.`}><input required type="number" min={Math.max(1,initial?.reviewsStarted||0)} max={100} value={maxReviews} onChange={event=>{setMax(Number(event.target.value));changed();}}/></Field><Field label="Policy state"><select value={status} onChange={event=>{setStatus(event.target.value as 'active'|'paused');changed();}}><option value="paused">Paused</option><option value="active">Allow reviewed planning acceptance</option></select></Field></div>
  <Field label="Approval expiry"><select value={duration} onChange={event=>{setDuration(event.target.value);if(event.target.value)setExpiry(new Date(Date.now()+Number(event.target.value)*60000).toISOString());changed();}}><option value="">Keep displayed expiry</option>{[20,60,240,480,1440].map(minutes=><option key={minutes} value={minutes}>{minutes<60?`${minutes} minutes`:`${minutes/60} hours`}</option>)}</select></Field>
  <p className={s.notice}>Expires {new Date(expiresAt).toLocaleString()}. Finish host enrollment before approval: initial worker connection rotates the agent configuration. The reviewer allowance is separate from specialist runs and coordinator cycles; it is not a spending cap.</p>
  <label className={s.checkbox}><input required type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>I reviewed the distinct agents, allowed stages, sponsor policy, lifetime allowance and exact expiry.</label>
 </fieldset>{mutation.error&&<p className="error-message" role="alert">{mutation.error}</p>}<div className={s.actions}><button type="button" className="button secondary" disabled={mutation.busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={mutation.busy||!reviewed||!valid||!allowedStages.length}>{mutation.busy?'Saving policy…':'Save reviewed policy'} <Check size={15}/></button></div></form></Modal>;
}
