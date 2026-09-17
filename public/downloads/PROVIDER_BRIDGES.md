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
| Runpod | `RUNPOD_API_KEY` and `COATRIA_RUNPOD_ENDPOINT_ID` | OpenAI-compatible Chat Completions |

Only fixed official API hosts are accepted. `OPENAI_BASE_URL`, arbitrary installation endpoints and model-generated URLs cannot redirect model credentials. There is no automatic provider fallback or credential import from Slack. Provider billing is separate from Coatria.

## Models and limits

The installation supplies the reviewed model ID. Fireworks **`accounts/fireworks/models/qwen3p8-max`** is the initial Qwen3.8 recommendation because its published card confirms function calling. Together **`Qwen/Qwen3.5-9B`** is the economy option with documented tool support. Runpod requires your own deployed model ID and a validated tool-capable serving configuration. [Fireworks model card](https://fireworks.ai/models/fireworks/qwen3p8-max), [Together catalog](https://docs.together.ai/docs/serverless/models), [Runpod configuration](https://docs.runpod.io/serverless/vllm/openai-compatibility)

| HTTP inference limit | Default | Accepted range |
| --- | --- | --- |
| Model turns | 8 | 1–20 |
| Output tokens per response | 2,048 | 256–8,192 |
| Total reported tokens per run | 24,000 | 2,000–100,000 |
| Run inference deadline | 180 seconds | 30–600 seconds |

The worker applies a conservative UTF-8-byte estimate before the next HTTP request and aggregates provider-reported usage after each response, including Anthropic cache tokens. These are execution guards, not an exact dollar cap. Provider account limits remain necessary. Operator environment ceilings can further reduce limits: `COATRIA_MAX_STEPS`, `COATRIA_MAX_OUTPUT_TOKENS`, `COATRIA_MAX_TOTAL_TOKENS`, `COATRIA_TIMEOUT_SECONDS`.

The adapter checks every tool name, call ID and argument object in a batch before acting, allows at most 8 calls in that batch and 64 in a run, and executes them sequentially. Coatria validates each tool's full argument schema and rechecks its lease and permissions. A batch is not one atomic transaction: earlier successful actions remain recorded if a later action fails. A recovered or later-attempt run requires review of committed effects and a new human request; the adapter does not invent new action keys and repeat uncertain work.

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

All six HTTP protocols and the Claude CLI process boundary have local fixture tests. The installed Claude CLI version and flags were inspected without paid inference. Perform an approved provider-account canary before unattended use; fixture tests do not establish real model quality, account access, availability or cost.

## Autonomous company missions

The worker can queue due, administrator-enabled missions through `POST /api/agent/autonomy/tick`. It checks once per minute while idle, using only its own agent credential. It reconciles an uncertain claim or completion before scheduling anything else. The server controls mission scope, deadlines, remaining cycles and duplicate-cycle prevention; an ordinary worker startup does not authorize new paid work without an enabled mission.

Keep a supervised worker online for scheduled missions. Vercel does not run this persistent inference loop. Pausing a mission prevents future cycles; cancellation and revocation fence active Coatria actions through the run lease. A mission is a bounded recurring task, not unrestricted permission to run a business, spend money or manage accounts. Monitor its results and approvals. Model tokens remain execution estimates and reported usage, not a guaranteed dollar budget.
