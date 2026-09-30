# Android Who-Reacted Maestro Migration Design

- Issue: #759, part of #660
- Status: Proposed; the coordinator rules on the open questions below
- Branch: local `wip/759-who-reacted` at `6d763606` (#758 re-acceptance, head of PR #677); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.who-reacted` suite. Implementation and acceptance evidence will be
tracked in `e2e/android/MIGRATION.md`. The #758 quote-notification suite is
the harness template: its proof-first `record()`, `receipt()`, tap-anchored
windows, redacted rethrows, exported finish-stage function, guarded cleanup,
imported-export shape guard and publication marker are ported. The #757
pinned-message-workflow suite is the two-stage template, and its D2
amendment (a paced live flood) is the model for the live reaction burst. The
#754 message-swipe suite is the template for the native Android Settings
round trip and its navigation-helper expansion. Nothing in this suite writes
a device setting: the Appearance mode is an application preference, which
the stage teardown clears with the application data.

## Intent and source boundary

Migrate the two Android-applicable who-reacted definitions to one serial,
two-stage installed-Android Node suite against real Synapse. The predecessor
stays enabled and unchanged until hosted acceptance (D14). Desktop-only
branches, the Playwright Pixel definition and the synthetic resize, count and
font stages stay in the predecessor and are never Android claims.

### Source pins

The issue's pin is **current**. `e2e/browser/journeys/conversations/reactions-who.spec.mts`
hashes to
`dce976ac883e07e14850bfee43cf50050b1b1f334174ba742ca530e2b0dc9b8a`
(737 lines) in the working tree **and** as the blob at
`RETIRED_PREDECESSOR_COMMIT` `dd0cb53c`. The file last changed in `11fc6024`
(#632), before the retirement registry's commit. So, unlike #757 and #758,
there is no stale pin to reconcile. The guard still reads the blob through
`readRetiredPredecessor(PREDECESSOR)`, pins both at `dce976ac…` and proves
them byte-equal, so a later working-tree drift fails and only this pin moves
at the D14 retirement.

The shared pins were recomputed for this design, from the working tree and
from `dd0cb53c`. All four match the issue:

| File                                       | SHA-256                                                            | Role                                     |
| ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------- |
| `e2e/support/app.mts`                      | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` | `login` (reaches no site)                |
| `e2e/support/account.mts`                  | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` | `registerUser` (reaches no site)         |
| `e2e/support/journeys/navigation.mts`      | `43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81` | `openSettingsFromRooms`, `closeSettings` |
| `e2e/browser/support/settings-journey.mts` | `b645b7cb0ad697c8a2ec28cf74d0c5a74e0f103ea2ee1a51f8d0c3fad22fb813` | `hasDarkMode` (reaches no site)          |

The spans below are the issue's, verified by AST:

| Span    | Role                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| 32–48   | `loginApi`: its one site is line 45 (`response.ok()`)                                                         |
| 51–83   | `joinWithRetry`: five attempts, `retry_after_ms` clamped to 1–10 000 ms (default 1 000); its one site is 64   |
| 85–95   | `interface Seeded`                                                                                            |
| 101–225 | `seedReactedMessage`: own sites 139 (create Room) and 149 (send target); the `react` closure 155–170 owns 169 |
| 171–207 | `sendReactions`, returned by shorthand at 223; it calls `react` at 172, 176, 178 and 201                      |
| 227–235 | `openRoom`: `rail-rooms`, `.channel` by name (30 s `waitFor` at 230), site 232 (`composer-input`, 15 s)       |
| 32–235  | the issue's "API login/join/reaction fixture and Room helper" span                                            |
| 241–531 | general definition `names the reactors on the pill and lists them all in the dialog`                          |
| 534–709 | `runMobileReactionJourney`; 647–700 are the excluded synthetic stages                                         |
| 711–737 | `Who reacted · Pixel 5 sheet`: the Playwright definition 723–729 (excluded) and the Android one 731–735       |

The AST found the desktop-only spans of the general definition at
296–306, 309–317, 327–345, 354–388, 392–400, 428–471, 482–505 and 507–524
(`if (!isAndroidE2E)` then-blocks, the `else` of each running on Android),
in the mobile helper at 543 (`target.tap()`) and 704–706, and in the
describe at 718–730. In `navigation.mts` they are 37–44 and 104–105 (after an
Android block that ends in `return`).

## Parity records: 88 + 103 = 191

A site is every `expect(…)` call **and every `expect.poll(…)` call**, as the
#758 guard counts them. An identifier-only counter finds 14 + 14; the
poll-aware counter finds 16 + 19. The guard proves that difference.

### Direct sites

- **General (Android path of 241–531): 16.** 256, 265, 271, 278, 320, 348,
  351, 391, 401, 404, 405, 411 (poll), 420 (poll), 476, 477, 529. The AST also
  finds 35 desktop-only sites in the span (297 … 523). They are excluded.
- **Mobile (534–709 without 647–700): 19.** 553, 558, 562, 572 (poll), 583,
  584, 597, 598, 599, 606, 612 (poll), 618, 626 (poll), 633 (poll), 641, 642
  (poll), 645, 703, 707. The span's other 14 sites are excluded: 13 synthetic
  (650, 651, 653, 654, 655, 656, 670, 682, 683, 685, 686, 687, 688) and one
  desktop (705).

### Helper expansion

Every binding is resolved through the TypeChecker, and every multiplicity is
computed from the AST (the guard's `cardinality()` and `executions()`),
never typed:

| Helper (site)                    | Call@via                                              | Executions                                                   | Per journey |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ | ----------- |
| `loginApi` (45)                  | seed@119 (reader)                                     | 1                                                            | 1           |
| `loginApi` (45)                  | seed@130 in `otherUsers.map`                          | 16 (`[long, ...Array.from({ length: 15 })]`)                 | 16          |
| `seedReactedMessage` own (139)   | seed@139                                              | 1                                                            | 1           |
| `joinWithRetry` (64)             | seed@142 in `for … of otherHeaders`                   | 16 (`otherHeaders` = `await Promise.all(otherUsers.map(…))`) | 16          |
| `seedReactedMessage` own (149)   | seed@149                                              | 1                                                            | 1           |
| `react` closure (169)            | `sendReactions`@172                                   | 1                                                            | 1           |
| `react` closure (169)            | `sendReactions`@176 in `for … of otherHeaders.map(…)` | 16                                                           | 16          |
| `react` closure (169)            | `sendReactions`@178                                   | 1                                                            | 1           |
| `react` closure (169)            | `sendReactions`@201 in `for … of [18 keys].entries()` | 18                                                           | 18          |
| **fixture subtotal**             |                                                       |                                                              | **71**      |
| `openRoom` (232)                 | general 253; mobile 551, 574, 614                     | 1 each                                                       | 1 / 3       |
| `openSettingsFromRooms` (19, 32) | mobile 569, 609 (Android path)                        | 2 sites × 2                                                  | 4           |
| `closeSettings` (69, 84, 99)     | mobile 573, 613 (Android path)                        | 3 sites × 2                                                  | 6           |

The `seed` call is 246 (general) and 545 (mobile). `sendReactions` is called
as `seeded.sendReactions()` at 264 and 557. The guard binds that property
call through the checker: the receiver `seeded` is declared as
`await seedReactedMessage(…)`, a module-level function; its returned object
literal has the shorthand `sendReactions` at 223, whose value symbol is the
`const` arrow at 171. The `react` calls bind to the `const` at 155 inside
`seedReactedMessage`, so a shadowing `react` does not expand.
`joinWithRetry`'s site sits inside a bounded `for` retry loop, on the
`if (response.ok()) { …; return; }` path, so it executes once per call. The
desktop `openSettingsFromRooms`/`closeSettings` calls at 312, 316, 368 and
372, and their desktop sites 41, 44 and 105, are excluded. `login`,
`registerUser`, `hasDarkMode`, `captureScreenshot` and `synapseSession`
reach no site; the guard proves it.

- **General:** 16 direct + 71 fixture + 1 Room = **88**.
- **Mobile:** 19 direct + 71 fixture + 3 Room + 10 Settings = **103**.

A naive expansion (every support or module-local call, static sites, no
branch or multiplicity awareness, as #758's `expandDefinition`) finds 73
(general) and 57 (mobile); the guard pins both as "not the contract's".

### Identities

Identities are `who-reacted.<stage>.<suffix>`. The stages are `pill-dialog`
(general) and `mobile-sheet`. Records are ordered by the key
`[call, 0, via, index]` for an inherited site and `[line, 1, 0, 0]` for a
direct one, where `via` is the line inside the helper where the site runs
(the nested call line, or the helper's own site line) and `index` counts
iterations from 1 (the reader's login is index 0). Two-digit indices keep
lexical and numeric order equal.

Fixture block, identical in both stages (35 at the seed call, 36 at the
`sendReactions` call):

| Suffix                       | Site        | Count |
| ---------------------------- | ----------- | ----- |
| `api-login-reader`           | 45 via 119  | 1     |
| `api-login-other-01` … `-16` | 45 via 130  | 16    |
| `room-created`               | 139         | 1     |
| `join-other-01` … `-16`      | 64 via 142  | 16    |
| `target-sent`                | 149         | 1     |
| `reaction-01`                | 169 via 172 | 1     |
| `reaction-02` … `-17`        | 169 via 176 | 16    |
| `reaction-18`                | 169 via 178 | 1     |
| `reaction-19` … `-36`        | 169 via 201 | 18    |

`pill-dialog` (88), in order: the 35 seed records (call 246); `room-open`
(232@253); `target-visible` (256); `reaction-01…36` (call 264);
`thumbs-count` (265), `group-count` (271), `thumbs-summary` (278),
`dialog-visible` (320), `dialog-total` (348), `close-visible` (351),
`key-count` (391), `long-reactor-listed` (401), `thumbs-reactors` (404),
`long-reactor-ellipsis` (405), `long-reactor-overflow` (411),
`detail-overflow` (420), `heart-pressed` (476), `heart-reactors` (477),
`dialog-dismissed` (529).

`mobile-sheet` (103), in order: the 35 seed records (call 545); `room-open`
(232@551); `target-visible` (553); `reaction-01…36` (call 557);
`thumbs-count` (558), `group-count` (562); `light-rooms-route` (19@569),
`light-settings-sections` (32@569), `light-mode` (572),
`light-section-unwound` (69@573), `light-rooms-restored` (84@573),
`light-settings-detached` (99@573), `light-room-open` (232@574);
`light-dialog-visible` (583), `sheet-class` (584), `sheet-left-bound` (597),
`sheet-right-bound` (598), `sheet-bottom-attached` (599),
`light-dialog-closed` (606); `dark-rooms-route` (19@609),
`dark-settings-sections` (32@609), `dark-mode` (612),
`dark-section-unwound` (69@613), `dark-rooms-restored` (84@613),
`dark-settings-detached` (99@613), `dark-room-open` (232@614);
`dark-dialog-visible` (618), `directory-overflow` (626),
`detail-overflow` (633), `last-key-pressed` (641), `directory-scrolled`
(642), `last-key-reactors` (645), `dialog-dismissed` (703),
`composer-visible` (707).

## Selected architecture

**One suite, two stages** (open question 3). Both definitions share the
fixture, the Room helper and every renderer read; one target means one APK
install, one runtime provenance, one CI run line, gate and upload. Two
suites would pay the install, provenance and wiring twice for no isolation
gain the stage ledger does not already give: each stage has its own
Accounts, Room, directory and marker entry. The cost is that a failed first
stage stops the second (one attempt, as every suite).

| Unit      | File                                         | Responsibility                                                                                                                     |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Fixture   | `e2e/android/account-workspace-fixtures.mts` | **Three additive members**: `joinHonoringRateLimit`, `sendReaction`, `reactionRelations` (open question 1)                         |
| Guard     | `scripts/who-reacted-migration.spec.mjs`     | Pins, AST site map with branches, bindings and multiplicities, import shapes, asserters, observer, simulated app, controls, wiring |
| Contract  | `e2e/android/who-reacted-contract.mts`       | Two stages, 191 identities, profiles, texts, the reaction plan, asserters                                                          |
| Observer  | `e2e/android/who-reacted-observer.mts`       | Read-only expressions: the target row and its pills, the dialog, the shell route and theme                                         |
| Artifacts | `e2e/android/who-reacted-artifacts.mts`      | Secrets, the publication marker, abort revocation                                                                                  |
| Journeys  | `e2e/android/who-reacted-journeys.mts`       | Runner, `record()`/`receipt()`, both stages, the directory swipe, teardown, redacted rethrows                                      |

Reused unchanged, by import:

- `account-workspace-client.mts`: `reset`, `login`, `hideKeyboard`,
  `tapCurrent`, `visible`, `scrollIntoViewIfNeeded`, `nativeRect`,
  `eventIdentity`, `capture`, `record`, `close`, `device.runFlow`;
- `account-workspace-fixtures.mts`: `account` (with `longName`),
  `setDisplayName`, `createRoom`, `sendMessage`, `roomMessages`, plus the
  three new members;
- `message-quote-observer.mts`: `readAppliedProfile` and the type
  `ObservationOptions`;
- `pinned-message-panel-artifacts.mts`: `redactDiagnosticText`,
  `scrubPinnedPanelArtifacts`, `scanPinnedPanelArtifacts`,
  `runPinnedPanelStageCleanup` and the type `PinnedPanelPublicationSafety`;
- the flow `flows/native-shell-back.yaml` (`pressKey: BACK`), as
  `room-profile-settings`, `message-grouping` and `native-shell` use it.

The #758 imported-export shape guard is ported: it pins, by AST, the shape of
every imported name from `message-quote-observer` and
`pinned-message-panel-artifacts`, and the Back flow's bytes. No `message-swipe`
module is imported; the Settings asserters are local (a route string and three
counts), which avoids coupling to `SwipeViewObservation`.

## Feasibility probes

Five local probes ran on 2026-09-30 from `6d763606`, with a production
renderer (manifest `cb89e7a2…`) and the debug APK built from it, on the API 36
emulator (Pixel 6 AVD). The probe file lived under `.superpowers/probes/`,
was never committed, and wrote only counts, booleans and timings. Host load
was 4–5. Probe 5 is the complete run; probes 1–4 found the three facts that
changed the design (items 3, 5 and 7).

1. **Arrangement.** Seventeen fixture Accounts took 8.4–8.6 s. Joins: the
   first 9 of 16 succeeded at once; the other 7 each got one 429 with
   `retry_after_ms` 437–462 and succeeded on the second attempt (7.46 s for
   16). Synapse's default per-Room join limit is exercised on every run, so
   the bounded retry is load-bearing.
2. **General profile.** `reset` at 1280×720 with touch applied exactly
   (`innerWidth` 1280, `innerHeight` 720, DPR 1.0, coarse pointer, hover none,
   platform `android`). One-flow sign-in 38.6–45.0 s; `rail-rooms` tap
   10.7–11.9 s; Room-row tap 12.8 s; the target row was reconciled at the
   first read (7–8 ms).
3. **The `reactions-who` chip is behind the composer.** At 1280×720 its
   centre (y 689) hit `composer-input`; the timeline scroller ends at y 625.
   Playwright's click scrolls it into view programmatically. The shared
   native `scrollIntoViewIfNeeded` (one Maestro swipe, 10.4–10.7 s) moved the
   timeline's `scrollTop` from 64 to 160 and made it hit the chip. At 393×851
   the chip was already unobstructed (26–32 ms, no swipe).
4. **Paced reactions.** Groups of 8 with a rendered-state gate after each of
   the first four took 3.1 s (general) and 3.6 s (mobile) for all 36; every
   gate passed in 121–230 ms. The final state (👍 17, 20 groups, the summary
   pattern) followed within 122–174 ms. The summary read
   `👍 reacted by You, <a>, <b> and 14 others`.
5. **The long reactor must be longer than the fixture's.** At 1280×720 the
   sheet is 576 px wide (352–928). The fixture's `longName` username (57
   characters) and a 76-character display name did **not** overflow (client
   and scroll width 485). The predecessor's name is
   `who-other-${runId}-${'x'.repeat(36)}` with `runId` =
   `${testResourceId('run')}w`, about 97 characters. With the Node
   namespace's `role('run')`, the exact equivalent, the name was 86
   characters (general) and 89 (mobile). It overflowed by 44 px at 1280×720
   (500 → 544) and by 250 px at 393×851 (317 → 567), with
   `text-overflow: ellipsis`.
6. **Dialog, heart and host Back (general).** The dialog was a sheet
   (`reactions-dialog--sheet`, as on every mobile OS), bottom-attached at 720,
   with `36 total`, a visible close control, 20 keys, 👍 pressed, 17 reactors,
   350 px of detail overflow and 545 px of directory overflow. Keys order 👍,
   🎉, ❤️, …, 🌟. The heart tap (10.6–10.8 s) selected index 2 with one
   reactor. `native-shell-back.yaml` (10.2–10.4 s) closed the dialog at the
   first read, the composer was visible, and the viewport stayed 1280×720.
7. **Mobile profile.** `reset` at 393×851 mobile/touch applied exactly (DPR
   1.0). **A Room reused after its reactions fails**: with 36 reactions after
   the target, the app's first sync window (20 events) did not hold the
   target, and the row never rendered (probe 3). That is why the predecessor
   loads the target before the burst; each stage uses its own fresh Room.
8. **Native Settings round trip, twice.** `back-to-rooms` (visible in the
   Room) 10.1 s; `open-settings` 9.7–11.9 s; `settings-nav-appearance`
   10.1–10.2 s; `mode-light`/`mode-dark` was unobstructed without a swipe and
   took 9.8–10.0 s; `html.dark` followed at the first read; two
   `trn-settings button[aria-label="Back"]` taps (9.6–10.0 s each) unwound
   `/settings/appearance` → `/settings` → the Account-qualified Rooms route,
   with no `trn-settings` left; `rail-rooms` and the Room row reopened the
   same Room (≈10 s each). The Settings nav read at `/settings` was visible.
9. **Mobile sheet.** Sheet class present; box left 0, right 393.14, bottom
   851.05 against `innerHeight` 851 (|Δ| 0.05); 20 keys; directory
   `scrollWidth` 1121 against `clientWidth` 393; detail overflow 245 px.
   Close (11.1 s) hid it at the first read. In dark mode the dialog paint was
   `oklch(0.24 …)` against light `oklch(0.965 …)`.
10. **Native horizontal directory swipe.** A materialized Maestro swipe from
    80 % to 20 % of the directory's width at its vertical centre (600 ms)
    advanced `scrollLeft` 0 → 186 → 387 → 588 → 728 (the maximum) in four
    swipes of 11.0–11.6 s; only then was the last key (🌟) unobstructed. The
    tap (10.7 s) pressed it (index 19), one reactor, `scrollLeft` 728. Host
    Back closed the sheet with the composer visible; the viewport stayed
    393×851.
11. **Unpaced burst, locally.** In a second fresh Room, 36 reactions sent back
    to back (2.85 s) while the Room was open did **not** reset the timeline
    on this host: the row stayed rendered with all 32 groups. The #757 hosted
    flake shows a hosted runner can batch differently, so the pacing stays
    (open question 4).
12. **Wall time.** Probe 5 took 9 min 23 s including Synapse, install, both
    arrangements and the extra burst Room, with 34 native actions.

## Decisions

### D1. Profiles, Accounts and sign-in

- **`pill-dialog` runs at `GENERAL_TOUCH_PROFILE`** =
  `{ width: 1280, height: 720, isMobile: false, hasTouch: true, deviceScaleFactor: 1 }`:
  the Android Playwright project's default viewport
  (`e2e/android/playwright.config.mts`) plus the describe's
  `test.use({ hasTouch: true })` (239).
- **`mobile-sheet` runs at `MOBILE_SHEET_PROFILE`** =
  `{ width: 393, height: 851, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }`:
  the describe's `test.use` (713–717). The user agent and DPR at 719–722 are
  for the excluded non-Android definition, so Playwright's implicit DPR 1
  applies, as #747's portrait profile records.
- Each stage reads the applied profile back through `readAppliedProfile`
  (exact size, DPR within 1e-6, coarse pointer, hover none, platform
  `android`) before any tap, and writes `profile-applied.json`.
- Each stage creates its own 17 fixture Accounts: `wr-reader`, then
  `wr-other-01` … `wr-other-16`, where `wr-other-01` is the long reactor. No
  Account is shared between stages: the issue requires a fresh reader and
  sixteen others per journey. The reader signs in natively with the one-flow
  `client.login(reader)`, then `client.hideKeyboard()`.

### D2. Arrangement

In the predecessor's order, through real Synapse, before any UI step:

- `runId` is `${namespace.role('run')}w` (general, 245) or
  `${namespace.role('mobile')}m` (mobile, 548), from the Node test
  namespace. That is `testResourceId`'s own implementation, so every
  run-bearing text has the predecessor's shape and length (probe 5).
- The seventeen Accounts are created and logged in by `fixtures.account()`,
  in the order reader, others 1–16. Each return proves one `loginApi` site
  (45): the fixture's login answered 2xx and its `user_id` is the Account's.
- The long reactor's display name is set to
  `who-other-${runId}-${'x'.repeat(36)}` with `fixtures.setDisplayName`
  **before it joins** (open question 2). Synapse gives a password-registered
  Account its localpart as display name, which is exactly what the
  predecessor shows (217–218); the fixture chooses localparts, so the suite
  sets that name explicitly. Its join event carries it.
- The reader creates `Who reacted <runId>` with `preset: 'public_chat'`
  (135–139).
- The sixteen others join in order through `fixtures.joinHonoringRateLimit`
  (142, D5).
- The reader sends `react to me <runId>` with txn `who-<runId>` (145–153).
- A fail-closed `arranged` receipt reads the reader's `/messages` page (about
  26 events; the page holds 50): it must reach `m.room.create`, hold exactly
  one `m.room.message` (the target, from the reader, exact body), show a
  `public` join rule and exactly 17 joined members (the reader and the
  sixteen), with the long reactor's latest member event carrying the long
  display name. No reaction exists yet.

### D3. Native action ownership

Every product action is a native Maestro action through
`AccountWorkspaceClient`, each proving a trusted, matched activation. In
order:

- **`pill-dialog`:**
  1. `client.login(reader)`, `hideKeyboard`;
  2. tap `[data-testid="rail-rooms"]`; tap `.channel` `{ text: roomName }`
     once it has been visible for up to 30 s (`openRoom` 230);
  3. REST reactions (D5);
  4. `scrollIntoViewIfNeeded('[data-testid="reactions-who"]', '.scroll', { within: TARGET_ROW })`
     (probe 3), then tap `[data-testid="reactions-who"]` `{ within: TARGET_ROW }`,
     where `TARGET_ROW = { selector: '.scroll .msg[data-mid^="$"]', text: body }`;
  5. tap `[data-testid="reactions-key"]` `{ text: '❤️' }`;
  6. host Back: `client.device.runFlow('e2e/android/flows/native-shell-back.yaml', { APP_ID })`.
- **`mobile-sheet`:**
  1. sign-in and Room as above; REST reactions;
  2. per mode (light, then dark): if `back-to-rooms` is visible, tap it
     (the predecessor's conditional at 568/608; probe 8 saw it visible);
     tap `open-settings` unless the route is already `/settings` (the
     helper's own conditional at 26); tap `settings-nav-appearance`; tap
     `mode-<mode>`; tap `trn-settings button[aria-label="Back"]`, and again
     if the route is `/settings` (the helper's conditional at 75/81); tap
     `rail-rooms` and the Room row;
  3. `scrollIntoViewIfNeeded` then tap `reactions-who` (light), tap
     `close-reactions`; after the dark round trip, tap `reactions-who` again;
  4. the directory swipe (D7) until the last key is unobstructed, at most six
     swipes; tap `[data-testid="reactions-directory"] > [data-testid="reactions-key"]:last-of-type`;
  5. host Back, as above.

No suite source contains a renderer `.click(`, `.tap(`, `.focus(`,
`dispatchEvent`, `.value =`, `textContent =`, `.style.`, `classList.add`,
`classList.remove`, `classList.toggle`, `scrollLeft =`, `scrollTop =`,
`scrollTo(`, `scrollBy(`, `scrollIntoView(`, `setViewportSize`, `.resize(`,
`location.`, `history.`, `.fill(`, `.press(`, `localStorage`,
`Preferences.set`, `requestSubmit`, `.submit(`, `preventDefault` or
`stopPropagation`, and no product handler (`select(`, `showReactors`,
`toggleReaction`, `open$(`). Renderer code only reads. (`location.` and
`scrollIntoView(` are banned as renderer text; the client's native
`scrollIntoViewIfNeeded(` is allowed by exact name.)

### D4. Observation and windows

Renderer observations are the observer's expressions, polled on the wall
clock; server observations are fixture reads. **No window is anchored before
the action it waits for.** A tap's return comes after its proven activation,
so tap latency (9.6–13.3 s in probe 5) never counts against a window. A 10 s
or 15 s predecessor bound, and every default 5 s `expect`/`expect.poll`,
becomes 20 s under host load, as in #757/#758. Bounds of 20 s and 30 s are
kept. Each consecutive record polls from the read that satisfied the
previous one, as the predecessor's consecutive `expect`s do.

| Claim                                                       | Bound       | Anchored at                                                                                               |
| ----------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| Room row visible (230 `waitFor`)                            | 30 s        | the `rail-rooms` tap's return                                                                             |
| `room-open` (232)                                           | 20 s        | the Room-row tap's return                                                                                 |
| `target-visible` (256/553)                                  | 20 s        | the read that satisfied `room-open`                                                                       |
| reaction gate 1–4 (receipts)                                | 30 s        | that group's last send's return                                                                           |
| `thumbs-count` (265/558)                                    | 30 s        | the last send's return                                                                                    |
| `group-count` (271/562)                                     | 30 s        | the read that satisfied `thumbs-count`                                                                    |
| `thumbs-summary` (278)                                      | 20 s        | the read that satisfied `group-count`                                                                     |
| `dialog-visible` (320/583/618)                              | 20 s        | the `reactions-who` tap's return                                                                          |
| dialog records 348–420, 584, 626, 633                       | 20 s each   | the read that satisfied the previous record                                                               |
| `sheet-*-bound`/`-attached` (597–599)                       | single read | the read that satisfied `sheet-class` (one `evaluate`, as 586–596)                                        |
| `heart-pressed` (476), `last-key-pressed` (641)             | 20 s        | the key tap's return                                                                                      |
| `heart-reactors`, `directory-scrolled`, `last-key-reactors` | 20 s        | the read that satisfied the previous record                                                               |
| `light/dark-rooms-route` (19)                               | 20 s        | the `back-to-rooms` tap's return, or the read that satisfied the preceding record when it was not visible |
| `*-settings-sections` (32)                                  | 20 s        | the `open-settings` tap's return                                                                          |
| `light/dark-mode` (572/612)                                 | 20 s        | the `mode-<mode>` tap's return                                                                            |
| `*-section-unwound` (69)                                    | 20 s        | the first Back tap's return                                                                               |
| `*-rooms-restored` (84)                                     | 20 s        | the second Back tap's return, or 69's read                                                                |
| `*-settings-detached` (99)                                  | 20 s        | the read that satisfied 84                                                                                |
| `light-dialog-closed` (606)                                 | 20 s        | the `close-reactions` tap's return                                                                        |
| `dialog-dismissed` (529/703)                                | 20 s        | the Back flow's return                                                                                    |
| `composer-visible` (707)                                    | 20 s        | the read that satisfied `dialog-dismissed`                                                                |

Server polls use `left(bound, anchor) = max(bound − (now − anchor), 1)`, as
#757/#758.

### D5. Reactions: exact plan, pacing and proof

- **The plan is the predecessor's, exactly**, as one ordered list of 36:
  1. the reader, 👍, txn `r1-<runId>` (172);
  2. others 1–16, 👍, txns `r2-<runId>` … `r17-<runId>` (173–177);
  3. other 1, 🎉, txn `r10-<runId>` (178; txns are per-device, so this does
     not collide with other 9's `r10`);
  4. keys ❤️ 😂 😮 😢 😡 🚀 ✅ ❌ 👏 🙌 🔥 💯 🎯 ✨ 💡 🌈 🍀 🌟 in that order,
     key `i` (0–17) sent by other `((i + 1) % 16) + 1`, txn `group<i>-<runId>`
     (179–206).
     Each is one `fixtures.sendReaction(sender, roomId, targetId, key, txn)`
     with the exact content
     `{ 'm.relates_to': { rel_type: 'm.annotation', event_id, key } }`. Each
     returned event id is registered at once and proves one `reaction-NN`
     record (169: the send answered 2xx with an event id). The totals are the
     predecessor's: 17 👍, 20 groups, `36 total` (220–222).
- **Pacing (open question 4).** The app's incremental `/sync` sets no
  timeline limit, so Synapse's default of 10 applies. A batch of more than 10
  new events is `limited`, and matrix-js-sdk then resets the live timeline
  without the target (#757's D2 amendment, reproduced there with a held
  sync). The reactions therefore go out in groups of `REACTION_GROUP` = 8
  (1–8, 9–16, 17–24, 25–32, 33–36), sequential and awaited. After each group
  but the last, the stage polls (30 s, anchored at that group's last send's
  return) until the rendered row shows that group's cumulative state and is
  still the arranged event: 👍 8/1 group, 16/1, 17/8, 17/16. The SDK has then
  processed the batch holding the group's last event, so the next batch
  holds at most 8 new timeline events and can never be `limited`. The gate
  is a receipt (`reaction-gate-N`), never a parity record. After the last
  group, records `thumbs-count` and `group-count` are the predecessor's own
  final claims. Probe 4: 3.1–3.6 s for all 36.
- **Read-back.** After `thumbs-summary` (general) or `group-count` (mobile),
  a fail-closed `reactions-arranged` receipt reads
  `fixtures.reactionRelations(reader, roomId, targetId)`: exactly 36
  unredacted `m.reaction` events, every one annotating the target, their ids
  equal to the 36 recorded ids, 17 👍 from 17 distinct senders including the
  reader, 20 distinct keys, and each other key from its planned sender. It
  records counts only.

### D6. `pill-dialog` sequence

1. Protect the room name, body, long display name and all 37 txns. Arrange
   (D2), recording the 35 seed records as each call returns; write
   `arranged`; set `safety.unsafeSecrets = false`.
2. `reset(GENERAL_TOUCH_PROFILE)`, read back the profile, `login`,
   `hideKeyboard`.
3. `rail-rooms`, Room row; record `room-open` (one visible `composer-input`
   on the Room's route). Record `target-visible`: exactly one reconciled row
   with the body, bound to the arranged event by `eventIdentity`.
4. The paced reactions with gates (D5); records `reaction-01…36`.
5. Records `thumbs-count` (👍 pill count text exactly `17`), `group-count`
   (exactly 20 non-`who` pills), `thumbs-summary` (the 👍 pill's
   `aria-label` matches `^👍 reacted by You, .* and \d+ others$`; the label is
   never recorded, only `{ matches: true, others }`). Receipt
   `reactions-arranged`.
6. Reveal and tap the chip (D3). Records `dialog-visible` (exactly one
   visible `reactions-dialog`), `dialog-total` (`.reactions-dialog__total`
   text exactly `36 total`), `close-visible`, `key-count` (exactly 20
   `reactions-key`), `long-reactor-listed` (`reactors-list` text contains the
   long name), `thumbs-reactors` (exactly 17 `.reactor`),
   `long-reactor-ellipsis` (the first `.reactor__name` containing the long
   name computes `text-overflow: ellipsis`), `long-reactor-overflow` (its
   `scrollWidth − clientWidth > 0`), `detail-overflow`
   (`.reactions-dialog__detail` `scrollHeight − clientHeight > 0`). A receipt
   `dialog-shape` records the sheet class, the pressed key index (0) and the
   directory overflow, never a name.
7. Tap ❤️. Records `heart-pressed` (the ❤️ key's `aria-pressed` is `true`)
   and `heart-reactors` (exactly one `.reactor`).
8. Host Back. Record `dialog-dismissed` (no `reactions-dialog` remains
   visible). Receipt `room-recovered`: one visible composer on the same
   Room's route.

### D7. `mobile-sheet` sequence and the directory swipe

1–4. As `pill-dialog` 1–4, at `MOBILE_SHEET_PROFILE`, with the mobile `runId`. 5. Records `thumbs-count`, `group-count`; receipt `reactions-arranged`. 6. **Light round trip** (569–575). Records, each on its own read:
`light-rooms-route` (path starts `/rooms`, `account` is the reader's user
id), `light-settings-sections` (path starts `/settings`, the
`nav[aria-label="Settings sections"]` is visible), `light-mode`
(`html.dark` is absent), `light-section-unwound` (path is `/settings` or
starts `/rooms`), `light-rooms-restored` (the Account-qualified Rooms
route), `light-settings-detached` (no `trn-settings`), `light-room-open`
(232@574). A receipt `light-same-room` binds the reopened row to the
arranged event with `eventIdentity`. 7. Tap `reactions-who`. Records `light-dialog-visible`, `sheet-class` (the
`trn-reactions-dialog` host holding the dialog has
`reactions-dialog--sheet`), then from **one** read: `sheet-left-bound`
(`left ≥ 0`), `sheet-right-bound` (`right ≤ innerWidth + 1`),
`sheet-bottom-attached` (`|bottom − innerHeight| < 0.5`, Playwright's
`toBeCloseTo(…, 0)`). Receipt `light-sheet-paint` records the dialog's
background colour digest. 8. Tap `close-reactions`. Record `light-dialog-closed`. 9. **Dark round trip** (607–615), the same seven records with `dark-`, where
`dark-mode` requires `html.dark`. Receipt `dark-same-room`. 10. Tap `reactions-who`. Record `dark-dialog-visible`. Receipt
`dark-sheet-usable`: sheet class, bounds and bottom attachment hold, and
the background differs from the light receipt's ("usable in both
themes"). 11. Records `directory-overflow` (`reactions-directory`
`scrollWidth − clientWidth > 0`) and `detail-overflow`. 12. **The directory swipe.** While the last key is not unobstructed (at most
six times): measure the directory's rect, map it with
`client.nativeRect`, write `swipe: start 80 %, end 20 % of its width at
    its vertical centre, duration 600` to a flow under `client.output`, run
it with `client.device.runFlow`, and require `scrollLeft` to increase
within 20 s. Each swipe writes a `directory-swipe-N` receipt
(`{ before, after, max }`). Probe 10 needed four. 13. Tap the last key. Records `last-key-pressed` (`aria-pressed="true"` on the
last `reactions-key`), `directory-scrolled` (`scrollLeft > 0`),
`last-key-reactors` (exactly one `.reactor`). 14. Host Back. Records `dialog-dismissed` and `composer-visible` (one visible
`composer-input`).

### D8. Documented reinterpretations

- **Accounts and REST sessions (32–48, 101–133).** Fixture Accounts and their
  closure-private sessions replace `registerUser`, `loginApi` and the
  `Bearer` headers. Localparts are the fixture's; the long reactor's
  displayed name is the predecessor's localpart shape, set as a display name
  before it joins.
- **Join rate limit (51–83).** The bounded retry, its clamp and its default
  are kept exactly, in an additive fixture member (open question 1).
- **Live burst (264/557).** Sent in five paced groups with render gates
  (D5). The predecessor's claims (final 👍 17 and 20 groups within 30 s of the
  burst) are unchanged; the anchors are the last send's return.
- **Chip activation (318/578/617).** Playwright's click scrolls the chip into
  view programmatically; the suite reveals it with the shared native
  timeline swipe when it is obstructed (probe 3), then taps natively.
- **Last-key selection (640).** Playwright's click scrolled the key into view,
  which is what made `scrollLeft > 0`. The suite scrolls the directory with
  native horizontal swipes (D7), then taps; record `directory-scrolled`
  observes the resulting offset.
- **Dismissal (528/702).** The general predecessor presses Escape on Android;
  the issue requires host Back for both journeys, and the mobile predecessor
  already calls `app.pressBack()`. Both use the Android Back key flow.
- **Screenshots (601, 620).** The predecessor attaches rasters; the suite
  writes id-free pass/failure captures, and the scrub deletes rasters.
- **Bounds.** 10/15 s and default 5 s become 20 s; every window is anchored
  after its event (D4).
- **Identity without identifiers.** The Room is opened by exact name, the row
  by body text, and each is bound to the arranged event by `eventIdentity`.
- **Excluded, retained in the predecessor:** the desktop hover tooltip
  (296–306), desktop Settings light/dark and paint comparison (309–317,
  354–388), desktop pane geometry and overflow (327–345, 392–400), keyboard
  traversal, focus paint and Enter/Space selection (428–470), the 640 px
  compact resize (482–505), close by Space/Escape with focus restoration
  (507–523, 704–706), the Playwright Pixel definition (723–729), and the
  synthetic 900 px resize, fake `123456789` count text, 125 % root font and
  320 px resize with their geometry and screenshot (647–700). None is
  reproduced as an Android claim.

### D9. Protection

Registered the moment each is known:

- before any request: the Room name, the body, the long display name and the
  36 distinct txns (`who-<runId>`, `r1`…`r17` — the 🎉 send reuses `r10` —
  and `group0`…`group17`);
- as each `account()` returns: its user id, username and password (17 per
  stage). `createNodeAccount` and the fixture login fail with fixed-text
  messages that carry no identifier, so nothing is exposed before
  registration;
- the Room id as `createRoom` returns; the target id as `sendMessage`
  returns; each reaction id as `sendReaction` returns.

The fixture's seventeen access tokens per stage never leave its closure; the
device session's token is removed by the shared scrub. No sync token is ever
read. The pill summary names reactors, so its label is never recorded. A
failed fixture request's message carries the percent-encoded path; every
encoded form is registered (`quoteNotificationSecrets`' shape: raw,
`slice(1)`, component-encoded, base64url route), and the shared scan
redacts every Room and event id shape besides. The fixed keys (the emoji) are
constants, not secrets; a test asserts they are not registered.

The gated `android-who-reacted` upload runs only after `publication-safe`,
which requires: 2 stages and 88 + 103 records in contract order;
`pill-dialog/profile-applied.json` at the general profile and
`mobile-sheet/profile-applied.json` at the mobile profile; attempt 1 and
retries 0; each stage's three passed captures; runtime provenance; a clean
scan. A failed stage is rethrown through `redactStageFailure`
(`throw redactStageFailure(entry.id, failures, secrets);`, exactly once); a
failed guarded cleanup through `redactCleanupFailure`.

### D10. Teardown, must-run steps and guard strength

The stage teardown is `client.close()`, then
`device.clearApplicationData('eu.qwky.trinity')`, which also removes the
Appearance preference the mobile stage set. It is exported as
`whoReactedTeardown(client, device)` and run by
`finishWhoReactedStage(client, device, failures): Promise<boolean>` through
`runPinnedPanelStageCleanup`. The fixture cleanup (logout, leave and forget
for all 34 Accounts) runs through the guarded Matrix cleanup.

| Must-run step                                                                                               | Guard                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| stage `finally` → `if (await finishWhoReactedStage(client, device, failures)) safety.cleanupFailed = true;` | AST: first statement of the stage `finallyBlock`; deleting it or moving it into the `try` fails                            |
| `finishWhoReactedStage` runs close then clear even when close throws                                        | behavioural: fakes; order `['close', 'clear:eu.qwky.trinity']`; `true` on a throw                                          |
| scan then scrub cleanups registered before `openMaestroDevice`                                              | AST: both `guardedCleanup` calls, in order, before the device                                                              |
| outer `finally` → `if (effectiveSignal.aborted) await revokeOnAbort?.();`                                   | AST plus the behavioural revocation test                                                                                   |
| `assertWhoReactedRecords(entry.id, records)` then `client.capture('passed')`                                | AST: in that order, in the stage `try` after the runner                                                                    |
| the single `throw redactStageFailure(entry.id, failures, secrets);`                                         | exact count 1; no other `throw failures`/`AggregateError`                                                                  |
| every identifier registered before the native action that could expose it                                   | simulated: the secrets snapshot at fake `reset` holds every pre-UI value; each reaction id is registered before its record |
| the guarded cleanup marks failure, saves and rethrows id-free                                               | behavioural port of #758's test                                                                                            |
| the reaction gate runs after each group but the last                                                        | simulated: the fake's limited-sync model (below) fails a run without a gate                                                |

**The limited-sync model.** The simulated app delivers REST reactions to its
rendered state only on a renderer read, as one sync batch: every reaction
sent since the previous read. A batch of more than 10 resets the rendered
timeline to the batch alone, so the target row disappears. This is the named
fault exactly (#757's mechanism). A journeys mutation that removes the gates,
and one that raises `REACTION_GROUP` to 11, must both fail with the gate's
"target row is still rendered" message.

**Windows (fake clock).** Ported from #758: every fake tap, Back flow, swipe
and REST send advances the fake clock by `tapMs`/`sendMs`, and every state
change is a pure function of `Date.now()` relative to the recorded return.
Each window class has a passing case 5 s inside its bound and a failing case
1 s past it, and a server case that fails when every read burns 10 s.

### D11. CI placement and budget

- **Shard.** Headroom is `limit − figure − 45 − 15` from the `android-e2e`
  budget comment: shard 1 36, shard 2 45, **shard 3 96**, shard 4 95,
  shard 5 42, shard 6 31. Shard 3 has the most; the suite runs last, after
  `quote-notification` (open question 5).
- **Budget.** Estimate 12 minutes (probe 5's 9.4 plus the heart tap, the
  fixture cleanup of 34 Accounts and captures): 84 + 12 + 60 = 156 ≤ 240. The
  acceptance task replaces the estimate with the measured time.
- **Timeouts.** A 25-minute Node test (`--timeout-ms=1500000`) and a
  30-minute CI wrapper (`1800000`); re-derived if the measured run exceeds 15
  minutes.
- No CHANGELOG or README change: a test-only migration.

### D12. MIGRATION.md section

`## Who-reacted journeys` after `## Quote-notification journey`, in #758's
shape: the source paragraph (pin, blob equality, spans, four shared pins);
the sentence
`The suite records 191 ordered, unique identities: pill-dialog 88 (16 direct + 71 fixture + 1 Room) and mobile-sheet 103 (19 direct + 71 fixture + 3 Room + 10 Settings).`;
a table of the non-fixture identities and one row per fixture block; the
arrangement and pacing paragraph; the native-ownership paragraph; the
protection paragraph ending exactly "a failed teardown step is rethrown
through `redactStageFailure`, and a failed guarded cleanup is rethrown
through `redactCleanupFailure`, never as the raw error."; the D8 bullets;
known limitations (desktop paths; the local unpaced burst did not reset);
the command block; the placement sentence beginning with the invariant text
`Shard 3 runs it last, after quote-notification`; the acceptance paragraph
(written in the acceptance task); and
`Predecessor status: enabled; after hosted acceptance the coordinator retires the Android definition and keeps the general definition desktop-only, skipped on Android (#839).`

### D13. Additive fixture members

All in `createAccountFixtures`, tokens kept in the closure:

- `joinHonoringRateLimit(member, roomId): Promise<{ status; attempts; retryAfterMs: readonly (number | null)[] }>`:
  up to 5 POSTs to `/rooms/{id}/join`; on 429 it waits
  `min(max(retry_after_ms, 1), 10 000)` (1 000 when absent or not finite)
  under the fixture signal; any other non-2xx throws
  `MatrixFixtureHttpError`; five 429s throw
  `Matrix fixture join still rate-limited after 5 attempts`. It tracks the
  membership for cleanup as `join` does.
- `sendReaction(sender, roomId, eventId, key, txn): Promise<string>`: one PUT
  of the exact annotation content; returns the event id.
- `reactionRelations(observer, roomId, eventId): Promise<readonly MatrixRecord[]>`:
  one read-only GET of
  `/_matrix/client/v1/rooms/{room}/relations/{event}/m.annotation/m.reaction?limit=100`;
  it fails when the response has a `next_batch` (the list must be complete).
  The existing `reactionEvents` uses Synapse's default limit of 5 and stays
  unchanged, since other suites use it.

Each has a behavioural test with a mocked `fetch`, and a source guard in the
#758 Q3 shape: the reader is GET-only and never returns a token; the two
writers use exactly one method each and never return a token.

### D14. Predecessor retention and retirement scope

Until hosted acceptance the predecessor is unchanged. The guard asserts the
working tree is `dce976ac…` and equal to the blob, with exactly three
`test(` definitions (241, 723, 731), two `test.skip(` self-skips, no
`fixme`/`only`, one journey-catalog entry, the Android Playwright config
still matching `browser/journeys/**`, and no retirement-registry entry.

Under #839 the file is not deleted: the general definition keeps its
desktop branches and would skip on Android; the Android definition (731–735)
is Android-only and would be retired; the Playwright Pixel definition
(723–729) never ran on Android and is untouched. The suggested entry:

```js
{
  path: 'e2e/browser/journeys/conversations/reactions-who.spec.mts',
  sha256: 'dce976ac883e07e14850bfee43cf50050b1b1f334174ba742ca530e2b0dc9b8a',
  issues: [759],
  deleted: false,
  retired: ['uses touch selection and native Back to dismiss the reaction sheet'],
  desktopOnly: ['names the reactors on the pill and lists them all in the dialog'],
}
```

Retirement is the coordinator's step; no plan task touches the registry.

## Negative-control plan

Each control names its fault exactly, and the guard models that fault, not a
neighbour. Each must fail when its protection is removed.

- **Sources and ledger.**
  - The five hashes (blob, tree and the four shared files), each under a
    one-byte flip; blob-tree equality under a one-byte tree drift.
  - Every text pin under a one-character mutation, including the runId
    templates, the long name, `public_chat`, the five-attempt bound and its
    clamp, the 18-key array, the sender index `(index + 1) % otherHeaders.length`,
    the txn templates, `totalReactions`, the 30 s bounds, the summary regex,
    `36`-bearing texts, `.last()`, `app.pressBack()` and the synthetic
    boundaries 647 and 700.
  - The site maps: identifier-only counts 14/14, poll-aware 16/19.
  - Branch awareness: dropping the `!isAndroidE2E` rule makes the general
    Android set 51 sites, not 16.
  - Multiplicities: `length: 15` → 14 makes 68 fixture records (85/100 per
    stage); a 19th key makes 72 (89/104); wrapping a `react` call in an `if`
    or a `while` throws `Unsupported`; a retry path without `return` throws.
  - Bindings: a shadowing local `react`, `loginApi` or `openRoom`, and a
    `seeded` whose initializer is not `seedReactedMessage`, do not expand.
  - Naive counts differ from 88 and 103.
  - Every AST-derived line and count differs from the contract under a
    contract mutation.
- **Imported-export shapes.** Each pinned signature, interface member list and
  the Back flow hash fails under an in-memory mutation of its declaration.
- **Fixture members.** The reader gaining a write or returning a token; a
  writer gaining a second method or returning a token; a join that retries a
  403; six attempts; a 20 000 ms `retry_after_ms` waited unclamped; a missing
  `retry_after_ms` waited other than 1 000 ms; a relations page with
  `next_batch` accepted.
- **Arrangement (stage, before any native action).** 16 joined members; a
  second message; a target from another sender; an `invite` join rule (a
  `private_chat` Room); the
  long name missing from the member event; a join that exhausts five 429s.
- **Reactions.** 35 reactions; a reaction on another event; a 👍 from a
  duplicate sender; 19 keys; a key from the wrong sender; a read-back with a
  `next_batch`; a returned id that differs from the recorded one; a send
  answering non-2xx.
- **Pacing.** The limited-sync model with no gates; with `REACTION_GROUP` 11;
  a gate that passes on 👍 count while the row is gone.
- **Pill.** 👍 16; 19 groups; a summary without `You` first; a label for 🎉.
- **Dialog (general).** `35 total`; close hidden; 19 keys; the long reactor
  missing; `text-overflow: clip`; `scrollWidth == clientWidth`; detail not
  scrollable; 16 reactors; ❤️ not pressed (👍 still pressed); two reactors
  under ❤️; the heart selected by a renderer call (source ban).
- **Dismissal and recovery.** The dialog still visible after Back; Back
  replaced by a `close-reactions` tap (the action log requires the Back flow
  last); the composer hidden after Back (mobile); the reopened row bound to
  another event.
- **Settings (mobile).** A route without `account`; the sections nav hidden;
  `html.dark` unchanged after the mode tap (light and dark); a Back that
  leaves `/settings/appearance`; a `trn-settings` left attached; the mode set
  through storage or a class write (source bans).
- **Sheet.** No sheet class; `left` −1; `right` `innerWidth + 2`; `bottom`
  1 px short; a dark sheet with the light paint.
- **Directory.** No horizontal overflow; a swipe that does not advance
  `scrollLeft`; seven swipes needed; the last key never unobstructed; the
  last key not pressed; `scrollLeft` 0 after the tap; two reactors.
- **Native ownership.** Every source ban, each shown effective by an
  in-memory insertion; the exact action log per stage.
- **Windows.** Every D4 class, pass 5 s inside and fail 1 s past, with
  `tapMs` 45 s; server windows fail when reads burn 10 s.
- **Cleanup and redaction.** The D10 must-run table; every identifier form
  (user ids, usernames, passwords, Room ids, names, bodies, the long name,
  txns, event ids) and 17 fixture-token shapes plus the device token in the
  scan; a raster; a failed cleanup, scrub or scan; revocation on abort; the
  marker withheld for 1 stage, 87 or 102 records, a swapped record,
  `retries: 1`, a wrong profile in either stage, `cleanupFailed` and an
  unscrubbed identifier.

## Evidence and acceptance plan

1. Run the guard, the fixture test, the typecheck, ESLint on the changed
   files, and the neighbour guards, including `quote-notification-migration`
   and `pinned-message-panel-migration` (whose modules are imported),
   `message-quote-migration`, and every guard that reads
   `account-workspace-fixtures.mts`; then the full `pnpm nx run scripts:test`.
2. Develop on the device until both stages pass; fix each finding at its
   root and add one guard control per fix.
3. On the final unchanged commit, with a fresh production renderer, run three
   consecutive `trinity-e2e-android:who-reacted` first attempts. Each shows
   2/2 stages and 88 + 103 records at attempt 1 with zero retries,
   `publication-safe`, matching APK digests, both profile digests and a clean
   identifier and raster scan; each reports every tap latency, the join 429
   count, the gate times, the swipe count and the long-name overflow.
4. Run the predecessor sequentially at `--workers=1 --retries=0` (both
   browser definitions pass, including their browser-only stages).
5. Hosted: the coordinator audits the original-attempt shard-3 Android,
   browser and renderer artifacts, applies D14 and updates the parent ledger.

## Open questions for the coordinator

1. **Fixture members.** Recommendation: the three additive members in
   `account-workspace-fixtures.mts` (D13), with read-only/write-scope source
   guards and behavioural tests, as #758's Q3. _If ruled otherwise:_ a
   suite-local `who-reacted-fixtures.mts` must log each Account in again (17
   extra sessions and logouts per stage, 17 more tokens to redact) — the
   plan's Task 1 becomes a new module and Tasks 4–6 change.
2. **Long reactor name.** Recommendation: `runId` from
   `namespace.role('run'|'mobile')` (exactly `testResourceId`) and the long
   reactor's display name set to the predecessor's localpart shape before it
   joins (probe 5: 86/89 characters, 44/250 px overflow). _If ruled
   otherwise_ (for example, a fixture `usernameSuffix` option so the localpart
   itself is long): the plan's Task 1 edits `account()` and its test, and
   Tasks 3 and 5 change; the fixture's current 57-character `longName` does **not**
   overflow at 1280 px (probe 5), so it cannot be used alone.
3. **One suite, two stages.** Recommendation: one `android.who-reacted`
   target. _If ruled otherwise:_ two targets double the install, provenance,
   CI line, gate, upload and budget entries (the plan's Tasks 7 and 9 double,
   Task 4's artifacts split by suite and Task 5's runner runs one stage each).
4. **Paced burst.** Recommendation: groups of 8 with render gates (D5), the
   #757 amendment's mechanism, even though the local unpaced burst did not
   reset (probe 11). _If ruled otherwise_ (send the 36 back to back as the
   predecessor): drop the gates and the limited-sync model from the plan's
   Tasks 3 and 5;
   the hosted flake risk returns.
5. **Shard.** Recommendation: shard 3, last, after `quote-notification`
   (headroom 96). _If ruled shard 4_ (headroom 95): the plan's Task 7 wiring and Task 9
   budget lines change.
6. **Horizontal directory swipe.** Recommendation: a suite-local helper on
   public client APIs (`nativeRect`, `device.runFlow`, `output`), as #754's
   motion helper, rather than extending the shared `swipeCurrent` (vertical
   only). _If ruled otherwise:_ a new first plan task adds horizontal
   directions to `account-workspace-client.mts` with its own tests, every
   guard that reads that file must stay green, and Task 6's swipe calls it.
7. **Chip reveal.** Recommendation: the shared native
   `scrollIntoViewIfNeeded` when the chip is obstructed (probe 3), recorded
   as a reinterpretation of Playwright's actionability scroll. _If ruled
   otherwise_, there is no native way to activate the chip at 1280×720; the
   general profile would have to change, which the issue does not allow.
