/** Read-only availability for the exact CPU size and product we submit.
 * Catalog availability is a snapshot, never an allocation guarantee. */
export const RUNPOD_CPU_CATALOG_PATH='/catalog/cpus/cpu3c?include=AVAILABILITY&product=POD&vcpuCount=2';
type Capacity='available'|'unavailable'|'unconfirmed';
const levels=new Set(['NONE','LOW','MEDIUM','HIGH']);
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
export function runpodCpuCapacity(cpu:unknown,dataCenterId:string):Capacity{
 if(!object(cpu)||!levels.has(cpu.availability as string))return 'unconfirmed';
 if(cpu.availability==='NONE')return 'unavailable';
 if(!Array.isArray(cpu.dataCenters)||cpu.dataCenters.length>200)return 'unconfirmed';
 const seen=new Set<string>();let selected:string|undefined;
 for(const entry of cpu.dataCenters){
  if(!object(entry)||typeof entry.id!=='string'||!entry.id||seen.has(entry.id)||!levels.has(entry.availability as string))return 'unconfirmed';
  seen.add(entry.id);if(entry.id===dataCenterId)selected=entry.availability as string;
 }
 return !selected||selected==='NONE'?'unavailable':'available';
}
