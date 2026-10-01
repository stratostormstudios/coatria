'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,FileImage,FolderOpen,RefreshCw,ShieldCheck} from 'lucide-react';
import {api,when} from '@/lib/client';
import {projectImagePreparationProcessorSchema,type ProjectImagePreparation,type ProjectImagePreparationPage,type ProjectImagePreparationAvailability} from '@/lib/project-image-preparations-protocol';
import {HIGGSFIELD_REFERENCE_ROLES,type HiggsfieldReference,type HiggsfieldReferenceAvailability} from '@/lib/higgsfield-references-protocol';
import type {StudioReadableProjectDetail} from '@/lib/studio-protocol';
import type {ProjectStorageListing} from '@/lib/project-storage-protocol';
import {Badge,Field,Loading} from './ui';
import {ReferenceFilePicker,ReferenceImagePreview,referenceSize,type ReferenceFileSelection} from './HiggsfieldReferenceFiles';
import s from './ProjectImagePreparationsPanel.module.css';

type Processing=ProjectImagePreparationAvailability;
type Page=ProjectImagePreparationPage&{processing:Processing};
type Response={preparation:ProjectImagePreparation;processing:Processing};
type ReferenceResponse={reference:HiggsfieldReference;processing:HiggsfieldReferenceAvailability};
type Props={companyId:string;projectId:string;projectRevision:number;projectReady:boolean;workItems:StudioReadableProjectDetail['workItems'];workItemId?:string;isAdmin:boolean;onReferencePrepared:(value:ReferenceResponse)=>void};
const labels:Record<ProjectImagePreparation['status'],string>={proposed:'Needs processing approval',queued:'Approved · queued',reading:'Reading the approved original',transforming:'Preparing image pixels',validating:'Checking the prepared image',storing:'Saving a separate PNG',verifying:'Verifying stored bytes and cleanup',ready:'Prepared image ready',uncertain:'Outcome unknown · review required',blocked:'Preparation blocked',failed:'Preparation failed',revoked:'Processing permission revoked'};
const terminal=['ready','uncertain','blocked','failed','revoked'];
const hash=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const unavailable:Processing={enabled:false,message:'Image processing is unavailable. You can propose an original; no processing will start until a qualified service is available and an administrator approves it.',processor:null};
function availability(value:Processing):Processing{
 if(!value||typeof value.enabled!=='boolean'||typeof value.message!=='string')throw Error('The processing availability response is incomplete. Refresh before continuing.');
 if(!value.enabled)return {...value,processor:null};
 const parsed=projectImagePreparationProcessorSchema.safeParse(value.processor);
 if(!parsed.success)throw Error('The processing identity could not be verified. Refresh before continuing.');
 return {...value,processor:parsed.data};
}
function sourceFacts(file:ReferenceFileSelection){return <><strong>{file.name} · v{file.version}</strong><p>{referenceSize(file.bytes)} · {file.contentType}</p><details><summary>Exact original version and checksum</summary><code>{file.versionId}<br/>{file.sha256}</code></details></>;}

export function ProjectImagePreparationsPanel(props:Props){return <Preparations key={`${props.companyId}:${props.projectId}:${props.projectRevision}:${props.isAdmin}`} {...props}/>;}
function Preparations({companyId,projectId,projectRevision,projectReady,workItems,workItemId,isAdmin,onReferencePrepared}:Props){
 const base=`/api/companies/${companyId}/image-preparations`;
 const [page,setPage]=useState<Page|null>(null),[review,setReview]=useState<ProjectImagePreparation|null>(null),[source,setSource]=useState<ReferenceFileSelection|null>(null),[picker,setPicker]=useState<'source'|'folder'|null>(null);
 const [folder,setFolder]=useState<{id:string|null;name:string}>({id:null,name:'Project files (root)'}),[name,setName]=useState(''),[task,setTask]=useState(workItemId??''),[purpose,setPurpose]=useState('');
 const [reviewFolder,setReviewFolder]=useState<{id:string|null;name:string}|null>(null);
 const [minutes,setMinutes]=useState(30),[cost,setCost]=useState('0.01'),[consents,setConsents]=useState([false,false,false]),[previewed,setPreviewed]=useState(''),[referenceTask,setReferenceTask]=useState(workItemId??''),[role,setRole]=useState<HiggsfieldReference['role']>('image'),[referencePurpose,setReferencePurpose]=useState('');
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[now,setNow]=useState(Date.now());
 const alive=useRef(true),pending=useRef(false),sequence=useRef(0),controllers=useRef(new Set<AbortController>()),read=useRef<AbortController|null>(null),idempotency=useRef(new Map<string,string>());
 const tasks=workItems.filter(item=>['references','generation'].includes(item.stage)&&['agent','creative'].includes(item.execution));
 const eligible=(id:string)=>tasks.some(item=>item.id===id&&['todo','doing'].includes(item.status)&&!item.blockedReason);
 const idFor=(identity:unknown)=>{const key=JSON.stringify(identity);let value=idempotency.current.get(key);if(!value){value=crypto.randomUUID();idempotency.current.set(key,value);}return value;};
 const clearReview=()=>{setConsents([false,false,false]);setPreviewed('');};
 function check(row:ProjectImagePreparation,prior?:ProjectImagePreparation){
  if(!row||!uuid.test(row.id)||row.projectId!==projectId||!uuid.test(row.workItemId)||!Number.isSafeInteger(row.revision)||row.revision<1||!hash.test(row.requestHash)||!row.source||!uuid.test(row.source.versionId)||!uuid.test(row.source.fileId)||!hash.test(row.source.sha256)||!Number.isSafeInteger(row.source.bytes)||row.source.bytes<1||row.source.bytes>32*1024**2||!Object.hasOwn(labels,row.status))throw Error('The preparation response changed project or file scope. Refresh before continuing.');
  if(prior&&(row.id!==prior.id||row.requestHash!==prior.requestHash||row.source.versionId!==prior.source.versionId||row.source.sha256!==prior.source.sha256||row.source.bytes!==prior.source.bytes||row.workItemId!==prior.workItemId||row.destinationFolderId!==prior.destinationFolderId||row.destinationName!==prior.destinationName||row.revision<prior.revision))throw Error('The preparation identity changed. Refresh before continuing.');
  if(row.derivation&&(row.derivation.sourceVersionId!==row.source.versionId||row.derivation.sourceSha256!==row.source.sha256||row.derivation.sourceBytes!==row.source.bytes||row.derivation.outputVersionId===row.source.versionId||row.derivation.outputFileId===row.source.fileId||!uuid.test(row.derivation.outputVersionId)||!uuid.test(row.derivation.outputFileId)||!hash.test(row.derivation.outputSha256)||!hash.test(row.derivation.receiptSha256)||row.derivation.outputBytes<1||row.derivation.outputBytes>10*1024**2||row.derivation.recipeSha256!==row.recipeSha256))throw Error('The prepared image does not match its original and stored derivation. Refresh before continuing.');
 }
 async function request<T>(url:string,method='GET',body?:unknown,controller=new AbortController()){
  controllers.current.add(controller);const timer=setTimeout(()=>controller.abort(),20_000);
  try{const value=await api<T>(url,method,body,{signal:controller.signal});controller.signal.throwIfAborted();if(!alive.current)throw Error('The project view changed.');return value;}
  finally{clearTimeout(timer);controllers.current.delete(controller);}
 }
 const load=useCallback(async(after?:string)=>{
  read.current?.abort();const controller=new AbortController(),ticket=++sequence.current;read.current=controller;setLoading(true);setError('');setReview(null);setConsents([false,false,false]);setPreviewed('');
  try{const value=await request<Page>(`${base}?${new URLSearchParams({projectId,limit:'20',...(after?{after}:{})})}`,'GET',undefined,controller);const processing=availability(value.processing);value.preparations.forEach(item=>check(item));if(new Set(value.preparations.map(item=>item.id)).size!==value.preparations.length)throw Error('The preparation list contains duplicate identities. Refresh before continuing.');if(alive.current&&ticket===sequence.current)setPage(previous=>({...value,processing,preparations:after&&previous?[...previous.preparations,...value.preparations.filter(item=>!previous.preparations.some(old=>old.id===item.id))]:value.preparations}));}
  catch(cause){if(alive.current&&ticket===sequence.current){setPage(null);setError(cause instanceof Error?cause.message:'Image preparations could not be loaded.');}}
  finally{if(alive.current&&ticket===sequence.current)setLoading(false);}
 },[base,projectId]);
 useEffect(()=>{alive.current=true;void load();const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{alive.current=false;sequence.current++;controllers.current.forEach(controller=>controller.abort());clearInterval(timer);};},[load]);
 function replace(value:Response,prior?:ProjectImagePreparation){check(value.preparation,prior);const processing=availability(value.processing);if(!alive.current)return;setPage(previous=>({preparations:previous?.preparations.some(item=>item.id===value.preparation.id)?previous.preparations.map(item=>item.id===value.preparation.id?value.preparation:item):[value.preparation,...previous?.preparations??[]],hasMore:previous?.hasMore??false,nextAfter:previous?.nextAfter??null,processing}));setReview(value.preparation);setReviewFolder(value.preparation.destinationFolderId?null:{id:null,name:'Project files (root)'});clearReview();}
 async function act(operation:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');read.current?.abort();sequence.current++;try{await operation();}catch(cause){if(alive.current){clearReview();setError(cause instanceof Error?cause.message:'This action was not confirmed. Refresh its saved status before continuing.');}}finally{pending.current=false;if(alive.current){setBusy(false);setLoading(false);}}}
 async function propose(){
  if(!source||!eligible(task)||!purpose.trim()||!name.toLowerCase().endsWith('.png'))throw Error('Choose a supported original, an open production task, a PNG filename and a purpose.');
  const body={projectId,projectRevision,workItemId:task,sourceVersionId:source.versionId,sourceSha256:source.sha256,sourceBytes:source.bytes,destinationFolderId:folder.id,destinationName:name.trim(),purpose:purpose.trim()};
  const value=await request<Response>(base,'POST',{...body,clientId:idFor({operation:'propose',...body})});check(value.preparation);
  if(value.preparation.source.versionId!==source.versionId||value.preparation.source.sha256!==source.sha256||value.preparation.source.bytes!==source.bytes||value.preparation.workItemId!==task||value.preparation.projectRevision!==projectRevision||value.preparation.destinationFolderId!==folder.id||value.preparation.destinationName!==body.destinationName||value.preparation.purpose!==body.purpose)throw Error('The proposed image preparation differs from your selection. Refresh before approving.');
  replace(value);setReviewFolder(folder);setNotice('Original proposed. No processing or external sharing has been approved.');
 }
 async function inspect(item:ProjectImagePreparation){
  setReview(null);setReviewFolder(null);clearReview();const value=await request<Response>(`${base}/${item.id}`);check(value.preparation,item);
  let destination={id:null as string|null,name:'Project files (root)'};
  if(value.preparation.destinationFolderId){const listing=await request<ProjectStorageListing>(`/api/companies/${companyId}/studio/projects/${projectId}/files?${new URLSearchParams({parentId:value.preparation.destinationFolderId,limit:'1'})}`);if(listing.binding?.projectId!==projectId||listing.breadcrumbs.at(-1)?.id!==value.preparation.destinationFolderId)throw Error('The preparation destination folder could not be verified. Refresh before approving.');destination={id:value.preparation.destinationFolderId,name:'Project files / '+listing.breadcrumbs.map(folder=>folder.name).join(' / ')};}
  replace(value,item);setReviewFolder(destination);setMinutes(30);setCost('0.01');setReferenceTask(eligible(workItemId??'')?workItemId!:eligible(item.workItemId)?item.workItemId:'');setReferencePurpose(item.purpose);
 }
 const processing=page?.processing??unavailable,processor=processing.processor,processorCurrent=processing.enabled&&!!processor&&Date.parse(processor.expiresAt)>now;
 const costMicrousd=Math.round(Number(cost)*1_000_000),validCost=cost.trim()!==''&&Number.isFinite(costMicrousd)&&costMicrousd>=0&&costMicrousd<=1_000_000;
 // Machine planning acceptance advances the project exactly once. The server
 // proves its recorded transition before adopting processing consent; the UI
 // must not disable that legitimate submitted-plan approval in advance.
 const revisionEligible=!!review&&(review.projectRevision===projectRevision||review.continuationMode==='submitted_plan_v1'&&review.projectRevision+1===projectRevision);
 const locked=busy||loading||!projectReady,canApprove=!!review&&review.status==='proposed'&&revisionEligible&&!!reviewFolder&&reviewFolder.id===review.destinationFolderId&&(review.continuationMode==='submitted_plan_v1'||eligible(review.workItemId))&&processorCurrent&&isAdmin&&!locked;
 async function approve(){
  if(!review||!processor||!canApprove||!consents.every(Boolean)||!validCost)throw Error('Review the exact original, processor and all three finite permissions first.');
  const body={revision:review.revision,requestHash:review.requestHash,processorId:processor.id,qualificationSha256:processor.qualificationSha256,expiresInMinutes:minutes,maxCostMicrousd:costMicrousd,processingConsent:true,derivativeWriteConsent:true,adoptionConsent:true};
  replace(await request<Response>(`${base}/${review.id}/approve`,'POST',{...body,clientId:idFor({operation:'approve',id:review.id,...body})}),review);setNotice('Processing approved for this original and processor only. Refresh to see saved progress.');
 }
 async function revoke(item:ProjectImagePreparation){const body={revision:item.revision,note:'Processing permission revoked in the project image preparation panel.'};replace(await request<Response>(`${base}/${item.id}/revoke`,'POST',{...body,clientId:idFor({operation:'revoke',id:item.id,...body})}),item);setNotice('Future processing is revoked. An in-flight attempt still needs confirmed cleanup; existing files were not deleted.');}
 const derivative=review?.status==='ready'&&review.derivation&&review.cleanupConfirmedAt?review.derivation:null;
 const prepared:ReferenceFileSelection|null=derivative&&review?{versionId:derivative.outputVersionId,fileId:derivative.outputFileId,name:review.destinationName,version:1,bytes:derivative.outputBytes,sha256:derivative.outputSha256,contentType:'image/png'}:null;
 async function makeReference(){
  if(!review||!derivative||!prepared||previewed!==derivative.receiptSha256||!eligible(referenceTask)||!referencePurpose.trim())throw Error('Preview the exact prepared image and choose an open downstream task and purpose.');
  const body={revision:review.revision,projectRevision,workItemId:referenceTask,role,purpose:referencePurpose.trim()};
  const value=await request<ReferenceResponse>(`${base}/${review.id}/reference`,'POST',{...body,clientId:idFor({operation:'reference',id:review.id,...body})});
  const reference=value.reference;
  if(!reference||reference.projectId!==projectId||reference.workItemId!==referenceTask||reference.role!==role||reference.purpose!==body.purpose||reference.projectRevision!==projectRevision||reference.proxy.versionId!==prepared.versionId||reference.proxy.sha256!==prepared.sha256||reference.proxy.bytes!==prepared.bytes||reference.source?.versionId!==review.source.versionId||reference.source.sha256!==review.source.sha256||reference.source.bytes!==review.source.bytes)throw Error('The sharing proposal does not match this prepared image and original. Refresh before continuing.');
  const evidence=reference.preparation;
  if(!evidence||evidence.id!==review.id||evidence.sourceVersionId!==review.source.versionId||evidence.outputVersionId!==prepared.versionId||evidence.recipeSha256!==derivative.recipeSha256||evidence.receiptSha256!==derivative.receiptSha256||evidence.metadataRemoved!==true||evidence.outputWidth!==derivative.outputWidth||evidence.outputHeight!==derivative.outputHeight)throw Error('The sharing proposal is missing this exact preparation receipt. Refresh before continuing.');
  onReferencePrepared(value);setNotice('Prepared image proposed for sharing review below. Higgsfield has not received sharing approval.');
 }
 const consentLabels=[`I allow the processor at ${processor?.location??'the reviewed location'} to read and process this exact original, including its metadata.`,`I allow one separate PNG to be written to the reviewed project folder; the original must stay unchanged.`,`I adopt this task’s processing request and its cost limit for the finite approval period, including work proposed by an agent.`];
 return <section className={s.panel} aria-label="Prepare original image" aria-busy={busy||loading}>
  <header className={s.header}><div><span className="eyebrow">ORIGINAL → PREPARED IMAGE → SHARING REVIEW</span><h3><FileImage size={19}/>Keep the original. Prepare a reference.</h3><p>A separate PNG with orientation applied, a maximum 2048-pixel edge and embedded metadata removed. Transparency is preserved; smaller images stay their original size.</p></div><button className="button secondary small" disabled={busy||loading} onClick={()=>void load()}><RefreshCw size={14}/>Refresh preparations</button></header>
  <ol className={s.steps} aria-label="Image preparation steps"><li><span>1</span>Choose original</li><li><span>2</span>Approve processing</li><li><span>3</span>Preview derivative</li><li><span>4</span>Review sharing</li></ol>
  <p className={s.notice} role="status">{processing.message}{processing.enabled&&!processorCurrent?' This processor qualification has expired. Refresh before approving.':''}</p>
  {error&&<p className="error-message" role="alert">{error}</p>}{notice&&<p className={s.notice} role="status">{notice}</p>}{loading&&!page&&<Loading label="Loading image preparations"/>}
  <div className={s.form} role="group" aria-label="Propose original preparation"><h4>1. Select the original and its new destination</h4><p>Only metadata is read while choosing a version. A later processing approval permits the selected processor to read the original; it does not permit sharing with Higgsfield.</p>
   <div className={s.actions}><button className="button secondary small" disabled={locked} onClick={()=>setPicker('source')}>{source?'Change original image':'Choose original image'}</button><button className="button secondary small" disabled={locked} onClick={()=>setPicker('folder')}><FolderOpen size={15}/>Choose derivative folder</button></div>
   {picker&&<ReferenceFilePicker key={`${companyId}:${projectId}:${picker}`} companyId={companyId} projectId={projectId} imageOnly={false} original={picker==='source'} folderOnly={picker==='folder'} label={picker==='source'?'Choose original for preparation':'Choose prepared image destination'} onClose={()=>setPicker(null)} onSelect={value=>{setSource(value);setName(value.name.replace(/\.[^.]+$/,'').slice(0,140)+'-reference.png');setPicker(null);}} onFolderSelect={value=>{setFolder(value);setPicker(null);}}/>}
   {source&&<div className={s.card}>{sourceFacts(source)}</div>}<p>Destination: <strong>{folder.name}</strong></p>
   <div className={s.columns}><Field label="Prepared PNG filename"><input value={name} maxLength={180} disabled={locked} onChange={event=>setName(event.target.value)} placeholder="product-reference.png"/></Field><Field label="Image preparation task"><select value={task} disabled={locked} onChange={event=>setTask(event.target.value)}><option value="">Choose open references or generation work</option>{tasks.map(item=><option key={item.id} value={item.id} disabled={!eligible(item.id)}>{item.title} · {item.status}</option>)}</select></Field></div>
   <Field label="Image preparation purpose"><input value={purpose} maxLength={1000} disabled={locked} onChange={event=>setPurpose(event.target.value)} placeholder="For example: a smaller product reference with private metadata removed"/></Field>
   <button className="button primary small" disabled={locked||!source||!eligible(task)||!name.trim().toLowerCase().endsWith('.png')||!purpose.trim()} onClick={()=>void act(propose)}>Propose image preparation</button>
  </div>
  {review&&<section className={s.review} aria-label="Review image preparation"><div className={s.header}><h4>{review.destinationName}</h4><Badge tone={review.status==='ready'?'good':['uncertain','failed','blocked'].includes(review.status)?'warning':''}>{labels[review.status]}</Badge></div>
   <div className={s.card}>{sourceFacts(review.source)}<p><ArrowRight size={14}/>Separate PNG: <strong>{review.destinationName}</strong> · {reviewFolder?.name??(review.destinationFolderId?'Selected project folder':'Project files (root)')}</p></div><p>{review.purpose}</p>
   {review.projectRevision!==projectRevision&&<p className={s.notice}>The project changed after this request. Refresh the project and propose a current request before approving processing.</p>}
   {review.continuationMode==='submitted_plan_v1'&&<p className={s.notice}>This request comes from a submitted agent plan. Approval adopts only its recorded original, recipe, destination and finite cost; the server rechecks the accepted plan. It does not resume or impersonate the agent’s ended run.</p>}
   {review.status==='proposed'&&<>{isAdmin?<><h4>2. Approve this processing request</h4>{processor?<div className={s.card}><strong>Processing location: {processor.location}</strong><p>Qualification valid until {new Date(processor.expiresAt).toLocaleString()}. This permission does not grant external reference sharing.</p><details><summary>Exact processor and qualification</summary><code>{processor.id}<br/>{processor.qualificationSha256}</code></details></div>:<p>No qualified image processor is currently available. Your proposal remains saved.</p>}
    <div className={s.columns}><Field label="Processing permission expires after"><select value={minutes} disabled={!canApprove} onChange={event=>{setMinutes(Number(event.target.value));setConsents([false,false,false]);}}>{[10,30,60].map(value=><option key={value} value={value}>{value} minutes</option>)}</select></Field><Field label="Maximum processing cost (USD)" hint="A cap, not a price quote. Maximum $1.00."><input type="number" min="0" max="1" step="0.01" value={cost} disabled={!canApprove} onChange={event=>{setCost(event.target.value);setConsents([false,false,false]);}}/></Field></div>
    {consentLabels.map((label,index)=><label className={s.check} key={index}><input type="checkbox" disabled={!canApprove||!validCost} checked={consents[index]} onChange={event=>setConsents(previous=>previous.map((value,i)=>i===index?event.target.checked:value))}/>{label}</label>)}
    <button className="button primary small" disabled={!canApprove||!validCost||!consents.every(Boolean)} onClick={()=>void act(approve)}>Approve exact image processing</button>
   </>:<p>A human administrator must approve reading the original, writing a derivative and adopting the bounded processing cost. Your proposal grants none of these permissions.</p>}</>}
   {review.approval&&<p>Approved processor: {review.approval.processor.location} · Cost cap ${(review.approval.maxCostMicrousd/1_000_000).toFixed(2)} · Permission {Date.parse(review.approval.expiresAt)>now?'expires':'expired'} {new Date(review.approval.expiresAt).toLocaleString()}.</p>}
   {review.claimedAt&&!review.cleanupConfirmedAt&&<p className={s.warning}>Processor and temporary-file cleanup are not yet confirmed. The attempt retains its processing slot.</p>}
   {review.status==='uncertain'&&<p className={s.warning}>A processing or storage operation may have happened. An administrator must reconcile this original attempt; do not create a replacement. No automatic retry is offered.</p>}
   {review.status==='revoked'&&<p>Future processing is disabled. Revocation cannot undo reads or writes that already happened; cleanup must still be confirmed.</p>}
   {prepared&&derivative&&<><h4>3. Preview the separate prepared image</h4><p><ShieldCheck size={15}/>Stored bytes verified · {derivative.outputWidth} × {derivative.outputHeight} · {referenceSize(derivative.outputBytes)} · Cleanup confirmed. The original remains unchanged.</p><ReferenceImagePreview key={`${review.id}:${derivative.receiptSha256}:${prepared.versionId}`} companyId={companyId} projectId={projectId} file={prepared} onVerified={()=>setPreviewed(derivative.receiptSha256)}/><h4>4. Prepare a sharing review</h4><p>Choose current, open work for this image. This creates a new reference proposal; separate image inspection and administrator sharing consent still apply.</p>
    <div className={s.columns}><Field label="Prepared image reference task"><select value={referenceTask} disabled={locked} onChange={event=>setReferenceTask(event.target.value)}><option value="">Choose open downstream work</option>{tasks.map(item=><option key={item.id} value={item.id} disabled={!eligible(item.id)}>{item.title} · {item.status}</option>)}</select></Field><Field label="Prepared image reference role"><select value={role} disabled={locked} onChange={event=>setRole(event.target.value as HiggsfieldReference['role'])}>{HIGGSFIELD_REFERENCE_ROLES.map(value=><option key={value} value={value}>{value==='image'?'Image reference':value==='start_image'?'Video start frame':'Video end frame'}</option>)}</select></Field></div><Field label="Prepared image sharing purpose"><input value={referencePurpose} maxLength={1000} disabled={locked} onChange={event=>setReferencePurpose(event.target.value)}/></Field>
    <button className="button primary small" disabled={locked||previewed!==derivative.receiptSha256||!eligible(referenceTask)||!referencePurpose.trim()} onClick={()=>void act(makeReference)}>Prepare sharing review</button>
   </>}
   {review.status==='ready'&&!prepared&&<p className={s.warning}>The exact stored derivative and cleanup evidence are incomplete. Refresh before previewing or proposing sharing.</p>}
   {review.diagnosticCode&&<p>Diagnostic: <code>{review.diagnosticCode}</code></p>}
  </section>}
  <div className={s.history}><h4>Saved image preparations</h4><p>Progress below comes from saved processing receipts. Refresh to see changes; no transfer starts from viewing this list.</p>{page&&!page.preparations.length&&<p>No originals have been proposed for preparation.</p>}{page?.preparations.map(item=><article key={item.id} className={s.card} aria-label={`Image preparation ${item.destinationName}`}><div className={s.header}><strong>{item.destinationName}</strong><Badge tone={item.status==='ready'?'good':['uncertain','failed','blocked'].includes(item.status)?'warning':''}>{labels[item.status]}</Badge></div><p>{item.source.name} · v{item.source.version} → separate PNG · Updated {when(item.updatedAt)}</p><div className={s.actions}><button className="button secondary small" disabled={locked} onClick={()=>void act(()=>inspect(item))}>Review preparation</button>{isAdmin&&!terminal.includes(item.status)&&<button className="button secondary small" disabled={locked} onClick={()=>void act(()=>revoke(item))}>Revoke processing permission</button>}</div></article>)}{page?.hasMore&&page.nextAfter&&<button className="button secondary small" disabled={locked} onClick={()=>void load(page.nextAfter!)}>Load more preparations</button>}</div>
 </section>;
}
