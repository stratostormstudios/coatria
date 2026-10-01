'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowLeft,ArrowRight,AudioLines,Check,ClipboardCheck,Film,Image as ImageIcon,LoaderCircle,Plus,Trash2} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import type {StudioGeneratedProject} from '@/lib/studio-protocol';
import type {GeneratedProjectInput} from '@/lib/studio-generated-protocol';
import {changeGeneratedAudioFormat,changeGeneratedKind,changeGeneratedVideoFormat,GENERATED_EMBEDDED_CODECS,GENERATED_PCM_CODECS,GENERATED_VIDEO_CODECS,initialGeneratedProjectDraft,nextGeneratedUnitCode,parseGeneratedProjectDraft,type GeneratedProjectDraft,type GeneratedUnitDraft} from '@/lib/generated-project-draft';
import {Field,Modal} from './ui';
import {useStudioMutation} from './studio-hooks';
import s from './GeneratedProjectWizard.module.css';

type Props={p:WorkspaceProps;onClose:()=>void;onSaved:(project:StudioGeneratedProject)=>void|Promise<void>};
const steps=['Brief','Delivery target','Deliverables','Review'];
const mediaChoices=[{kind:'image',title:'Image',description:'Campaign stills, concepts, key art',Icon:ImageIcon},{kind:'video',title:'Video',description:'Clips, motion, generated sequences',Icon:Film},{kind:'audio',title:'Audio',description:'Voice, music, sound design',Icon:AudioLines}] as const;
const codecNames:Record<string,string>={h264:'H.264',hevc:'HEVC / H.265',av1:'AV1',mpeg4:'MPEG-4',prores:'ProRes',aac:'AAC',mp3:'MP3',pcm_u8:'PCM · 8-bit unsigned',pcm_s16le:'PCM · 16-bit',pcm_s24le:'PCM · 24-bit',pcm_s32le:'PCM · 32-bit',pcm_f32le:'PCM · 32-bit float',pcm_f64le:'PCM · 64-bit float'};
const policyNames={unknown:'Not confirmed yet',allowed:'AI use permitted',restricted:'Restricted · see brief'};
const fieldNames:Record<string,string>={name:'Project name',clientName:'Client / brand',brief:'Creative brief',dueDate:'Delivery date',aiPolicy:'AI-use policy',width:'Width',height:'Height',codec:'Codec',format:'File format',sampleRateHz:'Sample rate',channels:'Channels',frameRate:'Frame rate',numerator:'Frame-rate numerator',denominator:'Frame-rate denominator',audio:'Embedded audio',color:'Color metadata',code:'Code',description:'Description',durationMs:'Duration interval',min:'Minimum duration',max:'Maximum duration'};
function issueLabel(path:PropertyKey[]){const label=fieldNames[String(path.at(-1))]||'Delivery target';return path[0]==='shots'?(typeof path[1]==='number'?`Deliverable ${path[1]+1} · ${label}`:'Deliverables'):label;}

/** Keep drafts, in-flight responses and retry IDs inside one member identity. */
export function GeneratedProjectWizard(props:Props){
 return <GeneratedProjectWizardForm key={`${props.p.user.id}:${props.p.company.id}:${props.p.company.role}`} {...props}/>;
}

function GeneratedProjectWizardForm({p,onClose,onSaved}:Props){
 const [draft,setDraft]=useState(initialGeneratedProjectDraft),[step,setStep]=useState(0),[validation,setValidation]=useState('');
 const [validationId]=useState(()=>crypto.randomUUID()),[reviewed,setReviewed]=useState<GeneratedProjectInput|null>(null);
 const [createdProject,setCreatedProject]=useState<StudioGeneratedProject|null>(null),[opening,setOpening]=useState(false),[openError,setOpenError]=useState('');
 const mutation=useStudioMutation(),heading=useRef<HTMLHeadingElement>(null),errorRef=useRef<HTMLParagraphElement>(null),openPending=useRef(false);
 const busy=mutation.busy||opening,locked=busy||!!createdProject,error=validation||openError||(step===3?mutation.error:'');
 useEffect(()=>{if(step>0)heading.current?.focus();},[step]);
 useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
 function change<K extends keyof GeneratedProjectDraft>(key:K,value:GeneratedProjectDraft[K]){setDraft(current=>({...current,[key]:value}));setValidation('');}
 function changeUnit(key:string,patch:Partial<GeneratedUnitDraft>){setDraft(current=>({...current,units:current.units.map(unit=>unit.key===key?{...unit,...patch}:unit)}));setValidation('');}
 function back(){if(locked)return;setValidation('');setReviewed(null);setStep(current=>Math.max(0,current-1));}
 function edit(target:number){if(locked)return;setValidation('');setReviewed(null);setStep(target);}
 async function openCreated(project:StudioGeneratedProject){
  if(openPending.current)return;openPending.current=true;setOpening(true);setOpenError('');
  try{await onSaved(project);}catch(error){setOpenError(error instanceof Error?error.message:'Your project was created. Try opening it again.');}
  finally{openPending.current=false;setOpening(false);}
 }
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;setValidation('');
  if(createdProject){await openCreated(createdProject);return;}
  if(step<3){
   if(step===1&&draft.kind!=='audio'&&!draft.colorMode){setValidation('Choose how color metadata will be checked before continuing.');return;}
   const parsed=parseGeneratedProjectDraft(draft,validationId);
   if(!parsed.success){
    const relevant=parsed.error.issues.filter(issue=>step===0?!['spec','shots'].includes(String(issue.path[0])):step===1?issue.path[0]==='spec':true);
    if(relevant.length){setValidation(relevant.slice(0,3).map(issue=>`${issueLabel(issue.path)}: ${issue.message}`).join(' '));return;}
   }
   if(step===2){if(!parsed.success)return;setReviewed(parsed.data);}
   setStep(current=>current+1);return;
  }
  if(!reviewed){setValidation('Review your delivery requirements before creating this project.');return;}
  const {clientId:validationOnly,...body}=reviewed;void validationOnly;
  // The hook binds one retry ID to this exact reviewed body. Remember a known
  // successful creation before opening it so an opening error cannot re-POST.
  await mutation.mutate<{project:StudioGeneratedProject}>(`/api/companies/${p.company.id}/studio/projects`,body,async result=>{
   setCreatedProject(result.project);await openCreated(result.project);
  });
 }
 const sampleFields=<div className={s.grid}><Field label="Sample rate (Hz)"><input required type="number" min={1} max={384000} step={1} value={draft.sampleRate} onChange={event=>change('sampleRate',event.target.value)}/></Field><Field label="Audio channels" hint="1 = mono · 2 = stereo · up to 8 channels"><input required type="number" min={1} max={8} step={1} value={draft.channels} onChange={event=>change('channels',event.target.value)}/></Field></div>;
 return <Modal title="Create a generated-media project" description={`${p.company.name} · Higgsfield production`} wide onClose={()=>{if(!busy)onClose();}}>
  <form className={s.wizard} onSubmit={submit} aria-busy={busy}>
   <ol className={s.steps} aria-label="Project setup progress">{steps.map((label,index)=><li key={label} aria-current={step===index?'step':undefined} className={index<step?s.complete:step===index?s.current:''}><span aria-hidden="true">{index<step?<Check size={13}/>:index+1}</span><b>{label}</b></li>)}</ol>
   <fieldset disabled={locked} className={s.body}>
    {step===0&&<>
     <div className={s.intro}><span className={s.eyebrow}>01 / THE CREATIVE START</span><h3 ref={heading} tabIndex={-1}>What are we making?</h3><p>Give the team a clear brief, then define exactly what a finished deliverable should be.</p></div>
     <fieldset className={s.mediaGroup}><legend>Output type</legend><div className={s.mediaChoices}>{mediaChoices.map(({kind,title,description,Icon})=><label key={kind} className={`${s.mediaChoice} ${draft.kind===kind?s.selected:''}`}><input type="radio" name="generated-media-kind" value={kind} checked={draft.kind===kind} onChange={()=>{setDraft(current=>changeGeneratedKind(current,kind));setValidation('');}}/><Icon size={23} aria-hidden="true"/><strong>{title}</strong><small>{description}</small></label>)}</div><p className={s.hint}>One output type per project. Add as many as 100 deliverables in the next steps.</p></fieldset>
     <div className={s.grid}><Field label="Project name"><input required maxLength={160} autoComplete="off" placeholder="Summer campaign · first light" value={draft.name} onChange={event=>change('name',event.target.value)}/></Field><Field label="Client / brand"><input required maxLength={160} autoComplete="organization" placeholder="Who is this production for?" value={draft.clientName} onChange={event=>change('clientName',event.target.value)}/></Field></div>
     <Field label="Creative brief" hint="Include the intended audience, creative direction, references, approved sources, and what the client will consider ready."><textarea required maxLength={12000} rows={5} placeholder="Describe the outcome, not just the prompt…" value={draft.brief} onChange={event=>change('brief',event.target.value)}/></Field>
     <div className={s.grid}><Field label="Target delivery date" hint="Optional. You can plan a project before setting a deadline."><input type="date" value={draft.dueDate} onChange={event=>change('dueDate',event.target.value)}/></Field><Field label="Client AI-use policy"><select value={draft.aiPolicy} onChange={event=>change('aiPolicy',event.target.value as GeneratedProjectDraft['aiPolicy'])}>{Object.entries(policyNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field></div>
    </>}
    {step===1&&<>
     <div className={s.intro}><span className={s.eyebrow}>02 / A CLEAR DELIVERY TARGET</span><h3 ref={heading} tabIndex={-1}>Set the acceptance requirements.</h3><p>These requirements apply to every {draft.kind} in this project and will be checked against the actual output. Available generation models may support only a subset.</p></div>
     <section className={s.section}><h4>File &amp; {draft.kind==='audio'?'sound':'picture'}</h4>
      {draft.kind==='image'&&<Field label="Image format"><select value={draft.imageFormat} onChange={event=>change('imageFormat',event.target.value as GeneratedProjectDraft['imageFormat'])}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></Field>}
      {draft.kind==='video'&&<div className={s.grid}><Field label="Video container"><select value={draft.videoFormat} onChange={event=>setDraft(current=>changeGeneratedVideoFormat(current,event.target.value as 'mp4'|'mov'))}><option value="mp4">MP4</option><option value="mov">QuickTime / MOV</option></select></Field><Field label="Video codec"><select value={draft.videoCodec} onChange={event=>change('videoCodec',event.target.value)}>{GENERATED_VIDEO_CODECS[draft.videoFormat].map(codec=><option key={codec} value={codec}>{codecNames[codec]}</option>)}</select></Field></div>}
      {draft.kind==='audio'&&<><div className={s.grid}><Field label="Audio container"><select value={draft.audioFormat} onChange={event=>setDraft(current=>changeGeneratedAudioFormat(current,event.target.value as 'wav'|'mp3'))}><option value="wav">WAV</option><option value="mp3">MP3</option></select></Field><Field label="Audio codec"><select value={draft.audioCodec} onChange={event=>change('audioCodec',event.target.value)}>{(draft.audioFormat==='wav'?GENERATED_PCM_CODECS:['mp3']).map(codec=><option key={codec} value={codec}>{codecNames[codec]}</option>)}</select></Field></div>{sampleFields}</>}
      {draft.kind!=='audio'&&<div className={s.grid}><Field label="Width (pixels)"><input required type="number" min={1} max={16384} step={1} value={draft.width} onChange={event=>change('width',event.target.value)}/></Field><Field label="Height (pixels)"><input required type="number" min={1} max={16384} step={1} value={draft.height} onChange={event=>change('height',event.target.value)}/></Field></div>}
     </section>
     {draft.kind==='video'&&<section className={s.section}><h4>Timing &amp; embedded audio</h4><Field label="Frame-rate preset" hint="Constant frame rate. Use the exact fraction below for custom rates."><select value={['24/1','25/1','30/1','24000/1001','30000/1001','60/1'].includes(`${draft.fpsNumerator}/${draft.fpsDenominator}`)?`${draft.fpsNumerator}/${draft.fpsDenominator}`:'custom'} onChange={event=>{if(event.target.value==='custom')return;const [fpsNumerator,fpsDenominator]=event.target.value.split('/');setDraft(current=>({...current,fpsNumerator,fpsDenominator}));}}><option value="24/1">24 fps</option><option value="25/1">25 fps</option><option value="30/1">30 fps</option><option value="24000/1001">23.976 fps · 24000/1001</option><option value="30000/1001">29.970 fps · 30000/1001</option><option value="60/1">60 fps</option><option value="custom">Custom fraction below</option></select></Field><div className={s.grid}><Field label="Frame-rate numerator"><input required type="number" min={1} max={1000000000} step={1} value={draft.fpsNumerator} onChange={event=>change('fpsNumerator',event.target.value)}/></Field><Field label="Frame-rate denominator"><input required type="number" min={1} max={1000000000} step={1} value={draft.fpsDenominator} onChange={event=>change('fpsDenominator',event.target.value)}/></Field></div><Field label="Embedded audio policy"><select value={draft.videoAudio} onChange={event=>change('videoAudio',event.target.value as 'none'|'required')}><option value="none">Silent video · no audio track</option><option value="required">Audio track required</option></select></Field>{draft.videoAudio==='required'&&<><Field label="Embedded audio codec"><select value={draft.embeddedCodec} onChange={event=>change('embeddedCodec',event.target.value)}>{GENERATED_EMBEDDED_CODECS[draft.videoFormat].map(codec=><option key={codec} value={codec}>{codecNames[codec]}</option>)}</select></Field>{sampleFields}<p className={s.hint}>Technical checks verify the audio format. Listening and audio-to-picture sync still need review.</p></>}</section>}
     {draft.kind!=='audio'&&<section className={s.section}><h4>Color requirements</h4><Field label="Color metadata policy" hint="Choose this deliberately. Missing metadata will never be assumed to mean sRGB or Rec.709."><select required value={draft.colorMode} onChange={event=>change('colorMode',event.target.value as GeneratedProjectDraft['colorMode'])}><option value="" disabled>Choose how color will be checked…</option><option value="exact">Match exact color metadata</option><option value="not_required">Do not require color metadata matching</option></select></Field>{draft.colorMode==='not_required'&&<p className={s.notice}>Color tags will not be checked automatically. Independent visual review still applies.</p>}{draft.colorMode==='exact'&&<div className={s.grid}><Field label="Color space"><select value={draft.colorSpace} onChange={event=>change('colorSpace',event.target.value)}><option value="gbr">RGB / GBR</option><option value="bt709">BT.709</option><option value="bt2020nc">BT.2020 · non-constant luminance</option><option value="bt2020c">BT.2020 · constant luminance</option><option value="smpte170m">SMPTE 170M</option></select></Field><Field label="Color primaries"><select value={draft.colorPrimaries} onChange={event=>change('colorPrimaries',event.target.value)}><option value="bt709">BT.709</option><option value="bt2020">BT.2020</option><option value="smpte170m">SMPTE 170M</option><option value="smpte432">SMPTE 432 / Display P3</option></select></Field><Field label="Transfer function"><select value={draft.colorTransfer} onChange={event=>change('colorTransfer',event.target.value)}><option value="bt709">BT.709</option><option value="iec61966-2-1">sRGB · IEC 61966-2-1</option><option value="linear">Linear</option><option value="smpte2084">PQ · SMPTE 2084</option><option value="arib-std-b67">HLG · ARIB STD-B67</option><option value="smpte170m">SMPTE 170M</option></select></Field><Field label="Color range"><select value={draft.colorRange} onChange={event=>change('colorRange',event.target.value)}><option value="pc">Full / PC</option><option value="tv">Limited / TV</option></select></Field></div>}</section>}
    </>}
    {step===2&&<>
     <div className={s.intro}><span className={s.eyebrow}>03 / MAKE THE WORK ACTIONABLE</span><h3 ref={heading} tabIndex={-1}>Define your deliverables.</h3><p>Each deliverable gets its own reference, generation, and independent quality-review tasks.</p></div>
     {draft.kind!=='image'&&<p className={s.notice}>Enter an inclusive duration interval in whole milliseconds. For a 5-second target, 4,999–5,001 ms leaves room for measurement precision. {draft.kind==='video'?'Video checks also require a proven constant frame rate.':'Audio duration is checked against decoded samples.'}</p>}
     <div className={s.units}>{draft.units.map((unit,index)=><section className={s.unit} key={unit.key} aria-label={`Deliverable ${index+1}`}><div className={s.unitTop}><span>DELIVERABLE {String(index+1).padStart(2,'0')}</span><button type="button" className="icon-button" disabled={draft.units.length===1} aria-label={`Remove deliverable ${index+1}`} onClick={()=>{setDraft(current=>({...current,units:current.units.filter(item=>item.key!==unit.key)}));setValidation('');}}><Trash2 size={16}/></button></div><div className={s.unitFields}><Field label={`Deliverable ${index+1} code`} hint="Unique code · letters, numbers, hyphens, underscores"><input required maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,39}" autoComplete="off" value={unit.code} onChange={event=>changeUnit(unit.key,{code:event.target.value})}/></Field><Field label={`Deliverable ${index+1} description`}><textarea required maxLength={2000} rows={2} placeholder={draft.kind==='image'?'Hero image · sunlit product with room for campaign copy':draft.kind==='video'?'Opening clip · slow camera move into the scene':'Opening sound · warm, spacious, with a clean ending'} value={unit.description} onChange={event=>changeUnit(unit.key,{description:event.target.value})}/></Field></div>{draft.kind!=='image'&&<div className={s.grid}><Field label={`Deliverable ${index+1} minimum duration (ms)`}><input required type="number" min={1} max={3600000} step={1} value={unit.durationMin} onChange={event=>changeUnit(unit.key,{durationMin:event.target.value})}/></Field><Field label={`Deliverable ${index+1} maximum duration (ms)`}><input required type="number" min={1} max={3600000} step={1} value={unit.durationMax} onChange={event=>changeUnit(unit.key,{durationMax:event.target.value})}/></Field></div>}</section>)}</div>
     <div className={s.addRow}><button type="button" className="button secondary" disabled={draft.units.length>=100} onClick={()=>setDraft(current=>({...current,units:[...current.units,{key:crypto.randomUUID(),code:nextGeneratedUnitCode(current.units),description:'',durationMin:'4999',durationMax:'5001'}]}))}><Plus size={16}/> Add deliverable</button><span>{draft.units.length} / 100</span></div>
    </>}
    {step===3&&reviewed&&<>
     <div className={s.intro}><span className={s.eyebrow}>04 / READY FOR THE TEAM</span><h3 ref={heading} tabIndex={-1}>{createdProject?'Your project is created.':'Review the production plan.'}</h3><p>{createdProject?'The project is safely saved. Open it to continue.':'Check the brief and exact requirements before preparing the work.'}</p></div>
     <div className={s.reviewHero}><ClipboardCheck size={26} aria-hidden="true"/><div><span>{reviewed.spec.kind.toUpperCase()} PRODUCTION</span><h4>{reviewed.name}</h4><p>{reviewed.clientName} · {reviewed.shots.length} {reviewed.shots.length===1?'deliverable':'deliverables'}</p></div></div>
     <section className={s.section}><div className={s.sectionTop}><h4>Brief &amp; planning</h4><button type="button" className={s.edit} onClick={()=>edit(0)}>Edit brief</button></div><p className={s.brief}>{reviewed.brief}</p><dl className={s.facts}><div><dt>Delivery date</dt><dd>{reviewed.dueDate||'Not set'}</dd></div><div><dt>AI-use policy</dt><dd>{policyNames[reviewed.aiPolicy]}</dd></div></dl></section>
     <section className={s.section}><div className={s.sectionTop}><h4>Delivery requirements</h4><button type="button" className={s.edit} onClick={()=>edit(1)}>Edit requirements</button></div><SpecReview spec={reviewed.spec}/></section>
     <section className={s.section}><div className={s.sectionTop}><h4>{reviewed.shots.length} deliverables</h4><button type="button" className={s.edit} onClick={()=>edit(2)}>Edit deliverables</button></div><ol className={s.reviewUnits}>{reviewed.shots.map(unit=><li key={unit.code}><div><strong>{unit.code}</strong>{unit.kind!=='image'&&<span>{unit.durationMs.min.toLocaleString()}–{unit.durationMs.max.toLocaleString()} ms · inclusive</span>}</div><p>{unit.description}</p></li>)}</ol></section>
     <p className={s.notice}>Creating the project prepares intake and dependent tasks. Generation requests, spending, and approval are handled separately in the project.</p>
    </>}
   </fieldset>
   {error&&<p className="error-message" ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
   <footer className={s.footer}><button type="button" className="button secondary" disabled={busy} onClick={()=>step===0||createdProject?onClose():back()}>{step>0&&!createdProject&&<ArrowLeft size={15}/>} {step===0||createdProject?'Close':'Back'}</button><button className="button primary" type="submit" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:step===3?<Check size={16}/>:<ArrowRight size={16}/>} {busy?(createdProject?'Opening…':'Creating…'):createdProject?'Open project':step===3?'Create project':step===2?'Review project':'Continue'}</button></footer>
  </form>
 </Modal>;
}

function SpecReview({spec}:{spec:GeneratedProjectInput['spec']}){
 return <dl className={s.facts}>
  <div><dt>File</dt><dd>{spec.format.toUpperCase()}{spec.kind!=='image'?` · ${codecNames[spec.codec]}`:''}</dd></div>
  {spec.kind!=='audio'&&<><div><dt>Dimensions</dt><dd>{spec.width.toLocaleString()} × {spec.height.toLocaleString()} px</dd></div><div><dt>Color metadata</dt><dd>{spec.color.mode==='not_required'?'Matching explicitly not required':`Exact · ${spec.color.space} · ${spec.color.primaries} · ${spec.color.transfer} · ${spec.color.range==='pc'?'full':'limited'} range`}</dd></div></>}
  {spec.kind==='video'&&<><div><dt>Frame rate</dt><dd>{spec.frameRate.numerator}/{spec.frameRate.denominator} fps · constant</dd></div><div><dt>Embedded audio</dt><dd>{spec.audio.mode==='none'?'No audio track':`Required · ${codecNames[spec.audio.codec]} · ${spec.audio.sampleRateHz.toLocaleString()} Hz · ${spec.audio.channels} channels`}</dd></div></>}
  {spec.kind==='audio'&&<><div><dt>Sample rate</dt><dd>{spec.sampleRateHz.toLocaleString()} Hz</dd></div><div><dt>Channels</dt><dd>{spec.channels}{spec.channels===1?' · mono':spec.channels===2?' · stereo':''}</dd></div></>}
 </dl>;
}
