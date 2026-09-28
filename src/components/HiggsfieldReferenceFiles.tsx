'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {ChevronRight,FileImage,FolderOpen,RefreshCw,ShieldCheck} from 'lucide-react';
import {api} from '@/lib/client';
import {downloadStorageFile,type StorageDownloadAccess} from '@/lib/project-storage-client';
import type {ProjectStorageFile,ProjectStorageListing} from '@/lib/project-storage-protocol';
import type {HiggsfieldReferenceCandidatePage,HiggsfieldReferenceVersion} from '@/lib/higgsfield-references-protocol';
import {Field,Loading} from './ui';
import s from './HiggsfieldReferencesPanel.module.css';

export type ReferenceFileSelection=HiggsfieldReferenceVersion;
type Version=HiggsfieldReferenceVersion;
type VersionsPage=HiggsfieldReferenceCandidatePage;
export const REFERENCE_IMAGE_MAX_BYTES=10*1024**2;
const IMAGE_TYPES=['image/png','image/jpeg','image/webp'];
export const referenceSize=(bytes:number)=>bytes>=1024**2?`${(bytes/1024**2).toFixed(2)} MiB`:`${bytes.toLocaleString()} bytes`;
function unavailable(version:Version,imageOnly:boolean){
 if(!version.sha256)return 'This version has no verified storage receipt.';
 if(imageOnly&&!IMAGE_TYPES.includes(version.contentType))return 'Choose PNG, JPEG or WebP.';
 if(imageOnly&&version.bytes>REFERENCE_IMAGE_MAX_BYTES)return 'Prepare a shareable image smaller than 10 MiB first.';
 return '';
}

/** Only server-scoped version identifiers leave this picker. Selection never downloads an original. */
export function ReferenceFilePicker({companyId,projectId,imageOnly,label,onSelect,onClose}:{companyId:string;projectId:string;imageOnly:boolean;label:string;onSelect:(selection:ReferenceFileSelection)=>void;onClose:()=>void}){
 const base=`/api/companies/${companyId}/studio/projects/${projectId}/files`;
 const [listing,setListing]=useState<ProjectStorageListing|null>(null),[folder,setFolder]=useState<string|null>(null),[file,setFile]=useState<ProjectStorageFile|null>(null),[versions,setVersions]=useState<VersionsPage|null>(null),[filter,setFilter]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const alive=useRef(true),request=useRef<AbortController|null>(null),sequence=useRef(0);
 const load=useCallback(async(parentId:string|null,after?:string)=>{
  request.current?.abort();const controller=new AbortController(),seq=++sequence.current;request.current=controller;setLoading(true);setError('');setFile(null);setVersions(null);
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{
   const value=await api<ProjectStorageListing>(`${base}?${new URLSearchParams({limit:'20',...(parentId?{parentId}:{}),...(after?{after}:{})})}`,'GET',undefined,{signal:controller.signal});
   if(value.binding&&value.binding.projectId!==projectId)throw Error('The file library changed project scope. Reopen the picker.');
   if(alive.current&&seq===sequence.current){setListing(previous=>({...value,items:after&&previous?[...previous.items,...value.items.filter(item=>!previous.items.some(old=>old.id===item.id))]:value.items}));setFolder(parentId);setFilter('');}
  }catch(cause){if(alive.current&&seq===sequence.current)setError(cause instanceof Error?cause.message:'Project files could not be loaded.');}
  finally{clearTimeout(timer);if(alive.current&&seq===sequence.current)setLoading(false);}
 },[base,projectId]);
 useEffect(()=>{alive.current=true;void load(null);return()=>{alive.current=false;sequence.current++;request.current?.abort();};},[load]);
 async function openVersions(selected:ProjectStorageFile,after?:string){
  request.current?.abort();const controller=new AbortController(),seq=++sequence.current;request.current=controller;setLoading(true);setError('');setFile(selected);if(!after)setVersions(null);
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{
   const value=await api<VersionsPage>(`/api/companies/${companyId}/higgsfield/references/candidates?${new URLSearchParams({projectId,fileId:selected.id,limit:'20',...(after?{after}:{})})}`,'GET',undefined,{signal:controller.signal});
   if(value.versions.some(version=>version.fileId!==selected.id))throw Error('The version response changed file scope. Reopen the file.');
   if(alive.current&&seq===sequence.current)setVersions(previous=>({...value,versions:after&&previous?[...previous.versions,...value.versions.filter(item=>!previous.versions.some(old=>old.versionId===item.versionId))]:value.versions}));
  }catch(cause){if(alive.current&&seq===sequence.current)setError(cause instanceof Error?cause.message:'File versions could not be loaded.');}
  finally{clearTimeout(timer);if(alive.current&&seq===sequence.current)setLoading(false);}
 }
 function choose(selected:ProjectStorageFile,version:Version){if(unavailable(version,imageOnly))return;onSelect({...version,name:selected.name});}
 return <section className={s.picker} aria-label={label} aria-busy={loading}>
  <div className={s.header}><h4>{label}</h4><button type="button" className="button secondary small" onClick={onClose}>Close file picker</button></div>
  <p>{imageOnly?'Choose an already-prepared, shareable PNG, JPEG or WebP, at most 10 MiB. Selecting it does not upload it to Higgsfield.':'Link an original only for provenance. Its bytes will stay on project storage and will not be substituted for the prepared image.'}</p>
  {error&&<p className="error-message" role="alert">{error}</p>}
  <nav className={s.breadcrumbs} aria-label={`${label} location`}><button type="button" disabled={loading} onClick={()=>void load(null)}><FolderOpen size={15}/>Project files</button>{listing?.breadcrumbs.map(item=><span key={item.id}><ChevronRight size={13}/><button type="button" disabled={loading} onClick={()=>void load(item.id)}>{item.name}</button></span>)}</nav>
  {loading&&!listing&&<Loading label="Loading project files"/>}
  {listing&&!listing.binding&&<p>No project storage is connected. Set up storage in this project’s Files tab.</p>}
  {!file&&listing&&<><Field label="Search loaded reference files"><input type="search" value={filter} onChange={event=>setFilter(event.target.value)} placeholder="Filter this loaded folder…"/></Field><div className={s.files}>{listing.items.filter(item=>item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(item=><article key={item.id} className={s.file}><div>{item.kind==='folder'?<FolderOpen size={18}/>:<FileImage size={18}/>}<strong>{item.name}</strong></div>{item.kind==='folder'?<button type="button" className="button secondary small" disabled={loading} onClick={()=>void load(item.id)}>Open {item.name}</button>:<><p>{item.latestVersion?`Latest: v${item.latestVersion.version} · ${referenceSize(item.latestVersion.bytes)} · ${item.latestVersion.verified?'Storage verified':'Not verified'}`:'No uploaded version yet'}</p><button type="button" className="button secondary small" disabled={loading||!item.latestVersion} onClick={()=>void openVersions(item)}>Choose version of {item.name}</button></>}</article>)}</div>{!listing.items.length&&<p>No files or subfolders here.</p>}{listing.page.hasMore&&listing.page.nextAfter&&<button type="button" className="button secondary small" disabled={loading} onClick={()=>void load(folder,listing.page.nextAfter!)}>Load more reference files</button>}</>}
  {file&&<><div className={s.header}><strong>{file.name}</strong><button type="button" className="button secondary small" disabled={loading} onClick={()=>{setFile(null);setVersions(null);}}>Back to files</button></div>{loading&&!versions&&<Loading label="Loading exact file versions"/>}<div className={s.files}>{versions?.versions.map(version=><article key={version.versionId} className={s.file}><strong>Version {version.version}</strong><p>{referenceSize(version.bytes)} · {version.contentType}</p><code>{version.sha256??'No verified hash'}</code>{unavailable(version,imageOnly)&&<p>{unavailable(version,imageOnly)}</p>}<button type="button" className="button secondary small" disabled={loading||!!unavailable(version,imageOnly)} onClick={()=>choose(file,version)}>Use version {version.version}</button></article>)}</div>{versions?.hasMore&&versions.nextAfter&&<button type="button" className="button secondary small" disabled={loading} onClick={()=>void openVersions(file,versions.nextAfter!)}>Load more file versions</button>}</>}
  {error&&<button type="button" className="button secondary small" disabled={loading} onClick={()=>file?void openVersions(file):void load(folder)}><RefreshCw size={14}/>Reload picker</button>}
 </section>;
}

/** A bounded authenticated storage read, hashed in-browser. Provider URLs are never rendered. */
export function ReferenceImagePreview({companyId,projectId,file,onVerified}:{companyId:string;projectId:string;file:ReferenceFileSelection;onVerified:()=>void}){
 const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[dimensions,setDimensions]=useState('');
 const controller=useRef<AbortController|null>(null),objectUrl=useRef(''),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);};},[]);
 async function preview(){
  if(busy)return;setBusy(true);setError('');const abort=new AbortController();controller.current=abort;const timer=setTimeout(()=>abort.abort(),30_000);
  try{
   if(file.bytes>REFERENCE_IMAGE_MAX_BYTES||!IMAGE_TYPES.includes(file.contentType))throw Error('This version is outside the prepared-image preview limits.');
   const base=`/api/companies/${companyId}/studio/projects/${projectId}/files`;
   const current=await api<ProjectStorageListing>(`${base}?limit=1`,'GET',undefined,{signal:abort.signal});
   if(current.binding?.projectId!==projectId||!current.transfers.available)throw Error(current.transfers.available===false?current.transfers.message:'This project has no available storage preview service.');
   const result=await api<{access:StorageDownloadAccess}>(`${base}/versions/${file.versionId}/access`,'POST',{clientId:crypto.randomUUID(),disposition:'inline'},{signal:abort.signal});
   if(result.access.bytes!==file.bytes||result.access.sha256!==file.sha256||result.access.contentType!==file.contentType)throw Error('The storage access does not match this exact version. Refresh the reference.');
   const downloaded=await downloadStorageFile(result.access,null,{gatewayOrigin:current.transfers.gatewayOrigin,signal:abort.signal});
   if(!downloaded.blob)throw Error('The complete preview was not received.');
   const digest=await crypto.subtle.digest('SHA-256',await downloaded.blob.arrayBuffer()),sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(sha256!==file.sha256)throw Error('The preview bytes differ from the selected version. Do not approve this reference.');
   const decoded=await createImageBitmap(downloaded.blob);const {width,height}=decoded;decoded.close();
   if(width<1||height<1||width>4096||height>4096||width*height>16_000_000)throw Error('The prepared image exceeds the 4096-pixel or 16-megapixel preview limits.');
   abort.signal.throwIfAborted();if(!alive.current)return;
   if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=URL.createObjectURL(downloaded.blob);setUrl(objectUrl.current);setDimensions(`${width} × ${height}`);
  }catch(cause){if(alive.current){setUrl('');setError(cause instanceof Error?cause.message:'The exact image could not be previewed.');}}
  finally{clearTimeout(timer);if(alive.current)setBusy(false);}
 }
 return <div className={s.preview}>
  {url?<><img src={url} alt={`Exact prepared reference: ${file.name}`} onLoad={onVerified} onError={()=>{setUrl('');setError('This exact image could not be displayed.');}}/><p><ShieldCheck size={14}/>Exact storage bytes checked · {dimensions}. This preview does not remove metadata or establish sharing rights.</p></>:<><p>Preview this exact file before approving external sharing. The preview reads project storage; it does not contact Higgsfield.</p><button type="button" className="button secondary small" disabled={busy} onClick={()=>void preview()}>{busy?'Checking exact preview…':'Preview exact prepared image'}</button></>}
  {error&&<p className="error-message" role="alert">{error}</p>}
 </div>;
}
