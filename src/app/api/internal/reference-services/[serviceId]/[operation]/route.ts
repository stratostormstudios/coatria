import {referenceServiceRequest} from '@/lib/higgsfield-reference-service-runtime';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function POST(request:Request,context:{params:Promise<{serviceId:string;operation:string}>}){
 const {serviceId,operation}=await context.params;return referenceServiceRequest(request,serviceId,operation);
}
