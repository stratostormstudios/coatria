import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {changeGeneratedAudioFormat,changeGeneratedKind,changeGeneratedVideoFormat,initialGeneratedProjectDraft,nextGeneratedUnitCode,parseGeneratedProjectDraft,type GeneratedProjectDraft} from '../src/lib/generated-project-draft';
import {studioGeneratedProjectInput} from '../src/lib/studio-generated-protocol';

function draft():GeneratedProjectDraft{
 const value=initialGeneratedProjectDraft();
 return {...value,name:'  First light  ',clientName:'  Studio client  ',brief:'  A sunlit product launch.  ',colorMode:'exact',units:[{...value.units[0],description:'  Opening hero  '}]};
}
function parse(value:GeneratedProjectDraft){const result=parseGeneratedProjectDraft(value,randomUUID());if(!result.success)assert.fail(result.error.message);return result.data;}

test('image draft projects a strict reviewed image contract without UI keys or invented frame fields',()=>{
 const input={...draft(),durationMin:'bad',durationMax:'bad',fpsNumerator:'bad',audioCodec:'bad'};
 const result=parse(input);
 assert.deepEqual(result.spec,{kind:'image',format:'png',width:1920,height:1080,color:{mode:'exact',space:'gbr',primaries:'bt709',transfer:'iec61966-2-1',range:'pc'}});
 assert.deepEqual(result.shots,[{kind:'image',code:'MEDIA010',description:'Opening hero'}]);
 assert.equal(result.contractVersion,2);assert.equal(result.productionPath,'higgsfield');
 assert.equal(result.name,'First light');assert.equal(result.brief,'A sunlit product launch.');assert.equal(result.clientName,'Studio client');
 assert.equal(result.dueDate,null);assert.equal(result.aiPolicy,'unknown');
 assert.equal(Object.hasOwn(result,'units'),false);
 assert.equal(studioGeneratedProjectInput.safeParse(result).success,true);
});

test('visual color matching needs an explicit decision and media switches clear the previous decision',()=>{
 assert.equal(parseGeneratedProjectDraft({...draft(),colorMode:''},randomUUID()).success,false);
 const waiver=parse({...draft(),colorMode:'not_required',colorSpace:'invalid hidden state'});
 assert.deepEqual(waiver.spec.kind==='image'?waiver.spec.color:null,{mode:'not_required'});
 const video=changeGeneratedKind(draft(),'video');
 assert.equal(video.colorMode,'');assert.equal(video.colorSpace,'bt709');assert.equal(video.colorTransfer,'bt709');assert.equal(video.colorRange,'tv');
 assert.equal(parseGeneratedProjectDraft(video,randomUUID()).success,false);
 const image=changeGeneratedKind({...video,colorMode:'not_required'},'image');
 assert.equal(image.colorMode,'');assert.equal(image.colorSpace,'gbr');
 assert.equal(changeGeneratedKind(draft(),'image').colorMode,'exact');
});

test('switching to audio drops all visual state while preserving the brief and exact per-unit milliseconds',()=>{
 const value=changeGeneratedKind({...draft(),width:'',height:'',videoCodec:'invalid',fpsDenominator:'0',dueDate:'2026-12-10',aiPolicy:'restricted'},'audio');
 value.units[0]={...value.units[0],durationMin:'12001',durationMax:'12999'};
 const result=parse(value);
 assert.deepEqual(result.spec,{kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:2});
 assert.deepEqual(result.shots,[{kind:'audio',code:'MEDIA010',description:'Opening hero',durationMs:{min:12001,max:12999}}]);
 assert.equal(result.brief,'A sunlit product launch.');assert.equal(result.dueDate,'2026-12-10');assert.equal(result.aiPolicy,'restricted');
});

test('reviewed video uses a normalized rational constant rate and explicit silent or required audio',()=>{
 const value={...changeGeneratedKind(draft(),'video'),colorMode:'not_required' as const,fpsNumerator:'48000',fpsDenominator:'2000',sampleRate:'',channels:'',embeddedCodec:'stale'};
 const silent=parse(value);assert.equal(silent.spec.kind,'video');if(silent.spec.kind!=='video')throw new Error('video expected');
 assert.deepEqual(silent.spec.frameRate,{mode:'constant',numerator:24,denominator:1});assert.deepEqual(silent.spec.audio,{mode:'none'});
 assert.deepEqual(studioGeneratedProjectInput.parse(silent),silent,'Review and API parse must agree on the exact normalized contract.');
 const sound=parse({...value,videoAudio:'required',embeddedCodec:'aac',sampleRate:'44100',channels:'1',fpsNumerator:'24000',fpsDenominator:'1001'});
 assert.equal(sound.spec.kind,'video');if(sound.spec.kind!=='video')throw new Error('video expected');
 assert.deepEqual(sound.spec.audio,{mode:'required',codec:'aac',sampleRateHz:44100,channels:1});assert.deepEqual(sound.spec.frameRate,{mode:'constant',numerator:24000,denominator:1001});
 assert.deepEqual(sound.shots[0],{kind:'video',code:'MEDIA010',description:'Opening hero',durationMs:{min:4999,max:5001}});
});

test('container changes repair incompatible codecs while preserving compatible selections',()=>{
 let value={...changeGeneratedKind(draft(),'video'),colorMode:'not_required' as const,videoFormat:'mov' as const,videoCodec:'prores',videoAudio:'required' as const,embeddedCodec:'pcm_s24le'};
 const mp4=changeGeneratedVideoFormat(value,'mp4');assert.equal(mp4.videoCodec,'h264');assert.equal(mp4.embeddedCodec,'aac');parse(mp4);
 assert.equal(changeGeneratedVideoFormat({...value,videoCodec:'hevc',embeddedCodec:'mp3'},'mp4').videoCodec,'hevc');
 value={...value,videoFormat:'mov'};
 const mov=changeGeneratedVideoFormat({...value,videoFormat:'mp4',videoCodec:'av1'},'mov');assert.equal(mov.videoCodec,'h264');
 const mp3=changeGeneratedAudioFormat(changeGeneratedKind(draft(),'audio'),'mp3');assert.equal(mp3.audioCodec,'mp3');parse(mp3);
 const wav=changeGeneratedAudioFormat(mp3,'wav');assert.equal(wav.audioCodec,'pcm_s16le');parse(wav);
 assert.equal(changeGeneratedAudioFormat({...wav,audioCodec:'pcm_f64le'},'wav').audioCodec,'pcm_f64le');
 assert.equal(parseGeneratedProjectDraft({...mp4,videoCodec:'prores'},randomUUID()).success,false,'Strict parser still rejects forged state.');
});

test('empty and invalid numeric controls never silently become zero or receive invented defaults',()=>{
 for(const [key,value]of[['width',''],['height',' '],['width','0'],['width','2.5'],['width','NaN'],['width','Infinity']] as const){assert.equal(parseGeneratedProjectDraft({...draft(),[key]:value},randomUUID()).success,false,`${key}=${value}`);}
 const audio=changeGeneratedKind(draft(),'audio');
 for(const durationMin of['','0','1.5','3600001','NaN']){assert.equal(parseGeneratedProjectDraft({...audio,units:[{...audio.units[0],durationMin}]},randomUUID()).success,false,durationMin);}
 assert.equal(parseGeneratedProjectDraft({...audio,units:[{...audio.units[0],durationMin:'100',durationMax:'99'}]},randomUUID()).success,false);
 assert.equal(parseGeneratedProjectDraft({...audio,sampleRate:''},randomUUID()).success,false);
 const video={...changeGeneratedKind(draft(),'video'),colorMode:'not_required' as const};
 for(const [fpsNumerator,fpsDenominator]of[['24',''],['241','1'],['1','0']])assert.equal(parseGeneratedProjectDraft({...video,fpsNumerator,fpsDenominator},randomUUID()).success,false);
});

test('work-unit editing enforces unique codes, descriptions, and the 100-deliverable boundary',()=>{
 const value=draft();
 assert.equal(parseGeneratedProjectDraft({...value,units:[]},randomUUID()).success,false);
 assert.equal(parseGeneratedProjectDraft({...value,units:[{...value.units[0],description:' '}]},randomUUID()).success,false);
 assert.equal(parseGeneratedProjectDraft({...value,units:[...value.units,{...value.units[0],key:'second',code:'media010'}]},randomUUID()).success,false);
 for(const code of['space inside','_leading','!','x'.repeat(41)])assert.equal(parseGeneratedProjectDraft({...value,units:[{...value.units[0],code}]},randomUUID()).success,false,code);
 const units=Array.from({length:100},(_,index)=>({...value.units[0],key:`key${index}`,code:`MEDIA${index}`}));assert.equal(parse({...value,units}).shots.length,100);
 assert.equal(parseGeneratedProjectDraft({...value,units:[...units,{...value.units[0],key:'extra',code:'EXTRA'}]},randomUUID()).success,false);
});

test('adding after removal reuses the first available code without colliding case-insensitively',()=>{
 const unit=draft().units[0];
 assert.equal(nextGeneratedUnitCode([]),'MEDIA010');
 assert.equal(nextGeneratedUnitCode([{...unit,code:' media010 '},{...unit,key:'3',code:'MEDIA030'}]),'MEDIA020');
 assert.equal(nextGeneratedUnitCode(Array.from({length:100},(_,index)=>({...unit,key:`${index}`,code:`MEDIA${String((index+1)*10).padStart(3,'0')}`}))),'MEDIA1010');
});
