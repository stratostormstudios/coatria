/** Disposable CI only: fixed reference identity and command shapes. No shell,
 * inherited credentials, arbitrary commands or raw process output in failures. */
import {spawnSync} from 'node:child_process';
import {referenceHostUnitName} from './reference-host-delegation.mjs';
import {REFERENCE_QUALIFIER_STATE_PROPERTIES} from './reference-host-qualification.mjs';

const errors=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','ENOMEM','EAGAIN','EMFILE','ENFILE','EINVAL']);
export class ReferenceHostCiCommandError extends Error {
 constructor(operation,result){super('REFERENCE_HOST_CI_COMMAND_FAILED');this.diagnostic=Object.freeze({operation,status:Number.isInteger(result?.status)&&result.status>=0&&result.status<=255?result.status:null,errorCode:result?.error?errors.has(result.error.code)?result.error.code:'UNKNOWN':null});}
}
export function createReferenceHostCiCommand(serviceId,run=spawnSync){
 const units=Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,referenceHostUnitName(serviceId,mode)]));
 return (operation,value)=>{
  let executable='/usr/bin/systemctl',args,timeout=15000;
  switch(operation){
   case 'create_service_user': executable='/usr/sbin/useradd';args=['--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','coatria-reference'];break;
   case 'reload_units': args=['daemon-reload'];break;
   case 'read_systemd_version': args=['--version'];break;
   case 'sync_journal': executable='/usr/bin/journalctl';args=['--sync'];break;
   case 'read_unit_state': case 'read_unit_install_state':
    if(!Object.hasOwn(units,value))throw new ReferenceHostCiCommandError('invalid_operation',null);
    args=['show',units[value],'--property='+ (operation==='read_unit_state'?'ActiveState':'UnitFileState'),'--value'];break;
   case 'read_qualifier_state': args=['show',units.qualify,'--property='+REFERENCE_QUALIFIER_STATE_PROPERTIES];break;
   case 'read_invocation': args=['show',units.qualify,'--property=InvocationID','--value'];break;
   case 'read_failure_state': args=['show',units.qualify,'--property=ActiveState,Result,ExecMainStatus'];break;
   case 'start_qualifier': args=['start',units.qualify];timeout=360000;break;
   case 'stop_qualifier': args=['stop',units.qualify];timeout=60000;break;
   case 'start_disabled_worker': args=['start',units.worker];timeout=60000;break;
   case 'read_qualifier_diagnostics':
    if(typeof value!=='string'||!/^(?!0{32}$)[a-f0-9]{32}$/.test(value))throw new ReferenceHostCiCommandError('invalid_operation',null);
    executable='/usr/bin/journalctl';args=['--no-pager','--output=json','--lines=50','--unit='+units.qualify,'_SYSTEMD_INVOCATION_ID='+value];break;
   default: throw new ReferenceHostCiCommandError('invalid_operation',null);
  }
  if(!['read_unit_state','read_unit_install_state','read_qualifier_diagnostics'].includes(operation)&&value!==undefined)throw new ReferenceHostCiCommandError('invalid_operation',null);
  let result;try{result=run(executable,args,{shell:false,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout,maxBuffer:1024**2});}catch(error){throw new ReferenceHostCiCommandError(operation,{error});}
  if(result.status!==0||result.error)throw new ReferenceHostCiCommandError(operation,result);return result.stdout.trim();
 };
}
/** Execute the accepted immutable qualifier CLI, never a checkout interpreter. */
export function createReferenceHostCiAcceptor(serviceId,bundleSha256,run=spawnSync){
 referenceHostUnitName(serviceId,'qualify');if(typeof bundleSha256!=='string'||!/^[a-f0-9]{64}$/.test(bundleSha256))throw new ReferenceHostCiCommandError('invalid_operation',null);
 const release='/var/lib/coatria-reference-releases/'+bundleSha256,host='/etc/coatria-reference/'+serviceId+'/host.json';
 return (evidencePath,evidenceSha256)=>{
  if(typeof evidencePath!=='string'||!new RegExp('^/var/lib/coatria-reference-worker/'+serviceId+'/evidence/qualification-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/host-evidence\\.json$').test(evidencePath)||typeof evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(evidenceSha256))throw new ReferenceHostCiCommandError('invalid_operation',null);
  let result;try{result=run(release+'/runtime/node',[release+'/qualifier/runtime.mjs','--accept-qualification','--host',host,'--bundle',bundleSha256,'--evidence',evidencePath,'--sha256',evidenceSha256],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout:60000,maxBuffer:65536});}catch(error){throw new ReferenceHostCiCommandError('accept_compiled_qualification',{error});}
  if(result.status!==0||result.error)throw new ReferenceHostCiCommandError('accept_compiled_qualification',result);
  let output;try{output=JSON.parse(result.stdout);}catch{throw new ReferenceHostCiCommandError('accept_compiled_qualification',null);}
  if(!output||output.workerEnabled!==false||output.enrolled!==false||output.replayed!==false||output.receipt?.kind!=='coatria-reference-worker-qualification')throw new ReferenceHostCiCommandError('accept_compiled_qualification',null);return output;
 };
}
