import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createProjectStorageGateway} from '../src/lib/project-storage-gateway';
import {database} from '../src/lib/db';

if(!process.env.DATABASE_URL||!process.env.COATRIA_HOSTING_KEYRING)throw new Error('Storage gateway database and credential vault must be configured.');
const port=Number(process.env.PORT||4190),host=process.env.HOST||'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid gateway port.');
const appOrigin=new URL(process.env.APP_URL||'https://coatria.com').origin;
if(process.env.NODE_ENV==='production'&&!appOrigin.startsWith('https://'))throw new Error('Production requires an HTTPS application origin.');
const gateway=createProjectStorageGateway({allowedOrigins:[appOrigin]});
let active=0,verifying=false,closing=false;
const server=createServer(async(req,res)=>{
 if(closing||active>=8){res.writeHead(503,{'Content-Type':'application/json','Retry-After':'5'});res.end(JSON.stringify({error:'The transfer service is busy. Check upload status before retrying.',code:'STORAGE_TRANSFER_LIMIT'}));return;}
 active++;const abort=new AbortController();req.on('aborted',()=>abort.abort());res.on('close',()=>{if(!res.writableFinished)abort.abort();});
 try{
  // The Host header never chooses an upstream destination or an access scope.
  const url=new URL(req.url||'/','http://127.0.0.1:'+port);
  const headers=new Headers();for(const[key,value]of Object.entries(req.headers)){if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);}
  const method=req.method||'GET';
  const request=new Request(url,{method,headers,signal:abort.signal,...!['GET','HEAD'].includes(method)?{body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'}:{}} as RequestInit);
  const response=await gateway.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body)await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),res);else res.end();
 }catch{if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Transfer interrupted. Check its status before retrying.',code:'STORAGE_OUTCOME_UNCERTAIN'}));}else res.destroy();}
 finally{active--;}
});
server.requestTimeout=5*60*1000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;
const worker=setInterval(()=>{if(verifying||closing)return;verifying=true;void gateway.verifyNext().catch(()=>{console.error('Storage verification queue unavailable.');}).finally(()=>{verifying=false;});},2000);
server.listen(port,host,()=>console.log(`Coatria storage transfer service listening on ${host}:${port}.`));
async function stop(){if(closing)return;closing=true;clearInterval(worker);server.close();server.closeIdleConnections();const deadline=Date.now()+30000;while((active||verifying)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));await database().end();process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
