const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The company is part of the link; opening a task never changes tenants. */
export function taskHref(companyId:string,taskId:string){
 return `#tasks?company=${encodeURIComponent(companyId)}&task=${encodeURIComponent(taskId)}`;
}

export function taskLinkTarget(hash:string,companyId:string):{taskId:string;error:null;companyId?:never}|{taskId:null;error:string;companyId?:string}|null{
 if(hash==='#tasks'||!hash)return null;
 const query=hash.startsWith('#tasks?')?new URLSearchParams(hash.slice(7)):null;
 if(!query||[...query.keys()].length!==2||query.getAll('company').length!==1||query.getAll('task').length!==1||!uuid.test(query.get('company')??'')||!uuid.test(query.get('task')??''))return {taskId:null,error:'This task link is invalid. Open the task again from Production studio or the work board.'};
 if(query.get('company')!.toLowerCase()!==companyId.toLowerCase())return {taskId:null,companyId:query.get('company')!.toLowerCase(),error:'This task link belongs to another company. You need access to that company to open it.'};
 return {taskId:query.get('task')!.toLowerCase(),error:null};
}
