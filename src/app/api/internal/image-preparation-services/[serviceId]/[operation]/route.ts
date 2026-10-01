import {imagePreparationServiceRequest} from '@/lib/project-image-preparation-service-runtime';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function POST(request:Request){return imagePreparationServiceRequest(request);}
