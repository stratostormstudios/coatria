import { z } from 'zod';
import { query, transaction } from './db';
import { requireMembership } from './auth';
import { bearer, body, fail, hashToken, id, json, rateLimit, secret, uuid } from './security';
import { memberMutation, recordActivity } from './company';
import { agentColumns, driveColumns, text } from './model';
import {AGENT_CAPABILITIES} from './agent-policy';
const capabilityInput=z.array(z.enum(AGENT_CAPABILITIES)).max(AGENT_CAPABILITIES.length).refine(values=>new Set(values).size===values.length,'Capabilities must be unique.');

type AuthenticatedAgent={id:string;company_id:string;created_by:string;token_hash:string}&Record<string,any>;
export async function authenticateAgent(request: Request):Promise<AuthenticatedAgent> {
  const token=bearer(request);if(!token.startsWith('ca_'))fail(401,'Invalid agent token.');
  const agent=(await query<AuthenticatedAgent>(`SELECT a.* FROM agents a JOIN memberships m ON m.company_id=a.company_id AND m.user_id=a.created_by WHERE a.token_hash=$1 AND a.status='active' AND a.expires_at>clock_timestamp() AND m.role IN ('owner','admin')`,[hashToken(token)])).rows[0];
  if(!agent)fail(401,'This agent token is invalid, paused, revoked, or its sponsor lost access.');
  await rateLimit(`agent:${agent.id}`,120,60);
  // Contact metadata is updated before any authority locks, never by upgrading
  // a conversation reader's FOR SHARE lock. Chat-only harnesses appear active too.
  await query(`UPDATE agents a SET last_seen_at=clock_timestamp() WHERE a.id=$1 AND a.company_id=$2 AND a.token_hash=$3 AND a.status='active' AND a.expires_at>clock_timestamp() AND (a.last_seen_at IS NULL OR a.last_seen_at<now()-interval '60 seconds') AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=a.company_id AND m.user_id=a.created_by AND m.role IN ('owner','admin'))`,[agent.id,agent.company_id,agent.token_hash]);
  return agent;
}
async function authenticateConnector(request: Request) {
  const token=bearer(request);if(!token.startsWith('cd_'))fail(401,'Invalid connector token.');
  const drive=(await query(`SELECT d.* FROM drives d JOIN memberships m ON m.company_id=d.company_id AND m.user_id=d.created_by WHERE d.token_hash=$1 AND d.status<>'revoked' AND m.role IN ('owner','admin')`,[hashToken(token)])).rows[0];
  if(!drive)fail(401,'This connector token is invalid, revoked, or its sponsor lost access.');
  await rateLimit(`connector:${drive.id}`,20,60);return drive;
}
export async function integrationRoute(request: Request, parts: string[], method: string): Promise<Response|null> {
  const path=parts.join('/');
  if(path==='agent/work'&&method==='GET'||path==='agent/report'&&method==='POST'){await authenticateAgent(request);fail(410,'Use an authorized agent run and its live lease through /api/agent/runs and /api/agent/tools.','AGENT_RUN_REQUIRED');}
  if(path==='connector/config'&&method==='GET') {
    const drive=await authenticateConnector(request);
    return json({drive:{id:drive.id,name:drive.name,companyId:drive.company_id,kind:'byo'},mode:'metadata-only',heartbeatSeconds:30,maxFiles:10000,originalsUploaded:false});
  }
  if(path==='connector/heartbeat'&&method==='POST') {
    const drive=await authenticateConnector(request);
    const safePath=z.string().min(1).max(1024).refine(value=>!value.startsWith('/')&&!value.startsWith('\\')&&!/^[a-zA-Z]:/.test(value)&&!value.split(/[\\/]/).includes('..')&&!/[\x00-\x1f]/.test(value),'Use a relative path without parent traversal.');
    const data=await body(request,z.object({files:z.array(z.object({path:safePath,size:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),modifiedAt:z.iso.datetime({offset:true})}).strict()).max(10000).refine(files=>new Set(files.map(f=>f.path)).size===files.length,'File paths must be unique.'),status:z.literal('online')}).strict(),3*1024*1024);
    await transaction(async client=>{
      if(!(await client.query('SELECT id FROM companies WHERE id=$1 FOR KEY SHARE',[drive.company_id])).rowCount)fail(401,'Connector company access ended.');
      const sponsor=(await client.query("SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",[drive.company_id,drive.created_by])).rows[0];if(!sponsor)fail(401,'Connector sponsor access ended.');
      const active=(await client.query("SELECT id FROM drives WHERE id=$1 AND status<>'revoked' FOR UPDATE",[drive.id])).rows[0];if(!active)fail(401,'Connector access ended.');
      await client.query('DELETE FROM drive_files WHERE drive_id=$1',[drive.id]);
      if(data.files.length)await client.query(`INSERT INTO drive_files(drive_id,path,size,modified_at) SELECT $1,f.path,f.size,f."modifiedAt"::timestamptz FROM jsonb_to_recordset($2::jsonb) AS f(path text,size bigint,"modifiedAt" text)`,[drive.id,JSON.stringify(data.files)]);
      await client.query("UPDATE drives SET status='online',last_seen_at=now(),file_count=$2 WHERE id=$1",[drive.id,data.files.length]);
    });return json({ok:true});
  }
  if(parts[0]!=='companies'||parts.length<3)return null;const companyId=id(parts[1]);
  if(parts[2]==='agents') {
    const member=await requireMembership(request,companyId,true);
    if(parts.length===3&&method==='POST') {
      await rateLimit(`agent-create:${member.userId}`,20,3600);
      const data=await body(request,z.object({name:text(80),harness:z.enum(['hermes','custom','claude-code','codex']),description:z.string().trim().max(4000).default(''),conversationAccess:z.enum(['none','read','write']).default('none'),invocationAccess:z.enum(['none','members','admins']).default('none'),capabilities:capabilityInput.default([]),expiresInDays:z.number().int().min(1).max(365).default(90)}).strict());const token=secret('ca_');
      const agent=await memberMutation(member,true,async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${companyId}:agent-quota`]);if(Number((await client.query("SELECT count(*) FROM agents WHERE company_id=$1 AND status<>'revoked'",[companyId])).rows[0].count)>=100)fail(409,'This company has reached the limit of 100 active or paused agents.');
        const row=(await client.query(`INSERT INTO agents(company_id,name,harness,description,token_hash,created_by,conversation_access,invocation_access,capabilities,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$10*interval '1 day') RETURNING ${agentColumns}`,[companyId,data.name,data.harness,data.description,hashToken(token),member.userId,data.conversationAccess,data.invocationAccess,JSON.stringify(data.capabilities),data.expiresInDays])).rows[0];await recordActivity(client,member,'agent.created',`${member.user.name} registered ${data.name} with explicit conversation and invocation grants.`);return row;
      });return json({agent,token},201);
    }
    if(parts.length===4&&method==='PATCH') {
      const agentId=id(parts[3]);const data=await body(request,z.object({status:z.enum(['active','paused','revoked']).optional(),conversationAccess:z.enum(['none','read','write']).optional(),invocationAccess:z.enum(['none','members','admins']).optional(),capabilities:capabilityInput.optional()}).strict().refine(value=>Object.keys(value).length>0,'Provide an access change.'));
      const agent=await memberMutation(member,true,async client=>{
        const current=(await client.query('SELECT * FROM agents WHERE id=$1 AND company_id=$2 FOR UPDATE',[agentId,companyId])).rows[0];if(!current)fail(404,'Agent not found.');if(current.status==='revoked'&&(data.status!=='revoked'||Object.keys(data).length>1))fail(409,'Revoked credentials cannot be reactivated. Register a new agent.');
        const row=(await client.query(`UPDATE agents SET status=$3,conversation_access=$4,invocation_access=$5,capabilities=$6 WHERE id=$1 AND company_id=$2 RETURNING ${agentColumns}`,[agentId,companyId,data.status??current.status,data.conversationAccess??current.conversation_access,data.invocationAccess??current.invocation_access,JSON.stringify(data.capabilities??current.capabilities)])).rows[0];
        await client.query("UPDATE agent_runs r SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error='Agent invocation authority changed.' WHERE r.company_id=$1 AND r.agent_id=$2 AND r.status IN ('queued','running') AND ($3<>'active' OR $4='none' OR ($4='admins' AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=r.company_id AND m.user_id=r.requested_by AND m.role IN ('owner','admin'))))",[companyId,agentId,row.status,row.invocationAccess]);
        await recordActivity(client,member,'agent.access_changed',`${member.user.name} updated ${row.name}'s agent access.`);return row;
      });return json({agent});
    }
    if(parts.length===5&&parts[4]==='rotate'&&method==='POST'){
      const agentId=id(parts[3]),data=await body(request,z.object({expiresInDays:z.number().int().min(1).max(365).default(90)}).strict()),token=secret('ca_');
      const agent=await memberMutation(member,true,async client=>{const current=(await client.query('SELECT status FROM agents WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,agentId])).rows[0];if(!current)fail(404,'Agent not found.');if(current.status==='revoked')fail(409,'Register a new agent instead of rotating a revoked credential.');const row=(await client.query(`UPDATE agents SET token_hash=$3,expires_at=clock_timestamp()+$4*interval '1 day' WHERE company_id=$1 AND id=$2 RETURNING ${agentColumns}`,[companyId,agentId,hashToken(token),data.expiresInDays])).rows[0];await client.query("UPDATE agent_runs SET status='cancelled',worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error='Agent credential rotated.' WHERE company_id=$1 AND agent_id=$2 AND status IN ('queued','running')",[companyId,agentId]);await recordActivity(client,member,'agent.credential_rotated',`${member.user.name} rotated ${row.name}'s credential.`);return row;});return json({agent,token});
    }
  }
  if(parts[2]==='drives') {
    if(parts.length===3&&method==='POST') {
      const member=await requireMembership(request,companyId,true);await rateLimit(`drive-create:${member.userId}`,10,3600);
      const data=await body(request,z.object({name:text(100),kind:z.literal('byo'),description:z.string().trim().max(4000).default('')}).strict());const token=secret('cd_');
      const drive=await memberMutation(member,true,async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${companyId}:drive-quota`]);if(Number((await client.query("SELECT count(*) FROM drives WHERE company_id=$1 AND status<>'revoked'",[companyId])).rows[0].count)>=20)fail(409,'This company has reached the limit of 20 connectors.');
        const row=(await client.query(`INSERT INTO drives(company_id,name,description,token_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING ${driveColumns}`,[companyId,data.name,data.description,hashToken(token),member.userId])).rows[0];await recordActivity(client,member,'drive.created',`${member.user.name} registered ${data.name} for metadata indexing.`);return row;
      });return json({drive,token},201);
    }
    if(parts.length===5&&parts[4]==='files'&&method==='GET') {
      await requireMembership(request,companyId);const driveId=id(parts[3]);if(!(await query('SELECT id FROM drives WHERE id=$1 AND company_id=$2',[driveId,companyId])).rowCount)fail(404,'Drive not found.');
      return json({files:(await query('SELECT path,size::float8 AS size,modified_at AS "modifiedAt" FROM drive_files WHERE drive_id=$1 ORDER BY path LIMIT 10000',[driveId])).rows});
    }
    // Administrators can permanently revoke a lost connector credential.
    if(parts.length===4&&method==='PATCH') {
      const member=await requireMembership(request,companyId,true);const driveId=id(parts[3]);await body(request,z.object({status:z.literal('revoked')}).strict());
      const drive=await memberMutation(member,true,async client=>{
        const row=(await client.query(`UPDATE drives SET status='revoked' WHERE id=$1 AND company_id=$2 RETURNING ${driveColumns}`,[driveId,companyId])).rows[0];if(!row)fail(404,'Drive not found.');await recordActivity(client,member,'drive.revoked',`${member.user.name} revoked ${row.name}.`);return row;
      });return json({drive});
    }
  }
  return null;
}
