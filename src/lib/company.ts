import { z } from 'zod';
import {randomUUID} from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from './db';
import { lockMembership, requireMembership, requireUser, type Membership } from './auth';
import { body, fail, hashToken, id, json, publicUrl, rateLimit, secret, uuid } from './security';
import { agentColumns, driveColumns, email, layoutInput, openingColumns, presenceInput, roomInput, STUDIO_LAYOUT, taskColumns, text } from './model';
import { DEFAULT_FLOOR, readFloorPlan, type FloorPlanDocument } from './floor-plan';
import {resolveOfficeSeat,type OfficeSeat} from './office-seating';
import {INTERACTION_TTL_SECONDS} from './presence-protocol';

export async function recordActivity(client: PoolClient, member: Membership, kind: string, description: string) {
  await client.query('INSERT INTO activity(company_id,actor_id,kind,description) VALUES($1,$2,$3,$4)', [member.companyId, member.userId, kind, description]);
}
export async function memberMutation<T>(member: Membership, admin: boolean, run: (client: PoolClient) => Promise<T>) {
  return transaction(async client => {
    // Lifecycle changes lock company first; KEY SHARE permits concurrent writes.
    await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE', [member.companyId]);
    member.role = await lockMembership(client, member, admin); return run(client);
  });
}
export async function existingRoom(client: PoolClient, companyId: string, roomId: string | null | undefined) {
  if (roomId && !(await client.query('SELECT id FROM rooms WHERE id=$1 AND company_id=$2', [roomId, companyId])).rowCount) fail(400, 'Room is not part of this company.');
}
export async function existingAssignee(client: PoolClient, companyId: string, userId: string | null | undefined) {
  if (userId && !(await client.query("SELECT user_id FROM memberships WHERE user_id=$1 AND company_id=$2 AND role<>'removed' FOR SHARE", [userId, companyId])).rowCount) fail(400, 'Assignee is not an active member of this company.');
}
export async function readPresence(companyId: string) {
  return (await query(`SELECT p.user_id AS "userId",u.name,u.avatar_color AS "avatarColor",u.avatar_id AS "avatarId",p.room_id AS "roomId",p.x,p.z,p.status,p.state_updated_at AS "updatedAt",
    p.motion_mode AS "motionMode",p.seat_id AS "seatId",p.seat_transform AS seat,
    CASE WHEN p.interaction_at>clock_timestamp()-$2*interval '1 second' THEN json_build_object('id',p.interaction_id,'type',p.interaction_type,'value',p.interaction_value,'createdAt',p.interaction_at,'expiresAt',p.interaction_at+$2*interval '1 second') ELSE NULL END AS interaction
    FROM presence p JOIN users u ON u.id=p.user_id JOIN memberships m ON m.user_id=p.user_id AND m.company_id=p.company_id
    WHERE p.company_id=$1 AND p.updated_at>clock_timestamp()-interval '45 seconds' AND m.role<>'removed' ORDER BY u.name`, [companyId,INTERACTION_TTL_SECONDS])).rows;
}
async function writePresence(client:PoolClient,member:Membership,data:z.infer<typeof presenceInput>){
 const companyId=member.companyId;
 await existingRoom(client,companyId,data.roomId);
 // Serialize one person's initial INSERT as well as later writes. No other person's
 // presence row is locked, so opposite seat requests cannot form a row-lock cycle.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`presence-user:${companyId}:${member.userId}`]);
 const previous=(await client.query("SELECT *,updated_at>clock_timestamp()-interval '45 seconds' AS active FROM presence WHERE company_id=$1 AND user_id=$2 FOR UPDATE",[companyId,member.userId])).rows[0];
 const moved=Boolean(previous&&(Math.abs(previous.x-data.x)>.0001||Math.abs(previous.z-data.z)>.0001));
 const roomChanged=Boolean(previous&&previous.room_id!==data.roomId),explicitSeat=typeof data.seatId==='string';
 let seatId=explicitSeat?data.seatId!:data.seatId===null||moved||roomChanged||!previous?.active?null:previous?.seat_id??null;
 let seat:OfficeSeat|null=null,x=data.x,z=data.z;
 if(seatId){
  const plan=readFloorPlan((await client.query('SELECT layout FROM companies WHERE id=$1',[companyId])).rows[0].layout);
  const item=plan.items.find(item=>item.id===seatId);seat=item?resolveOfficeSeat(item,plan.floor):null;
  if(!seat){if(explicitSeat)fail(404,'This chair is no longer available for sitting.','SEAT_UNAVAILABLE');seatId=null;}
  else{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`presence-seat:${companyId}:${seatId}`]);
   const occupied=(await client.query("SELECT 1 FROM presence p JOIN memberships m ON m.company_id=p.company_id AND m.user_id=p.user_id WHERE p.company_id=$1 AND p.seat_id=$2 AND p.user_id<>$3 AND p.updated_at>clock_timestamp()-interval '45 seconds' AND m.role<>'removed' LIMIT 1",[companyId,seatId,member.userId])).rowCount;
   if(occupied){if(explicitSeat)fail(409,'Someone else is using this chair. Choose another seat.','SEAT_OCCUPIED');x=seat.approach.x;z=seat.approach.z;seatId=null;seat=null;}
   else{x=seat.x;z=seat.z;}
  }
 }
 if(!seat&&previous?.seat_transform&&!moved&&(data.seatId===null||roomChanged||!previous.active)){
  x=previous.seat_transform.approach.x;z=previous.seat_transform.approach.z;
 }
 const clearEmote=previous?.interaction_type==='emote'&&(moved||roomChanged||data.seatId===null||data.motionMode==='teleport'||explicitSeat);
 const interaction=data.interaction;
 // Keep existing event values inside PostgreSQL. Passing timestamptz through a
 // JavaScript Date would truncate microseconds and change a heartbeat's event.
 const eventId=interaction?randomUUID():null;
 await client.query(`INSERT INTO presence(company_id,user_id,room_id,x,z,status,motion_mode,seat_id,seat_transform,interaction_id,interaction_type,interaction_value,interaction_at,state_updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $13::boolean THEN clock_timestamp() ELSE NULL END,clock_timestamp())
  ON CONFLICT(company_id,user_id) DO UPDATE SET room_id=EXCLUDED.room_id,x=EXCLUDED.x,z=EXCLUDED.z,status=EXCLUDED.status,motion_mode=EXCLUDED.motion_mode,
  seat_id=EXCLUDED.seat_id,seat_transform=EXCLUDED.seat_transform,
  interaction_id=CASE WHEN $13::boolean THEN EXCLUDED.interaction_id WHEN $14::boolean THEN NULL ELSE presence.interaction_id END,
  interaction_type=CASE WHEN $13::boolean THEN EXCLUDED.interaction_type WHEN $14::boolean THEN NULL ELSE presence.interaction_type END,
  interaction_value=CASE WHEN $13::boolean THEN EXCLUDED.interaction_value WHEN $14::boolean THEN NULL ELSE presence.interaction_value END,
  interaction_at=CASE WHEN $13::boolean THEN EXCLUDED.interaction_at WHEN $14::boolean THEN NULL ELSE presence.interaction_at END,
  updated_at=clock_timestamp(),state_updated_at=GREATEST(clock_timestamp(),presence.state_updated_at+interval '1 millisecond')`,
  [companyId,member.userId,data.roomId,x,z,data.status,data.motionMode??previous?.motion_mode??'walk',seatId,seat?JSON.stringify(seat):null,eventId,interaction?.type??null,interaction?.value??null,Boolean(interaction),Boolean(clearEmote)]);
}
async function releaseChangedSeats(client:PoolClient,companyId:string,plan:FloorPlanDocument){
 const occupants=(await client.query('SELECT user_id,seat_id,seat_transform FROM presence WHERE company_id=$1 AND seat_id IS NOT NULL',[companyId])).rows;
 for(const occupant of occupants){
  const item=plan.items.find(item=>item.id===occupant.seat_id),current=item?resolveOfficeSeat(item,plan.floor):null;
  const same=current&&['x','z','yaw','seatHeight'].every(key=>Math.abs(current[key as 'x'|'z'|'yaw'|'seatHeight']-occupant.seat_transform[key])<.000001)&&Math.abs(current.approach.x-occupant.seat_transform.approach.x)<.000001&&Math.abs(current.approach.z-occupant.seat_transform.approach.z)<.000001;
  if(same)continue;
  const previous=occupant.seat_transform as OfficeSeat;
  const x=Math.max(-plan.floor.width/2+.45,Math.min(plan.floor.width/2-.45,previous.approach.x)),z=Math.max(-plan.floor.depth/2+.45,Math.min(plan.floor.depth/2-.45,previous.approach.z));
  await client.query(`UPDATE presence SET seat_id=NULL,seat_transform=NULL,x=$3,z=$4,motion_mode='walk',
   interaction_id=CASE WHEN interaction_type='emote' THEN NULL ELSE interaction_id END,interaction_value=CASE WHEN interaction_type='emote' THEN NULL ELSE interaction_value END,
   interaction_at=CASE WHEN interaction_type='emote' THEN NULL ELSE interaction_at END,interaction_type=CASE WHEN interaction_type='emote' THEN NULL ELSE interaction_type END,
   state_updated_at=GREATEST(clock_timestamp(),state_updated_at+interval '1 millisecond') WHERE company_id=$1 AND user_id=$2`,[companyId,occupant.user_id,x,z]);
 }
}
export async function createInvitation(client: PoolClient, member: Membership, role: 'admin' | 'member', emailAddress: string | null, request: Request, recipientUserId: string | null = null) {
  if (emailAddress) {
    const verified=(await client.query('SELECT id FROM users WHERE email=$1 AND email_verified_at IS NOT NULL FOR SHARE',[emailAddress])).rows[0];
    if(!verified)fail(409,'Email-restricted invitations require verified email. Verification delivery is not enabled yet. Create a single-use invitation link and share it directly with the intended person.','EMAIL_VERIFICATION_REQUIRED');
  }
  const token = secret('ci_'); const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const invitation = (await client.query('INSERT INTO invitations(company_id,token_hash,email,role,created_by,expires_at,recipient_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [member.companyId, hashToken(token), emailAddress, role, member.userId, expiresAt,recipientUserId])).rows[0];
  return { id: invitation.id, token, url: `${publicUrl(request)}/?invite=${encodeURIComponent(token)}`, expiresAt };
}
export async function companyRoute(request: Request, parts: string[], method: string): Promise<Response | null> {
  const path = parts.join('/');
  if (path === 'companies' && method === 'POST') {
    const user = await requireUser(request); await rateLimit(`company-create:${user.id}`, 5, 86400);
    const data = await body(request, z.object({ name: text(100), slug: z.string().trim().toLowerCase().min(3).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), template: z.enum(['studio','blank']) }).strict());
    const company = await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      if (Number((await client.query("SELECT count(*) FROM memberships WHERE user_id=$1 AND role='owner'", [user.id])).rows[0].count) >= 5) fail(409, 'You can own up to five companies in this release.');
      const layout={version:1,items:data.template==='studio'?STUDIO_LAYOUT:[],floor:DEFAULT_FLOOR,revision:0};
      const row = (await client.query('INSERT INTO companies(name,slug,template,layout) VALUES($1,$2,$3,$4) RETURNING id,name,slug,template', [data.name, data.slug, data.template, JSON.stringify(layout)])).rows[0];
      await client.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')", [row.id, user.id]);
      if (data.template === 'studio') {
        for (const room of [['Meeting room','meeting',8],['Focus room','focus',4],['Lounge','lounge',12],['Auditorium','auditorium',50]]) await client.query('INSERT INTO rooms(company_id,name,kind,capacity) VALUES($1,$2,$3,$4)', [row.id,...room]);
      }
      await recordActivity(client, {companyId:row.id,userId:user.id,role:'owner',user}, 'company.created', `${user.name} opened the company.`);
      return {...row,role:'owner'};
    });
    return json({company},201);
  }
  if (path === 'invitations/join' && method === 'POST') {
    const user = await requireUser(request); await rateLimit(`invite-join:${user.id}`, 15, 900);
    const data = await body(request,z.object({token:z.string().min(20).max(150)}).strict());
    const company = await transaction(async client => {
      const located=(await client.query('SELECT company_id FROM invitations WHERE token_hash=$1',[hashToken(data.token)])).rows[0];
      if(!located)fail(400,'This invitation is invalid, expired, or already used.');
      // Same company-first order as offboarding. Serialize simultaneous invites
      // for one account so a second redemption cannot overwrite the first role.
      await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[located.company_id]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`invite:${located.company_id}:${user.id}`]);
      const invite = (await client.query('SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE', [hashToken(data.token)])).rows[0];
      if (!invite || invite.used_at || new Date(invite.expires_at).getTime() <= Date.now()) fail(400,'This invitation is invalid, expired, or already used.');
      if (invite.email && invite.email !== user.email) fail(403,'This invitation belongs to a different email address.');
      if (invite.email) {
        const verified=(await client.query('SELECT id FROM users WHERE id=$1 AND email=$2 AND email_verified_at IS NOT NULL FOR SHARE',[user.id,invite.email])).rows[0];
        if(!verified)fail(403,'This invitation requires verified ownership of its email address. Request a new invitation directly from the company administrator.','EMAIL_VERIFICATION_REQUIRED');
      }
      if(invite.recipient_user_id&&invite.recipient_user_id!==user.id)fail(403,'This invitation belongs to a different Coatria account.');
      // Invitations stop granting access when the issuer loses administrator access.
      const issuer = (await client.query("SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE", [invite.company_id,invite.created_by])).rows[0];
      if (!issuer) fail(403,'The invitation issuer no longer has permission. Request a new invitation.');
      const current = (await client.query('SELECT m.role,m.access_revoked_at,(i.created_at>m.access_revoked_at) AS invitation_is_new FROM memberships m JOIN invitations i ON i.id=$3 WHERE m.company_id=$1 AND m.user_id=$2 FOR UPDATE OF m', [invite.company_id,user.id,invite.id])).rows[0];
      if (current && current.role !== 'removed') fail(409,'You already belong to this company.');
      if(current?.access_revoked_at&&!current.invitation_is_new)fail(403,'This invitation predates the end of your company access. Ask an administrator for a new invitation.','INVITATION_REVOKED');
      await client.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(company_id,user_id) DO UPDATE SET role=EXCLUDED.role,joined_at=now(),access_revoked_at=NULL',[invite.company_id,user.id,invite.role]);
      await client.query('UPDATE invitations SET used_by=$2,used_at=now() WHERE id=$1',[invite.id,user.id]);
      await recordActivity(client,{companyId:invite.company_id,userId:user.id,role:invite.role,user},'member.joined',`${user.name} joined the company.`);
      return {...(await client.query('SELECT id,name,slug,template FROM companies WHERE id=$1',[invite.company_id])).rows[0],role:invite.role};
    });
    return json({company});
  }
  if (parts[0] !== 'companies' || parts.length < 3) return null;
  const companyId = id(parts[1]), resource = parts[2];
  if (resource === 'workspace' && parts.length === 3 && method === 'GET') {
    const member = await requireMembership(request,companyId);
    const [company,rooms,members,agents,tasks,messages,presence,activity,drives,openings,applications] = await Promise.all([
      query('SELECT id,name,slug,template,layout FROM companies WHERE id=$1',[companyId]),
      query('SELECT id,name,kind,capacity FROM rooms WHERE company_id=$1 ORDER BY created_at',[companyId]),
      query(`SELECT u.id,u.id AS "userId",u.name,u.email,m.role,u.role_title AS "roleTitle",u.avatar_color AS "avatarColor",u.avatar_id AS "avatarId" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=$1 AND m.role<>'removed' ORDER BY m.joined_at`,[companyId]),
      query(`SELECT ${agentColumns} FROM agents WHERE company_id=$1 ORDER BY created_at`,[companyId]),
      query(`SELECT ${taskColumns} FROM tasks WHERE company_id=$1 ORDER BY updated_at DESC LIMIT 500`,[companyId]),
      query(`SELECT m.id,m.room_id AS "roomId",m.body,m.created_at AS "createdAt",m.user_id AS "userId",u.name AS "authorName" FROM messages m JOIN users u ON u.id=m.user_id WHERE m.company_id=$1 ORDER BY m.created_at DESC LIMIT 100`,[companyId]),
      readPresence(companyId),
      query(`SELECT a.id,a.kind,a.description,a.actor_id AS "actorId",u.name AS "actorName",a.created_at AS "createdAt" FROM activity a LEFT JOIN users u ON u.id=a.actor_id WHERE a.company_id=$1 ORDER BY a.created_at DESC LIMIT 50`,[companyId]),
      query(`SELECT ${driveColumns} FROM drives WHERE company_id=$1 ORDER BY created_at`,[companyId]),
      query(`SELECT ${openingColumns} FROM openings WHERE company_id=$1 ORDER BY created_at DESC`,[companyId]),
      member.role === 'member' ? Promise.resolve({rows:[]}) : query(`SELECT a.id,a.opening_id AS "openingId",a.user_id AS "userId",u.name AS "applicantName",u.email AS "applicantEmail",a.agent_id AS "agentId",a.message,a.status,a.created_at AS "createdAt",a.updated_at AS "updatedAt" FROM applications a JOIN users u ON u.id=a.user_id WHERE a.company_id=$1 ORDER BY a.created_at DESC LIMIT 500`,[companyId])
    ]);
    // Recheck after reads: revoked access must not return a workspace snapshot.
    const latestMember = await requireMembership(request,companyId);
    const {layout:storedLayout,...details}=company.rows[0],plan=readFloorPlan(storedLayout);
    return json({company:{...details,role:latestMember.role},rooms:rooms.rows,members:members.rows,agents:agents.rows,tasks:tasks.rows,messages:messages.rows.reverse(),presence,activity:activity.rows,drives:drives.rows,openings:openings.rows,applications:latestMember.role==='member'?[]:applications.rows,layout:plan.items,floor:plan.floor,layoutRevision:plan.revision});
  }
  if (resource === 'presence' && parts.length === 3) {
    const member = await requireMembership(request,companyId);
    if (method === 'GET') {const presence=await readPresence(companyId);await requireMembership(request,companyId);return json({presence});}
    if (method === 'POST') {
      const data=await body(request,presenceInput);
      if(data.interaction)await rateLimit(`interaction:${companyId}:${member.userId}`,8,10);
      await memberMutation(member,false,client=>writePresence(client,member,data));
      const presence=await readPresence(companyId);await requireMembership(request,companyId);return json({presence});
    }
  }
  if (resource === 'invitations' && parts.length === 3 && method === 'POST') {
    const member = await requireMembership(request,companyId,true); await rateLimit(`invite-create:${member.userId}`,30,3600);
    const data=await body(request,z.object({role:z.enum(['member','admin']).default('member'),email:email.optional()}).strict());
    const invitation=await memberMutation(member,true,client=>createInvitation(client,member,data.role,data.email||null,request));
    const {id:_id,...result}=invitation; return json(result,201);
  }
  if (resource === 'rooms' && parts.length === 3 && method === 'POST') {
    const member=await requireMembership(request,companyId,true); const data=await body(request,roomInput);
    const room=await memberMutation(member,true,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${companyId}:room-quota`]);
      if(Number((await client.query('SELECT count(*) FROM rooms WHERE company_id=$1',[companyId])).rows[0].count)>=100)fail(409,'This company has reached the 100-room limit.');
      const row=(await client.query('INSERT INTO rooms(company_id,name,kind,capacity) VALUES($1,$2,$3,$4) RETURNING id,name,kind,capacity',[companyId,data.name,data.kind,data.capacity])).rows[0];
      await recordActivity(client,member,'room.created',`${member.user.name} added ${data.name}.`); return row;
    }); return json({room},201);
  }
  if(resource==='layout'&&parts.length===3&&method==='PATCH') {
    const member=await requireMembership(request,companyId,true);const data=await body(request,layoutInput);
    const saved=await transaction(async client=>{
      // Serialize layout changes before membership, using the lifecycle lock order.
      // Starting with FOR UPDATE avoids an upgrade deadlock between two editors.
      const row=(await client.query('SELECT layout FROM companies WHERE id=$1 FOR UPDATE',[companyId])).rows[0];
      if(!row)fail(404,'Company not found.');
      member.role=await lockMembership(client,member,true);
      const current=readFloorPlan(row.layout);
      if(data.revision!==current.revision)fail(409,'The floor plan changed since you opened it. Reload the latest floor before saving your changes.','LAYOUT_CONFLICT');
      const plan:FloorPlanDocument={version:1,items:data.layout,floor:data.floor,revision:current.revision+1};
      await client.query('UPDATE companies SET layout=$2 WHERE id=$1',[companyId,JSON.stringify(plan)]);
      await releaseChangedSeats(client,companyId,plan);
      await recordActivity(client,member,'office.updated',`${member.user.name} updated the office layout.`);
      return {layout:plan.items,floor:plan.floor,layoutRevision:plan.revision};
    });return json(saved);
  }
  if(resource==='ownership'&&parts.length===3&&method==='POST') {
    const member=await requireMembership(request,companyId,true);
    const data=await body(request,z.object({userId:uuid}).strict());
    if(data.userId===member.userId)fail(400,'Choose another active member to receive ownership.');
    await transaction(async client=>{
      await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
      const rows=(await client.query('SELECT user_id,role FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR UPDATE',[companyId,[member.userId,data.userId]])).rows;
      if(rows.find(row=>row.user_id===member.userId)?.role!=='owner')fail(403,'Only the current owner can transfer ownership.');
      const target=rows.find(row=>row.user_id===data.userId);if(!target||target.role==='removed')fail(400,'The new owner must be an active company member.');
      if(target.role==='owner')fail(409,'That member already owns this company.');
      await client.query("UPDATE memberships SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'admin' END WHERE company_id=$1 AND user_id=ANY($3::uuid[])",[companyId,data.userId,[member.userId,data.userId]]);
      await recordActivity(client,member,'company.ownership_transferred',`${member.user.name} transferred company ownership to another active member.`);
    });return json({ok:true});
  }
  if((resource==='members'&&parts.length===4&&method==='PATCH')||(resource==='leave'&&parts.length===3&&method==='POST')) {
    const leaving=resource==='leave';const member=await requireMembership(request,companyId,!leaving);
    const targetId=leaving?member.userId:id(parts[3]);const data=leaving?{role:'removed' as const}:await body(request,z.object({role:z.enum(['member','admin','removed'])}).strict());
    await transaction(async client=>{
      await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
      const actorRole=await lockMembership(client,member,!leaving);
      const target=(await client.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 FOR UPDATE',[companyId,targetId])).rows[0];
      if(!target||target.role==='removed')fail(404,'Member not found.');
      if(!leaving&&targetId===member.userId&&data.role==='admin'&&actorRole==='member')fail(403,'You cannot elevate your own role.');
      if(target.role==='owner') {
        if(actorRole!=='owner')fail(403,'Only an owner can change another owner.');
        const owners=Number((await client.query("SELECT count(*) FROM memberships WHERE company_id=$1 AND role='owner'",[companyId])).rows[0].count);
        if(owners<=1)fail(409,'Transfer ownership to another active member before leaving or changing your role.');
      }
      if(!leaving&&target.role==='admin'&&actorRole!=='owner'&&targetId!==member.userId)fail(403,'Only the owner can change another administrator.');
      await client.query("UPDATE memberships SET role=$3,access_revoked_at=CASE WHEN $3='removed' THEN clock_timestamp() ELSE access_revoked_at END WHERE company_id=$1 AND user_id=$2",[companyId,targetId,data.role]);
      if(data.role==='removed') {
        await client.query('DELETE FROM presence WHERE company_id=$1 AND user_id=$2',[companyId,targetId]);
        await client.query("UPDATE agents SET status='revoked' WHERE company_id=$1 AND created_by=$2",[companyId,targetId]);
        await client.query("UPDATE drives SET status='revoked' WHERE company_id=$1 AND created_by=$2",[companyId,targetId]);
        await client.query('UPDATE tasks SET assignee_id=NULL,updated_at=now() WHERE company_id=$1 AND assignee_id=$2 AND status<>\'done\'',[companyId,targetId]);
      }
      await recordActivity(client,member,data.role==='removed'?'member.removed':'member.role_changed',`${member.user.name} ${leaving?'left the company':`changed a member’s role to ${data.role}`}.`);
    });return json({ok:true});
  }
  return null;
}
