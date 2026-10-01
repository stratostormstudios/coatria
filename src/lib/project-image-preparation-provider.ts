/** Server-owned provider I/O. The SDK may report cancellation before its raw
 * transport settles; drain owns those late responses and their body cleanup. */
import {createRunpodProjectStorage,type RunpodProjectStorage,type RunpodProjectStorageConfig} from './project-storage-runpod';

export type ImagePreparationByteProvider=RunpodProjectStorage&{drain():Promise<void>};
export function createImagePreparationByteProvider(config:RunpodProjectStorageConfig):ImagePreparationByteProvider{
 const pending=new Set<Promise<unknown>>(),bodies=new Set<()=>Promise<void>>();
 let closed=false,cleanupFailed=false;
 const track=<T>(promise:Promise<T>)=>{pending.add(promise);void promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;};
 const transport:typeof fetch=async(input,init)=>{
  const deadline=Date.now()+(config.timeoutMs??30000);
  if(closed||init?.signal?.aborted)throw Error('PREPARATION_PROVIDER_ABORTED');
  const response=await track(fetch(input,init));
  if(!response.body)return response;
  if(closed||init?.signal?.aborted){
   try{await track(response.body.cancel());}catch{cleanupFailed=true;}
   return new Response(null,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
  const reader=response.body.getReader();let cancelled:Promise<void>|undefined,ended=false;
  const cancel=()=>cancelled??=track((async()=>{
   try{await reader.cancel();}catch{cleanupFailed=true;}
   finally{ended=true;bodies.delete(cancel);try{reader.releaseLock();}catch{cleanupFailed=true;}}
  })());
  bodies.add(cancel);
  const body=new ReadableStream<Uint8Array>({
   async pull(controller){if(ended){controller.close();return;}try{
    if(closed||init?.signal?.aborted||Date.now()>=deadline)throw Error('PREPARATION_PROVIDER_ABORTED');
    const part=await track(reader.read());if(ended)return;
    if(closed||init?.signal?.aborted||Date.now()>=deadline)throw Error('PREPARATION_PROVIDER_ABORTED');
    if(part.done){ended=true;bodies.delete(cancel);reader.releaseLock();controller.close();}else controller.enqueue(part.value);
   }catch(error){controller.error(error);await cancel();}},
   cancel,
  },{highWaterMark:0});
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
 const adapter=createRunpodProjectStorage(config,{fetch:transport});
 return {...adapter,close(){closed=true;adapter.close();for(const cancel of bodies)void cancel();},async drain(){
  for(const cancel of bodies)void cancel();
  while(pending.size)await Promise.allSettled([...pending]);
  if(bodies.size||cleanupFailed)throw Error('PREPARATION_PROVIDER_CLEANUP_FAILED');
 }};
}
