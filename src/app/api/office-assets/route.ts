import {handleOfficeAssetRequest} from '@/lib/office-assets';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return handleOfficeAssetRequest(request);}
