# Android Unread-Divider Maestro Migration Design

- Issue: #755, part of #660; blocked by #754 until its original-attempt hosted evidence is accepted
- Status: Design recorded autonomously for coordinator review; open questions at the end
- Branch: local `wip/755-unread-divider` from `1b71a81f` (the head of PR #677 with the #754 message-swipe suite); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.message-unread` suite. Implementation and acceptance evidence are
tracked in `e2e/android/MIGRATION.md`. The #752 message-source suite is the
structural template for a single-stage suite: contract, read-only observer,
artifacts and journeys modules, a Vitest guard with effective negative
controls, and the same registry, Nx, package and CI wiring. The suite-local
REST fixture follows the message-spoiler fixture. The real reduced-motion
setting and its restore follow composer-typing. Native gesture lessons from
#754 are applied where they reach this journey.

## Intent and source boundary

Migrate the one canonical unread-divider and jump-to-unread definition to one
serial, single-stage installed-Android Node suite against real Synapse. The
Playwright predecessor stays enabled and unchanged. The coordinator retires it
after hosted acceptance, under the 2026-09-26 policy.

The source of truth is
`e2e/browser/journeys/conversations/message-unread.spec.mts` (278 lines) at
SHA-256 `f66ad80bb41f3cc32fb45935a88ad5a94582d1a8921069517f5f0a891d40b8bd`.
The branch file hashes to the issue's pin, so no `develop` reconstruction is
needed. The guard also pins, by SHA-256:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`     | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts` | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |

| Span    | Role                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------ |
| 21–40   | `apiToken`: password login for a REST access token                                               |
| 42–57   | `sendText`: one `m.text` event by transaction                                                    |
| 59–67   | `openRoom`: rail, `.channel` by name, composer visible (64)                                      |
| 72–277  | the definition                                                                                   |
| 97–154  | arrangement: Room with the member invited, join, `seen already`, both markers, 14 unread, thread |
| 157     | `setViewportSize(1000×400)` (browser-only control 1)                                             |
| 223–237 | `Element.prototype.scrollIntoView` patch recording `behavior` (browser-only control 2)           |
| 255     | `emulateMedia({ reducedMotion: 'reduce' })` (browser-only control 3)                             |
| 266     | `scroll.evaluate(el => el.scrollTo(…))` (browser-only control 4)                                 |
| 268–270 | `__scrolls = []` global reset (replaced with a fresh sampler per window)                         |

## Parity records: 13 direct + 1 helper-expanded = 14

`expect(…)` sites are counted as in the edit-history guard. `openRoom` is called
once (line 164) and reaches one site (64). `apiToken`, `sendText`,
`registerUser` and `login` reach none. `64@164` reads as helper line 64 reached
from the call on line 164.

| #   | Source | Predecessor claim                                    | Suffix                   |
| --- | ------ | ---------------------------------------------------- | ------------------------ |
| 1   | 64@164 | composer visible after opening the Room              | `room-ready`             |
| 2   | 168    | divider text matches `/New messages/i`               | `divider-text`           |
| 3   | 171    | exactly one `.thread-connector` in the divider       | `one-thread-connector`   |
| 4   | 184    | connector extends ≥ 7.99 px above the divider        | `connector-above`        |
| 5   | 185    | connector extends ≥ 7.99 px below the divider        | `connector-below`        |
| 6   | 206    | computed `flex` / `center` / `600` / `::before` 1    | `divider-styled`         |
| 7   | 217    | jump pill visible at initial bottom settlement       | `jump-visible`           |
| 8   | 240    | jump pill hidden after activation                    | `jump-hidden`            |
| 9   | 246    | the jump scrolled smoothly                           | `smooth-trajectory`      |
| 10  | 256    | `(prefers-reduced-motion: reduce)` matches           | `reduced-motion-query`   |
| 11  | 267    | jump pill visible again at the newest message        | `jump-visible-at-latest` |
| 12  | 272    | jump pill hidden after the reduced-motion activation | `reduced-jump-hidden`    |
| 13  | 275    | the reduced-motion jump scrolled at all              | `reduced-scrolled`       |
| 14  | 276    | every reduced-motion movement is automatic           | `automatic-only`         |

One stage, `divider-jump`. Identities are `message-unread.divider-jump.<suffix>`,
in the order above. There are 14 unique identities and 14 stage-local records.

## Selected architecture

| Unit      | File                                        | Responsibility                                                                              |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Guard     | `scripts/message-unread-migration.spec.mjs` | Source pins, AST site map with binding expansion, browser-control bans, controls, wiring    |
| Contract  | `e2e/android/message-unread-contract.mts`   | Stage, 14 identities, arrangement constants, pure parsers, asserters, trajectory classifier |
| Observer  | `e2e/android/message-unread-observer.mts`   | Read-only view expressions and the passive animation-frame scroll sampler                   |
| Fixture   | `e2e/android/message-unread-fixture.mts`    | Private REST session: both read markers, the thread relation, the `m.fully_read` read-back  |
| Artifacts | `e2e/android/message-unread-artifacts.mts`  | The #752 secrets, scrub, scan and marker policy for two Accounts and two Rooms              |
| Journeys  | `e2e/android/message-unread-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, native helpers, the one stage and teardown     |

No shared source changes. `account-workspace-client.mts` (`reset`, `relaunch`,
`login`, `hideKeyboard`, `tapCurrent`, `visible`, `capture`, `record`,
`device.adb`) and `account-workspace-fixtures.mts` (`account`, `createRoom`,
`join`, `sendMessage`, `roomMessages`) are reused unchanged. The shared
fixtures have no read-marker writer, no relation sender and no account-data
reader. These three live in the suite-local fixture, whose access tokens stay
in its closure and are logged out in a bounded cleanup, as in
`message-spoiler-fixture.mts`.

## Feasibility probes

Local probes ran on 2026-09-28 against the renderer and debug APK built from
`1b71a81f`, the API 36 emulator (Pixel 6 AVD, gesture navigation) and the
Pixel 5 profile. Every probe file was deleted, and no probe was committed.

1. **Overflow at the production profile.** With exactly the predecessor's
   arrangement, the opened Room's `.scroll` had `scrollHeight` 714 against
   `clientHeight` 416 at `scrollTop` 298.67. The divider's box started at
   y = 132, above the scroller's top at y = 217. The jump pill was visible at
   (135, 225, 122×44). This state was stable for 6 s. The installed app
   renders `trn-virtual-message-list`, and the IME was hidden after open.
2. **Divider on device.** `textContent` was `New messages` (the rendered text
   is uppercase through `text-transform`). There was one `.thread-connector`,
   extending 7.99999 px above and 8.00001 px below: the predecessor's 0.01
   tolerance is still needed. The computed style was exactly `flex`,
   `center`, `600` and `::before` flexGrow `1`.
3. **Default jump.** A Maestro tap on `jump-to-unread` moved `scrollTop` on
   consecutive animation frames 298 → 270 → 187 → 153 → 106 → 80. The
   virtual list's re-aim then settled it at 137.5, for 10 changes in about
   1 s. The pill hid, the divider settled inside the scroller (y = 388), and
   `jump-to-latest` appeared.
4. **Return to newest.** A Maestro tap on `jump-to-latest` moved `scrollTop`
   to the bottom (394.3 of 810 − 416) and showed the jump pill again.
5. **Reduced motion is not live.** With `animator_duration_scale` set to `0`
   while the app ran, the query stayed `false` for 10 s. After
   `client.relaunch` (force-stop and cold start), it was `true`. This matches
   the composer-typing proof.
6. **The unread anchor does not survive a relaunch.** The product advances
   `m.fully_read` when a Room is viewed, so the marker had moved after the
   first open. On relaunch the same Room had no divider and no pill. Posting
   the original event to `read_markers` again left the marker moved, because
   Synapse only moves `m.fully_read` forwards.
7. **A second, unopened Room keeps its anchor.** A Room arranged identically
   but never opened stayed at `seen already` through the first session and
   the reduced-motion relaunch. Opened under reduced motion, it showed the
   divider off-screen and the pill visible, exactly as in probe 1.
8. **Reduced-motion jumps.** The first jump (target row windowed out) moved
   298 → 43 → 80 → 138 on non-consecutive frames (664, 668, 671). Returning
   to newest with `jump-to-latest` was one change. The second jump (target row
   rendered) was one change, 394 → 138.
9. **The trajectory evidence discriminates.** Under reduced motion, an
   explicit probe-only `scrollTo({ behavior: 'smooth' })` still animated
   (15 changes in 77 frames). An app that ignored the query would therefore
   be caught by the trajectory on device.
10. **Tap latency.** Each `tapCurrent` took 13.5–16.8 s end to end, including
    the Maestro flow. The whole probe took about 4 minutes, Synapse included.

## Decisions

### D1. Profile, Accounts and sign-in

- The stage runs at the shared Pixel 5 profile (`PIXEL_5_ACCOUNT_PROFILE`,
  393×727 CSS px, DPR 2.75, mobile, touch). The shared harness applies it only
  at `reset` and `relaunch`. The journey never resizes the viewport, which
  replaces browser-only control 1. Probe 1 proves the predecessor's
  precondition at this profile without a resize: the divider is off-screen
  above and the pill shows on open. The applied profile is read back after
  each launch, and the stage fails before any tap if it differs.
- There are two fresh Accounts, reader and member, as in lines 80–95. There is
  no `SharedStageAccount`: the suite has one stage, and the reader's read
  state is the subject under test. The `scripts/android-native-actions.spec.mjs`
  `sharedSuites` guard is therefore unchanged.
- The reader signs in through the one-flow `client.login`
  (`accounts-sign-in.yaml`). Nothing else is typed or sent through the UI, so
  the `fillFocused` digit-sentinel rule and the `composer-send` rule do not
  arise. Adding UI text entry later would bring both rules back.

### D2. Arrangement: two identical Rooms

Through real Synapse, as lines 97–154, done twice before any UI step:

- Room A, `Unread E2E <run>-motion`, is used under default motion.
- Room B, `Unread E2E <run>-reduced`, is used under reduced motion. Neither
  name is a substring of the other.

In each Room:

- the reader creates it with the member invited (`createRoom`, no preset, as
  line 100), and the member joins;
- the member sends `seen already` (transaction `<run>-<room>-a`, where
  `<room>` is `motion` or `reduced`);
- the reader posts `read_markers` with both `m.fully_read` and `m.read` set to
  that event;
- the member sends `unread message 0` to `unread message 13`
  (`<run>-<room>-b<i>`);
- the reader sends `Thread after the unread marker` with an `m.thread`
  relation and `m.in_reply_to`, both naming unread event 2
  (`<run>-<room>-thread`).

Before the first UI step, each Room's raw `/messages` page must hold exactly
these 16 events, in order, with their senders and the relation. The reader's
`m.fully_read` must name `seen already`. Room B's marker is read again
immediately before it is opened. `run` is the stage's namespace alias plus the
predecessor's `u`.

The reason for Room B is probes 5–7. Real reduced motion needs a cold
relaunch. The relaunch loses Room A's anchor because the product advances the
marker, and Synapse refuses to move it back. The only faithful way to repeat
the jump under reduced motion is a Room with the identical arrangement that
has never been viewed.

### D3. Native action ownership

- Every product action is a Maestro tap through `client.tapCurrent`, which
  proves one trusted, matched activation of the target. The taps are
  `rail-rooms`, the `.channel` row by exact name, `jump-to-unread` and
  `jump-to-latest`.
- The return to the newest message (browser-only control 4) is a native tap
  on the product's `jump-to-latest` control (`aria-label` "Jump to latest
  messages"). It is preferred over a native swipe because it is one
  deterministic product action, and it cannot cross the auto-load threshold
  that line 263 warns about. A receipt proves that the scroller then sits at
  its bottom (`scrollTop + clientHeight ≥ scrollHeight − 1`) and that
  `jump-to-latest` has gone.
- The tap targets are the pill centre, about (196, 247) CSS px, and the
  jump-to-latest centre, about (355, 599). Both are at least 30 CSS px clear of
  the timeline's 8 px scrollbar (x 385–393) and far from the gesture-navigation
  edge zones. No swipe is used, so #754's scrollbar and `pointercancel`
  findings do not reach this suite. They are why the swipe alternative was
  rejected.
- Keyboard: `client.hideKeyboard()` runs after sign-in and after the
  reduced-motion relaunch. It reads the IME through `android-ime.mts` and
  records `shownBefore`. The suite contains no other IME read. Probe 1 saw no
  IME after opening the Room, because focus moves to the Room heading.
- Precondition: before the stage, the suite reads `navigation_mode` into
  `navigation-mode.json` and fails closed unless it is `2`. It also reads
  `animator_duration_scale` and fails closed unless the live query is `false`
  after the first launch. Either condition would mean an earlier probe or
  suite had left the emulator in a bad state.

### D4. Observation-only trajectory sampler (replaces browser-only control 2)

Before each jump, the observer starts a fresh sampler under a new,
never-reused window key. On each `requestAnimationFrame` it only reads the
`.scroll` scroller's `scrollTop` and the divider's rect, then appends
`[t, scrollTop, dividerInView]` to its own array. It stops itself after 60
unchanged frames following the first movement, or at a 45 s cap (a tap takes
up to 17 s). Node then polls its `done` flag. Nothing is patched, called,
assigned, focused or cleared: a second window gets a new key rather than an
emptied array. This also replaces the `__scrolls = []` reset at 268–270.

The pure classifier in the contract takes the samples:

- **Baseline.** At least 30 unchanged frames before the first movement, so
  the scroller was still when the tap began.
- **Movement.** A movement is a frame-to-frame change of at least 1 CSS px.
  A run is a sequence of consecutive frames that move in the same direction.
- **Smooth** (line 246). At least one run of 4 or more frames. Probe 3 had a
  run of 5.
- **Automatic** (line 276). At least one movement, and no run longer than 2
  frames. Probe 8 had isolated steps (runs of 1).
- **Ambiguous.** A longest run of exactly 3 is neither smooth nor automatic,
  and fails closed.
- **Settled.** After the last movement, the divider lies inside the
  scroller's box.

Line 275 (`reduced.length > 0`) becomes "at least one movement", and line 276
(`set == ['auto']`) becomes "automatic". Probe 9 shows that Chromium still
animates an explicit smooth scroll under reduced motion, so the classifier
detects an app that ignores the query. The samples are published as
`trajectory-default.json` and `trajectory-reduced.json`, containing numbers
only.

### D5. Real reduced motion: hard feasibility gate (replaces browser-only control 3)

- **Apply.** The stage saves `settings get global animator_duration_scale`
  (`null` locally), then sets `settings put global animator_duration_scale 0`.
  A flag is set before the write, so teardown restores it even if the write
  throws. The stage then runs `client.relaunch(PIXEL_5_ACCOUNT_PROFILE)`, which
  keeps the persisted session, and `client.hideKeyboard()`.
- **Query.** The stage polls `matchMedia('(prefers-reduced-motion: reduce)').matches`
  read-only for up to 20 s, and it must become `true` (record 10). If it never
  does, the stage writes `reduced-motion/feasibility.json` (prior value,
  applied value, observed query, relaunch receipt) with `feasible: false` and
  fails closed. The publication marker requires `feasible: true`. No CDP media
  emulation or renderer shim ever substitutes.
- **Scope.** Only `animator_duration_scale` changes. It is the signal
  Chromium's WebView projects as reduced motion, as probe 5 and composer-typing
  showed. The transition and window scales stay untouched, so there is less to
  restore.
- **Restore.** Teardown restores the exact prior value (`settings delete` when
  it was `null`) before `client.close()` and the application-data clear. It
  reads the value back and fails the stage if it differs. The retained
  Playwright run that follows on the shard uses the same emulator.

### D6. Stage sequence

1. **Launch.** Run the preconditions (D3), `reset` at Pixel 5, record the
   applied profile, `login` the reader, then `hideKeyboard`.
2. **Room A, default motion.** Open Room A natively. Record `room-ready`,
   then read the divider in one renderer turn. Record `divider-text`,
   `one-thread-connector`, `connector-above`, `connector-below` and
   `divider-styled`.
3. Poll the pill for up to 20 s and record `jump-visible`.
4. Start the sampler, tap `jump-to-unread`, and poll until the pill is hidden
   (up to 20 s). Record `jump-hidden`.
5. Wait for the sampler to finish, classify the samples and record
   `smooth-trajectory`.
6. **Reduced motion.** Apply it (D5) and record `reduced-motion-query`.
7. **Room B, reduced motion.** Read Room B's marker (it must still be
   `seen already`), open Room B natively, prove the pill visible and the
   divider off-screen above (receipt), then tap `jump-to-unread`. A receipt
   proves the pill hidden and the divider in view, with the trajectory
   recorded but not classified. This step recreates the predecessor's
   state before its return to newest.
8. Tap `jump-to-latest` natively and prove the bottom receipt (D3). Record
   `jump-visible-at-latest`.
9. Start a fresh sampler, tap `jump-to-unread`, and record
   `reduced-jump-hidden`. Classify the samples, then record `reduced-scrolled`
   and `automatic-only`.
10. **Teardown.** Restore the setting (D5), then close the client, clear the
    application data and clean up the fixtures.

The single `openRoom` helper expansion (line 64) maps to Room A only. Room B's
readiness is a receipt.

### D7. Documented reinterpretations

- **Viewport (157).** The predecessor sets 1000×400 so the divider starts
  off-screen. Here the Pixel 5 profile is applied at launch, and probe 1
  proves the same precondition (D1).
- **Recorded `behavior` (223–246, 268–276).** The predecessor reads the
  argument passed to `scrollIntoView`. Here it is the observed frame
  trajectory (D4). The issue forbids inferring behaviour from options.
- **Media emulation (255–260).** This becomes the real Android animator
  setting and a cold relaunch, with the query read without writing (D5).
- **Direct `scrollTo` (266).** This becomes a native tap on `jump-to-latest`
  (D3).
- **Reduced-motion jump in Room B (D2).** The predecessor repeats the jump in
  the same Room. Here the repeat runs in an identically arranged Room that has
  never been opened, because the product advances the marker and Synapse
  keeps it monotonic. Room B's own first jump and return to newest recreate
  the predecessor's state before line 267.
- **Text (168).** Playwright's `toHaveText` reads `textContent`, which must
  match `/New messages/i`. The rendered uppercase `innerText` is also
  recorded.
- **Geometry (174–185).** Both boxes are read in one renderer turn, keeping
  the predecessor's 0.01 tolerance (probe 2 measured 7.99999).
- **Visibility (217, 240, 267, 272).** Visible means one element with a
  non-empty box and `visibility: visible`. Hidden means absent or not visible.
  Each claim is polled for up to the predecessor's 20 s.
- **Room readiness (64).** The composer must be visible within the helper's
  15 s after the native open. The record also proves the route names Room A.
- **Identity without identifiers.** Rooms are opened by exact name, rows are
  found by body, and no selector or wait description carries an event or Room
  id.

### D8. Protection

Before any UI step, the suite registers both Accounts (user ids, usernames and
passwords), both Room ids and names, every transaction, all 32 event ids and
the fixture's access tokens. The #752 scrub and fail-closed scan apply
unchanged, with the second Account and second Room added. No raw `$…` event
id, `!…:…` Room id, `syt_` token, secure-storage payload or password may reach
an artifact. No raster is published. Records hold digests, booleans, texts
fixed by the predecessor, measured numbers and computed styles only.

### D9. CI placement and budgets

- **Shard.** Shard 4, last, after `message-links`. The `ci.yml` budget comment
  gives shard 1 about 84, shard 2 about 75, shard 3 about 78, shard 4 about
  75, shard 5 about 78 and shard 6 about 89 (message-swipe included). Shard 3
  is nearly full. Shards 2 and 4 tie lowest at 75. Shard 4 wins the tie on
  headroom: its job limit is 240 minutes against shard 2's 180.
- **Budget.** The guard requires `figure + 45 (retained Playwright) + 15
(diagnostics) ≤ job timeout`. With the probe's 4 minutes plus install and
  provenance, the estimate is about 6 minutes: 75 + 6 = 81, and
  81 + 45 + 15 = 141 ≤ 240. The acceptance task replaces the estimate with the
  measured local time, rounded up. The comment adds "Shard 4 also carries
  message-unread at its N-minute local acceptance time until a hosted run
  measures it", as #754 did.
- **Timeouts.** The message-source bounds apply: a 15-minute Node test
  (`--timeout-ms=900000`) and a 20-minute CI wrapper (`1200000`), unless
  measurement falsifies them.
- **Docs.** No CHANGELOG or README change: this is a test-only migration with
  no user impact.

## Negative-control plan

For each control, the guard must fail when its protection is removed:

- **Sources.** The source pins and every text pin (bodies, room-name template,
  thread body, both markers, fourteen unread events, the thread root at index
  2), and the 13/1 site map with binding expansion (including a shadowing
  helper).
- **Browser controls.** A `setViewportSize`, `emulateMedia`,
  `Emulation.setEmulatedMedia`, `scrollIntoView`, `scrollTo`, `scrollTop =`,
  `.click()`, `.focus()` or prototype assignment in any suite source except
  the read-only sampler's own array.
- **Read boundary.** A marker naming a different event, thirteen or fifteen
  unread events, a relation to another root, and Room B opened (or its marker
  moved) before the relaunch.
- **Divider.** A wrong text, zero or two connectors, an extension of 7.98 px,
  and each style field changed.
- **Initial gating.** A pill hidden at open, and a divider in view at open.
- **Default trajectory.** A single jump, a 3-frame run, no baseline, and a
  divider not in view after settling.
- **Reduced motion.** A `false` query, `feasible: false`, a relaunch skipped,
  a 4-frame run, and no movement.
- **Native ownership.** A tap replaced by a renderer dispatch, and a missing
  trusted activation.
- **Cleanup and redaction.** A missing or wrong setting restore, a
  `navigation_mode` other than 2, every identifier form, credentials and
  tokens, rasters, a failed cleanup, scrub or scan, abort revocation, and a
  redacted rethrow.

## Evidence and acceptance plan

1. Guard, typecheck (`e2e/tsconfig.json`), ESLint on the changed files, and the
   full `pnpm nx run scripts:test`.
2. Device development until the stage passes; findings are fixed at the root.
3. On the final unchanged commit, with a fresh production renderer: three
   consecutive `trinity-e2e-android:message-unread` first attempts. Each must
   show 1/1 stage and 14/14 records at attempt 1 with zero retries,
   `publication-safe`, `feasible: true`, the setting restored, matching built
   and installed APK digests, and a clean identifier scan.
4. The predecessor at `--workers=1 --retries=0`.
5. Hosted: the coordinator audits the original-attempt shard-4 artifact, then
   retires the predecessor.

## Open questions for the coordinator

1. **"Production Android viewport."** This design reads it as the shared
   Pixel 5 profile, applied once at launch. The unemulated native WebView
   viewport (about 411×914 on the Pixel 6 AVD) would need a shared
   `AccountWorkspaceClient` change, because `reset` and `relaunch` always apply
   a profile. No shared root cause justifies that change.
2. **Room B.** The reduced-motion repeat runs in a second, identically
   arranged Room (D2, D7). Probes 5–7 show the alternative is impossible
   without the renderer or server writes the issue forbids. Please confirm
   that this reinterpretation is acceptable against "send exactly fourteen
   later unread events", which each Room satisfies on its own.
3. **Shard 2 or 4.** They tie at 75. This design picks shard 4 for its
   240-minute headroom. Shard 2 also fits: 81 + 60 = 141 ≤ 180.
