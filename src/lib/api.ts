import { assertOrigin, errorResponse, fail, json, rateLimit } from './security';
import { currentUser } from './auth';
import { identityRoute } from './identity';
import { companyRoute } from './company';
import { workRoute } from './work';
import { integrationRoute } from './integrations';
import { talentRoute } from './talent';
import { conversationRoute } from './conversation-api';
import { randomUUID } from 'node:crypto';

export async function handleApi(request: Request, parts: string[]): Promise<Response> {
  const requestId=randomUUID(),started=performance.now();
  const conversation=parts[0]==='agent'&&parts[1]==='conversations'||parts[0]==='companies'&&parts[2]==='conversations';
  const finish=(response:Response)=>{
    response.headers.set('X-Request-Id',requestId);
    const durationMs=Math.round(performance.now()-started);
    if(conversation&&(response.status>=500||response.status===429||durationMs>=1500)){
      // Operational correlation without message text, credentials, tenant/user IDs or raw URLs.
      const tail=parts.slice(parts[0]==='agent'?2:3);
      const operation=tail.includes('reactions')?'reactions':tail[1]==='read'?'read':tail[1]==='events'?'events':tail[1]==='messages'?'messages':'list';
      console.warn('Coatria conversation request',JSON.stringify({requestId,method:request.method,operation,actor:parts[0]==='agent'?'agent':'human',status:response.status,durationMs}));
    }
    return response;
  };
  try {
    const method=request.method.toUpperCase();
    const bearerEndpoint=(parts[0]==='agent'||parts[0]==='connector');
    if(!['GET','HEAD'].includes(method)&&!bearerEndpoint)assertOrigin(request);
    if(!process.env.DATABASE_URL) {
      if(parts.join('/')==='session'&&method==='GET')return finish(json({user:null,companies:[],configured:false}));
      if(parts.join('/')==='opportunities'&&method==='GET')return finish(json({openings:[],configured:false}));
      return finish(json({error:'Coatria is awaiting its production database setup. Accounts and workspaces will open when setup is complete.',code:'SETUP_REQUIRED',configured:false},503));
    }
    if(!['GET','HEAD'].includes(method)&&!bearerEndpoint&&!['auth'].includes(parts[0])) {
      const user=await currentUser(request);if(user)await rateLimit(`write:${user.id}`,240,60);
    }
    for(const handler of [identityRoute,conversationRoute,companyRoute,workRoute,integrationRoute,talentRoute]) {
      const result=await handler(request,parts,method);if(result)return finish(result);
    }
    fail(404,'API endpoint not found.');
  }catch(error){return finish(errorResponse(error));}
}
