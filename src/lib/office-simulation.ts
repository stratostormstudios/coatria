import {AVATAR_CATALOG} from './avatar-catalog';
import {OFFICE_50_PRESET} from './office-presets';
import type {User,Member,Presence} from './client';

export type SimulationScenario='working'|'moving'|'reconnect';
const names=['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Jamie','Avery','Robin'];
const colors=['#dae5ce','#ebdfcd','#d5e4e4','#e4ddec','#e8e2cd'];
export function simulationMembers(viewer:User,count:number):Member[]{
  return Array.from({length:Math.max(1,Math.min(50,Math.floor(count)))},(_,i)=>({id:i===0?viewer.id:`lab-person-${i}`,userId:i===0?viewer.id:`lab-person-${i}`,name:i===0?'You · test observer':`${names[i%10]} · ${String(i+1).padStart(2,'0')}`,email:'',role:i===0?'owner':'member',roleTitle:`Test teammate · ${OFFICE_50_PRESET.zones.find(z=>z.id===OFFICE_50_PRESET.workstations[i].zoneId)?.name||'Studio'}`,avatarColor:colors[Math.floor(i/10)],avatarId:AVATAR_CATALOG[i%AVATAR_CATALOG.length].id}));
}

/** Deterministic local snapshots. These identities never enter the company's APIs. */
export function simulationPresence(members:Member[],elapsed:number,scenario:SimulationScenario,observer?:{x:number;z:number}):Presence[]{
  const step=Math.floor(elapsed/8),disrupted=scenario==='reconnect'&&elapsed>=18&&elapsed<30;
  return members.filter((_,i)=>!disrupted||i===0||i%5!==0).map((member,i)=>{
    const index=members.indexOf(member),station=OFFICE_50_PRESET.workstations[index];
    const moving=index!==0&&(scenario==='moving'||index%4===step%4);
    const destination=moving?OFFICE_50_PRESET.workstations[(index+step*7+9)%members.length].approach:station.approach;
    const position=index===0?(observer||OFFICE_50_PRESET.spawn):destination;
    return {userId:member.userId,name:member.name,avatarColor:member.avatarColor,avatarId:member.avatarId,roomId:null,x:position.x,z:position.z,status:moving?'available':'focus',updatedAt:new Date().toISOString()};
  });
}

export type ConnectionReport={schemaVersion:1;kind:'coatria-connections';generatedAt:string;summary:{clients:number;durationSeconds:number;requests:number;errorRate:number;p50Ms:number;p95Ms:number;maxMs:number;requestsPerSecond:number;bytesReceived:number;passed:boolean;unexpectedErrors:number};checks:{id:string;label:string;passed:boolean;detail:string}[];environment:{applicationMode:string;database:string;isolated:boolean;origin:string;databasePoolMax:number;limitations:string[]};cleanup:{verified:boolean;remainingUsers:number;remainingCompanies:number}};
export function readConnectionReport(value:unknown):ConnectionReport{
  if(!value||typeof value!=='object')throw new Error('Choose a Coatria connection-test JSON report.');
  const r=value as Record<string,any>,s=r.summary,e=r.environment,c=r.cleanup;
  const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e15;
  const text=(v:unknown,max=1000)=>typeof v==='string'&&v.length<=max;
  if(r.schemaVersion!==1||r.kind!=='coatria-connections'||!text(r.generatedAt,80)||!Number.isFinite(Date.parse(r.generatedAt))||!s||!e||!c||!Array.isArray(r.checks)||r.checks.length>100||
    !['clients','durationSeconds','requests','errorRate','p50Ms','p95Ms','maxMs','requestsPerSecond','bytesReceived','unexpectedErrors'].every(k=>number(s[k]))||s.clients>100||s.errorRate>1||typeof s.passed!=='boolean'||
    !['applicationMode','database','origin'].every(k=>text(e[k],250))||typeof e.isolated!=='boolean'||!number(e.databasePoolMax)||!Array.isArray(e.limitations)||e.limitations.length>30||!e.limitations.every((v:unknown)=>text(v))||
    typeof c.verified!=='boolean'||!number(c.remainingUsers)||!number(c.remainingCompanies)||r.checks.some((v:any)=>!v||!text(v.id,100)||!text(v.label,200)||!text(v.detail,2000)||typeof v.passed!=='boolean'))throw new Error('This file does not match the supported connection-test report format.');
  return {schemaVersion:1,kind:'coatria-connections',generatedAt:r.generatedAt,summary:s,checks:r.checks,environment:e,cleanup:c};
}
