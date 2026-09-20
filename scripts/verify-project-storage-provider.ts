/** Prepare is offline. Run writes only synthetic objects in the reviewed volume.
 * Credentials are read from private environment variables, never CLI arguments. */
import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareStorageConformance,runStorageConformance,verifyStorageConformance,storageConformancePlanSchema,storageConformancePlanSha256} from '../src/lib/project-storage-conformance';
import {RunpodStorageError} from '../src/lib/project-storage-runpod';

const normalized=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
function localPath(path:string){if(!isAbsolute(path)||path.includes('\0')||/^[\\/]{2}/.test(path)||process.platform==='win32'&&path.slice(2).includes(':'))throw Error('Use a private absolute local directory without device paths or alternate streams.');}
async function privateDirectory(path:string){localPath(path);const info=await lstat(path),actual=await realpath(path);if(!info.isDirectory()||info.isSymbolicLink()||normalized(actual)!==normalized(path))throw Error('Use a real directory without symlink or junction ancestors.');return actual;}
async function readPlan(directory:string){
 const path=join(directory,'plan.json'),before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>16384)throw Error('Use one bounded regular plan file.');
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{
  const current=await file.stat();if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||current.nlink!==1)throw Error('Plan file identity changed.');
  const buffer=Buffer.alloc(16385);let length=0;while(length<buffer.length){const part=await file.read(buffer,length,buffer.length-length,length);if(!part.bytesRead)break;length+=part.bytesRead;}
  const after=await file.stat();if(length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||length>16384)throw Error('Plan changed or exceeds the reviewed size limit.');
  return storageConformancePlanSchema.parse(JSON.parse(buffer.subarray(0,length).toString('utf8')));
 }finally{await file.close();}
}
type JournalSink={write(buffer:Buffer,offset:number,length:number,position:null):Promise<{bytesWritten:number}>;sync():Promise<void>};
/** FileHandle.write may complete only a prefix. A partial/zero write must never
 * be mistaken for a durable complete intent authorizing the next provider I/O. */
export async function appendConformanceJournal(journal:JournalSink,event:unknown){const bytes=Buffer.from(JSON.stringify({at:new Date().toISOString(),event})+'\n');let offset=0;while(offset<bytes.length){const {bytesWritten}=await journal.write(bytes,offset,bytes.length-offset,null);if(!Number.isSafeInteger(bytesWritten)||bytesWritten<1||bytesWritten>bytes.length-offset)throw Error('The complete journal entry could not be written.');offset+=bytesWritten;}await journal.sync();}

export async function main(args=process.argv.slice(2)){
 const [mode,...rest]=args;
 if(mode==='--help'||mode==='help'){
  console.log('Offline: prepare <volume-id> <region> <new-absolute-directory>\nSynthetic writes: run <absolute-directory> <exact-plan-sha256>\nRead only: verify <absolute-directory> <exact-plan-sha256>\nSet COATRIA_CONFORMANCE_S3_ACCESS_KEY_ID and COATRIA_CONFORMANCE_S3_SECRET_ACCESS_KEY privately before run/verify. A run retains about 5 MiB of synthetic data and never starts compute, creates a volume, deletes existing files or retries uncertain writes.');return;
 }
 if(mode==='prepare'){
  if(rest.length!==3||!isAbsolute(rest[2]))throw Error('Expected prepare <volume-id> <region> <new-absolute-directory>.');
  const plan=prepareStorageConformance(rest[0],rest[1]);localPath(rest[2]);await privateDirectory(dirname(rest[2]));await mkdir(rest[2],{mode:0o700});const directory=await privateDirectory(rest[2]);
  await writeFile(join(directory,'plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({mode:'prepared',directory,planSha256:storageConformancePlanSha256(plan),volumeId:plan.volumeId,region:plan.region,maximumBytesSent:plan.bytes+plan.abortBytes,retainedSyntheticBytes:plan.bytes,startsCompute:false,createsVolume:false,deletesExistingFiles:false}));return;
 }
 if(!['run','verify'].includes(mode)||rest.length!==2||!isAbsolute(rest[0])||!(/^[a-f0-9]{64}$/).test(rest[1]))throw Error('Expected run|verify <absolute-directory> <exact-plan-sha256>.');
 const directory=await privateDirectory(rest[0]),plan=await readPlan(directory);
 if(storageConformancePlanSha256(plan)!==rest[1])throw Error('Plan digest mismatch.');
 const credentials={accessKeyId:process.env.COATRIA_CONFORMANCE_S3_ACCESS_KEY_ID??'',secretAccessKey:process.env.COATRIA_CONFORMANCE_S3_SECRET_ACCESS_KEY??''};
 if(!/^user_[A-Za-z0-9_-]{4,160}$/.test(credentials.accessKeyId)||!/^rps_[A-Za-z0-9_-]{8,256}$/.test(credentials.secretAccessKey))throw Error('Configure the dedicated Runpod S3 environment credentials.');
 // Never resume a mutation journal after an interruption. The retained plan and
 // returned upload descriptors let an operator reconcile uncertain operations.
 const journal=await open(join(directory,mode==='run'?'mutation-journal.jsonl':'readback-'+Date.now()+'.jsonl'),'wx',0o600);
 const stop=new AbortController(),cancel=()=>stop.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 const record=async(event:unknown)=>appendConformanceJournal(journal,event);
 try{
  const result=await (mode==='run'?runStorageConformance:verifyStorageConformance)(plan,{credentials,record,signal:stop.signal});
  await writeFile(join(directory,mode==='run'?'report.json':'readback-'+Date.now()+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({mode,status:'passed',directory,...mode==='run'?{providerTransportPassed:true,productionReady:false}:{storedBytesVerified:true}}));
 }finally{await journal.close();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(error=>{console.error(JSON.stringify({status:'failed',code:error instanceof RunpodStorageError?error.code:'STORAGE_CONFORMANCE_SETUP_OR_JOURNAL_FAILED',automaticRetry:false,message:'Inspect the local plan and journal. Do not rerun an uncertain mutation or print credentials.'}));process.exitCode=1;});
