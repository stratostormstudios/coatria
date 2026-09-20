/** Opt-in generated media v2. Legacy frame contracts and their hashes stay in
 * studio-protocol.ts. These schemas do not certify provider output capability,
 * authorize storage access, publish artifacts, or perform creative/QC review. */
import {z} from 'zod';
import type {HiggsfieldMediaDescriptor} from './higgsfield-media-inspection';

export const STUDIO_GENERATED_MAX_DURATION_MS=3_600_000;
export const STUDIO_GENERATED_MAX_PIXELS=64*1024**2;
export const STUDIO_GENERATED_VIDEO_CODECS=['h264','hevc','av1','mpeg4','prores'] as const;
export const STUDIO_GENERATED_PCM_CODECS=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'] as const;
export const STUDIO_GENERATED_AUDIO_CODECS=['aac','mp3',...STUDIO_GENERATED_PCM_CODECS] as const;
// PostgreSQL JSONB cannot store NUL or unpaired UTF-16. Reject those before a
// valid-looking contract is hashed or accepted; preserve all valid Unicode.
const storableText=(value:string):boolean=>{for(let i=0;i<value.length;i++){const unit=value.charCodeAt(i);if(unit===0)return false;if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(unit>=0xdc00&&unit<=0xdfff)return false;}return true;};
const uuid=z.string().uuid(),text=(max:number)=>z.string().trim().min(1).max(max).refine(storableText,'Text must contain valid Unicode without NUL.'),revision=z.number().int().min(1).max(2147483646);
const dimension=z.number().int().min(1).max(16384),sampleRate=z.number().int().min(1).max(384000),channels=z.number().int().min(1).max(8);
const code=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/);
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
const rational=z.object({numerator:z.number().int().min(1).max(1_000_000_000),denominator:z.number().int().min(1).max(1_000_000_000)}).strict();
const exactTags={space:z.enum(['gbr','bt709','bt2020nc','bt2020c','smpte170m']),primaries:z.enum(['bt709','bt2020','smpte170m','smpte432']),transfer:z.enum(['bt709','iec61966-2-1','linear','smpte2084','arib-std-b67','smpte170m']),range:z.enum(['pc','tv'])};
/** not_required is explicit reviewed waiver of machine color-tag matching. It
 * does not label absent tags sRGB, Rec.709 or any other inferred color space. */
export const studioGeneratedColorInput=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('not_required')}).strict(),
 z.object({mode:z.literal('exact'),...exactTags}).strict(),
]);
export const studioGeneratedFrameRateInput=rational.extend({mode:z.literal('constant')}).strict().refine(value=>value.numerator/value.denominator<=240,'At most 240 frames per second are supported.').transform(value=>{const divisor=gcd(value.numerator,value.denominator);return {...value,numerator:value.numerator/divisor,denominator:value.denominator/divisor};});
export const studioGeneratedVideoAudioInput=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('none')}).strict(),
 z.object({mode:z.literal('required'),codec:z.enum(STUDIO_GENERATED_AUDIO_CODECS),sampleRateHz:sampleRate,channels}).strict(),
]);
const visual={width:dimension,height:dimension,color:studioGeneratedColorInput};
const imageSpec=z.object({kind:z.literal('image'),format:z.enum(['png','jpeg','webp']),...visual}).strict();
const videoSpec=z.object({kind:z.literal('video'),format:z.enum(['mp4','mov']),codec:z.enum(STUDIO_GENERATED_VIDEO_CODECS),...visual,frameRate:studioGeneratedFrameRateInput,audio:studioGeneratedVideoAudioInput}).strict();
const audioSpec=z.object({kind:z.literal('audio'),format:z.enum(['wav','mp3']),codec:z.enum(['mp3',...STUDIO_GENERATED_PCM_CODECS]),sampleRateHz:sampleRate,channels}).strict();
const videoCodecSupported=(format:string,codec:string)=>format==='mp4'?['h264','hevc','av1','mpeg4'].includes(codec):format==='mov'?['h264','hevc','mpeg4','prores'].includes(codec):false;
const audioCodecSupported=(format:string,codec:string)=>format==='mp3'?codec==='mp3':format==='wav'?(STUDIO_GENERATED_PCM_CODECS as readonly string[]).includes(codec):false;
const embeddedCodecSupported=(format:string,codec:string)=>format==='mp4'?['aac','mp3'].includes(codec):format==='mov'?(STUDIO_GENERATED_AUDIO_CODECS as readonly string[]).includes(codec):false;
export const studioGeneratedSpecInput=z.discriminatedUnion('kind',[imageSpec,videoSpec,audioSpec]).superRefine((value,ctx)=>{
 if(value.kind!=='audio'&&value.width*value.height>STUDIO_GENERATED_MAX_PIXELS)ctx.addIssue({code:'custom',path:['width'],message:'The reviewed pixel limit is 64 megapixels.'});
 if(value.kind==='video'&&!videoCodecSupported(value.format,value.codec)||value.kind==='audio'&&!audioCodecSupported(value.format,value.codec))ctx.addIssue({code:'custom',path:['codec'],message:'This codec/container pair is outside the reviewed generated-media contract.'});
 if(value.kind==='video'&&value.audio.mode==='required'&&!embeddedCodecSupported(value.format,value.audio.codec))ctx.addIssue({code:'custom',path:['audio','codec'],message:'This embedded audio codec/container pair is not supported.'});
});
export const studioGeneratedDurationInput=z.object({min:z.number().int().min(1).max(STUDIO_GENERATED_MAX_DURATION_MS),max:z.number().int().min(1).max(STUDIO_GENERATED_MAX_DURATION_MS)}).strict().refine(value=>value.min<=value.max,'Duration bounds must be ordered.');
const work={code,description:text(2000)};
export const studioGeneratedWorkUnitInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('image'),...work}).strict(),
 z.object({kind:z.literal('video'),...work,durationMs:studioGeneratedDurationInput}).strict(),
 z.object({kind:z.literal('audio'),...work,durationMs:studioGeneratedDurationInput}).strict(),
]);
export const studioGeneratedProjectPlanInput=z.object({contractVersion:z.literal(2),productionPath:z.literal('higgsfield'),name:text(160),clientName:text(160),brief:text(12000),dueDate:z.string().date().nullable().default(null),aiPolicy:z.enum(['unknown','allowed','restricted']).default('unknown'),spec:studioGeneratedSpecInput,shots:z.array(studioGeneratedWorkUnitInput).min(1).max(100)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.shots.map(shot=>shot.code.toLowerCase())).size!==value.shots.length)ctx.addIssue({code:'custom',path:['shots'],message:'Deliverable codes must be unique.'});
 value.shots.forEach((shot,index)=>{if(shot.kind!==value.spec.kind)ctx.addIssue({code:'custom',path:['shots',index,'kind'],message:'Each deliverable must match the project media kind.'});});
});
export const studioGeneratedProjectInput=studioGeneratedProjectPlanInput.safeExtend({clientId:uuid});
/** The caller selects an archive. Bytes, hashes, media facts, source identities
 * and author attribution must be loaded from trusted verified rows by server. */
export const studioGeneratedArtifactRegisterInput=z.object({clientId:uuid,revision,workItemId:uuid,archiveId:uuid,name:text(160),notes:z.string().trim().max(4000).refine(storableText,'Text must contain valid Unicode without NUL.').default('')}).strict();
export type GeneratedProjectSpec=z.infer<typeof studioGeneratedSpecInput>;
export type GeneratedWorkUnit=z.infer<typeof studioGeneratedWorkUnitInput>;
export type GeneratedProjectPlan=z.infer<typeof studioGeneratedProjectPlanInput>;
export type GeneratedProjectInput=z.infer<typeof studioGeneratedProjectInput>;
export type GeneratedArtifactRegisterInput=z.infer<typeof studioGeneratedArtifactRegisterInput>;

export type GeneratedMediaIssueCode='SPEC_INVALID'|'WORK_UNIT_INVALID'|'WORK_KIND_MISMATCH'|'OBSERVATION_INVALID'|'UNSUPPORTED_CODEC'|'MEDIA_KIND_MISMATCH'|'FORMAT_MISMATCH'|'CODEC_MISMATCH'|'DIMENSIONS_MISMATCH'|'COLOR_METADATA_UNKNOWN'|'COLOR_METADATA_MISMATCH'|'CADENCE_UNPROVEN'|'VARIABLE_FRAME_RATE'|'FRAME_RATE_MISMATCH'|'FRAME_TIMING_MISMATCH'|'DURATION_MISMATCH'|'DURATION_PRECISION_UNPROVEN'|'AUDIO_UNEXPECTED'|'AUDIO_REQUIRED'|'SAMPLE_RATE_MISMATCH'|'CHANNELS_MISMATCH'|'FILE_FACTS_INVALID'|'FILE_BYTES_MISMATCH'|'FILE_HASH_MISMATCH'|'FILE_CONTENT_TYPE_MISMATCH';
export type GeneratedMediaLimitation='COLOR_METADATA_NOT_REQUIRED'|'VIDEO_DURATION_ROUNDED_TO_MS'|'EMBEDDED_AUDIO_TIMING_UNVERIFIED';
export type GeneratedMediaMatch={matches:boolean;issues:{code:GeneratedMediaIssueCode;path:string}[];limitations:GeneratedMediaLimitation[]};
const observedCodec=z.string().min(1).max(80).regex(/^[a-z0-9_]+$/),tag=z.string().min(1).max(80).regex(/^[A-Za-z0-9_. -]+$/).nullable();
const observedColor=z.object({space:tag,primaries:tag,transfer:tag,range:tag}).strict();
const observedAudio=z.object({codec:observedCodec,sampleRateHz:sampleRate,channels}).strict();
const observedCommon={bytes:z.number().int().min(1).max(100*1024**3),sha256:z.string().regex(/^[a-f0-9]{64}$/),verification:z.literal('full_decode'),inspectionVersion:z.literal(1)};
const observedImage=z.object({...observedCommon,kind:z.literal('image'),format:z.enum(['png','jpeg','webp']),contentType:z.enum(['image/png','image/jpeg','image/webp']),width:dimension,height:dimension,codec:observedCodec,color:observedColor}).strict();
const observedVideo=z.object({...observedCommon,kind:z.literal('video'),format:z.enum(['mp4','mov']),contentType:z.enum(['video/mp4','video/quicktime']),width:dimension,height:dimension,codec:observedCodec,color:observedColor,durationMs:z.number().int().min(1).max(STUDIO_GENERATED_MAX_DURATION_MS),frameRate:rational.nullable(),averageFrameRate:rational.nullable(),vfr:z.boolean().nullable(),frameCount:z.number().int().min(1).max(120000),audio:observedAudio.nullable()}).strict();
const observedSound=z.object({...observedCommon,kind:z.literal('audio'),format:z.enum(['wav','mp3']),contentType:z.enum(['audio/wav','audio/mpeg']),codec:observedCodec,sampleRateHz:sampleRate,channels,durationMs:z.number().int().min(1).max(STUDIO_GENERATED_MAX_DURATION_MS),decodedSamples:z.number().int().min(1).max(2_000_000_000)}).strict();
/** Validate stored probe JSON as data. A matching shape is not proof that an
 * archive was verified: the caller must authenticate its immutable source row. */
export const studioGeneratedObservedMediaInput=z.discriminatedUnion('kind',[observedImage,observedVideo,observedSound]).superRefine((value,ctx)=>{
 const issue=(path:string[],message:string,generatedCode:GeneratedMediaIssueCode='OBSERVATION_INVALID')=>ctx.addIssue({code:'custom',path,message,params:{generatedCode}});
 const mime={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',mov:'video/quicktime',wav:'audio/wav',mp3:'audio/mpeg'};
 if(mime[value.format]!==value.contentType)issue(['contentType'],'Observed content type conflicts with the inspected container.');
 if(value.kind!=='audio'&&value.width*value.height>STUDIO_GENERATED_MAX_PIXELS)issue(['width'],'Observed image exceeds the decoder pixel ceiling.');
 if(value.kind==='image'&&({png:'png',jpeg:'mjpeg',webp:'webp'} as const)[value.format]!==value.codec||value.kind==='video'&&!videoCodecSupported(value.format,value.codec)||value.kind==='audio'&&!audioCodecSupported(value.format,value.codec))issue(['codec'],'Observed codec/container is unsupported.','UNSUPPORTED_CODEC');
 if(value.kind==='video'){
  if(value.width*value.height*value.frameCount>100_000_000_000)issue(['frameCount'],'Decoded frames exceed the inspection pixel ceiling.');
  if(value.audio&&!embeddedCodecSupported(value.format,value.audio.codec))issue(['audio','codec'],'Observed embedded audio codec is unsupported.','UNSUPPORTED_CODEC');
  if(value.frameCount<3?(value.vfr!==null||value.frameRate!==null):(value.vfr===null||value.vfr===false&&value.frameRate===null||value.vfr===true&&value.frameRate!==null))issue(['frameRate'],'Observed cadence fields conflict with the decoder evidence.');
 }
 if(value.kind==='audio'){
  if(value.decodedSamples*value.channels>2_000_000_000)issue(['decodedSamples'],'Decoded samples exceed the inspection ceiling.');
  if(BigInt(value.decodedSamples)*1000n>BigInt(STUDIO_GENERATED_MAX_DURATION_MS)*BigInt(value.sampleRateHz))issue(['decodedSamples'],'Exact decoded duration exceeds the inspection ceiling.');
  if(Math.round(value.decodedSamples/value.sampleRateHz*1000)!==value.durationMs)issue(['durationMs'],'Rounded duration conflicts with the exact decoded sample count.');
 }
});
export type GeneratedObservedMedia=z.infer<typeof studioGeneratedObservedMediaInput>;
// Compile-time alignment in addition to runtime parsing. This is deliberately
// type-only: no decoder/node child-process import enters a browser schema bundle.
const _descriptorCompatible=(value:GeneratedObservedMedia):HiggsfieldMediaDescriptor=>value;
void _descriptorCompatible;

const specification= z.object({spec:studioGeneratedSpecInput,workUnit:studioGeneratedWorkUnitInput}).strict().refine(value=>value.spec.kind===value.workUnit.kind,'The specification and deliverable media kinds must agree.');
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
export function generatedSpecificationCanonical(spec:unknown,workUnit:unknown):string{return canonical({schemaVersion:2,kind:'generated_specification',...specification.parse({spec,workUnit})});}
export async function generatedSpecificationSha256(spec:unknown,workUnit:unknown):Promise<string>{const bytes=new TextEncoder().encode(generatedSpecificationCanonical(spec,workUnit)),digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');}

/** Compare observed facts without filling unknown metadata or trusting file
 * names/URLs. Video timing is presently rounded to milliseconds by inspection;
 * its complete [duration-.5,duration+.5) interval must fit the approved range. */
export function matchGeneratedMedia(specInput:unknown,workInput:unknown,observedInput:unknown):GeneratedMediaMatch{
 return matchParsedGeneratedMedia(studioGeneratedSpecInput.safeParse(specInput),studioGeneratedWorkUnitInput.safeParse(workInput),studioGeneratedObservedMediaInput.safeParse(observedInput));
}
function matchParsedGeneratedMedia(spec:ReturnType<typeof studioGeneratedSpecInput.safeParse>,unit:ReturnType<typeof studioGeneratedWorkUnitInput.safeParse>,observed:ReturnType<typeof studioGeneratedObservedMediaInput.safeParse>):GeneratedMediaMatch{
 const result:GeneratedMediaMatch={matches:false,issues:[],limitations:[]},add=(code:GeneratedMediaIssueCode,path:string)=>result.issues.push({code,path});
 if(!spec.success)add('SPEC_INVALID','spec');if(!unit.success)add('WORK_UNIT_INVALID','workUnit');
 if(!observed.success)for(const issue of observed.error.issues){const code=issue.code==='custom'&&issue.params?.generatedCode==='UNSUPPORTED_CODEC'?'UNSUPPORTED_CODEC':'OBSERVATION_INVALID';const path='media'+(issue.path.length?'.'+issue.path.join('.'):'');if(!result.issues.some(item=>item.code===code&&item.path===path))add(code,path);}
 if(!spec.success||!unit.success||!observed.success)return result;
 const expected=spec.data,work=unit.data,media=observed.data;
 if(expected.kind!==work.kind)add('WORK_KIND_MISMATCH','workUnit.kind');if(expected.kind!==media.kind)add('MEDIA_KIND_MISMATCH','media.kind');if(result.issues.length)return result;
 if(expected.format!==media.format)add('FORMAT_MISMATCH','media.format');
 if(expected.kind!=='audio'&&media.kind!=='audio'){
  if(expected.width!==media.width||expected.height!==media.height)add('DIMENSIONS_MISMATCH','media.dimensions');
  if(expected.color.mode==='not_required')result.limitations.push('COLOR_METADATA_NOT_REQUIRED');
  else for(const key of ['space','primaries','transfer','range'] as const){if(media.color[key]===null||['unknown','unspecified','reserved','N/A'].includes(media.color[key]))add('COLOR_METADATA_UNKNOWN','media.color.'+key);else if(media.color[key]!==expected.color[key])add('COLOR_METADATA_MISMATCH','media.color.'+key);}
 }
 const sound=(expected:{codec:string;sampleRateHz:number;channels:number},actual:{codec:string;sampleRateHz:number;channels:number},path:string)=>{if(expected.codec!==actual.codec)add('CODEC_MISMATCH',path+'.codec');if(expected.sampleRateHz!==actual.sampleRateHz)add('SAMPLE_RATE_MISMATCH',path+'.sampleRateHz');if(expected.channels!==actual.channels)add('CHANNELS_MISMATCH',path+'.channels');};
 if(expected.kind==='audio'&&media.kind==='audio'&&work.kind==='audio'){
  sound(expected,media,'media');const numerator=BigInt(media.decodedSamples)*1000n,rate=BigInt(media.sampleRateHz);
  if(numerator<BigInt(work.durationMs.min)*rate||numerator>BigInt(work.durationMs.max)*rate)add('DURATION_MISMATCH','media.durationMs');
 }
 if(expected.kind==='video'&&media.kind==='video'&&work.kind==='video'){
  if(expected.codec!==media.codec)add('CODEC_MISMATCH','media.codec');
  if(media.vfr===null||media.frameRate===null&&media.vfr!==true)add('CADENCE_UNPROVEN','media.frameRate');
  else if(media.vfr===true)add('VARIABLE_FRAME_RATE','media.frameRate');
  else if(media.frameRate){
   if(BigInt(expected.frameRate.numerator)*BigInt(media.frameRate.denominator)!==BigInt(media.frameRate.numerator)*BigInt(expected.frameRate.denominator))add('FRAME_RATE_MISMATCH','media.frameRate');
   // The descriptor has no unrounded last-frame timestamp; require even the
   // CFR implied whole-file duration to be consistent with its rounded span.
   const implied=BigInt(media.frameCount)*BigInt(media.frameRate.denominator)*2000n,rate=BigInt(media.frameRate.numerator);
   if(implied<BigInt(media.durationMs*2-1)*rate||implied>=BigInt(media.durationMs*2+1)*rate)add('FRAME_TIMING_MISMATCH','media.durationMs');
  }
  result.limitations.push('VIDEO_DURATION_ROUNDED_TO_MS');
  if(media.durationMs<work.durationMs.min||media.durationMs>work.durationMs.max)add('DURATION_MISMATCH','media.durationMs');
  else if(media.durationMs-.5<work.durationMs.min||media.durationMs+.5>work.durationMs.max)add('DURATION_PRECISION_UNPROVEN','media.durationMs');
  if(expected.audio.mode==='none'){if(media.audio)add('AUDIO_UNEXPECTED','media.audio');}
  else if(!media.audio)add('AUDIO_REQUIRED','media.audio');else{sound(expected.audio,media.audio,'media.audio');result.limitations.push('EMBEDDED_AUDIO_TIMING_UNVERIFIED');}
 }
 result.matches=result.issues.length===0;return result;
}

export const studioGeneratedFileFactsInput=z.object({bytes:observedCommon.bytes,sha256:observedCommon.sha256,contentType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/wav','audio/mpeg'])}).strict();
export type GeneratedFileFacts=z.infer<typeof studioGeneratedFileFactsInput>;
/** Bind probe facts to separately loaded immutable, byte-verified file facts.
 * All four arguments are required. Caller still must enforce tenant/project,
 * archive/source identity, live authority and a real verification receipt. */
export function matchGeneratedArchiveMedia(spec:unknown,unit:unknown,descriptor:unknown,fileFacts:unknown):GeneratedMediaMatch{
 // One parsed snapshot must support both requirement matching and byte binding.
 // A second parse could read different facts from a getter-backed input object.
 const parsedSpec=studioGeneratedSpecInput.safeParse(spec),parsedUnit=studioGeneratedWorkUnitInput.safeParse(unit),media=studioGeneratedObservedMediaInput.safeParse(descriptor),file=studioGeneratedFileFactsInput.safeParse(fileFacts);
 const result=matchParsedGeneratedMedia(parsedSpec,parsedUnit,media);
 if(!file.success)result.issues.push({code:'FILE_FACTS_INVALID',path:'file'});
 else if(media.success){if(file.data.bytes!==media.data.bytes)result.issues.push({code:'FILE_BYTES_MISMATCH',path:'file.bytes'});if(file.data.sha256!==media.data.sha256)result.issues.push({code:'FILE_HASH_MISMATCH',path:'file.sha256'});if(file.data.contentType!==media.data.contentType)result.issues.push({code:'FILE_CONTENT_TYPE_MISMATCH',path:'file.contentType'});}
 result.matches=result.issues.length===0;return result;
}
