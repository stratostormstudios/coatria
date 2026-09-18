'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '@/lib/client';
const message=(error:unknown)=>error instanceof Error?error.message:'The request could not be completed.';

/** Mount by company identity. Late replies cannot update a different workspace. */
export function useStudioResource<T>(path:string){
 const [data,setData]=useState<T|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const active=useRef(true),version=useRef(0),request=useRef<AbortController|null>(null);
 const reload=useCallback(async()=>{
  request.current?.abort();const ticket=++version.current,controller=new AbortController();request.current=controller;
  const timeout=setTimeout(()=>controller.abort(),20_000);
  try{const value=await api<T>(path,'GET',undefined,{signal:controller.signal});if(active.current&&ticket===version.current){setData(value);setError('');}}
  catch(error){if(active.current&&ticket===version.current)setError(message(error));}
  finally{clearTimeout(timeout);if(request.current===controller)request.current=null;if(active.current&&ticket===version.current)setLoading(false);}
 },[path]);
 useEffect(()=>{active.current=true;setData(null);setLoading(true);setError('');void reload();const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!request.current)void reload();},10_000);return()=>{active.current=false;version.current++;request.current?.abort();clearInterval(timer);};},[reload]);
 return {data,loading,error,reload};
}

export function useStudioMutation(){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=useRef(true),pending=useRef(false),request=useRef<AbortController|null>(null),attempts=useRef(new Map<string,string>());
 useEffect(()=>{active.current=true;return()=>{active.current=false;request.current?.abort();};},[]);
 async function mutate<T>(path:string,body:Record<string,unknown>,saved:(result:T)=>void|Promise<void>,method='POST'){
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  const signature=method+path+JSON.stringify(body);if(!attempts.current.has(signature))attempts.current.set(signature,crypto.randomUUID());
  const controller=new AbortController();request.current=controller;const timeout=setTimeout(()=>controller.abort(),20_000);
  try{const result=await api<T>(path,method,{...body,clientId:attempts.current.get(signature)},{signal:controller.signal});attempts.current.delete(signature);if(active.current)await saved(result);}
  catch(error){if(active.current)setError(message(error));}
  finally{clearTimeout(timeout);pending.current=false;if(request.current===controller)request.current=null;if(active.current)setBusy(false);}
 }
 return {busy,error,mutate};
}
