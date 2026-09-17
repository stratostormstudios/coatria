# Provider bridges: verified choices and readiness

Research checked September 16, 2026. Prices are USD per million tokens, before taxes and provider-specific terms. They are reference prices, not a Coatria quote or spending guarantee. Model access, limits and availability still depend on the operator's account.

## Recommended initial routing

Use Fireworks for the requested Qwen3.8 integration. Its **Qwen3.8 Max** page explicitly lists serverless access and function calling, with model ID `accounts/fireworks/models/qwen3p8-max`. Published input/cached-input/output pricing is **$2 / $0.25 / $6**. This is a capable tier, not the cheapest model. A managed endpoint avoids operating GPU replicas during the pilot. [Fireworks model card](https://fireworks.ai/models/fireworks/qwen3p8-max)

For an economical tool-using worker, Together lists **`Qwen/Qwen3.5-9B`** at **$0.17 input / $0.25 output**, with function calling marked supported. Its catalog also lists **Qwen3.8 Flash** at **$0.15 / $0.47**, but the function-calling column is unspecified. Do not silently route agent actions to that model until a paid canary and task evaluations validate it. The Qwen3.8 name is real; it was not mistaken for Qwen3 8B. [Together serverless catalog](https://docs.together.ai/docs/serverless/models)

Runpod is the infrastructure option when operators want to choose weights, GPUs and serving configuration. Its documented vLLM compatibility path is `https://api.runpod.ai/v2/ENDPOINT_ID/openai/v1`. Coatria accepts only the endpoint ID from the private worker environment; no user-selected HTTP host is accepted. Operators must validate the deployed model's tool parser, chat template, quantization, concurrency, cold-start behavior and license. A Runpod deployment is not automatically a supported Qwen3.8 model. [Runpod compatibility guide](https://docs.runpod.io/serverless/vllm/openai-compatibility)

## Provider protocols

| Bridge | Protocol / model examples | Readiness evidence |
| --- | --- | --- |
| OpenAI / Astra | Responses API; catalog-reviewed `gpt-6-astra` | Protocol fixtures; account/model canary required |
| xAI / Grok | Responses API; `grok-4.6` | Official function-calling examples; protocol fixtures |
| Anthropic | Messages API; `claude-sonnet-5`, `claude-opus-5`, `claude-haiku-4-5-20251001` | Official model IDs; protocol fixtures |
| Fireworks / Qwen | Chat Completions; `accounts/fireworks/models/qwen3p8-max` | Model card confirms function calling; protocol fixtures |
| Together / economy | Chat Completions; `Qwen/Qwen3.5-9B` | Catalog confirms function calling; protocol fixtures |
| Runpod / operator deployment | OpenAI-compatible Chat Completions | Protocol fixtures; operator must certify its model endpoint |
| Claude Code | Restricted local CLI + Coatria MCP | Installed 2.1.248 `--version` and `--help` verified; process fixtures; no authenticated inference run |

xAI currently documents Grok4.6 function calling through Responses. The adapter uses `store:false`, supplies its own bounded history and does not enable hosted web or code tools. Retention obligations beyond that flag remain governed by the provider agreement. [xAI function calling](https://docs.x.ai/developers/tools/function-calling), [Responses reference](https://docs.x.ai/developers/rest-api-reference/inference/responses)

Anthropic's current IDs include Sonnet5, Opus5 and dated Haiku4.5. The adapter preserves thinking/signature blocks across tool turns and selects text by block type. It does not send temperature overrides or manual thinking budgets, which current models may reject. [Anthropic model overview](https://platform.claude.com/docs/en/models/overview), [Sonnet5 migration](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide)

Claude Code uses its CLI permission system and Coatria MCP together. `--restricted`, an empty built-in tool list, `--strict-mcp-config`, explicit allowed MCP names and `dontAsk` avoid broad permission bypass. `--bare` disables ambient customizations and requires an API key rather than saved consumer OAuth. Managed machine policy remains an operator responsibility. [CLI reference](https://code.claude.com/docs/en/cli-reference), [MCP permissions](https://code.claude.com/docs/en/agent-sdk/mcp)

## What is and is not demonstrated

The HTTP bridge tests complete a tool-call/result cycle for all six providers using local fixtures. They exercise cancellation, credential containment, redirects, malformed output, repeated tool IDs, parallel-call bounds, token limits and provider failures. Claude process fixtures exercise restricted arguments, MCP readiness, output parsing, cancellation, timeouts and observed usage limits.

No paid inference was sent to these providers during implementation. A fixture proves wire handling, not provider availability, intelligence, latency, regional compliance or cost efficiency. Before enabling a bridge for unattended company missions, run a small approved account canary, evaluate real tasks, set provider account spend alerts/limits, and monitor authorization failures and incomplete runs. There is no automatic cross-provider fallback: such a fallback would change data recipients and cost without the installation review.

These are Coatria-owned bridges, not vendor-published plugins or a way to execute Slack plugin packages. External marketplace package ingestion, vendor OAuth, signed third-party submissions and supplier certification are separate capabilities.
