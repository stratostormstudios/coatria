import {companyHiggsfieldArchiveAvailability} from './higgsfield-archive-config';
import {requireMembership} from './auth';
import {memberMutation} from './company';
import {assertOrigin,body,id,json} from './security';
import {higgsfieldArchiveProposalInput,higgsfieldArchiveApproveInput,higgsfieldArchiveRevokeInput} from './higgsfield-archive-protocol';
import {proposeHiggsfieldArchive,listHiggsfieldArchives,getHiggsfieldArchive,approveHiggsfieldArchive,revokeHiggsfieldArchive} from './higgsfield-archives';

/** Control-plane metadata only. Media bytes and signed provider locators never
 * enter these session routes; agents use the same service through leased tools. */
export async function higgsfieldArchiveRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='higgsfield'||parts[3]!=='archives')return null;
 const companyId=id(parts[1]),decision=method==='POST'&&parts.length===6&&['approve','revoke'].includes(parts[5]);
 const member=await requireMembership(request,companyId,decision),actor={companyId,userId:member.userId};
 if(method!=='GET')assertOrigin(request);
 if(parts.length===4&&method==='GET'){
  const parameters=Object.fromEntries(new URL(request.url).searchParams);
  const input={...parameters,...parameters.limit!==undefined?{limit:Number(parameters.limit)}:{}};
  return json(await memberMutation(member,false,async db=>({...await listHiggsfieldArchives(db,actor,input),processing:await companyHiggsfieldArchiveAvailability(db,companyId,parameters.projectId)})));
 }
 if(parts.length===4&&method==='POST'){
  const input=await body(request,higgsfieldArchiveProposalInput);
  const result=await memberMutation(member,false,db=>proposeHiggsfieldArchive(db,actor,input));
  return json(result,result.replayed?200:201);
 }
 if(parts.length===5&&method==='GET')return json(await memberMutation(member,false,db=>getHiggsfieldArchive(db,actor,id(parts[4]))));
 if(parts.length===6&&parts[5]==='approve'&&method==='POST'){
  const input=await body(request,higgsfieldArchiveApproveInput);
  return json(await memberMutation(member,true,db=>approveHiggsfieldArchive(db,actor,id(parts[4]),input)));
 }
 if(parts.length===6&&parts[5]==='revoke'&&method==='POST'){
  const input=await body(request,higgsfieldArchiveRevokeInput);
  return json(await memberMutation(member,true,db=>revokeHiggsfieldArchive(db,actor,id(parts[4]),input)));
 }
 return null;
}
