/** Read-only canary observation, never a decoder isolation/cleanup decision.
 * A disappearing kernfs child can fail a pending read with ENODEV. Accept it
 * only after a fresh lookup proves that exact decoder UUID directory is gone. */
import {lstat} from 'node:fs/promises';
import {basename,isAbsolute} from 'node:path';

/** @param {unknown} error @param {string} directory
 * @param {(path:string)=>Promise<unknown>} [stat] */
export async function mediaSandboxDecoderDisappeared(error,directory,stat=lstat){
 const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
 if(code==='ENOENT')return true;
 if(code!=='ENODEV'||!isAbsolute(directory)||!/^decoder-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(basename(directory)))return false;
 try{await stat(directory);return false;}catch(probe){return !!probe&&typeof probe==='object'&&'code' in probe&&probe.code==='ENOENT';}
}
