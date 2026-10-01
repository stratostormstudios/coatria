'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {api} from '@/lib/client';
import type {ProjectStorageConnection} from '@/lib/project-storage-protocol';
import {Field,Modal} from './ui';
import s from './ProjectFilesPanel.module.css';

type Attempt={clientId:string;revision:number;cancelClientId:string};
type Result={recorded?:boolean;reauthorization?:{connectionId:string;appliedRevision:number};connection:ProjectStorageConnection};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function valid(value:unknown):value is Attempt{const a=value as Attempt;return !!a&&typeof a==='object'&&Object.keys(a).length===3&&uuid.test(a.clientId)&&uuid.test(a.cancelClientId)&&Number.isSafeInteger(a.revision)&&a.revision>0;}

/** The journal contains request identity only. Keys exist in the password form
 * and one POST; an unknown outcome never silently submits another replacement. */
export function StorageConnectionCredentials({userId,companyName,companyId,connection,onChanged,onClose}:{userId:string;companyName:string;companyId:string;connection:ProjectStorageConnection;onChanged:(connection:ProjectStorageConnection,message:string)=>void;onClose:()=>void}){
 const path=`/api/companies/${companyId}/storage-connections/${connection.id}`,journal=`coatria:storage-credentials:${userId}:${companyId}:${connection.id}`;
 const [current,setCurrent]=useState(connection),[attempt,setAttempt]=useState<Attempt|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),flight=useRef(false),controller=useRef<AbortController|null>(null);
 useEffect(()=>{alive.current=true;try{const saved=sessionStorage.getItem(journal);if(saved){const parsed:unknown=JSON.parse(saved);if(!valid(parsed))throw Error();setAttempt(parsed);}setReady(true);}catch{setError('The pending credential change cannot be read. Ask an administrator to reconcile this connection before replacing keys.');}return()=>{alive.current=false;controller.current?.abort();};},[journal]);
 function clear(){sessionStorage.removeItem(journal);setAttempt(null);setConfirmed(false);}
 function inspect(result:Result,saved:Attempt){
  const c=result.connection;if(c.id!==connection.id||c.region!==connection.region||c.volumeId!==connection.volumeId||!Number.isSafeInteger(c.revision)||c.revision<saved.revision)throw Error('The connection response did not match the reviewed storage identity.');
  setCurrent(c);setConfirmed(false);
  if(result.reauthorization?.connectionId===c.id&&result.reauthorization.appliedRevision===saved.revision+1&&c.revision===result.reauthorization.appliedRevision&&c.status==='configured'&&c.credentialsConfigured){clear();onChanged(c,`Credentials saved for “${c.name}”. The same volume, folders and file history were retained. Provider access still needs verification.`);return;}
  if(c.revision>saved.revision){clear();const message=c.status==='revoked'?'This connection is revoked. The pending request cannot restore its previous revision.':'The connection changed after this request. Review its current revision before replacing credentials.';onChanged(c,message);return;}
  setNotice('No completed replacement is recorded yet. The request may still finish. Check again, or explicitly revoke the connection to invalidate this pending revision.');
 }
 async function perform(run:(signal:AbortSignal)=>Promise<void>){if(flight.current)return;flight.current=true;setBusy(true);setError('');setNotice('');setConfirmed(false);const c=new AbortController();controller.current=c;const timeout=setTimeout(()=>c.abort(),20000);try{await run(c.signal);}catch(e){if(alive.current)setError(e instanceof Error?e.message:'The connection change has not been confirmed.');}finally{clearTimeout(timeout);flight.current=false;if(alive.current)setBusy(false);}}
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!ready||busy||attempt||!confirmed)return;const form=event.currentTarget,data=new FormData(form),saved={clientId:crypto.randomUUID(),cancelClientId:crypto.randomUUID(),revision:current.revision};
  await perform(async signal=>{sessionStorage.setItem(journal,JSON.stringify(saved));setAttempt(saved);const body={clientId:saved.clientId,revision:saved.revision,accessKeyId:String(data.get('accessKeyId')),secretAccessKey:String(data.get('secretAccessKey'))};form.reset();try{const result=await api<Result>(path+'/reauthorize','POST',body,{signal});if(alive.current)inspect(result,saved);}catch{throw Error('The credential replacement has not been confirmed. Check its saved request before making another change.');}finally{body.accessKeyId='';body.secretAccessKey='';data.delete('accessKeyId');data.delete('secretAccessKey');}});
 }
 async function check(){if(!attempt)return;const saved=attempt;await perform(async signal=>{const result=await api<Result>(path+'/reauthorize/'+saved.clientId,'GET',undefined,{signal});if(alive.current)inspect(result,saved);});}
 async function endPending(){if(!attempt||!confirmed||current.revision!==attempt.revision)return;const saved=attempt;await perform(async signal=>{try{await api(path,'PATCH',{clientId:saved.cancelClientId,revision:saved.revision,status:'revoked'},{signal});const result=await api<Result>(path+'/reauthorize/'+saved.clientId,'GET',undefined,{signal});if(alive.current)inspect(result,saved);}catch{throw Error('Revocation has not been confirmed. Check the saved request and current connection; no automatic retry will run.');}});}
 return <Modal title={current.status==='revoked'?'Restore storage access':'Replace storage credentials'} onClose={()=>{if(!busy)onClose();}}>
  <div className={s.form}><div className={s.connectionAccess}><strong>{current.name}</strong><p>{companyName} · Runpod · {current.region}</p><p>Volume {current.volumeId}</p><details><summary>Connection details</summary><p>Company: <code>{companyId}</code><br/>Connection: <code>{current.id}</code><br/>Current revision {current.revision}</p></details></div>
   <p className={s.info}>This keeps the same volume, project folders and file history. It replaces saved access for every linked project. Previous transfer tokens stay invalid; pending uploads and archive approvals are not resumed.</p>
   {error&&<p className={s.error} role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {attempt?<><p className={s.info}>A credential change is pending confirmation. Its keys were not saved in this browser. You can close this window and check this request later.</p><button className="button secondary" disabled={busy||!ready} onClick={()=>void check()}>Check credential change</button>
    <label className={s.confirmRevoke}><input type="checkbox" checked={confirmed} disabled={busy||current.revision!==attempt.revision} onChange={e=>setConfirmed(e.target.checked)}/><span>Revoke “{current.name}” for all linked projects and end the pending credential change.</span></label><button className="button secondary" disabled={busy||!confirmed||current.revision!==attempt.revision} onClick={()=>void endPending()}>Revoke connection and end pending change</button></>:
    <form className={s.form} autoComplete="off" onSubmit={event=>void submit(event)} onChange={event=>{if(event.target instanceof HTMLInputElement&&event.target.type!=='checkbox')setConfirmed(false);}}>
     <Field label="New S3 access key ID"><input name="accessKeyId" type="password" autoComplete="new-password" required pattern="user_[a-zA-Z0-9_-]{4,160}" maxLength={165} disabled={busy||!ready} spellCheck={false}/></Field>
     <Field label="New S3 secret access key"><input name="secretAccessKey" type="password" autoComplete="new-password" required pattern="rps_[a-zA-Z0-9_-]{8,256}" maxLength={260} disabled={busy||!ready} spellCheck={false}/></Field>
     <p className={s.info}>Keys are encrypted by Coatria. Saving them does not prove provider access, start compute, create a volume or enable file transfer. The original storage administrator must still have access.</p>
     <label className={s.confirmRevoke}><input type="checkbox" checked={confirmed} disabled={busy||!ready} onChange={e=>setConfirmed(e.target.checked)}/><span>Replace credentials for “{current.name}” and restore saved access for every linked project.</span></label>
     <button className="button primary" disabled={busy||!ready||!confirmed}>{busy?'Saving credentials…':'Save new credentials'}</button>
    </form>}
   <button className="button secondary" disabled={busy} onClick={onClose}>Close</button>
  </div>
 </Modal>;
}
