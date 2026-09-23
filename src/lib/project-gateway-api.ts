import {requireMembership} from './auth';
import {memberMutation} from './company';
import {body,id,json,rateLimit} from './security';
import {verifiedProjectGateway,verifyAndBindProjectGateway,revokeProjectGateway,verifyProjectGatewayInput,revokeProjectGatewayInput} from './project-gateway-bindings';
/** Human company administrators may verify a fixed provision; never a URL. */
export async function projectGatewayRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts.length!==6||parts[0]!=='companies'||parts[2]!=='studio'||parts[3]!=='projects'||parts[5]!=='gateway')return null;
 const member=await requireMembership(request,id(parts[1]),true),projectId=id(parts[4]);
 if(method==='GET')return json({gateway:await memberMutation(member,true,db=>verifiedProjectGateway(db,member.companyId,projectId))});
 if(method==='POST'){await rateLimit(`gateway-verify:${member.companyId}:${member.userId}`,6,60);const data=await body(request,verifyProjectGatewayInput);return json(await memberMutation(member,true,db=>verifyAndBindProjectGateway(db,member,projectId,data)));}
 if(method==='DELETE'){const data=await body(request,revokeProjectGatewayInput);return json(await memberMutation(member,true,db=>revokeProjectGateway(db,member,projectId,data)));}return null;
}
