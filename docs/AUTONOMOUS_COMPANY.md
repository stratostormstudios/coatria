# Coatria: operating a company with agents

The product direction is a company operating system: an owner defines the business and measurable outcomes; named AI colleagues retain their roles; Coatria organizes permissions, recurring work, contributions and review. The office makes activity visible, while the same operations remain available through the API.

## Implemented foundation

- **Plugins:** eight curated bridges for Codex, Claude Code, OpenAI, Anthropic, xAI, Fireworks, Together and Runpod. Versioned manifests specify permitted providers and models. Installation creates a scoped company identity; it does not purchase inference, connect a provider account, deploy a worker, or import arbitrary Slack plugins.
- **Character:** role title, responsibilities/persona and working style travel with every installed-agent request. The fixed adapter policy keeps task accuracy, permissions and explicit AI identity above roleplay. This preserves configuration, not a fabricated personal history or guaranteed personality consistency from a stochastic model.
- **Company autopilot:** administrators define missions, assign existing agents, choose a 15–1,440 minute cadence and authorize at most 100 total cycles. The interface defaults to a paused three-cycle mission. Templates cover operations, delivery and quality. These are editable responsibilities, not automatically recruited departments.
- **Autonomous dispatch:** an online worker checks its own approved missions at startup and at most once per minute when idle. Scheduling, cycle allocation and durable run creation commit together. There is no backlog of catch-up cycles, and a mission cannot overlap its previous pending cycle. Several missions for one agent execute sequentially through its existing queue.
- **Progress:** every cycle has actual queued/running/succeeded/failed/cancelled state, a persisted result and the existing committed-action receipts. Results appear in company conversations. Successful execution does not prove a business outcome or approve a contribution.
- **Control:** current sponsor, mission-author and agent authority are checked during execution. Permission/configuration changes fence stale workers. Mission changes cancel pending work; they cannot undo earlier effects. Failed, cancelled or expired-lease mission execution pauses for administrator review instead of starting another reasoning attempt automatically.

## A first company

1. Write one concrete business outcome and success measure. For example: “Prepare a reviewable launch plan and prototype for product X,” rather than “run a successful business.”
2. Install an operations lead and give it workspace read/task preparation capabilities. Configure its character in Plugins. Connect an operator-managed worker using the corresponding setup guide.
3. Create a short mission in Company autopilot, review its objective, set a small cycle count and activate it. Observe the first results and committed actions before expanding responsibility.
4. Add separate delivery and quality roles when useful. Their identities, workers, permissions and results remain distinct. Humans retain independent contribution approval and administrative decisions.
5. Pause or adjust missions when the business objective changes. Resolve ambiguous effects before resuming failed work. Enforce provider spending limits independently of Coatria cycle limits.

## Real execution evidence

On 2026-09-16, an actual Codex Sol worker completed two cycles against an isolated PostgreSQL-compatible test company using the real Coatria handlers, marketplace installation, durable worker and stdio MCP bridge. “Avery · AI operations lead” created exactly one launch-readiness task, submitted it for independent review, then recognized that same task on the second cycle and made no duplicate mutation. Two committed write receipts were recorded (`tasks_create`, `tasks_submit`), the task remained in `review`, and the mission completed at its two-cycle limit. The test advanced the due timestamp between cycles; it did not wait 15 minutes or modify production company data.

Other provider integrations have protocol and failure-path fixture coverage. Live model access, billing and tool behavior still require account-specific canaries. No provider key is entered in the browser or stored in Coatria's database by this release.

## Required before broader autonomous business operation

This release provides bounded recurring company work, not unattended control of arbitrary businesses. It does not yet provide automatically generated organization charts, dependency-aware multi-agent project planning, autonomous hiring, payment authority, outbound sales/email, production deployment tools, an always-on managed worker fleet, or cross-company personal-experience portability. Worker hosting is operator-managed; model credentials and spending controls must be supplied there.

The next engineering stages are durable company goals and departmental ownership; structured task dependencies and verified handoffs; scoped, separately authorized business connectors; provider usage/cost ledgers and hard admission budgets; isolated multi-tenant worker provisioning; evaluation of task quality and character consistency; and regional capacity/recovery exercises. Task value should be assessed by accepted outcomes and evidence, not token volume.

Before claiming a global production service, establish service objectives and alerting, backup/restore drills, incident response, queue and provider load testing, tenant-isolation testing, and measured capacity beyond the existing 50-session office test. A small controlled pilot is the appropriate deployment scope for the new autonomy layer.
