/** CI-only fixed executable routing and bounded failure metadata. Never retain
 * command arguments, environment, stdout/stderr or raw OS error messages. */
import {spawnSync} from 'node:child_process';
const operations=Object.freeze({install_acl:'/usr/bin/apt-get',create_service_user:'/usr/sbin/useradd',set_acl_control:'/usr/bin/setfacl',reload_units:'/usr/bin/systemctl',read_unit_state:'/usr/bin/systemctl',read_unit_install_state:'/usr/bin/systemctl',read_invocation:'/usr/bin/systemctl',start_qualifier:'/usr/bin/systemctl',start_disabled_worker:'/usr/bin/systemctl',read_systemd_version:'/usr/bin/systemctl',read_failure_state:'/usr/bin/systemctl',read_qualifier_diagnostics:'/usr/bin/journalctl'});
const errors=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','ENOMEM','EAGAIN','EMFILE','ENFILE','EINVAL']);
export class ArchiveHostCiCommandError extends Error{
 constructor(operation,result){super('ARCHIVE_HOST_CI_COMMAND_FAILED');this.name='ArchiveHostCiCommandError';this.diagnostic=Object.freeze({operation:Object.hasOwn(operations,operation)?operation:'unknown_operation',status:Number.isInteger(result?.status)&&result.status>=0&&result.status<=255?result.status:null,errorCode:result?.error?errors.has(result.error.code)?result.error.code:'UNKNOWN':null});}
}
/** Injected runner is a trusted local-test seam, never a request parameter. */
export function createArchiveHostCiCommand(run=spawnSync){return (operation,args,timeout=120000)=>{
 if(!Object.hasOwn(operations,operation)||!Array.isArray(args)||args.length>20||args.some(v=>typeof v!=='string'||v.includes('\0')||v.length>4096)||!Number.isSafeInteger(timeout)||timeout<1||timeout>300000)throw new ArchiveHostCiCommandError('unknown_operation',null);
 let result;try{result=run(operations[operation],args,{shell:false,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C',DEBIAN_FRONTEND:'noninteractive'},encoding:'utf8',timeout,maxBuffer:2*1024**2});}catch(error){throw new ArchiveHostCiCommandError(operation,{status:null,error});}
 if(result.status!==0||result.error)throw new ArchiveHostCiCommandError(operation,result);return result.stdout.trim();
};}
