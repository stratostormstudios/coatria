# Jev placement in Coatria

Design recommendation, researched 2026-09-20. This document does not install a
provider, enable inference, send company data, or create new agent permissions.

## Recommended responsibility

Use Jev as an optional decision service inside the harness orchestrator. Its
initial jobs should be flagging incomplete planning handoffs, then recommending
the department and relevant skills for an incoming request. The project manager
remains responsible for the brief, plan,
dependencies and acceptance criteria; specialist agents execute the work with
their configured reasoning or generation providers.

| Layer | Proposed Jev use | Execution owner |
| --- | --- | --- |
| Request intake | Classify the department and missing brief fields | Existing intake and project manager |
| Skill discovery | Rank an already authorized shortlist of skills | Existing agent and skill policy |
| Model selection | Recommend routine versus complex work after evaluation | Provider adapter and tenant model policy |
| Review triage | Flag uncertainty or evidence gaps for a reviewer | Technical validators and independent reviewer |
| Office presence | Later, choose among allowed idle/social actions on events | Presence state machine and activity records |

The initial pilot should flag missing information in already saved planning
handoffs, without changing their review decisions. The next pilot is request
routing: it is measurable, frequent and reversible. A client asking to revise
the soundtrack should be routed to
audio; an ambiguous request should produce an explicit abstention. A visually
active avatar must still reflect actual task state: Jev must not fabricate work,
progress, client approval or evidence.

## Safe execution path

1. Authenticate the request and compute the tenant's permitted candidate set.
2. Build a minimal text state with the brief, task metadata and approved skill
   descriptions. Exclude credentials, private employee skills without consent,
   unrelated conversations and media bytes.
3. Ask atomic questions with fixed options, including `uncertain` and
   `none_of_the_above`. Keep separate dimensions separate.
4. Run inference outside database lock transactions. Record the recommendation,
   model version, policy version, candidate-set hash,
   probabilities, latency and usage in a bounded tenant-scoped audit record.
   Do not log raw confidential prompts by default.
5. In observation mode, run the existing workflow unchanged and compare its
   outcome with the recommendation. No assignment, provider choice or tool call
   is changed by this mode.
6. After a measured pilot, optionally apply approved low-risk routes. Recheck
   current role, task, skill, budget and provider permissions before execution.
   Uncertainty, timeout, schema failure or provider outage uses the existing
   route or asks the project manager to resolve ambiguity.

Jev recommendations never expand capabilities, enable a plugin, choose an
unapproved provider, approve spending, accept a deliverable or grant file access.
They cannot substitute for full media decoding, byte hashes, immutable evidence,
independent QC or client acceptance. Type-safe output can still be a wrong
decision. Model confidence is not a universal probability of correctness and
must be evaluated on Coatria's own task distribution.

## Existing integration points

- `studio-review-policy.ts:getStudioPlanningReview/readStudioPlanningReview`
  expose immutable planning submissions for advisory checks. Keep
  `decideStudioPlanningReview` as the authorized decision path.
- `agent-tools.ts:studioAgentProject`, `studio.ts:workItems` and
  `studio-coordination.ts:studioCoordinationSnapshot` provide bounded work and
  policy context. Rank only eligible ready work; `dispatchStudioWork` retains
  dispatch authorization and the current coordinator remains the fallback.
- `studio-staffing-protocol.ts:draftStudioStaffing` and
  `studio-staffing.ts:proposeStudioStaffing` are a later seam for staffing advice
  before an administrator approves the exact plan hash.

These are proposed seams, not installed Jev integrations. A separate advisory
record/service would still need implementation and qualification. In particular,
`public/downloads/provider-adapter.mjs:providerConfiguration` reads one installed
model, and `studio-inference.ts` pins the managed model and configuration hash.
Automatic model substitution during a run is not supported by this design;
cost-based model routing needs its own approved provider-policy extension.

## Evaluation and rollout

Start with a labeled set of real, consented or synthetic production briefs,
including overlapping departments, multiple intents, incomplete information,
unavailable skills, hostile instructions and multilingual requests. Split the
set into tuning and held-out evaluation data. Compare with the current router
and a simple deterministic baseline.

Measure routing precision per department, abstention coverage, harmful
misroutes, false confidence, end-to-end p50/p95 latency and total cost including
fallback calls. Report confidence intervals and failures, not only an overall
accuracy score. Choose activation thresholds from the required error tolerance
and held-out results; do not ship the example thresholds in vendor docs as
universal defaults.

Use per-company opt-in, an explicit data-processing decision, model-version
pinning where supported, bounded retries, a timeout, a circuit breaker, usage
limits and an immediate switch back to the existing route. A successful routing
pilot does not qualify autonomous QC, payments, hiring or client publication.

## Sources and limits

- [TypeSafe introduction](https://docs.typesafe.ai/introduction): Jev returns
  Choice, Score and Noul results from state and typed questions; it does not
  generate prose or code. Atomic questions are composed by application logic.
- [Confidence](https://docs.typesafe.ai/confidence): Choice and Score confidence
  is derived from their returned distributions; Noul has no separate confidence.
  Thresholds need domain-specific evaluation.
- [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev):
  launched in early access on September 15, 2026. The vendor quotes $0.042 per
  million input tokens and 70–500 ms response times. These are published vendor
  claims, not Coatria measurements or a service-level guarantee.

Use the official provider or an explicitly reviewed gateway when evaluating.
No Jev account, paid subscription, inference call or production dependency has
been added as part of this recommendation.
