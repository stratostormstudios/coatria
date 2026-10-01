import {requireMembership} from './auth';
import {memberMutation} from './company';
import {assertOrigin,body,id,json} from './security';
import {projectImagePreparationProposalInput,projectImagePreparationApproveInput,projectImagePreparationRevokeInput} from './project-image-preparations-protocol';
import {proposeProjectImagePreparation,getProjectImagePreparation,listProjectImagePreparations,approveProjectImagePreparation,revokeProjectImagePreparation,type ProjectImagePreparationOptions} from './project-image-preparations';

/** Metadata only. Processor availability comes from a trusted server resolver,
 * never a request body. No lease, native execution or storage write route. */
export async function projectImagePreparationRoute(request:Request,parts:string[],method:string,options:ProjectImagePreparationOptions={}):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='image-preparations')return null;
 const companyId=id(parts[1]),decision=method==='POST'&&parts.length===5&&['approve','revoke'].includes(parts[4]);
 const member=await requireMembership(request,companyId,decision),actor={companyId,userId:member.userId};
 if(method!=='GET')assertOrigin(request);
 if(parts.length===3&&method==='GET')return json(await memberMutation(member,false,db=>listProjectImagePreparations(db,actor,Object.fromEntries(new URL(request.url).searchParams))));
 if(parts.length===3&&method==='POST'){
  const input=await body(request,projectImagePreparationProposalInput),result=await memberMutation(member,false,db=>proposeProjectImagePreparation(db,actor,input));
  return json(result,result.replayed?200:201);
 }
 if(parts.length===4&&method==='GET')return json(await memberMutation(member,false,db=>getProjectImagePreparation(db,actor,id(parts[3]))));
 if(decision){
  const input=parts[4]==='approve'?await body(request,projectImagePreparationApproveInput):await body(request,projectImagePreparationRevokeInput);
  return json(await memberMutation(member,true,db=>parts[4]==='approve'?approveProjectImagePreparation(db,actor,id(parts[3]),input,options):revokeProjectImagePreparation(db,actor,id(parts[3]),input)));
 }
 return null;
}
