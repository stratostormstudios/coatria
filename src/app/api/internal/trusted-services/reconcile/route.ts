import {createHash,timingSafeEqual} from 'node:crypto';
import {reconcileTrustedServices} from '@/lib/trusted-service-provisioning';
import {errorResponse,json} from '@/lib/security';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(request:Request){
 const expected=process.env.CRON_SECRET,authorization=request.headers.get('authorization')||'',digest=(value:string)=>createHash('sha256').update(value).digest();
 if(!expected||authorization.length>4096||!timingSafeEqual(digest(authorization),digest('Bearer '+expected)))return json({error:'Unauthorized.'},401);
 try{return json(await reconcileTrustedServices(2));}catch(error){return errorResponse(error);}
}
