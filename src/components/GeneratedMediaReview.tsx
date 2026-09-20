'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Check,Download,ExternalLink,FileCheck2,Image as ImageIcon,Music2,Package,Plus,RefreshCw,ShieldCheck,Video,X} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import type {StudioDelivery,StudioGeneratedArtifact,StudioGeneratedProjectDetail} from '@/lib/studio-protocol';
import type {HiggsfieldArchive,HiggsfieldArchivePage} from '@/lib/higgsfield-archive-protocol';
import type {HiggsfieldRequest} from '@/lib/higgsfield-protocol';
import type {ProjectStorageListing} from '@/lib/project-storage-protocol';
import {api,when} from '@/lib/client';
import {canStreamStorageDownload,chooseStorageDownloadTarget,STORAGE_BROWSER_BLOB_LIMIT,type StorageDownloadAccess,type StorageSaveTarget} from '@/lib/project-storage-client';
import {downloadGeneratedMedia} from '@/lib/generated-media-download';
import {assertGeneratedDownload,generatedArchiveReason,generatedBytes,generatedLimitationText,generatedManifestPath,generatedPackageSelection,generatedProjectPath,generatedRegistrationReason,generatedReviewerReason,generatedTechnicalMatch,generatedVersionAccessPath} from '@/lib/generated-media-ui';
import {Badge,Field,Loading,Modal} from './ui';
import {useStudioMutation} from './studio-hooks';
import {StudioClientDeliveries} from './StudioClientDeliveries';
import s from './GeneratedMediaReview.module.css';

type Props={p:WorkspaceProps;detail:StudioGeneratedProjectDetail;onReload:()=>void|Promise<void>};
type EditorProps={p:WorkspaceProps;detail:StudioGeneratedProjectDetail;workItemId:string;onClose:()=>void;onSaved:()=>void|Promise<void>};
type Candidate={archive:HiggsfieldArchive;request:HiggsfieldRequest|null;error?:string};
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'This request could not be completed.';
const humanize=(value:string)=>value.replaceAll('_',' ');
const identity=(p:WorkspaceProps,detail:StudioGeneratedProjectDetail)=>`${p.user.id}:${p.company.id}:${p.company.role}:${detail.project.id}`;
const person=(p:WorkspaceProps,value:unknown)=>typeof value==='string'?p.workspace.members.find(member=>member.userId===value)?.name??value:'Not recorded';
function Notice({children}:{children:React.ReactNode}){return <p className={s.notice}><ShieldCheck size={17}/><span>{children}</span></p>;}
function FrozenAttempt({error}:{error:string}){return error?<><p className="error-message" role="alert">{error}</p><p className={s.muted}>A response was not confirmed. Retry sends the same reviewed details and request ID. To change them, close this dialog, refresh the project and check whether the action was already recorded.</p></>:null;}
function saveBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);}
function packageDownload(delivery:StudioDelivery){saveBlob(new Blob([JSON.stringify(delivery.manifest,null,2)+'\n'],{type:'application/json'}),`coatria-package-${delivery.id}.json`);}

/** Key by account/company/project so dialogs, reads and transfers never cross identities. */
export function GeneratedMediaReview(props:Props){return <ReviewWorkspace key={identity(props.p,props.detail)} {...props}/>;}
function ReviewWorkspace({p,detail,onReload}:Props){
 const [register,setRegister]=useState(false),[review,setReview]=useState<StudioGeneratedArtifact|null>(null),[packaging,setPackaging]=useState(false);
 const admin=['owner','admin'].includes(p.company.role),registrationBlock=generatedRegistrationReason(detail,p.company.role),selection=generatedPackageSelection(detail);
 const clientBlock=detail.project.status==='delivered'?'This project has an authenticated client acknowledgement. Existing invitations and receipts remain below.':!detail.deliveries.some(delivery=>delivery.status==='prepared')?'Prepare an approved internal package first.':!detail.workItems.some(work=>work.stage==='delivery')||detail.workItems.some(work=>work.status!=='done')?'Accept every production, QC and delivery-handoff task before inviting the client.':detail.project.gates.production?.decision!=='approved'?'Production approval is required before client access.':null;
 const afterSaved=async()=>{setRegister(false);setReview(null);setPackaging(false);await onReload();};
 return <div className={s.workspace}>
  <header className={s.heading}><div><span className={s.eyebrow}>GENERATED MEDIA · VERIFIED VERSIONS</span><h2>From archived output to reviewed final.</h2><p>Inspect the actual media, record an independent decision, then prepare an internal package.</p></div>{admin&&<button className="button secondary" disabled={!!registrationBlock} title={registrationBlock??undefined} onClick={()=>setRegister(true)}><Plus size={15}/> Register verified output</button>}</header>
  {admin&&registrationBlock&&<p className={s.muted}>{registrationBlock}</p>}
  <div className={s.layout}><section className={s.stack} aria-label="Registered generated outputs">
   {!detail.artifacts.length?<div className={s.empty}><FileCheck2 size={25}/><h3>No verified output registered yet</h3><p>Use the generation panel to archive a completed provider output into project storage. Once the archive is verified, register it against its exact generation task here.</p></div>:detail.artifacts.map(artifact=><article key={artifact.id} className={s.card}>
    <header className={s.cardHeader}><div className={s.mediaTitle}><span className={s.mediaIcon}>{artifact.mediaKind==='image'?<ImageIcon size={21}/>:artifact.mediaKind==='video'?<Video size={21}/>:<Music2 size={21}/>}</span><div><h3>{artifact.name}</h3><p>Version {artifact.version} · {detail.workItems.find(work=>work.id===artifact.workItemId)?.title??'Generation task'}</p></div></div><Badge tone={artifact.reviewStatus==='changes_requested'?'warning':''}>{humanize(artifact.reviewStatus)}</Badge></header>
    <MediaFacts artifact={artifact}/>
    {artifact.notes&&<p className={s.prose}>{artifact.notes}</p>}
    <p className={s.verified}><ShieldCheck size={14}/> Archived bytes verified · full media decode recorded</p>
    {!!artifact.limitations.length&&<ul className={s.limitations}>{artifact.limitations.map(code=><li key={code}>{generatedLimitationText[code]}</li>)}</ul>}
    <Provenance p={p} artifact={artifact}/>
    <div className={s.actions}><ArtifactFiles p={p} detail={detail} artifact={artifact}/>{!generatedReviewerReason(detail,artifact,p.user.id,p.company.role)&&<button className="button secondary small" onClick={()=>setReview(artifact)}>Review version <Check size={14}/></button>}</div>
    {generatedReviewerReason(detail,artifact,p.user.id,p.company.role)&&<p className={s.small}>{generatedReviewerReason(detail,artifact,p.user.id,p.company.role)}</p>}
   </article>)}
   {!!detail.reviews.length&&<section className={s.card}><h3>Independent review history</h3><ol className={s.history}>{detail.reviews.map(item=><li key={item.id}><strong>{humanize(item.decision)} · {detail.artifacts.find(artifact=>artifact.id===item.artifactId)?.name??'Registered output'}</strong><small>{person(p,item.reviewedBy)} · {when(item.createdAt)} · {item.technicalQc?'Technical QC attested':'Technical QC not attested'}</small><p>{item.note}</p><details className={s.details}><summary>Exact review evidence</summary><dl className={s.identifiers}><dt>Artifact</dt><dd>{item.artifactId}</dd><dt>Specification SHA-256</dt><dd>{item.specSha256}</dd><dt>Manifest SHA-256</dt><dd>{item.manifestSha256}</dd><dt>Attestation</dt><dd>Version {item.attestationVersion} · {item.technicalMatch.matches?'Technical requirements matched':'Technical requirements not matched'}</dd></dl>{item.technicalMatch.issues.map((issue,index)=><p key={`${issue.code}:${index}`} className={s.small}>{humanize(issue.code)} · {issue.path}</p>)}</details></li>)}</ol></section>}
  </section><aside className={s.stack}><section className={s.card}><span className={s.eyebrow}>INTERNAL HANDOFF</span><h3>Package the approved finals</h3><p className={s.muted}>The package pins the exact media, specification and independent review receipts. It does not transfer files or record client acceptance.</p>{admin&&<button className="button primary" onClick={()=>setPackaging(true)} disabled={!!selection.reason}><Package size={16}/> Prepare internal package</button>}{selection.reason&&<p className={s.small}>{selection.reason}</p>}
   {detail.deliveries.map(delivery=><article className={s.package} key={delivery.id}><header><h4>{delivery.name}</h4><Badge>Not transferred</Badge></header><p>{delivery.note}</p><small>Prepared {when(delivery.createdAt)}</small><button className="button secondary small" onClick={()=>packageDownload(delivery)}><Download size={14}/> Download package JSON</button><p className={s.small}>This internal manifest preserves its preparation state. Client invitations, access and responses are recorded separately below.</p></article>)}
  </section><Notice>Verification establishes archived file facts. Creative quality, rights, reference fidelity and any audio synchronization require human review. Registration and packaging do not complete production or QC tasks.</Notice></aside></div>
  <StudioClientDeliveries companyId={p.company.id} projectId={detail.project.id} projectRevision={detail.project.revision} deliveries={detail.deliveries} admin={admin} creationBlocked={clientBlock} onChanged={onReload}/>
  {register&&<GeneratedArtifactEditor p={p} detail={detail} workItemId="" onClose={()=>setRegister(false)} onSaved={afterSaved}/>}
  {review&&<GeneratedReviewEditor p={p} detail={detail} artifact={review} onClose={()=>setReview(null)} onSaved={afterSaved}/>}
  {packaging&&<GeneratedPackageEditor p={p} detail={detail} onClose={()=>setPackaging(false)} onSaved={afterSaved}/>}
 </div>;
}

function MediaFacts({artifact}:{artifact:StudioGeneratedArtifact}){
 const media=artifact.media;
 return <dl className={s.facts}>
  <div><dt>File</dt><dd>{media.format.toUpperCase()} · {generatedBytes(artifact.file.bytes)}<small>{artifact.file.contentType}</small></dd></div>
  <div><dt>Codec</dt><dd>{media.codec}</dd></div>
  {media.kind!=='audio'&&<div><dt>Dimensions</dt><dd>{media.width} × {media.height}</dd></div>}
  {media.kind!=='image'&&<div><dt>Duration</dt><dd>{(media.durationMs/1000).toLocaleString(undefined,{maximumFractionDigits:3})} seconds</dd></div>}
  {media.kind==='video'&&<><div><dt>Frame cadence</dt><dd>{media.frameRate?`${media.frameRate.numerator}/${media.frameRate.denominator} fps`:'Unknown'}<small>{media.vfr===null?'Variable-frame-rate status unknown':media.vfr?'Variable frame rate':'Constant frame rate'} · {media.frameCount} decoded frames</small><small>Container average: {media.averageFrameRate?`${media.averageFrameRate.numerator}/${media.averageFrameRate.denominator} fps`:'unknown'}</small></dd></div><div><dt>Embedded audio</dt><dd>{media.audio?`${media.audio.codec} · ${media.audio.sampleRateHz} Hz · ${media.audio.channels} channels`:'None detected'}</dd></div></>}
  {media.kind==='audio'&&<><div><dt>Audio</dt><dd>{media.sampleRateHz} Hz · {media.channels} channels</dd></div><div><dt>Decoded samples</dt><dd>{media.decodedSamples.toLocaleString()}</dd></div></>}
  {media.kind!=='audio'&&<div className={s.wideFact}><dt>Observed color metadata</dt><dd>Space: {media.color.space??'unknown'} · Primaries: {media.color.primaries??'unknown'} · Transfer: {media.color.transfer??'unknown'} · Range: {media.color.range??'unknown'}</dd></div>}
 </dl>;
}
function Provenance({p,artifact}:{p:WorkspaceProps;artifact:StudioGeneratedArtifact}){
 return <details className={s.details}><summary>Provenance & immutable identifiers</summary><dl className={s.identifiers}>
  <dt>File SHA-256</dt><dd>{artifact.file.sha256}</dd><dt>Specification SHA-256</dt><dd>{artifact.specSha256}</dd><dt>Artifact manifest SHA-256</dt><dd>{artifact.manifestSha256}</dd>
  <dt>Storage version</dt><dd>{artifact.provenance.storageVersionId}</dd><dt>Archive</dt><dd>{artifact.provenance.archiveId}</dd><dt>Generation request</dt><dd>{artifact.provenance.requestId}</dd><dt>Tracked job / output</dt><dd>{artifact.provenance.jobId} / {artifact.provenance.outputId}</dd>
  <dt>Original producer</dt><dd>{person(p,artifact.producedBy)}{artifact.producedAgentId&&<> · Agent {artifact.producedAgentId}</>}</dd><dt>Agent sponsor</dt><dd>{person(p,artifact.source.agentSponsorId)}</dd><dt>Provider sponsor</dt><dd>{person(p,artifact.source.providerSponsorId)}</dd>
  <dt>Archive approved by</dt><dd>{person(p,artifact.provenance.archiveApprovedBy)}</dd><dt>Registered by</dt><dd>{person(p,artifact.provenance.registeredBy)}{artifact.provenance.registeredAgentId&&<> · Agent {artifact.provenance.registeredAgentId}</>}</dd><dt>Registered</dt><dd>{when(artifact.createdAt)}</dd>
 </dl><p className={s.small}>The file checksum identifies media bytes. The specification and manifest checksums identify separate documents. A provider locator identity is not a file checksum.</p></details>;
}
function ApprovedTarget({detail,workItemId}:{detail:StudioGeneratedProjectDetail;workItemId:string}){
 const spec=detail.project.spec,work=detail.workItems.find(item=>item.id===workItemId),unit=detail.shots.find(item=>item.id===work?.shotId);
 return <details className={s.details} open><summary>Approved target{unit?` · ${unit.code}`:''}</summary><p className={s.small}>{spec.format.toUpperCase()}{spec.kind!=='audio'?` · ${spec.width} × ${spec.height} pixels`:''}{spec.kind==='video'?` · ${spec.codec} · ${spec.frameRate.numerator}/${spec.frameRate.denominator} fps (constant)`:''}{spec.kind==='audio'?` · ${spec.codec} · ${spec.sampleRateHz} Hz · ${spec.channels} channels`:''}{unit&&unit.kind!=='image'?` · Duration ${unit.durationMs.min}–${unit.durationMs.max} ms`:''}</p>{spec.kind!=='audio'&&<p className={s.small}>Color: {spec.color.mode==='not_required'?'Exact color metadata is not required.':`${spec.color.space} · ${spec.color.primaries} · ${spec.color.transfer} · ${spec.color.range}`}</p>}{spec.kind==='video'&&<p className={s.small}>Audio: {spec.audio.mode==='none'?'No embedded audio.':`${spec.audio.codec} · ${spec.audio.sampleRateHz} Hz · ${spec.audio.channels} channels`}</p>}</details>;
}

function ArtifactFiles({p,detail,artifact}:{p:WorkspaceProps;detail:StudioGeneratedProjectDetail;artifact:StudioGeneratedArtifact}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState('');
 const alive=useRef(true),active=useRef<AbortController|null>(null),pending=useRef(false);
 useEffect(()=>{alive.current=true;const abort=()=>active.current?.abort();window.addEventListener('coatria:session-changed',abort);return()=>{alive.current=false;abort();window.removeEventListener('coatria:session-changed',abort);};},[]);
 function download(){
  if(pending.current)return;
  if(!canStreamStorageDownload()&&artifact.file.bytes>STORAGE_BROWSER_BLOB_LIMIT){setError('This browser cannot stream this large file to disk. Use a browser with a file save picker or the authenticated storage API.');return;}
  pending.current=true;setBusy(true);setError('');setProgress('Requesting this exact file version…');
  const controller=new AbortController();active.current=controller;
  // The native picker must be opened in this click event, before any network await.
  const destination=chooseStorageDownloadTarget(`${artifact.name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')}.${artifact.media.format==='jpeg'?'jpg':artifact.media.format}`);
  void(async()=>{
   let target:StorageSaveTarget|null=null;const timeout=setTimeout(()=>controller.abort(),15*60_000);
   try{
    target=await destination;controller.signal.throwIfAborted();
    const listing=await api<ProjectStorageListing>(generatedProjectPath(p.company.id,detail.project.id)+'/files?limit=1','GET',undefined,{signal:controller.signal});controller.signal.throwIfAborted();
    if(!listing.transfers.available)throw Error(listing.transfers.message);
    const {access}=await api<{access:StorageDownloadAccess}>(generatedVersionAccessPath(p.company.id,detail.project.id,artifact.provenance.storageVersionId),'POST',{clientId:crypto.randomUUID(),disposition:'attachment'},{signal:controller.signal});controller.signal.throwIfAborted();
    assertGeneratedDownload(access,artifact,listing.transfers.gatewayOrigin);
    const result=await downloadGeneratedMedia(access,artifact,target,{gatewayOrigin:listing.transfers.gatewayOrigin,signal:controller.signal,onProgress:bytes=>{if(alive.current)setProgress(`${generatedBytes(bytes)} of ${generatedBytes(artifact.file.bytes)}`);}});controller.signal.throwIfAborted();
    if(alive.current){if(result.blob)saveBlob(result.blob,access.name);setProgress('Saved this exact archived file version. Download checksum verified.');}
   }catch(error){await target?.abort(error).catch(()=>{});if(alive.current){setProgress('');setError(controller.signal.aborted?'Download cancelled. The registered file version is unchanged.':errorMessage(error));}}
   finally{clearTimeout(timeout);if(active.current===controller)active.current=null;pending.current=false;if(alive.current)setBusy(false);}
  })();
 }
 return <div className={s.fileActions}><div className={s.actions}><button type="button" className="button secondary small" onClick={download} disabled={busy}><Download size={14}/>{busy?'Downloading…':'Download exact media'}</button><a className="button secondary small" href={generatedManifestPath(p.company.id,detail.project.id,artifact.id)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/> View manifest</a>{busy&&<button type="button" className="button secondary small" onClick={()=>active.current?.abort()}><X size={14}/> Cancel download</button>}</div>{progress&&<p className={s.small} role="status">{progress}</p>}{error&&<p className="error-message" role="alert">{error}</p>}</div>;
}

export function GeneratedArtifactEditor(props:EditorProps){return <Registration key={`${identity(props.p,props.detail)}:${props.workItemId}`} {...props}/>;}
function Registration({p,detail,workItemId,onClose,onSaved}:EditorProps){
 const [revision]=useState(detail.project.revision),[rows,setRows]=useState<Candidate[]>([]),[after,setAfter]=useState<string|null>(null),[loading,setLoading]=useState(true),[readError,setReadError]=useState('');
 const [archiveId,setArchiveId]=useState(''),[name,setName]=useState(''),[notes,setNotes]=useState(''),[attempt,setAttempt]=useState<Record<string,unknown>|null>(null);
 const mutation=useStudioMutation(),alive=useRef(true),sequence=useRef(0),read=useRef<AbortController|null>(null);
 const base=`/api/companies/${p.company.id}/higgsfield`,projectId=detail.project.id;
 const load=useCallback(async(cursor?:string)=>{
  read.current?.abort();const controller=new AbortController(),ticket=++sequence.current;read.current=controller;setLoading(true);setReadError('');const timer=setTimeout(()=>controller.abort(),30_000);
  try{
   const query=new URLSearchParams({projectId,limit:'20',...(cursor?{after:cursor}:{})});
   const page=await api<HiggsfieldArchivePage>(`${base}/archives?${query}`,'GET',undefined,{signal:controller.signal});controller.signal.throwIfAborted();
   const verified=page.archives.filter(archive=>archive.projectId===projectId&&archive.status==='verified'&&archive.bytesVerified&&!archive.revokedAt&&archive.versionId);
   const requests=new Map<string,HiggsfieldRequest|null>(),errors=new Map<string,string>(),ids=[...new Set(verified.map(archive=>archive.requestId))];
   // Bounded parallel reads, one exact lookup per request in this page. No provider calls.
   let index=0;
   await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{while(index<ids.length){const requestId=ids[index++];controller.signal.throwIfAborted();try{const result=await api<{request:HiggsfieldRequest}>(`${base}/requests?${new URLSearchParams({projectId,requestId})}`,'GET',undefined,{signal:controller.signal});requests.set(requestId,result.request);}catch(error){controller.signal.throwIfAborted();requests.set(requestId,null);errors.set(requestId,errorMessage(error));}}}));
   controller.signal.throwIfAborted();
   if(alive.current&&ticket===sequence.current){const incoming=verified.map(archive=>({archive,request:requests.get(archive.requestId)??null,error:errors.get(archive.requestId)}));setRows(current=>cursor?[...current,...incoming.filter(row=>!current.some(old=>old.archive.id===row.archive.id))]:incoming);setAfter(page.hasMore?page.nextAfter:null);if(!cursor)setArchiveId('');}
  }catch(error){if(alive.current&&ticket===sequence.current)setReadError(errorMessage(error));}
  finally{clearTimeout(timer);if(read.current===controller)read.current=null;if(alive.current&&ticket===sequence.current)setLoading(false);}
 },[base,projectId]);
 useEffect(()=>{alive.current=true;void load();const abort=()=>read.current?.abort();window.addEventListener('coatria:session-changed',abort);return()=>{alive.current=false;sequence.current++;abort();window.removeEventListener('coatria:session-changed',abort);};},[load]);
 const selected=rows.find(row=>row.archive.id===archiveId),selectedWork=detail.workItems.find(work=>work.id===selected?.request?.workItemId);
 const blocker=generatedRegistrationReason(detail,p.company.role),associationBlock=selected?generatedArchiveReason(detail,selected.archive,selected.request,workItemId):'Choose a verified archive.';
 return <Modal title="Register verified generated output" description="Choose a verified archive. Coatria loads the media facts and provenance from its immutable source records." onClose={()=>{if(!mutation.busy)onClose();}} wide>
  <form className="form" onSubmit={event=>{event.preventDefault();if(!attempt&&(blocker||associationBlock||!selected||!selectedWork||!name.trim()||detail.project.revision!==revision))return;const body=attempt??{revision,workItemId:selectedWork!.id,archiveId:selected!.archive.id,name:name.trim(),notes:notes.trim()};setAttempt(body);void mutation.mutate(generatedProjectPath(p.company.id,projectId)+'/generated-artifacts',body,onSaved);}}>
   <fieldset disabled={mutation.busy||!!attempt}>
    {blocker&&<p className={s.notice}>{blocker}</p>}
    <div className={s.pickerHeading}><div><h3>Verified project archives</h3><p className={s.small}>{workItemId?`For ${detail.workItems.find(work=>work.id===workItemId)?.title??'the selected generation task'}`:'Each archive is checked against its exact generation request.'}</p></div><button type="button" className="button secondary small" disabled={loading} onClick={()=>void load()}><RefreshCw size={14}/> Refresh archives</button></div>
    {loading&&!rows.length&&<Loading label="Checking verified archives"/>}
    {readError&&<p className="error-message" role="alert">{readError}</p>}
    <div className={s.archiveList} role="radiogroup" aria-label="Verified archive">
     {rows.map(row=>{const reason=generatedArchiveReason(detail,row.archive,row.request,workItemId),work=detail.workItems.find(item=>item.id===row.request?.workItemId);return <label key={row.archive.id} className={s.archive} data-disabled={!!reason}><input type="radio" name="verifiedArchive" value={row.archive.id} disabled={!!reason} checked={archiveId===row.archive.id} onChange={()=>{setArchiveId(row.archive.id);setName(row.archive.destination.name);}}/><span><strong>{row.archive.destination.name}</strong><small>{row.archive.kind} · {row.archive.fetched?generatedBytes(row.archive.fetched.bytes):'File facts unavailable'} · {work?.title??'Generation association unavailable'}</small>{reason&&<small>{row.error?'Could not load the exact request. Refresh archives to check access again.':reason}</small>}<small className={s.identifier}>Archive {row.archive.id}</small></span></label>;})}
    </div>
    {!loading&&!rows.length&&!readError&&<p className={s.empty}>No verified archives on this page. Archive a completed generation in the generation panel, then refresh here.{after?' More archive pages are available below.':''}</p>}
    {after&&<button type="button" className="button secondary small" disabled={loading} onClick={()=>void load(after)}>{loading?'Checking archives…':'Load more archives'}</button>}
    {selected&&!associationBlock&&<div className={s.selected}><strong>Linked generation task: {selectedWork?.title}</strong><p>Request {selected.archive.requestId}</p><p>Immutable storage version {selected.archive.versionId}</p><p>Archived file SHA-256 {selected.archive.fetched?.sha256}</p><small>The server checks the current source, role, storage access and technical specification before registration.</small></div>}
    <Field label="Output name"><input required maxLength={160} value={name} onChange={event=>setName(event.target.value)}/></Field>
    <Field label="Registration notes" hint="Describe this output and what the independent reviewer should inspect."><textarea rows={3} maxLength={4000} value={notes} onChange={event=>setNotes(event.target.value)}/></Field>
    <Notice>Registering records a version. It does not approve media, accept the generation task or complete QC. The registrar must be different from the administrator reviewing this version.</Notice>
   </fieldset>
   {detail.project.revision!==revision&&!attempt&&<p className={s.notice}>The project changed while this dialog was open. Close it and reopen to review the current project revision.</p>}
   <FrozenAttempt error={mutation.error}/>
   <button className="button primary" disabled={mutation.busy||!attempt&&(loading||!!blocker||!!associationBlock||!name.trim()||detail.project.revision!==revision)}><FileCheck2 size={15}/>{mutation.busy?'Registering…':attempt?'Retry exact registration':'Register verified output'}</button>
  </form>
 </Modal>;
}

function GeneratedReviewEditor({p,detail,artifact,onClose,onSaved}:{p:WorkspaceProps;detail:StudioGeneratedProjectDetail;artifact:StudioGeneratedArtifact;onClose:()=>void;onSaved:()=>void|Promise<void>}){
 const [revision]=useState(detail.project.revision),[decision,setDecision]=useState<'approved'|'changes_requested'>('approved'),[note,setNote]=useState(''),[qc,setQc]=useState(false),[attempt,setAttempt]=useState<Record<string,unknown>|null>(null),[attemptView,setAttemptView]=useState<StudioGeneratedProjectDetail|null>(null);
 const view=attemptView??detail,mutation=useStudioMutation(),reason=generatedReviewerReason(detail,artifact,p.user.id,p.company.role),match=generatedTechnicalMatch(view,artifact);
 const approvalBlock=!match.matches?'This media does not match the current technical specification. Request changes instead.':detail.project.aiPolicy!=='allowed'||detail.project.gates.production?.decision!=='approved'?'Production approval and the client AI-use policy must be current before approval.':null;
 return <Modal title={`Review ${artifact.name}`} description={`Version ${artifact.version} · independently inspect the exact archived media before deciding.`} onClose={()=>{if(!mutation.busy)onClose();}} wide><form className="form" onSubmit={event=>{event.preventDefault();if(!attempt&&(reason||!note.trim()||detail.project.revision!==revision||decision==='approved'&&(!qc||approvalBlock)))return;const body=attempt??{revision,artifactId:artifact.id,decision,note:note.trim(),technicalQc:qc};if(!attempt)setAttemptView(structuredClone(detail));setAttempt(body);void mutation.mutate(generatedProjectPath(p.company.id,detail.project.id)+'/reviews',body,onSaved);}}>
  <ArtifactFiles p={p} detail={detail} artifact={artifact}/><ApprovedTarget detail={view} workItemId={artifact.workItemId}/><MediaFacts artifact={artifact}/>
  <fieldset disabled={mutation.busy||!!attempt}>{reason&&<p className={s.notice}>{reason}</p>}<Field label="Review decision"><select value={decision} onChange={event=>setDecision(event.target.value as typeof decision)}><option value="approved">Approve this exact version</option><option value="changes_requested">Request changes</option></select></Field>
   {decision==='approved'&&approvalBlock&&<p className={s.notice}>{approvalBlock}</p>}
   {!match.matches&&<ul className={s.limitations}>{match.issues.map((issue,index)=><li key={`${issue.code}:${index}`}>{humanize(issue.code)} · {issue.path}</li>)}</ul>}
   <Field label="Findings & evidence"><textarea required maxLength={4000} rows={5} value={note} onChange={event=>setNote(event.target.value)} placeholder="Record what you inspected, creative findings, rights/reference checks, technical findings and any corrections needed."/></Field>
   <label className={s.checkbox}><input type="checkbox" required={decision==='approved'} checked={qc} onChange={event=>setQc(event.target.checked)}/><span>I independently inspected the actual {artifact.mediaKind} file and checked its approved specification, content and technical integrity{artifact.mediaKind==='video'?', including timing and any audio synchronization':''}.</span></label>
   <Notice>Only a human company administrator who did not produce, sponsor or register this version can review it. The server checks independence, the latest version, current storage access and exact technical evidence. Task acceptance remains a separate action.</Notice>
  </fieldset><FrozenAttempt error={mutation.error}/>
  {detail.project.revision!==revision&&!attempt&&<p className={s.notice}>The project changed. Close and reopen this review to use its current revision.</p>}
  <button className="button primary" disabled={mutation.busy||!attempt&&(!!reason||!note.trim()||detail.project.revision!==revision||decision==='approved'&&(!qc||!!approvalBlock))}><Check size={15}/>{mutation.busy?'Recording review…':attempt?'Retry exact review':'Record review decision'}</button>
 </form></Modal>;
}
function GeneratedPackageEditor({p,detail,onClose,onSaved}:{p:WorkspaceProps;detail:StudioGeneratedProjectDetail;onClose:()=>void;onSaved:()=>void|Promise<void>}){
 const [revision]=useState(detail.project.revision),[name,setName]=useState(`${detail.project.name} · approved finals`.slice(0,160)),[note,setNote]=useState(''),[confirm,setConfirm]=useState(false),[attempt,setAttempt]=useState<Record<string,unknown>|null>(null),[attemptView,setAttemptView]=useState<StudioGeneratedProjectDetail|null>(null);
 const view=attemptView??detail,selection=generatedPackageSelection(view),mutation=useStudioMutation();
 return <Modal title="Prepare an internal media package" description="Include the exact latest approved final for every deliverable. No media is transferred." onClose={()=>{if(!mutation.busy)onClose();}} wide><form className="form" onSubmit={event=>{event.preventDefault();if(!attempt&&(selection.reason||!confirm||!name.trim()||!note.trim()||detail.project.revision!==revision))return;const body=attempt??{revision,name:name.trim(),artifactIds:selection.artifacts.map(artifact=>artifact.id),note:note.trim()};if(!attempt)setAttemptView(structuredClone(detail));setAttempt(body);void mutation.mutate(generatedProjectPath(p.company.id,detail.project.id)+'/deliveries',body,onSaved);}}>
  <fieldset disabled={mutation.busy||!!attempt}><Field label="Package name"><input required maxLength={160} value={name} onChange={event=>setName(event.target.value)}/></Field><h3>Exact approved finals</h3>{selection.reason&&<p className={s.notice}>{selection.reason}</p>}<ul className={s.finalList}>{selection.artifacts.map(artifact=><li key={artifact.id}><strong>{artifact.name} · v{artifact.version}</strong><small>{view.workItems.find(work=>work.id===artifact.workItemId)?.title} · {artifact.mediaKind}</small><code>File SHA-256 {artifact.file.sha256}</code><code>Storage version {artifact.provenance.storageVersionId}</code></li>)}</ul>
   <Field label="Internal handoff notes"><textarea required maxLength={4000} rows={4} value={note} onChange={event=>setNote(event.target.value)} placeholder="Describe the approved content, remaining delivery arrangements and the person responsible for the handoff."/></Field>
   <label className={s.checkbox}><input type="checkbox" required checked={confirm} onChange={event=>setConfirm(event.target.checked)}/><span>I reviewed the included final versions. This is an internal manifest with status “not transferred”.</span></label><Notice>The package records current independent review receipts. It cannot be shared through the external client portal or used to record client acceptance in this version.</Notice>
  </fieldset><FrozenAttempt error={mutation.error}/>{detail.project.revision!==revision&&!attempt&&<p className={s.notice}>The project changed. Close and reopen to review the current finals.</p>}<button className="button primary" disabled={mutation.busy||!attempt&&(!!selection.reason||!confirm||!name.trim()||!note.trim()||detail.project.revision!==revision)}><Package size={15}/>{mutation.busy?'Preparing package…':attempt?'Retry exact package':'Prepare internal package'}</button>
 </form></Modal>;
}
