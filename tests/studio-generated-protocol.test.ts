import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {access,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {studioProjectInput,studioArtifactInput} from '../src/lib/studio-protocol';
import {studioGeneratedSpecInput,studioGeneratedWorkUnitInput,studioGeneratedProjectInput,studioGeneratedArtifactRegisterInput,studioGeneratedObservedMediaInput,generatedSpecificationCanonical,generatedSpecificationSha256,matchGeneratedMedia,matchGeneratedArchiveMedia,STUDIO_GENERATED_MAX_DURATION_MS,type GeneratedMediaIssueCode} from '../src/lib/studio-generated-protocol';
import {inspectHiggsfieldArchiveMedia} from '../src/lib/higgsfield-media-inspection';

const color={space:'bt709',primaries:'bt709',transfer:'bt709',range:'tv'},unknownColor={space:null,primaries:null,transfer:null,range:null};
const waiver={mode:'not_required'};
const image={kind:'image',format:'png',width:1920,height:1080,color:waiver};
const video={kind:'video',format:'mp4',codec:'h264',width:1920,height:1080,color:{mode:'exact',...color},frameRate:{mode:'constant',numerator:24,denominator:1},audio:{mode:'none'}};
const audio={kind:'audio',format:'wav',codec:'pcm_s16le',sampleRateHz:48000,channels:2};
const imageUnit={kind:'image',code:'DIR010',description:'First direction'},videoUnit={kind:'video',code:'VID010',description:'First video',durationMs:{min:999,max:1001}},audioUnit={kind:'audio',code:'AUD010',description:'First audio',durationMs:{min:1000,max:1000}};
const common={bytes:1000,sha256:'a'.repeat(64),verification:'full_decode',inspectionVersion:1};
const imageMedia={...common,kind:'image',format:'png',contentType:'image/png',width:1920,height:1080,codec:'png',color:unknownColor};
const videoMedia={...common,kind:'video',format:'mp4',contentType:'video/mp4',width:1920,height:1080,codec:'h264',color,durationMs:1000,frameRate:{numerator:24,denominator:1},averageFrameRate:{numerator:24,denominator:1},vfr:false,frameCount:24,audio:null};
const audioMedia={...common,kind:'audio',format:'wav',contentType:'audio/wav',codec:'pcm_s16le',sampleRateHz:48000,channels:2,durationMs:1000,decodedSamples:48000};
const project=(spec:unknown,shots:unknown[])=>({clientId:randomUUID(),contractVersion:2,productionPath:'higgsfield',name:'Generated contract fixture',clientName:'Internal',brief:'One exact reviewed deliverable',spec,shots});
const has=(result:ReturnType<typeof matchGeneratedMedia>,code:GeneratedMediaIssueCode)=>{assert.equal(result.matches,false);assert(result.issues.some(issue=>issue.code===code),JSON.stringify(result));};

test('v2 strict schemas reject legacy frame fields, cross-kind data, unknown keys and unbounded inputs',()=>{
 for(const value of[null,{},[],{...image,kind:'audio'},{...image,format:'exr'},{...image,color:undefined},{...image,color:{mode:'not_required',space:'bt709'}},{...image,width:0},{...image,width:16384,height:16384},{...video,codec:'vp9'},{...video,codec:'prores'},{...video,audio:undefined},{...video,frameRate:{mode:'variable'}},{...video,frameRate:{mode:'constant',numerator:241,denominator:1}},{...video,frameRate:{mode:'constant',numerator:24,denominator:0}},{...audio,format:'mp3'},{...audio,sampleRateHz:Infinity},{...audio,channels:9},{...audio,width:1920}])assert.equal(studioGeneratedSpecInput.safeParse(value).success,false,JSON.stringify(value));
 for(const value of[{...imageUnit,frameStart:0},{...imageUnit,handles:0},{...imageUnit,durationMs:{min:1,max:2}},{...audioUnit,disciplines:[]},{...videoUnit,durationMs:{min:10,max:9}},{...videoUnit,durationMs:{min:0,max:10}},{...videoUnit,durationMs:{min:1,max:STUDIO_GENERATED_MAX_DURATION_MS+1}},{...videoUnit,durationMs:{min:1.5,max:10}},{...audioUnit,frameEnd:1}])assert.equal(studioGeneratedWorkUnitInput.safeParse(value).success,false);
 assert.equal(studioGeneratedProjectInput.safeParse({...project(image,[imageUnit]),contractVersion:undefined}).success,false);
 assert.equal(studioGeneratedProjectInput.safeParse({...project(image,[imageUnit]),productionPath:'vfx'}).success,false);
 assert.equal(studioGeneratedProjectInput.safeParse(project(image,[audioUnit])).success,false);
 assert.equal(studioGeneratedProjectInput.safeParse(project(image,[imageUnit,{...imageUnit,code:'dir010'}])).success,false);
 assert.equal(studioGeneratedProjectInput.safeParse(project(image,[])).success,false);
 assert.equal(studioGeneratedProjectInput.safeParse(project(image,Array.from({length:101},(_,i)=>({...imageUnit,code:'D'+i})))).success,false);
});

test('all three explicit v2 kinds preserve their own units without invented frame fields',()=>{
 for(const[spec,unit]of[[image,imageUnit],[video,videoUnit],[audio,audioUnit]]){
  const parsed=studioGeneratedProjectInput.parse(project(spec,[unit]));assert.equal(parsed.contractVersion,2);assert.equal(parsed.spec.kind,parsed.shots[0].kind);
  for(const field of['frameStart','frameEnd','handles','disciplines'])assert(!Object.hasOwn(parsed.shots[0],field));
 }
 assert.equal(studioGeneratedSpecInput.safeParse({...audio,format:'mp3',codec:'mp3'}).success,true);
 assert.equal(studioGeneratedSpecInput.safeParse({...video,format:'mov',codec:'prores'}).success,true);
});

test('v2 free text rejects JSONB-incompatible Unicode without changing valid international text',async()=>{
 const registration={clientId:randomUUID(),revision:1,workItemId:randomUUID(),archiveId:randomUUID(),name:'Approved output'};
 for(const invalid of['before\0after','before\ud800after','before\udc00after','ending\ud800']){
  for(const field of['name','clientName','brief'])assert.equal(studioGeneratedProjectInput.safeParse({...project(image,[imageUnit]),[field]:invalid}).success,false,field);
  assert.equal(studioGeneratedWorkUnitInput.safeParse({...imageUnit,description:invalid}).success,false);
  for(const field of['name','notes'])assert.equal(studioGeneratedArtifactRegisterInput.safeParse({...registration,[field]:invalid}).success,false,field);
  await assert.rejects(generatedSpecificationSha256(image,{...imageUnit,description:invalid}));
 }
 const description='Direction — 東京 🎬';assert.equal(studioGeneratedWorkUnitInput.parse({...imageUnit,description}).description,description);
 assert.equal(studioGeneratedArtifactRegisterInput.parse({...registration,notes:description}).notes,description);
 assert.equal(await generatedSpecificationSha256(image,{...imageUnit,description}),createHash('sha256').update(generatedSpecificationCanonical(image,{...imageUnit,description})).digest('hex'));
});

test('registration accepts only archive identity; callers cannot provide URLs, bytes, probes or producer attribution',()=>{
 const input={clientId:randomUUID(),revision:1,workItemId:randomUUID(),archiveId:randomUUID(),name:'Approved generated output'};
 assert.equal(studioGeneratedArtifactRegisterInput.parse(input).notes,'');
 for(const key of['url','sha256','bytes','contentType','media','probe','producedBy','approvedBy','versionId','outputId','contractVersion'])assert.equal(studioGeneratedArtifactRegisterInput.safeParse({...input,[key]:'caller-supplied'}).success,false,key);
 assert.equal(studioGeneratedArtifactRegisterInput.safeParse({...input,archiveId:'https://private.invalid/file'}).success,false);
 assert.equal(studioGeneratedArtifactRegisterInput.safeParse({...input,clientId:undefined}).success,false);
});

test('runtime observation validation rejects inconsistent MIME, impossible facts, extra transport and unknown codecs',()=>{
 for(const value of[null,{}, {...imageMedia,url:'https://private.invalid/file'},{...imageMedia,bytes:0},{...imageMedia,bytes:NaN},{...imageMedia,bytes:100*1024**3+1},{...imageMedia,sha256:'A'.repeat(64)},{...imageMedia,verification:'declared'},{...imageMedia,inspectionVersion:2},{...imageMedia,contentType:'image/jpeg'},{...audioMedia,width:16},{...audioMedia,decodedSamples:48001,durationMs:2000},{...audioMedia,decodedSamples:2_000_000_000,channels:2},{...videoMedia,vfr:true},{...videoMedia,frameCount:2},{...videoMedia,frameRate:{numerator:NaN,denominator:1}}]){
  assert.equal(studioGeneratedObservedMediaInput.safeParse(value).success,false);has(matchGeneratedMedia(image,imageUnit,value),'OBSERVATION_INVALID');
 }
 has(matchGeneratedMedia(image,imageUnit,{...imageMedia,codec:'mjpeg'}),'UNSUPPORTED_CODEC');
 has(matchGeneratedMedia(video,videoUnit,{...videoMedia,codec:'unrecognized_codec'}),'UNSUPPORTED_CODEC');
 has(matchGeneratedMedia(audio,audioUnit,{...audioMedia,codec:'aac'}),'UNSUPPORTED_CODEC');
 has(matchGeneratedMedia(video,videoUnit,{...videoMedia,audio:{codec:'opus',sampleRateHz:48000,channels:2}}),'UNSUPPORTED_CODEC');
 has(matchGeneratedMedia(null,imageUnit,imageMedia),'SPEC_INVALID');has(matchGeneratedMedia(image,{},imageMedia),'WORK_UNIT_INVALID');
});

test('kind, supported format, codec, dimensions and audio sample requirements must exactly match',()=>{
 has(matchGeneratedMedia(image,audioUnit,imageMedia),'WORK_KIND_MISMATCH');has(matchGeneratedMedia(image,imageUnit,audioMedia),'MEDIA_KIND_MISMATCH');
 has(matchGeneratedMedia(image,imageUnit,{...imageMedia,format:'jpeg',contentType:'image/jpeg',codec:'mjpeg'}),'FORMAT_MISMATCH');
 has(matchGeneratedMedia(video,videoUnit,{...videoMedia,codec:'hevc'}),'CODEC_MISMATCH');
 has(matchGeneratedMedia(image,imageUnit,{...imageMedia,width:1919}),'DIMENSIONS_MISMATCH');
 has(matchGeneratedMedia(audio,audioUnit,{...audioMedia,codec:'pcm_s24le'}),'CODEC_MISMATCH');
 has(matchGeneratedMedia(audio,audioUnit,{...audioMedia,sampleRateHz:44100,decodedSamples:44100}),'SAMPLE_RATE_MISMATCH');
 has(matchGeneratedMedia(audio,audioUnit,{...audioMedia,channels:1}),'CHANNELS_MISMATCH');
 assert.equal(matchGeneratedMedia(audio,audioUnit,audioMedia).matches,true);
});

test('observations cannot exceed actual aggregate decoder ceilings hidden by per-frame or rounded limits',()=>{
 const largeVideo={...videoMedia,width:16384,height:4096,frameCount:2400,durationMs:100000};
 assert.equal(studioGeneratedSpecInput.safeParse({...video,width:largeVideo.width,height:largeVideo.height}).success,true);
 has(matchGeneratedMedia({...video,width:largeVideo.width,height:largeVideo.height},{...videoUnit,durationMs:{min:99999,max:100001}},largeVideo),'OBSERVATION_INVALID');
 const atLimit={...audioMedia,channels:1,decodedSamples:172800000,durationMs:STUDIO_GENERATED_MAX_DURATION_MS};
 assert.equal(studioGeneratedObservedMediaInput.safeParse(atLimit).success,true);
 assert.equal(Math.round((atLimit.decodedSamples+1)/atLimit.sampleRateHz*1000),STUDIO_GENERATED_MAX_DURATION_MS);
 assert.equal(studioGeneratedObservedMediaInput.safeParse({...atLimit,decodedSamples:atLimit.decodedSamples+1}).success,false,'Rounded milliseconds must not hide samples beyond the exact one-hour ceiling');
});

test('color waiver is explicit; exact raw tags never infer color from file type or normalized names',()=>{
 const waived=matchGeneratedMedia(image,imageUnit,imageMedia);assert.equal(waived.matches,true);assert.deepEqual(waived.limitations,['COLOR_METADATA_NOT_REQUIRED']);
 has(matchGeneratedMedia({...image,color:{mode:'exact',...color}},imageUnit,imageMedia),'COLOR_METADATA_UNKNOWN');
 assert.equal(matchGeneratedMedia({...image,color:{mode:'exact',...color}},imageUnit,{...imageMedia,color}).matches,true);
 for(const observed of[{...color,transfer:'unknown'},{...color,range:null},{...color,primaries:'unspecified'}])has(matchGeneratedMedia(video,videoUnit,{...videoMedia,color:observed}),'COLOR_METADATA_UNKNOWN');
 for(const observed of[{...color,primaries:'Rec.709'},{...color,range:'limited'},{...color,space:'BT709'}])has(matchGeneratedMedia(video,videoUnit,{...videoMedia,color:observed}),'COLOR_METADATA_MISMATCH');
});

test('CFR uses measured rational cadence, rejects VFR/unknown evidence and detects inconsistent final-frame timing',()=>{
 assert.equal(matchGeneratedMedia(video,videoUnit,{...videoMedia,frameRate:{numerator:48000,denominator:2000}}).matches,true);
 has(matchGeneratedMedia(video,videoUnit,{...videoMedia,frameRate:{numerator:25,denominator:1}}),'FRAME_RATE_MISMATCH');
 has(matchGeneratedMedia(video,videoUnit,{...videoMedia,vfr:true,frameRate:null}),'VARIABLE_FRAME_RATE');
 has(matchGeneratedMedia(video,videoUnit,{...videoMedia,frameCount:2,vfr:null,frameRate:null}),'CADENCE_UNPROVEN');
 // Average FPS is a container summary, never a substitute for observed cadence.
 assert.equal(matchGeneratedMedia(video,videoUnit,{...videoMedia,averageFrameRate:{numerator:999,denominator:1}}).matches,true);
 has(matchGeneratedMedia(video,{...videoUnit,durationMs:{min:998,max:1002}},{...videoMedia,durationMs:1001}),'FRAME_TIMING_MISMATCH');
});

test('duration tolerance is explicit: rounded video boundaries cannot prove exact milliseconds; audio uses decoded samples',()=>{
 for(const bounds of[{min:1000,max:1000},{min:1000,max:1001},{min:999,max:1000}])has(matchGeneratedMedia(video,{...videoUnit,durationMs:bounds},videoMedia),'DURATION_PRECISION_UNPROVEN');
 assert.equal(matchGeneratedMedia(video,videoUnit,videoMedia).matches,true);
 has(matchGeneratedMedia(video,{...videoUnit,durationMs:{min:1001,max:1002}},videoMedia),'DURATION_MISMATCH');
 const fractional={...audioMedia,decodedSamples:48001};assert.equal(fractional.durationMs,1000);
 has(matchGeneratedMedia(audio,audioUnit,fractional),'DURATION_MISMATCH');
 assert.equal(matchGeneratedMedia(audio,{...audioUnit,durationMs:{min:1000,max:1001}},fractional).matches,true);
 assert.equal(matchGeneratedMedia(audio,audioUnit,audioMedia).matches,true,'Exact audio sample counts can prove an integer-ms boundary');
});

test('embedded audio is explicit and does not imply proven duration or synchronization',()=>{
 const sound={codec:'aac',sampleRateHz:48000,channels:2},required={...video,audio:{mode:'required',...sound}};
 has(matchGeneratedMedia(video,videoUnit,{...videoMedia,audio:sound}),'AUDIO_UNEXPECTED');
 has(matchGeneratedMedia(required,videoUnit,videoMedia),'AUDIO_REQUIRED');
 const result=matchGeneratedMedia(required,videoUnit,{...videoMedia,audio:sound});assert.equal(result.matches,true);assert(result.limitations.includes('EMBEDDED_AUDIO_TIMING_UNVERIFIED'));
 has(matchGeneratedMedia(required,videoUnit,{...videoMedia,audio:{...sound,channels:1}}),'CHANNELS_MISMATCH');
});

test('archive matching requires separate exact immutable file facts without accepting an optional or caller media fallback',()=>{
 const facts={bytes:imageMedia.bytes,sha256:imageMedia.sha256,contentType:imageMedia.contentType};assert.equal(matchGeneratedArchiveMedia(image,imageUnit,imageMedia,facts).matches,true);
 for(const bad of[undefined,null,{}, {...facts,url:'https://private.invalid/'}])has(matchGeneratedArchiveMedia(image,imageUnit,imageMedia,bad),'FILE_FACTS_INVALID');
 has(matchGeneratedArchiveMedia(image,imageUnit,imageMedia,{...facts,bytes:1001}),'FILE_BYTES_MISMATCH');
 has(matchGeneratedArchiveMedia(image,imageUnit,imageMedia,{...facts,sha256:'b'.repeat(64)}),'FILE_HASH_MISMATCH');
 has(matchGeneratedArchiveMedia(image,imageUnit,imageMedia,{...facts,contentType:'image/webp'}),'FILE_CONTENT_TYPE_MISMATCH');
});

test('canonical v2 specification/work hashing is stable, normalized only for rational equivalence and sensitive to requirements',async()=>{
 const canonical='{"kind":"generated_specification","schemaVersion":2,"spec":{"color":{"mode":"not_required"},"format":"png","height":1080,"kind":"image","width":1920},"workUnit":{"code":"DIR010","description":"First direction","kind":"image"}}';
 assert.equal(generatedSpecificationCanonical(image,imageUnit),canonical);assert.equal(await generatedSpecificationSha256(image,imageUnit),createHash('sha256').update(canonical).digest('hex'));
 const reversed=Object.fromEntries(Object.entries(image).reverse());assert.equal(await generatedSpecificationSha256(image,imageUnit),await generatedSpecificationSha256(reversed,imageUnit));
 assert.equal(await generatedSpecificationSha256(video,videoUnit),await generatedSpecificationSha256({...video,frameRate:{mode:'constant',numerator:48000,denominator:2000}},videoUnit));
 for(const[spec,unit]of[[{...image,width:1921},imageUnit],[image,{...imageUnit,code:'DIR011'}],[image,{...imageUnit,description:'Changed intent'}],[{...image,color:{mode:'exact',...color}},imageUnit]])assert.notEqual(await generatedSpecificationSha256(image,imageUnit),await generatedSpecificationSha256(spec,unit));
 await assert.rejects(generatedSpecificationSha256(image,audioUnit));
});

test('archive requirement matching and byte binding use one parsed descriptor snapshot',()=>{
 let reads=0;
 const changing=Object.defineProperty({...imageMedia},'bytes',{enumerable:true,get(){return ++reads===1?1000:2000;}});
 const facts={bytes:2000,sha256:imageMedia.sha256,contentType:imageMedia.contentType};
 has(matchGeneratedArchiveMedia(image,imageUnit,changing,facts),'FILE_BYTES_MISMATCH');assert.equal(reads,1);
 let invalidReads=0;
 const invalidFirst=Object.defineProperty({...imageMedia},'bytes',{enumerable:true,get(){return ++invalidReads===1?0:2000;}});
 has(matchGeneratedArchiveMedia(image,imageUnit,invalidFirst,facts),'OBSERVATION_INVALID');assert.equal(invalidReads,1,'An invalid observation must not be re-read into a valid one');
});

test('legacy project/artifact parsers retain their exact frame-only branch',()=>{
 const legacy={clientId:randomUUID(),name:'Legacy',clientName:'Internal',brief:'Legacy frames',spec:{width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'},shots:[{code:'SH010',description:'Legacy shot',frameStart:0,frameEnd:23,disciplines:['compositing']}]};
 const parsed=studioProjectInput.parse(legacy);assert(!Object.hasOwn(parsed,'contractVersion'));assert.equal(parsed.productionPath,'vfx');assert.equal(parsed.shots[0].handles,8);assert.equal(studioProjectInput.safeParse({...legacy,contractVersion:2}).success,false);assert.equal(studioProjectInput.safeParse(project(image,[imageUnit])).success,false);
 assert.equal(studioArtifactInput.safeParse({clientId:randomUUID(),revision:1,workItemId:randomUUID(),archiveId:randomUUID(),name:'Generated'}).success,false);
});

const fixtures=fileURLToPath(new URL('./fixtures/media/',import.meta.url)),bin=process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Microsoft','WinGet','Links'):'/usr/bin';
const native={nativeTestMode:true as const,ffprobePath:process.env.COATRIA_TEST_FFPROBE_PATH??process.env.COATRIA_FFPROBE_PATH??join(bin,process.platform==='win32'?'ffprobe.exe':'ffprobe'),ffmpegPath:process.env.COATRIA_TEST_FFMPEG_PATH??process.env.COATRIA_FFMPEG_PATH??join(bin,process.platform==='win32'?'ffmpeg.exe':'ffmpeg')};
test('actual original fixture descriptors match reviewed image/video/audio requirements without assigning missing color',{timeout:30000},async t=>{
 // Same explicit decoder prerequisite as the existing media-inspection suite;
 // no provider/network calls, generated probes or invented received bytes.
 for(const path of[native.ffprobePath,native.ffmpegPath])await access(path);
 for(const[format,kind,codec,rate]of[['png','image','png',0],['jpeg','image','mjpeg',0],['webp','image','webp',0],['mp4','video','h264',0],['mov','video','h264',0],['wav','audio','pcm_s16le',8000],['mp3','audio','mp3',44100]] as const)await t.test(format,async()=>{
  const path=resolve(fixtures,'synthetic.'+format),bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex');
  const descriptor=await inspectHiggsfieldArchiveMedia({path,expectedKind:kind,expectedBytes:bytes.length,expectedSha256:sha256},native);
  const spec=kind==='image'?{...image,format,width:16,height:16}:kind==='video'?{...video,format,codec,width:16,height:16,color:waiver,frameRate:{mode:'constant',numerator:6,denominator:1}}:{...audio,format,codec,sampleRateHz:rate,channels:1};
  const unit=kind==='image'?imageUnit:kind==='video'?{...videoUnit,durationMs:{min:499,max:501}}:{...audioUnit,durationMs:{min:100,max:100}};
  const result=matchGeneratedArchiveMedia(spec,unit,descriptor,{bytes:bytes.length,sha256,contentType:descriptor.contentType});assert.equal(result.matches,true,JSON.stringify(result));
  if(kind!=='audio')assert(result.limitations.includes('COLOR_METADATA_NOT_REQUIRED'));
 });
});
