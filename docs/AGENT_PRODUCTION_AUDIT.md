# Agent production audit and implementation gates

**Audit date: 2026-09-11 UTC. Baseline source: `e8264a70be0564be85822f9de780986c44296c2a`.** This is a source and architecture review of the starting point for the agent-runtime work, not a claim that the proposed runtime is implemented, deployed or independently security-certified. Later changes need their own exact-source test and release evidence. No production accounts or data were changed for this review.

Coatria already provides authenticated agent conversations and contribution submission. It does not yet, at this baseline, provide a complete conversation-triggered execution service. A harness name, recent API contact, a posted answer and a completed task are four different facts; the product must present them separately.

## Candidate implementation reviewed on September 11

The working candidate now contains durable explicit invocations, 60-second fenced worker leases, current requester/sponsor checks, default-deny capability grants, credential expiry/rotation, 18 typed tools, administrative proposals and result receipts. The external worker and MCP stdio bridge share those REST boundaries. The Codex adapter is an explicit local setup with MCP-only tools by default; optional repository execution requires an operator-provisioned isolated worker. These are candidate source findings, not evidence of production deployment or Slack feature parity. The historical matrix below remains tied to the starting revision.

The worker/MCP/OpenAPI suite passed **13 local tests**, including a real stdio child process, redirect credential containment, lost claim/completion recovery, lease cancellation, Retry-After, bounded responses and separation of the lease from model-visible context. Whole-project TypeScript checking passed at this handoff. Real PostgreSQL concurrency, actual Codex execution, browser testing, deployment and operational checks belong in the release's exact-source evidence; they are not replaced by this test count.

At **2026-09-12 00:09:04 UTC**, the release coordinator also verified actual Codex → stdio MCP → durable worker → Coatria HTTP handlers against an isolated local PGlite database: workspace read, one task creation, submission to review at revision 2, two committed mutation receipts, one agent result message and lease renewal. No production data was mutated. This validates the real adapter path; PostgreSQL concurrency/CI and deployment evidence remain separate release checks. The coordinator will publish the final exact-source evidence with the release.

The independent tool review found and the candidate corrected a requester-authority gap: a member could otherwise claim another person's unassigned task through an admin-sponsored agent. Task claim/update/submission now additionally requires the requesting human to be the task creator or a current administrator; agent grants alone cannot confer that authority. Proposal approval checks current company authority, the original agent/run grants, immutable proposal contents and the expected floor revision. No additional cross-company or proposal-approval bypass was demonstrated in this bounded review.

Remaining operational gates include isolated worker provisioning, provider cost limits and cancellation/process supervision, credential lifecycle operations, real PostgreSQL/load/restore evidence and independent security testing. Tool request IDs deduplicate **the same logical operation key**. Re-running an LLM can choose different actions or new IDs, so a restarted reasoning session is not an exactly-once workflow engine. A production adapter must retain its own logical checkpoints or reconcile uncertain earlier effects. The [runtime guide](../public/downloads/AGENT_RUNTIME.md) and [public API contract](https://coatria.com/api/agent/openapi) document the implemented wire behavior.

## What Slack Code actually means

**Slack Code is an official product**, announced on August 20, 2026. Its code channels put people, an agent, project context and artifacts in a shared work session. The announcement describes code diffs, previews, steering and review alongside conversation. This is the relevant product direction for Coatria, rather than simply adding a bot that replies to messages. [Slack announcement](https://slack.com/blog/news/slack-code-channels-for-agents).

The current help page describes temporary code channels, working/idle/needs-attention states, stopping an agent response, and artifact inspection. It says rollout is gradual and currently lists approved agents; general code-channel API availability should not be assumed. An integration can also require its own paid provider account. [Slack Code help](https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code).

**Claude Code in Slack** is a specific integration: a coding request can start a Claude Code web session. It is not another name for Slack Code and does not establish that selecting “Claude Code” in Coatria launches anything. Coatria should expose the external adapter actually configured by its operator. [Anthropic integration documentation](https://code.claude.com/docs/en/slack).

## Baseline capability matrix

“Missing” below means missing at the reviewed starting revision. A subsequent implementation must replace these entries with verified evidence, not just a feature label.

| Area | Existing source behavior | Required for the requested usable-agent experience |
|---|---|---|
| Agent identity | Owner/admin creates a company-bound identity, one-time opaque token, harness label, pause/revoke controls and API-contact timestamp | Distinguish registered, worker online, executing, waiting for review and disconnected; test a real external worker |
| Conversation participation | Default-deny `none/read/write`; company commons and all room conversations; explicit agent authorship | Explicit invocation picker bound to an agent UUID, rather than ambiguous name matching or automatic execution of every mention |
| Message reliability | Stable send UUIDs, transactional event cursor, history/thread pagination, revisions and tombstones | Preserve source-message/run links and invocation deduplication independently of message deduplication |
| Starting work | External adapter can fetch up to 100 eligible unassigned tasks | Persist a requested run with requester, company, agent, source context and permission boundary |
| Execution ownership | No claim, execution lease or worker fencing | Atomic claim, expiring lease, heartbeat, worker-loss recovery and rejection of stale workers |
| Status and cancellation | Token pause/revoke ends subsequent API authority; no execution state machine | Persist queued/running/needs-attention/result/failed/cancelled states; cancellation request and worker acknowledgment must be distinguishable |
| Tool access | Agent-specific task work/report plus conversations; human routes require human sessions | Typed, allowlisted tools with current role/grant/run checks on every call; no universal admin proxy |
| Tasks and contribution review | Reports move eligible work to review; independent administrator accepts; prior authors/sponsors cannot approve their own work | Idempotent run completion, linked evidence, safe uncertainty recovery and visible review decisions |
| Workspace, people and rooms | Human workspace APIs exist | Agent projections expose only permitted company fields; grant-specific room/member access, avoiding private credentials and unnecessary account data |
| Spatial presence | Human presence and distinct agent visuals exist | Agent can operate only its own clearly identified bot; no human impersonation, microphone activation or screen capture |
| Infrastructure | Connector indexes relative filenames, size and time; it does not provide original bytes | Any file tool must disclose metadata-only behavior. Private footage download, NAS mutation and signed transfer remain separate work |
| Office layouts | Admin editor uses validated, revision-protected floor documents | Agent proposes a reviewable layout; administrator explicitly applies against the current layout revision |
| Hiring | Human-managed openings/applications; no payment processing | Read/draft tools can be scoped; publishing, acceptance and membership creation require the existing human authority boundary |
| Skills and memory | Personal vault is separate from company work and inaccessible to the company agent API | Keep private employee skills in the employee's harness; explicit separate consent is required before exposing skill content |
| Artifacts | Text results and submission URLs; no execution sandbox or rich artifact service | Typed bounded artifacts, revision/hash provenance and safe display. Untrusted HTML must not execute in the application's origin |
| MCP and provider support | REST conversation SDK and one-shot work/report adapter; no MCP/runtime implementation | A real MCP adapter and local worker contract; provider adapters run outside the website with explicit configuration |
| Accounting | Token counts are self-reported; recent contact is not a job-health signal | Per-run limits, measured usage where available, failure/stall alerts and costs labeled by measurement source |

Reviewed implementation anchors: [integration routes](../src/lib/integrations.ts), [conversation routes](../src/lib/conversation-api.ts), [conversation service](../src/lib/conversations.ts), [task authority](../src/lib/work.ts), [token/security primitives](../src/lib/security.ts), [schema](../database/001_initial.sql), [conversation migration](../database/007_conversations.sql), [connection guide](CONNECTIONS.md), and [release evidence](RELEASE_STATUS.md).

## Architecture decision: external execution, durable Coatria control

Coatria should own authorization, invocation state, tool policy, result records and review. The employee or company runs the harness on its approved infrastructure. Vercel requests remain bounded HTTP operations against durable PostgreSQL state; they do not become arbitrary long-running code-execution jobs. The web browser does not receive model-provider keys, repository credentials, database credentials or a general shell executor.

The external worker imports a deliberately configured local adapter. The adapter can use Hermes, a coding CLI, a provider SDK or an approved internal service. Importing this adapter executes trusted local code; downloading a configuration or selecting a harness label must never silently spawn a command. The operator chooses its directory, network policy and secret environment. A Coatria lease can prevent further Coatria calls after revocation; it cannot erase data already downloaded or forcibly stop an uncooperative external process.

Company outputs and audit references stay with the company. Private skill implementation, personal credentials and portable employee memory remain outside the company's default API surface. A run must record who requested it and under which company's authority it acted, even if the same employee later joins another company.

## Required conversation-to-result protocol

1. **Request:** the user deliberately selects an agent and submits a prompt. Persist a stable client request UUID, canonical payload hash, source conversation/message reference, requester, target agent and company in one transaction. Retrying returns the same run; different content under the same key conflicts. Conversation text and quoted files are data, not permission grants.
2. **Authorize:** calculate the intersection of the agent's configured grant, the requester's current role/resource authority, and any explicit run approval. An ordinary member must not obtain administrative powers by invoking an owner-sponsored agent. Save the decision inputs, but recheck live authority on claim, heartbeat, tool call and final result.
3. **Claim:** one worker obtains a bounded lease. An expired claim can be recovered with an incremented fencing generation. A stale worker cannot renew or commit results after another worker takes over. Stable claim IDs distinguish a lost claim response from a request for a second run.
4. **Execute:** fetch only the authorized run context. Persist each tool request ID and canonical arguments before applying an effect. Same ID/same arguments replays a known outcome; changed arguments conflict. Use short database transactions and the established company → membership → agent → run/resource lock order. Never hold a database lock while calling a model or external service.
5. **Review sensitive actions:** bind approval to the exact proposed resource, operation, arguments, version and expiry. Editing a proposal invalidates the old approval. Layout changes use the existing revision check. Hiring acceptance, role changes, external publication and paid actions do not become ordinary agent writes merely because the harness asks.
6. **Finish:** atomically persist the result, artifact references and run event, then show it in its conversation. Completion and failure retries need stable request IDs and readable terminal state. Submission for review is different from acceptance. A contribution's author/sponsor exclusion survives retries and later edits.
7. **Recover:** a worker restart reloads its durable claim, run and pending operation keys. Timeouts are uncertain outcomes, not proof that an effect did not happen. Internal database effects can be transactional; arbitrary external effects need upstream idempotency or explicit reconciliation. Do not promise exactly-once external execution.

A proposed run should expose timestamps, state, current lease expiry, requesting human, executing agent, linked task, tool outcomes, limits, cancellation status and review status. Show concise progress and evidence, not hidden model reasoning. “Worker has not responded” is more accurate than “working” after lease expiry.

## Credentials, MCP and tool boundaries

At the baseline, `ca_` tokens contained 32 random bytes and were stored as hashes. They are revocable opaque credentials, **not digitally signed credentials** or OAuth grants. Their lack of a signature is not by itself a vulnerability. The baseline lacked expiry/rotation and a resource-specific execution grant; the candidate adds expiry/rotation and an online, run-bound lease. That lease uses a keyed proof with live server verification, not a self-contained JWT or OAuth grant. Keep bootstrap credentials out of browser state, logs, URLs, prompts and generated artifacts.

For signed run authorization, use a server-issued, short-lived envelope with a pinned algorithm/key ID, issuer, intended audience, company/agent/run IDs, expiry, unique ID and lease generation. Validate its signature and live grant/lease state; a valid signature alone must not override revocation. An alternative online opaque lease can enforce the same server-side authority, but must not be described as signed. Rotate signing keys deliberately and test wrong audience, old generations, expiry and replay. A future webhook additionally needs signature validation over the raw body, timestamp tolerance and durable delivery-ID deduplication; the initial outbound-poll worker does not require a public webhook endpoint.

A local **stdio MCP bridge** is the smallest useful integration: discover only authorized Coatria tools, bind to an explicit run/lease, validate arguments and translate calls through the same server executor as REST. Keep diagnostics on stderr and protocol frames on stdout. No arbitrary URL-fetch or shell tool is exposed by default. MCP annotations and model-generated arguments are not authorization decisions; tools still need input validation and visible action policy. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

A later publicly hosted HTTP MCP server needs the actual authorization protocol: OAuth metadata/discovery, PKCE, intended-resource/audience validation and scoped grants. Do not market a bearer-only JSON endpoint as a complete OAuth-enabled MCP service. Never forward Coatria tokens to a third-party MCP server or accept an unrelated provider token as Coatria authority. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

Third-party tool descriptions, messages, files and returned links are untrusted. An instruction embedded in them cannot expand a grant or reveal secrets. Provider/MCP discovery and artifact URL fetching introduce SSRF risk: enforce approved destinations, validate redirects and DNS resolution, and block metadata/private networks unless an explicitly configured local connector owns that access. Do not auto-install an MCP server from conversation content. [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices).

MCP's task extension is experimental in the pinned 2025-11-25 specification. Coatria should keep its durable invocation model independent of that optional wire feature and bind all task/run lookup and cancellation to authenticated authority, never possession of an ID alone. [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks).

## Production risks and required evidence

No new exploitable cross-tenant bypass was demonstrated by this bounded source review. The following are confirmed baseline limitations or explicit risks introduced by the planned execution surface. Severity describes impact if the gate is omitted, not evidence of exploitation.

| Gate | Risk and release requirement | Evidence required |
|---|---|---|
| P0 — delegated authority | An admin-sponsored agent could become a confused deputy for an ordinary member | Tests for member invoking admin tools, cross-company IDs, sponsor/requester removal while queued, reduced scopes after claim, and legacy endpoint bypass |
| P0 — worker ownership | Duplicate workers or expired leases can apply conflicting work | Real PostgreSQL concurrent claims; response lost after claim; lease expiry/reclaim; old worker completion/heartbeat/tool calls rejected; graceful restart |
| P0 — effect and result deduplication | A timed-out tool/report can be repeated or falsely called unsuccessful | Crash before/after transaction commit and after upstream acceptance; same-key replay; altered payload conflict; explicit external reconciliation |
| P0 — secret/execution separation | A provider key, local command or private skill could enter the browser or shared output | Browser/network/log scans with synthetic canaries; adapter has only selected environment and tools; no shell interpretation of server text |
| P0 — consent and artifacts | A prompt or artifact could trigger administrative writes or active-content execution | Scope checks and hash/version-bound approvals; unauthorized publication fails; unsafe URLs/HTML rejected or isolated; output-size limits |
| P1 — credential lifecycle | Baseline agent token has no expiry and grants company-wide chat visibility | Expiry/rotation/revocation tests, migration defaults deny new scopes, narrow context views and auditable grant changes |
| P1 — truthful status/cancellation | A stale heartbeat looks productive; cancel hides a still-running external process | Visible lease/stall state; signal reaches cooperative adapter; cancellation is distinguished from confirmed stop; no post-cancel server effect |
| P1 — resource abuse | One worker can consume API/model cost or occupy a run indefinitely | Limits on run duration, queue/concurrency, tool calls, bytes, retries and provider spend; backoff/Retry-After; load and alert-delivery evidence |
| P1 — human review integrity | Agent/sponsor accepts its own outcome or edited evidence inherits old acceptance | Existing author-history tests extended through run-created tasks, approval invalidation, and immutable accepted results |
| Commercial operation | Source tests cannot prove restore, isolation at infrastructure level or provider reliability | Real-adapter end-to-end proof, restore drill, incident ownership, measured capacity/cost, independent adversarial review and provider-specific restrictions |

The existing [security review](SECURITY_REVIEW.md) separately records open identity, provider-key rotation, historical privileged-deployment and repository-protection gates. This audit did not re-inspect those live controls and must not silently mark them closed. Tenant isolation is still application-enforced; the runtime database role is not a per-company RLS boundary. The conversation release's isolated 50-session load result is useful baseline evidence, not proof that model execution or an agent tool workload supports that capacity.

## Release acceptance checklist

- One explicit conversation request creates one durable run; an actual independently running worker claims it, calls an authorized tool and returns a visible result without the browser staying open.
- The same flow works through ordinary HTTP and the supplied MCP bridge; unsupported provider configuration fails clearly instead of posting a pretend successful result.
- A member cannot cause admin-only effects through an agent. A paused/revoked agent, removed requester/sponsor, stale lease and foreign company/run/resource ID all fail before an effect.
- Restarting the worker or losing a response preserves the original run/claim/completion IDs. Replaying the same logical tool key cannot repeat its internal effect; altered content conflicts. Adapter checkpoints must prevent a newly reasoned plan from accidentally issuing new IDs for old work. External uncertainty requires reconciliation.
- Cancellation, timeout, reconnect, stale completion, permission downgrade and unavailable tools have tested UI and API outcomes. A stopped run cannot silently return to running.
- Company task acceptance is still an independent human decision. Private skill content, original NAS bytes and model/provider credentials stay outside default tool context.
- Exact commit, migration/grant checks, actual PostgreSQL concurrency results, local real-worker/MCP results, browser accessibility checks and sanitized deployment evidence are recorded separately before calling the implementation production-ready.

The first release should use a small explicit tool set and external adapters. Adding a tool is an authorization and audit change, not merely adding a name to the model prompt. Broader managed execution, private channels, original-file transfer, automated payments and enterprise guarantees remain separately scoped releases.
