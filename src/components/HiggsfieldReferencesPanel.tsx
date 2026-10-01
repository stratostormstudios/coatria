'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {FileImage,RefreshCw,ShieldCheck} from 'lucide-react';
import {api,when} from '@/lib/client';
import {HIGGSFIELD_REFERENCE_ROLES,type HiggsfieldReference,type HiggsfieldReferenceAvailability,type HiggsfieldReferencePage} from '@/lib/higgsfield-references-protocol';
import type {StudioReadableProjectDetail} from '@/lib/studio-protocol';
import {Badge,Field,Loading} from './ui';
import {ReferenceFilePicker,ReferenceImagePreview,referenceSize,type ReferenceFileSelection} from './HiggsfieldReferenceFiles';
import s from './HiggsfieldReferencesPanel.module.css';

type Page=HiggsfieldReferencePage&{processing:HiggsfieldReferenceAvailability};
type ReferenceResponse={reference:HiggsfieldReference;processing:HiggsfieldReferenceAvailability};
type Props={companyId:string;projectId:string;projectRevision:number;projectReady:boolean;workItems:StudioReadableProjectDetail['workItems'];workItemId?:string;isAdmin:boolean;connectionRevision:number;onSelectionChange:(ids:string[])=>void};
const labels:Record<HiggsfieldReference['status'],string>={proposed:'Waiting for image inspection',inspecting:'Inspecting exact image',awaiting_approval:'Ready for your review',queued:'Approved · waiting for worker',reading:'Reading approved storage version',allocating:'Requesting upload slot',allocated:'Upload slot received',uploading:'Sharing approved bytes',uploaded:'Bytes sent · confirmation pending',confirming:'Awaiting Higgsfield confirmation',confirmed:'Higgsfield confirmed',uncertain:'Outcome unknown · review required',blocked:'Reference blocked',failed:'Reference failed',revoked:'Sharing permission revoked'};
const freshApproval=(reference:HiggsfieldReference,now:number)=>!!reference.expiresAt&&Date.parse(reference.expiresAt)>now&&!reference.revokedAt;
function FileFacts({file,label}:{file:ReferenceFileSelection;label:string}){return <div className={s.fileFacts}><strong>{label}: {file.name} · v{file.version}</strong><p>{referenceSize(file.bytes)} · {file.contentType}</p><details><summary>Exact file version and checksum</summary><dl className={s.facts}><div><dt>Exact version</dt><dd><code>{file.versionId}</code></dd></div><div><dt>SHA-256</dt><dd><code>{file.sha256}</code></dd></div></dl></details></div>;}

/** Reference IDs are safe company/project identifiers, never provider credentials or upload URLs. */
export function HiggsfieldReferencesPanel(props:Props){return <References key={`${props.companyId}:${props.projectId}:${props.connectionRevision}:${props.workItemId??''}:${props.isAdmin}`} {...props}/>;}
function References({companyId,projectId,projectRevision,projectReady,workItems,workItemId,isAdmin,connectionRevision,onSelectionChange}:Props){
 const base=`/api/companies/${companyId}/higgsfield/references`;
 const [page,setPage]=useState<Page|null>(null),[review,setReview]=useState<HiggsfieldReference|null>(null),[picker,setPicker]=useState<'proxy'|'source'|null>(null),[proxy,setProxy]=useState<ReferenceFileSelection|null>(null),[source,setSource]=useState<ReferenceFileSelection|null>(null);
 const [task,setTask]=useState(workItemId??''),[role,setRole]=useState<HiggsfieldReference['role']>('image'),[purpose,setPurpose]=useState(''),[minutes,setMinutes]=useState(30),[consents,setConsents]=useState([false,false,false,false]),[previewed,setPreviewed]=useState(''),[selected,setSelected]=useState<string[]>([]);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[now,setNow]=useState(Date.now());
 const alive=useRef(true),pending=useRef(false),read=useRef<AbortController|null>(null),sequence=useRef(0),ids=useRef(new Map<string,string>());
 const tasks=workItems.filter(item=>['references','generation'].includes(item.stage)&&['agent','creative'].includes(item.execution));
 const idFor=(value:unknown)=>{const signature=JSON.stringify(value);let id=ids.current.get(signature);if(!id){id=crypto.randomUUID();ids.current.set(signature,id);}return id;};
 function clearConsent(){setConsents([false,false,false,false]);setPreviewed('');}
 function assertScope(reference:HiggsfieldReference){if(reference.projectId!==projectId)throw Error('The reference response changed project scope. Refresh before continuing.');}
 const load=useCallback(async(after?:string)=>{
  read.current?.abort();const controller=new AbortController(),ticket=++sequence.current;read.current=controller;setLoading(true);setError('');setReview(null);setConsents([false,false,false,false]);setPreviewed('');
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{
   const value=await api<Page>(`${base}?${new URLSearchParams({projectId,limit:'20',...(after?{after}:{})})}`,'GET',undefined,{signal:controller.signal});
   if(value.references.some(item=>item.projectId!==projectId))throw Error('The reference response changed project scope. Refresh before continuing.');
   if(alive.current&&ticket===sequence.current)setPage(previous=>({...value,references:after&&previous?[...previous.references,...value.references.filter(item=>!previous.references.some(old=>old.id===item.id))]:value.references}));
  }catch(cause){if(alive.current&&ticket===sequence.current){setPage(null);setError(cause instanceof Error?cause.message:'References could not be loaded.');}}
  finally{clearTimeout(timer);if(alive.current&&ticket===sequence.current)setLoading(false);}
 },[base,projectId]);
 useEffect(()=>{alive.current=true;void load();const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{alive.current=false;sequence.current++;read.current?.abort();clearInterval(timer);};},[load]);
 const usable=page?.references.filter(item=>item.status==='confirmed'&&item.providerConfirmed&&freshApproval(item,now)&&item.providerConnectionRevision===connectionRevision)??[];
 const effectiveIds=projectReady?selected.filter(id=>usable.some(item=>item.id===id)):[];
 const selectionKey=effectiveIds.join(',');
 useEffect(()=>{onSelectionChange(selectionKey?selectionKey.split(','):[]);},[selectionKey,onSelectionChange]);
 useEffect(()=>()=>onSelectionChange([]),[onSelectionChange]);
 async function act(operation:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');try{await operation();}catch(cause){if(alive.current){clearConsent();setError(cause instanceof Error?cause.message:'The reference action was not confirmed. Refresh its status before trying again.');}}finally{pending.current=false;if(alive.current)setBusy(false);}}
 function replace(value:ReferenceResponse){assertScope(value.reference);if(!alive.current)return;setPage(previous=>({...previous,references:previous?.references.some(item=>item.id===value.reference.id)?previous.references.map(item=>item.id===value.reference.id?value.reference:item):[value.reference,...previous?.references??[]],hasMore:previous?.hasMore??false,nextAfter:previous?.nextAfter??null,processing:value.processing}));setReview(value.reference);clearConsent();}
 async function propose(){
  if(!proxy||!task)throw Error('Choose an exact prepared image and a production task.');
  const value={projectId,projectRevision,workItemId:task,proxyVersionId:proxy.versionId,proxySha256:proxy.sha256,proxyBytes:proxy.bytes,...source?{sourceVersionId:source.versionId}:{},role,purpose};
  const result=await api<ReferenceResponse>(base,'POST',{...value,clientId:idFor(value)});
  if(result.reference.proxy.versionId!==proxy.versionId||result.reference.proxy.sha256!==proxy.sha256||result.reference.proxy.bytes!==proxy.bytes||result.reference.source?.versionId!==(source?.versionId)||result.reference.workItemId!==task||result.reference.role!==role)throw Error('The prepared reference does not match your selected version. Refresh before reviewing it.');
  replace(result);setNotice('Reference prepared for inspection. No sharing approval has been given.');
 }
 async function inspect(item:HiggsfieldReference){setReview(null);clearConsent();const result=await api<ReferenceResponse>(`${base}/${item.id}`);if(result.reference.id!==item.id)throw Error('The reference identity changed. Refresh the list.');replace(result);setMinutes(30);}
 async function approve(){
  if(!review?.inspection||previewed!==review.requestHash||!consents.every(Boolean))throw Error('Preview and review this exact image before approving.');
  const value={revision:review.revision,requestHash:review.requestHash,inspectionHash:review.inspection.inspectionHash,expiresInMinutes:minutes,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true};
  const result=await api<ReferenceResponse>(`${base}/${review.id}/approve`,'POST',{...value,clientId:idFor({referenceId:review.id,...value})});
  if(result.reference.id!==review.id||result.reference.requestHash!==review.requestHash)throw Error('The approval response does not match the reviewed reference. Refresh its status.');
  replace(result);setNotice('Exact-byte sharing approved. Refresh to see the worker’s saved progress.');
 }
 async function revoke(item:HiggsfieldReference){
  const value={revision:item.revision,note:'Sharing permission revoked by an administrator in the project reference panel.'};
  const result=await api<ReferenceResponse>(`${base}/${item.id}/revoke`,'POST',{...value,clientId:idFor({referenceId:item.id,...value})});
  if(result.reference.id!==item.id)throw Error('The revocation response changed reference identity. Refresh its status.');
  replace(result);setSelected(previous=>previous.filter(id=>id!==item.id));setNotice('Future sharing and managed use are revoked. Bytes already disclosed may remain at Higgsfield; this did not delete them.');
 }
 const locked=busy||loading||!projectReady,processing=page?.processing,processingCurrent=!!processing?.enabled&&(!processing.expiresAt||Date.parse(processing.expiresAt)>now);
 const consentLabels=['This is the intended prepared image; the linked original must remain private.','I hold the rights and permission to share the image and its contents.','I understand all bytes, including embedded metadata, will be shared unchanged.','I approve sharing this exact version with the company Higgsfield connection shown above.'];
 return <section className={s.panel} aria-label="Managed Higgsfield references" aria-busy={locked}>
  <header className={s.header}><div><span className="eyebrow">PROJECT FILE → CREATIVE REFERENCE</span><h3><FileImage size={19}/>Share only the reference you approve</h3><p>Select a prepared image, inspect its exact version, then approve a bounded transfer.</p></div><button className="button secondary small" disabled={locked} onClick={()=>void load()}><RefreshCw size={14}/>Refresh references</button></header>
  {error&&<p className="error-message" role="alert">{error}</p>}{notice&&<p className={s.notice} role="status">{notice}</p>}
  {processing&&<p className={s.notice} role="status">{processing.message}{processing.enabled&&!processingCurrent?' This worker qualification has expired. Sharing is unavailable.':''}</p>}
  {loading&&!page&&<Loading label="Loading project references"/>}
  <p>Prepared images are copied unchanged. Coatria does not resize them or remove metadata in this flow. Keep heavy or private originals on project storage.</p>
  <div className={s.form} role="group" aria-label="Prepare managed reference">
   <h4>1. Choose what can leave project storage</h4>
   <div className={s.actions}><button className="button secondary small" disabled={locked} onClick={()=>setPicker('proxy')}>{proxy?'Change prepared image':'Choose prepared image'}</button>{proxy&&<button className="button secondary small" disabled={locked} onClick={()=>setPicker('source')}>{source?'Change linked original':'Link original for provenance (optional)'}</button>}{source&&<button className="button secondary small" disabled={locked} onClick={()=>setSource(null)}>Remove original link</button>}</div>
   {picker&&<ReferenceFilePicker key={`${projectId}:${picker}`} companyId={companyId} projectId={projectId} imageOnly={picker==='proxy'} label={picker==='proxy'?'Choose prepared reference image':'Link original source version'} onClose={()=>setPicker(null)} onSelect={value=>{if(picker==='proxy'){setProxy(value);if(source?.versionId===value.versionId)setSource(null);}else if(value.versionId===proxy?.versionId){setError('Choose a distinct original version. The prepared image is already selected.');return;}else setSource(value);setPicker(null);setError('');}}/>}
   {proxy&&<FileFacts file={proxy} label="Prepared image"/>}{source&&<FileFacts file={source} label="Original · provenance only"/>}
   <div className={s.columns}><Field label="Reference production task"><select value={task} disabled={locked} onChange={event=>setTask(event.target.value)}><option value="">Choose references or generation work</option>{tasks.map(item=><option key={item.id} value={item.id} disabled={!['todo','doing'].includes(item.status)||!!item.blockedReason}>{item.title} · {item.status}</option>)}</select></Field><Field label="Intended reference role" hint="The chosen generation model must support this role."><select value={role} disabled={locked} onChange={event=>setRole(event.target.value as HiggsfieldReference['role'])}>{HIGGSFIELD_REFERENCE_ROLES.map(value=><option key={value} value={value}>{value==='image'?'Image reference':value==='start_image'?'Video start frame':'Video end frame'}</option>)}</select></Field></div>
   <Field label="Reference purpose"><input maxLength={1000} value={purpose} disabled={locked} onChange={event=>setPurpose(event.target.value)} placeholder="For example: approved product shape and color reference"/></Field>
   <button className="button primary small" disabled={locked||!proxy||!task||!purpose.trim()} onClick={()=>void act(propose)}>Prepare reference for inspection</button>
  </div>
  {review&&<section className={s.review} aria-label="Review reference sharing">
   <div className={s.header}><h4>2. Review exact-byte sharing</h4><Badge>{labels[review.status]}</Badge></div>
   {review.status==='awaiting_approval'&&review.inspection&&<ReferenceImagePreview key={`${review.id}:${review.revision}:${review.requestHash}`} companyId={companyId} projectId={projectId} file={review.proxy} onVerified={()=>setPreviewed(review.requestHash)}/>}
   {review.projectRevision!==projectRevision&&<p className={s.notice} role="status">The project changed after this reference was prepared. Prepare and review a new reference before sharing.</p>}<FileFacts file={review.proxy} label="Image to share"/>{review.source&&<FileFacts file={review.source} label="Linked original · never substituted"/>}
   <dl className={s.facts}><div><dt>Purpose</dt><dd>{review.purpose}</dd></div><div><dt>Role</dt><dd>{review.role}</dd></div><div><dt>Destination</dt><dd>Company Higgsfield connection <code>{review.providerConnectionId}</code> · revision {review.providerConnectionRevision}</dd></div><div><dt>Project / task</dt><dd><code>{review.projectId}</code> / <code>{review.workItemId}</code></dd></div></dl>
   <details><summary>Review fingerprints and inspection</summary><p>Request SHA-256: <code>{review.requestHash}</code><br/>Storage connection revision: {review.storageConnectionRevision}<br/>Project revision: {review.projectRevision} · Task revision: {review.taskRevision}</p>{review.inspection?<><p>Server inspection recorded {when(review.inspection.inspectedAt)}. Full decoding does not sanitize or establish sharing rights.</p><pre>{JSON.stringify(review.inspection,null,2)}</pre></>:<p>No trusted image inspection recorded yet. Approval is unavailable.</p>}</details>
   {review.status==='awaiting_approval'&&<>
    {isAdmin?<><Field label="Reference permission expires after"><select value={minutes} disabled={locked} onChange={event=>{setMinutes(Number(event.target.value));setConsents([false,false,false,false]);}}>{[10,30,60].map(value=><option value={value} key={value}>{value} minutes</option>)}</select></Field><p className={s.disclosure}>The full file, including visible contents and embedded metadata, will be shared unchanged with Higgsfield. Approval expires after the interval above. Revoking permission cannot retract bytes already disclosed.</p>{consentLabels.map((label,index)=><label key={label} className={s.check}><input type="checkbox" checked={consents[index]} disabled={locked||!processingCurrent||previewed!==review.requestHash||!review.inspection||review.providerConnectionRevision!==connectionRevision||review.projectRevision!==projectRevision} onChange={event=>setConsents(previous=>previous.map((value,i)=>i===index?event.target.checked:value))}/>{label}</label>)}{previewed!==review.requestHash&&<p>Open the exact image preview before confirming these permissions.</p>}<button className="button primary small" disabled={locked||!processingCurrent||!review.inspection||previewed!==review.requestHash||!consents.every(Boolean)||review.providerConnectionRevision!==connectionRevision||review.projectRevision!==projectRevision} onClick={()=>void act(approve)}>Approve exact reference sharing</button></>:<p>A human administrator must preview and approve external sharing. Agents and members can prepare references and follow progress.</p>}
   </>}
   {review.expiresAt&&<p>Approval expires {new Date(review.expiresAt).toLocaleString()}{!freshApproval(review,now)?' · Permission is no longer current.':''}</p>}
  </section>}
  <div className={s.history}><h4>3. Confirmed references for the next generation</h4><p>Select up to eight confirmed, unexpired references below. When you prepare the generation, Coatria checks the project content, task relationship and current reference permissions on the server. Selection does not confirm compatibility. A generation still needs its own prompt and credit approval.</p>{page&&!page.references.length&&<p>No managed references prepared for this project.</p>}
   {page?.references.map(item=><article key={item.id} className={s.card} aria-label={`Reference ${item.proxy.name}`}><div className={s.header}><strong>{item.proxy.name} · v{item.proxy.version}</strong><Badge tone={item.status==='confirmed'&&item.providerConfirmed?'good':['uncertain','blocked','failed'].includes(item.status)?'warning':''}>{labels[item.status]}</Badge></div><p>{item.purpose} · {item.role} · {referenceSize(item.proxy.bytes)}</p>{item.status==='confirmed'&&item.providerConfirmed?<p><ShieldCheck size={14}/>Higgsfield acknowledged this upload. This is not creative approval or client acceptance.</p>:<p>No confirmed provider reference is available yet.</p>}{item.expiresAt&&<p>{freshApproval(item,now)?'Permission expires':'Permission expired or revoked'} {new Date(item.expiresAt).toLocaleString()}</p>}{item.status==='uncertain'&&<p className={s.disclosure}>Higgsfield may have received an upload or confirmation. Do not create a replacement until this original attempt is reconciled. No automatic retry is offered.</p>}{item.status==='revoked'&&<p>Future sharing and managed use are disabled. Bytes already shared may remain at Higgsfield.</p>}{item.diagnosticCode&&<p>Diagnostic: <code>{item.diagnosticCode}</code></p>}{usable.some(value=>value.id===item.id)&&isAdmin&&<label className={s.check}><input type="checkbox" checked={effectiveIds.includes(item.id)} disabled={locked||!effectiveIds.includes(item.id)&&effectiveIds.length>=8} onChange={event=>setSelected(previous=>event.target.checked?[...previous.filter(id=>id!==item.id),item.id]:previous.filter(id=>id!==item.id))}/>Use {item.proxy.name} version {item.proxy.version} in the next generation</label>}<div className={s.actions}><button className="button secondary small" disabled={locked} onClick={()=>void act(()=>inspect(item))}>Review reference details</button>{isAdmin&&item.status!=='revoked'&&<button className="button secondary small" disabled={locked} onClick={()=>void act(()=>revoke(item))}>Revoke reference permission</button>}</div></article>)}
   {page?.hasMore&&page.nextAfter&&<button className="button secondary small" disabled={locked} onClick={()=>void load(page.nextAfter!)}>Load more references</button>}
  </div>
 </section>;
}
