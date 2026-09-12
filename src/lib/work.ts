import { z } from 'zod';
import { query } from './db';
import { requireMembership } from './auth';
import { body, fail, id, json, rateLimit } from './security';
import { existingAssignee, memberMutation, recordActivity } from './company';
import { taskColumns, taskInput, taskPatch } from './model';
import { legacyConversationSend } from './conversation-api';

export function canApproveTask(task: {status:string;created_by:string;assignee_id?:string|null;submitted_by?:string|null;agent_sponsor?:string|null;author_ids?:string[]}, userId: string, role: string) {
  return ['owner','admin'].includes(role) && task.status === 'review' && ![task.assignee_id,task.submitted_by,task.agent_sponsor,...(task.author_ids||[])].includes(userId);
}
export async function workRoute(request: Request, parts: string[], method: string): Promise<Response | null> {
  if(parts[0]!=='companies'||parts.length<3)return null;
  const companyId=id(parts[1]);
  if(parts[2]==='messages'&&parts.length===3) {
    const member=await requireMembership(request,companyId);
    if(method==='GET') {
      const url=new URL(request.url);const room=url.searchParams.get('roomId');const after=url.searchParams.get('after');
      if(room&&room!=='null')id(room);
      if(after&&!z.iso.datetime({offset:true}).safeParse(after).success)fail(400,'after must be an ISO timestamp.');
      if(room&&room!=='null'&&!(await query('SELECT id FROM rooms WHERE id=$1 AND company_id=$2',[room,companyId])).rowCount)fail(404,'Room not found.');
      const values:unknown[]=[companyId];let filter='';
      if(room){values.push(room==='null'?null:room);filter+=` AND m.room_id IS NOT DISTINCT FROM $${values.length}::uuid`;}
      if(after){values.push(after);filter+=` AND m.created_at>$${values.length}::timestamptz`;}
      const messages=(await query(`SELECT m.id,m.room_id AS "roomId",m.body,m.created_at AS "createdAt",m.user_id AS "userId",m.agent_id AS "agentId",m.deleted_at AS "deletedAt",COALESCE(u.name,a.name,'Former teammate') AS "authorName" FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agents a ON a.id=m.agent_id AND a.company_id=m.company_id WHERE m.company_id=$1${filter} ORDER BY m.created_at DESC,m.id DESC LIMIT 100`,values)).rows.reverse();
      return json({messages});
    }
    if(method==='POST') {
      return legacyConversationSend(request,companyId);
    }
  }
  if(parts[2]==='tasks') {
    const member=await requireMembership(request,companyId);
    if(parts.length===3&&method==='POST') {
      await rateLimit(`tasks-create:${member.userId}`,100,3600);const data=await body(request,taskInput);
      const task=await memberMutation(member,false,async client=>{
        await existingAssignee(client,companyId,data.assigneeId);
        const row=(await client.query(`INSERT INTO tasks(company_id,title,description,assignee_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING ${taskColumns}`,[companyId,data.title,data.description,data.assigneeId||null,member.userId])).rows[0];
        await recordActivity(client,member,'task.created',`${member.user.name} created “${data.title}”.`);return row;
      });return json({task},201);
    }
    if(parts.length===4&&method==='PATCH') {
      const taskId=id(parts[3]);const data=await body(request,taskPatch);
      const task=await memberMutation(member,false,async client=>{
        const current=(await client.query('SELECT t.*,a.created_by AS agent_sponsor FROM tasks t LEFT JOIN agents a ON a.id=t.submitted_agent_id WHERE t.id=$1 AND t.company_id=$2 FOR UPDATE OF t',[taskId,companyId])).rows[0];
        if(!current)fail(404,'Task not found.');
        current.author_ids=(await client.query('SELECT user_id FROM task_authors WHERE task_id=$1 UNION SELECT a.created_by AS user_id FROM contributions c JOIN agents a ON a.id=c.agent_id WHERE c.task_id=$1',[taskId])).rows.map(row=>row.user_id);
        const admin=['owner','admin'].includes(member.role);const worker=current.assignee_id===member.userId||current.created_by===member.userId;
        if(!admin&&!worker)fail(403,'Only the task creator, assignee, or an administrator can change this task.');
        if(current.status==='done')fail(409,'Accepted contributions are immutable. Create a follow-up task for further work.');
        if(data.assigneeId!==undefined) {
          if(data.assigneeId!==current.assignee_id&&!admin&&current.created_by!==member.userId)fail(403,'Only the task creator or an administrator can reassign work.');
          await existingAssignee(client,companyId,data.assigneeId);
        }
        const next=data.status||current.status;
        if(next==='done') {
          if(!canApproveTask(current,member.userId,member.role))fail(403,'Acceptance requires a different administrator who did not perform or sponsor this work. Submit the task for review first.');
          if(Object.keys(data).some(key=>!['status','reviewNote'].includes(key)))fail(400,'Review acceptance cannot change the submitted work.');
        }
        if(data.reviewNote!==undefined&&data.reviewNote!==current.review_note&&!admin)fail(403,'Only an administrator can leave the review decision.');
        const isSubmission=next==='review'&&current.status!=='review';
        if(isSubmission&&!worker&&!admin)fail(403,'Only the task worker can submit a contribution.');
        if(current.status==='review'&&next==='review'&&((data.title!==undefined&&data.title!==current.title)||(data.description!==undefined&&data.description!==current.description)||(data.submissionUrl!==undefined&&data.submissionUrl!==current.submission_url)||(data.assigneeId!==undefined&&data.assigneeId!==current.assignee_id)))fail(409,'Move the task back to doing before changing a submitted contribution.');
        if(isSubmission||(data.submissionUrl!==undefined&&data.submissionUrl!==current.submission_url))await client.query('INSERT INTO task_authors(task_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[taskId,member.userId]);
        const row=(await client.query(`UPDATE tasks SET title=$3,description=$4,status=$5,assignee_id=$6,submission_url=$7,review_note=$8,
          submitted_by=$9,submitted_agent_id=$10,approved_by=$11,submission_summary=$12,agent_run_id=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING ${taskColumns}`,
          [taskId,companyId,data.title??current.title,data.description??current.description,next,data.assigneeId===undefined?current.assignee_id:data.assigneeId,data.submissionUrl===undefined?current.submission_url:data.submissionUrl,data.reviewNote??current.review_note,
          isSubmission?member.userId:current.submitted_by,isSubmission?null:current.submitted_agent_id,next==='done'?member.userId:null,isSubmission?'':current.submission_summary])).rows[0];
        await recordActivity(client,member,next==='done'?'task.accepted':isSubmission?'task.submitted':'task.updated',`${member.user.name} ${next==='done'?'accepted':isSubmission?'submitted':'updated'} “${row.title}”.`);return row;
      });return json({task});
    }
  }
  return null;
}
