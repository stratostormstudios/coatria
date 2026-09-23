import {requireMembership} from './auth';
import {transaction} from './db';
import {body,id,json} from './security';
import {executorCredentialInput,getArchiveExecutorCredential,saveArchiveExecutorCredential,revokeArchiveExecutorCredential} from './company-runtime-executor';

/** Human deployment operator only. Token is write-only and never echoed. */
export async function companyRuntimeExecutorRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts[0]!=='operator'||parts[1]!=='companies'||parts[3]!=='runtime-configurations'||parts[4]!=='archive'||parts[6]!=='executor-credentials')return null;
 if(!(parts.length===7&&['GET','POST'].includes(method)||parts.length===8&&method==='DELETE'))return null;
 const member=await requireMembership(request,id(parts[2]),true),configurationId=id(parts[5]);
 if(method==='GET')return json(await transaction(db=>getArchiveExecutorCredential(db,member,configurationId)));
 if(method==='DELETE')return json(await transaction(db=>revokeArchiveExecutorCredential(db,member,configurationId,id(parts[7]))));
 const input=await body(request,executorCredentialInput,6500),result=await transaction(db=>saveArchiveExecutorCredential(db,member,configurationId,input));return json(result,result.replayed?200:201);
}
