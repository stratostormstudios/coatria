import { assertOrigin, errorResponse, fail, json, rateLimit } from './security';
import { currentUser } from './auth';
import { identityRoute } from './identity';
import { companyRoute } from './company';
import { workRoute } from './work';
import { integrationRoute } from './integrations';
import { talentRoute } from './talent';

export async function handleApi(request: Request, parts: string[]): Promise<Response> {
  try {
    const method=request.method.toUpperCase();
    const bearerEndpoint=(parts[0]==='agent'||parts[0]==='connector');
    if(!['GET','HEAD'].includes(method)&&!bearerEndpoint)assertOrigin(request);
    if(!process.env.DATABASE_URL) {
      if(parts.join('/')==='session'&&method==='GET')return json({user:null,companies:[],configured:false});
      if(parts.join('/')==='opportunities'&&method==='GET')return json({openings:[],configured:false});
      return json({error:'Coatria is awaiting its production database setup. Accounts and workspaces will open when setup is complete.',code:'SETUP_REQUIRED',configured:false},503);
    }
    if(!['GET','HEAD'].includes(method)&&!bearerEndpoint&&!['auth'].includes(parts[0])) {
      const user=await currentUser(request);if(user)await rateLimit(`write:${user.id}`,240,60);
    }
    for(const handler of [identityRoute,companyRoute,workRoute,integrationRoute,talentRoute]) {
      const result=await handler(request,parts,method);if(result)return result;
    }
    fail(404,'API endpoint not found.');
  }catch(error){return errorResponse(error);}
}
