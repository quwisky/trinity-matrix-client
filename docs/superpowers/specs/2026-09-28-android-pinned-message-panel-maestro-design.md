# Android Pinned-Message Panel Maestro Migration Design

- Issue: #756, part of #660
- Status: Proposed; the open questions below await the coordinator's rulings
- Branch: local `wip/756-pinned-panel` at `854d9898` (head of PR #677); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.pinned-message-panel` suite. Implementation and acceptance evidence
will be tracked in `e2e/android/MIGRATION.md`. The #755 message-unread suite is
the structural template: a single-stage suite with a contract, a read-only
observer, an artifacts module and a journeys runner, plus a Vitest guard with
effective negative controls and the same registry, Nx, package and CI wiring.
Its redaction and cleanup guards (`redactStageFailure`, `redactCleanupFailure`,
the guarded cleanup and the throw-line pin) are ported from #752 through #755.
Nothing in this suite changes a device setting, so the #755 restore machinery
has no counterpart here.

## Intent and source boundary

Migrate the one canonical pinned-message-panel definition to one serial,
single-stage installed-Android Node suite against real Synapse. The Playwright
predecessor stays enabled and unchanged until hosted acceptance. The
coordinator then retires it under the 2026-09-26 policy of #839, which
replaces the issue's older "do not retire" text.

The source of truth is
`e2e/browser/journeys/conversations/pinned-message-panel.spec.mts` (161 lines)
at SHA-256 `d30470d1c2129818a096aefdf50768d31c4eae995ce17b5300e69afc696d56c0`.
The branch file hashes to the issue's pin, so no `develop` reconstruction is
needed. The guard also pins these files by SHA-256:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`     | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts` | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |

| Span    | Role                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| 34–91   | `seedPinnedRoom`: Account, REST login, private Room, two sends, `m.room.pinned_events` |
| 44–48   | names: `pinner-${runId}`, `pinner-pass-${runId}`, `Pinned Room ${runId}`, both bodies  |
| 51–60   | password login for a REST access token (replaced; see D1)                              |
| 62–67   | `createRoom` with `{ name, preset: 'private_chat' }`                                   |
| 69–78   | `send`: transaction id **is** the body; `unpin-me` first, then `keep-me`               |
| 80–83   | `PUT …/state/m.room.pinned_events/` with `{ pinned: [unpinId, keepId] }`               |
| 96–160  | the definition                                                                         |
| 101     | `runId = ${testResourceId('run')}p`                                                    |
| 109–114 | UI `login`, `rail-rooms`, `.channel` by name (30 s), open                              |
| 117     | `open-pinned` click: a desktop-only control, hidden at Pixel 5 (probe 2; D3)           |
| 129–134 | three `boundingBox()` reads: `trn-page-header header` first, `.panel-header`, its `h2` |
| 151–152 | row-scoped `.pin-item` by `unpinBody`, its `pinned-unpin` clicked (10 s)               |

## Parity records: 12 direct + 0 helper-expanded = 12

`expect(…)` sites are counted as in the edit-history guard. `seedPinnedRoom`,
`registerUser`, `login` (with `fillLabeledInput` and `waitForRooms`) and
`synapseSession` reach no site. The Playwright default `expect` timeout is 5 s
(the browser config sets none), which matters for lines 120, 157, 158 and 159.

| #   | Source | Predecessor claim                                            | Suffix                  |
| --- | ------ | ------------------------------------------------------------ | ----------------------- |
| 1   | 119    | the panel is visible (30 s)                                  | `panel-visible`         |
| 2   | 120    | exactly two `pinned-item` elements                           | `two-pinned-items`      |
| 3   | 135    | the first `trn-page-header header` has a box                 | `room-header-measured`  |
| 4   | 136    | the panel's `.panel-header` has a box                        | `panel-header-measured` |
| 5   | 137    | the panel's `.panel-header h2` has a box                     | `panel-title-measured`  |
| 6   | 139    | panel header height `toBe` the Room header height            | `header-heights-equal`  |
| 7   | 140    | title x − header x `toBeCloseTo(12, 0)`, so \|Δ − 12\| < 0.5 | `title-inset`           |
| 8   | 145    | \|above − below\| < 2 px                                     | `title-centred`         |
| 9   | 154    | exactly one `pinned-item` (30 s)                             | `one-pinned-item`       |
| 10  | 157    | the panel is still visible                                   | `panel-stays-open`      |
| 11  | 158    | the panel contains `keepBody`                                | `keep-remains`          |
| 12  | 159    | the panel does not contain `unpinBody`                       | `unpin-removed`         |

There is one stage, `list-unpin`, titled after the predecessor: `lists pinned
messages and unpins one in place`. Identities are
`pinned-message-panel.list-unpin.<suffix>`, in the order above. There are 12
unique identities and 12 stage-local records.

## Selected architecture

| Unit      | File                                              | Responsibility                                                                               |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Guard     | `scripts/pinned-message-panel-migration.spec.mjs` | Source pins, AST site map with binding expansion, action bans, negative controls, wiring     |
| Contract  | `e2e/android/pinned-message-panel-contract.mts`   | Stage, 12 identities, arrangement constants, pure parsers, asserters, settle/hold predicates |
| Observer  | `e2e/android/pinned-message-panel-observer.mts`   | One read-only panel view expression and the applied-profile read                             |
| Artifacts | `e2e/android/pinned-message-panel-artifacts.mts`  | The #752 secrets, scrub, scan and marker policy for one Account and one Room                 |
| Journeys  | `e2e/android/pinned-message-panel-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, native helpers, the one stage and its teardown  |

No suite-local REST fixture is needed. The shared `account-workspace-fixtures.mts`
already has `setRoomState` and `roomState`, which keep the access token in their
closure. The only shared change is one type-union member: `'m.room.pinned_events'`
is added to `WorkspaceRoomStateEventType` (open question 2). `account-workspace-client.mts`
(`reset`, `login`, `hideKeyboard`, `tapCurrent`, `visible`, `capture`, `record`)
is reused unchanged. Its `within` filter
(`{ selector: '.pin-item', text: unpinBody }`) is exactly the predecessor's
row scoping at line 151.

## Feasibility probe

One local probe ran on 2026-09-28 against the production renderer built from
`854d9898`, the debug APK built from the same commit, the API 36 emulator
(Pixel 6 AVD, gesture navigation) and the Pixel 5 profile. Host load was
about 1.5–5. The predecessor's exact arrangement was made through the shared
fixtures. The probe file and its output were deleted, and nothing was
committed.

1. **Arrangement.** `PUT m.room.pinned_events` returned 200. The REST read-back
   was `[unpin, keep]`, in that order.
2. **The toolbar pinned control is desktop-only.** At 393 CSS px,
   `[data-testid="open-pinned"]` is `display: none` with a 0×0 box. It carries
   `max-md:hidden`, and `md` is 768 px. The product's mobile path is the
   toolbar's `room-actions-overflow` button (32×32 at x 353, y 172). That
   button carries the same `header-pin` class and pin-count badge. Its menu
   item `overflow-open-pinned` (180×36) calls the same
   `messageActions.openPinnedPanel()`. Native taps on both worked, taking
   11.5 s and 10.6 s.
3. **The panel is a full-screen overlay at Pixel 5.** Below the `members`
   breakpoint (1100 px), `.chat-panel` is `position: fixed` with
   `max-width: 100%`. The measured boxes were:
   - panel `[0, 0, 393.14, 727.24]`;
   - `.panel-header` `[0, 0, 393.14, 56]`, with `padding-top` `0px` and
     `padding-left` `12px`, so `env(safe-area-inset-top)` is 0 under the
     emulated profile;
   - `h2` `[12, 15.62, 317.14, 24]`.
4. **Geometry holds at Pixel 5.** There is exactly one `trn-page-header header`
   in the document while the Room is open: the Room header,
   `[0, 160.76, 393.14, 56]`, which the overlay covers. The heights are 56 and
   56, exactly equal. The inset is 12.00. Above is 15.62 and below is 16.38,
   an imbalance of 0.76 px. These values were identical across three reads 1 s
   apart.
5. **Rows and unpin controls.** There are two `pinned-item` rows in pin order,
   `unpin-me` then `keep-me`, each 325×65.5. Their `pinned-unpin` controls are
   44×44 at x 337–381, 12 px from the right edge. `elementFromPoint` at each
   centre hits the control. The list has no scrollbar (`offsetWidth` equals
   `clientWidth`, both 393). Both rows carry the same sender, so the
   `aria-label` ("Unpin message from …") cannot tell them apart. Only the row
   text can.
6. **Row-specific native unpin.**
   `tapCurrent('[data-testid="pinned-unpin"]', { within: { selector: '.pin-item', text: unpinBody } })`
   passed its trusted-activation proof in 10.6 s. At the first read after
   that, the panel held one row (`keep-me`) and stayed open, and the REST
   state was already `[keep]`. This state was stable for 6 s.
7. **The UI projection is not optimistic.** `ConversationPinsController.write`
   calls `sendStateEvent`, then re-reads the live Room state. The row drops
   only when that state changes, so the server read-back and the UI agree by
   construction, not by coincidence.
8. **Time.** The whole run took 2.5 minutes, including Synapse start and
   stop, the APK install and sign-in.

## Decisions

### D1. Profile, Account and sign-in

- The stage runs at the shared Pixel 5 profile (`PIXEL_5_ACCOUNT_PROFILE`,
  393×727 CSS px, DPR 2.75, mobile, touch), applied once at `reset`. The
  applied profile is read back after the launch with #755's `isPixel5Profile`
  predicate (size, DPR, coarse pointer, `hover: none`, `android`). The stage
  fails before any tap if the profile differs.
- There is one fresh Account, the pinner, created with `fixtures.account('pinner')`,
  as in line 50. There is no `SharedStageAccount`, so the
  `scripts/android-native-actions.spec.mjs` `sharedSuites` guard is unchanged.
- The predecessor's separate REST password login (51–60) exists only to get
  a token for the arrangement. Here the shared fixture's own session does that
  work, and its token never leaves the fixture closure.
- The pinner signs in through the one-flow `client.login`
  (`accounts-sign-in.yaml`), then `client.hideKeyboard()`. Nothing else is
  typed, so the `fillFocused` per-value sentinel rule does not arise. Adding
  UI text entry later would bring the sentinel rule back, one sentinel per
  value.

### D2. Arrangement

Through real Synapse, before any UI step, exactly as lines 44–83:

- `run` is `${resources.aliasLocalpart('pinned-list-unpin')}p`, keeping the
  predecessor's `p` suffix;
- the Room `Pinned Room <run>` is created with `preset: 'private_chat'`;
- `unpin-me-<run>` is sent, then `keep-me-<run>`. Each transaction id **is**
  its body, as line 71;
- `setRoomState(pinner, room, 'm.room.pinned_events', { pinned: [unpinId, keepId] })`
  is written with the empty state key, as line 81.

Two read-backs must pass before the first UI step, or the stage fails closed:

- the raw `/messages` page must hold exactly these two `m.room.message`
  events, in order, from the pinner;
- `roomState(…, 'm.room.pinned_events')` must deep-equal
  `{ pinned: [unpinId, keepId] }`.

Both land in the `arranged` receipt as counts, order labels and digests.
Neither body is a substring of the other, and neither contains the Room name.
The guard pins all three.

### D3. Native action ownership

- Every product action is a Maestro tap through `client.tapCurrent`. Each tap
  proves one trusted, matched activation of its target. The ordered taps are:
  1. `[data-testid="rail-rooms"]`;
  2. `.channel` with `{ text: roomName }`, after waiting up to 30 s for it to
     be visible (line 113);
  3. `[data-testid="room-actions-overflow"]`;
  4. `[data-testid="overflow-open-pinned"]`, after it is visible;
  5. `[data-testid="pinned-unpin"]` with
     `{ within: { selector: '.pin-item', text: unpinBody } }`.
- **The toolbar pinned control (line 117).** At Pixel 5 the product hides
  `open-pinned` and offers the same action through the toolbar's overflow
  button (probe 2). The suite taps that toolbar control and its "Pinned
  messages" item. Before the first of those taps, a receipt proves
  `open-pinned` renders no box at this profile. If it is ever visible, the
  stage fails closed with `open-pinned is visible at Pixel 5; revisit D3`,
  rather than silently taking a different path. The guard pins the product
  template facts this relies on: `open-pinned` has `max-md:hidden`,
  `overflow-open-pinned` has `md:hidden`, and both call `openPinnedPanel()`.
- **Row targeting.** Immediately before the unpin tap, a one-turn read proves
  the target. There are exactly two `.pin-item` rows. The row whose text
  includes `unpinBody` holds exactly one `pinned-unpin` control. That
  control's box lies inside that row's box and outside the `keep` row's box,
  and its centre is unobstructed. The bodies enter only the in-page
  comparison and are never returned. The result is the `unpin-target`
  receipt. After it, `tapCurrent`'s own activation proof binds the tap to that
  one matched element.
- No renderer `click`, `focus`, `dispatchEvent`, value write, navigation,
  `scrollTo`, `scrollIntoView` or handler call appears in any suite source.
  Renderer code only reads.

### D4. Observation

All observations are one-turn `evaluateNative` reads of one view expression,
polled on the wall clock. No observation depends on animation frames, so
frame starvation under host load cannot distort a count, a text or a box. It
can only delay a read, and every window is anchored at the event it waits
for (below).

The view expression (`pinnedViewExpression({ roomName, unpinBody, keepBody })`)
returns only numbers, booleans and labels:

- `roomHeader`: the `trn-page-header header` count, the first one's box or
  `null`, and `namesRoom`, which is true when that header's `h1` text includes
  the Room name;
- `panel`: `[data-testid="pinned-panel"]` count, box, `visible` (a non-empty
  box and `visibility: visible`, as in #755), `containsKeep`, `containsUnpin`,
  and `animating` (the host's `getAnimations({ subtree: true })` includes one
  that is `running`);
- `panelHeader` and `panelTitle`: count and box of `.panel-header` and
  `.panel-header h2` inside the panel. The predecessor's strict locators imply
  exactly one of each;
- `items`: the `[data-testid="pinned-item"]` count, page-wide as line 120,
  and `order`, one label per row (`unpin`, `keep` or `other`);
- `rows`: for each `.pin-item`, its label, its box, its `pinned-unpin` count
  and box, and whether that control's centre is unobstructed;
- `openPinned`: count and box of `[data-testid="open-pinned"]`.

"Has a box" (records 3–5) means Playwright's `boundingBox()` is not `null`:
the element is attached and `getClientRects().length > 0`. Visibility and
count claims are polled. Every window starts at the event it waits for, not
at the observer's start or the stage's start:

| Claim                          | Bound | Anchored at                                           |
| ------------------------------ | ----- | ----------------------------------------------------- |
| Room row visible               | 30 s  | the `rail-rooms` tap's return (its proven activation) |
| overflow item visible          | 20 s  | the overflow tap's return                             |
| panel visible (record 1)       | 30 s  | the menu-item tap's return                            |
| two items (record 2)           | 20 s  | the first read that satisfied record 1                |
| geometry settled (records 3–8) | 20 s  | the read that satisfied record 2                      |
| one item (record 9)            | 30 s  | the unpin tap's return                                |
| held state (records 10–12)     | 2 s   | the read that satisfied record 9                      |
| server pins converge (receipt) | 30 s  | the unpin tap's return                                |

Each bound is at least the predecessor's own bound. The predecessor's 5 s
defaults become 20 s under host load. A tap's return is the right anchor
because `tapCurrent` returns only after its activation proof. Its end-to-end
latency was 10.6–11.5 s in the probe, and it reached 44 s under load in
#755, so it can never count against a window.

### D5. Geometry (records 3–8)

- **Settled.** Records 3–8 all come from one settled read: two consecutive
  one-turn reads at least 500 ms apart, where every measured box is identical
  and `panel.animating` is false in both. The panel enters with
  `members-drawer-in`, a translate animation, below the `members` breakpoint.
  An unsettled read is never recorded. Reads repeat until the settled pair
  appears, within 20 s of record 2 (D4). Otherwise the stage fails with
  `panel geometry did not settle`.
- **Room header identity.** Record 3 keeps the predecessor's `.first()`. Its
  observation also carries `roomHeader.count` and `namesRoom`. A receipt
  before record 3 requires `namesRoom`, so the measured bar is the Room
  header. The probe found one header in the document.
- **Exact predicates.** These are ported without loosening:
  - record 6: `Object.is(panelHeader.height, roomHeader.height)`;
  - record 7: `|panelTitle.x − panelHeader.x − 12| < 0.5`, which is
    Playwright's `toBeCloseTo(12, 0)`;
  - record 8: `|(title.y − bar.y) − (bar.y + bar.h − title.y − title.h)| < 2`.

  The probe measured 56 = 56, 12.00 and 0.76.

- Geometry is measured from rendered boxes only. No class name, computed
  padding or style string satisfies a geometry record. Computed padding is
  recorded as a diagnostic, never asserted.

### D6. Stage sequence

1. **Arrange** (D2) and register every identifier (D8). Set
   `safety.unsafeSecrets = false`.
2. **Launch.** `reset` at Pixel 5, read back the profile (D1), `login`, then
   `hideKeyboard`.
3. **Open the Room.** Tap `rail-rooms`, wait for the Room row (30 s), and tap
   it. Receipt `room-open`: the composer is visible (15 s), and the header
   names the Room.
4. **Open the panel.** Receipt `toolbar-pin-hidden` (D3). Tap
   `room-actions-overflow`, wait for `overflow-open-pinned` (20 s), and tap
   it.
5. Poll for the panel and record `panel-visible`. Poll for two items and
   record `two-pinned-items`. Receipt `pin-order`: the rendered order is
   exactly `[unpin, keep]`, the published pin order. This fails closed (open
   question 3).
6. **Geometry.** From one settled read (D5), record
   `room-header-measured`, `panel-header-measured`, `panel-title-measured`,
   `header-heights-equal`, `title-inset` and `title-centred`.
7. **Unpin.** Write the receipt `unpin-target` (D3), then tap the row's
   `pinned-unpin` natively.
8. Poll for one item and record `one-pinned-item`.
9. **Hold.** Read at least four times over at least 2 s. Every read must show
   the panel visible, one item, `containsKeep` and not `containsUnpin`. From
   that held series, record `panel-stays-open`, `keep-remains` and
   `unpin-removed`. A closed or empty panel fails all three: each asserter
   requires `panel.visible && items.count === 1`, so an empty or closed panel
   never counts as the row's removal.
10. **Server.** Poll `roomState(…, 'm.room.pinned_events')` until it
    deep-equals `{ pinned: [keepId] }` (30 s, anchored at the unpin tap), and
    write receipt `server-pins`. This fails closed on `[]`, `[unpinId]`,
    `[unpinId, keepId]`, or `[keepId, unpinId]`.
11. **Teardown.** Close the client, then clear the application data. Each
    step runs even if an earlier one throws. The shared fixtures then run
    their own guarded cleanup.

### D7. Documented reinterpretations

- **Toolbar pinned control (117).** At Pixel 5 the desktop `open-pinned`
  button is `max-md:hidden`. The suite taps the toolbar overflow button (the
  same `header-pin` control, with the same pin badge) and its "Pinned
  messages" item. Both call `openPinnedPanel()`. A receipt proves
  `open-pinned` is hidden, and the stage fails closed if it is not (D3).
- **Panel layout.** The predecessor measures a side column at 1280×720.
  Here the panel is a full-screen overlay that covers the Room header. The
  three `boundingBox` reads do not depend on occlusion, and every predicate
  is unchanged (D5).
- **REST login (51–60).** The shared fixture's session replaces it (D1).
- **Account naming (44–45).** The shared fixture's namespaced username and
  generated password replace `pinner-<run>` and `pinner-pass-<run>`. Both are
  registered secrets.
- **Visibility (119, 157).** Visible means one element with a non-empty box
  and `visibility: visible`. Polls use at least the predecessor's bound, and
  the 5 s defaults become 20 s (D4).
- **Negative text (159) and persistence (157).** The predecessor's
  `not.toContainText` and `toBeVisible` pass on the first matching read.
  Here they must hold on every read for 2 s, as #754 held its negative
  claims, and never on a closed or empty panel.
- **Pin order.** The predecessor's comment says "in pin order" but asserts
  only the count. The suite keeps record 2 count-only and proves the order in
  a fail-closed receipt (open question 3).
- **Server convergence.** The predecessor trusts the UI. The issue requires
  the Synapse pinned state to converge, so a fail-closed receipt reads it
  back (D6 step 10).
- **Identity without identifiers.** The Room is opened by exact name. Rows
  are found by body. No selector or wait description carries an event or
  Room id.

### D8. Protection

Before any UI step, the suite registers:

- the Account's user id, username and password;
- the Room id and name;
- both bodies, which are also both transaction ids;
- both event ids.

The #752 strict scrub and the fail-closed scan apply unchanged, for one
Account and one Room. That makes the port closer to `message-source-artifacts.mts`
than to #755's two-Room version. No raw `$…` event id, `!…:…` Room id, `syt_`
token, secure-storage payload or password may reach an artifact. Every raster
is deleted, and the gated `android-pinned-message-panel` upload runs only
after `publication-safe` is written. That marker requires:

- 1 stage and 12 records;
- `pixel-5`, attempt 1 and retries 0;
- a clean scan.

Records hold counts, booleans, order labels, measured numbers and digests.
They never hold row text, because each row's text includes the username.

A failed stage is rethrown through `redactStageFailure`. Only error names and
the first line of each message survive, with every registered value and every
Matrix identifier shape redacted. The runner's single throw line is exactly
`throw redactStageFailure(entry.id, failures, secrets);`. A failed guarded
cleanup is rethrown through `redactCleanupFailure`, never as the raw error.

### D9. Teardown and guard strength

The suite writes no device setting, so teardown has only two steps:
`client.close()`, then `device.clearApplicationData(APPLICATION_ID)`. They are
exported as one ordered list, `pinnedPanelTeardown(client, device)`, which the
runner passes to `runPinnedMessagePanelStageCleanup`. Composed source pins
alone are not enough, so every "must run", "must redact" and "must block
publication" property gets a behavioural guard. Each guard fails under
deletion or reordering of the code it protects:

- **Teardown.** The guard runs the exported list with fakes. A throwing
  `close()` must still reach `clearApplicationData`, and the collected
  failures must mark `cleanupFailed`. The recorded order must be exactly
  `['close', 'clear']`. Deleting either step, or swapping them, turns the
  test red.
- **Stage rethrow.** An assertion failure that carries an event id, a Room
  id, the password and Node's appended actual and expected values must reach
  the thrown error as its first line only, redacted. Removing the first-line
  cut or the redaction turns the test red. The throw-line pin catches a
  replacement with `throw failures[0]` or an `AggregateError`.
- **Cleanup rethrow.** A guarded cleanup that throws with an identifier must
  mark the stage failed, save `journeys.json` and rethrow an id-free error.
  Replacing the rethrow with `throw error` turns the test red.
- **Publication.** Behavioural tests of `markPinnedMessagePanelDiagnosticsSafe`
  cover a short record list, a retry, a wrong profile, a failed cleanup and
  an unscrubbed identifier. Each one must withhold the marker.
- **Windows.** A behavioural test drives the stage with a fake client whose
  unpin `tapCurrent` advances a fake clock by 45 s before it returns. The drop
  to one item then arrives 25 s later. The stage must pass. The same drop
  arriving 31 s after the tap returns must fail. A window anchored anywhere
  earlier would fail the first case.

### D10. CI placement and budgets

- **Shard.** Shard 3 goes last, after `message-spoiler`. The `ci.yml` budget
  comment gives these figures, with job limits of 240 minutes for shards 3
  and 4 and 180 for the rest. Headroom is
  `limit − figure − 45 (retained Playwright) − 15 (diagnostics)`:

  | Shard | Figure | Limit | Headroom |
  | ----- | ------ | ----- | -------- |
  | 1     | 84     | 180   | 36       |
  | 2     | 75     | 180   | 45       |
  | 3     | 78     | 240   | 102      |
  | 4     | 79     | 240   | 101      |
  | 5     | 78     | 180   | 42       |
  | 6     | 89     | 180   | 31       |

  Shard 3 has the most headroom. It also had the shortest hosted job in
  run 36436865291: 74 minutes, against 87–107 minutes for the others (open
  question 4).

- **Budget.** The estimate is about 5 minutes: the probe's 2.5 minutes plus
  install, provenance and the settle and hold waits. That gives
  78 + 5 = 83, and 83 + 60 = 143 ≤ 240. The acceptance task replaces the
  estimate with the measured local time, rounded up. It changes `shard 3 about 78`
  and adds "Shard 3 also carries pinned-message-panel at its N-minute local
  acceptance time until a hosted run measures it."
- **Timeouts.** A 15-minute Node test (`--timeout-ms=900000`) and a 20-minute
  CI wrapper (`1200000`), as for message-source and message-unread.
- **Docs.** No CHANGELOG or README change: this is a test-only migration with
  no user impact.

### D11. MIGRATION.md section

The suite appends `## Pinned-message panel journey` after
`## Message-unread journey`, in the #755 shape:

- the source pin, the 12-row identity table and the 12/0 prose;
- the arrangement and native-ownership paragraph;
- the protection paragraph (D8, including the first-line rethrow sentence);
- `Documented reinterpretations of the predecessor:` with the D7 bullets;
- known-limitation bullets:
  - **Desktop path.** The desktop `open-pinned` button and the side-column
    layout are not exercised on Android. The predecessor covers them until it
    is retired (open question 5).
  - **Safe-area growth.** `env(safe-area-inset-top)` is 0 under the emulated
    profile, so the header's inset growth on a notched device is not
    exercised.
- the command block and the target paragraph (one attempt, zero retries,
  15/20-minute bounds, the shard-3 placement);
- the acceptance paragraph, written in Task 4;
- `Predecessor status: enabled; the coordinator retires it after hosted
acceptance.`

## Negative-control plan

For each control, the guard must fail when its protection is removed:

- **Sources.** The three SHA-256 pins, the 12/0 site map with binding
  expansion (including a shadowing-helper control), and each text pin under
  an in-memory mutation:
  - `pinner-`, `Pinned Room `, `unpin-me-` and `keep-me-`;
  - `preset: 'private_chat'`;
  - the transaction-is-body path;
  - `pinned: [unpinId, keepId]`;
  - the `p` run suffix, `toBeCloseTo(12, 0)`, `toBeLessThan(2)`, the three
    30 s bounds (113, 119, 155) and the 10 s click bound.
- **Pin order and count.** The arrangement must fail on:
  - pins `[keepId, unpinId]`, `[unpinId]` or three pins;
  - a third message, or the messages in the wrong order.

  Record 2 must fail on one or three items. The `pin-order` receipt must fail
  on a reversed rendered order.

- **Panel visibility and persistence.** Record 1 must fail on a panel that
  never appears. Records 10–12 must fail when the panel closes, or shows zero
  items, on any read in the 2 s hold.
- **Row-specific, server-backed unpin.** The stage must fail on:
  - a tap on the `keep` row's control (the UI keeps `unpin`);
  - both rows removed;
  - the UI drops the row but the server still holds both pins;
  - the server drops `keep` instead;
  - an `unpin-target` read where the control lies outside the row, or two
    controls match.
- **Remaining and removed content.** `containsKeep` must be true, and
  `containsUnpin` must be false, on every held read.
- **Geometry.** Each record must fail on its boundary value:
  - heights 56 and 45 (the historical bug), and 56 and 56.01;
  - insets 12.5 and 11.5 (12.49 passes);
  - imbalances 2.0 and 1.99 (1.99 passes);
  - a `null` box for each of the three bars;
  - a first header that does not name the Room.

  The geometry must also fail on an unsettled pair (a moved box, or
  `animating` true) that never settles within the window.

- **Windows.** The anchored-window test (D9), in both directions.
- **Native ownership.** A tap replaced by a renderer dispatch, a missing
  trusted activation, `open-pinned` visible at Pixel 5, and each banned token
  in any suite source:
  - `.click(`, `.focus(`, `dispatchEvent`;
  - `.value =`, `location.`, `history.`, `scrollTo`, `scrollIntoView`;
  - `setViewportSize`;
  - `unpin(` as a renderer call;
  - `new SharedStageAccount(`, `input_method`, `dumpsys`.
- **Cleanup and redaction.** The D9 behavioural controls; every identifier
  form, credential and token in the scan; rasters; a failed cleanup, scrub or
  scan; revocation on abort; and the throw-line pin.

## Evidence and acceptance plan

1. Run the guard, the typecheck, ESLint on the changed files, the neighbour
   guards and the full `pnpm nx run scripts:test`.
2. Develop on the device until the stage passes. Fix each finding at its
   root, and add one guard control per fix.
3. On the final unchanged commit, with a fresh production renderer, run three
   consecutive `trinity-e2e-android:pinned-message-panel` first attempts.
   Each must show:
   - 1/1 stage and 12/12 records at attempt 1, with zero retries;
   - `publication-safe`;
   - matching built and installed APK digests;
   - a clean identifier and raster scan.
4. Run the predecessor sequentially at `--workers=1 --retries=0`.
5. Hosted: the coordinator audits the original-attempt shard-3 Android
   artifact, the browser artifact and the renderer artifact, then retires the
   predecessor and updates the parent ledger.

## Open questions for the coordinator

1. **The toolbar control at Pixel 5.** The issue says "tap the toolbar pinned
   control". At the production profile that control (`open-pinned`) is
   `max-md:hidden`. The alternatives are:
   - (a) the product's own mobile path: the toolbar overflow button, then
     "Pinned messages";
   - (b) a ≥ 768 px profile, such as the shared `DESKTOP_ACCOUNT_PROFILE`,
     where `open-pinned` shows and the panel is a drawer or column.

   **Recommendation: (a).** It keeps the #755 ruling that every migrated suite
   uses Pixel 5, and it is the path a phone user takes. A fail-closed receipt
   keeps the choice honest. Option (b) would test a layout no Android phone
   renders.

2. **Pinned-state fixture.** The alternatives are:
   - (a) add `'m.room.pinned_events'` to the shared `WorkspaceRoomStateEventType`
     union and reuse `setRoomState` and `roomState` (a one-line, type-only
     shared change);
   - (b) a suite-local REST fixture with its own password session, on the
     #755 pattern.

   **Recommendation: (a).** It is one line against about 150 lines plus
   fixture tests. The token never leaves the shared closure, and no guard
   pins the union's full member list (link-preview checks only that
   `m.room.encryption` is present). This breaks #755's "no shared source
   changes" precedent, which is why it is asked.

3. **Rendered pin order.** The predecessor asserts only the count. The issue's
   negative controls include "exact pin order". **Recommendation:** keep
   record 2 count-only (faithful) and prove the rendered order `[unpin, keep]`
   in a fail-closed receipt. The published order is proved separately by the
   arrangement read-back.
4. **Shard.** **Recommendation: shard 3**, last after `message-spoiler`. It
   has 102 minutes of headroom against shard 4's 101, and it had the shortest
   hosted job in run 36436865291. The #755 spec called shard 3 "nearly full".
   The budget figures do not support that, so please confirm. If the
   recommendation is wrong, one `ci.yml` line moves to shard 4.
5. **Retirement scope.** Retiring the predecessor ends end-to-end coverage of
   the desktop `open-pinned` button and the side-column layout. Under the
   #839 policy, implicit web-only paths were accepted as lost until #661.
   **Recommendation:** retire the whole file on hosted acceptance, and record
   the desktop path under the MIGRATION known limitations and the retirement
   table. The alternative is to keep it desktop-only and skip it on Android.
6. **Held negative claims.** Records 10–12 hold for 2 s rather than passing
   on the first read. **Recommendation: keep the hold.** The issue asks to
   prove the panel "stays open", and #754 set this precedent for negative
   claims.
