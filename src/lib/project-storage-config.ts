/** No provider credentials are needed to describe the transfer service. */
export const STORAGE_MAX_FILE_BYTES=100*1024**3;
export const STORAGE_PART_BYTES=64*1024**2;
export const STORAGE_GRANT_SECONDS=15*60;
export const STORAGE_HUMAN_GRANT_SECONDS=2*60*60;
export function storageGatewayOrigin():string|null {
 if(process.env.COATRIA_STORAGE_GATEWAY_ENABLED!=='true')return null;
 try {
  const url=new URL(process.env.COATRIA_STORAGE_GATEWAY_URL||'');
  const local=process.env.NODE_ENV!=='production'&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname);
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash||url.pathname!=='/')return null;
  return url.origin;
 }catch{return null;}
}
export function storageTransferAvailability(){
 const gatewayOrigin=storageGatewayOrigin();
 return gatewayOrigin?{available:true as const,gatewayOrigin,maxFileBytes:STORAGE_MAX_FILE_BYTES,partBytes:STORAGE_PART_BYTES}:{available:false as const,code:'STORAGE_GATEWAY_UNAVAILABLE' as const,message:'Folder organization is ready. Uploads and downloads open after the authenticated storage transfer service is connected.'};
}
