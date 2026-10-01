import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createProjectStorageGateway} from '../src/lib/project-storage-gateway';
import {database} from '../src/lib/db';
import {assertProjectStorageGatewayDatabase,ProjectStorageGatewayPreflightError} from '../src/lib/project-storage-preflight';
import {hostingEncryptionConfigured} from '../src/lib/studio-hosting';
import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {assertRemoteArchiveImmutableFile,parseRemoteArchiveArguments} from '../src/lib/higgsfield-remote-archive-config';
import {parseTrustedServiceGatewayConfiguration,trustedServiceHash} from '../src/lib/trusted-service-config';
import {gatewayIdentitySchema} from '../src/lib/project-gateway-identity';

async function main(){
const args=process.argv.slice(2);let preflight=args.length===1&&args[0]==='--preflight',configuration:ReturnType<typeof parseTrustedServiceGatewayConfiguration>|undefined;
if(args.includes('--config')){
 const cli=parseRemoteArchiveArguments(args);preflight=cli.preflight;await assertRemoteArchiveImmutableFile(fileURLToPath(import.meta.url));await assertRemoteArchiveImmutableFile(cli.path);
 if((await lstat(cli.path)).size>32768)throw new Error('Invalid gateway configuration.');const bytes=await readFile(cli.path);if(createHash('sha256').update(bytes).digest('hex')!==cli.sha256)throw new Error('Invalid gateway configuration hash.');configuration=parseTrustedServiceGatewayConfiguration(JSON.parse(bytes.toString('utf8')));
 const remaining=Date.parse(configuration.expiresAt)-Date.now();if(remaining<=0||remaining>86400000)throw new Error('Invalid gateway deadline.');
}else if(args.length&&!preflight)throw new Error('Invalid gateway arguments.');
if(!process.env.DATABASE_URL||!process.env.COATRIA_HOSTING_KEYRING)throw new Error('Storage gateway database and credential vault must be configured.');
if(!hostingEncryptionConfigured())throw new Error('Invalid storage credential vault.');
const port=configuration?.port??Number(process.env.PORT||4190),host=configuration?.host??process.env.HOST??'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid gateway port.');
const appOrigin=new URL(configuration?.appOrigin??process.env.APP_URL??'https://coatria.com').origin;
if(process.env.NODE_ENV==='production'&&!appOrigin.startsWith('https://'))throw new Error('Production requires an HTTPS application origin.');
const identity=configuration?gatewayIdentitySchema.parse({version:1,companyId:configuration.companyId,projectIds:configuration.projectIds,provisionId:process.env.COATRIA_SERVICE_PROVISION_ID,configurationHash:trustedServiceHash(configuration),sourceCommit:configuration.sourceCommit,expiresAt:configuration.expiresAt}):undefined;
const pool=database();let serving=false;
try{
 // Inspect the actual authenticated session before opening HTTP or polling the
 // verification queue. SET ROLE from an owner session is not a service LOGIN.
 const client=await pool.connect();let dbCheck;
 try{dbCheck=await assertProjectStorageGatewayDatabase(client);}finally{client.release();}
 if(preflight){console.log(JSON.stringify({event:'storage-gateway-preflight-passed',database:dbCheck,listening:false,workClaimed:false}));return;}
if(configuration&&Date.now()>=Date.parse(configuration.expiresAt))throw new Error('Gateway deadline ended during preflight.');
const gateway=createProjectStorageGateway({allowedOrigins:[appOrigin],...configuration?{scope:{companyId:configuration.companyId,projectIds:configuration.projectIds},identity}:{}});
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
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});
serving=true;
const worker=setInterval(()=>{if(verifying||closing)return;verifying=true;void gateway.verifyNext().catch(()=>{console.error('Storage verification queue unavailable.');}).finally(()=>{verifying=false;});},2000);
console.log(JSON.stringify({event:'storage-gateway-started',role:dbCheck.role}));
const expiryTimer=configuration?setTimeout(()=>void stop(),Math.max(1,Date.parse(configuration.expiresAt)-Date.now())):undefined;
async function stop(){if(closing)return;closing=true;clearInterval(worker);clearTimeout(expiryTimer);server.close();server.closeIdleConnections();const deadline=Date.now()+30000;while((active||verifying)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));await database().end();process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
}finally{if(!serving)await pool.end();}
}
void main().catch(error=>{console.error(JSON.stringify({event:'storage-gateway-startup-failed',code:error instanceof ProjectStorageGatewayPreflightError?error.code:'STORAGE_GATEWAY_CONFIGURATION_INVALID'}));process.exitCode=1;});
