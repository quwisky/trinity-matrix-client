# Trinity — Everyday UX Polish Roadmap

A prioritized plan for the **daily-driver** experience: the small-to-medium improvements that make
Trinity feel finished to send-and-read-messages-all-day users. Grounded in an audit of the current
codebase (what's already shipped vs. genuinely missing).

**This track deliberately excludes** moderation/room-admin, verification/security breadth, voice/video
calls, and account management — those are separate directions. See [PLAN.md](PLAN.md) for the full
roadmap and the deferred items.

## What already exists (so we don't rebuild it)

Compose with Markdown, edit/redact, replies, reactions (toggle), threads (full lifecycle), pin/unpin,
GIFs, encrypted media (+ paste, thumbnails, progress), emoji picker + `:shortcode` autocomplete,
read **receipts sent** on view, retry/optimistic echo, member presence dots, quick-switcher + in-room
search. The gaps below are what's left for a polished daily experience.

## Prioritization

Ranked by **value ÷ effort** for a daily user. Effort: **S** = <1 day · **M** = a few days ·
**L** = ~1–2 weeks. Three waves, roughly in the order I'd build them.

| #   | Feature                                            | Size | Value | Why now                                             |
| --- | -------------------------------------------------- | ---- | ----- | --------------------------------------------------- |
| 1   | Per-room draft persistence                         | S    | High  | Fixes a real text-loss bug                          |
| 2   | Full emoji picker for reactions                    | S    | Med   | Closes an obvious limitation, tiny                  |
| 3   | Spoiler reveal (click-to-reveal)                   | S    | Med   | We already receive spoilers, just don't reveal them |
| 4   | Set your own presence + status                     | S    | Med   | Completes the presence feature just shipped         |
| 5   | @user / #room autocomplete + `m.mentions`          | M    | High  | Biggest composer gap; also fixes mention pings      |
| 6   | Typing indicators                                  | M    | High  | Baseline chat expectation, currently absent         |
| 7   | Unread "new messages" divider + jump-to-unread     | M    | High  | Orientation when returning to a busy room           |
| 8   | Per-room notification level (mute / mentions-only) | M    | High  | Everyday control; no home for it today              |
| 9   | Internal matrix.to link navigation                 | M    | High  | Clicking a room/user link should stay in-app        |
| 10  | "Seen by" read-receipt display                     | M    | Med   | Uses the existing avatar component                  |
| 11  | Message forwarding                                 | M    | Med   | Common action, missing from the toolbar             |
| 12  | Link / URL previews (E2EE-off by default)          | M    | Med   | Nice for public rooms; privacy-gated                |
| 13  | Polls (MSC3381)                                    | L    | Med   | Visible collaboration feature                       |
| 14  | Voice messages (record + waveform)                 | L    | High  | High-demand, but needs mic plumbing                 |

---

## Wave 1 — Quick wins (each lands in a day or few)

### 1. Per-room draft persistence — **S / High**

- **Problem:** the composer is one reused instance; its text signal isn't keyed to a room. The
  room-change effect clears only the _staged file_, not the text, so a half-typed message bleeds into
  the next room and is lost on reload. This is a bug, not just a gap.
- **Approach:** a small draft store — `signal<Map<roomId, string>>` mirrored to Capacitor Preferences;
  save on input (debounced), restore on room open, clear on send. Thread-aware (key by `roomId` +
  optional `threadId`).
- **Dependency:** none.

### 2. Full emoji picker for reactions — **S / Med**

- **Problem:** the reaction popover is hardcoded to 6 `QUICK_EMOJIS`; you can't react with anything else.
- **Approach:** add an "Add reaction" affordance that opens the `emoji-mart` `PickerComponent` (already a
  composer dependency) and sends the chosen emoji as an `m.annotation`. Keep the 6 quick ones as a fast path.
- **Dependency:** none.

### 3. Spoiler reveal — **S / Med**

- **Problem:** `data-mx-spoiler` survives sanitization but renders as plain text — spoilers aren't hidden.
- **Approach:** style spoiler spans as blurred/blacked-out and add click-to-reveal in the message renderer.
  Send-side spoiler syntax is an optional follow-up.
- **Dependency:** none.

### 4. Set your own presence + status message — **S / Med**

- **Problem:** we _display_ others' presence (shipped this cycle) but you can't set your own state or a
  custom status.
- **Approach:** an online / away / busy / offline control + status text in the user panel or settings,
  calling `setPresence({ presence, status_msg })`. Degrade gracefully where the homeserver disables/rate-limits
  presence; note "invisible" isn't standard Matrix.
- **Dependency:** `setPresence` (built-in).

---

## Wave 2 — Core chat expectations (each a few days)

### 5. @user / #room autocomplete + `m.mentions` — **M / High**

- **Problem:** no `@`/`#` autocomplete, and no send/reply content builder sets `m.mentions` — so mentions
  (and replies) don't reliably **ping** on homeservers keying off `m.mentions` (MSC3952) rather than
  body-scanning. The single biggest composer gap vs. Element.
- **Approach:** reuse the existing `:shortcode` autocomplete framework (keyboard nav + IME handling already
  solved); member/room sources are already in memory. Insert a `matrix.to` pill into `formatted_body` and add
  `m.mentions` to the send/reply/edit content builders in `message-content.ts`.
- **Dependency:** `m.mentions` (MSC3952) — content-shape only, no SDK gap.

### 6. Typing indicators — **M / High**

- **Problem:** no `sendTyping` and no typing subscription anywhere — a baseline chat expectation is absent.
- **Approach:** debounce `client.sendTyping` on composer input; project `getTypingMembers` /
  `RoomMemberEvent.Typing` into a signal; render an "X is typing…" row under the timeline. Pair with a
  privacy toggle to suppress sending (see below).
- **Dependency:** `sendTyping` / `RoomMemberEvent.Typing` (built-in).

### 7. Unread "new messages" divider + jump-to-unread — **M / High**

- **Problem:** we send a read _receipt_ but never set `m.fully_read`, so there's no persisted unread anchor,
  no "New messages" divider, and no jump-to-first-unread affordance.
- **Approach:** call `setRoomReadMarkers` alongside the receipt; thread a divider into the virtual message
  list at the fully-read marker; add a "jump to unread" button when scrolled away.
- **Dependency:** `setRoomReadMarkers` / `m.fully_read` (built-in).

### 8. Per-room notification level — **M / High**

- **Problem:** no way to mute a room or set it to mentions-only; a busy, un-muteable room is a daily pain.
- **Approach:** a Mute / Mentions-&-keywords / All control in the room header or sidebar context menu, via
  `setRoomMutePushRule` / room-specific push rules. Account-data plumbing already exists (`setAccountData` in
  `rooms.service.ts`). (A full global notifications screen is a larger, separate follow-up.)
- **Dependency:** room push rules (built-in).

### 9. Internal matrix.to link navigation — **M / High**

- **Problem:** clicking a `matrix.to` room/user/message link in a message doesn't route in-app; external
  links need safe handling too.
- **Approach:** intercept link clicks in the message renderer — parse `matrix.to` permalinks and navigate
  internally (room / user card / jump-to-event); open non-Matrix links via the platform's safe external opener.
- **Dependency:** none (foundation for OS-level deep links later).

---

## Wave 3 — Visible features (medium value, larger)

### 10. "Seen by" read-receipt display — **M / Med**

Project `getReceiptsForEvent` into stacked avatars on the latest read message (reuse the shared avatar
component). Built-in SDK support.

### 11. Message forwarding — **M / Med**

A "Forward" toolbar action that reuses the existing user-picker to choose a destination and re-sends the
event content. Note: forwarding media into an E2EE room needs re-encryption/re-reference (adds nuance).

### 12. Link / URL previews — **Dropped**

> **Dropped** — built (OpenGraph card via `client.getUrlPreview`) and then removed on request: the
> homeserver-side preview fetch leaks the viewer's IP and the URL, and the value didn't justify the
> privacy trade-off in an E2EE-first client. Bare URLs are still made clickable on render (see #0/linkify).

### 13. Polls (MSC3381) — **L / Med**

`matrix-js-sdk` ships the `Poll` model and relation aggregation. Add a compose-poll dialog and a renderer
with live tallies, vote cast/redact, and close-poll. E2EE-safe.

### 14. Voice messages — **L / High**

> Also the best-ROI item in the calls track — see [CALLS-PLAN.md](CALLS-PLAN.md) (Step 1).

Hold-to-record via `MediaRecorder` (web/desktop) / a Capacitor audio plugin (native), sample a waveform,
upload encrypted through the existing media path, render a waveform player. Needs mic-permission plumbing
(iOS `NSMicrophoneUsageDescription`, Android `RECORD_AUDIO`, Electron permission handler) — the main cost.

---

## Recommended first three

If we build in order, start with the highest ROI cluster:

1. **Per-room draft persistence** (S) — fixes a real bug, immediate daily relief.
2. **@mention autocomplete + `m.mentions`** (M) — biggest composer gap _and_ corrects mention pings.
3. **Typing indicators** (M) — the most-noticed "this feels finished" signal.

Waves 1's other quick wins (full emoji reactions, spoiler reveal, presence status) are cheap enough to
slot in alongside. From there, the unread divider and per-room mute round out the "daily driver" feel.

## Explicitly out of scope for this track

Moderation & room admin (kick/ban/mute-members, power-level editing, room settings), verification breadth
(QR, cross-user, key-backup UI), voice/video **calls**, and account management (password, deactivate, 3PIDs).
These are the "Element parity", "big differentiator", and "ship-readiness" directions — see [PLAN.md](PLAN.md).
