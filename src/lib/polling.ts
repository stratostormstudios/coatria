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

/** Coalesce movement while a write is in flight; intermediate positions can be discarded. */
export function latestWriter<T>(send:(value:T,signal:AbortSignal)=>Promise<void>,onError:(error:unknown)=>void,intervalMs=1000){
  const controller=new AbortController();let pending:{value:T}|undefined,running=false,closed=false,timer:ReturnType<typeof setTimeout>|undefined,lastStarted=0;
  const flush=async()=>{
    if(closed||running||!pending)return;
    const delay=intervalMs-(Date.now()-lastStarted);
    if(delay>0){clearTimeout(timer);timer=setTimeout(flush,delay);return;}
    const value=pending.value;pending=undefined;running=true;lastStarted=Date.now();
    try{await send(value,controller.signal);}catch(error){if(!closed)onError(error);}finally{running=false;if(!closed&&pending)void flush();}
  };
  return {write(value:T){if(!closed){pending={value};void flush();}},close(){closed=true;pending=undefined;clearTimeout(timer);controller.abort();}};
}
