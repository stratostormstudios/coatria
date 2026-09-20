import {studioGeneratedProjectInput,type GeneratedWorkUnit} from './studio-generated-protocol';

export type GeneratedMediaKind=GeneratedWorkUnit['kind'];
export const GENERATED_VIDEO_CODECS={mp4:['h264','hevc','av1','mpeg4'],mov:['h264','hevc','mpeg4','prores']} as const;
export const GENERATED_PCM_CODECS=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'] as const;
export const GENERATED_EMBEDDED_CODECS={mp4:['aac','mp3'],mov:['aac','mp3',...GENERATED_PCM_CODECS]} as const;
export type GeneratedUnitDraft={key:string;code:string;description:string;durationMin:string;durationMax:string};
export type GeneratedProjectDraft={
 name:string;clientName:string;brief:string;dueDate:string;aiPolicy:'unknown'|'allowed'|'restricted';kind:GeneratedMediaKind;
 width:string;height:string;imageFormat:'png'|'jpeg'|'webp';videoFormat:'mp4'|'mov';videoCodec:string;
 colorMode:''|'exact'|'not_required';colorSpace:string;colorPrimaries:string;colorTransfer:string;colorRange:string;
 fpsNumerator:string;fpsDenominator:string;videoAudio:'none'|'required';embeddedCodec:string;
 audioFormat:'wav'|'mp3';audioCodec:string;sampleRate:string;channels:string;units:GeneratedUnitDraft[];
};
export function initialGeneratedProjectDraft():GeneratedProjectDraft{return {
 name:'',clientName:'',brief:'',dueDate:'',aiPolicy:'unknown',kind:'image',width:'1920',height:'1080',imageFormat:'png',videoFormat:'mp4',videoCodec:'h264',
 colorMode:'',colorSpace:'gbr',colorPrimaries:'bt709',colorTransfer:'iec61966-2-1',colorRange:'pc',fpsNumerator:'24',fpsDenominator:'1',videoAudio:'none',embeddedCodec:'aac',
 audioFormat:'wav',audioCodec:'pcm_s16le',sampleRate:'48000',channels:'2',units:[{key:'initial',code:'MEDIA010',description:'',durationMin:'4999',durationMax:'5001'}],
};}
export function changeGeneratedKind(draft:GeneratedProjectDraft,kind:GeneratedMediaKind):GeneratedProjectDraft{
 if(kind===draft.kind)return draft;
 return {...draft,kind,colorMode:'',colorSpace:kind==='image'?'gbr':'bt709',colorPrimaries:'bt709',colorTransfer:kind==='image'?'iec61966-2-1':'bt709',colorRange:kind==='image'?'pc':'tv'};
}
export function changeGeneratedVideoFormat(draft:GeneratedProjectDraft,videoFormat:'mp4'|'mov'):GeneratedProjectDraft{
 return {...draft,videoFormat,videoCodec:(GENERATED_VIDEO_CODECS[videoFormat] as readonly string[]).includes(draft.videoCodec)?draft.videoCodec:'h264',embeddedCodec:(GENERATED_EMBEDDED_CODECS[videoFormat] as readonly string[]).includes(draft.embeddedCodec)?draft.embeddedCodec:'aac'};
}
export function changeGeneratedAudioFormat(draft:GeneratedProjectDraft,audioFormat:'wav'|'mp3'):GeneratedProjectDraft{
 return {...draft,audioFormat,audioCodec:audioFormat==='mp3'?'mp3':(GENERATED_PCM_CODECS as readonly string[]).includes(draft.audioCodec)?draft.audioCodec:'pcm_s16le'};
}
export function nextGeneratedUnitCode(units:GeneratedUnitDraft[]):string{
 const used=new Set(units.map(unit=>unit.code.trim().toLowerCase()));for(let index=1;index<=1001;index++){const code=`MEDIA${String(index*10).padStart(3,'0')}`;if(!used.has(code.toLowerCase()))return code;}return 'MEDIA_NEW';
}
const numeric=(value:string)=>value.trim()===''?undefined:Number(value);
/** The reviewed API parser is the single authority. UI-only keys and irrelevant
 * media fields are deliberately excluded; an empty numeric control stays empty. */
export function parseGeneratedProjectDraft(draft:GeneratedProjectDraft,clientId:string){
 const color=draft.colorMode==='not_required'?{mode:'not_required'}:{mode:draft.colorMode,space:draft.colorSpace,primaries:draft.colorPrimaries,transfer:draft.colorTransfer,range:draft.colorRange};
 const visual={width:numeric(draft.width),height:numeric(draft.height),color};
 const sound={sampleRateHz:numeric(draft.sampleRate),channels:numeric(draft.channels)};
 const spec=draft.kind==='image'?{kind:'image',format:draft.imageFormat,...visual}:draft.kind==='audio'?{kind:'audio',format:draft.audioFormat,codec:draft.audioCodec,...sound}:{kind:'video',format:draft.videoFormat,codec:draft.videoCodec,...visual,frameRate:{mode:'constant',numerator:numeric(draft.fpsNumerator),denominator:numeric(draft.fpsDenominator)},audio:draft.videoAudio==='none'?{mode:'none'}:{mode:'required',codec:draft.embeddedCodec,...sound}};
 return studioGeneratedProjectInput.safeParse({clientId,contractVersion:2,productionPath:'higgsfield',name:draft.name,clientName:draft.clientName,brief:draft.brief,dueDate:draft.dueDate||null,aiPolicy:draft.aiPolicy,spec,shots:draft.units.map(unit=>({kind:draft.kind,code:unit.code,description:unit.description,...draft.kind==='image'?{}:{durationMs:{min:numeric(unit.durationMin),max:numeric(unit.durationMax)}}}))});
}
