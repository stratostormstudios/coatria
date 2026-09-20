/** Separate trusted Node process. Never import this entry point into Vercel. */
import {isAbsolute} from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {database} from '../src/lib/db';
import {higgsfieldArchiveAvailability} from '../src/lib/higgsfield-archive-config';
import {createHiggsfieldOutputFetcher} from '../src/lib/higgsfield-output-fetch';
import {inspectHiggsfieldArchiveMedia} from '../src/lib/higgsfield-media-inspection';
import {createHiggsfieldArchiveWorker} from '../src/lib/higgsfield-archive-worker';

async function main(){
 if(!higgsfieldArchiveAvailability().enabled)throw Error('Archive processing is disabled. Configure the dedicated worker before enabling archive approvals.');
 if(!process.env.DATABASE_URL||!process.env.COATRIA_HOSTING_KEYRING)throw Error('The dedicated archive database role and encryption keyring must be configured.');
 const scratchRoot=process.env.COATRIA_ARCHIVE_SCRATCH_ROOT,ffprobePath=process.env.COATRIA_FFPROBE_PATH,ffmpegPath=process.env.COATRIA_FFMPEG_PATH;
 for(const path of [scratchRoot,ffprobePath,ffmpegPath])if(!path||!isAbsolute(path))throw Error('Archive scratch and decoder paths must be explicitly configured absolute paths.');
 const info=await lstat(scratchRoot!);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Use a private regular scratch directory.');
 if(process.platform!=='win32'&&(info.mode&0o077)!==0)throw Error('Archive scratch directory must have mode 0700.');
 if(process.platform!=='win32'&&process.getuid?.()===0)throw Error('Run the archive worker as a dedicated unprivileged service user.');
 const hosts=(process.env.COATRIA_HIGGSFIELD_OUTPUT_HOSTS??'').split(',').map(value=>value.trim()).filter(Boolean);
 if(!hosts.length||hosts.length>20)throw Error('Configure a reviewed exact hostname allowlist for Higgsfield output storage.');
 const maxBytes=Number(process.env.COATRIA_ARCHIVE_MAX_SOURCE_BYTES??536870912),deadline=Number(process.env.COATRIA_ARCHIVE_OPERATION_MS??1800000);
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>100*1024**3||!Number.isSafeInteger(deadline)||deadline<1000||deadline>7200000)throw Error('Use bounded archive byte and time limits.');
 const fetchOutput=createHiggsfieldOutputFetcher({allowedHosts:hosts});
 const worker=createHiggsfieldArchiveWorker({scratchRoot:await realpath(scratchRoot!),operationDeadlineMs:deadline,fetchOutput:input=>fetchOutput({...input,maxBytes:Math.min(input.maxBytes,maxBytes)}),inspectMedia:input=>inspectHiggsfieldArchiveMedia(input,{ffprobePath,ffmpegPath,limits:{maxBytes}})});
 const stop=new AbortController();
 const close=()=>stop.abort();process.once('SIGTERM',close);process.once('SIGINT',close);
 console.log(JSON.stringify({event:'archive-worker-started',concurrency:1,maxBytes,deadlineMs:deadline}));
 try{
  while(!stop.signal.aborted){
   try{const result=await worker.runNext({signal:stop.signal});if(result.processed)console.log(JSON.stringify({event:'archive-attempt-recorded',...result}));}
   catch{console.error(JSON.stringify({event:'archive-worker-unavailable'}));}
   if(!stop.signal.aborted)await delay(2000,undefined,{signal:stop.signal}).catch(()=>{});
  }
 }finally{process.removeListener('SIGTERM',close);process.removeListener('SIGINT',close);await database().end();}
}
void main().catch(()=>{console.error('Archive worker startup failed. Check required configuration and service prerequisites; no credentials are logged.');process.exitCode=1;});
