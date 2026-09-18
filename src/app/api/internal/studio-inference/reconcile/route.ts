import {createHash,timingSafeEqual} from 'node:crypto';
import {reconcileStudioInferenceJobs} from '@/lib/studio-inference';
import {errorResponse,json} from '@/lib/security';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request){
 const expected=process.env.CRON_SECRET,authorization=request.headers.get('authorization')||'';
 const digest=(value:string)=>createHash('sha256').update(value).digest();
 if(!expected||authorization.length>4096||!timingSafeEqual(digest(authorization),digest('Bearer '+expected)))return json({error:'Unauthorized.'},401);
 try{return json(await reconcileStudioInferenceJobs(2));}
 catch(error){return errorResponse(error);}
}
