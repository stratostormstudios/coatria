import { handleAvatarRequest } from '@/lib/avatar-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleAvatarRequest(request); }
