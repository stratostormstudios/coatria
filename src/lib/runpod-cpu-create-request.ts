import {fail} from './security';

// Runpod v2 limits the complete /pods JSON body, including private environment
// values, to 100 KiB. Check the bytes before committing the submission fence.
export const RUNPOD_CPU_CREATE_MAX_BYTES=102400;
export function serializeRunpodCpuCreate(payload:Record<string,unknown>,scope:'CPU'|'SERVICE'):string{
 let body:string;
 try{body=JSON.stringify(payload);if(typeof body!=='string')throw Error();}
 catch{fail(503,'The compute create request could not be serialized.',scope+'_CREATE_REQUEST_INVALID');}
 if(Buffer.byteLength(body,'utf8')>RUNPOD_CPU_CREATE_MAX_BYTES)fail(413,'The complete compute create request exceeds the provider size limit.',scope+'_CREATE_REQUEST_TOO_LARGE');
 // This immutable string is sent unchanged after the authority transaction.
 // Neither this body nor any private field belongs in logs or durable errors.
 return body;
}
