import { z } from 'zod';
import { query, transaction } from './db';
import { requireMembership, requireUser } from './auth';
import { body, fail, id, json, rateLimit, uuid } from './security';
import { createInvitation, memberMutation, recordActivity } from './company';
import { openingColumns, text } from './model';

const applicationColumns=`id,opening_id AS "openingId",company_id AS "companyId",user_id AS "userId",agent_id AS "agentId",message,status,created_at AS "createdAt",updated_at AS "updatedAt"`;
export async function talentRoute(request:Request,parts:string[],method:string):Promise<Response|null> {
  if(parts.join('/')==='opportunities'&&method==='GET')return json({openings:(await query(`SELECT o.id,o.company_id AS "companyId",c.name AS "companyName",o.title,o.description,o.type,o.compensation,o.budget,o.status,o.created_at AS "createdAt" FROM openings o JOIN companies c ON c.id=o.company_id WHERE o.status='published' ORDER BY o.created_at DESC LIMIT 200`)).rows});
  if(parts[0]==='opportunities'&&parts.length===3&&parts[2]==='apply'&&method==='POST') {
    const user=await requireUser(request);const openingId=id(parts[1]);await rateLimit(`application:${user.id}`,30,3600);
    const data=await body(request,z.object({message:text(6000),agentId:uuid.nullable().optional()}).strict());
    const application=await transaction(async client=>{
      const opening=(await client.query("SELECT * FROM openings WHERE id=$1 AND status='published' FOR SHARE",[openingId])).rows[0];if(!opening)fail(404,'This opening is not accepting applications.');
      if(data.agentId) {
        const agent=(await client.query("SELECT id FROM agents WHERE id=$1 AND created_by=$2 AND status='active'",[data.agentId,user.id])).rows[0];if(!agent)fail(403,'You can only apply with an active agent you sponsor.');
        if(opening.type==='human')fail(400,'This opening accepts human applicants only.');
      } else if(opening.type==='agent')fail(400,'Select an agent for this opening.');
      return (await client.query(`INSERT INTO applications(opening_id,company_id,user_id,agent_id,message) VALUES($1,$2,$3,$4,$5) RETURNING ${applicationColumns}`,[openingId,opening.company_id,user.id,data.agentId||null,data.message])).rows[0];
    });return json({application},201);
  }
  // Applicants see their own application status, never another person's application.
  if(parts.join('/')==='applications'&&method==='GET') {
    const user=await requireUser(request);
    return json({applications:(await query(`SELECT a.id,a.opening_id AS "openingId",o.title AS "openingTitle",c.name AS "companyName",a.agent_id AS "agentId",a.message,a.status,a.created_at AS "createdAt" FROM applications a JOIN openings o ON o.id=a.opening_id JOIN companies c ON c.id=a.company_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 200`,[user.id])).rows});
  }
  if(parts[0]!=='companies'||parts.length<3)return null;const companyId=id(parts[1]);
  if(parts[2]==='openings') {
    const member=await requireMembership(request,companyId,true);
    if(parts.length===3&&method==='POST') {
      await rateLimit(`opening-create:${member.userId}`,20,3600);
      const data=await body(request,z.object({title:text(160),description:text(12000),type:z.enum(['human','agent','either']),compensation:z.enum(['paid','volunteer']),budget:z.string().trim().max(160).optional()}).strict());
      const opening=await memberMutation(member,true,async client=>{
        const row=(await client.query(`INSERT INTO openings(company_id,title,description,type,compensation,budget,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${openingColumns}`,[companyId,data.title,data.description,data.type,data.compensation,data.budget||'',member.userId])).rows[0];
        await recordActivity(client,member,'opening.created',`${member.user.name} drafted “${data.title}”.`);return row;
      });return json({opening},201);
    }
    if(parts.length===4&&method==='PATCH') {
      const openingId=id(parts[3]);const data=await body(request,z.object({status:z.enum(['draft','published','closed'])}).strict());
      const opening=await memberMutation(member,true,async client=>{
        const row=(await client.query(`UPDATE openings SET status=$3 WHERE id=$1 AND company_id=$2 RETURNING ${openingColumns}`,[openingId,companyId,data.status])).rows[0];if(!row)fail(404,'Opening not found.');
        await recordActivity(client,member,'opening.status_changed',`${member.user.name} set “${row.title}” to ${data.status}.`);return row;
      });return json({opening});
    }
  }
  if(parts[2]==='applications'&&parts.length===4&&method==='PATCH') {
    const member=await requireMembership(request,companyId,true);const applicationId=id(parts[3]);const data=await body(request,z.object({status:z.enum(['shortlisted','declined','accepted'])}).strict());
    const result=await memberMutation(member,true,async client=>{
      const current=(await client.query('SELECT a.*,u.email,u.name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.id=$1 AND a.company_id=$2 FOR UPDATE OF a',[applicationId,companyId])).rows[0];if(!current)fail(404,'Application not found.');
      if(current.status==='accepted')fail(409,'This application was already accepted. Its invitation was shown once; create a new member invitation if needed.');
      if(current.user_id===member.userId&&data.status==='accepted')fail(403,'You cannot accept your own application.');
      const invitation=data.status==='accepted'?await createInvitation(client,member,'member',current.email,request):null;
      const application=(await client.query(`UPDATE applications SET status=$3,invitation_id=$4,updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING ${applicationColumns}`,[applicationId,companyId,data.status,invitation?.id||null])).rows[0];
      await recordActivity(client,member,'application.reviewed',`${member.user.name} ${data.status} an application.`);
      return {application,...(invitation?{invitation:{token:invitation.token,url:invitation.url,expiresAt:invitation.expiresAt}}:{})};
    });return json(result);
  }
  return null;
}
