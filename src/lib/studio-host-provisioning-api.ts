import {z} from 'zod';
import {requireMembership} from './auth';
import {memberMutation} from './company';
import {body,fail,id,json,rateLimit} from './security';
import {readStudioHostProviderReadiness} from './studio-host-readiness';
import {studioHostProvisionPlanInput,studioHostProvisionStartInput,studioHostProvisionStopInput} from './studio-host-provisioning-protocol';
import {createStudioHostProvisionPlan,startStudioHostProvision,stopStudioHostProvision,getStudioHostProvision,listStudioHostProvisions,reconcileStudioHostProvision} from './studio-host-provisioning';

/** Provider effects occur only after the approval/stop receipt commits. */
export async function studioHostProvisioningRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='host-provisions')return null;
 const member=await requireMembership(request,id(parts[1]),true);
 if(parts.length===4&&method==='GET')return json(await memberMutation(member,true,client=>listStudioHostProvisions(client,member.companyId)));
 if(parts.length===4&&method==='POST'){
  const data=await body(request,studioHostProvisionPlanInput);
  const result=await memberMutation(member,true,client=>createStudioHostProvisionPlan(client,member,data));
  return json(result,result.replayed?200:201);
 }
 if(parts.length<5)return null;
 const provisionId=id(parts[4]);
 if(parts.length===6&&parts[5]==='readiness'&&method==='GET'){
  if(new URL(request.url).search)fail(400,'Provider readiness does not accept query parameters.','VALIDATION_ERROR');
  await rateLimit(`studio-cpu-readiness:${member.companyId}:${member.userId}`,4,60);
  const readiness=await readStudioHostProviderReadiness(member,provisionId);
  await requireMembership(request,member.companyId,true);
  return json({readiness});
 }
 if(parts.length===5&&method==='GET')return json({provision:await memberMutation(member,true,client=>getStudioHostProvision(client,member.companyId,provisionId))});
 if(parts.length!==6||method!=='POST')return null;
 const action=parts[5];if(!['start','stop','reconcile'].includes(action))return null;
 await rateLimit(`studio-cpu:${member.companyId}:${member.userId}`,12,60);
 if(action==='reconcile'){
  await body(request,z.object({clientId:z.string().uuid()}).strict());
  await memberMutation(member,true,client=>getStudioHostProvision(client,member.companyId,provisionId));
  await reconcileStudioHostProvision(provisionId);
  return json({provision:await memberMutation(member,true,client=>getStudioHostProvision(client,member.companyId,provisionId))});
 }
 const data=await body(request,action==='start'?studioHostProvisionStartInput:studioHostProvisionStopInput);
 const result=action==='start'
  ?await memberMutation(member,true,client=>startStudioHostProvision(client,member,provisionId,data))
  :await memberMutation(member,true,client=>stopStudioHostProvision(client,member,provisionId,data));
 await reconcileStudioHostProvision(provisionId);
 return json({...result,provision:await memberMutation(member,true,client=>getStudioHostProvision(client,member.companyId,provisionId))});
}
