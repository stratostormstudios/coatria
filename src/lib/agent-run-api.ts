import {body,fail,id,json,rateLimit} from './security';
import {z} from 'zod';
import {requireMembership} from './auth';
import {authenticateAgent} from './integrations';
import {agentRunContext,cancelAgentRun,claimAgentRun,claimInput,completeInput,createAgentRun,failInput,finishAgentRun,getAgentRun,heartbeatAgentRun,leaseInput,listAgentRuns,runInput} from './agent-runs';

export async function agentRunRoute(request:Request,parts:string[],method:string):Promise<Response|null>{
 const agent=parts[0]==='agent'&&parts[1]==='runs';
 const channelRuns=parts[0]==='companies'&&parts[2]==='conversations'&&parts.length===5&&parts[4]==='runs';
 const companyRuns=parts[0]==='companies'&&parts[2]==='agent-runs';
 if(!agent&&!channelRuns&&!companyRuns)return null;
 if(agent){
  const identity=await authenticateAgent(request);
  if(parts.length===3&&parts[2]==='claim'&&method==='POST')return json(await claimAgentRun(identity,await body(request,claimInput)));
  if(parts.length===4){const runId=id(parts[2]);
   if(parts[3]==='context'&&method==='GET')return json(await agentRunContext(identity,runId,request.headers.get('x-coatria-run-lease')||''));
   if(parts[3]==='heartbeat'&&method==='POST')return json(await heartbeatAgentRun(identity,runId,await body(request,leaseInput)));
   if(parts[3]==='complete'&&method==='POST')return json(await finishAgentRun(identity,runId,'complete',await body(request,completeInput)));
   if(parts[3]==='fail'&&method==='POST')return json(await finishAgentRun(identity,runId,'fail',await body(request,failInput)));
  }
  fail(404,'Agent request endpoint not found.');
 }
 const member=await requireMembership(request,id(parts[1]));
 if(method==='GET'){
  await rateLimit(`agent-runs-read:${member.companyId}:${member.userId}`,120,60);
  if(companyRuns&&parts.length===4)return json(await getAgentRun(member,id(parts[3])));
  if(channelRuns||companyRuns&&parts.length===3){const params:Record<string,unknown>={};for(const[key,value]of new URL(request.url).searchParams){if(key in params)fail(400,'Query parameters must not be repeated.');params[key]=key==='limit'?Number(value):value;}return json(await listAgentRuns(member,channelRuns?parts[3]:undefined,params));}
 }
 if(channelRuns&&method==='POST'){await rateLimit(`agent-runs-create:${member.companyId}:${member.userId}`,20,60);const result=await createAgentRun(member,parts[3],await body(request,runInput));return json(result,result.replayed?200:201);}
 if(companyRuns&&parts.length===5&&parts[4]==='cancel'&&method==='POST'){await body(request,z.object({}).strict());return json(await cancelAgentRun(member,id(parts[3])));}
 fail(404,'Agent request endpoint not found.');
}
