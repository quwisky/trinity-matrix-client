# Android Pinned-Message Workflows Maestro Migration Design

- Issue: #757, part of #660
- Status: Proposed; the coordinator rules on the open questions below
- Branch: local `wip/757-pinned-workflows` at `eb49eb26` (#756 local acceptance, head of PR #677); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.pinned-message-workflow` suite. Implementation and acceptance
evidence will be tracked in `e2e/android/MIGRATION.md`. The accepted #756
pinned-message-panel suite is the structural template. This design reuses its
Pixel 5 overflow path, the shared `m.room.pinned_events` fixture member, its
applied-profile observer and its stage-free artifact helpers. It adds a second
stage, a native long-press pin, and a passive flash recorder. Its redaction and
cleanup guards (`redactStageFailure`, `redactCleanupFailure`, the guarded
cleanup, the exported finish-stage function and the throw-line pin) are ported
from #752 through #756. Nothing in this suite changes a device setting.

## Intent and source boundary

Migrate the two Android-applicable pinned-message workflow definitions to one
serial, two-stage installed-Android Node suite against real Synapse. The third
definition (402–445) is desktop-only and stays with the predecessor (D12). The
predecessor stays enabled and unchanged until hosted acceptance. The
coordinator then retires the two migrated definitions under the 2026-09-26
policy of #839, which replaces the issue's "do not retire" text (open
question 6).

The source of truth is
`e2e/browser/journeys/conversations/pinned-message-workflow.spec.mts`
(446 lines) at the issue's SHA-256
`ee52c7e30ba06c519d277e0009416e63f1c5239a98e56fe1a6187cb8d18620f2`.
**The working-tree file no longer hashes to that pin.** The #839 retirement
commit `716b1637` rewrote one comment line (27: it dropped
`/ room-list.spec.mts`). The working tree now hashes to
`f0a1f4be395c30c05bc71820aadf5fe719d0062654e9b83d115c35e2a2ed5ff7`, with the
same 446 lines and every span unchanged. The issue's bytes are the Git object
at `RETIRED_PREDECESSOR_COMMIT` `dd0cb53c`, which the retirement registry
already fetches. The guard reads the predecessor from there with
`readRetiredPredecessor`, pins `ee52c7e3…`, and also pins the working tree at
`f0a1f4be…`. It proves the two differ in exactly line 27, a `//` comment
(open question 1). The guard also pins these files by SHA-256:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`     | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts` | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |

| Span        | Role                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| 40–42       | `OTHER_BODY` `just chatting`, `PIN_BODY` `pin me please`, `REPEAT_PIN_BODY` `pin me twice please`     |
| 56          | `FILLER_COUNT = 32`                                                                                   |
| 64–83       | `apiLogin`: password login for a REST token (replaced; see D1)                                        |
| 91–124      | `seedPinRoom`: `pin-reader-`, `reader-pass-`, `Pin E2E `; two sends, txns `pin-other-`/`pin-target-`  |
| 137–188     | `seedRepeatJumpPinRoom`: `pin-repeat-reader-`, `Pin Repeat E2E `; lead, target, `pinned: [target]`    |
| 193–290     | definition 1, stage `pin-jump-unpin`                                                                  |
| 198         | `runId = ${testResourceId('run')}p`                                                                   |
| 202–209     | UI `login`, `rail-rooms`, `.channel` by name (30 s), open                                             |
| 225–230     | the `isAndroidE2E` branch: `openMessageActionSheet` then `sheet-pin`; the `else` branch is desktop    |
| 240, 274    | `open-pinned` clicks: a desktop-only control, hidden at Pixel 5 (#756 probe 2)                        |
| 253         | `.pin-item__main` click (the jump)                                                                    |
| 280         | `.pin-item__unpin` click scoped to the `PIN_BODY` row                                                 |
| 288         | `Close pinned messages` button click                                                                  |
| 300–400     | definition 2, stage `repeat-jump`                                                                     |
| 305         | `runId = ${testResourceId('run')}pr`                                                                  |
| 334–346     | 32 sequential live filler sends, body `pin-repeat filler ${runId} ${i}`, txn `…-filler-${runId}-${i}` |
| 364, 390    | `open-pinned` clicks                                                                                  |
| 367, 393    | the two `.pin-item__main` clicks on the same row                                                      |
| 381–383     | `el.scrollTo(0, el.scrollHeight)` (replaced by a native control; see D3)                              |
| 402–445     | definition 3, desktop-only responsive geometry: **excluded** (D12)                                    |
| app 214–222 | `openMessageActionSheet`: touch long press, then `expect(sheet).toBeVisible` at 220 (10 s)            |
| app 202–211 | `clickRowMenuItem`: its `expect(…).toPass` at 207 is reached only from the desktop `else` at 229      |

## Parity records: 25 direct + 1 helper-expanded = 26

`expect(…)` sites are counted as in the edit-history and pinned-panel guards:
every `expect` call expression in the definition's span. Definition 1 owns 11
direct sites, definition 2 owns 14, and definition 3 owns 11 excluded sites
(417–444). The Android branch at 226 expands `openMessageActionSheet`'s one
readiness site (app 220). The desktop branch's `clickRowMenuItem` site (app
207, reached from 229) is excluded, as message-quote excludes its desktop
sites. `apiLogin`, `seedPinRoom`, `seedRepeatJumpPinRoom`, `registerUser`,
`login` (with `fillLabeledInput` and `waitForRooms`) and `synapseSession`
reach no site. `waitFor` calls (208, 217, 318, 328) are not `expect` sites;
they become polled preconditions (D4).

Identities are `pinned-message-workflow.<stage>.<suffix>`. Suffixes are
stage-local: `timeline-visible` appears in both stages, and the stage prefix
keeps all 26 identities unique.

| #   | Stage            | Source  | Kind      | Predecessor claim                                         | Suffix                       |
| --- | ---------------- | ------- | --------- | --------------------------------------------------------- | ---------------------------- |
| 1   | `pin-jump-unpin` | 212     | direct    | `.scroll` visible (15 s)                                  | `timeline-visible`           |
| 2   | `pin-jump-unpin` | 220@226 | inherited | the `Message actions` sheet is visible (10 s)             | `sheet-ready`                |
| 3   | `pin-jump-unpin` | 237     | direct    | the pin badge has text `1` (30 s)                         | `badge-one`                  |
| 4   | `pin-jump-unpin` | 241     | direct    | heading `Pinned messages` visible (10 s)                  | `panel-heading-visible`      |
| 5   | `pin-jump-unpin` | 246     | direct    | the `pin me please` pin row is visible (10 s)             | `pin-row-visible`            |
| 6   | `pin-jump-unpin` | 247     | direct    | its `.pin-item__body` contains `pin me please`            | `pin-row-body`               |
| 7   | `pin-jump-unpin` | 263     | direct    | the target row carries `msg--flash` (1.5 s)               | `jump-flash`                 |
| 8   | `pin-jump-unpin` | 267     | direct    | the heading is hidden (10 s)                              | `panel-closed-by-jump`       |
| 9   | `pin-jump-unpin` | 271     | direct    | the target row is in the viewport (15 s)                  | `target-in-viewport`         |
| 10  | `pin-jump-unpin` | 275     | direct    | the heading is visible again (10 s)                       | `panel-reopened`             |
| 11  | `pin-jump-unpin` | 284     | direct    | `No pinned messages in this channel yet.` visible (30 s)  | `empty-copy-visible`         |
| 12  | `pin-jump-unpin` | 289     | direct    | the badge count is 0 (30 s)                               | `badge-cleared`              |
| 13  | `repeat-jump`    | 321     | direct    | `.scroll` visible (15 s)                                  | `timeline-visible`           |
| 14  | `repeat-jump`    | 354     | direct    | the last filler row is in the viewport (30 s)             | `last-filler-in-viewport`    |
| 15  | `repeat-jump`    | 355     | direct    | the target row is not in the viewport (15 s)              | `target-offscreen`           |
| 16  | `repeat-jump`    | 365     | direct    | heading visible before the first jump (10 s)              | `first-heading-visible`      |
| 17  | `repeat-jump`    | 366     | direct    | pin row visible before the first jump (10 s)              | `first-pin-row-visible`      |
| 18  | `repeat-jump`    | 369     | direct    | first jump: target carries `msg--flash` (1.5 s)           | `first-flash`                |
| 19  | `repeat-jump`    | 376     | direct    | first jump: heading hidden (10 s)                         | `first-panel-closed`         |
| 20  | `repeat-jump`    | 377     | direct    | first jump: target in the viewport (15 s)                 | `first-target-in-viewport`   |
| 21  | `repeat-jump`    | 384     | direct    | at the newest position: target not in the viewport (15 s) | `target-offscreen-at-latest` |
| 22  | `repeat-jump`    | 391     | direct    | heading visible before the second jump (10 s)             | `second-heading-visible`     |
| 23  | `repeat-jump`    | 392     | direct    | pin row visible before the second jump (10 s)             | `second-pin-row-visible`     |
| 24  | `repeat-jump`    | 395     | direct    | second jump: target carries `msg--flash` (1.5 s)          | `second-flash`               |
| 25  | `repeat-jump`    | 398     | direct    | second jump: heading hidden (10 s)                        | `second-panel-closed`        |
| 26  | `repeat-jump`    | 399     | direct    | second jump: target in the viewport (15 s)                | `second-target-in-viewport`  |

The stages are titled after the predecessor:

- `pin-jump-unpin`: `pin a message, see it (and its count) in the pinned panel, jump to it, then unpin it`, 12 records (11 direct + 1 inherited);
- `repeat-jump`: `re-jumping to the SAME pinned message a second time still scrolls it into view`, 14 records (14 direct).

The helper table has one entry, `openMessageActionSheet` (module
`e2e/support/app.mts`, `expectLines: [220]`, role `action-sheet-readiness`),
with a per-stage inherited count of `[1, 0]`.

## Selected architecture

| Unit      | File                                                 | Responsibility                                                                                                            |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Guard     | `scripts/pinned-message-workflow-migration.spec.mjs` | Source pins, AST site map with binding expansion and the desktop-branch exclusion, action bans, negative controls, wiring |
| Contract  | `e2e/android/pinned-message-workflow-contract.mts`   | Two stages, 26 identities, arrangement constants, pure parsers, asserters, the flash-window classifier                    |
| Observer  | `e2e/android/pinned-message-workflow-observer.mts`   | One read-only workflow view expression, the sheet read, and the passive flash recorder (arm and read)                     |
| Artifacts | `e2e/android/pinned-message-workflow-artifacts.mts`  | Secrets for two stages, the publication marker and abort revocation; imports #756's stage-free helpers                    |
| Journeys  | `e2e/android/pinned-message-workflow-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, both stages, `finishPinnedWorkflowStage`, redacted rethrows                  |

Reused unchanged, by import:

- `account-workspace-client.mts`: `reset`, `login`, `hideKeyboard`,
  `tapCurrent`, `longPressCurrent`, `visible`, `capture`, `record`. There is
  no `SharedStageAccount`.
- `account-workspace-fixtures.mts`: `account`, `createRoom`, `sendMessage`,
  `setRoomState`, `roomState` and `roomMessages`. #756 already added
  `'m.room.pinned_events'` to `WorkspaceRoomStateEventType`, so this suite
  makes **no shared source change**.
- `pinned-message-panel-contract.mts`: `authoritativeRoomMessages`,
  `parseAppliedProfile`.
- `pinned-message-panel-observer.mts`: `readAppliedProfile`.
- `pinned-message-panel-artifacts.mts`: `encodedSecretPatterns`,
  `redactSecretText`, `redactDiagnosticText`, `scrubPinnedPanelArtifacts`,
  `scanPinnedPanelArtifacts` and `runPinnedPanelStageCleanup`. None of them
  takes a stage or a record count. Suite-specific functions stay local:
  `pinnedWorkflowSecrets`, `markPinnedWorkflowDiagnosticsSafe` and
  `revokePinnedWorkflowPublicationOnAbort` (open question 2).

#756's `pinnedViewExpression` is keyed to two pins (`unpin`/`keep`) and has no
badge, heading, empty-state, row-viewport or flash fields, so it is not reused.
The workflow view is a new expression built on the same `PRELUDE` semantics
for "visible".

## Feasibility probe

Two local probe runs on 2026-09-29 used a production renderer and a debug APK
built from `eb49eb26`, the API 36 emulator (Pixel 6 AVD, gesture navigation)
and the Pixel 5 profile. Host load was 3–6. The runs used the predecessor's
exact texts through the shared fixtures, and every observation was a
read-only renderer evaluation. The probe file and its output were deleted,
and nothing was committed. Run 1 covered stage 1. Run 2 covered stage 2 from
a fresh sign-in: at Pixel 5 the rail is not reachable from inside an open
Room, and each stage resets anyway.

1. **Surface.** There is exactly one `.scroll`, and the default timeline is
   the simple (non-virtual) list, so rows stay rendered: 8 rows in the
   two-message Room, and 40 after the flood. `prefers-reduced-motion` is
   false, and `--trinity-duration-flash` is `1.6s`.
2. **Native pin.** `longPressCurrent` on the reconciled target row opened the
   `Message actions` sheet in 13.0 s. `sheet-pin` sits at y 484–528 of the
   727 px viewport, with an unobstructed centre. No in-sheet swipe is needed;
   only Report, Edit and Delete lie below the fold. The `sheet-pin` tap took
   10.4 s.
3. **Badge and server after the pin.** At the first read after the tap
   returned, both `.header-pin__badge` elements read `1`: the one in
   `open-pinned` has width 0, and the one in `room-actions-overflow` has
   width 16. Synapse already held `{ pinned: [target] }`.
4. **Panel and first jump.** The overflow path opened the panel (10.6 s and
   10.5 s taps), with one `Pinned messages` heading. The recorder window was
   armed before the `pinned-item` tap. It captured one trusted click on the
   target item, an `add` 23 ms later, a second `add` record 2 ms after that
   (the `classList.remove` no-op mutation of the same `flash()` call), and a
   `remove` 1,600 ms after the first `add`. The tap itself returned 11.5 s
   after the click, 9.9 s after the class had already cleared, so no post-tap
   poll could have seen it. After the tap, the heading was gone, the target
   was in view, and `jump-to-latest` was showing, because `block: 'center'`
   leaves the list off its bottom.
5. **Unpin and close.** At the first read after the unpin tap (10.4 s), no
   badge remained. The panel showed exactly
   `No pinned messages in this channel yet.` with the heading still present,
   and Synapse held exactly `{ pinned: [] }`. `pinned-close` (11.1 s) removed
   the heading.
6. **Live flood.** 32 sequential REST sends after the Room opened landed as
   live traffic. The stick-to-bottom effect (own messages) brought the last
   filler into view, and the target row stayed rendered but out of view.
7. **Stage-2 first jump.** Window 2 captured a trusted click with
   `targetInViewport: false`, an `add` 42 ms later (the target was still out
   of view, because the smooth `scrollIntoView` had only begun), and a
   `remove` 1,582 ms later with the target in view. The tap returned in
   12.1 s.
8. **Native return to latest.** `jump-to-latest` was visible after the jump.
   Its native tap (10.8 s) brought the last filler back into view and the
   target out of view, and the pill disappeared.
9. **Second same-event jump.** Window 3 captured a trusted click with
   `targetInViewport: false`, an `add` 55 ms later, and a `remove` 1,609 ms
   after that. Afterwards the target was in view and the heading gone. The
   tap took 12.2 s. The product's `jumpToNonce` fix therefore re-fires the
   same-id jump natively, and the second window is independent evidence.
10. **Time.** Stage 1's UI part took about 1.7 minutes after sign-in, and
    stage 2's about 1.5 minutes. Each run took about 3.5 minutes including
    Synapse, install and sign-in.

## Decisions

### D1. Profile, Accounts and sign-in

- Both stages run at the shared Pixel 5 profile (`PIXEL_5_ACCOUNT_PROFILE`,
  393×727 CSS px, DPR 2.75, mobile, touch), applied at each stage's `reset`.
  The applied profile is read back with #755/#756's `isPixel5Profile`
  predicate, and the stage fails before any tap if it differs.
- **Motion precondition.** The same read also requires
  `(prefers-reduced-motion: reduce)` **not** to match. Otherwise the stage
  fails before any tap with `reduced motion is on; revisit animator_duration_scale (#755 M5)`.
  Under reduced motion the product sets `--trinity-duration-flash` to
  `0.01ms`, so the flash records would observe a different product state than
  the predecessor's 1.6 s animation. #755's M5 known limitation says an
  aborted #755 run can leave the emulator in that state.
- Each stage has one fresh Account. It is created with
  `fixtures.account('pin-reader')` (stage 1, line 96) or
  `fixtures.account('pin-repeat-reader')` (stage 2, line 147). The fixture
  session replaces `apiLogin` (64–83), and its token never leaves the fixture
  closure.
- The reader signs in through the one-flow `client.login`, then
  `client.hideKeyboard()`. Nothing else is typed.

### D2. Arrangement

All through real Synapse, before any UI step, except the stage-2 fillers.

- **Stage 1** (`seedPinRoom`, 91–124):
  - `run` is `${resources.aliasLocalpart('pinned-pin-jump-unpin')}p`;
  - the Room `Pin E2E <run>` is created with `preset: 'private_chat'`;
  - `just chatting` is sent with txn `pin-other-<run>`, then `pin me please`
    with txn `pin-target-<run>`.

  Two read-backs must pass, or the stage fails closed. The `/messages` page
  must hold exactly these two `m.room.message` events, in order, from the
  reader, and it must include `m.room.create`, so the page is the whole
  history. The Room must have **no** pinned state: `roomState` is absent or
  `{ pinned: [] }`. The first pin must be the native one (issue boundary).

- **Stage 2** (`seedRepeatJumpPinRoom`, 137–188):
  - `run` is `${resources.aliasLocalpart('pinned-repeat-jump')}pr`;
  - the Room `Pin Repeat E2E <run>` is created with `preset: 'private_chat'`;
  - `just chatting` is sent with txn `pin-repeat-lead-<run>`, then
    `pin me twice please` with txn `pin-repeat-target-<run>`;
  - `m.room.pinned_events` is set to `{ pinned: [targetId] }` with the empty
    state key.

  The read-backs require exactly the two messages, in order, and pinned state
  exactly `[targetId]`.

- **Stage-2 live fillers (334–346).** They are sent only after record 13 and
  the pre-flood target-row precondition (the predecessor's `waitFor` at 328).
  They go out sequentially and awaited:
  `sendMessage(reader, room, 'pin-repeat filler <run> <i>', 'pin-repeat-filler-<run>-<i>')`
  for `i` = 0…31. A fail-closed `fillers-sent` receipt then reads `/messages`
  back. It must hold exactly 34 `m.room.message` events: the lead, the target,
  then fillers 0–31 in order, all from the reader, plus `m.room.create`. With
  about eight state events the page is about 42 of its 50-event limit.
- Every text is from the predecessor. The three fixed bodies are constants,
  not secrets. No body is a substring of another within its stage, and no
  filler body contains `pin me`. The guard pins all of this.

### D3. Native action ownership

Every product action is a Maestro action through `AccountWorkspaceClient`.
Each one proves a trusted, matched activation of its target. The ordered
native actions are:

- **Stage 1:**
  1. tap `[data-testid="rail-rooms"]`;
  2. tap `.channel` `{ text: roomName }`, after it has been visible for up to
     30 s;
  3. `longPressCurrent('.scroll .msg[data-mid^="$"]', { text: 'pin me please' })`,
     after a read proves exactly one such reconciled row;
  4. tap `[data-testid="sheet-pin"]`, which is visible and unobstructed in
     the sheet without any swipe (probe 2);
  5. tap `[data-testid="room-actions-overflow"]`, then
     `[data-testid="overflow-open-pinned"]`;
  6. tap `[data-testid="pinned-item"]` `{ text: 'pin me please' }` (the
     `.pin-item__main` button);
  7. tap `room-actions-overflow`, then `overflow-open-pinned`;
  8. tap `[data-testid="pinned-unpin"]`
     `{ within: { selector: '.pin-item', text: 'pin me please' } }`;
  9. tap `[data-testid="pinned-close"]`, whose `aria-label` a receipt proves
     is exactly `Close pinned messages`, the predecessor's role name at 288.
- **Stage 2:**
  1. tap `rail-rooms`, then `.channel` `{ text: roomName }`;
  2. REST fillers (D2);
  3. tap `room-actions-overflow`, then `overflow-open-pinned`, then
     `pinned-item` `{ text: 'pin me twice please' }`: the first jump;
  4. tap `[data-testid="jump-to-latest"]`: the return to latest;
  5. tap `room-actions-overflow`, then `overflow-open-pinned`, then the same
     `pinned-item`: the second jump.
- **Pixel 5 overflow path (240, 274, 364, 390).** This is #756's ruled path.
  Before each stage's first overflow tap, a `toolbar-pin-hidden` receipt
  proves `open-pinned` renders no box. If it ever does, the stage fails with
  `open-pinned is visible at Pixel 5; revisit D3`.
- **Pin badge (237, 289).** The predecessor reads
  `open-pinned .header-pin__badge`. At Pixel 5 that button is `display: none`,
  and the visible count badge is the same `header-pin__badge` inside
  `room-actions-overflow`. Both render `pinned.messages().length`. Record 3
  requires the overflow badge to be visible with trimmed text exactly `1`,
  and every `.header-pin__badge` in the document to read `1`. Record 12
  requires zero `.header-pin__badge` elements in the document, which is the
  predecessor's `toHaveCount(0)` taken page-wide.
- **Return to latest (381–383).** The predecessor's `scrollTo` becomes one
  native tap on the production `jump-to-latest` pill, the control #755
  already taps. Its handler (`scrollToLatest`) is the product's own
  "newest position" action. The pill renders only when
  `notAtBottom() && !showJumpToUnread()`. The stage waits for it to be visible
  and unobstructed after record 20. If it never appears, the stage fails with
  `jump-to-latest did not appear; revisit D3`, rather than falling back to
  swipes (open question 4).
- No renderer `click`, `focus`, `dispatchEvent`, value write, navigation,
  `scrollTo`, `scrollIntoView`, `scrollTop =` assignment, `setViewportSize`
  or product handler call (`jumpTo(`, `unpin(`, `togglePin`,
  `scrollToLatest(`, `openPinnedPanel(`) appears in any suite source.
  Renderer code only reads. The flash recorder's MutationObserver and passive
  capture-phase click listener observe; they never prevent, stop or
  re-dispatch (D5).

### D4. Observation and windows

All observations are one-turn `evaluateNative` reads, polled on the wall
clock, or reads of the passive recorder (D5). No observation depends on
animation frames. Frame starvation can only delay a read, and every window
is anchored after the event it waits for. **No window is ever anchored before
a tap.** Taps took 10.4–13.0 s in the probe (host load 4–5) and up to 45 s under load in #755.
Every tap's return is after its proven activation, so tap latency never
counts against a window.

`workflowViewExpression({ roomName, targetBody, lastFillerBody })` returns only
counts, booleans, labels and measured numbers:

- `scroll`: the `.scroll` count and whether exactly one is visible;
- `target` and `lastFiller`: the count of `.scroll .msg[data-mid]` rows whose
  text includes the body, and for the first row `inViewport` (below);
- `badges`: for each `.header-pin__badge`, its host's `data-testid`, its
  trimmed text and `visible`;
- `heading`: the count of visible elements with a heading role whose
  normalized accessible text is exactly `Pinned messages`;
- `pinRow`: the count of `.pin-item` rows whose text includes the body,
  whether the first is visible, and whether its `.pin-item__body` text
  includes the body;
- `empty`: the count of `[data-testid="pinned-empty"]`, `visible`, and whether
  its normalized text equals the copy exactly;
- `close`: the `pinned-close` count and its `aria-label`;
- `openPinned`: the count and box of `[data-testid="open-pinned"]`;
- `jumpLatest`: count, `visible` and `unobstructed` (centre hit test).

**In viewport** is Playwright's `toBeInViewport`: an intersection ratio above 0. The row's box, clipped by its `.scroll` scroller and by the window, must
have positive area. **Not in viewport** additionally requires the row to be
rendered, exactly one match with an empty clipped area. So a row removed from
the DOM can never pass as "scrolled away" (D7).

Every observation, in stage order, with its type:

| Claim                                        | Type                       | Bound | Anchored at                                                                                   |
| -------------------------------------------- | -------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| Room row visible (208/318 `waitFor`)         | poll-until-true            | 30 s  | the `rail-rooms` tap's return                                                                 |
| 1/13 `timeline-visible`                      | poll-until-true            | 20 s  | the Room-row tap's return                                                                     |
| target row rendered (217/328 `waitFor`)      | poll-until-true            | 20 s  | the read that satisfied record 1/13                                                           |
| 2 `sheet-ready`                              | poll-until-true            | 20 s  | the long press's return                                                                       |
| `sheet-pin` reachable (receipt)              | single read                | —     | justified by the poll that satisfied record 2, which already required exactly one `sheet-pin` |
| 3 `badge-one`                                | poll-until-true            | 30 s  | the `sheet-pin` tap's return                                                                  |
| server pins `[target]` (receipt)             | poll-until-true (REST)     | 30 s  | the `sheet-pin` tap's return                                                                  |
| overflow item visible (each opening)         | poll-until-true            | 20 s  | the overflow tap's return                                                                     |
| 4/16/22 heading visible; 10 `panel-reopened` | poll-until-true            | 20 s  | the menu-item tap's return                                                                    |
| 5/17/23 pin row visible                      | poll-until-true            | 20 s  | the read that satisfied the heading record                                                    |
| 6 `pin-row-body`                             | poll-until-true            | 20 s  | the read that satisfied record 5                                                              |
| 7/18/24 flash                                | poll-until-true (recorder) | 20 s  | the jump tap's return                                                                         |
| 8/19/25 panel closed                         | poll-until-true            | 20 s  | the jump tap's return                                                                         |
| 9/20/26 target in viewport                   | poll-until-true            | 20 s  | the jump tap's return                                                                         |
| `unpin-target` (receipt)                     | single read                | —     | justified by the prior poll that satisfied record 10 and a row-present poll                   |
| 11 `empty-copy-visible`                      | poll-until-true            | 30 s  | the unpin tap's return                                                                        |
| server pins empty (receipt)                  | poll-until-true (REST)     | 30 s  | the unpin tap's return                                                                        |
| 12 `badge-cleared`                           | poll-until-true            | 30 s  | the close tap's return                                                                        |
| `fillers-sent` (receipt)                     | poll-until-true (REST)     | 30 s  | the 32nd send's return                                                                        |
| 14 `last-filler-in-viewport`                 | poll-until-true            | 30 s  | the 32nd send's return                                                                        |
| 15 `target-offscreen`                        | poll-until-true            | 20 s  | the read that satisfied record 14                                                             |
| `jump-to-latest` visible (receipt)           | poll-until-true            | 20 s  | the read that satisfied record 20                                                             |
| 21 `target-offscreen-at-latest`              | poll-until-true            | 20 s  | the `jump-to-latest` tap's return                                                             |
| `at-latest` (receipt): last filler in view   | poll-until-true            | 20 s  | the read that satisfied record 21                                                             |

Each bound is at least the predecessor's own. Its 10 s and 15 s bounds become
20 s under host load; 30 s bounds are kept. There is **no** must-remain-true
hold. The only persistence the workflow needs is that the target stays
offscreen until each stage-2 jump's click, and D5 captures that at the click
itself instead of holding for it. If a hold is ever added, it follows #756's
rule: check the duration after each read, so the last read is at least
`HOLD_MS` after the start and `spanMs` is the last read minus the start.

Server windows are measured from the tap. The REST poll's budget is the
window minus the time already spent since the tap's return
(`remaining = bound − (now − tapReturn)`), as #756's `server-pins` does. It
fails closed on every non-matching state: `[]` or absent after the pin;
`[target]`, or any other id, after the unpin.

### D5. The passive flash recorder (records 7, 18, 24)

`msg--flash` lasts `--trinity-duration-flash`, 1.6 s. `flash()` adds it right
after `scrollIntoView`, and an `animationend` listener removes it. A native
tap returns 10–13 s after its activation (probes 4, 7 and 9), long after
the class is gone, so no poll started after the tap can see the
class. The predecessor's own 1.5 s bound exists to stop a later poll
false-passing on stale state. The suite therefore captures the flash
passively, following #755's sampler pattern:

- **Arm, immediately before each jump tap.**
  `armFlashRecorderExpression(key, targetBody)` defines a never-reused window
  key `__trinityPinnedFlash<n>` (`n` counts suite-wide; `defineProperty`,
  non-writable, non-configurable). The arm fails if the key exists. It
  installs:
  - a `MutationObserver` on `document.body` (`subtree`, `attributes`,
    `attributeFilter: ['class']`, `attributeOldValue`). For every
    `.scroll .msg[data-mid]` whose `msg--flash` membership changes between
    `oldValue` and its current class list, it pushes
    `[add|remove, performance.now(), label, inViewport]`. The label is
    `target` or `other`, by body.
  - a passive capture-phase `click` listener. For each click it pushes
    `[click, performance.now(), itemLabel, isTrusted, targetInViewport]`.
    `itemLabel` is `target` when the click lands inside the
    `[data-testid="pinned-item"]` whose text includes the body, `other` inside
    another item, and `null` elsewhere.

  The arm returns the target's current state, and it must find the target row
  rendered with no `msg--flash`. MutationObserver callbacks are microtasks,
  not frame callbacks, so starvation delays delivery but never drops a
  change.

- **Read, after the tap returns.** Poll `readFlashRecorderExpression(key)`
  (20 s, anchored at the tap's return) until the classifier accepts the
  window. Only then is the flash record emitted.
- **The classifier** (`assertJumpFlash(window, { requireOffscreenAtClick })`)
  requires:
  1. exactly one trusted click with `itemLabel === 'target'`, and no other
     trusted click;
  2. no `add` on any row before that click;
  3. at least one `add` on `target` after the click. The first such `add`
     has a renderer-clock latency (`add − click`) of at most 1,500 ms, the
     predecessor's bound. Both stamps come from the renderer's clock, so tap
     latency never counts. One `flash()` call yields two class mutations,
     `classList.remove` (a no-op that still rewrites the attribute) and then
     `add`, and both classify as `add` (probe 4). Only the first one after
     the click is used, and the count is never asserted;
  4. no `add` on any `other` row;
  5. a `remove` on `target` after its first `add`, which proves the real,
     self-clearing, time-bounded class rather than a stuck one. The measured
     `remove − add` is recorded, never bounded above: starvation only
     lengthens it;
  6. for stage 2's jumps (`requireOffscreenAtClick`): the click's
     `targetInViewport` is `false`. The target was offscreen at the moment of
     the trusted click.

  The record's observation holds the latency, the flash duration and the
  click-time viewport flag.

- **Repeat-jump regression boundary (records 24–26).** The second jump is
  proven only from its own window:
  - a fresh key (`n` + 1), armed after record 21 and after the second
    panel's pin row is visible;
  - a trusted click on the target item, with the target offscreen **at that
    click**;
  - a new `add`/`remove` pair on the target after that click;
  - the panel closed and the target in the viewport, both polled after the
    second tap's return.

  No read of the first window, and no first-jump record or receipt, can
  satisfy any second-jump record. Before the fix, a same-id request was a
  signal no-op: the second window would show the click and no `add`, the
  target would stay offscreen, and records 24 and 26 would fail. The guard
  drives exactly that fake (negative-control plan).

### D6. Stage sequences

**Stage 1, `pin-jump-unpin`.**

1. Arrange (D2); register every identifier (D8); set
   `safety.unsafeSecrets = false`.
2. `reset` at Pixel 5; read back the profile and the motion precondition
   (D1); `login`; `hideKeyboard`.
3. Tap `rail-rooms`, wait for the Room row, and tap it. Record
   `timeline-visible`. Poll until exactly one reconciled target row is
   rendered.
4. Long-press the target row. Record `sheet-ready`: exactly one visible
   `Message actions` dialog, with exactly one `sheet-pin` control.
   Receipt `sheet-pin-reachable`: exactly one `sheet-pin`, visible, with an
   unobstructed centre (probe 2: no in-sheet swipe is needed). Tap it.
5. Poll for the badge and record `badge-one`. Poll Synapse and write the
   `server-pinned` receipt: `{ pinned: [targetId] }`.
6. Receipt `toolbar-pin-hidden`. Tap overflow, wait for the item, tap it.
   Record `panel-heading-visible`, `pin-row-visible` and `pin-row-body`.
7. Arm flash window 1, then tap the target's `pinned-item`. Record
   `jump-flash` (D5, without the offscreen requirement: the predecessor's
   Room has two messages, and the target starts in view). Then record
   `panel-closed-by-jump` and `target-in-viewport`.
8. Tap overflow, then the item. Record `panel-reopened`.
9. Receipt `unpin-target`: exactly one `.pin-item`, which holds the body and
   exactly one `pinned-unpin` control, inside the row's box, with an
   unobstructed centre. Tap that control.
10. Record `empty-copy-visible`. Poll Synapse and write the `server-unpinned`
    receipt: exactly `{ pinned: [] }` (probe 5).
11. Receipt `close-control`: `pinned-close`'s `aria-label` is
    `Close pinned messages`. Tap it. Record `badge-cleared`.
12. Teardown (D9).

**Stage 2, `repeat-jump`.**

1–2. As stage 1 (arrange, launch). 3. Open the Room. Record `timeline-visible`. Poll until the target row is
rendered, and write the receipt `pre-flood`: the target is rendered, and
no filler exists yet. 4. Send the 32 fillers (D2) and write the `fillers-sent` receipt. Record
`last-filler-in-viewport`, then `target-offscreen`. 5. Receipt `toolbar-pin-hidden`. Open the panel natively. Record
`first-heading-visible` and `first-pin-row-visible`. 6. Arm window 2, then tap the target item. Record `first-flash` (with the
offscreen requirement), `first-panel-closed` and
`first-target-in-viewport`. 7. Poll for `jump-to-latest`, visible and unobstructed (receipt), and tap
it. Record `target-offscreen-at-latest`. Write the receipt `at-latest`:
the last filler is in the viewport. 8. Open the panel natively. Record `second-heading-visible` and
`second-pin-row-visible`. 9. Arm window 3, then tap the same item. Record `second-flash` (with the
offscreen requirement), `second-panel-closed` and
`second-target-in-viewport`. 10. Teardown (D9).

### D7. Documented reinterpretations

- **Toolbar pinned control (240, 274, 364, 390).** At Pixel 5 the desktop
  `open-pinned` button is `max-md:hidden`. The suite taps the toolbar
  overflow button and its "Pinned messages" item, both calling
  `openPinnedPanel()`, as #756 ruled. A receipt proves `open-pinned` is
  hidden.
- **Pin badge (237, 289).** The observed badge is the visible
  `header-pin__badge` on the overflow button, the product's phone badge.
  Every badge in the document must agree, and "cleared" means none remains.
- **Action sheet (226–227).** Playwright's synthetic touch long press becomes
  a native Maestro long press on the reconciled row. `sheet-pin` is tapped
  natively.
- **Return to latest (381–383).** The renderer `scrollTo` becomes a native tap
  on the production `jump-to-latest` pill (D3).
- **Flash (263, 369, 395).** The class is captured passively from the jump's
  own trusted click, not by polling after the tap. The 1.5 s bound is kept,
  on the renderer clock, between the click and the class. The class must
  also self-clear (D5).
- **Offscreen (355, 384).** "Not in viewport" requires the row to be rendered
  (D4). The stage-2 jumps additionally prove the target offscreen at the
  moment of their click (D5).
- **Server convergence.** The predecessor trusts the UI. Fail-closed receipts
  read Synapse's `m.room.pinned_events` after the native pin and the native
  unpin, and the fillers after the flood.
- **REST login and Account naming (64–83, 96–97, 147–148).** The shared
  fixture's session and namespaced Account replace the predecessor's separate
  password login and `pin-reader-<run>`/`reader-pass-<run>`.
- **Visibility and bounds.** Visible means one element with a non-empty box
  and `visibility: visible`. The predecessor's 10 s and 15 s bounds become
  20 s. Every window is anchored after its event (D4).
- **Identity without identifiers.** Rooms are opened by exact name, and rows
  and pin items are found by body. No selector or wait description carries an
  event or Room id.

### D8. Protection

Before any UI step, each stage registers:

- its Account's user id, username and password;
- its Room id and name;
- every run-bearing text and transaction id, including all 32 filler bodies
  and filler transaction ids, which are known from `run` in advance;
- every event id, as it becomes known. The filler event ids are registered as
  each send returns, and the shared Matrix-identifier redaction covers the
  shape in any case.

Registration happens before any capture. The #752 strict scrub and
fail-closed scan apply unchanged, through #756's imported helpers. No raw `$…`
event id, `!…:…` Room id, `syt_` token, secure-storage payload or password may
reach an artifact. Every raster is deleted, and the gated
`android-pinned-message-workflow` upload runs only after `publication-safe` is
written. That marker requires:

- 2 stages and 26 records, stage by stage in contract order;
- `pixel-5`, attempt 1 and retries 0 for both;
- per-stage profile and passed captures;
- a clean scan.

Records hold counts, booleans, labels, measured numbers and digests, never
row or filler text.

A failed stage is rethrown through `redactStageFailure`. Only error names and
the first line of each message survive, with every registered value and
Matrix identifier shape redacted. The runner's single throw line is exactly
`throw redactStageFailure(entry.id, failures, secrets);`. Teardown-step
failures are collected into the same `failures` list, so they too are
rethrown through `redactStageFailure`. A failed guarded cleanup is rethrown
through `redactCleanupFailure`, never as the raw error.

### D9. Teardown and guard strength

The suite writes no device setting. Each stage's teardown is
`client.close()`, then `device.clearApplicationData(APPLICATION_ID)`, exported
as `pinnedWorkflowTeardown(client, device)`. The runner's `finally` calls
only the exported
`finishPinnedWorkflowStage(client, device, failures): Promise<boolean>`,
which runs that list through `runPinnedPanelStageCleanup`. Every "must run",
"must redact", "must block publication" and "must wait correctly" property
gets a behavioural guard that drives the **real** code path and fails under
its deletion or reordering:

- **Teardown.** Drive `finishPinnedWorkflowStage` with fakes. A throwing
  `close()` must still reach `clearApplicationData('eu.qwky.trinity')`; the
  order must be exactly `['close', 'clear:eu.qwky.trinity']`; the result must
  be `true`; and with both steps succeeding it must be `false`.
- **Stage rethrow.** Port #752's test. An assertion failure that carries an
  event id, a Room id, the password and Node's appended actual and expected
  values must reach the thrown error as its first line only, redacted. The
  throw-line pin catches `throw failures[0]` or an `AggregateError`.
- **Cleanup rethrow.** A guarded cleanup that throws with an identifier must
  mark the stage failed, save `journeys.json` and rethrow an id-free error.
- **Publication.** `markPinnedWorkflowDiagnosticsSafe` must withhold the
  marker for each of these: one stage, 25 records, a swapped stage order, a
  retry, a wrong profile, a failed cleanup and an unscrubbed identifier.
- **Windows (fake clock).** The simulated app is a fake client and fixtures
  pair that drives the real, imported `runPinJumpUnpin` and `runRepeatJump`.
  Every UI observation and server read is a **pure function of the fake
  clock relative to the recorded return time of the tap it follows**. No fake
  tap mutates UI or server state inside the tap. Each fake tap advances the
  fake clock by 45 s, then records its return time, and state changes happen
  only later, in reads. For each window class, the guard runs one passing
  and one failing case. The change arrives 5 s before the window's bound,
  which passes, or 1 s after it, which fails:
  - 30 s UI windows (badge after the pin, empty copy after the unpin, badge
    cleared after close, last filler after the flood): 25 s passes, 31 s
    fails;
  - 20 s UI windows (panel closed and target in view after each jump,
    offscreen after `jump-to-latest`): 15 s passes, 21 s fails;
  - server convergence after the pin and after the unpin: the pins lag
    15 s, which passes; they never converge, which fails with `server pinned
state`; or they converge 31 s after the tap's return, which fails, even
    though that beats a fresh 30 s measured from the poll's own start;
  - fillers: the `/messages` read lags 15 s, which passes, or never shows the
    32nd filler, which fails;
  - flash: the recorder's `remove` arrives 15 s after the tap's return,
    which passes, or never arrives, which fails.

  A window anchored anywhere earlier, such as before the tap or at the stage
  start, fails the passing cases.

### D10. CI placement and budgets

- **Shard.** Headroom is `limit − figure − 45 (retained Playwright) −
15 (diagnostics)`, from the current `ci.yml` budget comment:

  | Shard | Figure | Limit | Headroom |
  | ----- | ------ | ----- | -------- |
  | 1     | 84     | 180   | 36       |
  | 2     | 75     | 180   | 45       |
  | 3     | 81     | 240   | 99       |
  | 4     | 79     | 240   | 101      |
  | 5     | 78     | 180   | 42       |
  | 6     | 89     | 180   | 31       |

  **Shard 4 has the most headroom**, so it goes last, after
  `message-unread`. Hosted run 36488221868, however, measured shard 4 as the
  slowest job (100 min) and shard 3 as one of the fastest (67 min) (open
  question 5).

- **Budget.** The estimate is 6 minutes: two probe-sized stages (about 3.5 minutes each without the shared start and install) plus provenance and capture, less the Synapse start that one run pays once. That gives 79 + N,
  and 79 + N + 60 ≤ 240 for any N ≤ 101. The acceptance task replaces the
  estimate with the measured local time, rounded up. It changes
  `shard 4 about 79` and adds "Shard 4 also carries pinned-message-workflow
  at its N-minute local acceptance time until a hosted run measures it."
- **Timeouts.** A 15-minute Node test (`--timeout-ms=900000`) and a 20-minute
  CI wrapper (`1200000`), as #756. The acceptance task re-derives both if the
  measured run exceeds 10 minutes.
- **Docs.** No CHANGELOG or README change: this is a test-only migration.

### D11. MIGRATION.md section

The suite appends `## Pinned-message workflow journeys` after
`## Pinned-message panel journey`, in #756's shape:

- the source pin, including the `dd0cb53c` Git object and the one-comment
  working-tree difference; the 26-row identity table; and the 25/1 prose;
- the arrangement and native-ownership paragraph: the long-press pin, the
  overflow path, native jumps, `jump-to-latest` and native close;
- the protection paragraph, with this exact wording: "a failed teardown step
  is rethrown through `redactStageFailure`, and a failed guarded cleanup is
  rethrown through `redactCleanupFailure`, never as the raw error";
- `Documented reinterpretations of the predecessor:` with the D7 bullets;
- known-limitation bullets:
  - **Desktop definition excluded.** "the panel takes its own width, and only
    offers a divider where one means something" (402–445) compares the
    1280 px member column and divider with a programmatically resized 1000 px
    viewport. It is not an Android claim and stays with the predecessor,
    which remains canonical for it (D12);
  - **Desktop pin path.** The hover `⋯` menu (`clickRowMenuItem`,
    `msg-pin`) and the desktop `open-pinned` button are not exercised on
    Android;
  - **Flash latency on the renderer clock.** The 1.5 s bound is measured
    between two renderer timestamps, not from the native gesture's start,
    which Maestro does not report;
- the command block and the target paragraph: one attempt, zero retries, the
  15/20-minute bounds and the shard-4 placement;
- the acceptance paragraph, written in Task 4;
- `Predecessor status: enabled; the coordinator retires the two migrated definitions after hosted acceptance; definition 402–445 stays.`

### D12. Predecessor retention and retirement scope

Until hosted acceptance, the predecessor file is unchanged, and the guard
asserts that all three definitions are present. On hosted acceptance, the
coordinator retires the two migrated definitions only, and keeps the file
with the desktop-only definition. The registry already has partial-file
precedents: `identity/presence.spec.mts` (#674),
`room-library/leave-room.spec.mts` (#692), `kick-member.spec.mts` (#709),
`jump-to-date.spec.mts` (#737) and `message-edit-history.spec.mts` (#743).
Each is `deleted: false` with `retired` titles and `desktopOnly: []`. Here the
entry would be:

```js
{
  path: 'e2e/browser/journeys/conversations/pinned-message-workflow.spec.mts',
  sha256: 'ee52c7e30ba06c519d277e0009416e63f1c5239a98e56fe1a6187cb8d18620f2',
  issues: [757],
  deleted: false,
  retired: [
    'pin a message, see it (and its count) in the pinned panel, jump to it, then unpin it',
    're-jumping to the SAME pinned message a second time still scrolls it into view',
  ],
  desktopOnly: [],
}
```

The remaining definition is not an Android-owned `desktopOnly` entry. No
Android suite owns it, and it keeps its current behaviour, with no Android
skip added: #839's third class, "definitions no accepted batch owns are
unchanged". The retirement also removes what only the retired definitions
used: `REPEAT_PIN_BODY`, `FILLER_COUNT`, `seedRepeatJumpPinRoom`, and the
`clickRowMenuItem`, `isAndroidE2E` and `openMessageActionSheet` imports. It
adds 757 to `ACCEPTED_BATCHES`, moves the browser inventory baseline and
registry counts (−2 definitions, −25 assertion calls, same file count), and
switches the guard from retention to retirement assertions, as #755's
`4e418d20` did.

## Negative-control plan

For each control, the guard must fail when its protection is removed:

- **Sources.**
  - The four SHA-256 pins (commit bytes, working tree, `app.mts`,
    `account.mts`), and the one-line, comment-only working-tree difference.
  - The 25/1 site map with binding expansion, including a shadowing-helper
    control and a control that counts the desktop `clickRowMenuItem` site.
  - Each text pin under an in-memory mutation: the three bodies,
    `FILLER_COUNT = 32`, the `p` and `pr` suffixes, both Room-name and
    Account prefixes, all four transaction prefixes, the filler body and
    transaction templates, `pinned: [targetEventId]`,
    `preset: 'private_chat'`, the `isAndroidE2E` branch with
    `sheet.getByTestId('sheet-pin')`, the 1.5 s flash bounds (263, 369, 395),
    and the 30 s bounds (208, 237, 284, 289, 318, 354).
  - The desktop-only exclusion: 402–445 is excluded by title and span, it
    holds 11 sites, and none maps to an identity.
- **Native pin ownership.** The stage must fail on:
  - a pin seeded by REST before the UI (the arrangement read-back sees
    pins);
  - a tap replaced by a renderer dispatch, or a missing trusted activation;
  - a sheet with no, or two, `sheet-pin` controls;
  - `open-pinned` visible at Pixel 5.
- **Badge, panel, body and empty state.** The stage must fail on:
  - a badge `2`, or a badge visible only on the hidden `open-pinned`;
  - the heading never appearing, or the panel never closing after a jump;
  - a pin row whose body lacks the text;
  - an empty panel whose copy differs by one character;
  - a badge that remains after close;
  - server pins that never converge after the pin or the unpin.
- **First flash, viewport and close.** The recorder window must fail on:
  - no `add`;
  - an `add` on another row;
  - an `add` before the click;
  - latency 1,501 ms (1,500 passes);
  - no `remove` (a stuck class);
  - an untrusted click;
  - two clicks.

  The stage must also fail when the target never enters the viewport.

- **Live filler and offscreen setup.** The stage must fail on:
  - 31 or 33 fillers, or fillers out of order;
  - a filler from another sender;
  - the last filler never in view;
  - the target still in view after the flood;
  - the target row removed from the DOM (not "offscreen");
  - fillers sent before the Room was open (the `pre-flood` receipt).
- **Second same-event jump.** The stage must fail on:
  - the regression fake: a second window with a trusted click and no `add`,
    with the target left offscreen;
  - a second click taken while the target was still in view;
  - a second window whose only `add` precedes its click;
  - an attempt to read window 2 for the second jump (the key is used once).
- **Native return to latest.** The stage must fail when:
  - `jump-to-latest` never appears;
  - the target stays in view after the tap;
  - any source contains `scrollTo`, `scrollTop =` or `scrollIntoView`.
- **Motion.** A profile read with reduced motion on must fail before any tap.
- **Native ownership bans.** Each banned token in any suite source:
  - `.click(`, `.focus(`, `dispatchEvent`, `.value =`, `location.`,
    `history.`;
  - `scrollTo`, `scrollIntoView`, `scrollTop =`, `setViewportSize`;
  - `jumpTo(`, `unpin(`, `togglePin`, `scrollToLatest(`, `openPinnedPanel(`;
  - `preventDefault`, `stopPropagation`;
  - `new SharedStageAccount(`, `input_method`, `dumpsys`.
- **Windows.** The D9 fake-clock pairs, for every window class.
- **Cleanup and redaction.** The D9 behavioural controls; every identifier
  form, credential and token in the scan, including a filler body and a
  filler transaction id; rasters; a failed cleanup, scrub or scan;
  revocation on abort; and the throw-line pin.

## Evidence and acceptance plan

1. Run the guard, the typecheck, ESLint on the changed files, the neighbour
   guards (including `pinned-message-panel-migration`, whose imported helpers
   this suite shares) and the full `pnpm nx run scripts:test`.
2. Develop on the device until both stages pass. Fix each finding at its
   root, and add one guard control per fix.
3. On the final unchanged commit, with a fresh production renderer, run three
   consecutive `trinity-e2e-android:pinned-message-workflow` first attempts.
   Each must show:
   - 2/2 stages and 26/26 records at attempt 1, with zero retries;
   - `publication-safe`;
   - matching built and installed APK digests;
   - a clean identifier and raster scan.

   Each run also reports every flash window's latency and duration and every
   tap latency.

4. Run the predecessor file sequentially at `--workers=1 --retries=0`. All
   three definitions must pass, including the two applicable ones.
5. Hosted: the coordinator audits the original-attempt shard-4 Android
   artifact, the browser artifact and the renderer artifact. It then retires
   the two definitions (D12) and updates the parent ledger.

## Open questions for the coordinator

1. **Predecessor pin versus the working tree.** The issue pins `ee52c7e3…`.
   The working tree is `f0a1f4be…` after #839's one-comment edit.
   **Recommendation:** read the issue's bytes from the `dd0cb53c` Git object
   through `readRetiredPredecessor` (spans and sites are identical), and pin
   the working tree separately with a guard that the only difference is line
   27, a comment. The alternatives are to re-pin the issue to `f0a1f4be`, or
   to read only the working tree. Either one silently changes the accepted
   baseline's identity.
2. **Artifact helpers.** **Recommendation:** import #756's six stage-free
   helpers (scrub, scan, both redactors, the encoded-pattern builder and the
   cleanup runner) and keep only the secrets, marker and abort-revocation
   functions local. That saves about 200 duplicated lines. The cost is a
   cross-suite import: a future #756 change runs this guard too, and the scan
   messages say "pinned-panel". The alternative is a full per-suite port,
   the #752–#756 precedent.
3. **Flash latency bound.** **Recommendation:** keep the predecessor's
   1,500 ms, measured on the renderer clock from the trusted click to the
   class `add`. The probe measured 23, 42 and 55 ms at host load 3–6, which leaves a margin of more than 25 times; the latency needs only the renderer's own event loop, not a native gesture. The alternative is a load-tolerant
   bound such as 5 s. It is safe from stale-state false passes (the recorder
   window is armed per jump), but it loosens a source bound.
4. **Return-to-latest control.** **Recommendation:** the production
   `jump-to-latest` pill, one native tap, failing closed if it is absent. It
   is deterministic, #755 already uses it, and the product intends it for
   exactly this move. The alternative is bounded native swipes on `.scroll`
   until the last filler is in view. That is closer to a user's thumb, but
   it needs several swipes under load, and it proves nothing more about the
   jump regression.
5. **Shard.** **Recommendation:** shard 4, by the budget-comment headroom
   rule (101 against shard 3's 99). The hosted data points the other way
   (shard 4 100 min, shard 3 67 min in run 36488221868). If the coordinator
   weighs hosted wall time over the budget comment, it becomes shard 3, after
   `pinned-message-panel`: one `ci.yml` line and one guard row.
6. **Retirement scope.** **Recommendation:** on hosted acceptance, retire
   only the two migrated definitions and keep the file with 402–445 unchanged
   (D12), following the partial-file precedents. The issue's "do not retire"
   text is superseded by #839. The alternative, whole-file retirement, would
   drop the only desktop responsive-geometry check for the pinned panel.
7. **Motion precondition.** **Recommendation:** fail closed before any tap
   when `prefers-reduced-motion` matches (D1). This makes a #755 M5 leftover
   visible as a clear environment failure rather than a flash-record failure
   (0.01 ms class). The alternative is to accept either motion mode, since
   the recorder still sees `add`/`remove` at 0.01 ms, and to record the mode.
