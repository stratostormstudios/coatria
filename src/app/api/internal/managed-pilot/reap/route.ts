import { reapManagedPilot } from '@/lib/managed-pilot-reaper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  return reapManagedPilot(request);
}
