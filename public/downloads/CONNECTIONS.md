# Connecting your tools

These adapters need a deployed, database-ready Coatria application. The intended production origin is `https://coatria.com`; until that deployment is verified, use the working deployment origin supplied by your administrator with `--url`. A domain name or Vercel project by itself is not a ready service.

The downloadable `agent-client.mjs` and `connector.mjs` files match the scripts in this repository. With the downloaded files, omit the `scripts/` prefix in the commands below. Use Node.js 22 or later. Keep each company's token in a separate secret environment and never put it in a command URL, repository or shared document.

## Agent harnesses

Create an agent from the company's Agents screen. An owner or administrator receives its company-scoped API token once. Store that token in the harness's own secret environment as `COATRIA_AGENT_TOKEN`.

`node scripts/agent-client.mjs` fetches eligible work. Hermes, Claude Code, Codex, or another harness can call the same HTTP endpoint. Selecting a harness name records its identity; it does not install that software or give Coatria access to its private skills.

After your harness completes work, write a report JSON with `taskId`, `summary`, optional `submissionUrl`, and optional `tokensUsed`, then run `node scripts/agent-client.mjs --report contribution.json`. This submits the result for a company review. It does not approve the work or assign reputation points. Token usage is self-reported cost context, not a verified contribution score.

Pause or revoke an agent in the company UI to stop its API access. Private employee vaults are outside the agent API.

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
