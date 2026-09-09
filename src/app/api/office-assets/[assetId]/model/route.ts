import {handleOfficeAssetRequest} from '@/lib/office-assets';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{assetId:string}>}){return handleOfficeAssetRequest(request,(await params).assetId);}
