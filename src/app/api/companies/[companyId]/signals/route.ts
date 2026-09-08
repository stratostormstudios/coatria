import { z } from 'zod';
import { requireMembership, lockMembership } from '@/lib/auth';
import { transaction } from '@/lib/db';
import { assertOrigin, body, errorResponse, fail, id, json, rateLimit } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params: Promise<{companyId:string}>};
const payloadSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('description'),description:z.object({type:z.enum(['offer','answer']),sdp:z.string().max(32000)})}),
  z.object({type:z.literal('candidate'),candidate:z.object({candidate:z.string().max(2000),sdpMid:z.string().max(100).nullable().optional(),sdpMLineIndex:z.number().int().min(0).max(100).nullable().optional(),usernameFragment:z.string().max(256).nullable().optional()})})
]);
const inputSchema = z.object({
  action:z.enum(['join','heartbeat','leave','signal']), roomId:z.string().uuid(), peerId:z.string().uuid(),
  recipientId:z.string().uuid().optional(), payload:payloadSchema.optional()
});

export async function GET(request:Request, context:Context) {
  try {
    const {companyId}=await context.params, m=await requireMembership(request,companyId);
    const url=new URL(request.url), peerId=id(url.searchParams.get('peerId')||''), roomId=id(url.searchParams.get('roomId')||'');
    const after=url.searchParams.get('after')||'0';
    if (!/^\d{1,19}$/.test(after) || BigInt(after)>9223372036854775807n) fail(400,'Invalid signal cursor.');
    await rateLimit(`call-poll:${m.userId}`,120,60);
    const result=await transaction(async client=>{
      await lockMembership(client,m);
      const own=(await client.query("SELECT id FROM call_peers WHERE id=$1 AND company_id=$2 AND room_id=$3 AND user_id=$4 AND updated_at>now()-interval '45 seconds'",[peerId,companyId,roomId,m.userId])).rows[0];
      if (!own) fail(409,'Rejoin the room call.');
      const peers=await client.query(`SELECT p.id,p.user_id AS "userId",u.name FROM call_peers p JOIN users u ON u.id=p.user_id JOIN memberships m ON m.user_id=p.user_id AND m.company_id=p.company_id AND m.role<>'removed' WHERE p.company_id=$1 AND p.room_id=$2 AND p.id<>$3 AND p.updated_at>now()-interval '45 seconds' ORDER BY p.id`,[companyId,roomId,peerId]);
      const signals=await client.query(`SELECT s.id::text,s.sender_id AS "senderId",s.payload FROM call_signals s JOIN call_peers p ON p.id=s.sender_id JOIN memberships m ON m.company_id=p.company_id AND m.user_id=p.user_id AND m.role<>'removed' WHERE s.company_id=$1 AND s.room_id=$2 AND s.recipient_id=$3 AND s.id>$4::bigint AND s.created_at>now()-interval '2 minutes' AND p.updated_at>now()-interval '45 seconds' ORDER BY s.id LIMIT 100`,[companyId,roomId,peerId,after]);
      return {peers:peers.rows,signals:signals.rows};
    });
    return json(result);
  } catch(error) {return errorResponse(error);}
}

export async function POST(request:Request,context:Context) {
  try {
    assertOrigin(request);
    const {companyId}=await context.params, m=await requireMembership(request,companyId), input=await body(request,inputSchema,40000);
    await rateLimit(`call-write:${m.userId}`,240,60);
    const result=await transaction(async client=>{
      await lockMembership(client,m);
      // Serialize writes within this bounded room. Otherwise sequence ID N+1 can
      // commit before N, and a polling client can advance past an unseen signal.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`call:${companyId}:${input.roomId}`]);
      const room=(await client.query('SELECT id,capacity FROM rooms WHERE id=$1 AND company_id=$2',[input.roomId,companyId])).rows[0];
      if(!room) fail(404,'Room not found.');
      if(input.action==='join') {
        await client.query("DELETE FROM call_peers p WHERE p.company_id=$1 AND p.room_id=$2 AND (p.updated_at<now()-interval '45 seconds' OR NOT EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=p.company_id AND m.user_id=p.user_id AND m.role<>'removed'))",[companyId,input.roomId]);
        await client.query("DELETE FROM call_signals WHERE company_id=$1 AND room_id=$2 AND created_at<now()-interval '2 minutes'",[companyId,input.roomId]);
        const existing=(await client.query('SELECT user_id FROM call_peers WHERE id=$1',[input.peerId])).rows[0];
        if(existing) fail(409,'This call session already exists.');
        const count=Number((await client.query('SELECT count(*) FROM call_peers WHERE company_id=$1 AND room_id=$2',[companyId,input.roomId])).rows[0].count);
        const capacity=Math.min(6,Number(room.capacity));
        if(count>=capacity) fail(409,`This room supports up to ${capacity} participants per call.`);
        await client.query('INSERT INTO call_peers(id,company_id,room_id,user_id) VALUES($1,$2,$3,$4)',[input.peerId,companyId,input.roomId,m.userId]);
        const iceServers:RTCIceServer[]=[{urls:'stun:stun.l.google.com:19302'}];
        const turnConfigured=Boolean(process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL);
        if(turnConfigured) iceServers.push({urls:process.env.TURN_URL!,username:process.env.TURN_USERNAME!,credential:process.env.TURN_CREDENTIAL!});
        return {ok:true,iceServers,turnConfigured};
      }
      const own=(await client.query("SELECT id FROM call_peers WHERE id=$1 AND company_id=$2 AND room_id=$3 AND user_id=$4 AND updated_at>now()-interval '45 seconds' FOR UPDATE",[input.peerId,companyId,input.roomId,m.userId])).rows[0];
      if(!own) fail(409,'Rejoin the room call.');
      if(input.action==='leave') {await client.query('DELETE FROM call_peers WHERE id=$1',[input.peerId]);return {ok:true};}
      await client.query('UPDATE call_peers SET updated_at=now() WHERE id=$1',[input.peerId]);
      if(input.action==='signal') {
        if(!input.recipientId || !input.payload || input.recipientId===input.peerId) fail(400,'A recipient and signal are required.');
        const recipient=(await client.query("SELECT p.id FROM call_peers p JOIN memberships m ON m.company_id=p.company_id AND m.user_id=p.user_id AND m.role<>'removed' WHERE p.id=$1 AND p.company_id=$2 AND p.room_id=$3 AND p.updated_at>now()-interval '45 seconds'",[input.recipientId,companyId,input.roomId])).rows[0];
        if(!recipient) fail(404,'Participant is no longer in this call.');
        await client.query('INSERT INTO call_signals(company_id,room_id,sender_id,recipient_id,payload) VALUES($1,$2,$3,$4,$5)',[companyId,input.roomId,input.peerId,input.recipientId,JSON.stringify(input.payload)]);
      }
      return {ok:true};
    });
    return json(result);
  } catch(error) {return errorResponse(error);}
}
