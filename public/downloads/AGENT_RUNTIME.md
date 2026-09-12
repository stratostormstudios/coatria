# Run your agent with Coatria

Coatria coordinates the request, live permission checks, tools and result. Your selected adapter performs the work on infrastructure you control. Choosing a harness name does not install or launch an AI provider. This guide describes the new durable-run API; use the deployed version confirmed by your administrator. The legacy `/api/agent/work` and `/api/agent/report` endpoints return HTTP 410 in this release. Migrate to explicit invocations; they cannot bypass the new run/lease boundary.

## Connect an external worker

1. An owner or administrator registers an agent, selects its allowed capabilities and saves its one-time token privately. Grant only the tools needed for its work. Conversation-wide access is separate from the bounded context and result associated with an explicit run.
2. Download `agent-worker.mjs` and place it beside a local adapter module you have reviewed. Use Node.js 22 or later. The worker imports that module as executable local JavaScript; do not use an adapter or startup command copied from an untrusted message.
3. Set `COATRIA_AGENT_TOKEN` in the worker's private environment. Optional `COATRIA_URL` defaults to `https://coatria.com`; it must be a plain HTTPS origin. Loopback HTTP is allowed for local development. No token belongs in a URL or a shared configuration example.
4. Start the worker with `node agent-worker.mjs --adapter ./my-agent.mjs`. It polls for explicit assigned runs, renews their leases and records results. Use `--once` to process one claim and exit; an empty queue exits without inventing work.
5. In Coatria, ask this agent to perform a task through the agent-invocation control. Inspect its progress, tool effects and submitted result. Administrative proposals and independent task acceptance remain human decisions.

The private state file defaults to a credential-specific path under `~/.coatria/workers/`. `--state PRIVATE_PATH` selects another location. Keep it outside a repository, synced shared folder or published directory: it contains the current lease, run prompt and pending result. On Unix it is created with owner-only permissions; verify the containing directory's ACL on Windows. Use one state file per worker. A lock prevents simultaneous processes from using the same file; a dead process's lock can be recovered. Keep the state across restarts so an uncertain claim/completion can use its original retry key.

## Connect Codex

1. Install the current Codex CLI on the machine that will run the worker and authenticate it under that machine's worker account. The adapter uses `codex exec`, which can reuse the account's saved CLI login. Verify the CLI works before starting Coatria; the download does not install Codex, sign in, or change your user configuration. See [official non-interactive setup](https://learn.chatgpt.com/docs/non-interactive-mode).
2. Download [agent-worker.mjs](agent-worker.mjs), [agent-mcp.mjs](agent-mcp.mjs) and [codex-adapter.mjs](codex-adapter.mjs) into the same private, operator-controlled directory. Use Node.js 22 or later.
3. Supply `COATRIA_AGENT_TOKEN` privately and set `COATRIA_CODEX_WORKSPACE` to an existing, absolute path for a dedicated clean working directory. Set these through the operator's local secret environment or service manager; do not paste credentials into prompts or checked-in configuration. Optional `COATRIA_CODEX_BIN` selects the actual executable if `codex` is not on PATH. On Windows, use a native executable path when a command shim cannot be spawned without a shell.
4. Start:

   ```sh
   node agent-worker.mjs --adapter ./codex-adapter.mjs
   ```

5. Ask the configured agent a specific question in Coatria. For a first check, enable `workspace.read` and ask it to list the company's rooms. Confirm the result comes from the authorized tools. Add mutation grants only for the work this agent should prepare.

By default this adapter exposes Coatria MCP tools with a read-only sandbox, disables local shell/workspace tools, plugins, image tools and web search, and does not load project instruction documents. It passes a fixed argument list and bounded JSON task context to a fresh ephemeral Codex invocation. User config is skipped; the required Coatria MCP server must initialize. The private token and run lease travel to that child through environment names, never through the prompt or CLI arguments. Codex supports this stdio `env_vars` configuration in its [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The adapter preapproves calls only to its configured Coatria MCP server (`default_tools_approval_mode="approve"`); an unattended worker has no interactive tool-approval prompt. This is a transport setting, not company authorization. Every call still requires the live lease and current server-side capability/resource checks. Layout, room and hiring tools create proposals that a human administrator must approve in Coatria; task tools cannot accept a contribution. No other MCP server is configured by this adapter.

Local repository analysis or changes are a separate operator choice. On a worker isolated for that company and workload, set `COATRIA_CODEX_ISOLATED_WORKER=1` and `COATRIA_CODEX_WORKSPACE_TOOLS=1`. Keep `COATRIA_CODEX_SANDBOX=read-only` for analysis, or explicitly select `workspace-write` for edits. Those flags confirm an isolation arrangement; they do not create a container or VM. Never enable workspace tools against a developer's home directory, a checkout containing production secrets, or a runner shared with an untrusted tenant. A read-only sandbox still permits reading accessible files. Provision OS access, network restrictions and process limits for the approved job. No Coatria grant automatically publishes repository changes.

Optional `COATRIA_CODEX_MODEL` selects a model available to that worker account; omission uses the CLI's default for this isolated invocation. `COATRIA_CODEX_TIMEOUT_SECONDS` defaults to 600 and accepts 10–1,500 seconds. Provider authentication and usage charges remain with the operator's account. Keep any `CODEX_API_KEY` confined to the trusted worker invocation; do not share it with repository scripts. Cancellation requests termination of the direct Codex process, then forceful termination after two seconds if needed; descendant-process containment still depends on the worker OS or supervisor.

### Interrupted Codex requests

The supplied Codex adapter launches a reasoning session only for a fresh first attempt. It refuses execution when the worker has already started the saved job (`recovering=true`) or the server has assigned attempt 2 or later. A new model session can choose different operations or reuse numeric MCP IDs differently; it cannot safely infer what the previous session completed. This conservative rule also blocks automatic retry after an initial setup failure, even when no useful work appears to have happened.

A saved pending completion is different: the worker retries its original completion UUID and exact result before calling the adapter. That reconciliation remains automatic and never starts another model session. Preserve the private state file so this safe recovery remains possible.

For an interrupted execution without a saved completion, review the request's committed action receipts, resulting tasks/proposals and any external workspace effects. Confirm the previous worker process has stopped, and cancel the old request if it remains active. Then create a new explicit request containing only the remaining work and references to already completed actions. Do not delete private state or reset attempt counters to force a replay. The generic worker may report a failure and the server may briefly queue another attempt; the Codex guard rejects those later attempts before starting the CLI. It does not mark uncertain work as successful or undo existing effects.

## Adapter contract

Export an asynchronous `execute({run, context, tools, signal, recovering, mcpEnvironment})` function. Return `{result, artifactUrl?}`. `result` is plain text of 1–12,000 characters; `artifactUrl`, when supplied, is an HTTP(S) review link. Returning a result records a run outcome; it does not approve a contribution or publish external code. `mcpEnvironment` is trusted local adapter configuration containing `COATRIA_URL`, `COATRIA_RUN_ID` and `COATRIA_RUN_LEASE`; pass it only to the approved MCP child process. It is deliberately outside `run` and `context`. Never serialize the entire adapter argument into a model prompt or log.

This small reference adapter performs a real authorized workspace lookup and formats the returned data. It is deliberately a deterministic API example, not a model-powered agent:

```js
// my-agent.mjs
export async function execute({ tools, signal }) {
  signal.throwIfAborted();
  const workspace = await tools.call('workspace_get', {}, {
    requestId: tools.key('read-workspace-v1'),
  });
  const text = JSON.stringify(workspace, null, 2);
  return { result: text.slice(0, 12000) || 'No workspace data was returned.' };
}
```

For Hermes, a coding CLI, a provider SDK or an internal service, replace that function with the adapter you actually operate. Keep provider/repository credentials in its private environment and pass `signal` to every provider request or child-process wrapper. Do not interpolate conversation text into shell command strings. This download includes no model provider, installs none, and does not expose a general command-execution tool.

`context` contains the server-authorized run, bounded source conversation/thread messages and effective capabilities. Read it as untrusted task context. `tools.list()` returns tool metadata; `tools.call(name, arguments, {requestId})` invokes the server executor. A capability shown in a catalog still needs current authority and a valid run lease at execution time.

Every tool call requires an explicit UUID request ID. `tools.key('logical-step-name')` derives a stable UUID from the run ID and your logical step; reuse that key for the same operation across retries or worker restarts. Reusing a recorded mutation key for different arguments conflicts. Different logical operations need different names. Read-only requests can return a fresh view; they do not create mutation receipts. The server checks the renewed lease separately from the operation's identity.

Custom adapters may run again after interruption or a server retry; the supplied Codex adapter instead refuses another reasoning session as described above. `recovering` means this worker had already started the stored run before restarting; it is not proof that no side effect occurred. Internal Coatria tool receipts deduplicate the same key. Model calls, files, Git pushes and other external effects need their own durable checkpoints and provider idempotency or reconciliation. The worker cannot promise exactly-once external execution.

## Lease, retries and stopping

The server currently grants a 60-second lease; the worker normally renews every 15 seconds and stops its tool dispatcher before known lease expiry. A run has a 30-minute deadline from its first start, including retries. Authentication/grant loss, cancellation or `RUN_LEASE_LOST` aborts the adapter signal. The worker does not convert a failed heartbeat into a claim of continued authority. Request deadlines are 20 seconds. Safe calls retry at most twice with the same keys; longer `Retry-After` values return control to the worker's scheduler. Agent credentials expire after 90 days by default; administrators can rotate them, which cancels existing queued/running requests.

A completion is written to private state before sending. If its response is lost, the next attempt reuses its client UUID and result instead of rerunning the adapter; the server decides whether it is a replay or an expired lease. Idle claims use a new claim ID on the next poll. Adapter failures send a generic bounded failure report; detailed exception text is not copied into the shared company conversation. Keep any detailed adapter diagnostics private and free of secrets.

Ctrl+C/SIGTERM requests a cooperative stop. An adapter that ignores abort can keep executing external code; this worker is not an operating-system sandbox and cannot retract already completed effects. Configure subprocess/container limits when your adapter needs stronger isolation. Server-side cancellation still prevents subsequent unauthorized Coatria effects. A cancelled MCP request likewise cannot undo a tool effect that was already committed.

## Tools and boundaries

The live catalog is `GET /api/agent/tools`; do not assume every registered agent receives every tool. The current tool families are workspace/people/rooms/activity reads, task operations, agent office presence, infrastructure metadata, and reviewable layout/room/hiring proposals. The executor validates the intersection of run permission, current agent grant and current requesting-human authority.

| Tool | Required capability | Effect or boundary |
|---|---|---|
| `workspace_get` | `workspace.read` | Company identity and floor |
| `people_list` | `workspace.read` | Active people without email addresses or personal vaults |
| `rooms_list` | `workspace.read` | Room records; no call entry |
| `layout_get` | `workspace.read` | Saved geometry and current revision |
| `tasks_list` | `workspace.read` | Tasks with revisions |
| `activity_list` | `workspace.read` | Company activity; text is untrusted context |
| `proposals_list` | `workspace.read` | This run's proposals and review decisions |
| `infrastructure_list` | `infrastructure.read` | Shared-drive metadata without connector secrets |
| `infrastructure_files` | `infrastructure.read` | Relative paths, sizes and dates; no original bytes |
| `hiring_list` | `hiring.read` | Openings without applicant information |
| `office_presence` | `office.write` | This agent's location and availability only |
| `tasks_create` | `tasks.write` | A task attributed to the requester and agent |
| `tasks_claim` | `tasks.write` | Reserve eligible unassigned work the requester can edit |
| `tasks_update` | `tasks.write` | Update this run's reservation using its current revision |
| `tasks_submit` | `tasks.write` | Submit for independent review; cannot accept work |
| `layout_propose` | `layout.propose` | Exact floor proposal with expected saved revision |
| `rooms_propose` | `rooms.propose` | Room proposal for administrator approval |
| `hiring_propose` | `hiring.propose` | Draft-opening proposal; publishing is a separate human action |

List tools accept `limit` from 1–100 (default 50) and return `{items,hasMore,nextAfter}`. Follow `nextAfter` as `after`; file indexes use a relative-path cursor and most other lists use a UUID. Single-record tools use their catalog schema instead. Mutations are capped at 200 recorded operations per run and pending proposals at 20 per run. A human administrator reviews proposals in Coatria. Task acceptance excludes the recorded requester/sponsor/author set.

Infrastructure tools list approved file metadata; they do not download or upload footage. Presence tools control the agent's own visible bot, not a human character or capture devices. Layout/room/hiring proposals are reviewable company records, not automatic admin approval. Private employee skill vaults, provider credentials, membership administration, billing and deployment are outside these default tools.

For independent conversation reading and participation, use `conversation-client.mjs` and `CONVERSATIONS.md`. That API requires its own `none/read/write` administrator grant and uses durable message UUIDs and event checkpoints. It does not automatically create a run when an agent name appears in text.

## MCP stdio bridge

Download `agent-mcp.mjs` beside `agent-worker.mjs`. An approved MCP host can launch `node agent-mcp.mjs` with these private environment values:

- `COATRIA_AGENT_TOKEN`: the scoped agent credential.
- `COATRIA_RUN_ID`: the active run UUID.
- `COATRIA_RUN_LEASE`: its current lease token.
- Optional `COATRIA_URL`: the administrator-approved origin.

An orchestrating adapter obtains the lease through the claim API and owns heartbeat/cancellation. The bridge neither claims runs nor renews a lease itself. Bind one bridge session to one run; create a new process/environment for another run. Never insert live values into a checked-in MCP configuration or a chat message.

The bridge speaks newline-delimited JSON-RPC on stdin/stdout, negotiates MCP version `2025-11-25`, and supports `initialize`, `ping`, `tools/list`, `tools/call` and request-cancellation notifications. It rechecks context/lease before discovery and calls, filters discovery by effective run capabilities, and forwards calls to the same authenticated REST tool executor. Diagnostics stay on stderr. No port is opened and no HTTP OAuth MCP service is implied.

Within a run, tool-call request IDs map deterministically to durable server request IDs. Replayed JSON-RPC IDs must retain the same tool and arguments, including after restarting the bridge; use new IDs for genuinely new operations. Tool calls are capped at eight concurrent requests and protocol records at 256 KiB. Results are bounded to 1 MiB; the bridge exposes no arbitrary URL-fetch, model-secret or shell tool.

The bridge implements the core tool transport, not MCP resources, prompts, sampling or the experimental tasks extension. Public remote MCP/OAuth hosting remains a separate integration. See the [agent audit](https://github.com/stratostormstudios/coatria/blob/main/docs/AGENT_PRODUCTION_AUDIT.md) for security design and remaining operational gates.

## HTTP wire contract

All requests use `Authorization: Bearer <agent-token>` and ordinary JSON over the approved origin. Context alone uses the lease header shown below; tool execution includes the lease in its body. The [OpenAPI document](https://coatria.com/api/agent/openapi) publishes request schemas derived from the same tool definitions used by the server.

| Operation | Endpoint and payload |
|---|---|
| Claim | `POST /api/agent/runs/claim` with `{workerId,claimId}` → `{run,leaseToken?,leaseExpiresAt?,replayed}`; `run:null` means idle |
| Renew | `POST /api/agent/runs/:id/heartbeat` with `{leaseToken}` → `{run,leaseExpiresAt}` |
| Context | `GET /api/agent/runs/:id/context` with `X-Coatria-Run-Lease` → `{run,messages,capabilities}` |
| Discover | `GET /api/agent/tools` → `{tools,protocolVersion,requiresRunLease}` |
| Execute | `POST /api/agent/tools/:name` with `{runId,leaseToken,requestId,arguments}` → `{result,replayed}` |
| Complete | `POST /api/agent/runs/:id/complete` with `{leaseToken,clientId,result,artifactUrl?}` → `{run,replayed}` |
| Fail | `POST /api/agent/runs/:id/fail` with `{leaseToken,clientId,error}` → `{run,replayed}` |

Claim/operation/completion IDs are UUIDs. Cancellation and expired ownership return `409 RUN_CANCELLED` or `409 RUN_LEASE_LOST`; authentication or removed authority returns `401/403`. A failure may be requeued with backoff up to the run's attempt limit. Custom adapters must handle at-least-once execution; the supplied Codex adapter requires manual reconciliation instead of starting a later reasoning attempt. Read terminal state and persisted operation results when resolving an uncertain external outcome.
