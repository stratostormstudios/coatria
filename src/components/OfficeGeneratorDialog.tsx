'use client';
import {useMemo,useState} from 'react';
import {ArrowUpRight,Check,Flower2,Grid2X2,LayoutTemplate,Shuffle,Sparkles} from 'lucide-react';
import {OFFICE_50_PRESET,type OfficePreset} from '@/lib/office-presets';
import {generateOffice,OFFICE_GENERATOR_PRESETS,type OfficeGeneratorOptions,type GeneratedOffice} from '@/lib/office-generator';
import OfficePresetPreview from './OfficePresetPreview';
import {Badge,Field,Modal} from './ui';
import s from './OfficeGeneratorDialog.module.css';

const area=(value:number)=>value.toLocaleString(undefined,{maximumFractionDigits:1});
const defaults:OfficeGeneratorOptions={deskCount:24,roomCount:3,style:'courtyard',spaciousness:'airy',seed:'Coatria'};
const styles=[{id:'courtyard',name:'Courtyard',description:'A shared heart, with work arranged around it.',icon:Flower2},{id:'neighborhoods',name:'Neighborhoods',description:'Smaller team bays connected by generous aisles.',icon:Grid2X2},{id:'gallery',name:'Gallery',description:'A long social spine with distinct spaces along it.',icon:LayoutTemplate}] as const;

export default function OfficeGeneratorDialog({onClose,onApply}:{onClose:()=>void;onApply:(preset:OfficePreset)=>void}){
 const [tab,setTab]=useState<'presets'|'generate'>('presets'),[selected,setSelected]=useState(OFFICE_50_PRESET.id);
 const [desks,setDesks]=useState('24'),[rooms,setRooms]=useState('3'),[style,setStyle]=useState<OfficeGeneratorOptions['style']>('courtyard'),[space,setSpace]=useState<OfficeGeneratorOptions['spaciousness']>('airy'),[seed,setSeed]=useState('Coatria');
 const [generated,setGenerated]=useState<GeneratedOffice|null>(()=>{try{return generateOffice(defaults);}catch{return null;}}),[error,setError]=useState('');
 const presets=useMemo(()=>[OFFICE_50_PRESET,...OFFICE_GENERATOR_PRESETS.flatMap(entry=>{try{return[{...generateOffice(entry.options),id:entry.id,name:entry.name,description:entry.description}];}catch{return[];}})],[]);
 const chosen=tab==='presets'?presets.find(p=>p.id===selected)||OFFICE_50_PRESET:generated;
 const stale=tab==='generate'&&generated&&(!desks.trim()||!rooms.trim()||Number(desks)!==generated.options.deskCount||Number(rooms)!==generated.options.roomCount||style!==generated.options.style||space!==generated.options.spaciousness||String(seed)!==String(generated.options.seed));
 function create(variation=false){
  const nextSeed=variation?crypto.randomUUID().slice(0,8):seed.trim();
  setError('');
  if(!desks.trim()||!rooms.trim()||!Number.isInteger(Number(desks))||Number(desks)<1||Number(desks)>60||!Number.isInteger(Number(rooms))||Number(rooms)<0||Number(rooms)>8){setError('Choose 1–60 workstations and 0–8 rooms.');return;}
  if(!nextSeed){setError('Enter a layout seed, or choose New variation.');return;}
  try{const next=generateOffice({deskCount:Number(desks),roomCount:Number(rooms),style,spaciousness:space,seed:nextSeed});setGenerated(next);setSeed(String(next.options.seed));}catch(e){setError(e instanceof Error?e.message:'This combination needs more space. Try fewer desks or rooms.');}
 }
 const summary=chosen&&'summary' in chosen?(chosen as GeneratedOffice).summary:null;
 const roomCount=summary?.roomCount??chosen?.zones.filter(z=>z.kind==='meeting').length??0;
 return <Modal wide title="Office templates" description="Start with a studio you like, or generate a place around your team. Every piece stays editable." onClose={onClose}>
  <div className={s.studio}>
   <div className={s.tabs} role="tablist" aria-label="Choose how to design your office">{(['presets','generate'] as const).map((id,index)=><button type="button" key={id} id={'studio-tab-'+id} role="tab" aria-selected={tab===id} aria-controls={'studio-panel-'+id} tabIndex={tab===id?0:-1} onClick={()=>setTab(id)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'presets':event.key==='End'?'generate':index===0?'generate':'presets';setTab(next);document.getElementById('studio-tab-'+next)?.focus();}}}>{id==='presets'?<LayoutTemplate size={16}/>:<Sparkles size={16}/>} {id==='presets'?'Studio presets':'Generate a studio'}</button>)}</div>
   <section role="tabpanel" id={'studio-panel-'+tab} aria-labelledby={'studio-tab-'+tab}>
    {tab==='presets'?<div className={s.presets}>{presets.map(preset=><button type="button" key={preset.id} aria-pressed={selected===preset.id} className={s.preset} onClick={()=>setSelected(preset.id)}><span className={s.thumbnail}><OfficePresetPreview preset={preset} compact/>{selected===preset.id&&<span className={s.chosen}><Check size={13}/></span>}</span><strong>{preset.name}</strong><small>{preset.workstations.length} desks · {area(preset.floor.width*preset.floor.depth)} m²</small></button>)}</div>
     :<div className={s.builder}>
      <div className={s.counts}><Field label="Workstations" hint="One desk and chair per person."><input type="number" min={1} max={60} step={1} value={desks} onChange={e=>setDesks(e.target.value)}/></Field><Field label="Meeting rooms" hint="Furnished nooks with an open entrance."><input type="number" min={0} max={8} step={1} value={rooms} onChange={e=>setRooms(e.target.value)}/></Field><Field label="Space to breathe"><select value={space} onChange={e=>setSpace(e.target.value as OfficeGeneratorOptions['spaciousness'])}><option value="airy">Airy · wider aisles</option><option value="balanced">Balanced · efficient footprint</option></select></Field></div>
      <div className={s.styles} role="group" aria-label="Studio style">{styles.map(({id,name,description,icon:Icon})=><button type="button" key={id} aria-pressed={style===id} onClick={()=>setStyle(id)}><Icon size={20}/><strong>{name}</strong><small>{description}</small></button>)}</div>
      <div className={s.generateActions}><button className="button primary" type="button" onClick={()=>create()}><Sparkles size={15}/> Generate preview</button><button className="button secondary" type="button" onClick={()=>create(true)}><Shuffle size={15}/> New variation</button><details><summary>Keep a layout seed</summary><Field label="Layout seed" hint="The same settings and seed recreate this layout."><input value={seed} maxLength={64} onChange={e=>setSeed(e.target.value)}/></Field></details></div>
      {error&&<p className="error-message" role="alert">{error}</p>}
     </div>}
    {chosen&&<div className={s.result}><div className={s.preview}><OfficePresetPreview preset={chosen}/><span className={s.scale}>{chosen.floor.width} × {chosen.floor.depth} m</span></div><div className={s.description}>
     <div className={s.resultHeading}><div><span className="eyebrow">{tab==='presets'?'READY TO MAKE YOURS':'YOUR GENERATED STUDIO'}</span><h3>{chosen.name}</h3></div><Badge>{chosen.workstations.length} workstations · {area(chosen.floor.width*chosen.floor.depth)} m²</Badge></div>
     <p>{chosen.description}</p><div className={s.facts}><span><strong>{roomCount}</strong> meeting {roomCount===1?'area':'areas'}</span><span><strong>{chosen.layout.length}</strong> editable pieces</span>{summary&&<span><strong>{area(summary.areaM2/summary.deskCount)} m²</strong> per workstation</span>}</div>
     {tab==='generate'&&generated?.warnings.map((warning,i)=><p className={s.notice} key={i}>{warning}</p>)}
     {stale&&<p className={s.notice} role="status">Settings changed. Generate a preview to see and apply them.</p>}
     <div className={s.apply}><small>Applying changes your draft. Undo restores the previous plan; Save publishes it. Set up conversations for these spaces in Rooms.</small><button className="button primary" type="button" disabled={Boolean(stale)||Boolean(error)&&tab==='generate'} onClick={()=>onApply(chosen)}>Use {tab==='presets'?(chosen.id===OFFICE_50_PRESET.id?'50-person studio':chosen.name):'this layout'} <ArrowUpRight size={16}/></button></div>
    </div></div>}
   </section>
  </div>
 </Modal>;
}
