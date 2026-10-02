/** Exact provider observations only. Even ready/running counts do not prove a hot model.
 * https://github.com/runpod/runpodctl#waiting-until-a-resource-is-usable */
export const RUNPOD_WORKER_COUNT_KEYS=['idle','initializing','ready','running','throttled','unhealthy'] as const;
export type RunpodWorkerCounts=Record<typeof RUNPOD_WORKER_COUNT_KEYS[number],number|null>;
export type RunpodWorkerState='reported'|'none_reported'|'unconfirmed';
export function projectRunpodWorkerReadiness(value:unknown):{workerState:RunpodWorkerState;workerCounts:RunpodWorkerCounts;modelReadiness:'unverified'}{
 const workers=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 const valid=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
 const workerCounts=Object.fromEntries(RUNPOD_WORKER_COUNT_KEYS.map(key=>[key,valid(workers[key])?workers[key]:null])) as RunpodWorkerCounts;
 const malformed=RUNPOD_WORKER_COUNT_KEYS.some(key=>workers[key]!==undefined&&workers[key]!==null&&!valid(workers[key]));
 const workerState:RunpodWorkerState=malformed?'unconfirmed':RUNPOD_WORKER_COUNT_KEYS.some(key=>(workerCounts[key]??0)>0)?'reported':RUNPOD_WORKER_COUNT_KEYS.every(key=>workerCounts[key]===0)?'none_reported':'unconfirmed';
 return {workerState,workerCounts,modelReadiness:'unverified'};
}
