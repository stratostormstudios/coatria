import {requireMembership} from './auth';
import {memberMutation} from './company';
import {assertOrigin,body,id,json} from './security';
import {higgsfieldReferenceProposalInput,higgsfieldReferenceApproveInput,higgsfieldReferenceRevokeInput} from './higgsfield-references-protocol';
import {proposeHiggsfieldReference,listHiggsfieldReferences,listHiggsfieldReferenceCandidates,getHiggsfieldReference,approveHiggsfieldReference,revokeHiggsfieldReference,higgsfieldReferenceAvailability,type HiggsfieldReferenceOptions} from './higgsfield-references';

/** Metadata only: credentials, worker leases and bytes have no public route. */
export async function higgsfieldReferenceRoute(request:Request,parts:string[],method:string,options:HiggsfieldReferenceOptions={}):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='higgsfield'||parts[3]!=='references')return null;
 const companyId=id(parts[1]),decision=method==='POST'&&parts.length===6&&['approve','revoke'].includes(parts[5]);
 const member=await requireMembership(request,companyId,decision),actor={companyId,userId:member.userId};
 if(method!=='GET')assertOrigin(request);
 if((parts.length===4||parts.length===5&&parts[4]==='candidates')&&method==='GET'){
  const input=Object.fromEntries(new URL(request.url).searchParams);
  return json(await memberMutation(member,false,async db=>({...await (parts.length===4?listHiggsfieldReferences(db,actor,input):listHiggsfieldReferenceCandidates(db,actor,input)),processing:await higgsfieldReferenceAvailability(db,companyId,id(input.projectId),options)})));
 }
 if(parts.length===4&&method==='POST'){
  const input=await body(request,higgsfieldReferenceProposalInput);
  const result=await memberMutation(member,false,async db=>({...await proposeHiggsfieldReference(db,actor,input),processing:await higgsfieldReferenceAvailability(db,companyId,input.projectId,options)}));
  return json(result,result.replayed?200:201);
 }
 if(parts.length===5&&method==='GET')return json(await memberMutation(member,false,async db=>{const result=await getHiggsfieldReference(db,actor,id(parts[4]));return {...result,processing:await higgsfieldReferenceAvailability(db,companyId,result.reference.projectId,options)};}));
 if(parts.length===6&&method==='POST'&&['approve','revoke'].includes(parts[5])){
  const input=parts[5]==='approve'?await body(request,higgsfieldReferenceApproveInput):await body(request,higgsfieldReferenceRevokeInput);
  return json(await memberMutation(member,true,async db=>{const result=parts[5]==='approve'?await approveHiggsfieldReference(db,actor,id(parts[4]),input,options):await revokeHiggsfieldReference(db,actor,id(parts[4]),input);return {...result,processing:await higgsfieldReferenceAvailability(db,companyId,result.reference.projectId,options)};}));
 }
 return null;
}
