import {z} from 'zod';
import {requireMembership} from './auth';
import {memberMutation} from './company';
import {body,id,json,rateLimit} from './security';
import {trustedServicePlanInput,trustedServiceStartInput,trustedServiceStopInput} from './trusted-service-protocol';
import {planTrustedService,startTrustedService,stopTrustedService,getTrustedServiceProvision,listTrustedServiceProvisions,reconcileTrustedService} from './trusted-service-provisioning';

/** Human owner/admin only. Provider effects start after a durable approval. */
export async function trustedServiceRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='trusted-services')return null;
 const member=await requireMembership(request,id(parts[1]),true);
 if(parts.length===4&&method==='GET')return json(await memberMutation(member,true,db=>listTrustedServiceProvisions(db,member.companyId)));
 if(parts.length===4&&method==='POST'){
  await rateLimit(`trusted-service:${member.companyId}:${member.userId}`,12,60);
  const data=await body(request,trustedServicePlanInput),result=await memberMutation(member,true,db=>planTrustedService(db,member,data));return json(result,result.replayed?200:201);
 }
 if(parts.length<5)return null;const provisionId=id(parts[4]);
 if(parts.length===5&&method==='GET')return json({provision:await memberMutation(member,true,db=>getTrustedServiceProvision(db,member.companyId,provisionId))});
 if(parts.length!==6||method!=='POST'||!['start','stop','reconcile'].includes(parts[5]))return null;
 await rateLimit(`trusted-service:${member.companyId}:${member.userId}`,12,60);
 if(parts[5]==='reconcile'){
  await body(request,z.object({clientId:z.uuid()}).strict());await memberMutation(member,true,db=>getTrustedServiceProvision(db,member.companyId,provisionId));await reconcileTrustedService(provisionId);
  return json({provision:await memberMutation(member,true,db=>getTrustedServiceProvision(db,member.companyId,provisionId))});
 }
 const data=await body(request,parts[5]==='start'?trustedServiceStartInput:trustedServiceStopInput);
 const result=await memberMutation(member,true,db=>parts[5]==='start'?startTrustedService(db,member,provisionId,data):stopTrustedService(db,member,provisionId,data));
 await reconcileTrustedService(provisionId);return json({...result,provision:await memberMutation(member,true,db=>getTrustedServiceProvision(db,member.companyId,provisionId))});
}
