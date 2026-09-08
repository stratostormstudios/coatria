import { z } from 'zod';
import { uuid } from './security';

export const text = (max: number) => z.string().trim().min(1).max(max);
export const email = z.string().trim().toLowerCase().email().max(254);
export const signupInput = z.object({ name: text(80), email, password: z.string().min(12).max(256) }).strict();
export const loginInput = z.object({ email, password: z.string().min(1).max(256) }).strict();
export const roomInput = z.object({ name: text(80), kind: z.enum(['meeting','focus','lounge','auditorium']), capacity: z.number().int().min(1).max(500) }).strict();
export const layoutItem = z.object({ id: text(80), type: z.enum(['desk','meeting','focus','lounge','plant']), x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().min(0.1).max(100), h: z.number().min(0.1).max(100), label: text(80) }).strict().refine(v => v.x + v.w <= 100 && v.y + v.h <= 100, 'Furniture must fit inside the floor.');
export const layoutInput = z.object({ layout: z.array(layoutItem).max(100).refine(items => new Set(items.map(x => x.id)).size === items.length, 'Furniture IDs must be unique.') }).strict();
export const presenceInput = z.object({ roomId: uuid.nullable(), x: z.number().min(-20).max(20), z: z.number().min(-20).max(20), status: z.enum(['available','focus','away']) }).strict();
export const submissionUrl = z.string().url().max(2048).refine(url => { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }, 'Use an HTTP or HTTPS link without credentials.');
export const taskInput = z.object({ title: text(160), description: z.string().trim().max(12000).default(''), assigneeId: uuid.nullable().optional() }).strict();
export const taskPatch = z.object({ status: z.enum(['todo','doing','review','done']).optional(), title: text(160).optional(), description: z.string().trim().max(12000).optional(), assigneeId: uuid.nullable().optional(), submissionUrl: submissionUrl.nullable().optional(), reviewNote: z.string().trim().max(4000).optional() }).strict().refine(v => Object.keys(v).length > 0, 'Provide at least one change.');
export const skillInput = z.object({ title: text(160), description: z.string().trim().max(4000).default(''), content: z.string().min(1).max(50000) }).strict();
export const STUDIO_LAYOUT = [
  {id:'studio-desk-1',type:'desk',x:17,y:28,w:14,h:13,label:'Desk 01'},
  {id:'studio-desk-2',type:'desk',x:37,y:28,w:14,h:13,label:'Desk 02'},
  {id:'studio-desk-3',type:'desk',x:17,y:49,w:14,h:13,label:'Desk 03'},
  {id:'studio-desk-4',type:'desk',x:37,y:49,w:14,h:13,label:'Desk 04'},
  {id:'studio-meeting',type:'meeting',x:63,y:10,w:29,h:31,label:'Meeting room'},
  {id:'studio-focus',type:'focus',x:64,y:47,w:27,h:22,label:'Focus room'},
  {id:'studio-lounge',type:'lounge',x:14,y:74,w:37,h:18,label:'Lounge'},
  {id:'studio-plant',type:'plant',x:57,y:77,w:7,h:9,label:'Green corner'}
];
export const taskColumns = `id,title,description,status,assignee_id AS "assigneeId",created_by AS "createdBy",submission_url AS "submissionUrl",submission_summary AS "submissionSummary",review_note AS "reviewNote",submitted_by AS "submittedBy",submitted_agent_id AS "submittedAgentId",approved_by AS "approvedBy",created_at AS "createdAt",updated_at AS "updatedAt",(SELECT COALESCE(array_agg(DISTINCT author.user_id),'{}'::uuid[]) FROM (SELECT user_id FROM task_authors WHERE task_id=tasks.id UNION SELECT a.created_by AS user_id FROM contributions c JOIN agents a ON a.id=c.agent_id WHERE c.task_id=tasks.id) author) AS "authorIds"`;
export const agentColumns = `id,name,harness,description,status,created_by AS "createdBy",last_seen_at AS "lastSeenAt"`;
export const driveColumns = `id,name,kind,description,CASE WHEN status='online' AND last_seen_at<now()-interval '90 seconds' THEN 'offline' ELSE status END AS status,last_seen_at AS "lastSeenAt",file_count AS "fileCount"`;
export const openingColumns = `id,company_id AS "companyId",title,description,type,compensation,budget,status,created_at AS "createdAt"`;
export const skillColumns = `id,title,description,content,version,updated_at AS "updatedAt"`;
