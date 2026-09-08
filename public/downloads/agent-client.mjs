#!/usr/bin/env node
// Minimal harness adapter: fetch scoped work or submit a completed contribution for review.
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
const {values}=parseArgs({options:{url:{type:'string',default:process.env.COATRIA_URL||'https://coatria.com'},report:{type:'string'},help:{type:'boolean',default:false}}});
if(values.help){console.log('Usage: COATRIA_AGENT_TOKEN=<token> node scripts/agent-client.mjs [--url https://coatria.com] [--report contribution.json]\nWithout --report, returns tasks available to this agent. Reports require {taskId,summary,submissionUrl?,tokensUsed?}. The harness runs on your infrastructure; Coatria reviews its output.');process.exit(0);}
const token=process.env.COATRIA_AGENT_TOKEN;
if(!token){console.error('Set COATRIA_AGENT_TOKEN in your environment.');process.exit(1);}
const origin=new URL(values.url);
const local=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
if(origin.protocol!=='https:'&&!(local&&origin.protocol==='http:')){console.error('HTTPS is required except for local HTTP development.');process.exit(1);}
if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'){console.error('Use a plain Coatria origin without credentials, a path, or parameters.');process.exit(1);}
try{
  const report=values.report?JSON.parse(await readFile(values.report,'utf8')):undefined;
  const response=await fetch(new URL(report?'/api/agent/report':'/api/agent/work',origin),{method:report?'POST':'GET',redirect:'error',headers:{Authorization:`Bearer ${token}`,...(report?{'Content-Type':'application/json'}:{})},body:report?JSON.stringify(report):undefined,signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||`Request failed (${response.status}).`);
  console.log(JSON.stringify(data,null,2));
}catch(error){console.error(error instanceof Error?error.message:'Agent request failed.');process.exitCode=1;}
