import {z} from 'zod';
import {fail} from './security';

function unsupported():never{fail(409,'This estimate accepts only reviewed cost parameters inside one params object. Unsupported fields and serialized arguments are not forwarded. No reference was uploaded.','HIGGSFIELD_ESTIMATE_ARGUMENTS_UNSUPPORTED');}
function unsafeReference():never{fail(409,'Cost estimates cannot fetch or upload references. Use an existing Higgsfield media UUID in params.medias; upload and confirm any new reference through a separately authorized workflow first. No reference was uploaded.','HIGGSFIELD_ESTIMATE_REFERENCE_UNSAFE');}
const locator=/(?:[a-z][a-z\d+.-]*:\/\/|(?:https?|data|blob|file):|^\s*\/\/|^\s*\\\\)/i;

// Inspect unknown fields too: a provider's additionalProperties schema is not
// permission to forward URL aliases or a serialized nested reference payload.
function assertNoLocators(value:unknown,depth=0):void{
 if(depth>8)unsupported();
 if(typeof value==='string'){if(locator.test(value))unsafeReference();return;}
 if(value===null||typeof value!=='object')return;
 if(Array.isArray(value)){for(const child of value)assertNoLocators(child,depth+1);return;}
 if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)unsupported();
 for(const child of Object.values(value))assertNoLocators(child,depth+1);
}

const identifier=z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const reference=z.object({
 role:z.enum(['image','start_image','end_image','video','audio','ref_element']),
 value:z.string().uuid(),
}).strict();
const common={
 model:identifier,
 prompt:z.string().max(20000).optional(),
 aspect_ratio:z.string().max(32).regex(/^(?:auto|[1-9]\d*(?:\.\d+)?:[1-9]\d*(?:\.\d+)?)$/).optional(),
 count:z.number().int().min(1).max(4).optional(),
 folder_id:z.string().uuid().optional(),
 medias:z.array(reference).max(100).optional(),
 use_unlim:z.boolean().optional(),
};
const video={duration:z.number().int().positive().optional(),use_free_gens:z.boolean().optional()};
const audio={voice_id:identifier.optional(),voice_type:z.enum(['preset','element']).optional()};

/**
 * Only for cost/read calls. A syntactically valid UUID is not proof of ownership,
 * confirmation or permission. Generation proposals and paid dispatch are intact.
 * Unknown model-specific parameters need explicit review before this allowlist
 * grows; provider discovery alone cannot establish absence of upload side effects.
 */
export function prepareHiggsfieldCostArguments(tool:string,input:unknown):{params:Record<string,unknown>}{
 const generating=tool==='generate_image'||tool==='generate_video'||tool==='generate_audio';
 const image=tool==='generate_image'||tool==='estimate_image_cost';
 const moving=tool==='generate_video'||tool==='estimate_video_cost';
 const speaking=tool==='generate_audio';
 if(!image&&!moving&&!speaking)unsupported();
 assertNoLocators(input);
 const schema=z.object({params:z.object({
  ...common,...moving?video:{},...speaking?audio:{},...generating?{get_cost:z.boolean().optional()}:{},
 }).strict()}).strict();
 const parsed=schema.safeParse(input);
 if(!parsed.success){
  if(parsed.error.issues.some(issue=>issue.path.includes('medias')))unsafeReference();
  unsupported();
 }
 // Zod's fresh parsed copy preserves permitted values. Only this documented
 // generation-preflight flag changes; the stored arguments/hash are never edited.
 return generating?{params:{...parsed.data.params,get_cost:true}}:parsed.data;
}
