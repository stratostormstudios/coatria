import {callHiggsfieldTool,type HiggsfieldTool,type HiggsfieldToolResult} from './higgsfield-mcp';
import {buildReferenceUploadArguments,buildReferenceConfirmArguments,parseReferenceAllocation,parseReferenceConfirmation,referenceCatalogDigest} from './higgsfield-reference-provider';
import type {HiggsfieldReferenceLease,HiggsfieldReferenceAllocation,HiggsfieldReferencePhaseResult} from './higgsfield-references-protocol';
import {fail} from './security';

export type HiggsfieldReferenceProviderAuthority={connectionId:string;connectionRevision:number;catalogSha256:string;tools:HiggsfieldTool[]};
/** Construct inside the trusted control plane only. None of these callbacks or
 * the credential result is an API/agent tool, environment switch or worker grant. */
export type HiggsfieldReferenceBrokerDependencies={
 authority:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<HiggsfieldReferenceProviderAuthority>;
 credential:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>Promise<HiggsfieldReferenceProviderAuthority&{token:string}>;
 beginPhase:(lease:HiggsfieldReferenceLease,phase:'allocate'|'confirm')=>Promise<string>;
 completePhase:(lease:HiggsfieldReferenceLease,actionId:string,result:HiggsfieldReferencePhaseResult)=>Promise<unknown>;
 failPhase:(lease:HiggsfieldReferenceLease,actionId:string,code:string)=>Promise<unknown>;
 allocation:(lease:HiggsfieldReferenceLease)=>Promise<HiggsfieldReferenceAllocation>;
 call?:(token:string,name:string,args:Record<string,unknown>,transport:{signal:AbortSignal;timeoutMs:number})=>Promise<HiggsfieldToolResult>;
};
function changed():never{fail(409,'The reference transfer authority changed. Review its current state.','HIGGSFIELD_REFERENCE_AUTHORITY_CHANGED');}
function same(a:HiggsfieldReferenceProviderAuthority,b:HiggsfieldReferenceProviderAuthority){
 if(a.connectionId!==b.connectionId||a.connectionRevision!==b.connectionRevision||a.catalogSha256!==b.catalogSha256||referenceCatalogDigest(a.tools)!==referenceCatalogDigest(b.tools))changed();
}
function active(lease:HiggsfieldReferenceLease,signal:AbortSignal){
 if(signal.aborted||lease.phase!=='transfer'||!Number.isFinite(Date.parse(lease.expiresAt))||Date.parse(lease.expiresAt)<=Date.now())changed();
}
export function createHiggsfieldReferenceBroker(deps:HiggsfieldReferenceBrokerDependencies){
 const invoke=deps.call??callHiggsfieldTool;
 async function perform(lease:HiggsfieldReferenceLease,phase:'allocate'|'confirm',signal:AbortSignal){
  active(lease,signal);
  const before=await deps.authority(lease,signal);referenceCatalogDigest(before.tools);
  const allocation=phase==='confirm'?await deps.allocation(lease):null;
  const args=allocation?buildReferenceConfirmArguments(before.tools,allocation.mediaId):buildReferenceUploadArguments(before.tools,lease);
  // Refresh is control-plane owned and occurs before the phase intent. The
  // source, approval and catalog must still match after any refresh.
  const saved=await deps.credential(lease,signal);same(before,saved);active(lease,signal);
  same(before,await deps.authority(lease,signal));
  // Must commit before any mutating RPC. A phase intent is never reclaimed.
  const actionId=await deps.beginPhase(lease,phase);
  try{
   active(lease,signal);same(before,await deps.authority(lease,signal));
   const result=await invoke(saved.token,phase==='allocate'?'media_upload':'media_confirm',args,{signal,timeoutMs:20000});
   active(lease,signal);
   const parsed:HiggsfieldReferencePhaseResult=allocation?{phase:'confirm',...parseReferenceConfirmation(result,allocation.mediaId)}:{phase:'allocate',allocation:parseReferenceAllocation(result,lease.proxy.contentType)};
   // completePhase rechecks durable authority and exact action identity.
   await deps.completePhase(lease,actionId,parsed);
  }catch{
   // Even a response/commit failure can follow success at the provider. Retain
   // the fence if journaling also fails; never return a retryable raw exception.
   try{await deps.failPhase(lease,actionId,'HIGGSFIELD_REFERENCE_OUTCOME_UNCERTAIN');}catch{}
   fail(409,'This reference phase has an uncertain outcome and needs review. It will not be repeated.','HIGGSFIELD_REFERENCE_OUTCOME_UNCERTAIN');
  }
 }
 return {
  allocate:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>perform(lease,'allocate',signal),
  confirm:(lease:HiggsfieldReferenceLease,signal:AbortSignal)=>perform(lease,'confirm',signal),
  async uploadCapability(lease:HiggsfieldReferenceLease,signal:AbortSignal){
   active(lease,signal);const authority=await deps.authority(lease,signal);referenceCatalogDigest(authority.tools);
   const allocation=await deps.allocation(lease);active(lease,signal);
   if(!Number.isFinite(Date.parse(allocation.expiresAt))||Date.parse(allocation.expiresAt)<=Date.now())changed();
   return allocation;
  },
 };
}
