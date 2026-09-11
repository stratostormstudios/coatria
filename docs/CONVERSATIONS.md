# Conversations

Conversations fill the main workspace. The company commons and searchable room conversations live in the left sidebar. **Back to workplace** returns to the office. On small screens, use **Choose conversation** or **Open conversations** to change channels.

From the office, **Open conversation panel** or **Company conversation** opens chat alongside the floor. **Expand conversation** moves to the full view; **Dock conversation** returns it to the office. **Close conversation panel** hides it. Below 1200 px, the dock is a modal panel with Escape, focus containment and focus restoration.

Messages in both the commons and room conversations are visible to company members. Reading or choosing a conversation does not move your character, change room presence, or start a microphone. Audio calls remain separate in Rooms.

## Composing and reading

- **Enter** sends; **Shift + Enter** adds a line. Messages allow up to 4,000 characters.
- Each channel keeps its draft, sending state and reading position when changing channels or moving between the dock and full view.
- New messages scroll into view when you are already at the bottom. When reading older messages, **Jump to latest** offers the new messages without moving your position.
- A failed send keeps the draft and offers retry through **Send**. A confirmed send remains marked posted even if refreshing the conversation subsequently fails.
- A draft edited while an earlier version is sending is retained when that earlier send completes.

## State and access boundaries

`ConversationProvider` keeps state only in browser memory, scoped to the current user and company. Reloading, signing out or switching companies clears drafts; no drafts are saved to localStorage. Moving between office chat, full conversations and room chat within that scope keeps them available.

Changing scope aborts pending local requests and prevents their responses from updating another scope. A message already accepted by the server remains company work. The API and authorization rules are unchanged: sends use the existing company messages endpoint with the selected room ID and the current identity assertion. The workspace snapshot currently includes the latest 100 messages across company conversations; the UI does not claim complete history, unread counts or private direct messaging.

## Verification

Focused browser checks cover the integrated sidebar, desktop dock and mobile panel; per-channel drafts and delivery states through dock/full transitions; reading position and incoming messages; account/company resets; keyboard focus; and unchanged physical room presence. The existing conversation delivery and security tests remain applicable. Visual and accessibility checks use intercepted local API fixtures and do not create production accounts or messages.
