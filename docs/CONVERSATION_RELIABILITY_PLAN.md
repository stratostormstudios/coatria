# Conversation reliability plan

Research and source audit: **2026-09-11**. This is an implementation and acceptance plan, not a claim of Slack parity or a production service-level agreement. The baseline below describes the source inspected before this reliability work; completed work must be recorded separately with its commit, migrations, test results and deployment evidence.

**Implementation status:** the durable protocol, history/replay, scoped agent API, threads, own-message revisions/deletion, reactions and personal read markers were deployed on 2026-09-11 from `13e2cfd892ded023bef17020afd861e48ad1e9b0`, with migration 007. [Release evidence](RELEASE_STATUS.md) records the exact deployment, 147 passing application tests and the passing 50-session controlled load run. P2 realtime/operational work and the larger staging capacity target below remain unverified. The finalized wire contract is the [published API guide](https://coatria.com/downloads/CONVERSATIONS.md) and [OpenAPI schema](https://coatria.com/api/conversations/openapi); proposed field names in this design document are not a competing API contract.

## Decision

Keep Vercel for the application and authenticated HTTP API, with Neon PostgreSQL as the authoritative message store. First deliver durable writes, safe retries, complete history and replayable events shared by people and external agents. Add managed realtime delivery after those guarantees are tested. Every supported conversation action must remain available through a documented API without an open browser, a running avatar or a proprietary harness.

Slack separates API request processing from realtime distribution. Its published architecture uses regional WebSocket gateways and channel servers; presence is a separate service. Those architectural ideas are useful, but Slack's reported scale and latency are evidence about Slack, not Coatria. A similar chat interface does not establish equivalent infrastructure. [Slack engineering: Real-time Messaging](https://slack.engineering/real-time-messaging/)

## Baseline and priorities

| Area | Inspected Coatria behavior | Required improvement |
| --- | --- | --- |
| Persistence and acknowledgement | PostgreSQL insert commits before HTTP success; human writes recheck membership in a transaction. | Preserve this boundary. Add a stable client operation ID and a durable deduplication receipt. |
| Recovery | No server idempotency key. An uncertain network result followed by another POST can duplicate a committed message. | **P0:** same operation and payload return the same result; a reused key with different content fails explicitly. |
| History | Workspace snapshots contain the newest 100 messages across the company. The message endpoint supports room filtering and `after=ISO`, but no older-page cursor or `hasMore`. | **P0:** conversation-specific, stable keyset pagination and a separate event replay feed. Busy rooms must not erase another room's accessible history. |
| Ordering | Queries sort by `created_at` only; `after` uses a strict timestamp comparison. | **P0:** deterministic history ordering and a commit-safe event cursor. Equal timestamps and delayed commits must not lose messages. |
| Delivery | Visible clients refresh the full workspace every five seconds. Polls are single-flight and back off; there is no durable conversation event log. | **P0:** lightweight cursor polling with replay. **P2:** managed fanout and reconnect recovery using the same cursor. |
| Agent API | Company-scoped bearer tokens fetch eligible tasks and submit contributions. Tokens are paused/revoked with sponsor checks; messages currently require a human session. | **P0:** explicit conversation read/write grants and visible agent authorship. Existing tokens gain no new access automatically. |
| Conversation state | Drafts, pending sends and read positions survive dock/full transitions in memory and reset on account/company changes. | Preserve this UX. Add delivery/reconnect states; do not describe in-memory drafts as saved across browser restarts. |
| Collaboration | Plain text only; no message revisions, threads, reactions or durable personal read markers. All current room conversations are company-visible. | **P1:** add these as versioned, API-accessible operations. Private channels/DMs require their own membership model. |
| Operations | Application-enforced tenant isolation and a restricted database runtime role; fixed-window write limits. No conversation-specific latency or replay SLO verified. | **P0:** migration/grant checks, fault tests and useful metrics. **P2:** capacity, recovery and regional failover evidence. |

Source scope: `database/001_initial.sql`, `database/runtime-permissions.sql`, `src/lib/{work,company,integrations,auth,security,db,polling}.ts`, `src/app/page.tsx`, `src/components/Conversations.tsx`, and `docs/{API_CONTRACT,CONNECTIONS}.md`. No production database or credentials were inspected for this plan.

## P0: durable protocol and external access

### One mutation service, two authenticated actor types

Browser sessions and scoped agent tokens must call the same validation, authorization and mutation service. Derive `companyId`, actor type and author identity from verified credentials; never trust submitted author fields. Preserve cookie-origin checks for browser mutations and bearer authentication for external harnesses. Do not expose browser cookies or database access to agents.

Represent the author as a human or an agent, with a stable ID, display name and explicit bot label. Preserve history if an agent is revoked. The selected first-release permission is `agents.conversation_access = none | read | write`: `none` is the default, `read` permits company-visible conversation access, and `write` adds posting. Administrators must explicitly approve this company-wide visibility; an individual-room allowlist is a later extension, not an implied restriction. Future edits, reactions and moderation need separate policy decisions. Recheck agent status, sponsor authority and grants on every request and inside writes; avoid a long-lived authorization cache. Private employee vaults stay excluded.

Slack's history API combines token scopes with conversation access; bot access is tied to the conversations the bot belongs to. Its publishing API has a separate write scope. Coatria should use the same principle of explicit authority, without copying Slack's particular scope vocabulary or rate limits as a compatibility promise. [Slack history API](https://docs.slack.dev/reference/methods/conversations.history/), [Slack publishing API](https://docs.slack.dev/reference/methods/chat.postMessage/)

### Durable write and event transaction

The following names describe a proposed contract; the final wire format belongs in `API_CONTRACT.md` and a versioned schema.

1. Validate a bounded `clientMessageId`/idempotency key, conversation, body and optional thread parent. Resolve legacy `roomId:null` to an unambiguous Company commons key on the server.
2. In one transaction, lock/recheck authority, check the actor-scoped deduplication receipt, lock the conversation row, allocate its next event sequence, write the message and append its event. Commit before returning success.
3. Return the canonical message ID, version, server timestamp, event cursor and whether the request was a replay. An exact replay makes no second message or event. Reusing a key for a different payload returns a stable conflict code. Document deduplication retention; deletion must not allow an old retry to recreate the message.
4. Keep database state authoritative. A delivery provider outage cannot undo an accepted message. Later publishers use the committed event/outbox record and retry safely.

**A plain `BIGSERIAL` does not guarantee commit order.** Transaction A can reserve 101, transaction B commit 102, and a consumer advance beyond A before A commits. The selected design locks a conversation row before updating its transactional counter and holds that lock through commit for every event writer. Ordering and cursors are per conversation; a client must track each subscribed conversation separately. Different conversations can progress independently. Measure contention in a very busy conversation before partitioning further. PostgreSQL sequences are not rolled back with ordinary transaction changes. The delayed-commit consequence and row-lock design are Coatria reasoning. [PostgreSQL sequence semantics](https://www.postgresql.org/docs/18/functions-sequence.html)

### History and replay

| Operation | Proposed behavior |
| --- | --- |
| Bootstrap/history | Return one conversation's messages, an older-page cursor and `hasMore`. Order by an immutable unique key or `(createdAt,id)`. Bound page sizes and use an index beginning with company/conversation. |
| Catch-up events | For a selected conversation, return the **oldest unseen** authorized events in ascending order, `nextCursor`, `hasMore` and its server watermark. A backlog larger than one page must be drained, never skipped in favor of its newest page. |
| Snapshot boundary | Obtain history and its event boundary in the same database snapshot, or capture the cursor first and replay overlaps. Reading history and then a newer cursor can miss an intervening commit. |
| Client application | Merge by message ID and version; deduplicate event IDs. Older responses cannot overwrite a newer edit, resurrect a tombstone or cross an account/company generation. |
| Expired cursor | Return an explicit resync requirement with a supported bootstrap path. Never silently return an incomplete history. |

The selected first protocol uses validated per-conversation sequence strings in JSON, preserving PostgreSQL bigint precision. Store each cursor under its user/company/conversation key; a numeric cursor cannot identify its originating conversation by itself. A cursor is not authorization: the route must independently authorize its selected company/conversation before every page and event batch. If grants expand, bootstrap newly visible conversations rather than assuming an old restricted cursor contains their history. Keep event payloads minimal; reference authorized current projections where practical so deleted text is not indefinitely duplicated in delivery logs.

All current events are retained and replayed in pages of at most 100; a large backlog alone must not force a reset or silently skip events. Event records hydrate the current authorized message projection, so replay does not promise archived copies of every historical body revision. If retention is introduced later, an expired cursor must explicitly require resynchronization. External agents rebuilding state must page through the history and threads they need; loading only the newest 50 messages cannot repair cached old-message edits or deletions.

Slack exposes cursor pagination for conversation history and threaded replies. Coatria needs explicit pagination completeness independent of any push transport. [Slack history](https://docs.slack.dev/reference/methods/conversations.history/), [Slack replies pagination](https://docs.slack.dev/reference/methods/conversations.replies/)

### Retries, rate limits and client state

Use at-least-once retries with deduplicated database effects, not an “exactly once delivery” claim. Keep a pending operation's key stable after a timeout; reconcile or retry that operation before declaring it failed. Show `Sending`, `Sent`, `Retry needed` and `Reconnecting` accurately. A transport timeout can mean the commit succeeded. If a browser-restart outbox is added, isolate it by user/company, expire it, clear it on logout and revalidate access before replay; never silently submit it under another account.

Legacy clients that omit a client operation ID cannot gain safe automatic retry merely because the server generates an ID for them. Keep migration compatibility explicit and require client-supplied IDs in the supported external API.

Return machine-readable errors and `Retry-After` for 429 responses. Limit actors, conversations and company aggregate traffic separately; respect retry hints, use jitter and cap concurrent catch-up requests. Routine chat updates should not refetch every task, drive, application and floor object. Published Slack limits vary by method and app distribution; use the pattern of explicit budgets rather than importing their numeric values. [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)

## P1: everyday collaboration, available through the API

| Capability | Data and authority required before release |
| --- | --- |
| Threads | Stable root/parent IDs constrained to the same company/conversation, paginated replies and bounded nesting. Agent replies are supported by the same service. |
| Edits/deletion | Own-message policy plus an explicit moderation rule; optimistic version checks; edited indicator and deletion tombstone events. Define retention and audit access before retaining deleted bodies. |
| Reactions | Unique actor/message/reaction keys and idempotent add/remove operations; aggregate counts do not imply approval of an agent task. |
| Read markers | Durable per-user/per-conversation last-read position, coalesced monotonic updates and cross-device sync. Send a rendered message position, not every event watermark, to avoid a loop caused by read-marker events themselves. Return personal read payloads only to that actor; a bot must never mark messages read for its sponsor. |
| Mentions/search/attachments | Permission-filtered search and notifications. Uploads require separate storage, bounded signed access and retention; chat text must not implicitly publish BYO footage or vault content. |

Slack documents author-limited message updates, reaction operations and durable read cursors. These are concrete API and data-model capabilities, not visual additions. [Slack message modification](https://docs.slack.dev/messaging/modifying-messages), [Slack reactions](https://docs.slack.dev/reference/methods/reactions.add/), [Slack read markers](https://docs.slack.dev/reference/methods/conversations.mark/)

## P2: realtime distribution and operational scale

As checked on 2026-09-11, **Vercel Functions support WebSockets in beta**, including an experimental Next.js upgrade API. Connections are pinned to one instance, close at the function's maximum duration and can reconnect to another instance or deployment. Shared state and pub/sub must therefore live outside the Function. The older blanket statement that Vercel cannot host WebSockets is no longer an accurate design premise. Treat beta adoption as a deliberate production decision. [Vercel WebSockets](https://vercel.com/docs/functions/websockets)

Keep the durable HTTP protocol usable while evaluating either a managed realtime provider or Vercel WebSockets plus an external broker. Subscription capabilities must be short-lived, company/conversation-scoped and revocable. Treat pushed events as a latency improvement: clients always recover through durable cursors. A relational transaction plus an outbox avoids the gap between committing a message and publishing it. Publishers must retry, deduplicate and expose delivery lag. Never depend on unawaited in-process work after a request returns.

Neon's pooler uses transaction-mode PgBouncer and does not support `LISTEN` on pooled connections. Do not turn one pooled PostgreSQL connection per browser into a notification service. A dedicated listener, if later chosen, needs an appropriate direct connection and durable recovery; notifications themselves are not the replay log. [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)

For external push subscriptions, sign events, use stable event IDs, acknowledge receipt before expensive agent work, retry with backoff and expose failed-delivery inspection/replay. Slack's Events API explicitly retries failed deliveries, illustrating why consumers must tolerate duplicates. Outbound agent event delivery remains optional; polling the durable authenticated API is always supported. [Slack Events API](https://docs.slack.dev/apis/events-api/)

Vercel duration, concurrency, file-descriptor and payload limits remain relevant even with sockets. Record the actual plan/runtime configuration before testing; published maxima are not evidence that Coatria can operate at those levels. Keep Functions close to the database; broker regions do not turn a single database writer into a multi-region database. [Vercel Function limits](https://vercel.com/docs/functions/limitations)

## Release acceptance criteria

These are proposed release gates, not results already achieved.

| Gate | Required evidence |
| --- | --- |
| Durable acknowledgement | Kill or disconnect the client after commit but before the HTTP response. Retrying the same operation returns one canonical message and one event. Injected failure before commit leaves neither. |
| Concurrent deduplication | At least 20 concurrent identical requests produce one message/event. A different body or conversation with the same scoped key fails predictably; different actors' keys remain isolated. |
| Commit-order safety | Hold writer A open while writer B runs. A consumer must never advance past an event that can later commit invisibly. Test on real PostgreSQL, including rollback, not solely a database emulator. |
| Complete catch-up | Replay at least 1,001 events across pages of at most 100, including equal timestamps, edits and deletes. A large backlog must not reset or skip retained events. Every permitted event appears once after client deduplication. If retention is later introduced, separately prove explicit expiry and complete projection reconstruction. |
| History stability | Load older messages while new messages arrive. No duplicates or missing older rows; another busy conversation cannot remove accessible history. |
| Authorization | Cross-company/conversation resource IDs, malformed or ahead-of-stream cursors, wrong authors, `none` grants, writes with `read` grants, paused/revoked tokens and removed sponsors fail. Race revocation against reads/writes; no request beginning after revocation succeeds. |
| Agent compatibility | A standalone HTTP client with only its scoped bearer token can discover authorized conversations, paginate, catch up and send/retry. No browser session, private vault access or human impersonation. |
| Client recovery | Offline/reconnect, out-of-order responses, duplicate events, company/account changes and dock/full transitions preserve appropriate state without duplicate posting or stale content leakage. A visible reconnect state clears only after successful catch-up. |
| Rate budgets | 429 includes usable retry timing; human and bot bursts remain bounded. Slow polling and retries do not overlap or create a retry storm. |
| Migration and grants | Existing history survives migration; runtime-role tests cover all new tables/counters. Owner-only migrations remain separate. Mixed old/new deployment behavior is documented and tested. |
| Initial capacity target | In staging, run a 30-minute test with 200 concurrent clients across at least four companies, 50 simultaneous viewers of one conversation and 10 aggregate writes/second. Proposed targets: warm-region write p95 under 1s and active catch-up p95 under 3s, with zero acknowledged-message loss and bounded DB connections. Publish actual hardware, region, cold-start behavior, cost and measured results; tune the supported envelope from evidence. |
| Operations | Record request IDs, commit/catch-up latency, replay lag, dedup hits, conflicts, 429s and pool saturation without message bodies/tokens. Exercise alert delivery, restore into a separate database and cursor resynchronization. Define an RPO/RTO and prove it before promising one. |

Large-company hot streams, global latency, managed fanout failover, multi-region recovery, enterprise retention, verified identity and independent security testing remain additional work. A successful bounded release gate supports a measured initial operating envelope; it does not establish Slack-equivalent reliability or readiness for millions of users.
