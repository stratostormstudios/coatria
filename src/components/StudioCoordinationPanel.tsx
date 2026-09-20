'use client';

import {useState,type FormEvent} from 'react';
import {Bot,Check,GitBranch,Pause,RefreshCw,Settings2,ShieldCheck} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import type {StudioReadableProjectDetail} from '@/lib/studio-protocol';
import type {StudioCoordinationPolicy as Policy,StudioCoordinationSnapshot as Coordination} from '@/lib/studio-coordination-protocol';
import {Field,Loading,Modal} from './ui';
import {useStudioMutation,useStudioResource} from './studio-hooks';
import s from './StudioWorkspace.module.css';

type Props={p:WorkspaceProps;detail:StudioReadableProjectDetail;onSchedule:()=>void};

export function StudioCoordinationPanel({p,detail,onSchedule}:Props){
 const path=`/api/companies/${p.company.id}/studio/projects/${detail.project.id}/coordination`;
 const resource=useStudioResource<Coordination>(path),mutation=useStudioMutation(),[editing,setEditing]=useState(false);
 const admin=['owner','admin'].includes(p.company.role),policy=resource.data?.policy;
 const coordinator=detail.roles.find(role=>role.agentId===policy?.coordinatorAgentId);
 const status=policy?.effectiveStatus||policy?.status||'not configured';
 return <>
  <div className={s.heading}><div><h2>Let the coordinator bring the team together.</h2><p>Ready work goes to its assigned specialist. Every handoff keeps its task, run history, and review requirements.</p></div><button className="icon-button" aria-label="Refresh coordination" onClick={()=>void resource.reload()}><RefreshCw size={16}/></button></div>
  {resource.loading?<Loading label="Loading project coordination"/>:resource.data&&<>
   <div className={s.metrics}>
    <div className={s.metric}><span>Coordination</span><strong style={{fontSize:20,textTransform:'capitalize'}}>{status.replaceAll('_',' ')}</strong><small>{coordinator?.agentName||'Choose a production coordinator'}</small></div>
    <div className={s.metric}><span>Specialist runs remaining</span><strong>{policy?.remainingRuns??'—'}</strong><small>Within this project’s approved run allowance</small></div>
    <div className={s.metric}><span>Runs already started</span><strong>{policy?.runsStarted??0}</strong><small>Failed and cancelled runs still count</small></div>
    <div className={s.metric}><span>Concurrent specialist runs</span><strong>{policy?.maxConcurrentRuns??'—'}</strong><small>The connected host may have a lower limit</small></div>
   </div>
   <section className={s.section}>
    <div className={s.heading}><div><h3>Project delegation policy</h3><p>{policy?`Expires ${new Date(policy.expiresAt).toLocaleString()}. The allowance survives policy edits.`:'Review who can delegate, which roles can receive work, and how many runs the project can start.'}</p></div>{admin&&detail.project.status!=='delivered'&&<button className="button primary small" onClick={()=>setEditing(true)}><Settings2 size={14}/>{policy?'Review policy':'Set delegation policy'}</button>}</div>
    {policy?.blocker&&<p className={s.notice}>{policy.blocker}</p>}
    {admin&&policy?.status==='active'&&<button className="button secondary small" style={{marginTop:14}} disabled={mutation.busy} onClick={()=>void mutation.mutate(path,{revision:policy.revision,coordinatorAgentId:policy.coordinatorAgentId,allowedRoleKeys:policy.allowedRoleKeys,status:'paused',maxRuns:policy.maxRuns,maxConcurrentRuns:policy.maxConcurrentRuns,expiresAt:policy.expiresAt,...policy.generatedContinuations!==undefined?{generatedContinuations:policy.generatedContinuations}:{}},async()=>{await resource.reload();p.notify('Delegation paused. Delegated requests lose authority on their next API or lease check.');},'PUT')}><Pause size={14}/>{mutation.busy?'Pausing…':'Pause delegation'}</button>}
    {policy&&<ul className={s.skills} style={{marginTop:16}}>{policy.allowedRoleKeys.map(key=><li key={key}>{detail.roles.find(role=>role.key===key)?.title||key}</li>)}</ul>}
    {detail.project.contractVersion===2&&<p className={s.muted}>Verified generated output continuations: <strong>{policy?.generatedContinuations?'Opted in':'Off'}</strong>. Each continuation uses the existing specialist run allowance; an active policy and verified source are still required. It adds no generation, file transfer, or review authority.</p>}
    <p className={s.muted}>The coordinator can request existing work only after its dependencies and approval gates are satisfied. Changes to reviewed agents or assignments require a new policy review.</p>
    <div className={s.notice}><ShieldCheck size={17}/><p>This allowance counts specialist requests created by the coordinator. Coordinator cycles and manually queued requests have separate limits. It is not a dollar spending cap.</p></div>
   </section>
   <section className={s.section}><div className={s.heading}><div><h3>Keep the project moving</h3><p>A connected worker and an activated coordinator mission are needed for recurring progress. Saving a delegation policy starts neither.</p></div>{admin&&<button className="button secondary small" onClick={onSchedule}><Bot size={14}/> Schedule coordinator</button>}</div></section>
   <section className={s.section}><h3><GitBranch size={16}/> Specialist handoffs</h3>{!resource.data.dispatches.length?<p className={s.muted}>No specialist handoffs yet. Accepted dependencies and a live coordinator determine the next permitted action.</p>:<ol className={s.history}>{resource.data.dispatches.map(receipt=><li key={receipt.childRunId}><strong>{detail.workItems.find(work=>work.id===receipt.workItemId)?.title||'Production work'}</strong>{receipt.archiveId&&<small>Verified generated output continuation</small>}<small>{receipt.status||'Request recorded'}{receipt.createdAt?` · ${new Date(receipt.createdAt).toLocaleString()}`:''}</small><details><summary>Request provenance</summary><p>Coordinator request: {receipt.parentRunId}<br/>Specialist request: {receipt.childRunId}{receipt.archiveId&&<><br/>Verified archive: {receipt.archiveId}{receipt.sourceChildRunId&&<><br/>Original specialist request: {receipt.sourceChildRunId}</>}{receipt.artifactId&&<><br/>Registered artifact: {receipt.artifactId}</>}</>}</p></details></li>)}</ol>}</section>
  </>}
  {(resource.error||mutation.error)&&<p className="error-message" role="alert">{resource.error||mutation.error}</p>}
  {editing&&resource.data&&<PolicyEditor key={detail.project.id} p={p} detail={detail} initial={resource.data.policy} path={path} onClose={()=>setEditing(false)} onSaved={async()=>{setEditing(false);await resource.reload();p.notify('Project delegation policy saved. Worker and mission controls remain separate.');}}/>}
 </>;
}

function PolicyEditor({p,detail,initial:loadedPolicy,path,onClose,onSaved}:{p:WorkspaceProps;detail:StudioReadableProjectDetail;initial:Policy|null;path:string;onClose:()=>void;onSaved:()=>Promise<void>}){
 const mutation=useStudioMutation();
 // Background polling must not change the reviewed revision or an exact retry.
 const [initial]=useState(loadedPolicy);
 const candidates=p.workspace.agents.filter(agent=>agent.status==='active'&&!!agent.pluginInstallationId&&['studio.read','studio.write','tasks.write'].every(cap=>agent.capabilities?.includes(cap))&&detail.roles.some(role=>['producer','coordinator'].includes(role.key)&&role.agentId===agent.id));
 const [coordinatorAgentId,setCoordinatorAgentId]=useState(initial?.coordinatorAgentId||candidates[0]?.id||'');
 const [allowedRoleKeys,setAllowedRoleKeys]=useState<string[]>(initial?.allowedRoleKeys||[]),[maxRuns,setMaxRuns]=useState(initial?.maxRuns||5),[maxConcurrentRuns,setMaxConcurrentRuns]=useState(initial?.maxConcurrentRuns||1),[status,setStatus]=useState<'active'|'paused'>(initial?.status||'paused');
 const [expiresAt,setExpiresAt]=useState(initial?.expiresAt||new Date(Date.now()+3600000).toISOString()),[duration,setDuration]=useState(''),[reviewed,setReviewed]=useState(false);
 const [generatedContinuations,setGeneratedContinuations]=useState(initial?.generatedContinuations??false),[continuationsChanged,setContinuationsChanged]=useState(false);
 const roles=detail.roles.filter(role=>role.agentId&&role.agentId!==coordinatorAgentId&&role.key!=='qc'&&detail.workItems.some(work=>work.roleKey===role.key&&work.execution!=='human'));
 const invalidRoles=allowedRoleKeys.some(key=>!roles.some(role=>role.key===key));
 const changed=()=>setReviewed(false);
 async function submit(event:FormEvent){event.preventDefault();await mutation.mutate(path,{revision:initial?.revision||0,coordinatorAgentId,allowedRoleKeys,maxRuns,maxConcurrentRuns,status,expiresAt,...initial?.generatedContinuations!==undefined||continuationsChanged?{generatedContinuations}:{}},onSaved,'PUT');}
 return <Modal title="Review project delegation" description="Give one coordinator a bounded ability to request work from reviewed specialists." onClose={()=>{if(!mutation.busy)onClose();}} wide><form className="form" onSubmit={submit}><fieldset disabled={mutation.busy}>
  <Field label="Project coordinator"><select required value={coordinatorAgentId} onChange={event=>{setCoordinatorAgentId(event.target.value);setAllowedRoleKeys([]);changed();}}><option value="">Choose an active producer or coordinator</option>{candidates.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
  <fieldset className={s.disciplines}><legend>Specialist roles this coordinator may request</legend>{roles.map(role=><label key={role.key}><input type="checkbox" checked={allowedRoleKeys.includes(role.key)} onChange={event=>{setAllowedRoleKeys(event.target.checked?[...allowedRoleKeys,role.key]:allowedRoleKeys.filter(key=>key!==role.key));changed();}}/>{role.title} · {role.agentName||'Assigned agent'}</label>)}{!roles.length&&<p>Assign a different specialist to an agent or DCC production step first.</p>}</fieldset>
  <div className={s.formGrid} style={{marginTop:18}}><Field label="Total specialist run allowance" hint={`${initial?.runsStarted||0} already started. Existing usage is never reset.`}><input required type="number" min={Math.max(1,initial?.runsStarted||0)} max={100} value={maxRuns} onChange={event=>{setMaxRuns(Number(event.target.value));changed();}}/></Field><Field label="Maximum concurrent specialist runs"><input required type="number" min={1} max={3} value={maxConcurrentRuns} onChange={event=>{setMaxConcurrentRuns(Number(event.target.value));changed();}}/></Field></div>
  {detail.project.contractVersion===2&&<div><label className={s.checkbox}><input type="checkbox" checked={generatedContinuations} aria-describedby="generated-continuations-help" onChange={event=>{setGeneratedContinuations(event.target.checked);setContinuationsChanged(true);changed();}}/>Allow verified generated output continuations</label><p id="generated-continuations-help" className={s.muted}>Off by default. Resume an assigned specialist from its exact verified generated output within the existing run allowance. This permits registration and task submission only; it adds no generation, file transfer, or review authority. Independent QC and delivery approvals remain required.</p></div>}
  <div className={s.formGrid}><Field label="Policy state"><select value={status} onChange={event=>{setStatus(event.target.value as 'active'|'paused');changed();}}><option value="paused">Paused</option><option value="active">Allow reviewed delegation</option></select></Field><Field label="Set a new expiry"><select value={duration} onChange={event=>{setDuration(event.target.value);if(event.target.value)setExpiresAt(new Date(Date.now()+Number(event.target.value)*60000).toISOString());changed();}}><option value="">Keep the displayed expiry</option>{[20,60,120,240,480,1440].map(minutes=><option key={minutes} value={minutes}>{minutes<60?`${minutes} minutes`:`${minutes/60} hours`}</option>)}</select></Field></div>
  <p className={s.notice}>Exact expiry: {new Date(expiresAt).toLocaleString()}. Complete enrollment and wait for the supervisor’s first connection before this review. Initial connection and supervisor takeover rotate the reviewed agent configuration.</p>
  <p className={s.muted}>The coordinator cannot hire agents, increase their permissions, approve media, or send client deliveries. Each specialist keeps its existing model and per-request limits. Pausing, expiry, or changing this policy ends delegated authority at the next API or lease check, including for work already queued or running. Use request cancellation and host controls when an operational stop is needed.</p>
  <label className={s.checkbox}><input required type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>I reviewed the coordinator, selected roles, request allowance, concurrency, state, and exact expiry{detail.project.contractVersion===2?', including the generated output continuation option':''}.</label>
 </fieldset>{invalidRoles&&<p className="error-message" role="alert">A reviewed role is no longer available. Re-select the coordinator and review its current specialists.</p>}{mutation.error&&<p className="error-message" role="alert">{mutation.error}</p>}<div className={s.actions}><button className="button secondary" type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={mutation.busy||!reviewed||!coordinatorAgentId||!allowedRoleKeys.length||invalidRoles}>{mutation.busy?'Saving policy…':'Save reviewed policy'} <Check size={15}/></button></div></form></Modal>;
}
