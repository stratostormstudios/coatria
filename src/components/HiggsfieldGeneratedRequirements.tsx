import type {StudioReadableProjectDetail,StudioGeneratedProjectDetail} from '@/lib/studio-protocol';
import s from './HiggsfieldProductionPanel.module.css';

/** Requirements describe approved intent, never observations of provider media. */
export function HiggsfieldGeneratedRequirements({detail,workItemId}:{detail:StudioReadableProjectDetail|null;workItemId?:string}){
 if(detail?.project.contractVersion!==2)return null;
 const generated=detail as StudioGeneratedProjectDetail,spec=generated.project.spec,work=generated.workItems.find(item=>item.id===workItemId),unit=generated.shots.find(item=>item.id===work?.shotId);
 return <section className={s.request} aria-label="Generated media requirements">
  <div><h3>Required {spec.kind} output</h3><p>{unit?`${unit.code} · ${unit.description}`:'Choose a generation task to see its deliverable requirements.'}</p></div>
  <p><strong>{spec.format.toUpperCase()}</strong>{spec.kind!=='audio'&&` · ${spec.width} × ${spec.height} pixels`}{spec.kind==='video'&&` · ${spec.codec.toUpperCase()} · ${spec.frameRate.numerator} / ${spec.frameRate.denominator} fps (constant)`}{spec.kind==='audio'&&` · ${spec.codec} · ${spec.sampleRateHz.toLocaleString()} Hz · ${spec.channels} ${spec.channels===1?'channel':'channels'}`}</p>
  {unit&&unit.kind!=='image'&&<p><strong>Duration:</strong> {unit.durationMs.min.toLocaleString()}–{unit.durationMs.max.toLocaleString()} ms</p>}
  {spec.kind!=='audio'&&<p><strong>Color:</strong> {spec.color.mode==='not_required'?'Exact color metadata is not required by this specification.':`${spec.color.space} · ${spec.color.primaries} · ${spec.color.transfer} · ${spec.color.range}`}</p>}
  {spec.kind==='video'&&<p><strong>Audio:</strong> {spec.audio.mode==='none'?'No embedded audio.':`${spec.audio.codec} · ${spec.audio.sampleRateHz.toLocaleString()} Hz · ${spec.audio.channels} ${spec.audio.channels===1?'channel':'channels'}`}</p>}
  <p>Use a model that can meet these requirements. The exact arguments still need review; provider completion and a stored file do not establish a specification match or media approval.</p>
 </section>;
}
