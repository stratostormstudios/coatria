# Higgsfield production pipeline — v1.8 candidate

New Higgsfield projects use their own persisted reference → generation → independent QC workflow. The AI-production company template groups the required roles and skills, with explicit creative grants in the reviewed staffing plan. Generation requests pin an assigned work item, task revision and role snapshot; changed or completed tasks cannot spend against an old intent. Existing projects and agent grants remain unchanged. A separately attested exact output/request handoff permits one restricted submission pass after an asynchronous generation; automatic output import and continuation are not implied. Catalog refresh discovers the supported official tools, and exact unsent requests can use the advertised non-generating credit preflight.

This section describes source pending v1.8 deployment evidence. The current verified release is v1.7, source `902c05a`; its CI passed 612 tests and the isolated 50-session check completed 7,015 requests without unexpected errors. Higgsfield company consent, authenticated supported tool discovery and a live balance read are now verified. A real generation and output bridge remain pending.

---

# Historical Higgsfield production update — v1.7

The current product direction is the official Higgsfield MCP plugin for creative generation and references. Workstation and render-server expansion is deferred. Heavy originals stay on company storage; the current drive connector and new project pointers are metadata-only. See [Higgsfield production](HIGGSFIELD_PRODUCTION.md) for the implementation and remaining acceptance requirements.

Public OAuth discovery and public PKCE client registration have been verified against Higgsfield. Account consent, authenticated catalog discovery and a real generation are still pending. This source record is not evidence of production deployment; release output records track that separately.

The earlier v1.6 implementation is live at source f0a56fe; its application, 50-session test and Linux renderer CI passed. No Runpod rendering or inference is started by this scope change.

---

# Coatria — Studio readiness and historical release evidence

## Historical Studio implementation · v1.6

The repository now implements reviewed studio organization and staffing, dependency-aware project work, a separate opt-in planning reviewer, bounded coordination, managed CPU sessions, server-owned inference, controlled Blender execution, private-media verification and account-bound client delivery. The v1.6 increment adds the reviewed planning-reviewer staffing option, an explicit supported procedural-pilot project preset, and a scoped continuation after a verified, human-promoted render. These are bounded workflow capabilities, not evidence of an unattended VFX business or completed client production.

The earlier v1.5 baseline was **source `da87026`**. Its [CI run 35301982436](https://github.com/stratostormstudios/coatria/actions/runs/35301982436) passed 533 tests with four explicit skips on PostgreSQL 17.11, plus the 17-check deterministic agent fixture. The isolated 50-session office check completed 6,959 requests with zero unexpected errors and p95 69.76 ms; it did not test fifty concurrent model workers. Current deployment and migration outcomes belong to the operator's release record. New v1.6 source or passing local checks do not certify a v1.6 production deployment.

**Current compute state:** the operator reports the pilot CPU and GPUs stopped. No historical worker count or minimum-worker setting below describes current running compute. Retained storage charges and delayed provider billing remain separate.

The [Studio acceptance matrix](STUDIO_ACCEPTANCE.md) separates implemented code, fixture tests, actual local rendering/private storage, remaining live validation, and required human/client participation. The [operator guide](STUDIO_OPERATOR_GUIDE.md) gives the current workflow. A suitable independent administrator is still required for final media/task acceptance; an actual designated external account is required for authentic client acknowledgement.

## Historical evidence

The following dated sections record the named earlier release or pilot at its original time. Earlier version numbers, provider configuration, deployment identifiers and live observations are historical, not a claim about the present deployment or compute state. The final operating-boundary section returns to the current implementation.

The successful hosted workflow does not validate its research quality. The submitted brief was explicitly provisional and had no external research connector; review identified factual errors. Its contribution remains unaccepted and requires independent fact-checking.

### Historical hosted company pilot · 2026-09-17

The dedicated Runpod CPU worker is provisioned: Secure Cloud `cpu3c`, 2 vCPU, 4 GB RAM in `US-NC-2`, with a new 10 GB standard network volume. The runtime uses a pinned official Node 24.19.0 image and runs as UID/GID 1000. It first became live at 16:18 UTC and passed a real model connection test. The same CPU and volume restarted successfully and logged `state-restored` at 16:30:48 UTC, then again at 16:43:02.795 UTC after the allowance update. No customer desktop process is required for this hosted runtime.

The first company mission created and reserved a task but failed its context budget because the workspace summary included full floor geometry. The provider adapter now supplies a compact workspace overview without geometry; the public API contract is unchanged and `layout_get` retains the full layout. The recovery cycle then exposed a separate output-budget failure: Qwen used all 2,048 completion tokens for reasoning, returned `finish_reason: length` and supplied no final answer. It was recorded as failed. Both the installation and cloud environment now allow 8,192 output tokens per step; 80,000 total tokens, 600 seconds and 8 model steps remain unchanged. The third cycle was manually dispatched at 16:44 UTC and succeeded, recording its result at 16:53:13.544 UTC. The mission completed at three cycles. One task and one contribution are in review, submitted by the AI agent; no duplicate task or acceptance was observed. Its lifetime limit remains three, so no automatic fourth cycle is authorized. Private objectives, task identifiers and result content are omitted.

Runtime release `77a77ebb55e376a9bee09c55db61dd4678342d8b` was verified deployed through Vercel deployment `dpl_3qNjZLiAMDU1ejMMMR5iUgSrotuW`, ready and aliased to `coatria.com`. Initial hosted-release CI [35245547823](https://github.com/stratostormstudios/coatria/actions/runs/35245547823) passed 305 tests with one skip. Latest CI [35247034385](https://github.com/stratostormstudios/coatria/actions/runs/35247034385) succeeded with 318 tests passed, one skipped and no failures.

The independent production Vercel cutoff runs every minute; actual scheduled requests returned HTTP 200. Its fixed expiry is **2026-09-17 18:11 UTC (11:11 a.m. Pacific)**. The CPU quote is $0.06/hour and the new storage is approximately $0.70/month. GPU inference is configured for minimum 0, maximum 1 and a 60-second idle timeout. At 16:43:54 UTC between jobs, Runpod reported zero running, initializing and idle GPU workers, with three throttled historical entries; the account rate fell to approximately $0.077/hour for CPU and storage. This is an idle observation, not permanent GPU shutdown or zero billed spend. The API may retain the CPU hourly quote even after `EXITED`, so stopped lifecycle state does not certify billing. Cutoff delays during provider/scheduler outages and remaining storage charges require separate reconciliation.

This proves a provisioned single-company worker, cloud model connection, saved-state restoration and an idle interval with zero active GPU workers. The corrected workflow completed; its contribution awaits independent review. A normal scheduled mission follow-up remains unverified because the retries were manually dispatched; crash-safe inference recovery and fleet failover are also unverified. See [Runpod CPU hosting](RUNPOD_CPU_HOSTING.md) for the deployed profile and [Managed harness hosting](MANAGED_HARNESS_HOSTING.md) for remaining production requirements.

### Historical Runpod pilot update · 2026-09-17

The Runpod bridge now submits one queued inference job and polls that job through cold startup, with bounded HTTP requests, an overall execution deadline and best-effort cancellation. It never resubmits an uncertain inference job. The worker carries cancellation into tool calls, the adapter validates a complete proposed tool batch before effects, and the published tool schemas describe input defaults correctly. Runpod installations default to the verified `Qwen/Qwen3.8-27B-FP8` model, 80,000 total tokens per cycle and a 600-second deadline; reviewed existing installations keep their settings. These ceilings are not dollar budgets.

A real L40S pilot passed 17 checks across two autonomous cycles through the real API handlers and worker against an isolated PGlite company. It produced exactly one task and one submission for independent human review, stopped at the cycle limit, retained its assigned role, and ignored the tested hostile conversation. Seven inference calls reported 31,243 tokens. Cold startup dominated the first call at 290.9 seconds; later calls took 11.3–17.8 seconds. An earlier L40S trial failed because of an unnecessary task claim; explicit permitted-write instructions corrected the scenario without loosening the assertions. An 18,047-token retrieval probe also passed in 10.3 seconds. These small samples do not establish general task quality, prompt-injection immunity, throughput or production reliability.

The reusable `test:agent:fixture` command adds 17 deterministic workflow checks to CI without paid inference. `test:agent:live` explicitly opts into the authenticated Runpod evaluation. The isolated pilot ended with zero allowed workers and zero remaining workers observed. The existing endpoint was subsequently enabled for the dedicated hosted company pilot recorded above. Both that enablement and the earlier shutdown are historical; current stopped compute is recorded at the top of this page. Full isolated-pilot configuration, results and limitations are in [the Runpod inference guide](RUNPOD_INFERENCE.md). No AWS account is required for the chosen CPU deployment.

### Historical pre-Studio production release

Released on **2026-09-17 UTC** from source `233387e321c8bdd318ada41e89b5c7013b814c45`, Vercel deployment `dpl_6BFzG17v4oafYRQhBvKutoe9v4MD`. The public entry points are [Plugins](https://coatria.com/#plugins) and [Company autopilot](https://coatria.com/#autopilot). The feature implementation was reviewed in `8c41a6a9be736d705858a964f55ef25bc4356904`; the final source adds three verified text-contrast corrections.

Eight curated Coatria bridges cover Codex, Claude Code, OpenAI/Astra, Anthropic, xAI/Grok, Fireworks Qwen3.8, economical Together Qwen and operator-managed Runpod endpoints. A company installation pins a reviewed manifest, model, persistent role/persona, explicit capabilities and invocation access. Provider credentials remain on the operator’s worker. Installation and recent API contact are distinguished from a completed model connection check. These are Coatria integrations, not vendor-published Slack packages or bundled provider subscriptions.

Company autopilot adds administrator-owned missions, one responsible agent, a 15–1,440 minute cadence, an explicit lifetime limit of 1–100 cycles, and visible cycle history. Defaults prepare paused missions. An online worker schedules only its own approved missions; no browser must remain open. Durable scheduling prevents overlapping mission cycles and missed-cycle catch-up storms. Failed or uncertain effects require review before further autonomous reasoning. Current mission-author administrator authority is enforced during claims, context, tools, renewal and completion. Configuration changes cancel pending work, without pretending to undo already committed effects.

At that earlier release, the OpenAPI 3.1 contract was version 1.1.0 and documented marketplace, mission and leased-worker APIs. The [live contract endpoint](https://coatria.com/api/agent/openapi) may now serve a newer deployed version. The original eighteen typed workspace tools retain server-authoritative grants and independent contribution/proposal review. Private skills, credentials, original NAS media, payments, publishing and security administration are not new agent permissions. Connection checks are server-restricted to empty tool capabilities and no conversation history.

### Historical pre-Studio release evidence

- GitHub Actions run [35172419312](https://github.com/stratostormstudios/coatria/actions/runs/35172419312) passed application validation and the independent 50-session office regression. Application validation passed 255 tests with one licensed-asset CI skip and no failures. The final isolated office test recorded 6,982 requests with zero unexpected errors, p50 19.96 ms and p95 638.57 ms, within its 1,000 ms budget; these are CI measurements, not an inference or worldwide-production benchmark.
- Twenty focused local browser scenarios cover Plugins and Autopilot. Published HTML/JavaScript/CSS passed 11 functional/security/accessibility checks and nine desktop/mobile axe scans with zero violations or horizontal overflow. Browser APIs were synthetic fixtures; no production users, messages, agents or missions were created by these checks.
- An actual Codex Sol worker completed two autonomous cycles through marketplace installation, the real HTTP handlers, durable worker and MCP against an isolated PGlite company. It created one launch task, submitted it for human review, avoided a duplicate on the next cycle, and stopped at two cycles. The test advanced the due timestamp rather than waiting 15 minutes. At that release, other model providers had protocol fixtures; the later Runpod pilot is recorded above.
- Neon migrations 010 and 011 committed atomically. Eleven migrations are recorded; the three new tables have the existing application runtime’s explicit CRUD grants, with no TRUNCATE or schema CREATE grant. Initial installations and missions were zero. Provider credentials are not stored in those tables.
- Vercel verified twelve licensed rigged characters and 78 private office objects. Published public API, authorization and downloadable-source checks passed. The temporary candidate inspection credential was removed; preview protection is unchanged.

## Current operating boundary

Coatria remains a controlled-pilot foundation. Reviewed organization design, scoped staffing, dependency-aware multi-agent work, finite planning review, single-company managed hosting and server-owned inference now exist; they are no longer wholly future work. Durable request/receipt state and retained CPU/inference reservations are implemented and tested, while live failover, provider-capacity handling, cost reconciliation and semantic model quality still need operational validation. The pilot CPU and GPUs are stopped at this update; another session requires its normal reviewed limits and authorization.

The implemented Blender capability is a fixed procedural product-turntable profile, not arbitrary client-footage production. Human business gates, media promotion, independent final review and genuine client identity remain part of the workflow. Hiring/commerce execution, general DCC/NAS connectors, heavy-media transfer, automatic authorized rework, company-wide hard spending limits, enterprise identity/recovery, regional fleets and million-user capacity remain separate work. The 50-session CI result measures the office HTTP pipeline, not worldwide inference or production throughput.

See [current Studio acceptance](STUDIO_ACCEPTANCE.md), [the company operating plan](AUTONOMOUS_COMPANY.md), [security audit](AGENT_MARKETPLACE_AUDIT.md), [provider research](PROVIDER_RESEARCH.md), [worker guide](https://coatria.com/downloads/AGENT_RUNTIME.md) and [mission guide](https://coatria.com/downloads/AUTOPILOT.md).

Before rolling back to the pre-marketplace runtime, stop affected workers and pause or revoke affected agents: old code lacks the new installation and mission authorization fences. Prefer a forward fix.
