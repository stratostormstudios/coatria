/** A slow or unavailable connection cannot accumulate overlapping polls. */
export function startPolling(task:(signal:AbortSignal)=>Promise<void>,options:{intervalMs:number;active?:()=>boolean;immediate?:boolean;onError?:(error:unknown)=>void}) {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,stopped=false,failures=0;
  const run=async()=>{
    if(stopped)return;
    if(options.active&&!options.active()){timer=setTimeout(run,options.intervalMs);return;}
    const started=Date.now();
    try{await task(controller.signal);failures=0;}catch(error){if(!stopped){failures++;options.onError?.(error);}}
    if(!stopped){const delay=Math.min(30000,options.intervalMs*2**Math.min(failures,4));timer=setTimeout(run,Math.max(100,delay-(Date.now()-started)));}
  };
  timer=setTimeout(run,options.immediate===false?options.intervalMs:0);
  return()=>{stopped=true;clearTimeout(timer);controller.abort();};
}

/** Commands are ordered barriers; only movement between them may be coalesced. */
export function latestWriter<T,R=void>(send:(value:T,signal:AbortSignal)=>Promise<R>,onError:(error:unknown,kind:'write'|'heartbeat'|'command')=>void,intervalMs=1000){
  type Entry={kind:'write'|'heartbeat'|'command';value:T;resolve?:(value:R)=>void;reject?:(error:unknown)=>void};
  const controller=new AbortController(),queue:Entry[]=[];let active:Entry|undefined,closed=false,timer:ReturnType<typeof setTimeout>|undefined,lastStarted=0;
  const cancelled=()=>new DOMException('The workplace connection changed.','AbortError');
  const flush=async()=>{
    if(closed||active||!queue.length)return;
    // An explicit command also flushes movement ahead of it; sustained movement
    // alone remains rate-limited, and no HTTP requests overlap.
    const delay=queue.some(entry=>entry.kind==='command')?0:intervalMs-(Date.now()-lastStarted);
    if(delay>0){clearTimeout(timer);timer=setTimeout(flush,delay);return;}
    clearTimeout(timer);const entry=queue.shift()!;active=entry;lastStarted=Date.now();
    try{const result=await send(entry.value,controller.signal);if(!closed)entry.resolve?.(result);}
    catch(error){if(!closed){entry.reject?.(error);onError(error,entry.kind);}}
    finally{active=undefined;if(!closed&&queue.length)void flush();}
  };
  return {
    write(value:T){if(closed)return;const tail=queue.at(-1);if(tail&&tail.kind!=='command')queue[queue.length-1]={kind:'write',value};else queue.push({kind:'write',value});void flush();},
    heartbeat(value:T){if(closed||active||queue.length)return;queue.push({kind:'heartbeat',value});void flush();},
    command(value:T):Promise<R>{
      if(closed)return Promise.reject(cancelled());
      if(queue.filter(entry=>entry.kind==='command').length+(active?.kind==='command'?1:0)>=8)return Promise.reject(new Error('Please wait for your current actions to finish.'));
      if(queue.at(-1)?.kind==='heartbeat')queue.pop();
      return new Promise<R>((resolve,reject)=>{queue.push({kind:'command',value,resolve,reject});void flush();});
    },
    close(){if(closed)return;closed=true;clearTimeout(timer);controller.abort();const error=cancelled();active?.reject?.(error);for(const entry of queue)entry.reject?.(error);queue.length=0;}
  };
}
