import { query } from '@/lib/db';
import { json } from '@/lib/security';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const migrations=['001_initial.sql','002_calls.sql','003_agent_submission_summary.sql'];
export async function GET() {
  if(!process.env.DATABASE_URL)return json({status:'setup_required',configured:false},503);
  try {
    await query('SELECT 1');
    const result=await query('SELECT name FROM schema_migrations WHERE name=ANY($1::text[])',[migrations]);
    if(result.rows.length!==migrations.length)return json({status:'setup_required',configured:true},503);
    return json({status:'ready',configured:true});
  } catch { return json({status:'setup_required',configured:true},503); }
}
