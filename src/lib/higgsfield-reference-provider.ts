import {createHash} from 'node:crypto';
import {z} from 'zod';
import {fail} from './security';
import type {HiggsfieldTool,HiggsfieldToolResult} from './higgsfield-mcp';
import type {HiggsfieldReferenceAllocation,HiggsfieldReferenceLease} from './higgsfield-references-protocol';
import {acceptsHiggsfieldReferenceSchema} from './higgsfield-reference-schema';

export const HIGGSFIELD_REFERENCE_TOOLS=['media_upload','media_confirm'] as const;
type ObjectValue=Record<string,unknown>;
const object=(v:unknown):v is ObjectValue=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':object(v)?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(v);
function unsupported():never{fail(409,'The company Higgsfield catalog needs reference-transfer compatibility qualification.','HIGGSFIELD_REFERENCE_CATALOG_UNSUPPORTED');}
function receipt():never{fail(502,'The reference provider outcome could not be verified. Do not repeat this phase.','HIGGSFIELD_REFERENCE_OUTCOME_UNCERTAIN');}

function tool(tools:readonly HiggsfieldTool[],name:string){
 const entries=tools.filter(t=>t.name===name);if(entries.length!==1)unsupported();return entries[0];
}
function requireArguments(tools:readonly HiggsfieldTool[],name:string,args:ObjectValue){
 if(!acceptsHiggsfieldReferenceSchema(tool(tools,name).inputSchema,args))unsupported();return args;
}
/** This proves only adapter/schema compatibility. Runtime qualification, exact
 * company OAuth catalog provenance and storage readiness are separate requirements. */
export function referenceCatalogDigest(tools:readonly HiggsfieldTool[]):string{
 requireArguments(tools,'media_upload',{filename:'reference-00000000-0000-4000-8000-000000000000.png',content_type:'image/png',method:'upload_url'});
 requireArguments(tools,'media_confirm',{media_id:'00000000-0000-4000-8000-000000000000',type:'image'});
 return createHash('sha256').update(canonical({adapter:'coatria-prepared-image-reference-v1',tools:HIGGSFIELD_REFERENCE_TOOLS.map(name=>{const t=tool(tools,name);return {name,inputSchema:t.inputSchema,outputSchema:t.outputSchema??null};}),confirmationStatus:'confirmed'})).digest('hex');
}
export function buildReferenceUploadArguments(tools:readonly HiggsfieldTool[],lease:HiggsfieldReferenceLease):ObjectValue{
 const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
 const ext=extensions[lease.proxy.contentType];
 if(!ext||!z.string().uuid().safeParse(lease.referenceId).success)unsupported();
 referenceCatalogDigest(tools);
 return requireArguments(tools,'media_upload',{filename:`reference-${lease.referenceId}.${ext}`,content_type:lease.proxy.contentType,method:'upload_url'});
}
export function buildReferenceConfirmArguments(tools:readonly HiggsfieldTool[],mediaId:string):ObjectValue{
 if(!z.string().uuid().safeParse(mediaId).success)unsupported();referenceCatalogDigest(tools);
 return requireArguments(tools,'media_confirm',{media_id:mediaId,type:'image'});
}
function structured(result:HiggsfieldToolResult){
 if(result.isError||!object(result.structuredContent)||Object.hasOwn(result.structuredContent,'error'))receipt();return result.structuredContent;
}
export function parseReferenceAllocation(result:HiggsfieldToolResult,contentType:string,now=Date.now()):HiggsfieldReferenceAllocation{
 const data=structured(result);if(!Array.isArray(data.uploads)||data.uploads.length!==1)receipt();
 const item=data.uploads[0];
 if(!object(item)||!z.string().uuid().safeParse(item.media_id).success||item.content_type!==contentType||item.method!=='PUT'||typeof item.upload_url!=='string'||item.upload_url.length>8192||/[\u0000-\u0020\u007f\\#]/.test(item.upload_url)||!Number.isSafeInteger(item.expires_in_seconds)||(item.expires_in_seconds as number)<1||(item.expires_in_seconds as number)>3600)receipt();
 let url:URL;try{url=new URL(item.upload_url);}catch{return receipt();}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port)receipt();
 return {mediaId:item.media_id as string,uploadUrl:item.upload_url,expiresAt:new Date(now+(item.expires_in_seconds as number)*1000).toISOString()};
}
export function parseReferenceConfirmation(result:HiggsfieldToolResult,mediaId:string):{mediaId:string;confirmed:true}{
 const data=structured(result);if(!Array.isArray(data.results)||data.results.length!==1)receipt();const item=data.results[0];
 if(!object(item)||item.media_id!==mediaId||item.status!=='confirmed'||item.type!=='image')receipt();return {mediaId,confirmed:true};
}
