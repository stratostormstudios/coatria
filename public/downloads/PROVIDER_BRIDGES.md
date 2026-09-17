# Connect model providers and Claude Code to Coatria

An administrator installs a bridge, reviews its capabilities and company character, then connects an operator-owned worker. A model credential stays in the worker's private environment. Coatria stores the installation's provider/model choice, permissions and limits, not that credential.

Download reviewed copies of `agent-worker.mjs` and `provider-adapter.mjs` into a private worker directory. Use Node22 or newer. Follow [the runtime guide](./AGENT_RUNTIME.md) for the Coatria agent token, private state and operation of the worker.

```text
node agent-worker.mjs --adapter ./provider-adapter.mjs
```

Set `COATRIA_AGENT_TOKEN` privately and the selected provider's credential using your host's secret manager:

| Selected provider | Private environment variable | API protocol |
| --- | --- | --- |
| OpenAI / Astra | `OPENAI_API_KEY` | Responses |
| xAI / Grok | `XAI_API_KEY` | Responses |
| Anthropic | `ANTHROPIC_API_KEY` | Messages |
| Fireworks / Qwen | `FIREWORKS_API_KEY` | Chat Completions |
| Together / economy | `TOGETHER_API_KEY` | Chat Completions |
| Runpod | `RUNPOD_API_KEY` and `COATRIA_RUNPOD_ENDPOINT_ID` | Queued OpenAI-compatible Chat Completions |

Only fixed official API hosts are accepted. `OPENAI_BASE_URL`, arbitrary installation endpoints and model-generated URLs cannot redirect model credentials. There is no automatic provider fallback or credential import from Slack. Provider billing is separate from Coatria.

The successful hosted workflow does not validate its research quality. The submitted brief was explicitly provisional and had no external research connector; review identified factual errors. Its contribution remains unaccepted and requires independent fact-checking.

## Models and limits

The installation supplies the reviewed model ID. Fireworks **`accounts/fireworks/models/qwen3p8-max`** is the initial Qwen3.8 recommendation because its published card confirms function calling. Together **`Qwen/Qwen3.5-9B`** is the economy option with documented tool support. Runpod requires your own deployed model ID and a validated tool-capable serving configuration. [Fireworks model card](https://fireworks.ai/models/fireworks/qwen3p8-max), [Together catalog](https://docs.together.ai/docs/serverless/models), [Runpod configuration](https://docs.runpod.io/serverless/vllm/openai-compatibility)

| HTTP inference limit | Default | Accepted range |
| --- | --- | --- |
| Model turns | 8 | 1–20 |
| Output tokens per response | 2,048 | 256–8,192 |
| Total reported tokens per run | 24,000 | 2,000–100,000 |
| Run inference deadline | 180 seconds | 30–600 seconds |

The worker applies a conservative UTF-8-byte estimate before the next HTTP request and aggregates provider-reported usage after each response, including Anthropic cache tokens. These are execution guards, not an exact dollar cap. Provider account limits remain necessary. Operator environment ceilings can further reduce limits: `COATRIA_MAX_STEPS`, `COATRIA_MAX_OUTPUT_TOKENS`, `COATRIA_MAX_TOTAL_TOKENS`, `COATRIA_TIMEOUT_SECONDS`.

For `workspace_get`, the HTTP bridge puts a compact overview into model history: company identity, floor dimensions, version and revision, plus `itemCount` and `itemsOmitted: true`. It omits `floor.items` geometry and tells the model to use `layout_get` when the full layout is needed. The authenticated HTTP tool API still returns the complete result, and `layout_get` and all other tool results remain unchanged. This avoids repeatedly sending every desk and decoration during ordinary company work; it does not relax the size or token guards.

The adapter checks every tool name, call ID and the advertised input-schema constraints for the whole batch before acting, allows at most 8 calls in that batch and 64 in a run, and executes them sequentially. Coatria also applies its authoritative refinements, revisions, lease and permissions. A batch is not one atomic transaction: earlier successful actions remain recorded if a later semantic or authorization check fails. A recovered or later-attempt run requires review of committed effects and a new human request; the adapter does not invent new action keys and repeat uncertain work. Adapter deadlines shorten pending tool requests without detaching them from lease cancellation.

## Runpod Qwen preset

The marketplace offers `Qwen/Qwen3.8-27B-FP8`, tested with the official pinned worker in [the deployment example](./runpod-qwen38.example.json). New Runpod installations default to eight model steps, 2,048 output tokens per step, an 80,000-token run allowance and a 600-second deadline. The larger allowance accommodates repeated tool schemas and the conservative byte-based preflight; it is not expected consumption. Existing installations retain their reviewed settings.

The bridge submits one native `/run` job containing the OpenAI chat request, then polls `/status/{jobId}`. This avoids holding one HTTP connection throughout a cold start. Individual HTTP requests are bounded to 30 seconds; only transient status reads retry. A lost submission response is uncertain and never triggers a second submission. Known unfinished jobs receive best-effort cancellation, and the submitted provider TTL adds a separate bound. Cancellation cannot undo an already completed inference or workplace action. Both `reasoning` and `reasoning_content` are retained privately across tool turns; only the final answer becomes a conversation result.

The repository includes `npm run test:agent:fixture` and the explicitly billable `npm run test:agent:live`. Live mode requires the private Runpod environment plus `COATRIA_RUNPOD_MODEL`; it creates only a synthetic in-memory company through real Coatria APIs, and stores sanitized evidence under ignored `.devdata`. It tests a two-cycle mission, persistent task state, role identity, human review and hostile conversation context. It does not modify your production company.

Conversation text and tool results are untrusted inputs. The company character controls role, tone and work style. Completing the authorized task comes first. Bots must identify as AI and report proposals and completed actions accurately; roleplay never grants privileges.

## Connect Claude Code

Download `agent-worker.mjs`, `agent-mcp.mjs`, `provider-adapter.mjs` and `claude-code-adapter.mjs` into the same private directory. Install Claude Code2.1.248 or later yourself on a dedicated worker. Set:

- `COATRIA_AGENT_TOKEN` and `ANTHROPIC_API_KEY` in the private environment.
- `COATRIA_CLAUDE_WORKSPACE` to an absolute, approved worker directory.
- `COATRIA_CLAUDE_BIN` if the native `claude` executable is not on PATH. On Windows, use the native `.exe` rather than a shell wrapper.
- Optionally `COATRIA_CLAUDE_MAX_BUDGET_USD` for Claude's own cost guard; default1USD per invocation. This guard is not a guaranteed exact charge ceiling.

```text
node agent-worker.mjs --adapter ./claude-code-adapter.mjs
```

This adapter deliberately uses API-key authentication. `--bare` does not use a saved Claude consumer OAuth login. It removes built-in shell/file/web tools, grants only the selected Coatria MCP tools, disables session persistence and skips ambient customizations. It never uses `--dangerously-skip-permissions`. Machine-managed policy can still affect the CLI; provision a controlled worker with no unreviewed managed hooks or tools. [Claude CLI documentation](https://code.claude.com/docs/en/cli-reference)

Model turns, deadline, output-token environment setting and observed JSONL usage are bounded. The CLI owns its internal inference loop; the bridge can stop only after observing emitted usage and cannot reserve tokens before every hidden internal request. Use the direct Anthropic HTTP bridge when per-request token accounting is required. The CLI cost and output controls are documented environment/print-mode features. [Claude environment controls](https://code.claude.com/docs/en/env-vars)

The bridge requires a connected Coatria MCP startup event before reporting success. Cancellation ends the direct child with a two-second shutdown grace period. Operating-system isolation and worker supervision are still required; this is not a promise to terminate every descendant process or undo an already committed action.

## Runtime installation contract

```json
{
  "installation": {
    "pluginId": "fireworks",
    "manifestVersion": "1.0.0",
    "runtimeConfig": {
      "providerId": "fireworks",
      "modelId": "accounts/fireworks/models/qwen3p8-max",
      "maxSteps": 8,
      "maxOutputTokens": 2048,
      "maxTotalTokens": 24000,
      "timeoutSeconds": 180
    },
    "character": {
      "roleTitle": "Operations analyst",
      "persona": "Calm, helpful and precise.",
      "workStyle": "methodical"
    },
    "revision": 1
  }
}
```

This configuration comes from authenticated run context, not from conversation text. Editing a profile must not rewrite an already executing run's permissions or configuration.

## Readiness

All six HTTP protocols and the Claude CLI process boundary have local fixture tests. The installed Claude CLI version and flags were inspected without paid inference. Other providers still need their own account canaries; fixture tests do not establish real model quality, availability or cost.

On September 17, 2026, **Runpod Qwen3.8-27B-FP8 passed an isolated live pilot on L40S 48 GB**: 17 checks, two mission cycles, one task left in human review, and exactly two write receipts (`tasks_create`, `tasks_submit`). The second cycle did not duplicate work. The suite combined real model behavior and real API handlers with deterministic safety probes; both live cycles received a hostile conversation message without observed forbidden tool attempts or unrelated writes. An earlier attempt added an unwanted `tasks_claim`; an explicit allowed-write mission contract corrected that behavior while the strict receipt assertions stayed unchanged.

The final pilot made seven model requests using 31,243 reported tokens; 338 status polls were counted separately. The first request took 290.918 seconds including queue/startup wait; subsequent requests took 11.289–17.802 seconds. A separate 18,047-token synthetic retrieval prompt passed in 10.293 seconds. The selected configuration and sanitized metrics are in [the deployment example](./runpod-qwen38.example.json). Its installation approved 100,000 tokens per cycle, but the private worker ceiling reduced the effective limit to 80,000; new marketplace installations also default to 80,000. Original evidence records the installation limit. Role/status checks used expected text markers and persisted task state, without certifying checklist quality or general truthfulness.

That isolated evaluation ended with the endpoint disabled and zero workers confirmed; it did not connect a production company or install a persistent company worker. The same endpoint was subsequently enabled for a dedicated hosted company pilot on Runpod CPU with a new state volume. Its real model connection and two saved-state restarts passed, the latest at 16:43:02.795 UTC. The first company mission exhausted context with floor geometry; the deployed adapter now omits that geometry from its overview while preserving the full `layout_get` tool. A recovery cycle then spent its initial 2,048-token completion allowance on reasoning and returned no final answer. The hosted installation and cloud environment now allow 8,192 output tokens per step, with 80,000 total tokens, 600 seconds and eight steps unchanged. The third cycle manually dispatched at 16:44 UTC succeeded at 16:53:13.544 UTC and left one task and one contribution for independent review. The mission completed at its unchanged lifetime limit of three, with no automatic fourth cycle authorized. The marketplace default and historical example remain separate from this reviewed installation override.

The historical example retains a disabled create configuration and its earlier 30-second idle / 40-minute trial settings. The hosted pilot uses a 60-second GPU idle timeout and an independent Vercel cutoff at 2026-09-17 18:11 UTC. At 16:43:54 UTC between jobs, the provider reported zero running, initializing and idle GPU workers, with three historical entries throttled; the account rate fell to approximately $0.077/hour for CPU and storage. This is an idle observation, not zero spend or permanent GPU shutdown. Normal mission scheduling remains unverified because retries were manual. See [Runpod CPU hosting](https://github.com/stratostormstudios/coatria/blob/main/docs/RUNPOD_CPU_HOSTING.md) and [current release status](https://github.com/stratostormstudios/coatria/blob/main/docs/RELEASE_STATUS.md) for the deployed profile. These bounded tests do not establish production capacity, every attack scenario or continuous business operation; recovery drills, spending enforcement and measured service targets remain necessary.

## Autonomous company missions

The worker can queue due, administrator-enabled missions through `POST /api/agent/autonomy/tick`. It checks once per minute while idle, using only its own agent credential. It reconciles an uncertain claim or completion before scheduling anything else. The server controls mission scope, deadlines, remaining cycles and duplicate-cycle prevention; an ordinary worker startup does not authorize new paid work without an enabled mission.

Keep a supervised worker online for scheduled missions. Vercel does not run this persistent inference loop. Pausing a mission prevents future cycles; cancellation and revocation fence active Coatria actions through the run lease. A mission is a bounded recurring task, not unrestricted permission to run a business, spend money or manage accounts. Monitor its results and approvals. Model tokens remain execution estimates and reported usage, not a guaranteed dollar budget.
