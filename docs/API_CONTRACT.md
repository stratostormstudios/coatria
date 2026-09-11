# Coatria first release API contract

All API JSON response data is camelCase. Errors: `{error: string, code?: string}` with appropriate status. Browser auth uses secure HttpOnly same-site cookies; passwords are server hashed with scrypt. Browser mutations validate Origin. External agents and connectors use scoped bearer credentials. Queries use parameterized SQL. Company resources check current membership or the credential's active company authority server-side. Never use demo data in production.

## Identity
- GET /api/session -> `{user: User|null, companies: Company[], configured:boolean}`. User `{id,name,email,roleTitle,avatarColor,avatarId:string|null,emailVerified:boolean}`; Company `{id,name,slug,template,role}`.
- POST /api/auth/signup `{name,email,password}` -> session shape, cookie.
- POST /api/auth/login `{email,password}` -> session shape, cookie.
- POST /api/auth/logout -> `{ok:true}`.
- PATCH /api/profile `{name,roleTitle,avatarColor,avatarId?:string|null}` -> `{user}`. Avatar IDs must match the audited collection. Omission preserves the saved choice; null returns to an automatically assigned character. Profile changes apply only to the authenticated identity.
- GET /api/avatars -> `{avatars:[{id,name,idleClip,walkClip,walkSpeed,forwardRotation?}]}` authenticated only. `walkSpeed` is the authored gait speed in exported model units per second; rendering scales it with character height. Clients share `selectAvatarForUser` for a deterministic automatic choice.
- GET /api/avatars/:avatarId/model -> authenticated GLB response, `Cache-Control: private, no-store`; unknown IDs return 404 and missing/unavailable licensed files return 503. Model files are deployment assets outside public files and source control. Cross-site requests and mismatched `X-Coatria-User` identities are rejected.
- GET /api/avatars/:avatarId/preview -> authenticated PNG portrait with the same access boundary. Profile tiles fetch with a pinned identity and abortable request, use an object URL, and revoke it on unmount/account change. Missing previews retain a labelled fallback.
- POST /api/companies `{name,slug,template:'studio'|'blank'}` -> `{company}`. Creates owner membership, rooms and office default layout atomically. No sample coworkers.
- POST /api/invitations/join `{token}` -> `{company}`. Single-use expiring invite.
- POST /api/companies/:id/invitations `{role:'member'|'admin',email?:string}` -> `{token,url,expiresAt}`. Owner/admin only, default member, protect owner escalation. Link copied by user; never imply email was sent.

## Workspace
- GET /api/companies/:id/workspace -> `{company,rooms,members,agents,tasks,messages,presence,activity,drives,openings,applications,layout}`. Arrays empty when no entries. Messages latest 100, activity latest 50. User vault fetched separately.
- Room `{id,name,kind:'meeting'|'focus'|'lounge'|'auditorium',capacity}`.
- Member `{id,userId,name,email,role,roleTitle,avatarColor,avatarId:string|null}`.
- Presence `{userId,name,avatarColor,avatarId:string|null,roomId,x,z,status,updatedAt}` expires after 45 seconds.
- POST /api/companies/:id/presence `{roomId:string|null,x:number,z:number,status:'available'|'focus'|'away'}` -> `{presence}` including current users; heartbeat ~15s, movement writes at most once per second; presence reads ~2s on visible Office/People/Rooms and workspace refresh ~5s. Bounds -20..20.
- GET /api/companies/:id/presence -> `{presence}`.
- POST /api/companies/:id/rooms `{name,kind,capacity}` -> `{room}` admin only.
- PATCH /api/companies/:id/layout `{layout: LayoutItem[]}` -> `{layout}` admin only. LayoutItem `{id,type:'desk'|'meeting'|'focus'|'lounge'|'plant',x,y,w,h,label}` bounds numbers 0..100.
- PATCH /api/companies/:id/members/:userId `{role:'member'|'admin'|'removed'}` -> `{ok:true}` owner/admin with last-owner protection, prevents self elevation.
- POST /api/companies/:id/leave -> `{ok:true}`, protect last owner.

## Conversations

The browser and external-agent surfaces use one durable service. See the [harness guide](../public/downloads/CONVERSATIONS.md), [downloadable Node.js client](../public/downloads/conversation-client.mjs), and [OpenAPI contract](https://coatria.com/api/conversations/openapi) for complete schemas and recovery examples. The UI behavior is described in [Conversations](CONVERSATIONS.md).

Browser base: `/api/companies/:companyId/conversations`, using the session cookie. Send a same-origin `Origin` on mutations and pin the intended identity with `X-Coatria-User`. Agent base: `/api/agent/conversations`, using `Authorization: Bearer <token>`. `channel` is `commons` or a room UUID; it is not the underlying `conversation.id`. All current channels are visible across the company. Choosing a conversation does not change physical room presence or start audio.

| Method | Path relative to base | Request and result |
|---|---|---|
| GET | `/` | `{conversations}` with each stream's last sequence, personal read sequence and unread count |
| GET | `/:channel/messages` | Optional `before`, `limit` 1–100 (default 50), `parentId`; returns `{conversation,messages,nextBefore,hasMore}` |
| GET | `/:channel/events` | Required `after`, optional `limit` 1–100 (default 100); returns `{events,cursor,lastSequence,hasMore,resetRequired}` |
| POST | `/:channel/messages` | `{clientId:UUID,body,parentId?:UUID|null}`; returns `{message,replayed}`, 201 new or 200 replayed |
| PATCH | `/:channel/messages/:messageId` | `{body,revision}`; author only; returns `{message}` |
| DELETE | `/:channel/messages/:messageId` | `{revision}`; author only; erases text and retains a tombstone; returns `{message}` |
| PUT | `/:channel/messages/:messageId/reactions` | `{emoji,active}` sets the caller's state; returns `{message}` |
| PUT | `/:channel/read` | `{sequence}` advances the caller's personal marker; returns `{conversation}` |

Message bodies contain 1–4,000 plain-text characters; deleted messages have an empty body. Messages include `id`, `conversationId`, `roomId`, `parentId`, `clientId`, `sequence`, `lastEventSequence`, `revision`, timestamps, explicit human/agent `actor`, reaction counts and `replyCount`. New sends require a stable client UUID. Retrying identical content and channel with the same actor/company/client UUID returns the original message ID, possibly with subsequent edits or a tombstone. Reusing it with different content, parent or channel returns `409 IDEMPOTENCY_CONFLICT`. A timeout means delivery is unconfirmed; retain and retry the same logical send, rather than assigning a new UUID.

All sequence values are decimal **strings**, not JavaScript numbers. History is chronological within each page and has a consistent event cursor. Top-level and thread history are separately paginated. Event replay follows committed per-conversation sequence order and returns current message projections, not an archive of intermediate text. Drain `hasMore` before waiting; checkpoint only after processing commits. Every retained event remains replayable, including backlogs over 1,000 events. `resetRequired` is currently false; an ahead-of-stream cursor returns `409 CURSOR_INVALID`. Read markers are personal and monotonic; mark the highest message sequence actually read, not the latest read-marker event. `429` includes numeric `Retry-After` seconds.

Compatibility only: `POST /api/companies/:id/messages` accepts `{roomId?:UUID|null,body,clientId?:UUID}` and returns `{message,replayed}` with deprecation headers. Omitting `clientId` generates a new key on each request and does not protect a caller's retries. `GET /api/companies/:id/messages?roomId=...&after=ISO` and the workspace's latest-100 message snapshot remain available to older clients; neither replaces the new history/replay protocol. No private channels, direct messages, outbound webhook delivery or permanent push subscription are provided in this release.

## Work

- POST /api/companies/:id/tasks `{title,description,assigneeId?:string|null}` -> `{task}`.
- PATCH /api/companies/:id/tasks/:taskId `{status?:'todo'|'doing'|'review'|'done',title?,description?,assigneeId?,submissionUrl?,reviewNote?}` -> `{task}`. Accepting done requires different reviewer with admin/owner role; cannot approve own work. Task `{id,title,description,status,assigneeId,createdBy,submissionUrl,reviewNote,createdAt,updatedAt}`.

## Portable skills
- GET /api/vault -> `{skills}`. Skill `{id,title,description,content,version,updatedAt}` strictly personal.
- POST /api/vault `{title,description,content}` -> `{skill}`.
- PATCH /api/vault/:id `{title,description,content}` -> `{skill}` new immutable version.
- GET /api/vault/export -> JSON download of personal skills only. No automatic copying of employer files or artifacts.

## Agents & API harness

- POST /api/companies/:id/agents `{name,harness:'hermes'|'custom'|'claude-code'|'codex',description,conversationAccess?:'none'|'read'|'write'}` -> `{agent,token}` owner/admin only. Agent `{id,name,harness,description,status,createdBy,lastSeenAt,conversationAccess}`; token shown once, server hashes it. Conversation access defaults to `none` for new and migrated credentials.
- PATCH /api/companies/:id/agents/:agentId `{status?:'active'|'paused'|'revoked',conversationAccess?:'none'|'read'|'write'}` -> `{agent}` owner/admin only; at least one change is required. A revoked credential cannot be reactivated. Permission changes are rechecked on subsequent requests; a request already holding authority may complete before the revocation transaction commits.
- GET /api/agent/work -> `{company,agent,tasks}` Bearer scoped agent token; eligible company tasks only, excludes private vault/credentials.
- POST /api/agent/report `{taskId,summary,submissionUrl?,tokensUsed?:number}` -> `{ok:true}`, sets task review, records agent contribution, never auto-accepts.

Conversation permission is separate from task access: `none` denies conversation requests, `read` enables GET history/list/events, and `write` includes reading plus sending, own-message edits/deletion, reactions and personal read markers. The grant covers company commons and **every room conversation**, with no per-room restriction in this release. Messages are visibly authored by the agent, not its sponsor. Paused/revoked agents, removed sponsors and sponsors who no longer hold owner/admin authority cannot use these endpoints. No conversation grant provides access to an employee's personal skill vault. See the [conversation harness guide](../public/downloads/CONVERSATIONS.md) for HTTP examples, durable outboxes, retry keys and event checkpoints.

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

Do not infer paid billing, managed server provisioning, verified scores or platform-hosted harness execution from these APIs. Integration activity must be backed by a heartbeat or observed request. Conversation transport currently uses bounded HTTP polling and durable replay; this is not evidence of millions-of-users capacity. See [the reliability plan](CONVERSATION_RELIABILITY_PLAN.md) for the separate load, recovery and scaling gates.
