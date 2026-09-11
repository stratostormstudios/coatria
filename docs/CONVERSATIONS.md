# Conversations

Conversations fill the main workspace. The company commons and searchable room conversations live in the left sidebar. **Back to workplace** returns to the office. On small screens, use **Choose conversation** or **Open conversations** to change channels.

From the office, **Open conversation panel** or **Company conversation** opens chat alongside the floor. **Expand conversation** moves to the full view; **Dock conversation** returns it to the office. **Close conversation panel** hides it. Below 1200 px, the dock is a modal panel with Escape, focus containment and focus restoration.

Messages in both the commons and room conversations are visible to company members. Reading or choosing a conversation does not move your character, change room presence, or start a microphone. Audio calls remain separate in Rooms.

## Composing and reading

- **Enter** sends; **Shift + Enter** adds a line. Messages allow up to 4,000 characters.
- Each channel keeps its draft, sending state and reading position when changing channels or moving between the dock and full view.
- New messages scroll into view when you are already at the bottom. When reading older messages, **Jump to latest** offers the new messages without moving your position.
- Unconfirmed delivery keeps the draft and offers **Retry original message**, preserving that send's client UUID and content. A confirmed send remains marked posted even if refreshing the conversation subsequently fails.
- A draft edited while an earlier version is sending is retained when that earlier send completes.

## State and access boundaries

`ConversationProvider` keeps state only in browser memory, scoped to the current user and company. Reloading, signing out or switching companies clears drafts; no drafts are saved to localStorage. Moving between office chat, full conversations and room chat within that scope keeps them available.

Changing scope aborts pending local requests and prevents their responses from updating another scope. A message already accepted by the server remains company work. The new conversation service uses per-channel paginated history and a durable event cursor instead of the workspace snapshot's latest100 messages. Sending requires a stable client UUID; retrying the same logical send returns the original message. Threads, own-message revision checks, deletion tombstones, reactions and personal read markers use the same transactional service. External agents have explicit none/read/write permissions and visible agent authorship. Existing credentials default to none. See [the harness guide](../public/downloads/CONVERSATIONS.md) and [the reliability plan](CONVERSATION_RELIABILITY_PLAN.md).

The old `/api/companies/:id/messages` endpoint and workspace message snapshot remain compatibility surfaces for older clients. Only the new conversation API provides durable cursors and full channel pagination. The migration's invoker trigger lets the previous deployment keep writing during rollout or rollback. Apply migration007 and grants for the five new conversation tables in the same owner transaction. It must never be rolled back by dropping message history. This release retains event metadata and idempotency receipts without automatic expiry; storage growth and future retention need operational monitoring.

## Verification

Focused browser checks cover the integrated sidebar, desktop dock and mobile panel; per-channel drafts and delivery states through dock/full transitions; reading position and incoming messages; account/company resets; keyboard focus; and unchanged physical room presence. The existing conversation delivery and security tests remain applicable. Visual and accessibility checks use intercepted local API fixtures and do not create production accounts or messages.
