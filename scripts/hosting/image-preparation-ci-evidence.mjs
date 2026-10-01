/** CI artifact preservation only. These bindings cannot accept a host, enroll a
 * processor, or authorize any image processing. Original report bytes remain
 * separate from the existing host qualification/acceptance contract. */
import {join} from 'node:path';
import {archiveHostHash,archiveHostRead} from './archive-host-package.mjs';

const fail=()=>{throw Error('IMAGE_PREPARATION_CI_EVIDENCE_INVALID');};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const parse=bytes=>{if(!Buffer.isBuffer(bytes)||bytes.length<2||bytes.length>1024**2)fail();try{const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))fail();return value;}catch{fail();}};

/** @param {{directory:string,qualificationBytes:Buffer,hostEvidenceBytes?:Buffer,sourceCommit:string,sourceTree:string|null,bundleSha256:string|null,invocationId?:string|null}} input */
export async function collectImagePreparationCiEvidence({directory,qualificationBytes,hostEvidenceBytes,sourceCommit,sourceTree,bundleSha256,invocationId=null}){
 if(!commit(sourceCommit)||sourceTree!==null&&!commit(sourceTree)||bundleSha256!==null&&!digest(bundleSha256))fail();
 const qualification=parse(qualificationBytes),imageBytes=await archiveHostRead(join(directory,'image-preparation-transform.json'),1024**2),image=parse(imageBytes);
 if(image.version!==1||image.kind!=='image-preparation-isolated-linux-transform'||image.productionQualified!==false||image.installedServiceQualified!==false||image.enrollmentExercised!==false||image.remoteTransportExercised!==false||image.providerCalls!==0||!digest(image.recipeSha256)||!Array.isArray(image.cases)||image.cases.length>6)fail();
 const qualifiedInvocation=hostEvidenceBytes!==undefined;
 if(qualifiedInvocation){
  const host=parse(hostEvidenceBytes),actualInvocation=host.qualifierInvocationId??host.invocationId;
  if(!/^(?!0{32}$)[a-f0-9]{32}$/.test(invocationId??'')||actualInvocation!==invocationId||(host.sourceCommit??host.commit)!==sourceCommit||host.sourceTree!==undefined&&host.sourceTree!==sourceTree||host.bundleSha256!==bundleSha256||(host.reportSha256??host.qualificationSha256)!==archiveHostHash(qualificationBytes)||host.qualified!==true||qualification.qualified!==true)fail();
  if(image.passed!==true||image.actualLinuxTransform!==true||!Number.isSafeInteger(image.qualificationExecutions)||image.qualificationExecutions<1||image.profileSha256!==qualification.profiles?.real?.expectedProfileSha256||!digest(image.profileSha256))fail();
  const names=['png','jpeg','webp','wrong-source-hash','pre-aborted','cancel-native'];
  if(image.cases.length!==names.length||image.cases.some((value,index)=>value?.name!==names[index]||value.passed!==true||value.drainedAtReturn!==true||value.sourceHandleClosedAtReturn!==true||value.sourceUnchanged!==true||!Array.isArray(value.nativeEvidence)||value.nativeEvidence.some(event=>event?.drained!==true)||value.nativeExecutions!==value.nativeEvidence.length))fail();
  for(const value of image.cases){
   if(['png','jpeg','webp'].includes(value.name)){if(!digest(value.outputSha256)||!Number.isSafeInteger(value.outputBytes)||value.outputBytes<1||value.outputBytes>10*1024**2||value.failureCode!==null||value.nativeExecutions<1)fail();}
   else {
    if(value.failureCode!==(value.name==='wrong-source-hash'?'PREPARATION_BYTES_CHANGED':'PREPARATION_ABORTED')||value.outputSha256!==null||value.outputBytes!==null)fail();
    if(value.name==='cancel-native'){if(value.cancelledDuringNativeRun!==true||value.observedProcesses<1||value.nativeExecutions<1)fail();}else if(value.nativeExecutions!==0)fail();
   }
  }
 }else if(invocationId!==null)fail();
 const binding={version:1,kind:'image-preparation-ci-evidence-binding',sourceCommit,sourceTree,bundleSha256,invocationId,qualifiedInvocation,acceptanceAuthority:false,hostEvidenceSha256:qualifiedInvocation?archiveHostHash(hostEvidenceBytes):null,qualificationSha256:archiveHostHash(qualificationBytes),imagePreparationSha256:archiveHostHash(imageBytes),recipeSha256:image.recipeSha256,profileSha256:image.profileSha256??null,passed:image.passed===true};
 return {imageBytes,bindingBytes:Buffer.from(JSON.stringify(binding,null,2)+'\n')};
}

export function preserveImagePreparationCiEvidence(exports,prefix,collected){
 if(!/^(?:archive-host|reference-host|reference-enrollment)-(?:first|second|unaccepted-[1-9]\d*)$/.test(prefix)&&prefix!=='reference-enrollment')fail();
 for(const [name,bytes]of [['image-preparation-transform',collected.imageBytes],['image-preparation-binding',collected.bindingBytes]]){
  const file=prefix+'-'+name+'.json';if(exports.has(file))fail();exports.set(file,bytes);
 }
}
