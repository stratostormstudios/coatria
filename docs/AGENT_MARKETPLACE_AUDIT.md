# Agent marketplace and bounded autonomy audit

Reviewed 2026-09-16 (local time). This document records implementation and isolated test evidence before release. It does not claim that migrations have been applied, that a production worker is connected, or that production deployment has passed its checks. See `RELEASE_STATUS.md` for the final deployment record.

## Implemented boundary

The catalog contains curated, versioned integration metadata. Installing a plugin creates a scoped Coatria agent. Provider API keys, endpoints, account credentials, and arbitrary plugin code are not accepted by the installation API. Provider credentials stay on the operator's worker. The catalog being available or a worker having contacted Coatria does not prove provider authentication or a successful model response.

Migration `010_plugin_installations.sql` adds installations and the immutable `agent_runs.purpose` discriminator. Migration `011_agent_missions.sql` adds bounded missions and their cycle-to-run history. `database/runtime-permissions.sql` explicitly grants runtime CRUD on the three new tables; health checks require both migration records. The new runtime requires these migrations before deployment promotion.

Installation creation and mutation require a current owner or administrator. All reads and writes are company scoped. Installation creation uses a caller UUID and a normalized payload digest; retries return the existing installation without returning its credential again. The raw Coatria agent credential is returned once and only its hash is persisted. Rotation requires the current revision, cancels pending work, resets contact evidence, and cannot resurrect a revoked installation.

Default installation grants are no invocation and no tools. Ordinary conversation access is always `none` for a marketplace agent. Administrators explicitly select invocation access, capability grants, public provider/model identifiers, execution limits, and a company character. Unknown JSON fields—including provider secrets—are rejected. Managed agents cannot bypass installation revisions and policy through the older agent PATCH or rotation endpoints.

An installation edit takes the agent lock, updates its revision, and cancels all queued/running work atomically. Existing lease checks prevent a worker from continuing with stale configuration. Leased context includes the current pinned installation configuration and role/persona. Persona and objectives never expand server-enforced permissions.

Connection checks are ordinary durable runs with `purpose=connection_test`, an empty capability snapshot, and no conversation history. These restrictions are server enforced: the fixed prompt is not the security boundary. Public callers cannot set the purpose field. A connection-test request remains queued until a worker executes it; only an actual result proves the model responded.

## Bounded company missions

An administrator creates a mission for a specific agent. Creation defaults to paused. Starting or resuming explicitly approves its objective, cadence, and finite lifetime cycle budget. Manual runs and scheduled cycles use the same budget, requester, and durable run path.

A worker may tick only its own missions using its scoped agent credential. There is no global scheduler credential or unauthenticated cron endpoint. The worker queues due work and the existing leased execution pipeline performs it. Another administrator triggering a manual cycle does not replace its original requester: the mission author must remain an administrator throughout execution.

Company, membership, agent, mission, and run locks serialize policy changes with dispatch and execution. The live mission-author requirement is checked for context, heartbeat, tools, completion, claim replay, and queued claim selection—even when an agent permits ordinary member requests. Revoked, paused, expired, or unsponsored agents cannot dispatch.

Each mission has at most one pending cycle. Missed intervals do not generate catch-up runs. The next scheduled time advances from actual dispatch. Pending missions are excluded from due selection so they cannot starve other due missions. Concurrent ticks serialize on the agent and consume a cycle once.

A mission execution failure or expired lease becomes terminal on its first attempt, preventing automatic repetition of uncertain effects. A subsequent worker tick pauses the mission for administrator review. Explicit resume acknowledges the prior run before another cycle can begin. Editing a mission cancels its pending work and leaves it paused unless the administrator explicitly resumes it in the same request. Finishing the approved cycle budget stops dispatch. Existing ordinary conversation-run retry behavior is unchanged.

Administrative proposals, independent task approval, private skill-vault boundaries, and the existing tool allowlist remain in force. Missions do not add agent creation, payments, external publishing, arbitrary shell execution, or permission-management tools.

## Limits

| Boundary | Enforced limit |
| --- | --- |
| Active or paused agents | 100 per company, shared with ordinary agents |
| Pending durable requests | 100 per agent |
| Unfinished missions | 20 per agent |
| Cadence | 15–1,440 minutes |
| Lifetime cycles | 1–100; explicit administrator changes required to increase a budget |
| Missions examined per worker tick | 1–5 |
| Mission objective | 3,000 characters |
| Configured agent role/persona | 80 / 1,600 characters |
| Configured model steps | 1–20 |
| Configured output / total tokens | 256–8,192 / 2,000–100,000 |
| Configured provider timeout | 30–600 seconds |

Model request limits constrain the worker's supported adapter. They are not a provider billing guarantee or evidence that an arbitrary external harness obeys local budgets. Production operators should configure provider spending limits and isolated worker hosts.

## Verification

The targeted isolated database suite ran `plugin-marketplace`, `agent-missions`, `agent-runs`, `agent-tools`, and `backend-integration`: **43 passed, 0 failed, 2 intentional real-PostgreSQL concurrency skips** under PGlite. The integration fixture exercised 107 real database API responses. Type checking passed.

Regression coverage includes tenant and role boundaries; exact manifest validation; rejected provider-secret fields; one-time credentials; retry conflicts; stale revisions; rotation and terminal revocation; server-restricted connection checks; exact leased character/configuration; bounded cycle exhaustion; no catch-up dispatch; first-failure and lost-lease stop behavior; current mission-author authority; and cancellation fences. Real PostgreSQL CI adds competing installation revisions, competing scheduler ticks, and restricted runtime-role checks. These CI outcomes must be recorded in the release evidence rather than inferred from emulator results.

This audit covers application behavior and reviewable code. It does not establish independent penetration testing, disaster recovery, provider service reliability, always-on worker operations, billing reconciliation, or worldwide production capacity.

## Deployment and rollback

1. Apply migrations 010 and 011 with the database owner, record their migration names, and grant CRUD on `plugin_installations`, `agent_missions`, and `agent_mission_cycles` to the restricted runtime role. Keep schema/role/verification privileges denied.
2. Verify the candidate deployment, required migration health, authentication boundaries, assets, and exact-source real PostgreSQL CI before promoting it.
3. Start workers with operator-managed credentials and the reviewed adapters. A web deployment does not host a persistent model worker. Verify an actual connection check and a bounded mission separately.
4. Before rolling back to a runtime predating these changes, stop all connected workers and pause/revoke the affected agents using the current runtime. Pause active missions as well. Older runtimes do not enforce the managed-installation mutation fence, mission-author administration requirement, or first-failure mission stop rule.
5. Keep migrations and durable history in place during an application rollback. Do not drop mission or installation tables as a rollback shortcut. Confirm no old worker can claim remaining work before restoring service, then resume only after the correct policy-enforcing runtime is running.

Catalog maintainers must preserve installed manifest versions or provide a reviewed upgrade/retirement path. Removing the only definition of an installed version causes its leased configuration validation to fail closed. Pure pause/revoke changes remain available without manifest validation; regression coverage checks both kill switches against a retired manifest version. Other configuration or grant changes still require a known manifest.
