# Android Message-Swipe Maestro Migration Design

- Issue: #754, part of #660; blocked by #753 until its original-attempt hosted evidence is accepted
- Status: Design accepted for local implementation
- Branch: local `wip/754-message-swipe` from `266dcc1d` (the green head of PR #677's `test/676-android-sidebar-filter`); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.message-swipe` suite. Implementation and acceptance evidence are
tracked in `e2e/android/MIGRATION.md`. The #752 message-source suite is the
structural template: contract, read-only observer, artifacts and journeys
modules, a Vitest guard with effective negative controls, and the same
registry, Nx, package and CI wiring. The shared-Account pattern comes from
#839 (`SharedStageAccount`), the native Preferences seed from the GIF suite,
and the held-pointer observation from the native long press.

## Intent and source boundary

Migrate all fourteen canonical message-swipe and edge-gesture definitions to
one serial, fourteen-stage installed-Android Node suite against real Synapse.
The Playwright predecessor stays enabled and unchanged; the coordinator
retires it after hosted acceptance, under the 2026-09-26 policy.

The source of truth is
`e2e/browser/journeys/conversations/message-swipe.spec.mts` (626 lines) at
SHA-256 `435f360188e627c7942e29988f62dd4654955317eb23f0980adabea23fd7bdb4`.
The branch file hashes to the issue's pin, so no `develop` reconstruction is
needed. The guard also pins, by SHA-256:

| File                                  | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `e2e/support/journeys/navigation.mts` | `43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81` |
| `e2e/support/touch-platform.mts`      | `8bbf71ffc3e83010599c30ed5c2c347972f5a7b559daa6394613e33af2c43ee1` |
| `e2e/support/app.mts`                 | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts`             | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |

| Span    | Role                                                                                       |
| ------- | ------------------------------------------------------------------------------------------ |
| 35–38   | `SWIPE_KEY = 'trinity.message-swipe'`, `DRAWER_OPEN_FROM_RIGHT_PX = 44`                    |
| 41–156  | `openRoom`: paired Accounts, Room, theirs then mine, fillers, seed, login, open, readiness |
| 122–141 | its long-Room branch: back-pagination until the own row loads (127)                        |
| 158–172 | `swipeRow`: a rightward drag from 35% to 95% of the row at its centre                      |
| 180–624 | the fourteen definitions (537–566 is one definition run for `left` and `off`)              |

## Parity records: 38 direct + 36 helper-expanded = 74

`expect(…)` and `expect.poll(…)` are both assertion sites, as in the
edit-history guard. Helper expansion is resolved by binding: a call expands
only when the TypeChecker binds it to a module-level function of the
predecessor or a named import from `../../../support/`. `openRoom` reaches
112 and 118 on every call and 127 only when `filler > 0`; the navigation
helpers are expanded along their Android branch (the statements after an
`if (isAndroidE2E) { …; return; }` block are the desktop path). `registerUser`,
`login`, `seedPreference`, `cdpSwipe` and `touchPlatform.swipe` reach no
site. `112@184` reads as helper line 112 reached from the call on line 184.

| Stage (tag, seed, filler)            | Source (helper@call)                                             | Suffix                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit-own` (e, right, 0)             | 112@184, 118@184, 188                                            | `room-ready`, `encryption-banner`, `editing`                                                                                                                                                                                                         |
| `reply-other` (r, right, 0)          | 112@197, 118@197, 201                                            | `room-ready`, `encryption-banner`, `replying`                                                                                                                                                                                                        |
| `partial-affordance` (a, right, 0)   | 112@211, 118@211, 234, 238, 242                                  | …, `own-affordance-visible`, `own-edit-affordance`, `other-reply-affordance`                                                                                                                                                                         |
| `progressive-feedback` (p, right, 0) | 112@253, 118@253, 309–318                                        | …, `partial-opacity-positive`, `partial-opacity-below-one`, `armed-opacity-one`, `armed-scale-changed`, `armed-colour-changed`                                                                                                                       |
| `off-inert` (o, none, 0)             | 112@333, 118@333, 335, 338                                       | …, `no-affordance`, `no-banner`                                                                                                                                                                                                                      |
| `left-direction` (l, left, 0)        | 112@345, 118@345, 349, 361                                       | …, `right-drag-rejected`, `left-drag-replying`                                                                                                                                                                                                       |
| `left-strip-geometry` (g, left, 0)   | 112@377, 118@377, 411, 412                                       | …, `icon-past-row-end`, `icon-inside-original-row`                                                                                                                                                                                                   |
| `vertical-abandon` (v, right, 30)    | 112/118/127@426, 440, 441                                        | …, `history-loaded`, `no-banner`, `no-drag-style`                                                                                                                                                                                                    |
| `vertical-scroll` (s, right, 30)     | 112/118/127@459, 488, 489                                        | …, `history-loaded`, `timeline-moved`, `no-banner`                                                                                                                                                                                                   |
| `edge-dead-zones` (d, right, 0)      | 112@500, 118@500, 508, 516, 523, 532                             | …, `left-edge-no-banner`, `inset-control-replying`, `right-edge-drawer-hidden`, `inset-drawer-visible`                                                                                                                                               |
| `drawer-left` (l, left, 0)           | 112@545, 118@545, 555, 561, 564                                  | …, `drawer-initially-hidden`, `drawer-opened`, `drawer-closed`                                                                                                                                                                                       |
| `drawer-off` (o, none, 0)            | 112@545, 118@545, 555, 561, 564                                  | …, `drawer-initially-hidden`, `drawer-opened`, `drawer-closed`                                                                                                                                                                                       |
| `drawer-right` (w, right, 0)         | 112@572, 118@572, 575, 583, 587, 590                             | …, `drawer-initially-hidden`, `drawer-opened`, `row-swipe-suppressed`, `drawer-closed`                                                                                                                                                               |
| `live-setting` (c, none, 0)          | 112@599, 118@599, 600, 19/32/59@605, 69/84/99@612, 613, 614, 621 | …, `initially-no-affordance`, `settings-rooms-route`, `settings-sections-visible`, `settings-detail-ready`, `settings-section-unwound`, `rooms-route-restored`, `settings-detached`, `settings-dialog-hidden`, `no-settings-path`, `affordance-live` |

Stage records: 3, 3, 5, 7, 4, 4, 4, 5, 5, 6, 5, 5, 6, 12 = 74. Identities
are `message-swipe.<stage>.<suffix>`, globally unique; within a stage a
helper call's lines precede a later matcher and keep their own line order.
The skipped Playwright compositor definition (448–490, skipped on Android at
453 because the DevTools endpoint cannot pan) is a full stage here, behind the
hard gate below.

## Selected architecture

| Unit       | File                                       | Responsibility                                                                                        |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Guard      | `scripts/message-swipe-migration.spec.mjs` | Source pins, AST site map with Android-branch selection, binding expansion, controls, wiring          |
| Contract   | `e2e/android/message-swipe-contract.mts`   | Fourteen stages, 74 identities, arrangements, pure parsers and asserters for every record and gesture |
| Observer   | `e2e/android/message-swipe-observer.mts`   | Read-only view expression; a passive trusted-pointer recorder                                         |
| Motion     | `e2e/android/message-swipe-motion.mts`     | CSS-to-device mapping via `client.nativeRect`; `input motionevent` down/move/hold/up/cancel           |
| Preference | `e2e/android/message-swipe-preference.mts` | Strict native `CapacitorStorage.xml` read and a single-entry rewrite with the app stopped             |
| Artifacts  | `e2e/android/message-swipe-artifacts.mts`  | The #752 secrets, scrub, scan and marker policy for two Accounts and fourteen stages                  |
| Journeys   | `e2e/android/message-swipe-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, native helpers, the fourteen stages                      |

No shared source changes: `account-workspace-client.mts` (`SharedStageAccount`,
`reset`, `relaunch`, `login`, `tapCurrent`, `visible`, `nativeRect`,
`scrollIntoViewIfNeeded`, `capture`, `record`) and
`account-workspace-fixtures.mts` (`account`, `createRoom`, `join`,
`sendMessage`, `roomMessages`) are reused unchanged.

## Decisions

### D1. Profile and Accounts

- Every stage runs at the predecessor's Pixel 5 profile (393×727 CSS px,
  DPR 2.75, mobile, touch). The gesture is gated on the platform, which the
  installed app reports as Android.
- One shared signed-in Account (`SharedStageAccount('swipe-actor')`) plays the
  predecessor's `swipeact` user in stages 1–13: none tests Account, login or
  session state, and the swipe direction is a device-scoped Preference, set
  explicitly per stage (D4). Each stage gets a fresh other Account
  (`swipefr`) and a fresh Room. `live-setting` is `freshApp`: a cleared app
  and a new sign-in, so its unseeded Off is the untouched install state and no
  Preference is written.

### D2. Arrangement

Through real Synapse, as lines 56–101: the Room `Swipe <run>` with the other
Account invited, its join, `theirs <run>` (transaction `o-<run>`) from the
other Account, then `mine <run>` (`m-<run>`) from ours, then, for the two
long Rooms, `filler 0`…`filler 29` (`f-<run>-<i>`) from ours. The raw
`/messages` page must hold exactly those events, in order, with their
senders, before any UI step. `run` is the stage's namespace alias plus the
predecessor's tag.

### D3. Native motion

- Every gesture is Android's own `input motionevent DOWN|MOVE|UP|CANCEL` on the
  touchscreen, at device coordinates. A path is the predecessor's ten linear
  moves; a complete swipe is one device command (down, ten moves, up).
- CSS points map to the device with the transform native taps use:
  `client.nativeRect` of the measured timeline scroller gives the inset corners,
  and the affine map is required to be uniform; every point must lie inside
  that measured box.
- A held drag is down plus moves in one command; the pointer then stays down
  while the renderer is observed read-only, further moves or the release are
  separate commands, and teardown cancels a pointer that is still down.
- Before every gesture a passive capture recorder copies trusted pointer
  events. Each gesture must arrive as one trusted touch pointer going down
  within 3 CSS px of the planned start, with an interpolated path of moves
  along the plan, ending in `pointerup` (or `pointercancel` where the platform
  takes a scroll), and a held gesture must show no release. Coordinates,
  phases and durations are receipts.

### D4. Native Preference

`trinity.message-swipe` is set only in the native `CapacitorStorage.xml`,
with the app force-stopped: the document is parsed strictly, only that entry
is replaced (or removed for the predecessor's unseeded Off), every other entry
must be unchanged, and the value is read back before the relaunch. The
predecessor's seed-then-boot is exactly that relaunch. After launch the same
value is read again. The document never reaches an argument, log or error.

### D5. Hard feasibility gate (native pan stream and compositor panning)

Local probe (APK from `266dcc1d`, API 36 emulator, 4 cores, 4 GB):

- A held `input motionevent` drag to 55% of a row produced 11 trusted touch
  pointer events and left the row at `--swipe-drag: 77px`,
  `--swipe-progress: 0.799`, affordance opacity `0.799`, icon scale `0.93166`
  and colour `oklch(0.43 0.018 265)` with the finger still down; moving the
  same pointer to 95% armed the row (`msg--swipe-armed`) at opacity `1`, scale
  `1` and colour `oklch(0.47 0.19 275)` before release; `CANCEL` cleared all of
  it.
- A pure vertical native drag on the long Room delivered `pointerdown`,
  `pointermove`, then `pointercancel` as Chromium took the pan, and the real
  scroller moved from 164 to 595 CSS px.

The suite repeats this gate in `vertical-scroll` before its records: one
held, pure vertical 120 CSS px drag must deliver a native stream (one trusted
touch pointer, at least one trusted move, then at most one platform
`pointercancel` and no `pointerup`) and change the scroller's `scrollTop`
while the finger is down. Chromium cancels the pointer when it takes the pan,
so a pan delivers one move, as the probe above showed; held interpolation (at
least two moves with the finger down) is proven by the held horizontal
stages. The result is `vertical-scroll/feasibility.json`, which the
publication marker requires to be feasible. If the gate fails, the stage
fails closed with that artifact; no renderer or CDP scroll ever substitutes.
Line 127's back-pagination is also native: slow vertical drags that pause
before lifting (no fling), bounded to twelve drags and the predecessor's
30 s.

### D6. Gesture navigation owns the screen edges

The emulator (and the hosted runner's API 36 image) uses gesture navigation.
The probe showed that a native touch starting 4 CSS px from the left edge
(device x 10) or 4 CSS px from the right edge (device x 1020) is claimed by
Android's Back recogniser: the page sees `pointerdown` then `pointercancel`,
and the system navigates Back out of the Room. The product's 56 px dead zone
exists because of those recognisers, but under gesture navigation it is never
reached. The drawer's inset band (device x 915) and every in-row start are
outside the recogniser and behave normally.

`edge-dead-zones` therefore runs under three-button navigation: with the app
stopped, the stage selects the `threebutton` navigation-bar overlay and waits
for `navigation_mode` 0, then launches; teardown stops the app and restores
the original mode. Changing the mode with the app running re-creates the
activity and its WebView, so it is never done mid-stage. The left-edge
gesture is held first, and the row must carry no drag state while the finger
is down, before the release and the settled no-banner record. All other
stages run under the device's own gesture navigation.
Before stage 1 the suite reads `navigation_mode`, records it in
`navigation-mode.json` and fails closed unless it is `2` (gesture).

### D7. Negative claims are observed, not sampled

Lines 338, 349, 440, 441, 489, 508 and 523 assert an absence straight after a
gesture. Each is read for 2 s after the gesture and must hold on every read,
so a late banner, drawer or drag state fails it.

### D8. Documented reinterpretations

- **Action binding.** Line 188 also requires the composer to hold exactly the
  own body; 201, 361 and 516 require the banner's `<strong>` to name the other
  Account and the composer to stay empty.
- **Identity without identifiers.** Rows are found by body among
  `.scroll .msg[data-mid]` (system lines excluded), taking the last as the
  predecessor does; a read-only in-page comparison proves that row's `data-mid`
  is the arranged event. No selector carries an identifier.
- **Visibility.** Line 234 is Playwright's box visibility (opacity ignored, as
  the predecessor says); the measured opacity claims are 309–318.
- **Held observation.** 309–318 and 411–412 are read while the native pointer
  is down; the predecessor's closing `touchEnd` becomes a native release.
- **Settings on Android.** The navigation helpers' Android branch becomes
  native taps on `open-settings`, `settings-nav-appearance`, the select and
  its `message-swipe-right` option and the in-app `Back` button, with the
  native Preference read after the choice. Line 621 also requires the same
  document (`performance.timeOrigin` unchanged): no reload.
- **Viewport sizes.** `page.viewportSize()` is the renderer's `innerWidth` and
  `innerHeight`.
- **Right-edge start.** The predecessor starts the `right-edge` swipe at
  `width − 4` (`message-swipe.spec.mts:522`). On the installed WebView no
  trusted `pointerdown` reaches the page at that point: `754-dev6.log`
  captured nine trusted `pointermove` events and one `pointerup`, zero
  `pointerdown`. The timeline `.scroll` overflows in this stage
  (`scrollHeight` 466 against `clientHeight` 416, 364 with the reply banner)
  and draws the product's classic 8 px scrollbar (`--trinity-scrollbar-size`;
  `offsetWidth` 393, `clientWidth` 385). A touch that starts on a scrollbar
  belongs to the scrollbar, so the page gets only the moves after the finger
  leaves it. Native probes in the stage (`754-probe-f1b.log`,
  `754-probe-f1c.log`) confirm it: starts at `width − 4` and `width − 6`
  lost the `pointerdown` every time, before the reply as well as after it
  with the soft keyboard dismissed; starts at `width − 8` and further in
  delivered complete streams. A quiet Room without overflow has no
  scrollbar, which is why an earlier probe saw `width − 4` succeed there. The
  suite starts the right-edge swipe at `width − 24`, 16 CSS px clear of the
  8 px scrollbar and 8 CSS px short of the drawer's 32 px native-history
  strip (`NATIVE_HISTORY_EDGE_PX`, `drawer-swipe.directive.ts:56`), with the
  full D3 native proof unchanged: a trusted `pointerdown`
  at the planned start, the interpolated path, and the ending. The left-edge
  start stays at 4 CSS px; the scrollbar is on the right.

### D9. Protection

Every Account (both user ids, usernames and passwords), Room id and name,
body, transaction and event id is registered before any UI step. The #752
scrub and fail-closed scan apply unchanged, with the second Account added; no
raster is published; records hold digests, booleans, measured numbers and
computed styles only.

### D10. CI placement and budgets

Shard 6, last, after `message-quote`: run 36342631152 measured shard 6 at 79
minutes, the lowest of the six (97, 87, 91, 86, 90, 79). Timeouts are derived
from the local acceptance runs (MIGRATION.md records them). No CHANGELOG or
README change: test-only migration with no user impact.

## Negative-control plan

The guard must fail, for each control, when its protection is removed:
source pins and every text pin; the 38/36 site map and binding expansion
(including a shadowing helper and the desktop navigation branch); native
gesture ownership (a renderer dispatch, a non-trusted or mouse event, a start
off the plan, a missing path, a released held pointer); own/other binding
(Editing on the other row, a reply naming ourselves, a composer without the
body); partial and progressive feedback (opacity 0 or 1 part-way, not armed at
95%, unchanged scale or colour, a released pointer); Off, Left, the trailing
strip and abandonment (an affordance while Off, a Right-committed Left, an
icon outside the strip, a residual `--swipe-drag`); real vertical movement
(an unchanged offset, a failed feasibility gate); edge and drawer coexistence
(a drawer that never opens or closes, an affordance over the open drawer, an
armed edge start, missing three-button restoration); the live no-reload
update (a changed `timeOrigin`, a Preference not Right, a seeded live stage);
and cleanup/redaction (every identifier form, credentials, rasters, a failed
cleanup, scrub or scan, abort revocation, redacted rethrow).

## Evidence and acceptance plan

1. Guard, typecheck (`e2e/tsconfig.json`), ESLint and Prettier on changed
   files, and the full `scripts/*.spec.mjs` suite.
2. Device development until every stage passes; findings are fixed at the root.
3. On the final unchanged commit with a fresh production renderer: three
   consecutive `trinity-e2e-android:message-swipe` first attempts, each 14/14
   stages and 74/74 records at attempt 1 and zero retries, `publication-safe`,
   matching built and installed APK digests and a clean identifier scan.
4. The predecessor at `--workers=1 --retries=0`.
5. Hosted: the coordinator audits the original-attempt shard-6 artifact, then
   retires the predecessor.
