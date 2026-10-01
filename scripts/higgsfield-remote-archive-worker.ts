/** Separate trusted Linux controller; never import into the Vercel app. The
 * guest receives only decoder closure and source bytes. No provider fallback. */
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {database} from '../src/lib/db';
import {hostingEncryptionConfigured} from '../src/lib/studio-hosting';
import {higgsfieldArchiveAvailability} from '../src/lib/higgsfield-archive-config';
import {assertHiggsfieldArchiveDatabase,assertHiggsfieldArchiveScratchRoot,HiggsfieldArchivePreflightError} from '../src/lib/higgsfield-archive-preflight';
import {createHiggsfieldOutputFetcher} from '../src/lib/higgsfield-output-fetch';
import {createHiggsfieldArchiveWorker} from '../src/lib/higgsfield-archive-worker';
import {inspectHiggsfieldArchiveMedia} from '../src/lib/higgsfield-media-inspection';
import {createVercelMediaSandbox,type VercelMediaSandboxOptions} from '../src/lib/higgsfield-vercel-media-sandbox';
import {createHiggsfieldRemoteMediaController,RemoteMediaControllerError} from '../src/lib/higgsfield-remote-media-controller';
import {assertRemoteArchiveImmutableFile,loadRemoteArchiveConfiguration,parseRemoteArchiveArguments,RemoteArchiveConfigurationError} from '../src/lib/higgsfield-remote-archive-config';

/** A cancelled authority scope can return before the remote executor finishes
 * its separately bounded cleanup. Keep its receipt database alive while draining. */
export async function drainRemoteArchiveInspections(pending:ReadonlySet<Promise<unknown>>,timeoutMs=30000){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RemoteArchiveConfigurationError();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([Promise.allSettled([...pending]).then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}finally{clearTimeout(timer);}
}
export async function runRemoteArchiveWorker(args:readonly string[]){
 const cli=parseRemoteArchiveArguments(args),config=await loadRemoteArchiveConfiguration(cli.path,cli.sha256);
 // The image/bootstrap owns the full source/dependency manifest. This entry
 // itself must not be a writable script even before service configuration.
 await assertRemoteArchiveImmutableFile(fileURLToPath(import.meta.url));
 const deadlineMs=Date.parse(config.policy.expiresAt);if(Date.now()>=deadlineMs)throw new RemoteMediaControllerError('REMOTE_MEDIA_PILOT_EXPIRED');if(deadlineMs-Date.now()>86400000)throw new RemoteArchiveConfigurationError();
 if(!cli.preflight&&!higgsfieldArchiveAvailability().enabled||!process.env.DATABASE_URL||!process.env.COATRIA_HOSTING_KEYRING||!hostingEncryptionConfigured())throw new RemoteArchiveConfigurationError();
 const token=async()=>{const value=process.env.COATRIA_VERCEL_MEDIA_TOKEN;if(typeof value!=='string'||value.length<8||value.length>4096||/[\r\n]/.test(value))throw new RemoteArchiveConfigurationError();return value;};await token();
 const controller=createHiggsfieldRemoteMediaController(config.policy),pool=database(),stop=new AbortController(),inspections=new Set<Promise<unknown>>();
 const close=()=>stop.abort(new Error('REMOTE_ARCHIVE_STOPPED')),timer=setTimeout(()=>stop.abort(new Error('REMOTE_ARCHIVE_EXPIRED')),Math.min(2147483647,Math.max(1,deadlineMs-Date.now())));
 process.once('SIGTERM',close);process.once('SIGINT',close);
 try{
  const dbCheck=await assertHiggsfieldArchiveDatabase(pool),scratchRoot=await assertHiggsfieldArchiveScratchRoot(config.scratchRoot);stop.signal.throwIfAborted();
  if((await controller.scanRecovery()).length)throw new RemoteMediaControllerError('REMOTE_MEDIA_RECOVERY_REQUIRED');
  await controller.assertAdmission(3);
  const factory=async(journal:VercelMediaSandboxOptions['journal'])=>{const sandbox=await createVercelMediaSandbox({teamId:config.policy.binding.teamId,projectId:config.policy.binding.projectId,region:config.policy.binding.region,limits:config.policy.binding.limits,closure:config.closure,token,journal},config.qualification);if(!isDeepStrictEqual(sandbox.qualificationBinding,config.policy.binding))throw new RemoteArchiveConfigurationError();return sandbox;};
  // Construction verifies the real receipt/closure and never calls .run.
  // Throw-only callbacks prohibit accidental admission in this dry preflight.
  const denied=async()=>{throw new RemoteArchiveConfigurationError();};await factory({reserve:denied,record:denied,authorize:denied});stop.signal.throwIfAborted();
  if(cli.preflight){console.log(JSON.stringify({event:'remote-archive-preflight-passed',role:dbCheck.role,sourceCommit:config.policy.sourceCommit,pilotId:config.policy.pilotId,expiresAt:config.policy.expiresAt,workClaimed:false,providerCalled:false}));return;}
  const fetchOutput=createHiggsfieldOutputFetcher({allowedHosts:[...config.outputHosts]}),worker=createHiggsfieldArchiveWorker({scope:{companyId:config.policy.companyId,projectIds:config.policy.projectIds},scratchRoot,operationDeadlineMs:config.operationDeadlineMs,
   fetchOutput:input=>fetchOutput({...input,maxBytes:Math.min(input.maxBytes,config.policy.binding.limits.maxInputBytes)}),
   inspectMedia:(input,context)=>{const pending=(async()=>{stop.signal.throwIfAborted();const sandbox=await factory(controller.forArchive(context));return inspectHiggsfieldArchiveMedia(input,{sandbox,sandboxTimeoutMs:config.inspection.sandboxTimeoutMs,limits:{timeoutMs:config.inspection.timeoutMs,maxBytes:config.policy.binding.limits.maxInputBytes,maxProbeBytes:config.policy.binding.limits.maxOutputBytes}});})();inspections.add(pending);void pending.then(()=>inspections.delete(pending),()=>inspections.delete(pending));return pending;}
  });
  console.log(JSON.stringify({event:'remote-archive-worker-started',pilotId:config.policy.pilotId,expiresAt:config.policy.expiresAt,concurrency:1}));
  while(!stop.signal.aborted){
   // Stop before claiming another approved record if it cannot be admitted.
   // A restart never manufactures another pilot or forgets an uncertain guest.
   await controller.assertAdmission(3);stop.signal.throwIfAborted();if(Date.now()>=deadlineMs)break;
   const result=await worker.runNext({signal:stop.signal});if(result.processed)console.log(JSON.stringify({event:'remote-archive-attempt-recorded',...result}));
   if((await controller.scanRecovery()).length)throw new RemoteMediaControllerError('REMOTE_MEDIA_RECOVERY_REQUIRED');
   if(!stop.signal.aborted)await delay(2000,undefined,{signal:stop.signal}).catch(error=>{if(!stop.signal.aborted)throw error;});
  }
 }finally{clearTimeout(timer);process.removeListener('SIGTERM',close);process.removeListener('SIGINT',close);stop.abort();const drained=await drainRemoteArchiveInspections(inspections);await pool.end();if(!drained)throw new RemoteMediaControllerError('REMOTE_MEDIA_RECOVERY_REQUIRED');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void runRemoteArchiveWorker(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({event:'remote-archive-worker-stopped',code:error instanceof RemoteMediaControllerError||error instanceof HiggsfieldArchivePreflightError?error.code:'REMOTE_ARCHIVE_CONFIGURATION_INVALID'}));process.exitCode=1;});}
