'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Check,ExternalLink,Film,LockKeyhole,RefreshCw} from 'lucide-react';
import {api} from '@/lib/client';
import {Field,Loading} from './ui';
import {useStudioMutation,useStudioResource} from './studio-hooks';
import s from './StudioWorkspace.module.css';

type MediaFile={id:string;path:string;kind:string;frame:number|null;sha256:string;bytes:number;contentType:string;verifiedState:'verified'|'awaiting_upload_or_verification'};
type MediaPage={files:MediaFile[];page:{hasMore:boolean;nextAfter:string|null};maxFileBytes:number};
type Access={url:string;expiresAt:string};
const fileSize=(size:number)=>`${(size/1024/1024).toFixed(2)} MB`;

/** Signed addresses stay in component memory and expire; every refresh rechecks membership. */
function PrivateFile({file,base}:{file:MediaFile;base:string}){
 const [access,setAccess]=useState<Access|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null),active=useRef(true);
 useEffect(()=>{active.current=true;return()=>{active.current=false;request.current?.abort();};},[]);
 useEffect(()=>{if(!access)return;const timer=setTimeout(()=>setAccess(null),Math.max(0,Date.parse(access.expiresAt)-Date.now()-1000));return()=>clearTimeout(timer);},[access]);
 async function authorize(){
  if(request.current)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{const result=await api<{file:MediaFile;access:Access}>(`${base}/${file.id}`,'GET',undefined,{signal:controller.signal}),url=new URL(result.access.url);
   if(url.protocol!=='https:'||url.username||url.password||!url.hostname.endsWith('.blob.vercel-storage.com')||result.file.id!==file.id||!Number.isFinite(Date.parse(result.access.expiresAt))||Date.parse(result.access.expiresAt)<=Date.now())throw new Error('The private file link could not be verified.');
   if(active.current)setAccess(result.access);
  }catch(error){if(active.current)setError(error instanceof Error?error.message:'Unable to open this private file.');}
  finally{clearTimeout(timer);request.current=null;if(active.current)setBusy(false);}
 }
 return <article className={s.artifact}><header><div><h3>{file.path.split('/').at(-1)}</h3><small>{file.kind}{file.frame!==null?` · Frame ${file.frame}`:''} · {fileSize(file.bytes)}</small></div><span className={s.status} data-state={file.verifiedState==='verified'?'approved':'blocked'}>{file.verifiedState==='verified'?'Bytes verified':'Awaiting verification'}</span></header>
  {access&&file.contentType==='image/png'&&<img src={access.url} alt={`Rendered review image: ${file.path.split('/').at(-1)}`} referrerPolicy="no-referrer" style={{width:'100%',maxHeight:420,objectFit:'contain',marginTop:16,borderRadius:8,background:'#eef2e8'}} onError={()=>setError('Preview unavailable. Refresh access to request a new link.')}/>}
  <details className={s.smallPrint} style={{marginTop:12}}><summary>File provenance</summary><code>{file.path}</code><code>SHA-256 {file.sha256}</code></details><footer>{access?<><a className="button secondary small" href={access.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open private file <ExternalLink size={14}/></a><small>Access expires in less than a minute.</small></>:<button className="button secondary small" disabled={busy||file.verifiedState!=='verified'} onClick={()=>void authorize()}><LockKeyhole size={14}/>{busy?'Checking access…':file.contentType==='image/png'?'View private preview':'Get private file access'}</button>}</footer>{error&&<p role="alert" className="error-message">{error}</p>}
 </article>;
}

export function StudioMediaPanel({companyId,jobId,revision,admin,frameCount,onSaved}:{companyId:string;jobId:string;revision:number;admin:boolean;frameCount:number;onSaved:()=>Promise<void>}){
 const base=`/api/companies/${companyId}/studio/media`,[after,setAfter]=useState<string|null>(null),[history,setHistory]=useState<Array<string|null>>([]);
 const resource=useStudioResource<MediaPage>(`${base}?jobId=${jobId}&limit=100${after?'&after='+after:''}`),mutation=useStudioMutation(),[name,setName]=useState('Verified production sequence'),[promoted,setPromoted]=useState(false);
 async function promote(event:FormEvent){event.preventDefault();await mutation.mutate(`/api/companies/${companyId}/studio/execution/jobs/${jobId}/media/promote`,{revision,name},async()=>{setPromoted(true);await onSaved();});}
 return <section className={s.formSection} aria-label="Private production media"><div className={s.heading}><div><h3>Private production media</h3><p>Open actual files after server verification of their size and checksum.</p></div><button className="button secondary small" onClick={()=>void resource.reload()}><RefreshCw size={14}/> Refresh files</button></div>
  {resource.loading?<Loading label="Loading private media"/>:resource.data&&<>{resource.data.files.length?<div className={s.artifacts}>{[...resource.data.files].sort((a,b)=>Number(b.contentType==='image/png')-Number(a.contentType==='image/png')||(a.frame??Infinity)-(b.frame??Infinity)||a.path.localeCompare(b.path)).map(file=><PrivateFile key={file.id} file={file} base={base}/>)}</div>:<div className={s.emptyInline}><Film size={24}/><h3>Waiting for the renderer to publish its files.</h3><p>The worker publishes the sealed output directory to private storage. Files become available here after the server verifies their bytes.</p></div>}
   {(history.length>0||resource.data.page.hasMore)&&<div className={s.heading}><span>File page {history.length+1}</span><div className={s.actions}><button className="button secondary small" disabled={!history.length} onClick={()=>{setAfter(history.at(-1)??null);setHistory(history.slice(0,-1));}}>Previous files</button><button className="button secondary small" disabled={!resource.data.page.hasMore} onClick={()=>{setHistory([...history,after]);setAfter(resource.data!.page.nextAfter);}}>Next files</button></div></div>}
   <p className={s.smallPrint}>Private-media pilot: {fileSize(resource.data.maxFileBytes)} per file. Verification checks storage integrity; a reviewer still checks image quality, content, and the brief.</p>
  </>}
  {admin&&(promoted?<p role="status" className={s.notice}><Check size={17}/>The sequence is registered. Continue in Review &amp; delivery for independent review.</p>:<form className="form" onSubmit={promote}><Field label="Sequence version name"><input required maxLength={160} value={name} disabled={mutation.busy} onChange={event=>setName(event.target.value)}/></Field><p className={s.smallPrint}>Register all {frameCount} verified frames as one immutable version. The server checks the complete sequence and current project approvals.</p><button className="button primary" disabled={mutation.busy||!resource.data?.files.some(file=>file.verifiedState==='verified')}><Check size={15}/>{mutation.busy?'Registering…':'Register verified sequence for review'}</button></form>)}
  {(resource.error||mutation.error)&&<p role="alert" className="error-message">{resource.error||mutation.error}</p>}
 </section>;
}
