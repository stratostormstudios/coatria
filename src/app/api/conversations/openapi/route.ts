import {conversationOpenApi} from '@/lib/conversation-openapi';
export function GET(){return Response.json(conversationOpenApi,{headers:{'Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'}});}
