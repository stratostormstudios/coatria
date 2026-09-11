import type {Presence} from './client';

/** Request order governs roster membership; server row times govern movement. */
export function mergePresence(previous:Presence[],incoming:Presence[],newestRoster:boolean,preserveUserId?:string):Presence[]{
  const oldRows=new Map(previous.map(row=>[row.userId,row]));
  const incomingRows=new Map(incoming.map(row=>[row.userId,row]));
  const time=(row:Presence)=>Date.parse(row.updatedAt)||0;
  if(newestRoster)return incoming.filter(row=>row.userId!==preserveUserId||oldRows.has(row.userId)).map(row=>{
    const old=oldRows.get(row.userId);
    if(row.userId===preserveUserId&&old)return old;
    return old&&time(old)>time(row)?old:row;
  });
  // A late write can advance a surviving row, but cannot resurrect a removed person.
  return previous.map(row=>{
    if(row.userId===preserveUserId)return row;
    const next=incomingRows.get(row.userId);
    return next&&time(next)>time(row)?next:row;
  });
}
