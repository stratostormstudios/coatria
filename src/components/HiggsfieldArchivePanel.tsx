'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Archive,ChevronRight,FolderOpen,RefreshCw,ShieldCheck,X} from 'lucide-react';
import {api,when} from '@/lib/client';
import type {HiggsfieldArchive,HiggsfieldArchivePage} from '@/lib/higgsfield-archive-protocol';
import type {ProjectStorageListing} from '@/lib/project-storage-protocol';
import type {StudioReadableProjectDetail} from '@/lib/studio-protocol';
import {Badge,Field,Loading} from './ui';
import s from './HiggsfieldArchivePanel.module.css';

export type ArchiveSelection={jobId:string;outputId:string;outputIdentity:string;kind:string};
type Props={companyId:string;projectId:string;contractVersion?:1|2;isAdmin:boolean;selection:ArchiveSelection|null;onClose:()=>void};
type ArchivePage=HiggsfieldArchivePage&{processing:{enabled:boolean;message:string}};
const labels:Record<HiggsfieldArchive['status'],string>={proposed:'Awaiting approval',queued:'Approved · waiting for worker',fetching:'Checking source media',uploading:'Saving to project storage',verifying:'Verifying stored bytes',verified:'Stored file verified',uncertain:'Transfer needs inspection',blocked:'Archive blocked',cancelled:'Approval revoked',failed:'Archive failed'};
const size=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GiB`:bytes>=1024**2?`${(bytes/1024**2).toFixed(1)} MiB`:`${bytes.toLocaleString()} bytes`;
const destination=(archive:HiggsfieldArchive)=>['Project files',...archive.destination.ancestors.map(item=>item.name),archive.destination.name].join(' / ');

/** Locators and access credentials never enter this component. */
export function HiggsfieldArchivePanel(props:Props){return <ArchivePanel key={`${props.companyId}:${props.projectId}:${props.contractVersion??1}:${props.isAdmin}:${props.selection?.jobId??''}:${props.selection?.outputId??'history'}:${props.selection?.outputIdentity??''}`} {...props}/>;}
function ArchivePanel({companyId,projectId,contractVersion=1,isAdmin,selection,onClose}:Props){
 const base=`/api/companies/${companyId}/higgsfield/archives`,projectBase=`/api/companies/${companyId}/studio/projects/${projectId}`;
 const projectReadUrl=projectBase+(contractVersion===2?'?contractVersion=2':'');
 const [project,setProject]=useState<StudioReadableProjectDetail|null>(null);
 const [page,setPage]=useState<ArchivePage|null>(null),[projectRevision,setProjectRevision]=useState<number|null>(null),[listing,setListing]=useState<ProjectStorageListing|null>(null),[parentId,setParentId]=useState<string|null>(null);
 const [name,setName]=useState(selection?`output-${selection.outputId.slice(0,8)}`:''),[fileId,setFileId]=useState(''),[maxBytes,setMaxBytes]=useState(256*1024**2),[hours,setHours]=useState(2),[consent,setConsent]=useState(false);
 const [reviewBinding,setReviewBinding]=useState<{id:string;revision:number}|null>(null);
 const [review,setReview]=useState<HiggsfieldArchive|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const mounted=useRef(true),inFlight=useRef(false),read=useRef<AbortController|null>(null),sequence=useRef(0),requestId=useRef<{signature:string;id:string}|null>(null);
 function idFor(value:unknown){const signature=JSON.stringify(value);if(requestId.current?.signature!==signature)requestId.current={signature,id:crypto.randomUUID()};return requestId.current.id;}
 const refresh=useCallback(async(folder:string|null=null,after?:string)=>{
  read.current?.abort();const controller=new AbortController(),ticket=++sequence.current;read.current=controller;setLoading(true);setError('');setReview(null);setConsent(false);setProjectRevision(null);setReviewBinding(null);
  const timeout=setTimeout(()=>controller.abort(),20_000);
  try{
   const query=new URLSearchParams({limit:'50',...(folder?{parentId:folder}:{})});
   const [archives,files,detail]=await Promise.all([
    api<ArchivePage>(`${base}?${new URLSearchParams({projectId,limit:'20',...(after?{after}:{})})}`,'GET',undefined,{signal:controller.signal}),
    api<ProjectStorageListing>(`${projectBase}/files?${query}`,'GET',undefined,{signal:controller.signal}),
    api<StudioReadableProjectDetail>(projectReadUrl,'GET',undefined,{signal:controller.signal})
   ]);
   if(detail.project.id!==projectId||(detail.project.contractVersion??1)!==contractVersion||files.binding&&files.binding.projectId!==projectId||archives.archives.some(archive=>archive.projectId!==projectId))throw Error('The archive response changed project scope. Refresh before choosing a destination.');
   if(mounted.current&&ticket===sequence.current){setPage(previous=>({...archives,archives:after&&previous?[...previous.archives,...archives.archives.filter(item=>!previous.archives.some(old=>old.id===item.id))]:archives.archives}));setListing(files);setProject(detail);setProjectRevision(detail.project.revision);setParentId(folder);setFileId('');}
  }catch(cause){if(mounted.current&&ticket===sequence.current)setError(cause instanceof Error?cause.message:'Archive details could not be loaded.');}
  finally{clearTimeout(timeout);if(mounted.current&&ticket===sequence.current)setLoading(false);}
 },[base,projectBase,projectReadUrl,projectId,contractVersion]);
 useEffect(()=>{mounted.current=true;let active=true;queueMicrotask(()=>{if(active)void refresh();});return()=>{active=false;mounted.current=false;sequence.current++;read.current?.abort();};},[refresh]);
 async function act(action:()=>Promise<void>){if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(cause){if(mounted.current){setConsent(false);setError(cause instanceof Error?cause.message:'The archive action could not be completed. Refresh before choosing your next step.');}}finally{inFlight.current=false;if(mounted.current)setBusy(false);}}
 function replace(archive:HiggsfieldArchive){setPage(previous=>previous?{...previous,archives:previous.archives.some(item=>item.id===archive.id)?previous.archives.map(item=>item.id===archive.id?archive:item):[archive,...previous.archives]}:previous);}
 async function propose(){
  if(!selection||!listing?.binding||projectRevision===null)throw Error('Choose connected project storage first.');
  const input={projectId,projectRevision,jobId:selection.jobId,outputId:selection.outputId,outputIdentity:selection.outputIdentity,bindingId:listing.binding.id,bindingRevision:listing.binding.revision,parentId,...fileId?{fileId}:{},name,maxBytes};
  const result=await api<{archive:HiggsfieldArchive}>(base,'POST',{...input,clientId:idFor(input)});
  if(result.archive.projectId!==projectId||result.archive.jobId!==selection.jobId||result.archive.outputId!==selection.outputId||result.archive.outputIdentity!==selection.outputIdentity)throw Error('The archive response does not match this selected output. Refresh before continuing.');
  if(mounted.current){replace(result.archive);setReview(result.archive);setReviewBinding(listing.binding);setConsent(false);setNotice('Destination prepared. An administrator must approve the exact archive before it runs.');}
 }
 async function inspect(archive:HiggsfieldArchive){
  setConsent(false);setReview(null);setReviewBinding(null);setProjectRevision(null);
  const [fresh,files,detail]=await Promise.all([api<{archive:HiggsfieldArchive}>(`${base}/${archive.id}`),api<ProjectStorageListing>(`${projectBase}/files?limit=1`),api<StudioReadableProjectDetail>(projectReadUrl)]);
  if(fresh.archive.id!==archive.id||fresh.archive.projectId!==projectId||detail.project.id!==projectId||(detail.project.contractVersion??1)!==contractVersion||files.binding&&files.binding.projectId!==projectId)throw Error('The reviewed archive changed project scope. Refresh before approving.');
  if(mounted.current){replace(fresh.archive);setReview(fresh.archive);setReviewBinding(files.binding);setProject(detail);setProjectRevision(detail.project.revision);setConsent(false);setHours(2);}
 }
 async function approve(){
  if(!review||projectRevision===null||!reviewBinding)throw Error('Refresh this proposal and its storage connection before approving.');
  const input={revision:review.revision,requestHash:review.requestHash,projectRevision,bindingRevision:reviewBinding.revision,expiresInHours:hours,archiveConsent:true};
  const result=await api<{archive:HiggsfieldArchive}>(`${base}/${review.id}/approve`,'POST',{...input,clientId:idFor({id:review.id,...input})});
  if(result.archive.projectId!==projectId||result.archive.id!==review.id||result.archive.requestHash!==review.requestHash)throw Error('The approval response does not match the reviewed archive. Refresh its status.');
  if(mounted.current){replace(result.archive);setReview(result.archive);setConsent(false);setNotice('Archive approved. Refresh to read the worker’s saved progress. This does not approve the media for delivery.');}
 }
 async function revoke(archive:HiggsfieldArchive){
  const input={revision:archive.revision,note:'Revoked in the project archive panel.'};
  const result=await api<{archive:HiggsfieldArchive}>(`${base}/${archive.id}/revoke`,'POST',{...input,clientId:idFor({id:archive.id,...input})});
  if(result.archive.projectId!==projectId||result.archive.id!==archive.id)throw Error('The revocation response changed archive scope. Refresh its status.');
  if(mounted.current){replace(result.archive);setReview(null);setConsent(false);setNotice('Archive approval revoked. Existing bytes are retained; no deletion was requested.');}
 }
 const locked=loading||busy,binding=listing?.binding;
 return <section className={s.panel} aria-label="Project file archives" aria-busy={locked}>
  <header className={s.header}><div><span className="eyebrow">GENERATION → PROJECT FILE</span><h3><Archive size={19}/>Save work your team can use</h3><p>Choose a destination, approve the transfer, then verify the stored file.</p></div><button className="icon-button" aria-label="Close project file archives" disabled={busy} onClick={onClose}><X size={18}/></button></header>
  {error&&<p className="error-message" role="alert">{error}</p>}{notice&&<p className={s.notice} role="status">{notice}</p>}
  {page&&<p className={s.notice}>{page.processing.message}</p>}
  {project?.project.contractVersion===2&&<p className={s.notice}>This project requires {project.project.spec.kind} in {project.project.spec.format.toUpperCase()} format. Archiving preserves the original output; registering it and completing independent media review are separate steps.</p>}
  <div className={s.actions}><button className="button secondary small" disabled={locked} onClick={()=>void refresh(parentId)}><RefreshCw size={14}/>Refresh archives</button></div>
  {loading&&!page&&<Loading label="Loading archive destinations"/>}
  {selection&&listing&&<form className={s.form} onSubmit={event=>{event.preventDefault();void act(propose);}}>
   <h4>Save this {selection.kind} output</h4><p>Source output <code>{selection.outputId}</code>. Saving uses the original output; it does not generate it again.</p>
   {!binding?<p className={s.notice}>Open this project’s Files tab to connect storage before preparing an archive.</p>:<>
    <p><strong>{binding.connection.name}</strong> · {binding.connection.region} · Volume {binding.connection.volumeId}</p>
    {binding.connection.status==='revoked'&&<p role="status">This storage connection is revoked. Choose a working connection in Project files.</p>}
    <nav className={s.breadcrumbs} aria-label="Archive destination"><button type="button" disabled={locked} onClick={()=>void refresh(null)}><FolderOpen size={15}/>Project files</button>{listing.breadcrumbs.map(item=><span key={item.id}><ChevronRight size={13}/><button type="button" disabled={locked} onClick={()=>void refresh(item.id)}>{item.name}</button></span>)}</nav>
    <div className={s.folders}>{listing.items.filter(item=>item.kind==='folder').map(item=><button type="button" className="button secondary small" disabled={locked} key={item.id} onClick={()=>void refresh(item.id)}><FolderOpen size={15}/>{item.name}<ChevronRight size={13}/></button>)}{!listing.items.some(item=>item.kind==='folder')&&<p>No subfolders in the loaded items. The current folder can be used.</p>}</div>
    {listing.page.hasMore&&<button type="button" className="button secondary small" disabled={locked} onClick={()=>void act(async()=>{const next=await api<ProjectStorageListing>(`${projectBase}/files?${new URLSearchParams({limit:'50',after:listing.page.nextAfter!,...(parentId?{parentId}:{})})}`);if(next.binding?.revision!==binding.revision)throw Error('The project library changed. Refresh before choosing a destination.');if(mounted.current)setListing({...next,items:[...listing.items,...next.items.filter(item=>!listing.items.some(old=>old.id===item.id))]});})}>Load more destination items</button>}
    <Field label="Save as"><select disabled={locked} value={fileId} onChange={event=>{setFileId(event.target.value);const file=listing.items.find(item=>item.id===event.target.value);setName(file?.name??`output-${selection.outputId.slice(0,8)}`);}}><option value="">New file in this folder</option>{listing.items.filter(item=>item.kind==='file').map(item=><option key={item.id} value={item.id}>New version of {item.name}</option>)}</select></Field>
    <div className={s.columns}><Field label="File name" hint="An extension is optional. If supplied, it must match the detected media format."><input required maxLength={160} value={name} disabled={locked||!!fileId} onChange={event=>setName(event.target.value)}/></Field><Field label="Maximum source size" hint="This is your approval ceiling. Worker format, duration and size limits can be lower."><select disabled={locked} value={maxBytes} onChange={event=>setMaxBytes(Number(event.target.value))}>{[256*1024**2,1024**3,10*1024**3,100*1024**3].map(value=><option value={value} key={value}>{size(value)}</option>)}</select></Field></div>
    <button className="button primary small" disabled={locked||projectRevision===null||!name.trim()||binding.connection.status!=='configured'}>Prepare archive destination</button>
   </>}
  </form>}
  {review&&<div className={s.review} role="region" aria-label="Review archive approval">
   <div className={s.header}><h4>Review this exact archive</h4><Badge>{labels[review.status]}</Badge></div>
   <dl className={s.facts}><div><dt>Destination</dt><dd>{destination(review)}</dd></div><div><dt>Size limit</dt><dd>{size(review.maxBytes)}</dd></div><div><dt>Source</dt><dd>{review.kind} · {review.outputId}</dd></div><div><dt>Version</dt><dd>{review.destination.fileId?'Create a new version of the chosen file':'Create a new file'}</dd></div></dl>
   <details><summary>Approval identifiers</summary><p>Job: {review.jobId}<br/>Storage connection: {review.storageConnectionId}<br/>Proposal fingerprint: {review.requestHash}</p></details>
   <p>The worker verifies format, content checksum and the stored bytes. Technical QC, production-task approval and client acceptance are separate decisions.</p>
   {review.status==='proposed'&&(isAdmin?<><Field label="Approval expires after"><select disabled={locked} value={hours} onChange={event=>{setHours(Number(event.target.value));setConsent(false);}}>{[1,2,6,24].map(value=><option key={value} value={value}>{value} {value===1?'hour':'hours'}</option>)}</select></Field><label className={s.check}><input type="checkbox" checked={consent} disabled={locked||!page?.processing.enabled} onChange={event=>setConsent(event.target.checked)}/>I approve copying this output to the exact destination above, within the size limit and expiry shown.</label><button className="button primary small" disabled={locked||!consent||!page?.processing.enabled||!reviewBinding||reviewBinding.id!==review.bindingId} onClick={()=>void act(approve)}>Approve archive transfer</button></>:<p>An administrator can approve this proposal. You can prepare destinations and follow their progress.</p>)}
  </div>}
  <div className={s.history}><h4>Archive history</h4>{page&&!page.archives.length&&<p>No archive proposals yet. Choose a completed generation output to prepare one.</p>}
   {page?.archives.map(archive=><article className={s.card} key={archive.id} aria-label={`Archive ${archive.destination.name}`}>
    <div className={s.header}><strong>{archive.destination.name}</strong><Badge tone={archive.bytesVerified?'good':['uncertain','blocked','failed'].includes(archive.status)?'warning':''}>{archive.status==='verified'&&!archive.bytesVerified?'Stored verification unavailable':labels[archive.status]}</Badge></div>
    <p>{destination(archive)}</p><p>Prepared {when(archive.createdAt)} · Limit {size(archive.maxBytes)}{archive.expiresAt&&` · Approval expires ${new Date(archive.expiresAt).toLocaleString()}`}</p>
    {archive.bytesVerified?<p className={s.verified}><ShieldCheck size={16}/>Stored bytes verified. Open Project files for this version. Media QC and client acceptance remain separate.</p>:archive.fetched?<p>{size(archive.fetched.bytes)} source bytes checked. The stored version is not yet verified.</p>:<p>No verified stored bytes yet.</p>}
    {archive.diagnosticCode&&<p>Diagnostic: <code>{archive.diagnosticCode}</code>. Inspect this attempt before preparing another; no automatic generation retry is performed.</p>}
    <div className={s.actions}><button className="button secondary small" disabled={locked} onClick={()=>void act(()=>inspect(archive))}>{archive.status==='proposed'?'Review archive':'View archive details'}</button>{isAdmin&&!['verified','cancelled'].includes(archive.status)&&<button className="button secondary small" disabled={locked} onClick={()=>void act(()=>revoke(archive))}>Revoke archive approval</button>}</div>
   </article>)}
   {page?.hasMore&&page.nextAfter&&<button className="button secondary small" disabled={locked} onClick={()=>void refresh(parentId,page.nextAfter!)}>Load more archives</button>}
  </div>
 </section>;
}
