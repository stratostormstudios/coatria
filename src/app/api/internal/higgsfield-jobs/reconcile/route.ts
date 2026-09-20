import {createHash,timingSafeEqual} from 'node:crypto';
import {reconcileHiggsfieldJobs} from '@/lib/higgsfield-jobs';
import {errorResponse,json} from '@/lib/security';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request){
 const expected=process.env.CRON_SECRET,authorization=request.headers.get('authorization')||'';
 const digest=(value:string)=>createHash('sha256').update(value).digest();
 if(!expected||expected.length<32||authorization.length>4096||!timingSafeEqual(digest(authorization),digest('Bearer '+expected)))return json({error:'Unauthorized.'},401);
 if(process.env.HIGGSFIELD_JOB_RECONCILER_ENABLED!=='1')return json({enabled:false,checked:0,providerGenerationsSubmitted:0});
 try{return json({enabled:true,...await reconcileHiggsfieldJobs(2)});}
 catch(error){return errorResponse(error);}
}
