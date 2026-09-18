import {EXECUTION_BUILTIN_PROFILES} from './studio-execution-protocol';
import type {StudioProject} from './studio-protocol';

type Shot={frameStart:number;frameEnd:number;handles:number;disciplines:readonly string[]};
/** Planning defaults only; model-specific generation settings are reviewed in the Higgsfield panel. */
export function higgsfieldProjectPreset(){
 return {spec:{width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'mp4' as const,colorSpace:'Rec.709'},shots:[{code:'SH010',description:'A five-second concept clip developed from approved references. Confirm the generation model and its supported settings before submitting.',frameStart:1,frameEnd:120,handles:0,disciplines:['compositing' as const]}]};
}
export const HIGGSFIELD_PRODUCTION_STEPS=['Brief','References','Generation','Review','Delivery'] as const;
/** An explicit UI starting point, not permission to execute or a new backend project mode. */
export function proceduralTurntablePreset(){
 return {spec:{width:384,height:384,fpsNumerator:24,fpsDenominator:1,format:'exr' as const,colorSpace:'Linear Rec.709'},shots:[{code:'SH010',description:'An original procedural product turntable. No client model, textures or filmed footage are consumed.',frameStart:1001,frameEnd:1004,handles:0,disciplines:['lighting' as const]}]};
}
/** Capability fit for the one-shot pilot only. Server approval and worker validation still apply. */
export function proceduralTurntableFit(spec:StudioProject['spec'],shots:readonly Shot[]){
 const profile=EXECUTION_BUILTIN_PROFILES.find(item=>item.key==='coatria-product-turntable-v1'&&item.version===1)!;
 const reasons:string[]=[];
 if(shots.length!==1)reasons.push('The turntable pilot needs exactly one shot.');
 if(spec.format!=='exr')reasons.push('The turntable produces an EXR image sequence, not a movie.');
 if(!Number.isInteger(spec.width)||!Number.isInteger(spec.height)||spec.width<profile.minWidth||spec.height<profile.minHeight||spec.width>profile.maxWidth||spec.height>profile.maxHeight)reasons.push(`Use ${profile.minWidth}–${profile.maxWidth} pixels in width and ${profile.minHeight}–${profile.maxHeight} in height.`);
 const rate=spec.fpsNumerator/spec.fpsDenominator;
 if(!Number.isInteger(spec.fpsNumerator)||!Number.isInteger(spec.fpsDenominator)||spec.fpsNumerator<1||spec.fpsDenominator<1||rate<1||rate>profile.maxFps)reasons.push(`Use a valid rational frame rate between 1 and ${profile.maxFps} fps.`);
 if(!profile.colorSpaces.includes(spec.colorSpace))reasons.push(`Use ${profile.colorSpaces.join(' or ')} for the working color space.`);
 for(const shot of shots){
  if(shot.disciplines.length!==1||shot.disciplines[0]!=='lighting')reasons.push('Use only the lighting discipline for this procedural pilot; other disciplines need their own production work.');
  if(!Number.isInteger(shot.frameStart)||!Number.isInteger(shot.frameEnd)||!Number.isInteger(shot.handles)||shot.frameStart<0||shot.frameEnd<shot.frameStart||shot.frameEnd>10_000_000||shot.handles<0){reasons.push('Use an ordered integer frame range and nonnegative handles.');continue;}
  const start=Math.max(0,shot.frameStart-shot.handles),end=shot.frameEnd+shot.handles,count=end-start+1;
  if(end>10_000_000||count>profile.maxFrames)reasons.push(`The full shot including handles must fit within ${profile.maxFrames} frames.`);
  if(count*spec.width*spec.height>profile.maxTotalPixels)reasons.push(`The full shot including handles must stay within ${profile.maxTotalPixels.toLocaleString('en-US')} total pixels.`);
 }
 return {supported:reasons.length===0,reasons:[...new Set(reasons)],profileKey:profile.key,profileVersion:profile.version};
}
