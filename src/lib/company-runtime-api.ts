import {requireMembership} from './auth';
import {transaction} from './db';
import {body,id,json} from './security';
import {companyRuntimeKind,companyRuntimeSelectInput,companyRuntimeRevokeInput} from './company-runtime-protocol';
import {getCompanyRuntimeConfiguration,selectCompanyRuntimeConfiguration,revokeCompanyRuntimeConfiguration} from './company-runtime-config';

/** Deployment operator session only. Agent bearer tokens do not authorize this route. */
export async function companyRuntimeRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 if(parts.length!==5||parts[0]!=='operator'||parts[1]!=='companies'||parts[3]!=='runtime-configurations')return null;
 const kind=companyRuntimeKind.safeParse(parts[4]);if(!kind.success)return null;
 if(!['GET','POST','PATCH'].includes(method))return null;
 const member=await requireMembership(request,id(parts[2]),true);
 if(method==='GET')return json(await transaction(db=>getCompanyRuntimeConfiguration(db,member,kind.data)));
 const input=await body(request,method==='POST'?companyRuntimeSelectInput:companyRuntimeRevokeInput,220000);
 const result=await transaction(db=>method==='POST'?selectCompanyRuntimeConfiguration(db,member,kind.data,input):revokeCompanyRuntimeConfiguration(db,member,kind.data,input));
 return json(result,method==='POST'&&!result.replayed?201:200);
}
