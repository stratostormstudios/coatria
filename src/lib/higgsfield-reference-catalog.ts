/** Pure provider-schema compatibility; no OAuth, application DB or network. */
import {createHash} from 'node:crypto';
import {acceptsHiggsfieldReferenceSchema} from './higgsfield-reference-schema';
import type {HiggsfieldTool} from './higgsfield-mcp';
export const HIGGSFIELD_REFERENCE_CATALOG_TOOLS=['media_upload','media_confirm'] as const;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':object(v)?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
export function compatibleReferenceCatalogDigest(tools:readonly HiggsfieldTool[]):string{
 const reject=():never=>{throw Error('HIGGSFIELD_REFERENCE_CATALOG_UNSUPPORTED');};
 if(!Array.isArray(tools))return reject();
 const tool=(name:string)=>{const matches=tools.filter(t=>object(t)&&t.name===name);if(matches.length!==1)return reject();return matches[0];};
 if(!acceptsHiggsfieldReferenceSchema(tool('media_upload').inputSchema,{filename:'reference-00000000-0000-4000-8000-000000000000.png',content_type:'image/png',method:'upload_url'})||!acceptsHiggsfieldReferenceSchema(tool('media_confirm').inputSchema,{media_id:'00000000-0000-4000-8000-000000000000',type:'image'}))return reject();
 return createHash('sha256').update(canonical({adapter:'coatria-prepared-image-reference-v1',tools:HIGGSFIELD_REFERENCE_CATALOG_TOOLS.map(name=>{const t=tool(name);return {name,inputSchema:t.inputSchema,outputSchema:t.outputSchema??null};}),confirmationStatus:'confirmed'})).digest('hex');
}
