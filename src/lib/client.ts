export type User = { id:string; name:string; email:string; roleTitle:string; avatarColor:string; avatarId:string|null };
export type Company = { id:string; name:string; slug:string; template:string; role:string };
export type Member = { id:string; userId:string; name:string; email:string; role:string; roleTitle:string; avatarColor:string; avatarId:string|null };
export type Room = { id:string; name:string; kind:string; capacity:number };
export type Presence = { userId:string; name:string; avatarColor:string; avatarId:string|null; roomId:string|null; x:number; z:number; status:string; updatedAt:string };
export type Task = { id:string; title:string; description:string; status:string; assigneeId:string|null; createdBy:string; submissionUrl:string|null; submissionSummary?:string; reviewNote:string|null; submittedBy?:string|null; submittedAgentId?:string|null; approvedBy?:string|null; authorIds?:string[]; createdAt:string; updatedAt:string };
export type Message = { id:string; roomId:string|null; body:string; createdAt:string; userId:string; authorName:string };
export type Agent = { id:string; name:string; harness:string; description:string; status:string; createdBy:string; lastSeenAt:string|null };
export type Drive = { id:string; name:string; kind:string; description:string; status:string; lastSeenAt:string|null; fileCount:number };
export type Opening = { id:string; companyId:string; companyName?:string; title:string; description:string; type:string; compensation:string; budget?:string; status:string; createdAt:string };
export type Application = { id:string; openingId:string; userId:string; message:string; status:string; name?:string; applicantName?:string; applicantEmail?:string; openingTitle?:string; companyName?:string; agentId?:string; createdAt:string };
export type Skill = { id:string; title:string; description:string; content:string; version:number; updatedAt:string };
export type LayoutItem = { id:string; type:'desk'|'meeting'|'focus'|'lounge'|'plant'; x:number; y:number; w:number; h:number; label:string };
export type Activity = { id:string; description?:string; action?:string; body?:string; message?:string; actorName?:string; createdAt:string };
export type Workspace = { company:Company; rooms:Room[]; members:Member[]; agents:Agent[]; tasks:Task[]; messages:Message[]; presence:Presence[]; activity:Activity[]; drives:Drive[]; openings:Opening[]; applications:Application[]; layout:LayoutItem[] };
export type Session = { user:User|null; companies:Company[]; configured?:boolean };
let expectedUserId:string|null=null;
let identityVersion=0;
export function setClientIdentity(userId:string|null){if(expectedUserId!==userId)identityVersion++;expectedUserId=userId;}
export async function api<T>(path:string, method='GET', body?:unknown):Promise<T> {
  const identityIndependent=path==='/api/session'||path==='/api/auth/login'||path==='/api/auth/signup';
  const requestIdentityVersion=identityVersion;
  const headers:Record<string,string>={};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(expectedUserId&&!identityIndependent)headers['X-Coatria-User']=expectedUserId;
  const response = await fetch(path, { method, credentials:'same-origin', cache:'no-store', headers, body:body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({error:'The server returned an unreadable response. Please try again.'}));
  if(!identityIndependent&&requestIdentityVersion!==identityVersion)throw Object.assign(new Error('Your account changed before this request finished. Please try again.'),{status:409,code:'SESSION_CHANGED'});
  if (!response.ok){
    if(!identityIndependent&&(response.status===401||data.code==='SESSION_CHANGED')&&typeof window!=='undefined')window.dispatchEvent(new Event('coatria:session-changed'));
    throw Object.assign(new Error(data.error || `Request failed (${response.status}).`),{status:response.status,code:data.code});
  }
  return data as T;
}
export function values(form:HTMLFormElement) { return Object.fromEntries(new FormData(form).entries()) as Record<string,string>; }
export function initials(name:string) { return name.trim().split(/\s+/).slice(0,2).map(v=>v[0]).join('').toUpperCase(); }
export function when(date?:string|null) { if (!date) return 'Not connected yet'; const d = new Date(date); return Number.isNaN(+d) ? '' : d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
export function safeUrl(url?:string|null) { if (!url) return undefined; try { const u = new URL(url); return ['https:','http:'].includes(u.protocol) ? u.href : undefined; } catch { return undefined; } }
