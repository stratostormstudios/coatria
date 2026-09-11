'use client';

import {useEffect,useRef,useState,type CSSProperties,type PointerEvent as ReactPointerEvent} from 'react';
import {flushSync} from 'react-dom';
import {ArrowLeft,ArrowUpRight,Check,Copy,Grip,Hand,Maximize,Minus,MousePointer2,Plus,Redo2,RotateCw,Save,Scan,Trash2,Undo2,AlertCircle,Search,Package,LockKeyhole} from 'lucide-react';
import type {WorkspaceProps} from '@/app/page';
import {api,type Workspace,type LayoutItem,type FloorSize} from '@/lib/client';
import {MAX_LAYOUT_ITEMS} from '@/lib/floor-plan';
import {clamp,editorPlan,floorMaximum,floorMinimum,furniture,metres,moveItem,newItem,place,resizeFloor,resizeItem,rotateItem,round,signature,snap,setItemDimension,type EditorPlan,type Edge,type Rect} from '@/lib/floor-editor';
import {OFFICE_CATALOG,OFFICE_CATEGORIES,getOfficeAsset} from '@/lib/office-catalog';
import {useOfficePreviews} from './useOfficePreviews';
import {Badge,Field,PageHead,Modal} from './ui';
import OfficeGeneratorDialog from './OfficeGeneratorDialog';
import s from './FloorPlanEditor.module.css';

const edges:{edge:Edge;name:string}[]=[{edge:'nw',name:'Northwest'},{edge:'n',name:'North'},{edge:'ne',name:'Northeast'},{edge:'e',name:'East'},{edge:'se',name:'Southeast'},{edge:'s',name:'South'},{edge:'sw',name:'Southwest'},{edge:'w',name:'West'}];
type Gesture={kind:'move'|'resize'|'floor'|'palette'|'pan';pointerId:number;startX:number;startY:number;before:EditorPlan;scale:number;id?:string;edge?:Edge;type?:LayoutItem['type'];assetId?:string;moved:boolean;scrollLeft:number;scrollTop:number;capture:HTMLElement};
const editable=(target:EventTarget|null)=>target instanceof HTMLElement&&Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));

function NumberField({label,value,onValue,min=0,max=40}:{label:string;value:number;onValue:(value:number)=>void;min?:number;max?:number}) {
  const [text,setText]=useState(String(round(value,2))),focused=useRef(false),cancelled=useRef(false),touched=useRef(false);
  useEffect(()=>{if(!focused.current||!touched.current)setText(String(round(value,2)));},[value]);
  return <Field label={label}><input aria-label={label} type="number" min={min} max={max} step="0.1" value={text}
    onFocus={()=>{focused.current=true;cancelled.current=false;touched.current=false;}}
    onChange={event=>{touched.current=true;setText(event.target.value);}}
    onBlur={()=>{focused.current=false;const number=Number(text),valid=touched.current&&!cancelled.current&&text.trim()&&Number.isFinite(number),next=valid?clamp(number,min,max):value;if(valid)onValue(next);setText(String(round(next,2)));cancelled.current=false;touched.current=false;}}
    onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}if(event.key==='Escape'){cancelled.current=true;setText(String(round(value,2)));event.currentTarget.blur();event.stopPropagation();}}}/></Field>;
}

function FurnitureGlyph({type,rotation=0}:{type:LayoutItem['type'];rotation?:number}) {
  return <svg className={s.glyph} viewBox="0 0 100 100" aria-hidden="true" style={{transform:`rotate(${rotation}deg)`}}>
    {type==='desk'?<><rect x="9" y="12" width="82" height="51" rx="5" className={s.wood}/><rect x="29" y="17" width="42" height="8" rx="2" className={s.dark}/><rect x="34" y="35" width="30" height="10" rx="2" className={s.light}/><path d="M37 65h26v18H37z" className={s.chair}/><rect x="31" y="79" width="38" height="10" rx="5" className={s.chair}/></>
    :type==='plant'?<><circle cx="50" cy="52" r="24" className={s.wood}/><path d="M50 64C12 63 17 24 40 35C31 9 73 11 66 35C97 22 91 64 65 60C68 83 40 91 50 64Z" className={s.leaf}/><path d="M50 67V38M50 52l16-12M50 57L35 44" fill="none" stroke="#476744" strokeWidth="3"/></>
    :type==='lounge'?<><rect x="12" y="15" width="76" height="28" rx="7" className={s.chair}/><rect x="12" y="15" width="76" height="9" rx="4" className={s.dark}/><path d="M36 26v15M64 26v15" stroke="#526b58"/><rect x="28" y="57" width="44" height="22" rx="9" className={s.wood}/><circle cx="85" cy="80" r="8" className={s.leaf}/></>
    :type==='focus'?<><path d="M9 91V9h82" fill="none" stroke="#78928a" strokeWidth="5"/><rect x="20" y="23" width="61" height="36" rx="4" className={s.wood}/><rect x="34" y="27" width="31" height="6" className={s.dark}/><rect x="38" y="63" width="25" height="18" rx="6" className={s.chair}/></>
    :<><path d="M7 93V7h86" fill="none" stroke="#78928a" strokeWidth="5"/>{[24,50,76].map(x=><g key={x}><rect x={x-7} y="17" width="14" height="15" rx="4" className={s.chair}/><rect x={x-7} y="70" width="14" height="15" rx="4" className={s.chair}/></g>)}<rect x="14" y="33" width="73" height="35" rx="11" className={s.wood}/><rect x="45" y="45" width="12" height="9" rx="2" className={s.light}/></>}
  </svg>;
}

export default function FloorPlanEditor(p:WorkspaceProps&{onDone:()=>void}) {
  const [templates,setTemplates]=useState(false);
  const [plan,setPlan]=useState(()=>editorPlan(p.workspace.layout,p.workspace.floor));
  const [baseline,setBaseline]=useState(()=>({plan:editorPlan(p.workspace.layout,p.workspace.floor),revision:p.workspace.layoutRevision||0}));
  const [selected,setSelected]=useState<string|null>(null),[saving,setSaving]=useState(false),[conflict,setConflict]=useState(false),[resolving,setResolving]=useState(false);
  const [error,setError]=useState(''),[announcement,setAnnouncement]=useState(''),[snapping,setSnapping]=useState(true),[zoom,setZoom]=useState(1),[panMode,setPanMode]=useState(false);
  const [search,setSearch]=useState(''),[category,setCategory]=useState('all'),[visibleCount,setVisibleCount]=useState(12);
  const [viewportSize,setViewportSize]=useState({width:650,height:560}),[lockedScale,setLockedScale]=useState<number|null>(null),[lockedOrigin,setLockedOrigin]=useState<{left:number;top:number}|null>(null),[gestureKind,setGestureKind]=useState<Gesture['kind']|null>(null),[ghost,setGhost]=useState<LayoutItem|null>(null);
  const [,setHistoryVersion]=useState(0);
  const viewport=useRef<HTMLDivElement>(null),board=useRef<HTMLDivElement>(null),root=useRef<HTMLDivElement>(null),current=useRef(plan),baselineRef=useRef(baseline),savingRef=useRef(false),mounted=useRef(true);
  const history=useRef<{past:EditorPlan[];future:EditorPlan[]}>({past:[],future:[]}),gesture=useRef<Gesture|null>(null),labelStart=useRef<EditorPlan|null>(null),spaceHeld=useRef(false),ghostRef=useRef<LayoutItem|null>(null);
  const active=plan.layout.find(item=>item.id===selected),activeRect=active?metres(active,plan.floor):null;
  const activeAsset=active?.assetId?getOfficeAsset(active.assetId):undefined;
  const linked=activeAsset?.resize==='uniform'&&activeRect;
  const sizeLimits=activeRect?{minW:activeAsset?Math.max(.04,linked?.04*activeRect.w/activeRect.h:0):.5,minH:activeAsset?Math.max(.04,linked?.04*activeRect.h/activeRect.w:0):.5,maxW:Math.min(plan.floor.width-activeRect.x,linked?(plan.floor.depth-activeRect.y)*activeRect.w/activeRect.h:Infinity),maxH:Math.min(plan.floor.depth-activeRect.y,linked?(plan.floor.width-activeRect.x)*activeRect.h/activeRect.w:Infinity)}:null;
  const matching=OFFICE_CATALOG.filter(asset=>(category==='all'||asset.category===category)&&`${asset.name} ${asset.category}`.toLowerCase().includes(search.trim().toLowerCase())),visibleAssets=matching.slice(0,visibleCount);
  const previews=useOfficePreviews(p.user.id,[...visibleAssets.map(asset=>asset.id),...(activeAsset?[activeAsset.id]:[])]);
  const planPreviews=useOfficePreviews(p.user.id,[...plan.layout.flatMap(item=>item.assetId?[item.assetId]:[]),...(ghost?.assetId?[ghost.assetId]:[])],'plan');
  function assetImage(id:string,rotation=0,fallback=false,top=false,footprintRatio?:number){const preview=(top?planPreviews:previews).images[id],swapped=top&&rotation%180!==0,asset=getOfficeAsset(id);const stretch=swapped?(footprintRatio??(asset?asset.width/asset.depth:1)):1;return preview?.url?<img className={s.assetPreview+(top?' '+s.planPreview:'')} src={preview.url} alt="" draggable={false} style={{transform:`rotate(${rotation}deg)${swapped?` scale(${stretch},${1/stretch})`:''}`}}/>:<span className={s.previewPlaceholder}><Package size={22}/>{fallback&&<small>{preview?.error?'Preview unavailable':'Loading preview…'}</small>}</span>;}
  const dirty=signature(plan)!==signature(baseline.plan),remoteSignature=signature(editorPlan(p.workspace.layout,p.workspace.floor)),remoteRevision=p.workspace.layoutRevision||0;
  const fitScale=Math.max(2,Math.min((viewportSize.width-100)/plan.floor.width,(viewportSize.height-100)/plan.floor.depth));
  const scale=lockedScale??fitScale*zoom,minFloor=floorMinimum(plan),maxFloor=floorMaximum(plan);
  current.current=plan;baselineRef.current=baseline;
  function draft(next:EditorPlan){current.current=next;setPlan(next);setError('');}
  function remember(before:EditorPlan,after:EditorPlan){if(signature(before)===signature(after))return;history.current.past.push(before);history.current.past=history.current.past.slice(-60);history.current.future=[];setHistoryVersion(v=>v+1);}
  function commit(next:EditorPlan){remember(current.current,next);draft(next);}
  function clearHistory(){history.current={past:[],future:[]};labelStart.current=null;setHistoryVersion(v=>v+1);}
  function replaceItem(item:LayoutItem,source=current.current){return {...source,layout:source.layout.map(existing=>existing.id===item.id?item:existing)};}
  function undo(){const previous=history.current.past.pop();if(!previous)return;history.current.future.push(current.current);draft(previous);setHistoryVersion(v=>v+1);setAnnouncement('Undid the last change.');}
  function redo(){const next=history.current.future.pop();if(!next)return;history.current.past.push(current.current);draft(next);setHistoryVersion(v=>v+1);setAnnouncement('Redid the last change.');}
  function add(type:LayoutItem['type'],point?:{x:number;y:number},assetId?:string){if(current.current.layout.length>=MAX_LAYOUT_ITEMS)return;const item=newItem(type,current.current,crypto.randomUUID(),point,snapping,assetId);commit({...current.current,layout:[...current.current.layout,item]});setSelected(item.id);setAnnouncement(item.label+' added. Drag to move or use the dimension fields.');}
  function remove(){if(!active)return;commit({...current.current,layout:current.current.layout.filter(item=>item.id!==active.id)});setSelected(null);setAnnouncement(active.label+' removed.');}
  function duplicate(){if(!active||current.current.layout.length>=MAX_LAYOUT_ITEMS)return;const r=metres(active,current.current.floor),item=place({...active,id:crypto.randomUUID(),label:(active.label+' copy').slice(0,80)},{...r,x:r.x+.5,y:r.y+.5},current.current.floor);commit({...current.current,layout:[...current.current.layout,item]});setSelected(item.id);setAnnouncement('Object duplicated.');}
  function rotate(){if(!active)return;const rotated=rotateItem(active,current.current.floor);if(rotated===active){setError('This object cannot rotate within the current floor. Enlarge the floor or resize the object first.');return;}commit(replaceItem(rotated));setAnnouncement('Object rotated 90 degrees.');}
  function updateRect(key:keyof Rect,value:number){if(!active||!activeRect)return;const item=key==='w'||key==='h'?setItemDimension(active,current.current.floor,key,value):place(active,{...metres(active,current.current.floor),[key]:value},current.current.floor);commit(replaceItem(item));}
  function updateFloor(key:keyof FloorSize,value:number){const next=resizeFloor(current.current,{...current.current.floor,[key]:value});commit(next);if(Math.abs(next.floor[key]-value)>.001)setAnnouncement(value>next.floor[key]?'A small existing object limits floor expansion. Enlarge that object first.':'Floor size limited to fit all furniture. Move objects inward to make it smaller.');}
  function fit(){setZoom(1);viewport.current?.scrollTo({left:0,top:0});setAnnouncement('Floor fitted to the canvas.');}
  function finish(cancel=false){const g=gesture.current;if(!g)return;gesture.current=null;
    if(cancel&&g.kind!=='palette'&&g.kind!=='pan')draft(g.before);
    else if(!cancel&&g.kind==='palette'){if(g.moved&&ghostRef.current&&current.current.layout.length<MAX_LAYOUT_ITEMS){const item={...ghostRef.current,id:crypto.randomUUID()};commit({...current.current,layout:[...current.current.layout,item]});setSelected(item.id);setAnnouncement(item.label+' placed.');}else if(!g.moved&&g.type)add(g.type,undefined,g.assetId);}
    else if(!cancel&&g.kind!=='pan')remember(g.before,current.current);
    if(g.capture.hasPointerCapture(g.pointerId))g.capture.releasePointerCapture(g.pointerId);
    setLockedScale(null);setLockedOrigin(null);setGestureKind(null);setGhost(null);ghostRef.current=null;
    if(cancel)setAnnouncement('Drag cancelled.');
  }
  function start(event:ReactPointerEvent<HTMLElement>,kind:Gesture['kind'],extra:Partial<Gesture>={}){
    if(gesture.current||(!event.isPrimary&&event.pointerType!=='mouse')||![0,1].includes(event.button))return;
    if(kind!=='palette'&&(panMode||spaceHeld.current||event.button===1))kind='pan';
    event.preventDefault();event.stopPropagation();
    // Commit a pending inspector field before a gesture records its undo snapshot.
    const focused=document.activeElement;
    if(focused instanceof HTMLElement&&root.current?.contains(focused)&&editable(focused))flushSync(()=>focused.blur());
    const gestureScale=Number.parseFloat(board.current?.style.width||'0')/current.current.floor.width||scale;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current={kind,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,before:current.current,scale:gestureScale,id:extra.id,edge:extra.edge,type:extra.type,assetId:extra.assetId,moved:false,scrollLeft:viewport.current?.scrollLeft||0,scrollTop:viewport.current?.scrollTop||0,capture:event.currentTarget};
    setLockedScale(gestureScale);setLockedOrigin({left:board.current?.offsetLeft||50,top:board.current?.offsetTop||50});setGestureKind(kind);if(extra.id)setSelected(extra.id);
    board.current?.focus({preventScroll:true});
  }
  const handlers=useRef({move:(_event:PointerEvent)=>{},finish,undo,redo,remove,duplicate,rotate});
  handlers.current={finish,undo,redo,remove,duplicate,rotate,move(event){const g=gesture.current;if(!g||event.pointerId!==g.pointerId)return;const dx=(event.clientX-g.startX)/g.scale,dy=(event.clientY-g.startY)/g.scale;if(Math.hypot(event.clientX-g.startX,event.clientY-g.startY)>3)g.moved=true;if(!g.moved)return;
    const grid=snapping&&!event.altKey;
    if(g.kind==='pan'){viewport.current?.scrollTo({left:g.scrollLeft-(event.clientX-g.startX),top:g.scrollTop-(event.clientY-g.startY)});return;}
    if(g.kind==='palette'){const bounds=board.current?.getBoundingClientRect(),inside=bounds&&event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom;const item=inside&&g.type?newItem(g.type,g.before,'drag-preview',{x:(event.clientX-bounds.left)/g.scale,y:(event.clientY-bounds.top)/g.scale},grid,g.assetId):null;if(item)item.id='new-'+g.pointerId;ghostRef.current=item;setGhost(item);return;}
    if(g.kind==='floor'){draft(resizeFloor(g.before,{width:g.edge?.includes('e')?snap(g.before.floor.width+dx,grid):g.before.floor.width,depth:g.edge?.includes('s')?snap(g.before.floor.depth+dy,grid):g.before.floor.depth}));return;}
    const item=g.before.layout.find(item=>item.id===g.id);if(!item)return;
    draft(replaceItem(g.kind==='resize'?resizeItem(item,g.before.floor,g.edge!,dx,dy,grid):moveItem(item,g.before.floor,dx,dy,grid),g.before));
  }};
  useEffect(()=>{mounted.current=true;const move=(event:PointerEvent)=>handlers.current.move(event),up=(event:PointerEvent)=>{if(gesture.current?.pointerId===event.pointerId){handlers.current.move(event);handlers.current.finish();}},cancel=(event:PointerEvent)=>{if(gesture.current?.pointerId===event.pointerId)handlers.current.finish(true);},blur=()=>{spaceHeld.current=false;handlers.current.finish(true);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',blur);
    return()=>{mounted.current=false;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',blur);};
  },[]);
  useEffect(()=>{const element=viewport.current;if(!element)return;const observer=new ResizeObserver(()=>setViewportSize({width:element.clientWidth,height:element.clientHeight}));observer.observe(element);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(savingRef.current||remoteRevision<baselineRef.current.revision)return;const remote=editorPlan(p.workspace.layout,p.workspace.floor);if(remoteRevision===baselineRef.current.revision&&signature(remote)===signature(baselineRef.current.plan))return;if(signature(current.current)===signature(baselineRef.current.plan)&&!gesture.current){draft(remote);setBaseline({plan:remote,revision:remoteRevision});setConflict(false);clearHistory();}else setConflict(true);},[remoteSignature,remoteRevision,saving]);
  useEffect(()=>{if(!dirty)return;const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};const leave=(event:Event)=>{if(!window.confirm('Leave without saving your floor plan changes?'))event.preventDefault();};window.addEventListener('beforeunload',unload);document.addEventListener('coatria:before-navigate',leave);return()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('coatria:before-navigate',leave);};},[dirty]);
  function keys(event:React.KeyboardEvent){if(templates){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s')event.preventDefault();return;}if(event.defaultPrevented||editable(event.target))return;if(event.key==='Escape'){event.preventDefault();if(gesture.current)finish(true);else setSelected(null);return;}
    if(event.code==='Space'&&event.target===board.current){event.preventDefault();spaceHeld.current=true;return;}
    if(gesture.current)return;const command=event.ctrlKey||event.metaKey;
    if(command&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
    if(command&&event.key.toLowerCase()==='d'){event.preventDefault();duplicate();return;}
    if(command&&event.key.toLowerCase()==='s'){event.preventDefault();void save();return;}
    if(!active||command||event.altKey)return;
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const step=event.shiftKey?1:.1;commit(replaceItem(moveItem(active,plan.floor,event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0,false)));}
    else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();remove();}else if(event.key.toLowerCase()==='r'){event.preventDefault();rotate();}
  }
  function floorKeys(event:React.KeyboardEvent,edge:Edge){if(!event.key.startsWith('Arrow'))return;event.preventDefault();event.stopPropagation();const step=event.shiftKey?1:.1;commit(resizeFloor(current.current,{width:current.current.floor.width+(edge.includes('e')?(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0):0),depth:current.current.floor.depth+(edge.includes('s')?(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0):0)}));}
  async function resolve(keep:boolean){setResolving(true);setError('');try{const latest=await api<Workspace>('/api/companies/'+p.company.id+'/workspace');if(!mounted.current)return;const next=editorPlan(latest.layout,latest.floor);setBaseline({plan:next,revision:latest.layoutRevision||0});if(!keep){draft(next);setSelected(null);clearHistory();}setConflict(false);setAnnouncement(keep?'Draft kept. Save to replace the reviewed shared version.':'Latest shared floor plan loaded.');await p.refresh();}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current)setResolving(false);}}
  function discard(){const latest=remoteRevision>=baseline.revision?{plan:editorPlan(p.workspace.layout,p.workspace.floor),revision:remoteRevision}:baseline;draft(latest.plan);setBaseline(latest);setConflict(false);setSelected(null);clearHistory();}
  async function save(){if(savingRef.current||gesture.current||resolving||conflict||signature(current.current)===signature(baselineRef.current.plan))return;if(current.current.layout.some(item=>!item.label.trim())){setError('Give each object a name before saving.');return;}
    const saved=current.current,revision=baselineRef.current.revision;savingRef.current=true;setSaving(true);setError('');
    try{const response=await api<{layout:LayoutItem[];floor:FloorSize;layoutRevision:number}>('/api/companies/'+p.company.id+'/layout','PATCH',{layout:saved.layout,floor:saved.floor,revision});if(!mounted.current)return;const accepted=editorPlan(response.layout,response.floor);setBaseline({plan:accepted,revision:response.layoutRevision});baselineRef.current={plan:accepted,revision:response.layoutRevision};if(signature(current.current)===signature(saved))draft(accepted);await p.refresh();if(mounted.current)p.notify('Your shared floor plan is saved.');}
    catch(e){if(mounted.current){setError((e as Error).message);if((e as {code?:string}).code==='LAYOUT_CONFLICT'){setConflict(true);await p.refresh();}}}
    finally{savingRef.current=false;if(mounted.current)setSaving(false);}
  }
  const origin=lockedOrigin||{left:Math.max(50,(viewportSize.width-plan.floor.width*scale)/2),top:Math.max(50,(viewportSize.height-plan.floor.depth*scale)/2)};
  const stageStyle={width:Math.max(viewportSize.width,plan.floor.width*scale+origin.left+50),height:Math.max(viewportSize.height,plan.floor.depth*scale+origin.top+50)};
  const boardStyle={...origin,width:plan.floor.width*scale,height:plan.floor.depth*scale,'--grid':`${scale*.5}px`} as CSSProperties;
  return <div ref={root} className={s.editor} onKeyDown={keys} onKeyUp={event=>{if(event.code==='Space')spaceHeld.current=false;}}>
    <PageHead eyebrow="SPACE DESIGN STUDIO" title="A floor plan that fits your team." description="Arrange by hand, or generate a spacious studio around your team." action={<div className="row"><button className="button secondary" disabled={saving||!!gestureKind} onClick={()=>setTemplates(true)}><Package size={16}/> Office templates</button><button className="button secondary" onClick={p.onDone}><ArrowLeft size={16}/> Back to the office</button></div>}/>
    {templates&&<OfficeGeneratorDialog onClose={()=>setTemplates(false)} onApply={preset=>{commit({floor:{...preset.floor},layout:preset.layout.map(item=>({...item}))});setSelected(null);setZoom(1);setError('');setTemplates(false);setAnnouncement(preset.name+' applied to your draft. Undo restores the previous plan. Save to publish.');}}/>}
    {conflict&&<div className={s.conflict} role="alert"><AlertCircle size={21}/><div><strong>The shared floor plan changed while you were editing.</strong><p>Your draft is safe. Load the latest plan, or keep your draft and review it before replacing the shared version.</p><div className="row"><button className="button secondary small" disabled={resolving} onClick={()=>void resolve(false)}>Reload saved layout</button><button className="button secondary small" disabled={resolving} onClick={()=>void resolve(true)}>Keep my draft</button></div></div></div>}
    <div className={s.studio}>
      <aside className={s.palette} aria-label="Furniture library"><header><span className="eyebrow">FURNITURE COLLECTION</span><h2>Make yourself at work.</h2><p>Real furniture. Your arrangement. Drag or click to add.</p></header>
        <div className={s.catalogFilters}><label className={s.catalogSearch}><Search size={15}/><input aria-label="Search furniture" placeholder="Find furniture…" value={search} onChange={event=>{setSearch(event.target.value);setVisibleCount(12);}}/></label><select aria-label="Furniture category" value={category} onChange={event=>{setCategory(event.target.value);setVisibleCount(12);}}><option value="all">All furniture</option>{OFFICE_CATEGORIES.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
        <div className={s.catalogCount}><span>{matching.length} pieces</span><span>{plan.layout.length} / {MAX_LAYOUT_ITEMS} placed</span></div>
        <div className={s.assetLibrary}>
          {visibleAssets.map(asset=><button key={asset.id} aria-label={asset.name} data-asset-id={asset.id} disabled={plan.layout.length>=MAX_LAYOUT_ITEMS} className={s.assetCard} onPointerDown={event=>start(event,'palette',{type:'asset',assetId:asset.id})} onClick={event=>{if(event.detail===0)add('asset',undefined,asset.id);}}><span className={s.assetCardImage}>{assetImage(asset.id,0,true)}<Grip size={13}/></span><strong>{asset.name}</strong><small>{round(asset.width,2)} × {round(asset.depth,2)} m</small></button>)}
          {!matching.length&&<div className={s.noResults}><Search size={23}/><strong>No furniture found</strong><p>Try a different name or category.</p><button onClick={()=>{setSearch('');setCategory('all');setVisibleCount(12);}}>Clear filters</button></div>}
          {visibleCount<matching.length&&<button className={s.moreFurniture} onClick={()=>setVisibleCount(count=>count+12)}>Show more furniture <Plus size={14}/></button>}
        </div>
        {[...Object.values(previews.images),...Object.values(planPreviews.images)].some(image=>image.error)&&<button className={s.retryPreviews} onClick={()=>{previews.retry();planPreviews.retry();}}>Retry previews</button>}
        <details className={s.quickSpaces} open><summary>Quick spaces <span>5 layouts</span></summary><div className={s.library}>{furniture.map(item=><button key={item.type} aria-label={item.name} disabled={plan.layout.length>=MAX_LAYOUT_ITEMS} className={s.paletteItem} onPointerDown={event=>start(event,'palette',{type:item.type})} onClick={event=>{if(event.detail===0)add(item.type);}}><span className={s.paletteGlyph}><FurnitureGlyph type={item.type}/></span><span><strong>{item.name}</strong><small>{item.description}</small></span><Grip size={14}/></button>)}</div></details>
        <div className={s.libraryNote}><p>Furniture shapes the space. Create audio and video conversations separately in Rooms.</p></div>
      </aside>
      <section className={s.canvasPanel} aria-label="Floor plan canvas"><header className={s.toolbar}>
        <div className={s.toolGroup}><button title="Select and move" aria-label="Select and move" aria-pressed={!panMode} onClick={()=>setPanMode(false)}><MousePointer2 size={17}/></button><button title="Pan canvas · Space + drag" aria-label="Pan canvas" aria-pressed={panMode} onClick={()=>setPanMode(v=>!v)}><Hand size={17}/></button><i/><button aria-label="Undo" title="Undo · Ctrl / ⌘ Z" disabled={!history.current.past.length||!!gestureKind} onClick={undo}><Undo2 size={17}/></button><button aria-label="Redo" title="Redo · Ctrl / ⌘ Shift Z" disabled={!history.current.future.length||!!gestureKind} onClick={redo}><Redo2 size={17}/></button></div>
        <label className={s.snap}><input type="checkbox" aria-label="Snap to grid" checked={snapping} onChange={event=>setSnapping(event.target.checked)}/> Snap to grid <small>0.5 m</small></label>
        <div className={s.toolGroup}><button aria-label="Zoom out" disabled={zoom<=.5||!!gestureKind} onClick={()=>setZoom(v=>Math.max(.5,round(v-.25,2)))}><Minus size={16}/></button><span className={s.zoom}>{Math.round(zoom*100)}%</span><button aria-label="Zoom in" disabled={zoom>=3||!!gestureKind} onClick={()=>setZoom(v=>Math.min(3,round(v+.25,2)))}><Plus size={16}/></button><button aria-label="Fit floor" title="Fit floor" disabled={!!gestureKind} onClick={fit}><Scan size={18}/></button></div>
      </header>
      <div ref={viewport} data-testid="floor-viewport" className={s.viewport+' '+(panMode||gestureKind==='pan'?s.panning:'')} onPointerDown={event=>{if(panMode||spaceHeld.current||event.button===1)start(event,'pan');}}>
        <div className={s.stage} style={stageStyle}>
          <div ref={board} data-testid="floor-plan" aria-label="Office floor plan" aria-describedby="floor-keyboard-help" tabIndex={0} className={s.floor} style={boardStyle} onPointerDown={event=>{if(panMode||spaceHeld.current||event.button===1)start(event,'pan');else if(event.target===event.currentTarget){setSelected(null);event.currentTarget.focus({preventScroll:true});}}}>
            <span className={s.widthRuler}>{round(plan.floor.width,2)} m</span><span className={s.depthRuler}>{round(plan.floor.depth,2)} m</span>
            {plan.layout.map(item=><div key={item.id} data-object-id={item.id} data-object-type={item.type} data-asset-id={item.assetId} className={s.object+' '+s[item.type]+' '+(selected===item.id?s.selected:'')} style={{left:item.x+'%',top:item.y+'%',width:item.w+'%',height:item.h+'%',zIndex:selected===item.id?3:item.assetId&&getOfficeAsset(item.assetId)?.collidable===false?0:1}}>
              <button className={s.objectBody} aria-label={'Select '+item.label} aria-pressed={selected===item.id} title={item.label} onPointerDown={event=>start(event,'move',{id:item.id})} onClick={()=>setSelected(item.id)}>{item.assetId?assetImage(item.assetId,item.rotation,false,true,(item.h*plan.floor.depth)/(item.w*plan.floor.width)):<FurnitureGlyph type={item.type} rotation={item.rotation}/>}<span>{item.label}</span></button>
              {selected===item.id&&<><span className={s.measurement}>{round(item.w*plan.floor.width/100,2)} × {round(item.h*plan.floor.depth/100,2)} m</span>{edges.map(({edge,name})=><button key={edge} className={s.handle+' '+s['handle_'+edge]} aria-label={'Resize '+name} title={'Drag to resize '+name.toLowerCase()} onPointerDown={event=>start(event,'resize',{id:item.id,edge})} onKeyDown={event=>{if(!event.key.startsWith('Arrow'))return;event.preventDefault();event.stopPropagation();const step=event.shiftKey?1:.1;commit(replaceItem(resizeItem(item,plan.floor,edge,event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0,false)));}}/>)}</>}
            </div>)}
            {ghost&&<div className={s.ghost} style={{left:ghost.x+'%',top:ghost.y+'%',width:ghost.w+'%',height:ghost.h+'%'}}>{ghost.assetId?assetImage(ghost.assetId,0,false,true):<FurnitureGlyph type={ghost.type}/>}<span>Drop here</span></div>}
            {!plan.layout.length&&!ghost&&<div className={s.empty}><Maximize size={27}/><strong>A little space. Endless possibilities.</strong><span>Drag your first building block onto the grid.</span></div>}
            <button className={s.floorHandle+' '+s.floorEast} aria-label="Resize floor width" title="Drag to change floor width · Arrow keys for precision" onPointerDown={event=>start(event,'floor',{edge:'e'})} onKeyDown={event=>floorKeys(event,'e')}><Grip size={14}/></button>
            <button className={s.floorHandle+' '+s.floorSouth} aria-label="Resize floor depth" title="Drag to change floor depth · Arrow keys for precision" onPointerDown={event=>start(event,'floor',{edge:'s'})} onKeyDown={event=>floorKeys(event,'s')}><Grip size={14}/></button>
            <button className={s.floorCorner} aria-label="Resize floor width and depth" title="Drag to resize the floor · Arrow keys for precision" onPointerDown={event=>start(event,'floor',{edge:'se'})} onKeyDown={event=>floorKeys(event,'se')}><ArrowUpRight size={18}/></button>
          </div>
        </div>
      </div>
      <footer className={s.canvasFoot}><span><span className={s.floorDot}/> {p.company.name} · {round(plan.floor.width*plan.floor.depth,1)} m²</span><span>{gestureKind==='palette'?'Release over the floor to place':gestureKind==='floor'?'Furniture keeps its size':gestureKind?'Release to finish · Esc to cancel':'Top view · Drag the outer handles to resize the floor'}</span></footer>
      </section>
      <aside className={s.inspector} aria-label="Floor plan properties">
        <section><header><span className="eyebrow">THE FOUNDATION</span><h2>Floor dimensions</h2><Badge>{round(plan.floor.width*plan.floor.depth,1)} m²</Badge></header><div className={s.fields}><NumberField label="Floor width (m)" value={plan.floor.width} min={minFloor.width} max={maxFloor.width} onValue={value=>updateFloor('width',value)}/><NumberField label="Floor depth (m)" value={plan.floor.depth} min={minFloor.depth} max={maxFloor.depth} onValue={value=>updateFloor('depth',value)}/></div><p className={s.help}>8–40 m on each side. Furniture keeps its size and distance from the top-left corner. Move it inward to shrink the floor.</p>{(maxFloor.width<40||maxFloor.depth<40)&&<p className={s.help}>A small existing object limits expansion to {round(maxFloor.width,2)} × {round(maxFloor.depth,2)} m. Enlarge that object first to extend the floor further.</p>}</section>
        <section><header><span className="eyebrow">{active?'YOUR SELECTION':'OBJECT PROPERTIES'}</span><h2>{active?(activeAsset?.name||furniture.find(item=>item.type===active.type)?.name):'Select a building block'}</h2></header>
          {active&&activeRect?<>{activeAsset&&<div className={s.selectedPreview}>{assetImage(activeAsset.id)}</div>}<Field label="Label"><input value={active.label} maxLength={80} onChange={event=>{if(!labelStart.current)labelStart.current=current.current;draft(replaceItem({...active,label:event.target.value}));}} onBlur={()=>{if(labelStart.current)remember(labelStart.current,current.current);labelStart.current=null;}}/></Field>
            <div className={s.fields}><NumberField label="Left (m)" value={activeRect.x} max={plan.floor.width-activeRect.w} onValue={value=>updateRect('x',value)}/><NumberField label="Top (m)" value={activeRect.y} max={plan.floor.depth-activeRect.h} onValue={value=>updateRect('y',value)}/><NumberField label="Width (m)" value={activeRect.w} min={sizeLimits!.minW} max={sizeLimits!.maxW} onValue={value=>updateRect('w',value)}/><NumberField label="Depth (m)" value={activeRect.h} min={sizeLimits!.minH} max={sizeLimits!.maxH} onValue={value=>updateRect('h',value)}/></div>
            {activeAsset&&<div className={s.assetSizing}><p>{activeAsset.resize==='uniform'?<><LockKeyhole size={13}/> Proportions locked · width and depth resize together.</>:'Resize the footprint independently. Height stays fixed.'}</p><button onClick={()=>{const swapped=(active.rotation||0)%180!==0;commit(replaceItem(place(active,{...activeRect,w:swapped?activeAsset.depth:activeAsset.width,h:swapped?activeAsset.width:activeAsset.depth},plan.floor)));}}>Reset to original size</button></div>}
            <div className={s.objectActions}><button aria-label="Rotate selected object" title="Rotate 90° · R" onClick={rotate}><RotateCw size={17}/><span>{active.rotation||0}°</span></button><button aria-label="Duplicate selected object" title="Duplicate · Ctrl / ⌘ D" disabled={plan.layout.length>=MAX_LAYOUT_ITEMS} onClick={duplicate}><Copy size={17}/><span>Duplicate</span></button><button aria-label="Remove selected object" title="Remove · Delete" className={s.remove} onClick={remove}><Trash2 size={17}/></button></div>
            {!active.label.trim()&&<p className="error-message" role="alert">Give this object a name before saving.</p>}
          </>:<div className={s.selectHint}><MousePointer2 size={24}/><p>Click furniture to move, resize, rotate, or duplicate it. Use the handles for quick changes and the fields for precision.</p></div>}
        </section>
        <details className={s.shortcuts}><summary>Mouse & keyboard shortcuts</summary><p id="floor-keyboard-help">Drag to move. Drag an edge or corner to resize. Hold Alt to bypass snapping. Arrow keys move 0.1 m; Shift + arrows move 1 m. R rotates. Delete removes. Ctrl / ⌘ Z undoes. Space + drag pans. Escape cancels a drag. Dimension fields provide an alternative to every resize handle.</p></details>
      </aside>
    </div>
    <div className={s.saveBar}><div><strong>{saving?'Publishing your floor plan…':dirty?'You have unpublished changes':'Shared floor plan is up to date'}</strong><p>{dirty?'Save when you’re ready to update the office for everyone.':'Your shared office uses these dimensions and furniture positions.'}</p></div><div className={s.saveActions}><button className="button secondary" disabled={!dirty||saving||!!gestureKind} onClick={()=>{if(window.confirm('Discard your unpublished floor plan changes?'))discard();}}>Discard changes</button><button className="button primary" disabled={!dirty||saving||conflict||resolving||!!gestureKind||plan.layout.some(item=>!item.label.trim())} onClick={()=>void save()}>{dirty?<Save size={16}/>:<Check size={16}/>} {saving?'Publishing…':'Save shared floor plan'}</button></div></div>
    {error&&<p className="error-message" role="alert">{error}</p>}<span className="sr-only" role="status">{announcement}</span>
  </div>;
}
