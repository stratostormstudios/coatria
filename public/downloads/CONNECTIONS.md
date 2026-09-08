# Connecting your tools

These adapters need a deployed, database-ready Coatria application. The production origin is `https://coatria.com`. Its 2026-09-08 security update passed 39 live API checks and 16 production browser checks. Use the origin and version confirmed by your administrator with `--url`. See [release status](https://github.com/stratostormstudios/coatria/blob/main/docs/RELEASE_STATUS.md) for current evidence.

The downloadable `agent-client.mjs` and `connector.mjs` files match the scripts in this repository. With the downloaded files, omit the `scripts/` prefix in the commands below. Use Node.js 22 or later. Keep each company's token in a separate secret environment and never put it in a command URL, repository or shared document. Both clients reject redirects and require an HTTPS origin, except for loopback HTTP during local testing. A redirect is a connection error; update `--url` to the administrator-confirmed destination instead of forwarding credentials through it.

## Agent harnesses

Create an agent from the company's Agents screen. An owner or administrator receives its company-scoped API token once. Store that token in the harness's own secret environment as `COATRIA_AGENT_TOKEN`.

`node scripts/agent-client.mjs` fetches eligible work. Hermes, Claude Code, Codex, or another harness can call the same HTTP endpoint. Selecting a harness name records its identity; it does not install that software or give Coatria access to its private skills.

After your harness completes work, write a report JSON with `taskId`, `summary`, optional `submissionUrl`, and optional `tokensUsed`, then run `node scripts/agent-client.mjs --report contribution.json`. This submits the result for a company review. It does not approve the work or assign reputation points. Token usage is self-reported cost context, not a verified contribution score.

Pause or revoke an agent in the company UI to stop its API access. Private employee vaults are outside the agent API.

An agent remains subject to its sponsoring account's current company permissions. Its creator cannot offer it to a new engagement after losing the required owner/admin role. Accepted work must be reviewed by an administrator who is outside the recorded author/sponsor set; reopening a task does not erase its earlier authors.

## Existing servers and shared drives

Create a BYO server connection in Infrastructure. On the machine that can access the approved folder, set `COATRIA_CONNECTOR_TOKEN` to its one-time token and run:

```sh
node scripts/connector.mjs --root /approved/project-folder
```

The connector makes outbound HTTPS requests. No public listening port is opened. This release indexes relative paths, file sizes and modification dates for up to 1,000 files. It does not upload or serve originals, follow symbolic links, or scan hidden folders. Company members can browse the index in Coatria. Keep the connector running for fresh status.

The approved folder is selected by the person running the connector. Choose a project-specific root; visible filenames can themselves be sensitive. The connector skips hidden entries and dependency folders and rejects an index that exceeds its file, path or depth limits. It never sends a partial scan as a successful full index. No operating-system file mount or inbound server connection is created.

For local testing, add `--url http://127.0.0.1:4180 --once`. Production defaults to `https://coatria.com`.

Large-file transfer, edit proxies, signed download capabilities and managed paid servers require the next infrastructure release. Indexing does not make private footage downloadable by teammates.

## Room calls

Room calls use WebRTC peer connections and authenticated company-room signaling, with a maximum of six active participants or the room's lower capacity. Browsers request microphone permission on Join and screen selection on Share. Navigating away tears down capture and peer connections. A screen-picker result opened for an earlier room cannot attach to a later call. Loss of company access or expired authorization stops local capture.

For reliable connections across restrictive networks, configure a TURN service in Vercel with `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL`, then redeploy. These are relay credentials, scoped for client use; use a provider account with usage limits and rotate credentials. Without TURN, calls use direct connectivity and cannot guarantee connections across all networks. Auditorium broadcasts and large conferences require an SFU media service in a subsequent release.

## Operator credentials and company access

Company integration tokens are not Vercel, Neon, Meshy or database-owner credentials. Keep provider credentials outside employee harnesses and connectors. Rotate the Vercel and Meshy keys shared during project setup; do not reproduce their values in connection reports.

The production application uses the restricted `coatria_runtime_v1` login as a production-only Vercel Secret `DATABASE_URL`, verified through live API checks. Neon remains provisioned, automatic environment injection is detached, and owner-credential aliases have been removed from the project. Future migrations use a direct owner connection obtained separately from the Neon dashboard, followed by any updated explicit runtime grants. Role provisioning is first-time setup only; do not repeat it for the existing production login. Changing project variables affects new deployments; older deployments using owner credentials also need retirement or credential invalidation. Follow the [security review](https://github.com/stratostormstudios/coatria/blob/main/docs/SECURITY_REVIEW.md#production-database-separation) for the recorded cutover and remaining checks.

Public signup does not verify email ownership, and recovery, MFA and SSO are not enabled. Share ordinary single-use invitation links directly with the intended person. Email-restricted invitations cannot be satisfied by merely registering that email; hiring invitations are tied to the reviewed account. Offboarding invalidates older invitations, and re-entry requires a newly issued invitation.
