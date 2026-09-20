/** Stop long reads when their current company authority ends, even when the source stalls. */
export function authorityReader(reader:ReadableStreamDefaultReader<Uint8Array>,check:()=>Promise<unknown>,intervalMs=5000){
 // Opening a provider stream can take longer than the grant check that
 // preceded it. Revalidate before exposing even its first returned chunk.
 let ended=false,lastCheck=0,failure:unknown,pending:Promise<void>|undefined;
 async function validate(force=false){
  if(failure)throw failure;
  if(ended)return;
  if(!pending&&(force||Date.now()-lastCheck>=intervalMs)){
   pending=Promise.resolve().then(check).then(()=>{lastCheck=Date.now();}).catch(error=>{failure=error;void reader.cancel().catch(()=>{});throw error;}).finally(()=>{pending=undefined;});
  }
  if(pending)await pending;if(failure)throw failure;
 }
 const timer=setInterval(()=>{void validate(true).catch(()=>{});},intervalMs);
 return {
  async read(){await validate();const chunk=await reader.read();await validate();if(failure)throw failure;return chunk;},
  async close(){ended=true;clearInterval(timer);await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* A cancelled outstanding read will release naturally. */}}
 };
}
