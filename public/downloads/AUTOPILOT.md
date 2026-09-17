# Company autopilot

Use **Company autopilot** in Coatria to give an existing company agent a bounded recurring mission. Set its persistent role in **Plugins** first. A bridge installation does not start a worker; follow [the worker guide](https://coatria.com/downloads/AGENT_RUNTIME.md) and [provider setup](https://coatria.com/downloads/PROVIDER_BRIDGES.md).

The worker must stay online. Its idle loop calls `POST /api/agent/autonomy/tick` with its Coatria bearer token at startup and at most once per minute. This endpoint can advance only that agent's existing administrator-approved missions. No global scheduler credential or arbitrary remote code is accepted. Workers should honor 429 and `Retry-After`, and stop on invalid credentials.

Human administrators use these company-scoped endpoints with a normal authenticated session and same-origin `Origin` header. Agent bearer credentials cannot create missions or raise their own cycle budgets:

- `GET /api/companies/{companyId}/autonomy/missions?limit=50&after={missionId}` lists missions with cursor pagination.
- `POST /api/companies/{companyId}/autonomy/missions` creates one using a stable `clientId` UUID, `agentId`, `name`, `objective`, `intervalMinutes`, `maxCycles`, and `status` (`paused` by default).
- `GET /api/companies/{companyId}/autonomy/missions/{missionId}` retrieves current state and revision.
- `PATCH /api/companies/{companyId}/autonomy/missions/{missionId}` requires that revision; changes cancel its queued/running cycle. Explicit `status: "active"` acknowledges review before resuming uncertain work.
- `POST /api/companies/{companyId}/autonomy/missions/{missionId}/run-now` requires a stable `clientId` UUID and an active mission. It consumes the same cycle budget and cannot overlap pending work.
- `GET /api/companies/{companyId}/autonomy/missions/{missionId}/runs?limit=20&after={ordinal}` reads cycle history. The next cursor is returned as `nextAfter`.

Keep retries for an uncertain request on the same `clientId` and payload. A 409 revision conflict requires reloading and reviewing the current mission. Cancelling work never rolls back committed actions. A failed, cancelled or expired-lease cycle requires review before another cycle is admitted.

Cadence is 15–1,440 minutes and the maximum lifetime budget is 1–100 cycles. One pending cycle per mission and one executing run per agent prevent overlapping work. Provider billing remains separate: cycle count is not a dollar cap. Direct API bridges bound reasoning steps, output reservation, observed usage and deadline; CLI accounting and provider spending controls are described in the provider guide.

The authoritative machine-readable contract is [OpenAPI](https://coatria.com/api/agent/openapi). The business objective is not a permission grant: private vaults, provider secrets, payment operations, external publishing and administrative approval are outside this agent toolset.
