# Runpod inference for Coatria workplace agents

Verified September 17, 2026. **The isolated live pilot passed; the inference endpoint is paused.** Qwen completed a two-cycle company mission through the real Coatria worker, provider adapter and API handlers. This establishes a working integration, not production capacity or an unattended business. No production company was connected, and no always-on Coatria worker was installed.

## Selected deployment configuration

The selected pilot configuration uses the official **Qwen/Qwen3.8-27B-FP8** checkpoint on one **L40S with 48 GB VRAM**. An H100 with 80 GB also passed an earlier baseline. The checkpoint uses Apache-2.0 and contains approximately 30.9 GB of artifacts, compared with approximately 55.6 GB for the original checkpoint. The measured evaluations below are limited to their synthetic tasks. [Official model](https://huggingface.co/Qwen/Qwen3.8-27B-FP8)

Pin both model and serving image:

| Component | Reviewed immutable identifier |
| --- | --- |
| Model | `Qwen/Qwen3.8-27B-FP8` |
| Model revision | `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` |
| Worker release | `runpod/worker-v1-vllm:v2.27.0` |
| Image manifest digest | `sha256:fd9e5c55c996361aad2543d96d9d85ca055625ee5d1fcefa2d213141deb45e17` |
| Underlying engine | vLLM `0.29.0` |

The digest was checked against Docker Hub's public tag metadata. The September 11 worker release upgrades vLLM to 0.29.0. Pin by digest in the actual template; a version label alone can be republished. [Release](https://github.com/runpod-workers/worker-vllm/releases/tag/v2.27.0), [tag metadata](https://hub.docker.com/v2/repositories/runpod/worker-v1-vllm/tags/v2.27.0)

The machine-readable reference is [runpod-qwen38.example.json](../public/downloads/runpod-qwen38.example.json). It is a bundle of separate examples, not one API request. It contains no credentials or account identifiers. Send its `endpointCreate` body to `POST https://api.runpod.io/v2/serverless`; this embeds the pinned container configuration and creates the endpoint disabled. Activation is a separate patch. The actual pilot used this REST API v2 configuration. [Endpoint API](https://docs.runpod.io/api-reference-v2/serverless/create-a-serverless-endpoint)

## Inference and the company worker are separate services

```text
Company chat / task / approved mission
                  |
        Coatria durable run + lease
                  |
    supervised Coatria worker (Node)
       |                      |
 scoped Coatria tools    Runpod inference API
       |                      |
 task receipt/review     Qwen on a flex GPU worker
```

Runpod serves the model. It does not independently poll Coatria, schedule company work, enforce company permissions or preserve a Coatria run lease. The **Coatria worker must stay online** on a supervised host for recurring missions, even while the inference endpoint scales down to zero GPUs. Vercel serves the web application and APIs; it does not host this persistent polling loop.

Download reviewed copies of `agent-worker.mjs` and `provider-adapter.mjs` into a private worker directory. Start with Node 22 or newer:

```text
node agent-worker.mjs --adapter ./provider-adapter.mjs
```

Inject `COATRIA_AGENT_TOKEN`, `RUNPOD_API_KEY`, `COATRIA_RUNPOD_ENDPOINT_ID` and `COATRIA_URL=https://coatria.com` through the worker host's secret manager or private process environment. Protect its durable state directory as described in [the runtime guide](../public/downloads/AGENT_RUNTIME.md). Neither provider keys nor Coatria agent tokens belong in this JSON example, source control, browser storage, company messages, vLLM prompts or the inference container's environment. The model container does not need the account API key to answer requests.

The Coatria installation supplies the reviewed provider `runpod`, exact model ID, character and capability grants. Begin with only the capabilities needed for the canary. Operator ceilings can reduce model steps, output tokens, total reported tokens and deadline using the existing `COATRIA_MAX_STEPS`, `COATRIA_MAX_OUTPUT_TOKENS`, `COATRIA_MAX_TOTAL_TOKENS` and `COATRIA_TIMEOUT_SECONDS` settings. See [provider setup](../public/downloads/PROVIDER_BRIDGES.md).

## Serving protocol and configuration

Use a **queue-based** endpoint. The Coatria bridge submits a native job and polls that same job ID:

```text
POST https://api.runpod.ai/v2/ENDPOINT_ID/run
GET  https://api.runpod.ai/v2/ENDPOINT_ID/status/JOB_ID
```

The submitted input is `{openai_route:'/v1/chat/completions',openai_input:requestBody}`. The pinned worker proxies the entire OpenAI body to vLLM on loopback, including tools and reasoning controls; Runpod authenticates callers. The bridge unwraps a single completed result, never automatically resubmits inference, retries only bounded transient status reads, and attempts to cancel a known unfinished job on interruption. Each HTTP exchange has its own deadline while the approved run deadline bounds the whole queue wait. The direct `/openai/v1/chat/completions` route remains compatible with external clients, but the baseline exposed a roughly five-minute HTTP header timeout during a longer cold start. Do not expose a separate unauthenticated vLLM HTTP port. [Runpod compatibility](https://docs.runpod.io/serverless/vllm/openai-compatibility), [pinned proxy source](https://github.com/runpod-workers/worker-vllm/blob/v2.27.0/src/handler.py)

The Qwen recipe uses **`qwen3_xml`** for automatic tool calls and **`qwen3`** for reasoning. The selected configuration has 32,768 context tokens, one GPU, two maximum sequences and one admitted Runpod request per worker. It disables the vision tower and does not use speculative decoding. The L40S selection uses pool `ADA_48_PRO` with CUDA 13.0 minimum and excludes the other GPU types listed in the example. This is not a throughput claim for a 50-person company. [vLLM recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B)

`MAX_NUM_BATCHED_TOKENS=2048` and `ENABLE_CHUNKED_PREFILL=true` split longer prompts into prefill batches without reducing the configured context window. `VLLM_DEEP_GEMM_WARMUP=skip` skips that kernel's prewarm on supported GPUs; L40S uses a different kernel, so this setting does not explain its startup time. Keep compilation and CUDA graphs enabled initially. Eager mode is a separate startup/throughput experiment, not part of the measured preset. [vLLM batch scheduling](https://docs.vllm.ai/en/v0.29.0/configuration/optimization/), [warmup implementation](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/model_executor/warmup/kernel_warmup.py#L161)

There are two release-specific configuration details:

- `LANGUAGE_MODEL_ONLY` and `DEFAULT_CHAT_TEMPLATE_KWARGS` are absent from the wrapper's environment allowlist. Pass `--language-model-only` and `--default-chat-template-kwargs` through `VLLM_EXTRA_ARGS`, as in the example.
- Use `ENABLE_LOG_REQUESTS=false` and `ENABLE_LOG_OUTPUTS=false`. The old `DISABLE_LOG_REQUESTS` flag is removed. Keep remote-code trust and request-supplied chat templates disabled.

The wrapper parses extra arguments as arguments, then launches vLLM without a shell. These are operator-authored deployment settings, never model-controlled strings. [Pinned argument mapping](https://github.com/runpod-workers/worker-vllm/blob/v2.27.0/src/args_builder.py)

Qwen's default reasoning effort is `xhigh`; the preset explicitly selects **low reasoning** with thinking and reasoning preservation enabled. This encourages shorter reasoning but does not impose a reasoning-token ceiling or guarantee better overall task latency. Preserve response `reasoning` or legacy `reasoning_content` privately across tool turns, without publishing raw reasoning to company chat. vLLM 0.29 accepts the legacy input field and normalizes it. Require a complete final answer or valid tool call; a length-truncated response is not success. [Qwen thinking controls](https://huggingface.co/Qwen/Qwen3.8-27B), [vLLM request protocol](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/entrypoints/openai/chat_completion/protocol.py)

## Cost and lifecycle controls

The current Runpod pricing page lists the selected 48 GB Serverless tier at **US$1.75 per GPU-hour** and the H100 alternative at **US$4.79 per GPU-hour**. Forty billed minutes would be approximately **US$1.17** or **US$3.19** of compute respectively, plus storage and applicable account charges. Check the account's current quote before starting: these estimates are neither a guaranteed invoice nor a hard spending cap. [Current pricing](https://www.runpod.io/pricing)

Startup, model loading, execution and idle shutdown time are billable. The reference uses an 80 GB container disk and **no new network volume**. Container storage is approximately US$0.10/GB/month, billed in five-minute intervals. A persistent network volume would continue incurring storage charges and is intentionally omitted. [Billing semantics](https://docs.runpod.io/serverless/pricing)

| Stage | Minimum workers | Maximum workers | Purpose |
| --- | --- | --- | --- |
| Prepared / paused pending release | 0 | 0 | No workers admitted; verify the provider reports zero remaining workers |
| Supervised trial | 0 | 1 | One GPU at most; 30-second idle timeout; external teardown deadline |
| Approved on-demand operation | 0 | 1 initially | Scale to zero between requests; increase only after measured demand and cost review |

Use a 600-second execution timeout and an independent 40-minute trial deadline. On expiry, stop dispatching, cancel owned pending jobs, disable the endpoint, and verify workers actually stop. A local watchdog is best-effort and can fail if its host loses connectivity; account controls and post-test billing verification remain necessary. Setting maximum workers to zero does not reverse charges or already committed work.

The completed pilot was stopped with minimum and maximum workers at zero; provider inspection confirmed zero total and running workers. The reference remains disabled pending the release decision. Do not confuse minimum zero with disabled: an endpoint with maximum one can start a billed worker when a request arrives. Token limits do not cover GPU download, startup or idle costs.

## Measured pilot results

On September 17, 2026, the final L40S run passed **17 checks** across **two mission cycles** using real Runpod inference and the real Coatria worker/API handlers against an isolated in-memory SQL database. It created one task, submitted it for independent human review, and made no duplicate task or submission in the second cycle. The task remained in `review`, unapproved. Exactly two write receipts were recorded: `tasks_create` and `tasks_submit`. Both cycles received the seeded hostile conversation, with no forbidden tool attempts or unrelated administrative writes observed.

The 17-check suite includes deterministic unknown-tool, uncertain-recovery and budget probes alongside live model behavior and real API authentication/capability checks. Role/status assertions use expected text markers and persisted task state; they do not certify checklist quality or general truthfulness. The second scheduled cycle used a test-clock advance. These distinctions matter: this was not a long-running scheduler or concurrency test, and one hostile message is not a general prompt-injection guarantee.

| Observation | H100 baseline | Selected L40S pilot |
| --- | --- | --- |
| Suite checks passed | 15 | 17 |
| Model requests | 6 | 7 |
| Reported total tokens | 27,002 | 31,243 |
| First request elapsed, including queue/startup wait | 183.718 seconds | 290.918 seconds |
| Subsequent request elapsed range | 4.534–6.179 seconds | 11.289–17.802 seconds |
| Recorded status polls | Direct HTTP transport | 338 polls, separate from 7 inference submissions |

The final L40S mission completed in 374.127 seconds overall. Its first request included 276.126 seconds of provider queue/start delay. A separate synthetic retrieval probe correctly recovered the target from **18,047 prompt tokens in 10.293 seconds**, with a complete response. This verifies that tested context length; the configured 32,768-token maximum and simultaneous long requests still need capacity testing. The pilot allowed 2,048 output tokens per response and 600 seconds per cycle. Its installation approved 100,000 total tokens per cycle, but the private worker ceiling reduced the effective limit to **80,000**. The marketplace preset also defaults to an 80,000-token allowance. The original evidence's `limits` field describes the approved installation settings, not this additional operator reduction.

An earlier L40S attempt failed the strict two-receipt workflow because the model added a `tasks_claim` write. The mission was clarified to name its only allowed writes and explain that a new task already belongs to its run. The receipt assertions were not weakened; the final run passed. Server permissions remain authoritative, and this result does not make a prompt-only restriction an authorization boundary.

These are individual pilot observations, not a controlled GPU benchmark: hardware, transport, configuration, mission wording and generated output differed. The lower L40S hourly price does not by itself establish a lower cost per completed task. Sanitized summaries are published here; raw evidence, synthetic IDs and account configuration remain in ignored local artifacts. No provider credentials or production company data are included.

## Acceptance gates

Use an isolated company/database with synthetic records and real Coatria API handlers. Record the exact model revision, image digest, endpoint configuration and timestamps alongside sanitized evidence. The bounded pilot above passed; repeat and extend these gates before unattended production use.

1. Verify authenticated model discovery, bounded completion, tool parsing and both reasoning field formats. Reject malformed, unknown, duplicate or truncated tool calls before effects.
2. Run an employee mission through the real claim, lease, tools and completion path: inspect workspace, create a task, submit it for human review, and accurately report the result in character.
3. Run a second cycle and verify persisted task state prevents duplicate work. Test lost completion responses and uncertain execution without starting a fresh unreviewed model run.
4. Challenge permissions with untrusted conversation/tool instructions, out-of-scope actions, revoked grants and cancellation. Check recorded effects, not only the model's refusal text.
5. Verify tenant isolation, separate agent identities and lease fencing using deterministic server tests. A successful model response cannot prove those boundaries.
6. Measure elapsed time, queue/start delay, model calls, reported usage, tool receipts, failures and final GPU shutdown. Separate a small live-model canary from simulated API-load testing; neither establishes worldwide production capacity.

## Workplace harness evolution

The product direction draws on Codex and Claude Code for task execution, Hermes for reusable procedures, and OpenClaw for bounded coordination. This is an implementation roadmap, not a claim of feature parity, shared internals or installed third-party harnesses. Existing Coatria Codex/Claude adapters and the direct Runpod bridge remain distinct execution options.

| Stage | Concrete behavior | Release gate |
| --- | --- | --- |
| Reliable employee | Stable role and AI identity, authorized tools, durable task receipts, bounded missions, precise status | Bounded pilot passed; broader acceptance gates above remain required for production |
| Planner and executor | Planner proposes task decomposition; server records dependencies and approved assignees; executor receives only its task scope | Durable parent/child state, bounded fan-out, aggregate budgets and cancellation; no privilege inheritance by prose |
| Independent reviewer | A separate identity reviews evidence and requests changes; protected actions still use authorized human approval | No self-approval, provenance for every decision, revision checks and review-quality evaluations |
| Reusable skills | Suggest a versioned procedure after verified work; employee owns private skills; only explicitly shared procedures enter company context | Consent, data ownership, redaction, provenance, rollback and poisoned-memory tests |
| Continuous operations | Supervised workers execute approved missions with dashboards for results, blocked work and resource costs | Measured service objectives, incident controls, recovery drills and provider-capacity testing |

Hermes documents procedural skills and optional review before writes; OpenClaw documents isolated delegated sessions and tool policies that narrow downstream access. Coatria should adopt the underlying principles while enforcing its own ownership and API contracts. Do not import executable skills, broad shell access or agent-written policies automatically. [Hermes skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md), [OpenClaw subagents](https://docs.openclaw.ai/tools/subagents), [OpenClaw tool boundaries](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools)
