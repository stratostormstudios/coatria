# Coatria first release API contract

All API JSON response data is camelCase. Errors: `{error: string, code?: string}` with appropriate status. Auth uses secure HttpOnly same-site cookies, passwords are server hashed with scrypt. Mutations validate Origin and use parameterized SQL. Every company resource checks current active membership server-side. Never use demo data in production.

## Identity
- GET /api/session -> `{user: User|null, companies: Company[]}`. User `{id,name,email,roleTitle,avatarColor}`; Company `{id,name,slug,template,role}`.
- POST /api/auth/signup `{name,email,password}` -> session shape, cookie.
- POST /api/auth/login `{email,password}` -> session shape, cookie.
- POST /api/auth/logout -> `{ok:true}`.
- PATCH /api/profile `{name,roleTitle,avatarColor}` -> `{user}`.
- POST /api/companies `{name,slug,template:'studio'|'blank'}` -> `{company}`. Creates owner membership, rooms and office default layout atomically. No sample coworkers.
- POST /api/invitations/join `{token}` -> `{company}`. Single-use expiring invite.
- POST /api/companies/:id/invitations `{role:'member'|'admin',email?:string}` -> `{token,url,expiresAt}`. Owner/admin only, default member, protect owner escalation. Link copied by user; never imply email was sent.

## Workspace
- GET /api/companies/:id/workspace -> `{company,rooms,members,agents,tasks,messages,presence,activity,drives,openings,applications,layout}`. Arrays empty when no entries. Messages latest 100, activity latest 50. User vault fetched separately.
- Room `{id,name,kind:'meeting'|'focus'|'lounge'|'auditorium',capacity}`.
- Member `{id,userId,name,email,role,roleTitle,avatarColor}`.
- Presence `{userId,name,avatarColor,roomId,x,z,status,updatedAt}` expires after 45 seconds.
- POST /api/companies/:id/presence `{roomId:string|null,x:number,z:number,status:'available'|'focus'|'away'}` -> `{presence}` including current users; heartbeat ~15s, client refresh ~5s visible only. Bounds -20..20.
- GET /api/companies/:id/presence -> `{presence}`.
- POST /api/companies/:id/rooms `{name,kind,capacity}` -> `{room}` admin only.
- PATCH /api/companies/:id/layout `{layout: LayoutItem[]}` -> `{layout}` admin only. LayoutItem `{id,type:'desk'|'meeting'|'focus'|'lounge'|'plant',x,y,w,h,label}` bounds numbers 0..100.
- PATCH /api/companies/:id/members/:userId `{role:'member'|'admin'|'removed'}` -> `{ok:true}` owner/admin with last-owner protection, prevents self elevation.
- POST /api/companies/:id/leave -> `{ok:true}`, protect last owner.

## Chat & work
- POST /api/companies/:id/messages `{roomId?:string|null,body:string}` -> `{message}`. Message `{id,roomId,body,createdAt,userId,authorName}` max 4000 plain text.
- GET /api/companies/:id/messages?roomId=...&after=ISO -> `{messages}`.
- POST /api/companies/:id/tasks `{title,description,assigneeId?:string|null}` -> `{task}`.
- PATCH /api/companies/:id/tasks/:taskId `{status?:'todo'|'doing'|'review'|'done',title?,description?,assigneeId?,submissionUrl?,reviewNote?}` -> `{task}`. Accepting done requires different reviewer with admin/owner role; cannot approve own work. Task `{id,title,description,status,assigneeId,createdBy,submissionUrl,reviewNote,createdAt,updatedAt}`.

## Portable skills
- GET /api/vault -> `{skills}`. Skill `{id,title,description,content,version,updatedAt}` strictly personal.
- POST /api/vault `{title,description,content}` -> `{skill}`.
- PATCH /api/vault/:id `{title,description,content}` -> `{skill}` new immutable version.
- GET /api/vault/export -> JSON download of personal skills only. No automatic copying of employer files or artifacts.

## Agents & API harness
- POST /api/companies/:id/agents `{name,harness:'hermes'|'custom'|'claude-code'|'codex',description}` -> `{agent,token}` owner/admin only. Agent `{id,name,harness,description,status,createdBy,lastSeenAt}`; token shown once, server hashes it.
- PATCH /api/companies/:id/agents/:agentId `{status:'active'|'paused'|'revoked'}` -> `{agent}` owner/admin only. Revocation blocks immediately.
- GET /api/agent/work -> `{company,agent,tasks}` Bearer scoped agent token; eligible company tasks only, excludes private vault/credentials.
- POST /api/agent/report `{taskId,summary,submissionUrl?,tokensUsed?:number}` -> `{ok:true}`, sets task review, records agent contribution, never auto-accepts.

## Infrastructure & talent
- POST /api/companies/:id/drives `{name,kind:'byo',description}` -> `{drive,token}` owner/admin only. Drive `{id,name,kind,description,status,lastSeenAt,fileCount}`. Outbound connector token only hashes persisted, company scoped.
- GET /api/connector/config -> authorized connector metadata.
- POST /api/connector/heartbeat `{files:[{path,size,modifiedAt}],status:'online'}` -> `{ok:true}` Bearer token. Metadata indexing only; private originals never silently uploaded. Explicitly describe this capability in UI.
- GET /api/companies/:id/drives/:driveId/files -> `{files}` company membership gated.
- POST /api/companies/:id/openings `{title,description,type:'human'|'agent'|'either',compensation:'paid'|'volunteer',budget?}` -> `{opening}` admin only, explicitly unpublished drafts until publish.
- PATCH /api/companies/:id/openings/:openingId `{status:'draft'|'published'|'closed'}` -> `{opening}` admin only.
- GET /api/opportunities -> `{openings}` published only with company name, excludes internal data.
- POST /api/opportunities/:id/apply `{message,agentId?:string|null}` -> `{application}` authenticated; prevent duplicates; does not grant company membership.
- PATCH /api/companies/:id/applications/:applicationId `{status:'shortlisted'|'declined'|'accepted'}` -> `{application}` admin only. Acceptance creates scoped invitation, no payment processing promises.

Root will add WebRTC signaling if service assumptions allow, plus deployment, repository, meaningful E2E and cross-tenant tests. Do not invent paid billing, managed servers, verified scores or actual harness execution; integration statuses must be backed by a heartbeat or observed action. UI polling is functional small-team transport, not a millions-of-users architecture claim.
