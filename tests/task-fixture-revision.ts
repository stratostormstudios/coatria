import {query} from '../src/lib/db';

// Existing sequential authorization/Studio fixtures intentionally operate on
// current work. Explicit revisions (including stale ones) are never replaced.
// Raw request and concurrent revision checks live in task-revision.test.ts.
export async function currentTaskPatchForFixture(path:string,method:string,payload:unknown){
 const match=/^companies\/([^/]+)\/tasks\/([^/?]+)$/.exec(path);
 if(method!=='PATCH'||!match||!payload||typeof payload!=='object'||Array.isArray(payload)||'expectedRevision' in payload)return payload;
 const row=(await query('SELECT revision FROM tasks WHERE company_id=$1 AND id=$2',[match[1],match[2]])).rows[0];
 return {...payload,expectedRevision:row?.revision??1};
}
