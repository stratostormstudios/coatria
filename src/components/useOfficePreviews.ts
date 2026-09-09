'use client';
import {useEffect,useRef,useState} from 'react';
import {getOfficeAsset} from '@/lib/office-catalog';

type Preview={url?:string;error?:boolean};
/** The cache belongs to this editor and account; licensed images never enter a public cache. */
export function useOfficePreviews(userId:string,ids:string[],kind:'preview'|'plan'='preview'){
  const [images,setImages]=useState<Record<string,Preview>>({}),[retryVersion,setRetryVersion]=useState(0);
  const library=useRef<{setWanted:(ids:string[])=>void;retry:()=>void}|null>(null);
  const key=[...new Set(ids.filter(id=>Boolean(getOfficeAsset(id))))].join(',');
  useEffect(()=>{
    const controller=new AbortController(),entries=new Map<string,Preview>(),queue:string[]=[],urls=new Set<string>();let running=0,closed=false;
    setImages({});
    const publish=()=>{if(!closed)setImages(Object.fromEntries(entries));};
    const pump=()=>{while(!closed&&running<4&&queue.length){const id=queue.shift()!;running++;
      void fetch(`/api/office-assets/${encodeURIComponent(id)}/${kind}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'X-Coatria-User':userId}})
        .then(async response=>{if(closed)return;if(!response.ok){if(response.status===401||response.status===409)window.dispatchEvent(new Event('coatria:session-changed'));throw new Error('Preview unavailable');}const blob=await response.blob();if(blob.size>256*1024||blob.type!=='image/png')throw new Error('Preview unavailable');if(closed)return;const url=URL.createObjectURL(blob);urls.add(url);entries.set(id,{url});publish();})
        .catch(()=>{if(!closed){entries.set(id,{error:true});publish();}}).finally(()=>{running--;pump();});
    }};
    library.current={setWanted(ids){
      if(closed)return;
      // Only queued entries are removed. Active requests and completed blobs
      // stay deduplicated; an obsolete queued ID can load again when revisited.
      for(const id of queue)entries.delete(id);
      queue.length=0;
      for(const id of ids){if(entries.has(id)||!getOfficeAsset(id))continue;entries.set(id,{});queue.push(id);}
      publish();pump();
    },retry(){for(const[id,entry]of entries)if(entry.error)entries.delete(id);publish();}};
    return()=>{closed=true;controller.abort();queue.length=0;urls.forEach(url=>URL.revokeObjectURL(url));library.current=null;};
  },[userId,kind]);
  useEffect(()=>{library.current?.setWanted(key.split(',').filter(Boolean));},[key,userId,kind,retryVersion]);
  return {images,retry(){library.current?.retry();setRetryVersion(v=>v+1);}};
}
