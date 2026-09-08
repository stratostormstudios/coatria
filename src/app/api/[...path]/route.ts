import { handleApi } from '@/lib/api';

export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
async function route(request:Request,context:Context){const {path}=await context.params;return handleApi(request,path);}
export {route as GET,route as POST,route as PATCH,route as DELETE,route as PUT};
