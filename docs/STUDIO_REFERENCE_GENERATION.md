# Reference-to-generation continuations

This candidate adds migration 049 and an explicit `referenceGenerationContinuations` coordination option. It is not a production deployment or evidence of paid generation. Existing policies default to false; saved mission prompts and existing references are not rewritten.

## Workflow

1. A current generation specialist reserves its assigned task and uses `project_image_preparation_reference` with a verified derivative. The server records the exact original, derivative, task, producer, coordinator and policy in an immutable handoff.
2. The specialist completes successfully and reports that inspection and sharing are pending. Its ended lease cannot perform more work.
3. A human administrator adopts one inspection attempt through `POST /api/companies/{companyId}/higgsfield/references/{referenceId}/adopt-generation-inspection`. Explicit consent names the current reference revision, request hash and handoff hash. The window is at most 60 minutes and cannot exceed the original inspection or authority deadline. Retrying cannot extend it.
4. Inspection evidence permits a separate review of rights and sharing. The existing sharing approval, unchanged-byte transfer and provider confirmation remain required. Inspection adoption does not grant any of these permissions.
5. A new coordinator cycle reads `studio_reference_generation_followups_get`. For an eligible confirmed reference, `studio_reference_generation_followup_dispatch` creates one fresh specialist under the same finite lifetime/concurrency limits.
6. The specialist receives `referenceGenerationFollowup` context. `studio_reference_generation_followup_advance` first claims the exact task and then proposes generation. The server owns the claim/proposal IDs, task revisions and sole reference. The model supplies only the generation tool, arguments and note. Changing harness transport IDs does not duplicate work; changing a saved proposal conflicts.
7. Successful completion requires an actual saved proposal. Human credit consent and provider execution remain separate. Once the generated output is independently archived and verified, the existing archive continuation registers and submits it for independent media review. It preserves the actual generation producer and separately records the registrar.

Generated coordinator objective v6 discovers the new continuation only when its policy flag is enabled. Existing saved missions require an explicit edit before they use this objective.

## Boundaries

The fresh child can read only its assigned work, exact reference, exact proposal and safe company model metadata, or advance its two server-owned steps. It cannot directly mutate tasks, replace the reference, transfer files, generate, approve, delegate or accept delivery. Its run has one attempt. Failed, cancelled and expired children are not automatically replaced.

An immutable claim receipt permits exactly one task reservation/revision transition from the completed producer to its successor. Project content revisions, task text, assignment, storage binding, original/derivative identity, provider connection, current sponsors and policy remain pinned. Dispatch and claim have separate durable receipts and do not change the project content revision. Historical receipts do not extend current authority.

Final commit checks retain the source locks until the transaction ends. An overlapping authority operation returns `REFERENCE_GENERATION_AUTHORITY_BUSY` and rolls back; it does not cancel the child or authorize a replacement. The worker retries this exact error with the same request body and IDs, at most three HTTP attempts. Other 409 responses retain their existing handling. Both the current policy and reference-sharing deadlines are rechecked after awaited work.

Candidate/history pages have independent `after` and `historyAfter` cursors. The human read route is `GET /api/companies/{companyId}/studio/projects/{projectId}/reference-generation-followups`; all three operations also use the ordinary authenticated external agent tool API and lease envelope. OpenAPI includes inputs, outputs and optional context. Direct providers, MCP, Codex and Claude adapters use the same restricted tool catalog.

## Deployment and evidence

Apply migration 049 and the reviewed permission templates with their matching binaries. The reference broker receives only the adopted source view and bounded handoff/consent facts; it does not gain raw preparation or OAuth access. A guarded `studio_profiles.updated_at` lock permission permits `FOR SHARE` but rejects actual writes. The storage gateway receives only `company_id` and `child_run_id` from the new continuation table so it can deny transfer for these children. Its exact permission verifier and migration floor must roll out together with that grant.

Fixtures exercise real control-plane services from preparation/handoff to inspection adoption, confirmation, fresh dispatch, claim, proposal, completion and archive registration/submission. Their transform, upload, provider-generation and archive byte facts are explicitly synthetic. Separate byte-processing qualification and the live client-to-delivery pilot are required before claiming production acceptance. No migration or policy save enrolls a worker, starts inference, purchases infrastructure or spends provider credits.
