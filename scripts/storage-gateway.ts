import {createProjectStorageGateway} from '../src/lib/project-storage-gateway';
import {database,transaction} from '../src/lib/db';
import {ProjectStorageGatewayPreflightError} from '../src/lib/project-storage-preflight';
import {ImagePreparationGatewayDatabaseError} from '../src/lib/project-image-preparation-gateway-database.mjs';
import {createImagePreparationByteGateway} from '../src/lib/project-image-preparation-byte-gateway';
import {createStorageGatewayNodeServer} from '../src/lib/project-storage-gateway-startup';
import {assertStorageGatewayStartupDatabase} from '../src/lib/project-storage-gateway-database';
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
const pool=database();let serving=false,runtime:ReturnType<typeof createStorageGatewayNodeServer>|undefined,cleanupHold:ReturnType<typeof setInterval>|undefined;
function shutdownFailed(){console.error(JSON.stringify({event:'storage-gateway-cleanup-unconfirmed',code:'STORAGE_GATEWAY_CLEANUP_UNCONFIRMED'}));process.exitCode=1;cleanupHold??=setInterval(()=>{},60000); }
try{
 // Inspect the actual authenticated session before opening HTTP or polling the
 // verification queue. SET ROLE from an owner session is not a service LOGIN.
 const client=await pool.connect();let dbCheck;
 try{dbCheck=await assertStorageGatewayStartupDatabase(client,configuration);}finally{client.release();}
 if(preflight){console.log(JSON.stringify({event:'storage-gateway-preflight-passed',database:dbCheck,listening:false,workClaimed:false}));return;}
if(configuration&&Date.now()>=Date.parse(configuration.expiresAt))throw new Error('Gateway deadline ended during preflight.');
const gateway=createProjectStorageGateway({allowedOrigins:[appOrigin],...configuration?{scope:{companyId:configuration.companyId,projectIds:configuration.projectIds},identity}:{}});
const preparation=configuration?.imagePreparation?createImagePreparationByteGateway({transaction,identity:identity!,maxTransfers:configuration.imagePreparation.maxTransfers}):undefined;
runtime=createStorageGatewayNodeServer({gateway,preparation,host,port,maxTransfers:configuration?.maxTransfers??8,expiresAt:configuration?.expiresAt,closePool:()=>pool.end(),onVerificationError:()=>console.error('Storage verification queue unavailable.'),onShutdownError:shutdownFailed});
await runtime.listen();serving=true;
console.log(JSON.stringify({event:'storage-gateway-started',role:dbCheck.role,...preparation?{imagePreparation:true}:{}}));
const stop=()=>void runtime!.stop().catch(shutdownFailed);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
}finally{if(!serving){if(runtime){try{await runtime.stop();}catch(error){shutdownFailed();throw error;}}else await pool.end();}}

}
void main().catch(error=>{console.error(JSON.stringify({event:'storage-gateway-startup-failed',code:error instanceof ProjectStorageGatewayPreflightError||error instanceof ImagePreparationGatewayDatabaseError?error.code:'STORAGE_GATEWAY_CONFIGURATION_INVALID'}));process.exitCode=1;});
