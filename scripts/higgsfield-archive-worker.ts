/** Separate trusted Node process. Never import this entry point into Vercel. */
import {setTimeout as delay} from 'node:timers/promises';
import {database} from '../src/lib/db';
import {higgsfieldArchiveAvailability} from '../src/lib/higgsfield-archive-config';
import {createHiggsfieldOutputFetcher} from '../src/lib/higgsfield-output-fetch';
import {inspectHiggsfieldArchiveMedia} from '../src/lib/higgsfield-media-inspection';
import {createHiggsfieldArchiveWorker} from '../src/lib/higgsfield-archive-worker';
import {createLinuxMediaSandbox} from '../src/lib/higgsfield-media-sandbox';
import {assertHiggsfieldArchiveDatabase,assertHiggsfieldArchiveScratchRoot,HiggsfieldArchivePreflightError} from '../src/lib/higgsfield-archive-preflight';
import {hostingEncryptionConfigured} from '../src/lib/studio-hosting';

async function main(){
 const args=process.argv.slice(2),preflight=args.length===1&&args[0]==='--preflight';
 if(args.length&&!preflight)throw Error('Use no arguments to run the worker or --preflight to check it without claims.');
 if(!preflight&&!higgsfieldArchiveAvailability().enabled)throw Error('Archive processing is disabled. Configure the dedicated worker before enabling archive approvals.');
 if(!process.env.DATABASE_URL||!process.env.COATRIA_HOSTING_KEYRING)throw Error('The dedicated archive database role and encryption keyring must be configured.');
 if(!hostingEncryptionConfigured())throw Error('The archive encryption keyring is invalid.');
 const pool=database();
 try{
 const dbCheck=await assertHiggsfieldArchiveDatabase(pool);
 const scratchRoot=await assertHiggsfieldArchiveScratchRoot(process.env.COATRIA_ARCHIVE_SCRATCH_ROOT??'');
 if(process.platform!=='win32'&&process.getuid?.()===0)throw Error('Run the archive worker as a dedicated unprivileged service user.');
 const hosts=(process.env.COATRIA_HIGGSFIELD_OUTPUT_HOSTS??'').split(',').map(value=>value.trim()).filter(Boolean);
 if(!hosts.length||hosts.length>20)throw Error('Configure a reviewed exact hostname allowlist for Higgsfield output storage.');
 const maxBytes=Number(process.env.COATRIA_ARCHIVE_MAX_SOURCE_BYTES??536870912),deadline=Number(process.env.COATRIA_ARCHIVE_OPERATION_MS??1800000);
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>100*1024**3||!Number.isSafeInteger(deadline)||deadline<1000||deadline>7200000)throw Error('Use bounded archive byte and time limits.');
 const fetchOutput=createHiggsfieldOutputFetcher({allowedHosts:hosts});
 const sandbox=await createLinuxMediaSandbox({profilePath:process.env.COATRIA_MEDIA_SANDBOX_PROFILE??'',expectedProfileSha256:process.env.COATRIA_MEDIA_SANDBOX_PROFILE_SHA256??'',cgroupRoot:process.env.COATRIA_MEDIA_CGROUP_ROOT??''});
 if(preflight){console.log(JSON.stringify({event:'archive-worker-preflight-passed',database:dbCheck,sandbox:'qualified',processingEnabled:higgsfieldArchiveAvailability().enabled,workClaimed:false}));return;}
 const worker=createHiggsfieldArchiveWorker({scratchRoot,operationDeadlineMs:deadline,fetchOutput:input=>fetchOutput({...input,maxBytes:Math.min(input.maxBytes,maxBytes)}),inspectMedia:input=>inspectHiggsfieldArchiveMedia(input,{sandbox,limits:{maxBytes}})});
 const stop=new AbortController();
 const close=()=>stop.abort();process.once('SIGTERM',close);process.once('SIGINT',close);
 console.log(JSON.stringify({event:'archive-worker-started',concurrency:1,maxBytes,deadlineMs:deadline}));
 try{
  while(!stop.signal.aborted){
   try{const result=await worker.runNext({signal:stop.signal});if(result.processed)console.log(JSON.stringify({event:'archive-attempt-recorded',...result}));}
   catch{console.error(JSON.stringify({event:'archive-worker-unavailable'}));}
   if(!stop.signal.aborted)await delay(2000,undefined,{signal:stop.signal}).catch(()=>{});
  }
 }finally{process.removeListener('SIGTERM',close);process.removeListener('SIGINT',close);}
 }finally{await pool.end();}
}
void main().catch(error=>{console.error(JSON.stringify({event:'archive-worker-startup-failed',code:error instanceof HiggsfieldArchivePreflightError?error.code:'ARCHIVE_WORKER_CONFIGURATION_INVALID'}));process.exitCode=1;});
