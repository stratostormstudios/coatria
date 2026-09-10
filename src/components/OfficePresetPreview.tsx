import {OFFICE_50_PRESET} from '@/lib/office-presets';
import {getOfficeAsset} from '@/lib/office-catalog';

/** An actual plan diagram generated from the preset's saved geometry. */
export default function OfficePresetPreview(){
  const p=OFFICE_50_PRESET;
  return <svg viewBox={`-1 -1 ${p.floor.width+2} ${p.floor.depth+2}`} role="img" aria-label="50-person office plan with five team neighborhoods, a project lounge, and shared commons" style={{display:'block',width:'100%',height:'auto'}}>
    <rect x={-1} y={-1} width={p.floor.width+2} height={p.floor.depth+2} rx={.5} fill="#eef1e7"/>
    <rect width={p.floor.width} height={p.floor.depth} fill="#fffdf4" stroke="#6c8265" strokeWidth={.12}/>
    {p.layout.map(item=>{const asset=getOfficeAsset(item.assetId||'');return <rect key={item.id} x={item.x*p.floor.width/100} y={item.y*p.floor.depth/100} width={item.w*p.floor.width/100} height={item.h*p.floor.depth/100} rx={asset?.category==='seating'?.14:.05} fill={asset?.collidable===false?'#e4eadb':asset?.category==='desks'?'#bea680':asset?.category==='seating'?'#6c8062':asset?.category==='plants'?'#779653':'#b3b4a1'} stroke={asset?.collidable===false?'none':'#597051'} strokeWidth={.025}/>;})}
    {p.zones.map(zone=><text key={zone.id} x={zone.bounds.x+.1} y={zone.bounds.y-.25} fill="#345137" fontSize={.4} fontFamily="sans-serif" fontWeight={600}>{zone.name.toUpperCase()}</text>)}
  </svg>;
}
