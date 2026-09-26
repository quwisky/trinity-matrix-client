# Android runner migration ledger

This ledger tracks the critical milestone owned by
[Deliver critical Android Maestro journeys](https://github.com/quwisky/trinity-matrix-client/issues/659)
and the capability batches under
[Migrate remaining Android user journeys](https://github.com/quwisky/trinity-matrix-client/issues/660).
The [source inventory](https://github.com/quwisky/trinity-matrix-client/issues/654#issuecomment-5605110888)
remains the complete starting inventory. Each later migration must account for its
remaining assertions and variants before retiring their Playwright execution.

## Critical milestone

The `android.critical-journeys` suite uses the installed primary and secondary APKs,
two distinct Matrix users, and separate native session and Rust crypto stores on one
API 36 emulator. The coordinator stops the inactive application before attaching to
the active WebView. Maestro owns native input and augments its WebView hierarchy
through DevTools for DOM hooks and rendered content, as selected by the native
feasibility result. Direct CDP observes exact values and durable crypto databases
and permits the disposable Synapse certificate for that process.

Fixture HTTP requests register users and prepare an empty encrypted room with both
members. Every message is composed through the installed app. Each received message
must have the exact expected body and the sender's event ID, and the server event
must contain Megolm ciphertext with no plaintext body.

| Journey key                      | Existing assertion or feasibility source                                                                                                                                                                                           | New Android guarantee                                                                                                                                                                  | Remaining assertions owned elsewhere                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                          | [Android navigation](navigation.spec.mts), “logs in, opens settings by touch, and handles hardware Back”; [runner smoke](runner-smoke.mts)                                                                                         | Both fresh native clients reach their own authenticated Rooms route. Their durable account identities and account-scoped crypto databases exist and differ.                            | Settings navigation and hardware Back continue in the existing suite.                                                                           |
| `two-user-encrypted-messaging`   | [Message shields](../browser/journeys/trust/message-shield.spec.mts), the real encrypted sender/reader setup; [native encryption feasibility](https://github.com/quwisky/trinity-matrix-client/issues/655#issuecomment-5606670457) | B sends ASCII and an accent/emoji vector, A decrypts them and replies, and B decrypts the reply. Exact native input and server event correlation are asserted.                         | Shield levels, cross-signing, tooltips, plaintext-room behavior and other conversation assertions continue in their existing suites.            |
| `process-restart-restoration`    | [Android navigation](navigation.spec.mts), “restores the authenticated route after a native process restart”                                                                                                                       | A new Android process restores the same user, device and crypto database; previously received messages remain decryptable, and a fresh post-restart send decrypts in the other client. | Multi-account switching, sign-out and reauthentication retain their existing owners.                                                            |
| `background-foreground-recovery` | [Native lifecycle feasibility](https://github.com/quwisky/trinity-matrix-client/issues/655#issuecomment-5606670457)                                                                                                                | Home makes the document hidden, explicit activity foregrounding makes it visible, and the same process and account persist. A fresh post-resume message decrypts in the other client.  | Push delivery, process termination by the OS, offline transport recovery and physical Android release acceptance retain their dedicated owners. |

[Installed app-shell protection](app-shell.spec.mts), including redirecting an
unauthenticated protected route to login, also remains in the predecessor suite.
The milestone does not retire an entire source file merely because it covers one
of that file's assertions.

## Run and inspect

Prepare a production renderer and record its manifest, then run the registered target:

```bash
pnpm nx run trinity:build
node scripts/web-bundle-manifest.mjs write www
pnpm nx run trinity-e2e-android:critical-journeys
```

The target verifies the manifest and builds both APKs from the same renderer. Set
`MAESTRO_CLI` when the pinned Maestro installation is outside `PATH`. An explicit
`TRINITY_ANDROID_SERIAL` borrows a disposable emulator; otherwise the adapter owns
a private emulator overlay. Synapse and Android resource locks serialize the run.

CI executes this target on the first existing Android shard, alongside the runner
smoke and the unchanged Playwright shards. Its diagnostics use the existing upload
action and are retained whenever the critical suite started under the job's
artifact policy.

Each invocation writes its suite summary and JUnit result under
`dist/.playwright/trinity-e2e-android/<run-id>/android.critical-journeys/`.
The `critical-android` directory contains per-journey durations and outcomes,
sanitized account identities, encrypted-event metadata, screenshots, native flow
reports, WebView version, activity state and logcat. The issue's evidence records
the exact source, renderer, APK and tool inputs, failed development attempts,
deliberate negative cases and the consecutive first-attempt acceptance run.

Acceptance requires twenty consecutive successful runs of all four journeys on
unchanged relevant inputs, with zero retries and effective negative cases. A
successful implementation check or a single CI run does not establish that gate.

## Hosted shard layout

`.github/workflows/ci.yml` is the authority for current Android shard
placement; shard statements in the sections below record the placement at each
batch's acceptance. Run 36064938227 showed four shards could not hold the
migrated suites: shard 2 queued about 263 native minutes, its emulator stopped
answering adb after 3h15m, and shard 4 reached its 180-minute limit inside
retained Playwright. The Android job therefore has six shards, and retained
Playwright uses `--shard=N/6`.

| Shard | Moved suites |
| --- | --- |
| 5 (from 2) | `gif-picker`, `hide-system-messages`, `jump-to-date`, `jump-to-latest`, `link-preview`, `location-share`, `media-retention`, `message-action-sheet`, `legacy-sso`, `sso-recovery-reset` |
| 6 (from 2) | `message-authenticity-shield`, `native-shell`, `space-settings-core`, `space-leave`, `room-tombstone`, `member-details-promotion`, `member-role-classification` |
| 6 (from 4) | `room-widget-settings`, `space-settings-resilience` |

The pinned Chrome fixture runtime follows the SSO suites to shard 5. Every
suite keeps its target, timeout, started flag and diagnostics upload.

## Native shell, Back and Appearance batch

[Migrate Android native shell, Back and appearance journeys](https://github.com/quwisky/trinity-matrix-client/issues/670)
owns the eight definitions in the four Android-specific predecessor files. The
`android.native-shell` suite preserves their complete assertions and helper contracts;
the critical milestone's login coverage does not replace the unauthenticated route
guard or Settings Back assertions. Existing Playwright execution remains enabled
while this batch is verified.

| Stage                           | Predecessor definition at `877925dd`                                                                  | Required parity                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthenticated-shell`         | [App shell](app-shell.spec.mts), lines 8–14, and `expectLoginScreen` / `expectProtectedRouteRedirect` | Visible Homeserver and Continue; unauthenticated Settings navigation redirects to login.                                                                                                 |
| `settings-touch-back`           | [Navigation](navigation.spec.mts), lines 78–88                                                        | Account-qualified Rooms, native touch opens Settings and its sections, hardware Back restores the rendered Rooms surface.                                                                |
| `authenticated-process-restart` | [Navigation](navigation.spec.mts), lines 90–101                                                       | Native process restart restores the authenticated Rooms route and visible surface at this batch's revision.                                                                              |
| `settings-section-back`         | [Navigation](navigation.spec.mts), lines 103–140                                                      | Retained 390×844 mobile/touch viewport; target ≥44px; Appearance heading focus; Back restores directory focus, overflow ≤1px, then Rooms.                                                |
| `composer-keyboard-insert-back` | [Navigation](navigation.spec.mts), lines 166–244                                                      | Actual IME resize and native text input; insert tray dismisses IME, stays within the restored viewport, and Back restores focus and collapsed ARIA state.                                |
| `members-back-order`            | [Navigation](navigation.spec.mts), lines 246–299                                                      | Focused Members filter and IME; ordered Back dismisses keyboard, Members, then Conversation.                                                                                             |
| `composer-formatting`           | [Native formatting](composer-format-native.spec.mts), lines 48–98                                     | Native Aa/italic activation produces `say *hello*`, selection [5,10], editor focus and shown IME; sheet geometry and Back cancellation preserve content.                                 |
| `native-appearance`             | [Appearance](appearance.spec.mts), lines 75–219                                                       | Android/coarse pointer, light Amethyst/Cosy and dark Onyx/Compact/Larger projections, native StatusBar state, 20px font, target/overflow/inset geometry and paired device/WebView proof. |

The Settings viewport has a retained CDP owner; it is released before native IME
checks so Android's real keyboard resize remains observable. Other CDP reads
observe rendered state or the actual Capacitor plugin. Maestro owns native
interaction. The formatting case retains the predecessor's explicit selection
setup separately from the native formatting action. Its exact lowercase text
fixture selects the initial character and replaces it through Maestro input to
avoid the keyboard's word-commit capitalization; the expected formatted text,
selection and native keyboard assertions remain exact.

Run the batch against a verified production renderer with:

```bash
pnpm nx run trinity-e2e-android:native-shell
```

CI invokes it on the second existing Android shard and retains started-suite
diagnostics under
`dist/.playwright/trinity-e2e-android/<run-id>/android.native-shell/`.
The `native-shell/journeys.json` report records each stage's first-attempt outcome
and duration; screenshots and native/runtime diagnostics stay in ignored output.

Batch acceptance is pending until the owning issue records installed-emulator
parity, effective negative controls, predecessor coexistence and current-revision
quality/CI diagnostics. Completing this batch does not complete the canonical
Android ledger, physical push acceptance or the full migration's CI reliability gate.

## Account lifecycle and mixed workspace batch

[Account lifecycle and mixed workspace migration](https://github.com/quwisky/trinity-matrix-client/issues/672)
owns all fourteen definitions in the two canonical files below at `ed70277`.
The `android.accounts-workspace` suite runs every definition, resets the installed
app before each case and records a separate outcome for each. The predecessors
remain enabled during coexistence.

| Predecessor                                                                      | Lines   | Required parity                                                                                                                  |
| -------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [Account lifecycle](../browser/journeys/accounts/account-lifecycle.spec.mts)     | 25–83   | Add second Account; encryption banner; menu labels and exact count; Escape focus; switch back.                                   |
| Account lifecycle                                                                | 85–130  | Three Accounts, repeated switches, active-row no-op and absence of switch errors.                                                |
| Account lifecycle                                                                | 132–191 | Two unread messages contribute to the recorded Badge total before and after an active Account switch.                            |
| Account lifecycle                                                                | 193–220 | Removing the active Account preserves the surviving Account and exact menu count.                                                |
| Account lifecycle                                                                | 222–260 | Remove and re-add the same Account through the real persistent crypto-store lifecycle.                                           |
| Account lifecycle                                                                | 262–283 | Remove the only Account, reach login and reconnect.                                                                              |
| Account lifecycle                                                                | 285–300 | Cancel adding an Account and preserve the current Account and menu count.                                                        |
| Account lifecycle                                                                | 302–330 | Reconnect guidance, prefilled locked username, password entry and restored Account.                                              |
| [Mixed workspace](../browser/journeys/accounts/mixed-account-workspace.spec.mts) | 16–71   | Mixed room visibility, owning-Account badge, active-row constraints and correct acting identity.                                 |
| Mixed workspace                                                                  | 73–128  | Mixed Space pills, owning-Account badge and correct acting identity.                                                             |
| Mixed workspace                                                                  | 132–322 | Persist selection across reload; desktop keyboard navigation, focus restoration and geometry in both themes at 125% font size.   |
| Mixed workspace                                                                  | 339–478 | Pixel 5 profile; long Account names; both themes; actual short-list overflow, visible Done action, retained selection and focus. |
| Mixed workspace                                                                  | 481–529 | Quick switcher excludes another Account's room until mixed in, then shows its badge and opens it as its owner.                   |
| Mixed workspace                                                                  | 534–636 | Mixed invite visibility, distinct hydrated display names and the acting-identity header without an MXID fallback.                |

The retained viewport owner preserves the predecessor's desktop 1280×720 profile
and Pixel 5 viewport, user agent and pixel ratio, including its explicit 390×844
and 390×260 resizes. Maestro taps native screen coordinates measured from the
current WebView and retained viewport scale. A capture listener verifies a trusted
click reached the selected element; it does not dispatch or substitute input.
The Android keyboard adapter sends native key events for Arrow, Home, End, Space,
Tab and Escape because the pinned Maestro key enumeration lacks the required
keyboard meanings. Explicit focus, theme and font fixtures mirror the predecessor.

The badge case retains the predecessor's prebootstrap Capacitor Badge interception.
It proves the application's aggregate Badge calls, not a physical launcher's badge.
Matrix fixtures use the invocation-owned disposable Synapse and clean up room
memberships before logging out their API sessions.

```bash
pnpm nx run trinity-e2e-android:accounts-workspace
```

The existing third Android CI shard runs the batch. Its original hosted attempt
completed twelve cases before reaching the former 55-minute test limit. Stable
native-input probes measured approximately 15 seconds per warm fill; driver reuse
and counted erasure did not materially improve that cost. The complete batch now
allows 75 minutes in the Node test, 80 minutes in its resource-owning wrapper and
85 minutes in both the registry and CI command supervisor. The existing third
shard allows 240 minutes for smoke, this batch, its retained predecessor shard and
setup/diagnostics. Shard two allows 120 minutes including core Space Settings;
shards one and four allow 120 minutes for the Sidebar and Identity batches below. These
budgets preserve all fourteen cases, native actions and assertions; they are not
retries or acceptance evidence.

Started-suite diagnostics live
under `dist/.playwright/trinity-e2e-android/<run-id>/android.accounts-workspace/`;
`accounts-workspace/journeys.json` records all started cases, original source
ranges and first-attempt outcomes. Accepted installed-host parity, effective
negative controls, repeated first-attempt runs and original hosted evidence are
recorded in [the Accounts batch](https://github.com/quwisky/trinity-matrix-client/issues/672). Other Account journeys,
physical Android acceptance and the full migration reliability gate retain their
separate owners.

## Identity avatar and ordinary presence batch

[Android DM avatar and ordinary presence migration](https://github.com/quwisky/trinity-matrix-client/issues/674)
owns these three definitions at `f90ff0e`. The `android.identity-presence` suite
resets the installed app before each definition and uses the existing native
Account login and input adapter with the predecessor's 1280×720 desktop viewport.
All three definitions are mandatory in each complete invocation. Their Playwright
predecessors remain enabled during coexistence.

| Predecessor                                                       | Lines                  | Required parity                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DM avatar](../browser/journeys/identity/dm-avatar.spec.mts)      | 148–186                | Visible decoded partner image with a `blob:` URL in the unpictured DM; then a visible named group's avatar with no image in the same session. Both rooms have the same two members.                                                                     |
| [Member presence](../browser/journeys/identity/presence.spec.mts) | 153–182; helper 91–108 | Native room navigation; visible timeline; initially hidden member panel; native toggle and visible panel; exactly two seeded member rows; first presence dot visible with role `img` and an Online/Away/Offline label; reader's own online dot visible. |
| DM presence                                                       | 184–202                | Visible presence indicator in the exact seeded counterpart's DM sidebar row.                                                                                                                                                                            |

These rows retain ten direct body assertions and three member-panel helper
assertions, plus fixture and login readiness. Each login also verifies the exact
account-qualified `/rooms` pathname. Observations read the installed WebView DOM;
product actions use native input. The avatar check requires image completion and
positive natural dimensions before checking the two-member group, preserving the
predecessor's warmed-cache control.

For the two Rooms navigation steps, the Maestro flow requests current native
coordinates from a bounded local observation endpoint after the CLI has started.
The retained viewport supplies the mapping, and a trusted-click observation
verifies the selected target. This handles the observed startup banner shifting
the rail while the CLI launches, without adding gesture retries. Other native
actions retain the existing input adapter.

Owned Matrix fixtures upload the canonical PNG to the partner's profile, create
and join an unencrypted private DM, and record it in the reader's `m.direct`.
Neither avatar-case room has a room avatar. The named group has the same two
members and is absent from `m.direct`. Fixture requests are finite and abortable;
cleanup leaves and forgets known memberships before logging out API sessions.

```bash
pnpm nx run trinity-e2e-android:identity-presence
```

The fourth existing Android CI shard runs the batch between runner smoke and its
unchanged Playwright shard. The initial budgets are 15 minutes for the Node test,
18 minutes for its resource-owning wrapper, 20 minutes for the CI command and
120 minutes for the complete shard. These are provisional bounds until measured
installed-host evidence is recorded; budgets do not establish acceptance.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.identity-presence/`.
`identity-presence/journeys.json` records the three stage identities, predecessor
ranges, first-attempt outcomes and durations. [Accepted #674 evidence](https://github.com/quwisky/trinity-matrix-client/issues/674#issuecomment-5629058155)
records complete installed-host parity, all five effective avatar and presence
fault controls, the changed-fixture Accounts regression, exact predecessor
comparison, three consecutive complete runs with frozen inputs and original-attempt
hosted evidence.

Presence recovery definitions beginning at `presence.spec.mts:246` explicitly
exclude the production Android APK and remain with the browser migration owner.
This batch does not transfer other Android journeys, physical push acceptance or
the full migration reliability gate from their existing owners.

## Sidebar room filtering batch

[Android sidebar filtering migration](https://github.com/quwisky/trinity-matrix-client/issues/676)
owns exactly these two definitions at `738ef48`. The `android.sidebar-filter`
suite resets the installed app for each definition and uses native Account login,
Rooms navigation and text/key input at the predecessor's 1280×720 desktop viewport.
Both definitions are mandatory. Their Playwright predecessors remain enabled.

| Predecessor                                                                | Lines   | Required parity                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Sidebar filter](../browser/journeys/room-library/sidebar-filter.spec.mts) | 103–162 | Initially absent clear button; accent-folded `cafeteria` matches only the exact accented room and retains the query; `zzzz` leaves zero rows with the filtered-empty copy; native clear restores the empty value and exactly both original names. |
| Sidebar filter                                                             | 164–196 | Exactly two initial rows; `warehouse` matches only the exact Warehouse room; focused native Escape empties the value, restores exactly both original names and leaves the filter visible.                                                         |

The rows retain all sixteen direct assertions plus setup and native-action
obligations. Each definition creates a fresh reader with two private, non-DM rooms,
`Cafétéria <suffix>` and `Warehouse <suffix>`, and verifies the exact Account-qualified
`/rooms` route. Initial room readiness keeps the 30-second deadline; filtering and
restoration counts keep their 10-second deadlines. Complete rendered room-name
arrays prove inclusion and exclusion. Read-only DOM observations record values,
visibility and focus. Current-coordinate native taps select Rooms and clear;
Android Escape keycode 111 acts on the focused filter. The Escape definition does
not open a Conversation, so its retained final assertion proves filter visibility.

```bash
pnpm nx run trinity-e2e-android:sidebar-filter
```

The first existing Android CI shard runs the batch after critical journeys and
before its unchanged Playwright shard. Provisional bounds are 15 minutes for the
Node test, 18 minutes for the resource-owning wrapper, 20 minutes for the CI
command and 120 minutes for the complete shard. Measured local and original hosted
runs must establish that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.sidebar-filter/`.
`sidebar-filter/journeys.json` records both stages, source ranges, first-attempt
outcomes and artifact pointers. Stage-local JSON files retain each assertion's
observation; the suite and progress reports cover the complete run, including
registered fixture and device cleanup after the stage summary. Acceptance remains pending until #676
records complete installed-host parity; effective accent-fold, empty-copy,
clear-button and Escape fault controls; the exact two unchanged predecessors;
three consecutive complete runs with frozen inputs; required quality checks;
and original-attempt hosted evidence. Other Room Library definitions, physical
Android acceptance and the full migration reliability gate keep their existing owners.

## Sidebar touch targets and identity dock batch

[Android sidebar touch migration](https://github.com/quwisky/trinity-matrix-client/issues/687)
owns the complete `keeps the rail, room, menu and identity-dock controls
touch-sized` definition in
[Sidebar touch](../browser/journeys/room-library/sidebar-touch.spec.mts), lines
32–164 at `1e3f8a45`. The pinned source SHA-256 is
`8b09cba85b29db3e4819462e45b0f074f516198dca8f1733c195722c492f6ebb`.
`android.sidebar-touch` resets the installed app to the predecessor's exact
Playwright 1.62.1 Pixel 5 profile and runs the single definition as one mandatory
stage. Its Playwright predecessor remains enabled.

| Predecessor obligation              | Replacement assertion identities                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Touch media profile                 | `touch.media-profile` records both no-hover and coarse-pointer results as one composite assertion.                                                               |
| Account menu hierarchy and viewport | `account-menu.visible`, `account-menu.switch-account-copy`, `account-menu.add-account-copy`, `account-menu.remove-account-copy`, `account-menu.within-viewport`  |
| Escape focus restoration            | `account-menu.escape-focus-restored` after recorded native Android Escape keycode 111 dispatch                                                                   |
| Narrow identity dock                | `identity-dock.position`, `identity-dock.display`, `identity-dock.flow`; the flow observation throws when either required node is missing.                       |
| Rail and identity actions           | Width and height identities under `touch-target.rail-rooms`, `touch-target.user-menu-trigger`, and `touch-target.open-settings`, each retaining the 44 px floor. |
| Room row and kebab                  | `room-row.height`, `room-menu.opacity`, `room-menu.width`, `room-menu.height`, `room-menu.low-priority-visible`                                                  |

These are exactly 21 direct predecessor assertions. Setup creates a fresh
account and exactly one private `Touch <suffix>` room, then verifies the exact
account-qualified `/rooms` route. The room-row readiness wait retains the
30-second deadline. Menu activation and Rooms navigation use current-coordinate
native taps; Escape is a native Android key dispatch. Media state, menu text,
focus, computed CSS and geometry are read-only WebView observations. The kebab
opacity and final action retain 10-second bounds, and geometry is measured only
after opacity reaches exactly 1.

```bash
pnpm nx run trinity-e2e-android:sidebar-touch
```

Android CI shard 1 runs this batch after sidebar filtering and before its
unchanged Playwright shard. Provisional bounds are 15 minutes for the Node test,
18 minutes for the resource-owning wrapper, 20 minutes for the CI command and
120 minutes for the complete shard. Measured local and hosted runs must establish
that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.sidebar-touch/`.
`sidebar-touch/journeys.json` records the stage source, first-attempt outcome and
artifact pointer. Stage-local assertion records, menu/device screenshots and the
suite progress report retain the observations, provenance and registered cleanup.
Acceptance remains pending until #687 records three complete first attempts, all
four effective fault controls, the unchanged predecessor, required quality checks
and original-attempt hosted evidence. Other Room Library definitions, physical
Android acceptance and the full migration reliability gate stay with their
existing owners.

## Room favourite and low-priority tags batch

[Android room tag migration](https://github.com/quwisky/trinity-matrix-client/issues/688)
owns both definitions in
[Favourite rooms](../browser/journeys/room-library/favourite-rooms.spec.mts),
lines 130–196 and 198–275 at `a4197c4e`. The pinned source SHA-256 is
`35b1ba6d96033782dfb66e31a67821cb97a81c7bf98d4d729cbab5fd3313a228`.
`android.room-tags` resets the installed app to the Playwright 1.62.1 Pixel 5
profile for each definition and runs them as two mandatory stages. Both
Playwright predecessors remain enabled.

| Predecessor obligation      | Replacement assertion identities                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Favourite and unfavourite   | `favourite.initial-section-absent`, `favourite.menu-label`, `favourite.first-room`, `unfavourite.menu-label`, `unfavourite.section-absent`                                                                                                                                                       |
| Low priority and double tag | `low-priority.initial-section-absent`, `low-priority.initial-first-room`, `low-priority.menu-label`, `low-priority.last-room`, `low-priority.first-room`, `double-tag.low-priority-section-absent`, `double-tag.favourites-section-visible`, `double-tag.first-room`, `double-tag.restore-label` |

These are exactly 14 direct predecessor assertions. Each stage creates a fresh
account and exactly two private, non-DM rooms in Alpha-then-Bravo order, verifies
the exact account-qualified `/rooms` route, opens Rooms with a native tap and
waits up to 30 seconds for both exact room names. Room kebabs are targeted by
their exact accessible `Options for <room>` labels. Dropdown items are activated
with current-coordinate native taps. Menu copy, category visibility and complete
room order are read-only WebView observations.

The first stage proves the Favourite label and partition/order round trip, then
the Unfavourite label and section removal. The second proves the initial
activity order, Low priority label and demoted order, then the double-tag rule:
favourite wins the partition and sort while the retained low-priority tag changes
the menu copy to Restore to list. Tag round trips retain 30-second deadlines and
menu readiness/copy retain 10-second deadlines.

```bash
pnpm nx run trinity-e2e-android:room-tags
```

Android CI shard 1 runs this batch after sidebar touch and before its unchanged
Playwright shard. Provisional bounds are 15 minutes for the Node test, 18 minutes
for the resource-owning wrapper, 20 minutes for the CI command and 120 minutes
for the complete shard. Measured local and hosted runs must establish that these
bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-tags/`.
`room-tags/journeys.json` records both stage sources, first-attempt outcomes and
artifact pointers. Stage-local assertion records, screenshots and the suite
progress report retain observations, provenance and registered cleanup.
Acceptance remains pending until #688 records three complete first attempts, all
four effective fault controls, both unchanged predecessors, required quality
checks and original-attempt hosted evidence. Other Room Library definitions,
physical Android acceptance and the full migration reliability gate stay with
their existing owners.

## Room read-state batch

[Android room read-state migration](https://github.com/quwisky/trinity-matrix-client/issues/689)
owns the complete three definitions in
[Mark as read](../browser/journeys/room-library/mark-read.spec.mts), lines
48–102, and
[Mark as unread](../browser/journeys/room-library/mark-unread.spec.mts), lines
29–103 and 105–180 at `bdf4a7a7`. Their pinned SHA-256 values are
`38d3d95524dcb03cbc36ba0891031e52014ed66a8ff7416df374aa7f2256828b`
and
`43165d7f4fc936d214d54e5410d7876d174e6e61c0c477ed6fa8d398e70963b6`.
`android.room-read-state` resets the installed app to the Playwright 1.62.1
Pixel 5 profile for each definition and runs them as three mandatory stages.
All three Playwright predecessors remain enabled.

| Predecessor obligation | Replacement assertion identities                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mark all as read       | `mark-all.room-visible`, `mark-all.action-visible`, `mark-all.action-hidden`                                                                                                                        |
| Local Mark as unread   | `local.initial-flag-absent`, `local.initial-badge-absent`, `local.flag-round-trip`, `local.dot-visible`, `local.dot-empty`, `local.conversation-visible`, `local.flag-cleared`, `local.dot-cleared` |
| Remote Mark as unread  | `remote.initial-badge-absent`, `remote.write-accepted`, `remote.live-dot-visible`, `remote.reload-dot-visible`, `remote.flag-cleared`, `remote.dot-cleared`                                         |

These are exactly 17 direct predecessor assertions. Every stage creates a fresh
account and a private, non-DM room, verifies the exact account-qualified
`/rooms` route, opens Rooms with a native tap and waits up to 30 seconds for the
exact room name. The Mark-all fixture adds a fresh sender, joins it to the room
and sends the unread message before the reader signs in. Room kebabs use their
exact accessible `Options for <room>` labels; menu and row actions use measured
current-coordinate native taps.

The local stage proves the initial server flag and UI badge are absent, the
native menu action writes `m.marked_unread`, and the resulting empty-text dot
clears both in the UI and on the server when the room is opened. The remote stage
writes the flag through the private-token fixture boundary while the app is
open, proves live projection and reload persistence, then proves the native Mark
as read action clears both projections. WebView access remains read-only; app
lifecycle and all product actions stay native. The predecessor's 30-second row,
action and live-sync waits and 20-second round-trip waits are preserved.

```bash
pnpm nx run trinity-e2e-android:room-read-state
```

Android CI shard 1 runs this batch after room tags and before its unchanged
Playwright shard. Provisional bounds are 15 minutes for the Node test, 18 minutes
for the resource-owning wrapper, 20 minutes for the CI command and 120 minutes
for the complete shard. Measured local and hosted runs must establish that these
bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-read-state/`.
`room-read-state/journeys.json` records all three stage sources, first-attempt
outcomes and artifact pointers. Stage-local assertion records, screenshots and
the suite progress report retain observations, provenance and registered
cleanup. Acceptance remains pending until #689 records three complete first
attempts, all four effective fault controls, all three unchanged predecessors,
required quality checks and original-attempt hosted evidence. Other Room Library
definitions, physical Android acceptance and the full migration reliability gate
stay with their existing owners.

## Room-list preview and unread-row batch

[Android room-list migration](https://github.com/quwisky/trinity-matrix-client/issues/690)
owns both complete definitions in
[Room list](../browser/journeys/room-library/room-list.spec.mts), lines 185–217
and 219–269 at `9edd3a22`. The pinned source SHA-256 is
`122c617df290018bd59fcb57a08ad962e78dbba1230ae87d16d9d3c684112654`.
`android.room-list` resets the installed app to the Playwright 1.62.1 Pixel 5
profile for each definition and runs them as two mandatory stages. Both
Playwright predecessors remain enabled.

| Predecessor obligation | Replacement assertion identities                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Preview row structure  | `preview.latest-body`, `preview.room-name`, `preview.avatar-count`, `preview.legacy-hash-absent` |
| Muted unread row badge | `unread.muted-badge-visible`, `unread.muted-badge-count`                                         |

These are exactly six direct predecessor assertions. Each stage creates a fresh
reader and sender with one private, non-DM room, verifies the exact
account-qualified `/rooms` route, opens Rooms with a native tap and waits up to
30 seconds for the exact room name. The sender joins and posts all messages
before the reader signs in so preview and unread state arrive through initial
sync. Product navigation and room opening use measured current-coordinate
native taps; row structure and state remain read-only WebView observations.

The preview stage proves the exact latest non-typing message body, exact room
name, one row avatar and absence of the retired hash element. The unread stage
posts exactly three plain messages and proves one visible muted badge with text
`3`. It then opens the row and records
`unread.badge-clear-observation`: whether the badge disappears within 15
seconds. The source intentionally catches that read-receipt round-trip timeout,
so the replacement preserves it as explicit diagnostics rather than promoting
it to a mandatory assertion.

```bash
pnpm nx run trinity-e2e-android:room-list
```

Android CI shard 1 runs this batch after room read-state and before its
unchanged Playwright shard. Provisional bounds are 15 minutes for the Node test,
18 minutes for the resource-owning wrapper, 20 minutes for the CI command and
120 minutes for the complete shard. Measured local and hosted runs must
establish that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-list/`.
`room-list/journeys.json` records both stage sources, first-attempt outcomes and
artifact pointers. Stage-local assertion records, the best-effort observation,
screenshots and the suite progress report retain observations, provenance and
registered cleanup. Acceptance remains pending until #690 records three
complete first attempts, effective preview/structure/badge fault controls, both
unchanged predecessors, required quality checks and original-attempt hosted
evidence. Other Room Library definitions, physical Android acceptance and the
full migration reliability gate stay with their existing owners.

## Aggregate and platform unread-badge batch

[Android unread-badges migration](https://github.com/quwisky/trinity-matrix-client/issues/691)
owns both complete Android-relevant definitions in
[Unread badges](../browser/journeys/room-library/unread-badges.spec.mts), lines
133–160 and the explicit Android branch at 162–186 at `1f7afeb7`. The pinned
source SHA-256 is
`88717c4e01c304025b951a359b1cda79a775e92015be2f294639b39490adfae0`.
`android.unread-badges` resets the installed app to the Playwright 1.62.1 Pixel
5 profile for each definition and runs them as two mandatory stages. Both
Playwright predecessors remain enabled.

| Predecessor obligation          | Replacement assertion identities                        |
| ------------------------------- | ------------------------------------------------------- |
| Aggregate Rooms-rail badge      | `rail.badge-visible`, `rail.badge-positive-count`       |
| Native platform-badge lifecycle | `platform.badge-set-three`, `platform.badge-clear-zero` |

These are exactly four direct predecessor assertions. Each stage creates a
fresh reader and sender with one private, non-DM room and posts exactly three
messages before the reader signs in. The aggregate stage proves that the Rooms
rail item has one visible positive-integer badge, preferring exact text `3` but
preserving the predecessor's documented notification-timing fallback.

The platform stage installs the existing Capacitor Badge boundary recorder
before app boot and proves its count reaches exactly `3` within 30 seconds. It
then opens Rooms and the exact room through measured current-coordinate native
taps and proves the count reaches exactly `0` within 15 seconds. That clear is
mandatory because the predecessor explicitly requires it on Android. WebView
access remains read-only; fixture setup uses Matrix APIs, and recorder removal,
client/device cleanup and secret redaction remain registered on failures.

```bash
pnpm nx run trinity-e2e-android:unread-badges
```

Android CI shard 1 runs this batch after room-list and before its unchanged
Playwright shard. Provisional bounds are 15 minutes for the Node test, 18
minutes for the resource-owning wrapper, 20 minutes for the CI command and 120
minutes for the complete shard. Measured local and hosted runs must establish
that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.unread-badges/`.
`unread-badges/journeys.json` records both stage sources, first-attempt outcomes
and artifact pointers. Stage-local assertion records, screenshots and the suite
progress report retain observations, provenance and registered cleanup.
Acceptance remains pending until #691 records three complete first attempts,
effective rail/native badge fault controls, both unchanged predecessors,
required quality checks and original-attempt hosted evidence. Other Room
Library definitions, physical Android acceptance and the full migration
reliability gate stay with their existing owners.

## Leave-room functional batch

[Android leave-room migration](https://github.com/quwisky/trinity-matrix-client/issues/692)
owns the complete functional definition in
[Leave room](../browser/journeys/room-library/leave-room.spec.mts), lines 79–110
at `4e4a80f5`. The pinned source SHA-256 is
`3ff3a9e93bc430044062948c4e8e6bac67578f5588d68691ac540f46e41b390c`.
`android.leave-room` resets the installed app to the Playwright 1.62.1 Pixel 5
profile and runs one mandatory stage. The functional Playwright predecessor and
the same file's browser-only contrast definition both remain enabled.

| Predecessor obligation        | Replacement assertion identities                      |
| ----------------------------- | ----------------------------------------------------- |
| Initial two-room list         | `setup.leave-row-visible`, `setup.keep-row-visible`   |
| Destructive menu and dialog   | `menu.leave-action-visible`, `dialog.confirm-visible` |
| Membership-driven list update | `list.left-absent`, `list.keep-visible`               |

These are exactly six direct assertions. The stage creates one fresh reader
joined to two private, non-DM rooms, verifies the exact account-qualified
`/rooms` route and opens Rooms with a measured native tap. It targets the leave
room's exact `Options for …` accessibility label, proves the destructive action
and confirmation are visible, then activates both through measured
current-coordinate native taps. Within 30 seconds the left room must be absent
while the control room remains uniquely visible. WebView access remains
read-only; fixture setup uses Matrix APIs, and client/device cleanup and secret
redaction remain registered on failures.

```bash
pnpm nx run trinity-e2e-android:leave-room
```

Android CI shard 1 runs this batch after unread badges and before its unchanged
Playwright shard. Provisional bounds are 15 minutes for the Node test, 18
minutes for the resource-owning wrapper, 20 minutes for the CI command and 120
minutes for the complete shard. Measured local and hosted runs must establish
that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.leave-room/`.
`leave-room/journeys.json` records the stage source, first-attempt outcome and
artifact pointer. Stage-local assertion records, screenshots and the suite
progress report retain observations, provenance and registered cleanup.
Acceptance remains pending until #692 records three complete first attempts,
effective menu/membership fault controls, the unchanged functional predecessor,
required quality checks and original-attempt hosted evidence. The source's
canvas-composited mouse-hover/media-emulation contrast definition remains
browser-renderer coverage; other Room Library definitions, physical Android
acceptance and the full migration reliability gate stay with their existing
owners.

## Recent Activity batch

[Android Recent Activity migration](https://github.com/quwisky/trinity-matrix-client/issues/693)
owns all four definitions in
[Recent activity](../browser/journeys/room-library/recent-activity.spec.mts),
lines 97–301 at `4dbf0ce5`. The pinned source SHA-256 is
`c2b12540c8b45ace5a7d3e2111c3f00a61ba69555522b5b6212636cb0fc9243c`.
`android.recent-activity` resets the installed app to the Playwright 1.62.1
Pixel 5 profile for four mandatory stages. All four Playwright predecessors
remain enabled.

| Predecessor obligation                           | Replacement assertion identities                                                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default mixed list and Home/Rooms/Recent scoping | `scope.recent-current`, `scope.recent-dm-visible`, `scope.recent-room-visible`, `scope.home-recent-not-current`, `scope.home-dm-visible`, `scope.home-room-absent`, `scope.rooms-room-visible`, `scope.rooms-dm-absent`, `scope.return-dm-visible`, `scope.return-room-visible` |
| Favourite partition and row order                | `favourites.recent-current`, `favourites.section-visible`, `favourites.row-visible`, `favourites.dm-visible`, `favourites.index-present`, `favourites.before-dm`                                                                                                                |
| Space-child inclusion in Recent but not Rooms    | `space.recent-current`, `space.free-visible`, `space.child-visible`, `space.rooms-free-visible`, `space.rooms-child-absent`                                                                                                                                                     |
| Recent unread badge                              | `unread.badge-visible`, `unread.badge-numeric`, `unread.badge-positive`                                                                                                                                                                                                         |

These are exactly 24 direct assertions. Every stage uses fresh accounts and
unique room names. Matrix APIs create the ordinary/direct rooms, favourite tag,
space-child state and unread messages that the predecessors require. The
installed client must open on the exact account-qualified `/rooms` route with
Recent current. Home, Rooms and Recent transitions use measured
current-coordinate native taps. Exact rows, current-state attributes, complete
row order and badge text are read-only WebView observations. The unread stage
seeds three messages and accepts the predecessor's exact preferred count or its
positive numeric fallback. Client/device cleanup and secret redaction remain
registered on failures.

```bash
pnpm nx run trinity-e2e-android:recent-activity
```

Android CI shard 1 runs this batch after leave-room and before its unchanged
Playwright shard. Provisional bounds are 15 minutes for the Node test, 18
minutes for the resource-owning wrapper, 20 minutes for the CI command and 120
minutes for the complete shard. Measured local and hosted runs must establish
that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.recent-activity/`.
`recent-activity/journeys.json` records each stage source, first-attempt outcome
and artifact pointer. Stage-local assertion records, screenshots and the suite
progress report retain observations, provenance and registered cleanup.
Acceptance remains pending until #693 records three complete first attempts,
effective scoping/order/space/unread fault controls, all four unchanged
predecessors, required quality checks and original-attempt hosted evidence.
Other Room Library definitions, physical Android acceptance and the full
migration reliability gate stay with their existing owners.

## Spaceless room-filter functional batch

[Android spaceless room filtering](https://github.com/quwisky/trinity-matrix-client/issues/694)
owns the installed-Android functional guarantees in
[Rooms view excludes space-owned rooms](../browser/journeys/room-library/room-filter-spaceless.spec.mts),
lines 147–230 at `758e9f21`. The pinned source SHA-256 is
`0f5d42072c018ef27e6e1c6276f72b209d43b927666149c8e7574c2bc4aefadc`.
`android.room-filter-spaceless` resets the installed app to the Playwright
1.62.1 Pixel 5 profile for one mandatory stage. The complete Playwright
predecessor remains enabled.

| Predecessor obligation                                                 | Replacement assertion identities                   |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| Flat Rooms includes the freestanding room and excludes the space child | `rooms.freestanding-visible`, `rooms.child-absent` |
| Exact space pill is present, selectable and current                    | `space.pill-visible`, `space.pill-current`         |
| Selected space reveals the exact child                                 | `space.child-visible`, `space.child-name-exact`    |

These are exactly six direct assertions. The stage creates a fresh reader, one
private freestanding room, one private `m.space` and one private child linked by
an `m.space.child` event with `via: ['localhost']` and `suggested: true`. The
installed client must open on the exact account-qualified `/rooms` route. Rooms
and the exact named space pill are activated through measured current-coordinate
native taps. Exact rows, current state and channel-name text are read-only
WebView observations. Client/device cleanup and secret redaction remain
registered on failures.

```bash
pnpm nx run trinity-e2e-android:room-filter-spaceless
```

Android CI shard 1 runs this batch after Recent Activity and before its
unchanged Playwright shard. Provisional bounds are 15 minutes for the Node test,
18 minutes for the resource-owning wrapper, 20 minutes for the CI command and
120 minutes for the complete shard. Measured local and hosted runs must
establish that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-filter-spaceless/`.
`room-filter-spaceless/journeys.json` records the stage source, first-attempt
outcome and artifact pointer. Stage-local assertion records, screenshots and the
suite progress report retain observations, provenance and registered cleanup.
Acceptance remains pending until #694 records three complete first attempts,
effective Rooms/space/child fault controls, the unchanged predecessor, required
quality checks and original-attempt hosted evidence. The source's computed
radius, pseudo-element and mouse-hover checks remain browser-renderer coverage;
other Room Library definitions, physical Android acceptance and the full
migration reliability gate stay with their existing owners.

## Space creation and join curation functional batch

[Android space creation and join curation](https://github.com/quwisky/trinity-matrix-client/issues/695)
owns the installed-Android functional guarantees in three definitions from
[Space curation](../browser/journeys/room-library/space-curation.spec.mts),
lines 92–140, 142–221 and 392–457 at `0ac64bed`. The pinned source SHA-256 is
`35a2dd1726eef56c03288c64c23885703f3f1d06927870d4eeabac7bf3a51c7b`.
`android.space-curation-create-join` resets the installed app to the Playwright
1.62.1 Pixel 5 profile for three mandatory stages. All three complete
Playwright predecessors remain enabled.

| Predecessor obligation                                              | Replacement assertion identities                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Existing-room prompt is visible and writes a reachable child link   | `add.dialog-visible`, `add.link-present`, `add.link-via-array`, `add.link-via-nonempty` |
| Nested-space prompt creates and links an actual `m.space` child     | `subspace.name-field-visible`, `subspace.link-present`, `subspace.child-type-space`     |
| Joining an offered child updates the live space view without reload | `join.action-visible`, `join.action-hidden`, `join.child-row-visible`                   |

These are exactly ten direct assertions. Each stage uses fresh accounts and
rooms. Matrix state reads remain inside the fixture closure so access tokens
cannot enter diagnostics. Space selection, menus, room picks, creation and join
actions use measured current-coordinate native taps; the nested-space name uses
native input. WebView access is observation-only. UI-created membership is
registered for leave/forget cleanup, and client/device cleanup plus secret
redaction remain registered on failures.

```bash
pnpm nx run trinity-e2e-android:space-curation-create-join
```

Android CI shard 1 runs this batch after spaceless filtering and before its
unchanged Playwright shard. Provisional bounds are 15 minutes for the Node test,
18 minutes for the resource-owning wrapper, 20 minutes for the CI command and
120 minutes for the complete shard. Measured local and hosted runs must
establish that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.space-curation-create-join/`.
`space-curation-create-join/journeys.json` records each stage source,
first-attempt outcome and artifact pointer. Stage-local assertion records,
screenshots and the suite progress report retain observations, provenance and
registered cleanup. Acceptance remains pending until #695 records three
complete first attempts, effective link/type/join fault controls, all three
unchanged predecessors, required quality checks and original-attempt hosted
evidence. The source's computed dialog-opacity assertion and its write-fault,
held-write, reorder and desktop-keyboard definition remain browser coverage;
other Room Library definitions, physical Android acceptance and the full
migration reliability gate stay with their existing owners.

## Space room-order functional batch

[Android space room ordering](https://github.com/quwisky/trinity-matrix-client/issues/696)
owns the installed-Android functional guarantees in two definitions from
[Space room order](../browser/journeys/room-library/space-room-order.spec.mts),
lines 237–347 and 428–464 at `40820c19`. The pinned source SHA-256 is
`b26ae29366d8d470a1f813da9bf9e6b501ec4f49d77d432f1ba7e77606c96705`.
`android.space-room-order` resets the installed app to the Playwright 1.62.1
Pixel 5 profile for two mandatory stages. Both complete Playwright predecessors
remain enabled.

| Predecessor obligation                                                                                                         | Replacement assertion identities                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default recency, a durable per-Space override, unchanged shared hierarchy, Account-default precedence and the sidebar shortcut | `preference.default-recency-order`, `preference.form-visible`, `preference.space-order-checked`, `preference.saved-feedback`, `preference.hierarchy-unchanged`, `preference.curated-order`, `preference.reload-curated-order`, `preference.account-default-curated-order`, `preference.default-saved-feedback`, `preference.alphabetical-order`, `preference.shortcut-recency-order` |
| A newly synchronized message reorders the already-open Space                                                                   | `live.initial-recency-order`, `live.reordered-recency-order`                                                                                                                                                                                                                                                                                                                         |

These are exactly thirteen direct assertions. Each stage uses a fresh Account,
one Space and three uniquely named children whose curated, alphabetical and
recency orders disagree pairwise. Matrix APIs create the rooms, explicit
`m.space.child` order values and messages; before/after content snapshots prove
the device-local preference never rewrites the shared hierarchy. Space,
settings, radio, select, save, close, sidebar-sort and Android Back actions use
measured native Maestro input. A read-only WebView owner observes exact row
order, checked state and feedback and performs the predecessor's explicit
document reload. Client/device cleanup and secret redaction remain registered on
failures.

```bash
pnpm nx run trinity-e2e-android:space-room-order
```

Android CI shard 1 runs this batch after space creation/join curation and before
its unchanged Playwright shard. Provisional bounds are 15 minutes for the Node
test, 18 minutes for the resource-owning wrapper, 20 minutes for the CI command
and 120 minutes for the complete shard. Measured local and hosted runs must
establish that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.space-room-order/`.
`space-room-order/journeys.json` records both stage sources, first-attempt
outcomes and artifact pointers. Stage-local assertion records, screenshots and
the suite progress report retain observations, provenance and registered
cleanup. Acceptance remains pending until #696 records three complete first
attempts, effective preference/hierarchy/live-order fault controls, both
unchanged predecessors, required quality checks and original-attempt hosted
evidence. Computed menu-indicator styling, theme/font screenshots, desktop
keyboard activation, browser request interception and both header-geometry
definitions remain browser coverage; other Room Library definitions, physical
Android acceptance and the full migration reliability gate stay with their
existing owners.

## Room HTTP-error recovery functional batch

[Android room HTTP-error recovery](https://github.com/quwisky/trinity-matrix-client/issues/697)
owns the installed-Android functional guarantees in both definitions from
[Room HTTP error recovery](../browser/journeys/room-library/room-http-error-recovery.spec.mts),
lines 73–127 and 129–192 at `9aa0cfcd`. The pinned source SHA-256 is
`a9fd9a2f48a03061ceed67a94a2e81104472144683e65650099dba6074042fe6`.
`android.room-http-error-recovery` resets the installed app to the exact Pixel
5 profile for two mandatory stages. Both complete Playwright predecessors
remain enabled.

| Predecessor obligation                                                                                                               | Replacement assertion identities                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| An HTTP 503 invite failure shows exact guidance, releases the native invite action and lets a second request reach Synapse           | `invite.failure-feedback`, `invite.action-reenabled`, `invite.success-feedback`, `invite.two-transport-attempts`, `invite.real-membership`          |
| A visible invite survives an HTTP 502 join failure, releases the native accept action and lets a second request join through Synapse | `join.invite-visible`, `join.failure-feedback`, `join.action-reenabled`, `join.room-visible`, `join.two-transport-attempts`, `join.real-membership` |

These are exactly eleven direct assertions. Each stage uses fresh Accounts and
a real room. A test-owned persistent CDP `Fetch` session fulfills only the first
matching Matrix transport request with the pinned HTTP failure and continues
the second request to disposable Synapse. It cannot dispatch DOM events, focus
controls or navigate the product. Room selection, menus, picker entry, invite,
accept, retry and Android Back actions use measured native Maestro input;
WebView access is read-only observation. Matrix membership state proves the
successful retry changed the real server. Event subscription, controller,
page-session, client/device and room/account cleanup plus secret redaction
remain owned and abortable on every exit.

```bash
pnpm nx run trinity-e2e-android:room-http-error-recovery
```

Android CI shard 1 runs this batch after space room ordering and before its
unchanged Playwright shard. Provisional bounds are 15 minutes for the Node test,
18 minutes for the resource-owning wrapper, 20 minutes for the CI command and
120 minutes for the complete shard. Measured local and hosted runs must
establish that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-http-error-recovery/`.
`room-http-error-recovery/journeys.json` records both source mappings,
first-attempt outcomes and artifact pointers. Stage-local assertion and
transport records, screenshots and the suite progress report retain exact
request counts, membership proof, provenance and registered cleanup.
Acceptance remains pending until #697 records three complete first attempts,
effective invite-release/join-release/membership controls, both unchanged
predecessors, required quality checks and original-attempt hosted evidence.
Other request-interception definitions, unrelated Room Library definitions,
physical Android acceptance and the full migration reliability gate stay with
their existing owners.

## Mobile Room Settings functional batch

[Android mobile Room Settings](https://github.com/quwisky/trinity-matrix-client/issues/698)
owns the installed-Android functional guarantees in
[Room Settings · For you on a phone](../browser/journeys/room-administration/room-settings-for-you-mobile.spec.mts),
lines 18–115, and
[Room Settings on a phone](../browser/journeys/room-administration/room-settings-general-mobile.spec.mts),
lines 18–149, at `d976c05a`. Their pinned SHA-256 values are
`749dc05f43e01cfcc972bf639b8f83241ed3054220a32d8f32eb5be197cf62c0`
and `aec529aaa1769eddfa28f9f423d93825bb46ebd689e448036b1c168b5db3c310`.
`android.room-settings-mobile` resets the installed app to the exact Pixel 5
profile for two mandatory stages. Both complete Playwright predecessors remain
enabled.

| Predecessor obligation                                                                                                                                                         | Replacement assertion identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An ordinary member opens For you, stages Mute and Favourite, keeps both through the discard guard and saves them for the opening Account                                       | `for-you.settings-visible`, `for-you.directory-visible`, `for-you.form-visible`, `for-you.mute-enabled`, `for-you.favourite-enabled`, `for-you.mute-retained`, `for-you.favourite-retained`, `for-you.saved-feedback`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The full-screen directory opens before General, protects and discards a draft, preserves geometry and touch targets, navigates pristine Access and closes back to the composer | `general.settings-visible`, `general.full-width`, `general.full-height`, `general.directory-visible`, `general.panel-initially-hidden`, `general.panel-visible`, `general.heading-focused`, `general.account-contained`, `general.pristine-actions-hidden`, `general.draft-actions-visible`, `general.actions-sticky`, `general.discard-visible`, `general.save-visible`, `general.draft-retained`, `general.discard-directory-visible`, `general.room-name-contained`, `general-tab.touch-target`, `addresses-tab.touch-target`, `access.panel-visible`, `access.heading-focused`, `access.actions-hidden`, `access.back-directory-visible`, `general.reopened-visible`, `general.settings-closed`, `general.composer-visible` |

These are exactly thirty-three direct assertions. Fresh Accounts and real
private rooms establish ordinary-member and room-owner state through Matrix.
Room selection, overflow and settings controls, tabs, radio and checkbox,
textarea entry, guarded Back choices, save and close all use measured native
Maestro input. The owned WebView connection is read-only: it observes visible,
enabled, checked, focused and draft state plus viewport, containment, sticky
position and 44-pixel target geometry. Client/device cleanup and secret
redaction remain registered on every exit.

```bash
pnpm nx run trinity-e2e-android:room-settings-mobile
```

Android CI shard 4 runs this batch after Identity presence and before its
unchanged Playwright shard. Provisional bounds are 15 minutes for the Node test,
18 minutes for the resource-owning wrapper, 20 minutes for the CI command and
120 minutes for the complete shard. Measured local and hosted runs must
establish that these bounds fit the complete suite.

Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-settings-mobile/`.
`room-settings-mobile/journeys.json` records both stage sources, first-attempt
outcomes and artifact pointers. Stage-local assertion records and screenshots
retain the 33 observations, provenance and registered cleanup. Acceptance
remains pending until #698 records three complete first attempts, both unchanged
predecessors, required quality checks and original-attempt hosted evidence. The
widget iframe predecessor remains browser coverage; unrelated Room Settings,
physical Android acceptance and the full migration reliability gate stay with
their existing owners.

## Mobile Space Settings functional batch

[Android mobile Space Settings](https://github.com/quwisky/trinity-matrix-client/issues/699)
owns the installed-Android guarantees in
[Space settings on a phone](../browser/journeys/room-administration/space-settings-mobile.spec.mts),
definitions at lines 105–433, 435–471 and 473–536, at `27f09caf`. The pinned
source SHA-256 is
`fd8dcdd0305cdc1ffa2412cf61779c7775cfe7583563be801ba5be5342fdaaf4`.
`android.space-settings-mobile` resets the installed app to the exact Pixel 5
profile for three mandatory stages. The complete Playwright predecessor stays
enabled.

| Predecessor obligation                                                                                                                                                                                                      | Replacement assertion identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An opening admin traverses full-screen General, For you, Access and Contents; protects/discards drafts; preserves containment/focus/44px targets; adds, cancels and removes exact child Rooms; then closes back to the Room | `opening.composer-visible`, `settings.visible`, `settings.full-width`, `settings.full-height`, `directory.visible`, `general.initially-hidden`, `general.panel-visible`, `general.heading-focused`, `general.account-contained`, `general.pristine-actions-hidden`, `general.draft-actions-visible`, `general.actions-sticky`, `general.discard-visible`, `general.save-visible`, `general.draft-retained`, `general.discard-directory-visible`, `directory.space-name-contained`, `general-tab.touch-target`, `for-you-tab.touch-target`, `for-you.panel-visible`, `for-you.heading-focused`, `for-you.alphabetical-touch-target`, `for-you.alphabetical-retained`, `for-you.back-directory-visible`, `access-tab.touch-target`, `access.panel-visible`, `access.heading-focused`, `access.explainer-visible`, `access.actions-hidden`, `access.back-directory-visible`, `contents-tab.touch-target`, `contents.heading-focused`, `contents.room-visible`, `contents.create-room-touch-target`, `contents.create-room-contained`, `contents.suggested-touch-target`, `contents.suggested-checked`, `contents.move-up-touch-target`, `contents.move-up-disabled`, `contents.move-down-disabled`, `contents.suggested-cleared`, `contents.candidate-pick-visible`, `contents.add-selected-enabled`, `contents.candidate-visible`, `contents.candidate-link-created`, `contents.create-cancelled`, `contents.remove-cancel-retained`, `contents.candidate-link-removed`, `contents.candidate-membership-retained`, `contents.back-directory-visible`, `general.reopened-visible`, `settings.closed`, `space-pill.visible`, `room.composer-visible`, `room.heading-named` |
| The Space Members shortcut opens its detail directly and returns to focused directory navigation                                                                                                                            | `members.panel-visible`, `members.directory-hidden`, `members.heading-named`, `members.back-visible`, `members.directory-tab-visible`, `members.directory-tab-focused`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| An ordinary member reads exact General values as paragraph content without writable actions                                                                                                                                 | `readonly.name-visible`, `readonly.topic-visible`, `readonly.name-paragraph`, `readonly.topic-paragraph`, `readonly.actions-hidden`, `readonly.surface-visible`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

These are exactly sixty-seven direct assertions. Fresh Accounts, a real Space,
Rooms, child links and memberships establish state through Matrix. All product
navigation, form entry, radio/checkbox changes and dialog choices use measured
native Maestro input. Matrix reads observe persisted child and membership state;
the owned WebView connection only observes UI state and geometry. Client/device
cleanup and secret redaction remain registered on every exit.

```bash
pnpm nx run trinity-e2e-android:space-settings-mobile
```

Android CI shard 4 runs this batch after mobile Room Settings and before its
unchanged Playwright shard. Provisional bounds are 18 minutes for the Node test,
23 minutes for the resource-owning target, 25 minutes for the CI command and
120 minutes for the complete shard; measured runs must prove those bounds.
Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.space-settings-mobile/`.
`space-settings-mobile/journeys.json` records all stage sources, outcomes and
artifact pointers. Acceptance remains pending until #699 records three complete
first attempts, the unchanged predecessor, effective controls, quality checks
and original-attempt hosted evidence. Desktop/fault Space Settings, widget
iframes, physical Android acceptance and full migration reliability remain with
their existing owners.

## Space Settings resilience batch

[Android Space Settings resilience](https://github.com/quwisky/trinity-matrix-client/issues/700)
owns the installed-Android guarantees in
[Space Settings resilience](../browser/journeys/room-administration/space-settings-resilience.spec.mts),
including shared readiness at lines 69–82 and definitions at lines 88–143 and
145–305, on consolidated base `2042fc56`. The pinned source SHA-256 is
`97bf56cb47ac1f74911fa73df01d582f1cec4c37f8547e4d609f168fbb9a3091`.
`android.space-settings-resilience` resets the installed app to the exact Pixel
5 profile for two mandatory stages. The complete Playwright predecessor stays
enabled.

| Predecessor obligation                                                                                                                                                 | Replacement assertion identities                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| General saves the valid name through an exact first-topic 500 response, reports the partial failure, and retries only the unsaved topic                                | `partial.failure-feedback`, `partial.name-first-attempts`, `partial.topic-first-attempts`, `partial.retry-feedback`, `partial.name-total-attempts`, `partial.topic-total-attempts`                                                                                                                                                                           |
| An in-flight name save and all later General, address, invite and child-link writes remain on the opening owner after the active Account changes to an ordinary member | `continuity.opening-account`, `continuity.name-saving`, `continuity.active-member`, `continuity.account-retained`, `continuity.name-saved`, `continuity.topic-saved`, `continuity.topic-persisted`, `continuity.alias-visible`, `continuity.alias-resolves`, `continuity.invite-persisted`, `continuity.child-link-created`, `continuity.child-link-removed` |

These are exactly eighteen direct assertions. Fresh Accounts, a shared Space,
an exact candidate child Space and invitation/membership state are seeded through
Matrix. Login, Account addition and opening-owner selection, Space/settings
entry, General edits/save/retry, Addresses, Members invite, Contents add/remove
and confirmation use native Android input. Server-side reads prove the exact
persisted topic, alias, membership and child state.

The predecessor's pointer-blocked Account transition at lines 199–205 is the
single CDP user-action exception: the source-pinned helper invokes only the
exact user-menu and target Account-row click handlers, then separately proves
that the active Account changed. All other WebView/CDP access is observational;
it does not focus, fill, dispatch product events, mutate application state or
styles, or navigate. The exact room-state transport controller counts the name
and topic writes, injects the first topic's precise 500 payload, and holds then
releases the opening owner's name request. Pending requests, interception,
client/device state and secrets are cleaned on every exit.

```bash
pnpm nx run trinity-e2e-android:space-settings-resilience
```

Android CI shard 4 runs this batch after mobile Space Settings and before its
unchanged Playwright shard. Provisional bounds are 18 minutes for the Node test,
23 minutes for the resource-owning target, 25 minutes for the CI command and
120 minutes for the complete shard; measured runs must prove those bounds.
Started-suite diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.space-settings-resilience/`.
`space-settings-resilience/journeys.json` records both stage sources, outcomes
and artifact pointers. Acceptance remains pending until #700 records three
complete first attempts, both unchanged predecessor definitions, deliberate
controls, quality checks and original-attempt hosted evidence. The seven core
Space Settings definitions, member/address layout, widget iframe coverage,
physical Android acceptance and complete migration reliability stay with their
existing owners.

## Core Space Settings administration batch

[Android core Space Settings](https://github.com/quwisky/trinity-matrix-client/issues/701)
owns all seven definitions and 85 direct assertions in
[Space Settings](../browser/journeys/room-administration/space-settings.spec.mts),
pinned to consolidated base `cb8959d70f9e5c1b61e651bb2048f17a0b66ff9e` and source
SHA-256 `662f0fc7c62ba206aa1bd344c1d9ecf913162424c486b97059d252ff7ea30a3a`.
Shared Matrix, readiness and navigation helpers occupy lines 29–181. All seven
Playwright predecessors remain enabled with their assertions unchanged.

`android.space-settings-core` runs the following stages sequentially in one
invocation, using one installed debug APK built from the verified production
renderer. Every stage clears app data and resets its declared desktop profile
(1280 × 720, scale 1, no mobile/touch emulation) before login. Native input still
acts on the installed Android host. The first stage temporarily resizes to
700 × 800 and restores the original profile before continuing.

| Stage                      | Source lines | Direct assertions |
| -------------------------- | ------------ | ----------------- |
| `admin-general-and-access` | 186–360      | 21                |
| `seeded-values`            | 362–411      | 3                 |
| `exact-contents-lifecycle` | 413–670      | 33                |
| `readonly-member`          | 672–775      | 13                |
| `permission-loss-draft`    | 777–851      | 7                 |
| `address-via-enter`        | 853–904      | 4                 |
| `owner-admin-roster`       | 906–1000     | 4                 |

The exact replacement identities are centralized in
`space-settings-core-contract.mts` and grouped below by source stage:

- Administration: `admin.conversation-visible`, `admin.conversation-heading`,
  `admin.name-field-visible`, `admin.directory-visible`, `admin.account-owner`,
  `admin.heading-focused`, `admin.desktop-width`, `admin.compact-directory-hidden`,
  `admin.compact-back-visible`, `admin.desktop-directory-restored`,
  `admin.scaled-cancel-visible`, `admin.scaled-actions-hidden`,
  `admin.photo-feedback`, `admin.photo-persisted`, `admin.general-feedback`,
  `admin.name-persisted`, `admin.topic-persisted`, `admin.join-rule-persisted`,
  `admin.dialog-closed`, `admin.conversation-retained`, `admin.heading-retained`.
- Seeded values: `seed.name`, `seed.topic`, `seed.join-rule`.
- Contents: `contents.panel-visible`, `contents.linked-name`,
  `contents.linked-type-room`, `contents.scaled-create-space-visible`,
  `contents.scaled-no-overflow`, `contents.candidate-room-linked`,
  `contents.candidate-space-linked`, `contents.created-space-linked`,
  `contents.created-space-type`, `contents.recovery-visible`,
  `contents.recovery-name`, `contents.recovered-id`, `contents.create-first-count`,
  `contents.recovery-dismissed`, `contents.recovered-linked`,
  `contents.create-retry-count`, `contents.no-child-parent-governance`,
  `contents.remove-room-name`, `contents.remove-room-parent-name`,
  `contents.remove-room-not-deleted`, `contents.cancel-keeps-room-linked`,
  `contents.room-unlinked`, `contents.room-membership-retained`,
  `contents.remove-space-name`, `contents.remove-space-parent-name`,
  `contents.space-unlinked`, `contents.space-membership-retained`,
  `contents.demote-write`, `contents.actions-hidden`,
  `contents.candidate-space-visible`, `contents.unlink-hidden`,
  `contents.suggest-hidden`, `contents.move-up-hidden`.
- Readonly membership: `readonly.name`, `readonly.no-topic`,
  `readonly.name-paragraph`, `readonly.topic-paragraph`,
  `readonly.general-actions-hidden`, `readonly.join-rule-disabled`,
  `readonly.permission-explanation`, `readonly.access-policy`,
  `readonly.access-actions-hidden`, `readonly.child-visible`,
  `readonly.contents-actions-hidden`, `readonly.unlink-hidden`,
  `readonly.contents-explanation`.
- Permission loss: `permission.topic-editable`, `permission.actions-visible`,
  `permission.topic-readonly`, `permission.draft-retained`,
  `permission.draft-explanation`, `permission.discard-visible`,
  `permission.save-disabled`.
- Addresses: `address.panel-visible`, `address.dialog-retained`,
  `address.visible`, `address.resolves`.
- Members: `members.dialog-visible`, `members.heading`, `members.owner-row`,
  `members.admin-row`.

Login, Space/settings navigation, edits, save/cancel, join-rule selection,
contents linking/creation/removal, recovery retry and dialog confirmation use
native Maestro taps and text input. Photo upload uses Android DocumentsUI to
choose the exact pushed `space-photo.png`; address creation uses native Android
Enter. WebView/CDP reads observe visible DOM, focus, geometry and values. They
do not click, focus, fill, submit forms, dispatch product events, change history
or location, or replace native document selection. The only style mutation is
the source-pinned visual fixture for root font size `125%` and root theme/dark
state; it restores those values on every exit. Viewport emulation is scoped to
the declared profile and the source's compact-layout check.

Finite Matrix fixtures seed Accounts, Spaces, rooms, membership, existing state
and power levels. Server reads prove persisted avatar, name, topic, join rules,
exact child links, retained membership, alias resolution and roster powers. The
contents transport fixture fails only the opening parent's first nonempty keyed
`m.space.child` write with HTTP 403 and `link rejected`. It separately counts
`POST /createRoom`, proving that retry links the recovered room ID without a
second room creation or child-parent governance. Cleanup discovers UI-created
joined rooms even if an assertion fails before their IDs are observed, then
leaves/forgets memberships and logs out the fixture sessions.

```bash
pnpm nx run trinity-e2e-android:space-settings-core --skipNxCache
# Equivalent package command:
pnpm e2e:android:space-settings-core
```

The target is uncached and serial, depends on `trinity-android:build-prebuilt`,
and owns `android-avd` and `synapse` through the existing Node invocation. It
verifies the renderer manifest before and after Capacitor copies the renderer
into Android assets and before the Node test starts. Android CI shard 2 starts
this batch after `native-shell` and before the retained
`pnpm e2e:android --` Playwright command. Its single `android-space-settings-core`
diagnostic upload runs only after the suite's started marker, including ordinary
failures. The existing Playwright command and diagnostics remain unchanged.

Diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.space-settings-core/`.
`space-settings-core/journeys.json` records the expected seven stages and 85
assertions, each source span, running and terminal transitions, duration,
failure count and artifact pointer. Per-identity JSON observations, native
command records and pass/failure captures accompany it. WebView and device
cleanup, transport release, secret redaction and invocation teardown run on
success, failure and interruption; cleanup failures remain part of the failed
result.

Hosted run `34784705746` completed the first six stages in 27 minutes 41 seconds,
then reached `owner-admin-roster` and hit the original 30-minute Node-test bound
while that final stage was still making native progress. The evidence raised the
nested hang-containment bounds to 40 minutes for the Node test, 42 minutes for
its resource wrapper and 45 minutes for the hosted command; the complete shard
retains its 120-minute ceiling, and the suite remains inside the registry's
60-minute host budget. Acceptance requires three complete
first attempts with seven passed stages, all 85 assertion identities, zero
retries, completed native commands, exact profile/renderer/APK provenance,
redacted diagnostics and clean Synapse/device teardown. Deliberate failing
controls must prove the source hash, assertion inventory, keyed fault target,
DocumentsUI filename, persisted Matrix state and redaction/cleanup boundaries.
The unchanged seven-definition Playwright source, required quality gates and
original-attempt green browser and Android shard-2 jobs with an audited immutable
artifact are also required. Static integration checks alone do not establish
installed-host parity or authorize predecessor retirement.

## Space leave batch

[Android Space leave](https://github.com/quwisky/trinity-matrix-client/issues/706)
owns the single definition and all seven direct assertions in
[Space leave](../browser/journeys/room-administration/space-leave.spec.mts),
pinned to consolidated base `b23a2474eb366c1d714f8a8d20f1563242003678`
and source SHA-256
`a895c51a4a586f80d1399c31d1a3780d0c20c42534c926e9e53cf41f3fe8ed54`.
The shared token/menu/membership helpers occupy lines 17–53 and the definition
occupies lines 58–125. The Playwright predecessor remains enabled and unchanged.

`android.space-leave` resets one installed Android invocation to the exact Pixel
5 profile. A fresh Account, private Space, private child Room and suggested
`m.space.child` link are seeded through finite Matrix fixtures. Login, Space-pill
selection, overflow, Leave, Cancel and confirmed Leave use measured Maestro
native input. WebView/CDP access is read-only observation and coordinate
measurement; it does not click, focus, fill, submit forms, dispatch product
events, mutate application state or styles, or navigate. Finite Matrix
`joined_rooms` reads prove both memberships survive cancellation, the Space is
left after confirmation and the child Room remains joined.

| Predecessor obligation                                    | Replacement assertion identity      |
| --------------------------------------------------------- | ----------------------------------- |
| Confirmation names the exact Space                        | `dialog.space-name`                 |
| Confirmation names the exact Account                      | `dialog.account-name`               |
| Confirmation explains that child Room memberships remain | `dialog.child-membership-copy`      |
| Cancel retains both Space and child Room memberships      | `cancel.memberships-retained`       |
| Cancel leaves the exact Space pill visible                | `cancel.space-pill-visible`         |
| Confirm removes the Space from joined rooms               | `confirm.space-left`                |
| Confirm retains the child Room in joined rooms            | `confirm.child-membership-retained` |

```bash
pnpm nx run trinity-e2e-android:space-leave --skipNxCache
# Equivalent package command:
pnpm e2e:android:space-leave
```

The target is uncached and serial, depends on `trinity-android:build-prebuilt`,
and owns `android-avd` and `synapse` through the Node invocation. Its provisional
bounds are 15 minutes for the Node test, 18 minutes for the resource-owning
target and 20 minutes for the hosted command. Android CI shard 2 runs it after
`space-settings-core` and before retained Playwright. Started-only diagnostics
live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.space-leave/`; the
`space-leave/journeys.json` lifecycle records its source, running and terminal
state, duration, failure count and artifact pointer, accompanied by seven
per-identity records, native-command evidence, renderer/APK/profile provenance
and pass/failure captures. Device, WebView, Matrix and secret-redaction cleanup
run on every exit.

Acceptance remains pending until #706 records three complete unchanged-input
native first attempts, the unchanged predecessor, at least four effective
failing controls, all required static gates, and original-attempt green browser
and Android shard-2 hosted jobs with an audited immutable artifact. This mapping
does not authorize predecessor retirement.

## Room tombstone batch

[Android Room tombstone](https://github.com/quwisky/trinity-matrix-client/issues/707)
owns the single definition and all six direct assertions in
[Room tombstone](../browser/journeys/room-administration/tombstone.spec.mts),
pinned to consolidated base `f46e2751da6bfa3ff784f253da1360491e28e53d`
and source SHA-256
`ca5563f9d5a4f84db23d7fb7a889da28682fffabf3dedd3b42b2f529d936472b`.
The shared room-opening helper occupies lines 15–23 and the definition occupies
lines 28–113. The Playwright predecessor remains enabled and unchanged.

`android.room-tombstone` resets one installed Android invocation to the exact
Pixel 5 profile. A fresh Account and distinctly named old and successor private
Rooms are seeded through finite Matrix fixtures; the old Room receives the exact
`m.room.tombstone` body and successor ID. Login, Rooms-rail selection, old-Room
selection and successor activation use measured Maestro native input. WebView/CDP
access is read-only observation and coordinate measurement; it does not click,
focus, fill, submit forms, dispatch product events, mutate application state or
styles, or navigate.

| Predecessor obligation                         | Replacement assertion identity |
| ---------------------------------------------- | ------------------------------ |
| Old Room composer is visible                   | `old.composer-visible`         |
| Old Room upgrade banner is visible             | `old.banner-visible`           |
| Banner is outside and above the chat row       | `layout.banner-above-chat-row` |
| Timeline retains more than half the chat width | `layout.timeline-share`        |
| Successor Room has no tombstone banner         | `successor.banner-hidden`      |
| Successor Room composer remains visible        | `successor.composer-visible`   |

```bash
pnpm nx run trinity-e2e-android:room-tombstone --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-tombstone
```

The target is uncached and serial, depends on `trinity-android:build-prebuilt`,
and owns `android-avd` and `synapse` through the Node invocation. Its provisional
bounds are 15 minutes for the Node test, 18 minutes for the resource-owning
target and 20 minutes for the hosted command. Android CI shard 2 runs it after
`space-leave` and before retained Playwright. Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-tombstone/`; the
`room-tombstone/journeys.json` lifecycle records its source, running and terminal
state, duration, failure count and artifact pointer, accompanied by six
per-identity records, native-command evidence, renderer/APK/profile provenance
and pass/failure captures. Device, WebView, Matrix and secret-redaction cleanup
run on every exit.

Acceptance remains pending until #707 records three complete unchanged-input
native first attempts, the unchanged predecessor, at least four effective
failing controls, all required static gates, and original-attempt green browser
and Android shard-2 hosted jobs with an audited immutable artifact. This mapping
does not authorize predecessor retirement.

## Message moderation batch

[Android message reporting and moderator redaction](https://github.com/quwisky/trinity-matrix-client/issues/708)
owns two definitions and all five direct assertions in
[Report message](../browser/journeys/room-administration/report-message.spec.mts)
and
[Redact others](../browser/journeys/room-administration/redact-others.spec.mts),
pinned to consolidated base `b667802795d7cd7fd19cc99292ee1d8e30eaf4e1`.
The report source SHA-256 is
`3f8e9051936b66e5b6ab1112d52f29f95826866bc4277e7ba6d5bdd9ca312b7c`
(helper lines 19–25, definition lines 30–80). The redaction source SHA-256 is
`b7bb891ccdde3bb829044b6378247971555be539a6a8cd190f7ace323fa78b57`
(helper lines 57–63, definition lines 68–143). Both Playwright predecessors
remain enabled and unchanged.

`android.message-moderation` resets one installed Android invocation to the
exact Pixel 5 profile for each of two stages. Finite Matrix fixtures create the
fresh accounts and unencrypted Rooms, invite and join the member, and seed the
source messages. Login, Rooms and Room selection, message-row long press, sheet
action selection and confirmation use measured Maestro native input. The long
press resolves a blank point inside the exact message row, outside rendered text
and interactive/media rectangles, then executes a 750 ms near-static Maestro
swipe with trusted pointer-duration proof. This prevents Android text selection
from competing with Trinity's 500 ms row gesture. WebView/CDP access is read-only
observation and coordinate measurement; it does not click, focus, fill, submit
forms, dispatch product events, mutate application state or styles, or navigate.

| Predecessor obligation                | Replacement assertion identity       |
| ------------------------------------- | ------------------------------------ |
| Report Room timeline is visible       | `report.timeline-visible`            |
| Exact report-success toast is visible | `report.success-toast-visible`       |
| Redaction Room timeline is visible    | `redact.timeline-visible`            |
| Deleted-message marker is visible     | `redact.deleted-marker-visible`      |
| Original member message body is absent | `redact.original-body-absent`       |

```bash
pnpm nx run trinity-e2e-android:message-moderation --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-moderation
```

The target is uncached and serial, depends on `trinity-android:build-prebuilt`,
and owns `android-avd` and `synapse` through the Node invocation. Its provisional
bounds are 20 minutes for the Node test, 23 minutes for the resource-owning
target and 25 minutes for the hosted command. Android CI shard 3 runs it after
`accounts-workspace` and before retained Playwright. Started-only diagnostics
live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.message-moderation/`;
`message-moderation/journeys.json` records both stages, source, running and
terminal state, duration, failure count and artifact pointer, accompanied by
five per-identity records, native-command evidence, renderer/APK/profile
provenance and pass/failure captures. Device, WebView, Matrix and
secret-redaction cleanup run on every exit.

Acceptance remains pending until #708 records three complete unchanged-input
native first attempts, both unchanged predecessors, at least four effective
failing controls, all required static gates, original-attempt green Android
hosted evidence, exact hosted predecessor passes and an audited immutable
artifact. This mapping does not authorize predecessor retirement.

## Member moderation batch

[Android member Block, Kick, and Ban](https://github.com/quwisky/trinity-matrix-client/issues/709)
owns the three Android-applicable definitions and all 22 direct assertion sites
in
[Block member](../browser/journeys/room-administration/block-member.spec.mts)
and
[Kick/Ban member](../browser/journeys/room-administration/kick-member.spec.mts),
pinned to consolidated base `1610f3ca0872e8144be657b63d0e183b0a1284b0`.
The Block source SHA-256 is
`792a6e1d021c5e09661c5847e4fb577044cab1635673151cefd026cf57acfa84`
(helper lines 47–55, definition lines 60–123). The generated Kick/Ban source
SHA-256 is
`e7ab22e420abf9f545c7ad1bb9b637b435cbc9a754759167070ebb38550d2a86`
(helper lines 68–76, generator lines 81–94, generated definitions lines
95–165). Its stale-roster fault at lines 168–291 remains browser-owned because
it requires Angular development hooks unavailable in the production APK. All
Playwright predecessors remain enabled and unchanged.

`android.member-moderation` resets one installed Android invocation to the
exact Pixel 5 profile for each of three stages. Finite Matrix fixtures create
fresh admin/member accounts and invited private Rooms, set the target display
name, and join the lower-power member. Login, Rooms and Room selection, compact
overflow/Members navigation, member selection, moderation activation, and
confirmation use measured Maestro native input. WebView/CDP access is read-only
observation and coordinate measurement; it does not click, focus, fill, submit
forms, dispatch product events, mutate application state or styles, or navigate.

| Predecessor obligation                    | Replacement assertion identity       |
| ----------------------------------------- | ------------------------------------ |
| Block Room timeline is visible            | `block.room-timeline-visible`        |
| Block member list starts hidden           | `block.members-initially-hidden`     |
| Block member list opens visibly           | `block.members-panel-visible`        |
| Block member info is visible              | `block.member-info-visible`          |
| Initial Block action is visible           | `block.action-block-visible`         |
| Account-data round trip shows Unblock     | `block.action-unblock-visible`       |
| Kick Room timeline is visible             | `kick.room-timeline-visible`         |
| Kick member list starts hidden            | `kick.members-initially-hidden`      |
| Kick member list opens visibly            | `kick.members-panel-visible`         |
| Kick member info is visible               | `kick.member-info-visible`           |
| Kick closes member info                   | `kick.member-info-closed`            |
| Kick restores the visible roster          | `kick.roster-visible`                |
| Kicked target row is absent               | `kick.member-row-absent`             |
| Kicked target has Matrix membership leave | `kick.server-membership`             |
| Ban Room timeline is visible              | `ban.room-timeline-visible`          |
| Ban member list starts hidden             | `ban.members-initially-hidden`       |
| Ban member list opens visibly             | `ban.members-panel-visible`          |
| Ban member info is visible                | `ban.member-info-visible`            |
| Ban closes member info                    | `ban.member-info-closed`             |
| Ban restores the visible roster           | `ban.roster-visible`                 |
| Banned target row is absent               | `ban.member-row-absent`              |
| Banned target has Matrix membership ban   | `ban.server-membership`              |

```bash
pnpm nx run trinity-e2e-android:member-moderation --skipNxCache
# Equivalent package command:
pnpm e2e:android:member-moderation
```

The target is uncached and serial, depends on `trinity-android:build-prebuilt`,
and owns `android-avd` and `synapse` through the Node invocation. Its
provisional bounds are 25 minutes for the Node test, 28 minutes for the
resource-owning target and 30 minutes for the hosted command. Android CI shard 3
runs it after `message-moderation` and before retained Playwright. Started-only
diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.member-moderation/`;
`member-moderation/journeys.json` records all three stages, source, running and
terminal state, duration, failure count and artifact pointer, accompanied by 22
per-identity records, native-command evidence, renderer/APK/profile provenance
and pass/failure captures. Device, WebView, Matrix and secret-redaction cleanup
run on every exit.

Accepted on hosted run `34867886690` at source head `6fd03a32` (hosted merge
`5d022ff3`). Android shard 3 passed on attempt 1. Immutable artifact
`10362633783` records one suite attempt, zero retries, all three stages and 22
identities passed, 172/172 completed Maestro commands, native Block/Kick/Ban and
confirmation actions, exact `leave`/`ban` server memberships, verified
renderer/installed-package/Pixel 5 provenance, no bearer/password findings, and
complete Synapse teardown. Browser artifact `10358997011` records all three
exact predecessors and the browser-owned stale-roster case passed at retry 0.
Together with three complete unchanged-input local native first attempts, all
three unchanged local predecessors, five effective failing controls, the full
static gates, and an independent review with no unresolved findings, this
accepts #709. The Playwright predecessors remain enabled; this mapping does not
authorize their retirement or claim the browser-only stale-roster fault.

## Member details and promotion batch

[Android member details and promotion](https://github.com/quwisky/trinity-matrix-client/issues/710)
owns two Android-applicable definitions and all 25 direct assertion sites in
[Member info](../browser/journeys/room-administration/member-info.spec.mts) and
[Promote member](../browser/journeys/room-administration/promote-member.spec.mts),
pinned to consolidated base `02de1669419235fdeff4b0614f00ee1e5b2af862`.
The member-info source SHA-256 is
`cca86e8d3c5925ff2358e6efbcf229ca4f32095379385d9539698dedd1c2200d`
(Room helper lines 49–57, Members helper lines 59–68, definition lines 73–218).
The promotion source SHA-256 is
`649c05090a92bf48036530ea3738c55ad40f0ebc06a0200745e48b3b6903f7c3`
(Room helper lines 49–57, definition lines 62–134). Both Playwright
predecessors remain enabled and unchanged.

`android.member-details-promotion` resets one installed Android invocation to
the exact Pixel 5 profile for each of two stages. Finite Matrix fixtures create
fresh admin/member accounts and invited private Rooms, set the target display
name, and join the lower-power member. Login, Rooms and Room selection, compact
overflow/Members navigation, member selection, Copy user ID, panel and drawer
close, composer focus, clipboard paste, role selection, and confirmation use
measured Maestro native input. The paste flow consumes the current foreground
Android clipboard and never uses `setClipboard` or a DOM probe. WebView/CDP is
limited to read-only observation and coordinate measurement; it does not click,
focus, fill, dispatch product events, submit forms, navigate, inject DOM, or
mutate application state or styles.

| Predecessor obligation                           | Replacement assertion identity              |
| ------------------------------------------------ | ------------------------------------------- |
| Member-info Room timeline is visible             | `member-info.room-timeline-visible`         |
| Member-info roster opens visibly                 | `member-info.members-panel-visible`         |
| Member-info roster starts hidden                 | `member-info.members-initially-hidden`      |
| Target member row is exactly 44 px                | `member-info.row-height`                    |
| Roster section header is exactly 34 px            | `member-info.header-height`                 |
| Member-info panel is visible                     | `member-info.panel-visible`                 |
| Exact display name is shown                      | `member-info.name`                          |
| Exact Matrix user ID is shown                    | `member-info.handle`                        |
| Member role is shown                             | `member-info.role`                          |
| Message action is visible                        | `member-info.message-action-visible`        |
| Panel host uses flex layout                      | `member-info.surface-display`               |
| Panel host paints an opaque background           | `member-info.surface-opaque`                |
| Shared chat row has positive height              | `member-info.surface-row-positive`          |
| Compact drawer matches the viewport within one pixel | `member-info.surface-full-height`        |
| Exact copy-success toast is visible              | `member-info.copy-toast`                    |
| Native paste yields the exact target MXID        | `member-info.clipboard-mxid`                |
| Closing hides member info                        | `member-info.panel-closed`                  |
| Closing restores the visible roster              | `member-info.roster-restored`               |
| Promotion Room timeline is visible               | `promotion.room-timeline-visible`           |
| Promotion roster starts hidden                   | `promotion.members-initially-hidden`        |
| Promotion roster opens visibly                   | `promotion.members-panel-visible`           |
| Moderator section is initially absent            | `promotion.moderator-absent`                |
| Promotion member-info panel is visible           | `promotion.member-info-visible`             |
| Moderator section becomes visible                | `promotion.moderator-section-visible`       |
| Target is regrouped and has exact server power 50 | `promotion.member-row-and-server-power`     |

```bash
pnpm nx run trinity-e2e-android:member-details-promotion --skipNxCache
# Equivalent package command:
pnpm e2e:android:member-details-promotion
```

The target is uncached and serial, depends on `trinity-android:build-prebuilt`,
and owns `android-avd` and `synapse` through the Node invocation. Its provisional
bounds are 20 minutes for the Node test, 23 minutes for the resource-owning
target, and 25 minutes for the hosted command. Android CI shard 2 runs it after
`room-tombstone` and before retained Playwright. Started-only diagnostics live
under
`dist/.playwright/trinity-e2e-android/<run-id>/android.member-details-promotion/`;
`member-details-promotion/journeys.json` records both stages, source, running and
terminal state, duration, failure count and artifact pointer, accompanied by 25
per-identity records, completed native-command evidence, renderer/APK/Pixel 5
provenance, exact Matrix power evidence, and pass/failure captures. Device,
WebView, Matrix and secret-redaction cleanup run on every exit.

Acceptance completed on hosted run `34888697076`, Android shard-2 job
`104126448383`, from merge commit
`e0f9545eedbbf273c36942ea54862a9815d9f702`. The original owned attempt passed
with zero retries: both native stages and both exact Playwright predecessors were
green. Its immutable artifact contains all 25 assertion identities, 27 native
command files with 136 completed entries, exact clipboard MXID and server power
50 observations, 34 px section-header and 44 px member-row geometry, Pixel 5 and
renderer/APK provenance, redacted secrets, and clean teardown. The renderer tree
matches the hosted merge tree exactly. Unrelated aggregate-shard execution is
tracked separately and does not change this owned-suite acceptance. This mapping
does not authorize predecessor retirement.

## Member role classification batch

[Android member role classification](https://github.com/quwisky/trinity-matrix-client/issues/711)
owns the shared open-Room helper and four Android-applicable definitions in
[Member role sections](../browser/journeys/room-administration/member-roles.spec.mts),
pinned to consolidated base `d45ae933d41687f5b0b52ca36f9ac80cbbb9b931`
and source SHA-256
`58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f`.
The shared helper spans lines 173–193; the grouping, trusted-DM, owner-panel,
and owner/admin definitions span lines 205–281, 283–361, 363–393 and 395–433.
Together they contain exactly 27 unique source assertion sites: three shared
helper sites plus 24 direct sites. The four Playwright predecessors remain
enabled and unchanged.

`android.member-role-classification` resets one installed Android invocation to
the exact Pixel 5 profile for each of four stages. Finite Matrix fixtures create
fresh accounts and Rooms, set display names before membership events, join all
participants, and assign exact 100/50/0 powers. The direct-message stage uses a
real `trusted_private_chat` and publishes `m.direct`, preserving the canonical
equal-admin case. Login, Rooms and Room selection, compact overflow/Members
navigation, and member-row selection use measured Maestro native input.
WebView/CDP is limited to read-only observation and coordinate measurement; it
does not click, focus, fill, dispatch product events, submit forms, navigate,
inject DOM, or mutate application state or styles.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Shared Room timeline is visible | `open-members.room-timeline-visible` |
| Shared roster starts hidden | `open-members.roster-initially-hidden` |
| Shared roster opens visibly | `open-members.roster-visible` |
| Grouping has exactly three member rows | `grouping.member-count` |
| Grouping labels are ordered Owner / Moderator / Member | `grouping.section-labels` |
| All grouping headers are exactly 34 px | `grouping.header-heights` |
| All grouping rows are exactly 44 px | `grouping.row-heights` |
| All three section accessibility names are exact | `grouping.group-labels` |
| The creator is in Owner | `grouping.owner-member` |
| The power-50 participant is in Moderator | `grouping.moderator-member` |
| The power-0 participant is in Member | `grouping.plain-member` |
| Moderator row shows the exact display name | `grouping.moderator-name` |
| DM Room timeline is visible | `direct-message.room-timeline-visible` |
| DM roster starts hidden | `direct-message.roster-initially-hidden` |
| DM roster opens visibly | `direct-message.roster-visible` |
| DM has exactly two member rows | `direct-message.member-count` |
| DM renders one exact `Admin — 2` section | `direct-message.admin-section` |
| DM renders no Owner section | `direct-message.owner-absent` |
| DM member-info panel opens visibly | `direct-message.panel-visible` |
| DM member-info role is exactly Admin | `direct-message.role-admin` |
| Owner-panel Room has exactly two rows | `owner-panel.member-count` |
| Creator member-info panel opens visibly | `owner-panel.panel-visible` |
| Creator member-info role is exactly Owner | `owner-panel.role-owner` |
| Owner/admin Room has exactly two rows | `owner-admin.member-count` |
| Owner/admin labels are ordered Owner then Admin | `owner-admin.section-labels` |
| Creator appears in the Owner section | `owner-admin.owner-member` |
| Power-100 peer appears in the Admin section | `owner-admin.admin-member` |

```bash
pnpm nx run trinity-e2e-android:member-role-classification --skipNxCache
# Equivalent package command:
pnpm e2e:android:member-role-classification
```

The target is uncached and serial, depends on `trinity-android:build-prebuilt`,
and owns `android-avd` and `synapse` through the Node invocation. Its provisional
bounds are 30 minutes for the Node test, 33 minutes for the resource-owning
target, and 35 minutes for the hosted command. Android CI shard 2 runs it after
`member-details-promotion` and before retained Playwright. Started-only
diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.member-role-classification/`;
`member-role-classification/journeys.json` records all four stages, source,
running and terminal state, duration, failure count and artifact pointer. The
artifact contains all 27 unique identities and 33 stage-local assertion records
because the three shared helper identities are exercised in all three
applicable ordinary-Room stages. Completed native-command evidence,
renderer/APK/Pixel 5 provenance, pass/failure captures, and device, WebView,
Matrix and secret-redaction cleanup are retained on every exit.

Acceptance completed on original-attempt hosted run
[34900885420](https://github.com/quwisky/trinity-matrix-client/actions/runs/34900885420).
Android shard 2 passed from exact source head
`4f8e1a99884acbd1389a69b0f8235b2af4a7846d` through hosted merge
`c441d7d542d2d36bf2124586f8aa31d879c99cc1`. Immutable
[artifact 10374106048](https://github.com/quwisky/trinity-matrix-client/actions/runs/34900885420/artifacts/10374106048)
contains four passed stages, one attempt, zero retries, all 33 stage-local
records / 27 unique identities, 37 native-command files / 181 completed Maestro
entries, zero failed-command or secret-field findings, exact Owner/Admin/
Moderator/Member classification, 34 px section headers, 44 px member rows,
Pixel 5 viewport and installed-package evidence, pass captures, and clean
Synapse teardown. The same run's immutable
[browser artifact 10371646373](https://github.com/quwisky/trinity-matrix-client/actions/runs/34900885420/artifacts/10371646373)
records all four exact predecessors passed at retry 0. The verified production
renderer contains 49 files / 15,302,528 bytes and matches the hosted merge.
Together with the three unchanged local native passes, five effective failing
controls, static gates, and independent review, this completes #711 without
authorizing predecessor retirement.

### Member role live updates batch

[Android member role live updates](https://github.com/quwisky/trinity-matrix-client/issues/712)
owns four Android-applicable definitions in
[Member role sections](../browser/journeys/room-administration/member-roles.spec.mts),
pinned to consolidated base `4f8e1a99884acbd1389a69b0f8235b2af4a7846d`
and source SHA-256
`58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f`.
The definitions span lines 435–480, 482–543, 545–583 and 590–626 and own
exactly 25 direct assertion sites. The shared helper at lines 173–193 remains
owned by #711; this batch imports its three identities as runtime prerequisites
without reclaiming them. All four Playwright predecessors remain enabled and
unchanged.

`android.member-role-live-updates` resets one installed Android invocation to
the exact Pixel 5 profile for each of four stages. Finite Matrix fixtures keep
the member roster or settings surface open while server-side power events apply
the predecessor's exact invite threshold of 50 and the exact 0→50 promotion or
100→0 viewer demotion. Login, Room selection,
compact overflow/Members and settings navigation, row selection, hardware Back,
focus traversal, Enter, Space and touch use measured Maestro-native input. WebView/CDP
is limited to read-only observation and coordinate measurement; it does not
click, focus, fill, dispatch product events, navigate, inject DOM, or mutate
application state or styles.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Two live-promotion member rows | `live-promotion.member-count` |
| Initial Owner / Member labels | `live-promotion.initial-section-labels` |
| Final Owner / Moderator labels | `live-promotion.final-section-labels` |
| Promoted member moves to Moderator | `live-promotion.moderator-member` |
| Kick begins enabled | `permission-loss.kick-initially-enabled` |
| Kick disables live | `permission-loss.kick-disabled` |
| Kick description is exact | `permission-loss.kick-description` |
| Focused Kick tooltip is exact | `permission-loss.tooltip` |
| Enter and Space open no removal dialog | `permission-loss.remove-dialog-absent` |
| Compact Invite disables live | `permission-loss.invite-disabled` |
| Enter and Space open no invite dialog | `permission-loss.invite-dialog-absent` |
| Room Settings opens | `settings-demotion.surface-visible` |
| Name begins enabled | `settings-demotion.name-initially-enabled` |
| Demoted name text is exact | `settings-demotion.name-text` |
| Demoted name renders as a paragraph | `settings-demotion.name-paragraph` |
| General mutation actions are absent | `settings-demotion.general-actions-absent` |
| Address restriction copy is exact | `settings-demotion.aliases-read-only` |
| Alias input is absent | `settings-demotion.alias-input-absent` |
| Alias add is absent | `settings-demotion.alias-add-absent` |
| Alias set-main is absent | `settings-demotion.alias-set-main-absent` |
| Alias remove is absent | `settings-demotion.alias-remove-absent` |
| Touch-stage Kick is disabled | `touch-feedback.kick-disabled` |
| Touch-stage Kick remains visible | `touch-feedback.kick-visible` |
| Blocked-touch feedback is exact | `touch-feedback.exact-copy` |
| Blocked touch opens no removal dialog | `touch-feedback.remove-dialog-absent` |

Every stage also records the inherited
`open-members.room-timeline-visible`,
`open-members.roster-initially-hidden` and
`open-members.roster-visible` prerequisites. The immutable artifact therefore
contains 37 stage-local assertion records and 28 unique identities: 25 direct
plus three inherited.

```bash
pnpm nx run trinity-e2e-android:member-role-live-updates --skipNxCache
# Equivalent package command:
pnpm e2e:android:member-role-live-updates
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, and owns `android-avd` plus `synapse`. Its
provisional bounds are 30 minutes for the Node test, 33 minutes for the target,
and 35 minutes for the hosted wrapper. Shard 4 runs it after
`space-settings-resilience` and before retained Playwright. That placement
uses the latest comparable timing evidence: shard 4 completed in about 90
minutes while shards 1 and 3 remained active beyond 104 minutes, and shard 2
now owns #711. Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.member-role-live-updates/`;
`member-role-live-updates/journeys.json` records all four stages and their
terminal state. Transition receipts, completed native commands,
renderer/APK/Pixel 5 provenance, pass/failure captures, secret redaction, and
device, WebView and Matrix teardown are retained.

Accepted hosted evidence is recorded by
[run 34909929186](https://github.com/quwisky/trinity-matrix-client/actions/runs/34909929186).
The original attempt in shard 4 job `104195532491` passed all four stages with
one attempt and no retries. Native artifact `10376287433` contains 37
stage-local records for all 28 unique identities and 226 of 226 completed
command entries. It records the exact 0→50 promotion, each 100→0 demotion,
disabled and absent action results, exact blocked-action copy, installed APK and
Pixel 5 provenance, renderer digest verification, pass captures, secret
redaction, and successful device, WebView, Matrix and Synapse teardown. Browser
artifact `10375030956` records all four unchanged predecessors passing at retry
0. The audited renderer artifact `10373827842` contains 49 verified files with
digest `e0e4b57a301e141e0aec237a8cabead24094d8e9711b922a301d46f889a59a96`.
The run's unrelated failures in unchanged Android shards 1 and 3 are tracked on
#665; all #712-owned gates passed. This mapping does not authorize predecessor
retirement.

## Room unban batch

The [Android Room unban batch](https://github.com/quwisky/trinity-matrix-client/issues/713)
owns the canonical
`an admin unbans a member from the banned list` definition in
[Room members and addresses](../browser/journeys/room-administration/room-members-and-addresses.spec.mts),
source SHA-256
`f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5`,
lines 75–170. It also owns the transitive visible-Room obligation from
[`openRoom`](../browser/support/room-settings-journey.mts), SHA-256
`bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`,
lines 36–44, and the visible Members-panel obligation from
[`openSettingsTab`](../support/app.mts), SHA-256
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
lines 228–248. This is exactly seven direct plus two helper assertion sites.
All predecessor sources remain enabled and unchanged.

`android.room-unban` uses finite Matrix fixtures to create an admin and target,
set the target display name before membership events, create an invited private
Room, join and ban the target with reason `spam`, and prove exact initial `ban`
membership. The installed app is reset to the exact Pixel 5 profile. Login,
Rooms and Room selection, compact Room Settings navigation, Members and Banned
selection, Unban activation, and confirmation use measured Maestro-native
input. WebView/CDP is limited to read-only observation and coordinate
measurement; it does not click, focus, fill, dispatch product events, submit
forms, navigate, inject DOM, or mutate application state or styles.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Shared Room timeline is visible | `unban.room-timeline-visible` |
| Shared Members panel is visible | `unban.members-panel-visible` |
| Banned-members surface is visible | `unban.banned-surface-visible` |
| Exact target row is visible | `unban.target-row-visible` |
| Confirmation names the target | `unban.confirm-target` |
| Confirmation names the Room | `unban.confirm-room` |
| Confirmation names the opening Account | `unban.confirm-account` |
| Exact success toast is visible | `unban.toast-visible` |
| Target has exact server membership `leave` | `unban.server-membership` |

```bash
pnpm nx run trinity-e2e-android:room-unban --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-unban
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, and owns `android-avd` plus `synapse`. Its
bounds are 10 minutes for the Node test, 13 minutes for the target, and 15
minutes for the hosted wrapper. Shard 3 runs it after `message-moderation` and
before `member-moderation`, so a later unrelated moderation failure cannot
prevent the owned artifact while the accepted #709 suite and diagnostics stay
unchanged. Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-unban/` and preserve
all nine records, completed native commands, exact confirmation/toast/server
outcomes, renderer/APK/Pixel 5 provenance, pass/failure captures, secret
redaction, and device, WebView and Matrix teardown.

Acceptance for #713 requires three unchanged-input native first attempts, the
unchanged exact Playwright predecessor at retry 0, at least five effective
failing controls, required static gates, review, original-attempt green owned
hosted evidence, and immutable-artifact audit. This mapping does not authorize
predecessor retirement.

Original-attempt hosted [run 34919262884](https://github.com/quwisky/trinity-matrix-client/actions/runs/34919262884), from consolidated source
`86ebd1022d16da39d07d4e1defd160ac0ee36653` and hosted merge
`9f6e49a26e3e967d55faa392aa43a361a6c462fc`, accepted #713. Owned Android
shard 3 job `104223764913` passed on run attempt 1. Native artifact
`10379458816` records one passed stage, one suite attempt, zero retries, all
nine identities, 13 native command files, and 64 of 64 completed command
entries. It preserves the exact target/Room/Account confirmation, exact
`Unbanned <target>.` toast, final server membership `leave`, pass captures,
installed `eu.qwky.trinity` APK and hosted API 36 / Pixel 6 provenance,
renderer identity, zero targeted secret matches, and successful device,
WebView, Matrix and Synapse teardown. Browser artifact `10378565873` records
the exact unchanged predecessor passing once at retry 0 in 6,067 ms. Renderer
artifact `10377771152` contains 49 individually verified files with digest
`9ad995de220185e6e44bdcadd4ab989aae5e0fb75bf2e65d6efa75436c824c9b`.
The run's unrelated unchanged shard-1 `android.space-room-order` timeout is
tracked on #665; all #713-owned gates passed without a rerun. This mapping does
not authorize predecessor retirement.

## Room roster and live-authority batch

The [Android Room roster and live-authority batch](https://github.com/quwisky/trinity-matrix-client/issues/714)
owns the canonical
`keeps Room roster, member detail, role changes and live authority in one destination`
definition in
[Room members and addresses](../browser/journeys/room-administration/room-members-and-addresses.spec.mts),
source SHA-256
`f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5`,
lines 172–401. It also owns the transitive visible-Room obligation from
[`openRoom`](../browser/support/room-settings-journey.mts), SHA-256
`bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`,
lines 36–44, and the visible Members-panel obligation from
[`openSettingsTab`](../support/app.mts), SHA-256
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
lines 228–248. This is exactly 33 direct plus two helper assertion sites.
All predecessor sources remain enabled and unchanged.

`android.room-roster-live-authority` uses finite Matrix fixtures to create a
controller, opening admin and member, set the member display name before
membership, and create one invited private Room with exact controller power
101, admin power 100 and member power 0. Controller-authored 100→0→100 live
authority changes, reinvites/rejoins and authoritative membership observations
are the only post-setup REST operations. Installed-app login, Room and Room
Settings navigation, Members selection, role 50, kick, ban, banned-list unban,
Escape, Conversation roster, member detail and final focus use Maestro-native
input. WebView/CDP is limited to read-only observation and coordinate
measurement; it does not click, focus, fill, dispatch product events, submit
forms, navigate, inject DOM, or mutate application state or styles.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Shared Room timeline is visible | `roster.room-timeline-visible` |
| Shared Members panel is visible | `roster.members-panel-visible` |
| Room Settings roster is visible | `roster.roster-visible` |
| Exact member row is visible | `roster.target-row-visible` |
| Selected detail names the member | `roster.detail-target` |
| Role confirmation names the Room | `roster.role-confirm-room` |
| Role confirmation names the opening Account | `roster.role-confirm-account` |
| Roster returns after the role change | `roster.after-role-visible` |
| Moderator group contains the exact member | `roster.moderator-group-target` |
| Selected detail shows Moderator | `roster.detail-moderator` |
| Kick disappears after live admin demotion | `roster.kick-absent-after-demotion` |
| Ban disappears after live admin demotion | `roster.ban-absent-after-demotion` |
| Selected detail retains the exact member after demotion | `roster.detail-target-after-demotion` |
| Selected detail retains Moderator after demotion | `roster.detail-moderator-after-demotion` |
| Kick returns after live admin restoration | `roster.kick-visible-after-restore` |
| Kick confirmation names the member | `roster.kick-confirm-target` |
| Kick confirmation names the Room | `roster.kick-confirm-room` |
| Kick confirmation names the opening Account | `roster.kick-confirm-account` |
| Kicked row disappears with server membership `leave` | `roster.row-absent-after-kick` |
| Rejoined member row returns | `roster.row-visible-after-rejoin` |
| Ban action is visible | `roster.ban-visible` |
| Ban confirmation names the member | `roster.ban-confirm-target` |
| Ban confirmation names the Room | `roster.ban-confirm-room` |
| Ban confirmation names the opening Account | `roster.ban-confirm-account` |
| Banned row disappears with server membership `ban` | `roster.row-absent-after-ban` |
| Banned destination contains the exact member | `roster.banned-row-visible` |
| Unban confirmation names the member | `roster.unban-confirm-target` |
| Unban confirmation names the Room | `roster.unban-confirm-room` |
| Unban confirmation names the opening Account | `roster.unban-confirm-account` |
| Unbanned row disappears with server membership `leave` | `roster.banned-row-absent` |
| Native Escape closes Room Settings | `roster.settings-closed-after-escape` |
| Conversation roster contains the rejoined member | `roster.conversation-row-visible` |
| Conversation member detail names the member | `roster.conversation-detail-target` |
| Conversation row remains after detail closes | `roster.conversation-row-after-close-visible` |
| Conversation member filter regains focus | `roster.member-filter-focused` |

```bash
pnpm nx run trinity-e2e-android:room-roster-live-authority --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-roster-live-authority
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, and owns `android-avd` plus `synapse`. Its
bounds are 30 minutes for the Node test, 33 minutes for the target, and 35
minutes for the hosted wrapper. Shard 3 runs it after `room-unban` and before
`member-moderation`, so a later unrelated moderation failure cannot prevent
the owned artifact. Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-roster-live-authority/`
and preserve all 35 records, completed native commands, exact UI/server
outcomes, renderer/APK/Pixel 5 provenance, pass/failure captures, secret
redaction, and device, WebView and Matrix teardown.

Acceptance for #714 requires three unchanged-input native first attempts, the
unchanged exact Playwright predecessor at retry 0, at least five effective
failing controls, required static gates, review, original-attempt green owned
hosted evidence, and immutable-artifact audit. This mapping does not authorize
predecessor retirement.

Original-attempt hosted [run 34932186969](https://github.com/quwisky/trinity-matrix-client/actions/runs/34932186969), from consolidated source
`7864731f2464b1c452ead0fb8fa0c7ad99bc5f5b` and hosted merge
`e5db94e94a8f7013a6f083f8b13ef9f80a452148`, accepted #714. Owned Android
shard 3 job `104262819521` passed on run attempt 1. Native artifact
`10385576752`, digest
`cb225fbcd17087db59c3ed0de26f9ae621d996005de74f0746c0f9cb19b18cc3`,
records one passed stage in 311,535 ms, one suite attempt, zero retries, all 35
identities, 19 successful native action files, and 91 of 91 completed command
entries. It preserves exact role, kick, ban and unban dialogs, the
controller-authored admin 100→0→100 transitions, blocked moderation actions while
demoted, exact membership transitions, Escape, Conversation roster/detail
continuity, final member-filter focus, pass captures, installed APK/device/profile
and renderer provenance, zero targeted secret matches, and successful device,
WebView, Matrix and Synapse teardown.

Browser artifact `10382492300`, digest
`377c0a306d46f9e6b7d7eb59223f68651236e3291f9db5dfd8245e5cd4c28b59`, records
the exact unchanged predecessor passing once at retry 0 in 10,231 ms; the full
suite records 317 passes, one skip and zero retries. Renderer artifact
`10382172118`, artifact digest
`89fac69d4d73108001707a111aa8498c441b4dce2d29c2c7e6a2868352f80b14`,
contains 49 individually verified files whose recomputed manifest digest is
`c7c73787c08c14e0ac6ff15a9af66c5ebe04825837eaf7a59ab4803fb2e764cc`.
The run's unrelated unchanged shard-2 native-shell timeout is tracked on #665;
all #714-owned gates passed without a rerun. This mapping does not authorize
predecessor retirement.

The [Android Room address lifecycle batch](https://github.com/quwisky/trinity-matrix-client/issues/715)
owns the canonical `an admin adds a room address and makes it the main one`
definition in
[Room members and addresses](../browser/journeys/room-administration/room-members-and-addresses.spec.mts),
source SHA-256
`f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5`,
lines 403–536. It also owns the transitive visible-Room obligation from
[`openRoom`](../browser/support/room-settings-journey.mts), SHA-256
`bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`,
lines 36–44, and the visible Addresses-panel obligation from
[`openSettingsTab`](../support/app.mts), SHA-256
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
lines 228–248. This is exactly 15 direct plus two helper assertion sites. All
predecessor sources remain enabled and unchanged.

`android.room-address-lifecycle` uses finite Matrix fixtures to create one
owner and one private Room, derive invocation-unique accepted and rejected
local aliases, resolve directory state, and observe canonical-alias state.
Installed-app login, Room and Room Settings navigation, Addresses selection,
alias entry, native Enter submission, primary selection, removal cancellation,
removal confirmation, and rejected-draft entry all use Maestro-native input.
WebView/CDP is limited to read-only observation, coordinate measurement, and
failing the first exact rejected-alias
`PUT /_matrix/client/<version>/directory/room/<encoded-alias>` with HTTP 500;
it does not click, focus, fill, dispatch product events, submit forms, navigate,
inject DOM, or mutate application state or styles.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Shared Room timeline is visible | `address.room-timeline-visible` |
| Shared Addresses panel is visible | `address.addresses-panel-visible` |
| Room address editor is visible | `address.panel-visible` |
| Exact new alias row is visible | `address.row-visible` |
| Directory resolves the alias to the exact Room | `address.directory-resolves` |
| Exact alias shows the Primary marker | `address.primary-visible` |
| Canonical-alias state names the exact alias | `address.canonical-state` |
| Room Settings stays within the desktop viewport | `address.settings-within-viewport` |
| Exact primary-address toast is hidden | `address.primary-toast-hidden` |
| Removal explains the exact joining and linking effect | `address.remove-joining-effect` |
| Removal states that the Room is retained | `address.remove-room-retained` |
| Cancelling removal keeps the exact alias row | `address.cancel-keeps-row` |
| Confirming removal removes the exact alias row | `address.row-removed` |
| Confirming removal clears directory resolution | `address.directory-removed` |
| Confirming removal clears canonical alias state | `address.canonical-cleared` |
| Exact rejected-add toast is visible with HTTP 500 transport evidence | `address.rejected-toast-visible` |
| Rejected localpart remains in the input | `address.retry-draft-retained` |

```bash
pnpm nx run trinity-e2e-android:room-address-lifecycle --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-address-lifecycle
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, and owns `android-avd` plus `synapse`. Its
bounds are 10 minutes for the Node test, 13 minutes for the target, and 15
minutes for the hosted wrapper. Shard 3 runs it after
`room-roster-live-authority` and before `member-moderation`, so a later
unrelated moderation failure cannot prevent the owned artifact. Started-only
diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-address-lifecycle/`
and preserve all 17 records, completed native commands, exact UI, directory,
canonical-state and transport outcomes, renderer/APK/desktop-profile
provenance, pass/failure captures, secret redaction, and device, WebView,
transport-session and Matrix teardown.

Accepted on original hosted run `34943024129` at exact source head
`8c9b41f3812a62c6dd7a36bc7b1df40e3d2f2330` (hosted merge
`26dc0f8b3ad1988b7f4dac38dea00965f595aee0`). Owned shard-3 job
`104296347394` passed on attempt 1. Immutable Android artifact `10389934587`,
digest `72f43a185dcfa2ed200a9b6d023d0f4c1b604f4f5825ac79df6d1e9b8996f896`,
records one passed stage in 256,484 ms, one suite attempt, zero retries, all 17
identity records, and 14/14 successful native action files. It preserves the
exact alias row and directory target, primary marker and canonical state,
`1152 <= 1280` desktop geometry, hidden primary toast, exact removal copy,
cancelled and confirmed removal outcomes, cleared directory and canonical
state, exact rejected-add toast with one HTTP 500 response and injected-body
match, retained retry draft, renderer/APK/desktop-profile provenance, zero
literal bearer/token findings, and successful device, WebView, Matrix,
transport-session and Synapse teardown.

Browser artifact `10386962978`, digest
`4e36381c0b446999f8af4aeb729d028245c281ebafa2ad259edcfaf68a84dc2b`, records
the exact unchanged predecessor passing once at retry 0 in 10,028 ms; the full
browser suite records 317 passes, one skip and zero retries. Renderer artifact
`10386112391`, artifact digest
`cf37d16f7af41d2385629f15953109f3f1522c92ed756bd89c4116bb08e79733`, contains
49 independently verified files whose recomputed manifest digest is
`95d89c3ac2333632cc75ffa53d5626e08fa431d51f778b5cc4105c8e93a84f6e`.
Together with three unchanged-input native first attempts, the unchanged local
predecessor, five effective failing controls, the full static gates, and review
with no unresolved findings, this accepts #715. The run's unrelated unchanged
shard-2 native homeserver failure is tracked on #665; every #715-owned gate
passed without a rerun. The Playwright predecessor remains enabled; this
mapping does not authorize its retirement.

## Room access policy batch

The [Android Room access policy batch](https://github.com/quwisky/trinity-matrix-client/issues/716)
owns four canonical definitions in
[Room access settings](../browser/journeys/room-administration/room-access-settings.spec.mts),
source SHA-256
`3ae190d7814f8e3e2fda6640bcbfb77e089b1da8605b11645b7e79c2df0bcb6c`:
`an admin changes who can join and read history` at lines 20–137,
`an admin lets a space’s members join the room` at lines 139–215,
`an admin revokes a space’s access by unticking it` at lines 217–314, and
`a member reads Room policy without a disabled Save footer` at lines 316–390.
It also owns six unique helper obligations from [`openRoom`](../browser/support/room-settings-journey.mts),
SHA-256 `bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`,
lines 36–44, and [`openSettingsTab`](../support/app.mts), SHA-256
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
lines 228–248. The stage-one Addresses-panel helper outcome is identical to
direct assertion line 134 and is deliberately folded into
`admin.addresses-visible`. The mapping therefore contains exactly 23 direct
plus six helper identities, with all predecessor sources enabled and unchanged.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Admin Room timeline is visible | `admin.room-timeline-visible` |
| Admin Access panel is visible | `admin.access-panel-visible` |
| Room Settings is visible | `admin.settings-visible` |
| Access panel is initially absent | `admin.access-panel-initially-absent` |
| General panel is absent after Access opens | `admin.general-panel-absent` |
| Access heading owns focus | `admin.section-heading-focused` |
| Alias controls are absent from Access | `admin.aliases-absent` |
| Save remains visible at 125% text scale | `admin.save-visible-scaled` |
| Native Tab focuses Save | `admin.save-focused` |
| Server join rule is exactly public | `admin.join-rule-public` |
| Server history visibility is exactly world-readable | `admin.history-world-readable` |
| Addresses panel is visible | `admin.addresses-visible` |
| Restricted Room timeline is visible | `restricted.timeline-visible` |
| Restricted Room Settings is visible | `restricted.settings-visible` |
| Restricted Access panel is visible | `restricted.access-panel-visible` |
| Exact parent Space option is visible | `restricted.space-option-visible` |
| Server join rule is exactly restricted | `restricted.join-rule` |
| Allow list contains exactly the parent Space | `restricted.allow` |
| Revocation Room timeline is visible | `revoke.timeline-visible` |
| Revocation Access panel is visible | `revoke.access-panel-visible` |
| Exact dropped Space option is visible | `revoke.dropped-option-visible` |
| Allow list retains the kept Space and unknown rule only | `revoke.allow` |
| Member Room timeline is visible | `member.room-timeline-visible` |
| Member Access panel is visible | `member.access-panel-visible` |
| Member sees exact Invite-only policy | `member.join-rule-text` |
| Member sees exact joined-history policy | `member.history-text` |
| Member sees the exact join-rule role warning | `member.join-rule-read-only-message` |
| Member sees the exact history role warning | `member.history-read-only-message` |
| Member sees no Access action footer | `member.actions-absent` |

`android.room-access-policy` uses finite Matrix REST fixtures to create its
accounts, version-9 Rooms, Spaces, child links, membership, history and exact
restricted allow-list state, and to observe final server state. Installed-app
login, Room/Space navigation, Room Settings and Access selection, radio and
checkbox changes, native Tab focus, Enter submission and Addresses navigation
all use Maestro-native input. WebView/CDP is read-only except for the two
source-pinned light/125%-text and dark/amethyst visual captures; that document
root fixture restores every temporary style value in `finally`. It never
clicks, focuses, submits, navigates, or otherwise mutates product state.

```bash
pnpm nx run trinity-e2e-android:room-access-policy --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-access-policy
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, and owns `android-avd` plus `synapse`. Its
bounds are 35 minutes for the Node test and 40 minutes for the hosted wrapper.
Shard 3 runs it as the first dedicated suite, before `accounts-workspace`, so a
failure in the long retained suite chain cannot suppress this batch's started-only
artifact. The retained shard-3 suites otherwise keep their established order.
Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-access-policy/`
and must preserve four desktop-profile stages, all 29 identity records,
completed native commands, exact UI/server outcomes, renderer/APK/profile
provenance, named visual and pass/failure captures, secret redaction, and
device, WebView and Matrix teardown.

Acceptance is recorded from original-attempt hosted run
[34973431105](https://github.com/quwisky/trinity-matrix-client/actions/runs/34973431105),
head `c8a5a5b3c5548dec93c42df21f91d33600023241`, hosted merge
`34d0db139b20b5fc3a1486a3ef252603e5e742e5`. The shard-3 job
[104395734369](https://github.com/quwisky/trinity-matrix-client/actions/runs/34973431105/job/104395734369)
ran `android.room-access-policy` first: all four stages and all 29 unique
stage-local identities passed in one suite attempt with zero retries. Its
[immutable native artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/34973431105/artifacts/10402179732),
ID `10402179732`, has digest
`sha256:a74e6342bfb97fd2f9cf080fd1a5c7ea41682c3a21c0429111179d08677ded73`.
The audit found 46 successful native-action JUnits, all 226 recorded Maestro
commands completed, exact UI/server outcomes, installed/resumed
`eu.qwky.trinity/.MainActivity`, desktop-profile captures, 24 redacted
`SECRET_TEXT` occurrences and no access token, bearer token, Matrix token or
password assignment. Synapse, device and WebView cleanup completed, and the
hosted worktree diff gate passed.

The same original attempt's
[browser artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/34973431105/artifacts/10399861379),
ID `10399861379`, digest
`sha256:9da1b74bd489cae1465ce82d0b34358c2891601a5acce3008f5503fbb9505023`,
records all four exact predecessors passing at retry 0. Its
[renderer artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/34973431105/artifacts/10397819593),
ID `10397819593`, digest
`sha256:8ce74f00bd5c54ca2a193d1786961eb0d982b5dd7ef7946ba73d224dc3918e51`,
has a valid manifest receipt and all 49 files match their declared sizes and
hashes for hosted merge `34d0db139b20b5fc3a1486a3ef252603e5e742e5`.
Together with three unchanged-input local first attempts, five effective
failing controls, the required static gates and review with no unresolved
findings, this accepts #716. The shard later failed in the unchanged
`message-moderation` suite when Maestro's device server died while starting a
swipe; that infrastructure failure is tracked on #665 and does not invalidate
the already-passed, independently uploaded #716 evidence. The four Playwright
predecessors remain enabled; this mapping does not authorize their retirement.

## Room profile settings batch

The [Android Room profile settings batch](https://github.com/quwisky/trinity-matrix-client/issues/717)
owns four canonical definitions in
[Room profile settings](../browser/journeys/room-administration/room-profile-settings.spec.mts),
source SHA-256
`f6ab33a1fc7160efb206c66f064ab158cea1c3969ad6ee5a55b8eb39299d1f96`:
`an admin renames a room from the settings dialog` at lines 16–151,
`an admin changes the room photo` at lines 153–197,
`keeps partial General saves retryable` at lines 199–256, and
`keeps the opening account for in-flight General saves` at lines 258–358.
It also owns five stage-local timeline obligations from
[`openRoom`](../browser/support/room-settings-journey.mts), source SHA-256
`bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`,
lines 36–44. The mapping contains exactly 36 direct plus five inherited
identities. All four predecessor definitions and their helper remain enabled
and byte-for-byte unchanged.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Prior Room timeline is visible | `rename.prior-room-timeline-visible` |
| Original Room timeline is visible | `rename.original-room-timeline-visible` |
| Rename settings dialog is visible | `rename.settings-visible` |
| Desktop settings directory is visible | `rename.directory-visible` |
| Opening Account is exact | `rename.opening-account` |
| General heading owns focus | `rename.heading-focused` |
| Desktop dialog meets its minimum width | `rename.desktop-width-minimum` |
| Desktop dialog stays within its maximum width | `rename.desktop-width-maximum` |
| Compact directory is hidden | `rename.compact-directory-hidden` |
| Compact Back control is visible | `rename.compact-back-visible` |
| Compact General panel remains visible | `rename.compact-general-visible` |
| Desktop directory returns after resize restoration | `rename.desktop-directory-restored` |
| Desktop Back control is hidden after restoration | `rename.desktop-back-hidden` |
| Cancel remains visible at 125% text scale | `rename.scaled-cancel-visible` |
| Scaled action layout does not overflow | `rename.scaled-actions-absent` |
| Android Back opens the discard dialog | `rename.back-discard-visible` |
| Cancelling Back discard retains the exact draft | `rename.back-draft-retained` |
| General-tab navigation opens the discard dialog | `rename.tab-discard-visible` |
| Cancelling tab discard retains the exact draft | `rename.tab-draft-retained` |
| General panel remains selected after discard cancellation | `rename.general-panel-retained` |
| Renamed Room appears in the channel list | `rename.new-channel-visible` |
| Old Room name disappears from the channel list | `rename.old-channel-absent` |
| Photo Room timeline is visible | `photo.room-timeline-visible` |
| Photo settings dialog is visible | `photo.settings-visible` |
| Exact success toast and authoritative MXC avatar state are present | `photo.updated` |
| Partial-save Room timeline is visible | `partial.room-timeline-visible` |
| First topic failure feedback is exact | `partial.failure-feedback` |
| Name is attempted exactly once before retry | `partial.name-first-attempts` |
| Topic is attempted exactly once before retry | `partial.topic-first-attempts` |
| Retry feedback is exact | `partial.retry-feedback` |
| Name is not retried | `partial.name-total-attempts` |
| Topic is retried exactly once | `partial.topic-total-attempts` |
| Continuity Room timeline is visible | `continuity.room-timeline-visible` |
| Opening owner Account is exact | `continuity.opening-account` |
| Delayed Room name reports Saving | `continuity.name-saving` |
| Target member Account row is visible | `continuity.member-row-visible` |
| Target member becomes active | `continuity.active-member` |
| In-flight save retains the opening owner Account | `continuity.account-retained` |
| Delayed Room name reports Name saved | `continuity.name-saved` |
| Subsequent topic reports Topic saved | `continuity.topic-saved` |
| Member observer reads the exact persisted topic | `continuity.topic-persisted` |

`android.room-profile-settings` uses finite Matrix REST fixtures to create
Rooms and accounts and to observe exact name, topic and avatar state. Installed
app login, Room and Room Settings navigation, responsive Back behavior, text
entry, save/retry actions, photo activation and Android DocumentsUI selection
use Maestro-native input. WebView/CDP is read-only except for bounded
light/dark/125%-text document-root fixtures, exact first-topic failure and
first-name delay transport controllers, and the predecessor-required Account
switch behind the pointer-blocking save modal. That Room-specific exception is
confined to the exact two source-pinned clicks at predecessor lines 324–335.
The document root, transport controllers and staged document are restored or
closed in `finally`.

```bash
pnpm nx run trinity-e2e-android:room-profile-settings --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-profile-settings
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns `android-avd` plus `synapse`, and has a
35-minute Node timeout. Shard 3 runs it immediately after
`room-access-policy` and before `accounts-workspace` under a 40-minute wrapper.
Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-profile-settings/`
and must preserve four desktop-profile stages, all 41 unique identity records,
completed native commands, exact UI/server/transport outcomes,
renderer/APK/profile provenance, named visual and pass/failure captures,
secret redaction, and device, WebView, document, transport and Matrix teardown.

Acceptance requires the focused and full contract gates, Android and browser
typecheck/lint, formatting and documentation gates, at least five effective
failing controls, three unchanged-input native first attempts, all four exact
unchanged Playwright predecessors at retry 0, review with no unresolved
findings, and original-attempt hosted Android/browser/renderer artifact audit.
This mapping does not authorize predecessor retirement or merging PR #677.

Acceptance completed on original-attempt hosted
[run 34997349842](https://github.com/quwisky/trinity-matrix-client/actions/runs/34997349842)
at source head `37af1042301d955bc78e368b73b329e22b3f4ae3` and hosted
merge `033588e404894acd53a625a6396273bc4f7722e5`. Android shard-3
[job 104477625076](https://github.com/quwisky/trinity-matrix-client/actions/runs/34997349842/job/104477625076)
uploaded the passing
[Room profile settings artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/34997349842/artifacts/10411410578),
ID `10411410578`, digest
`sha256:ddd6a373db81a2b9722df562370543e0f59e6577489b04b06cf0f6b533954a4b`.
Its one 937915 ms invocation passed all four stages with zero retries: rename
249700 ms, photo 155995 ms, partial retry 204158 ms and opening-Account
continuity 326744 ms. The audit found every one of the 41 contract identities
exactly once, 62 successful native-action JUnits and 305 completed Maestro
commands with no failed, cancelled or pending command. The document picker
selected `room-photo.png` through Downloads; the partial-save controller
recorded the exact first `m.room.topic` 500 and one topic-only retry; the
continuity controller released exactly one delayed `m.room.name` write; and
the captured UI and authoritative server outcomes were exact. All 40
`SECRET_TEXT` assignments were redacted, no credential assignment was exposed,
the installed `eu.qwky.trinity/.MainActivity` and API 36 emulator provenance
were present, all six audited desktop/light/dark captures were complete and
unclipped, Synapse/device/WebView/controller/document cleanup completed, and
the hosted worktree diff gate passed.

The same attempt's
[browser artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/34997349842/artifacts/10409282811),
ID `10409282811`, digest
`sha256:cb3fb6d8b3a39578d97fa56420e06995800d0764c355f283870e7e864a189236`,
records all four exact predecessors passing at retry 0. Its
[renderer artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/34997349842/artifacts/10408442154),
ID `10408442154`, digest
`sha256:bc548b1e6623b0f0e6683692a31bac33faa0895d65ff216f020f943ef74fad33`,
contains 49 verified files / 15,302,528 bytes and manifest digest
`e938ec050b0ee7d59381f15dd973d3d0ea47955c2f95dcb810d21665f7cad749`
for the hosted merge. Together with three unchanged-input local first
attempts, six effective negative controls, required static gates and review
with no unresolved findings, this accepts #717. The shard later failed in the
unchanged Accounts/Workspace suite because Maestro rejected an unavailable
driver host port before starting a `fill()` flow. The only #717 shared-client
change is confined to `replace()`, and 27 earlier password fills passed in the
same job; the independent host reliability failure is tracked on #665. All
four Playwright predecessors remain enabled.

## Room For-you preferences batch

The [Android Room For-you preferences batch](https://github.com/quwisky/trinity-matrix-client/issues/718)
owns the two canonical definitions in
[Room For-you settings](../browser/journeys/room-administration/room-settings-for-you.spec.mts),
source SHA-256
`923fe4053badf040b9deaf9beba7da74bc27bf19277af4bb570462fed2c24f88`:
`shows a failed preference read and retries into the editable form` at lines
150–225 and `isolates staged preferences to the opening Account and retries
only a failed field` at lines 227–391. It also owns three stage-local timeline
obligations from [`openRoom`](../browser/support/room-settings-journey.mts),
source SHA-256
`bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`,
lines 36–44. The mapping contains exactly 35 direct plus three inherited
identities. Both predecessor definitions and their helpers remain enabled and
byte-for-byte unchanged.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Failed-read Room timeline is visible | `load.room-timeline-visible` |
| Failed-read settings dialog is visible | `load.settings-visible` |
| Exact preference-read error heading is visible | `load.error-heading-visible` |
| Error alert does not use a live region | `load.alert-not-live` |
| Retry remains enabled | `load.retry-enabled` |
| Alert geometry is present | `load.alert-box-present` |
| Retry geometry is present | `load.retry-box-present` |
| Retry left edge is contained by the alert | `load.retry-left-contained` |
| Retry top edge is contained by the alert | `load.retry-top-contained` |
| Retry right edge is contained by the alert | `load.retry-right-contained` |
| Retry bottom edge is contained by the alert | `load.retry-bottom-contained` |
| Retry recovers the editable form | `load.form-visible` |
| Push-rules read is attempted at least twice | `load.read-attempts-minimum` |
| Owner Room timeline is visible | `preferences.owner-room-timeline-visible` |
| Member Room timeline is visible | `preferences.member-room-timeline-visible` |
| Preference settings dialog is visible | `preferences.settings-visible` |
| For-you form is visible | `preferences.form-visible` |
| For-you heading owns focus | `preferences.heading-focused` |
| Expected notification mode is checked | `preferences.expected-mode-checked` |
| Other notification modes are unchecked | `preferences.other-modes-unchecked` |
| Opening Account is exact | `preferences.opening-account` |
| Favourite starts unchecked | `preferences.initial-favourite-unchecked` |
| Partial-save feedback is exact | `preferences.partial-feedback` |
| Notification writes occur before retry | `preferences.notification-first-writes` |
| Favourite is written exactly once before retry | `preferences.favourite-first-writes` |
| Low priority is attempted before retry | `preferences.low-priority-first-writes` |
| Retry success feedback is exact | `preferences.retry-feedback` |
| Notification is not retried | `preferences.notification-total-writes` |
| Favourite is not retried | `preferences.favourite-total-writes` |
| Owner notification mode persists | `preferences.owner-mode-persisted` |
| Owner favourite and low-priority tags persist | `preferences.owner-tags-persisted` |
| Member notification mode remains isolated | `preferences.member-mode-persisted` |
| Member tags remain isolated | `preferences.member-tags-persisted` |
| Form remains visible across theme captures | `preferences.theme-form-visible` |
| Form remains visible at 125% text scale | `preferences.scaled-form-visible` |
| Member Account becomes active | `preferences.member-account` |
| Member favourite remains checked | `preferences.member-favourite-checked` |
| Member low priority remains unchecked | `preferences.member-low-priority-unchecked` |

`android.room-for-you` uses finite Matrix REST fixtures to create its Accounts
and private Room, seed and observe exact notification modes and Room tags, and
clean all resources. Installed-app login, Account addition and switching, Room
and Room Settings navigation, radio and checkbox changes, retry, cancellation
and keyboard focus use Maestro-native input. WebView/CDP is read-only except
for bounded default/Amethyst/Onyx light/dark and 125%-text document-root
fixtures and exact first push-rules-read and low-priority-write fault
instrumentation. Those fixtures, transport controllers and WebView sessions
are restored or closed in `finally`.

```bash
pnpm nx run trinity-e2e-android:room-for-you --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-for-you
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns `android-avd` plus `synapse`, and has a
30-minute Node timeout. Shard 3 runs it immediately after
`room-profile-settings` and before `accounts-workspace` under a 35-minute
wrapper. Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-for-you/` and must
preserve both desktop-profile stages, all 38 unique identity records,
completed native commands, exact UI/server/transport outcomes,
renderer/APK/profile provenance, named visual and pass/failure captures,
secret redaction, and device, WebView, document, transport and Matrix teardown.

Acceptance requires the focused and full contract gates, Android and browser
typecheck/lint, formatting and documentation gates, at least six effective
failing controls, three unchanged-input native first attempts, both exact
unchanged Playwright predecessors at retry 0, review with no unresolved
findings, and original-attempt hosted Android/browser/renderer artifact audit.
This mapping does not authorize predecessor retirement.
It does not authorize merging PR #677.

Acceptance completed on original-attempt hosted
[run 35035908519](https://github.com/quwisky/trinity-matrix-client/actions/runs/35035908519)
at exact consolidated source head
`d8751f1aeee22d58fd7b32af28f5b669e91736e0` and hosted merge
`229aacd262ad7a15173f303d757925a38c455774`. Android shard 3
[job 104605348465](https://github.com/quwisky/trinity-matrix-client/actions/runs/35035908519/job/104605348465)
uploaded the passing
[Room For-you artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35035908519/artifacts/10428021795),
ID `10428021795`, digest
`sha256:5a91dc598fabfc333b7fa75ec7c6ba3c02827e0c697521b1edd29236b8be3cb2`.
Its one 677788 ms invocation passed both stages with zero retries: failed
preference read and recovery in 175014 ms, then opening-Account preference
isolation and partial retry in 501315 ms. The immutable audit found all 38
contract identities exactly once, 42 successful native-action JUnits and 197
completed Maestro commands with no failure, cancellation or pending command.
The read controller recorded the exact first push-rules GET 500/`offline` and
at least two reads. The write controller recorded the exact first
opening-owner low-priority tag PUT 500/`retry me`, exactly one notification
write, one favourite write and a low-priority-only retry. Final owner state was
Mute plus favourite and low priority; member state remained Mentions plus
favourite. Exact feedback, radio, Account and retry-containment observations
were present.

All seven default/Amethyst/Onyx light/dark and 125%-text captures were
complete, visible and contained in the 1280x720 installed WebView. All 27
`SECRET_TEXT` occurrences were redacted across 18 environment values and nine
evaluated inputs. Synapse teardown and emulator shutdown completed after both
stage passes, and the hosted worktree diff gate passed.

The same attempt's
[browser artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35035908519/artifacts/10424246571),
ID `10424246571`, digest
`sha256:3a7d7293214e49390c26a8ef71cfd3a4aff5c9743a1d2880aae12106d2181f85`,
records the failed-read and Account-isolation predecessors passing at retry 0
in 7534 ms and 10997 ms. Its
[renderer artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35035908519/artifacts/10422853271),
ID `10422853271`, digest
`sha256:cbeebd4dc6c97dd42126187ec4788a0c7d5d3daee2961847044af57f5b681f3c`,
contains 49 verified files / 15,302,528 bytes and manifest digest
`5c77b7d4181e5532cbcc29c2786db1fc78ca48370abf4ab0bd6315af508474e6`
for the hosted merge. Together with three unchanged-input local first
attempts, seven effective negative controls, required static/documentation
gates, review with no unresolved findings and the all-green exact-head hosted
run, this accepts #718. Both Playwright predecessors remain enabled. PR #677
remains draft/open and is not merged.

## Room widget journeys

`android.room-widget-settings` preserves the four Playwright Room-widget
definitions pinned by issue #719. The executable contract maps lines 37–236 of
`room-settings-widgets-mobile.spec.mts`, lines 20–235, 237–421 and 423–543 of
`room-widget-settings.spec.mts`, and the pinned widget, Room Settings,
multi-Account and app helpers. It contains exactly 86 direct plus seven
inherited stage-local identities (93 unique identities total). All four
predecessors and their helpers remain enabled and byte-for-byte unchanged.

The four installed-Android stages preserve:

- Pixel 5 draft protection, eight seeded widgets, one native-created widget,
  scrolling, long-content containment, embed bounds, close behavior, six
  reversible Mode/Theme captures and 125% text scale;
- exact URL substitution and secure link attributes, no eager load, rejected
  same-origin-sibling and changed-origin responses, legitimate Widget API
  negotiation, exact request/referrer counts, iframe sandbox/referrer policy,
  denied capabilities and mixed-content blocking;
- the opening admin across the predecessor's pointer-blocked Account switch,
  an exact first widget-state-write 500, pending/error/draft continuity,
  native retry, exact server declaration, confirmation, removal focus and an
  empty state-event tombstone; and
- live creation/removal controls after power grant and revocation, without an
  eager widget request.

Maestro owns reachable product taps, text entry, Enter, confirmation and
scrolling. Finite Matrix REST owns setup and server observation. WebView/CDP is
read-only except for exact-host fixture HTTP, reversible document-root visual
fixtures, the source-pinned sibling/changed-origin/mixed-content probes, the
two exact Account-runtime handler invocations required while the settings
overlay blocks pointer input, and the exact first widget-state-write fault.
The widget fixture intercepts only `https://widgets.example/*` and
`https://attacker.example/origin-change`, continues unrelated requests, and
records real widget requests plus referrers. Every Fetch/Network/Log session,
block list, visual fixture and WebView is restored or closed in bounded
cleanup.

```bash
pnpm nx run trinity-e2e-android:room-widget-settings --skipNxCache
# Equivalent package command:
pnpm e2e:android:room-widget-settings
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns `android-avd` plus `synapse`, and has a
40-minute Node timeout. Shard 4 runs it after `member-role-live-updates` and
before retained Playwright under a 45-minute wrapper. Started-only diagnostics
live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.room-widget-settings/`
and must preserve all four stages, all 93 identities exactly once, completed
native commands, fixture request/referrer and bridge-policy evidence, exact
Matrix write-fault/declaration/tombstone evidence, renderer/APK/profile
provenance, visual and pass/failure captures, secret redaction, Synapse
teardown and emulator shutdown.

Acceptance requires the focused and full contract gates, Android and browser
typecheck/lint, formatting and documentation gates, effective negative
controls, three unchanged-input native first attempts, all four exact
unchanged Playwright predecessors at retry 0, review with no unresolved
findings, and original-attempt hosted Android/browser/renderer artifact audit.
This mapping does not authorize predecessor retirement or merging PR #677.

Local acceptance used seven effective controls: one direct and one inherited
identity, the exact widget write-fault target, the changed-origin Fetch pattern,
opening-Account retention, live power grant and artifact-secret redaction. Each
mutation failed its intended guard, and the restored contract passed. Three
unchanged-input installed-Android invocations
`mu3vjerh-a6833afd-e177-43c3-8b97-2238304fb7ee`,
`mu3w0hzs-c388abb8-b55f-4ede-9712-d8446acb3821` and
`mu3whdzw-2bd84f86-500a-4a2c-824c-ee22e71da8c1` passed all four stages on
their original attempt with zero retries and all 93 identities exactly once.
The final invocation contained 38 redacted `SECRET_TEXT` environment values
and 19 redacted evaluated inputs. The four exact Playwright predecessors passed
sequentially with one worker and zero retries in invocations
`mu3wylhu-c1d4c7d2-e940-4324-9f8e-1a29964d97d1`,
`mu3wz7iy-67782616-d349-4f8a-a1db-74c981ee5c6e`,
`mu3wzuc8-69724043-c87f-43e6-ac45-962e2a990fc5` and
`mu3x0gm1-d7421f55-adb4-4b0c-9b6c-6182bfac00d0`.

Acceptance completed on original-attempt hosted
[run 35082714400](https://github.com/quwisky/trinity-matrix-client/actions/runs/35082714400)
at exact consolidated source head
`224292a53f78e0bec6633a3cc76bdbb710e932a1` and hosted merge
`9636717d384f7ee009042020240f888033e20ada`. Android shard 4
[job 104750787806](https://github.com/quwisky/trinity-matrix-client/actions/runs/35082714400/job/104750787806)
uploaded the passing
[Room widget artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35082714400/artifacts/10444606111),
ID `10444606111`, digest
`sha256:a3f48e2eccd54e17b3adf6fd777f4429c5f2a69e8318c4cb62ab1c663e4c3a7e`.
Its one 888167 ms invocation passed all four stages with zero retries: mobile
layout in 280371 ms, restricted bridge in 165649 ms, opening-admin management
in 325841 ms and live authority in 115053 ms. The immutable audit found all 93
contract identities exactly once, 72 successful native-action JUnits and 337
completed Maestro commands with no failed, cancelled or pending command. It
also verified the three legitimate Widget API requests with null referrers,
the sandbox/referrer/denied-capability policy, rejected sibling and
changed-origin replies, blocked mixed content, exact first widget-state-write
500, exact declaration and empty tombstone, and live grant/revocation outcomes.

All six default/Amethyst/Onyx light/dark captures, the 125%-text capture and
four stage-pass captures were present, visible and readable on the installed
Android surface. All 38 `SECRET_TEXT` environment occurrences and 19 evaluated
inputs were redacted. Synapse data was removed after the stage passes, and the
artifact retained the installed `eu.qwky.trinity` activity plus verified
renderer manifest evidence.

The same attempt's
[browser artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35082714400/artifacts/10442695083),
ID `10442695083`, digest
`sha256:dbff806658633ee5d49a9e124dfb046fa9c1d02e9794ae84d0d8352c891478ce`,
records all 317 retained browser tests passing and one skip with zero retries.
The four exact widget predecessors passed in 6770 ms, 7940 ms, 9534 ms and
7098 ms. Its Synapse data was removed during teardown. The
[renderer artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35082714400/artifacts/10441126716),
ID `10441126716`, digest
`sha256:9ec340ca292fc35ab6f841b63b138dd64a91284f4c89cb20a53b7c3acda43378`,
contains 49 verified files / 15,302,528 bytes and manifest digest
`111dba0e9d4eb0e537c48e6a5503523b4b5b418a5e9bb748e043277f09ead555`
for the hosted merge. Together with three unchanged-input local first
attempts, seven effective negative controls, required static/documentation
gates and review with no unresolved findings, this accepts #719. All four
Playwright predecessors remain enabled. PR #677 remains draft/open and is not
merged.

## Account password-change journey

`android.account-password-change` preserves the canonical Playwright account
password definition pinned by issue #720 at
`e2e/browser/journeys/accounts/change-password.spec.mts:52-94`, its local
Account-form readiness helper at lines 42–47, the Android navigation helper at
`e2e/support/journeys/navigation.mts:11-60`, and the pinned app helper. The
executable contract contains exactly five direct plus three inherited
identities (eight unique identities total). The predecessor and helpers remain
enabled and byte-for-byte unchanged.

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| Rooms URL is Account-qualified | `password-change.rooms-account-qualified` |
| Settings navigation is visible | `password-change.settings-navigation-visible` |
| Settings detail is non-empty | `password-change.settings-detail-non-empty` |
| Current-password form is ready | `password-change.form-ready` |
| Wrong current password shows exact feedback and retains new credentials | `password-change.wrong-current-feedback` |
| Successful change shows the exact toast | `password-change.success-toast` |
| New password login returns 200 | `password-change.new-password-login-status` |
| Old password login returns 403 | `password-change.old-password-login-status` |

The stage registers a disposable password account and drives installed-app
login, Settings navigation, Account-section selection, password entry and both
submissions through Maestro-native input. WebView/CDP is read-only: it observes
route, visibility, feedback and a one-way hash comparison proving both new
credential fields remain exact after the rejected submission. Finite Matrix
REST probes observe the final 200/403 credential statuses; every successful
probe session is immediately logged out in `finally` with an independent
timeout. Diagnostics store only UI observations, booleans and status codes.

```bash
pnpm nx run trinity-e2e-android:account-password-change --skipNxCache
# Equivalent package command:
pnpm e2e:android:account-password-change
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns `android-avd` plus `synapse`, and has a
15-minute Node timeout. Shard 4 runs it after `room-widget-settings` and before
retained Playwright under a 20-minute wrapper. Started-only diagnostics live
under
`dist/.playwright/trinity-e2e-android/<run-id>/android.account-password-change/`
and must preserve the stage, all eight identities exactly once, completed
native commands, exact UI/REST outcomes, renderer/APK/profile provenance,
pass/failure captures, credential redaction and device, WebView, probe and
Synapse teardown.

Acceptance requires the focused and full contract gates, Android and browser
typecheck/lint, formatting and documentation gates, at least six effective
negative controls, three unchanged-input native first attempts, the exact
unchanged Playwright predecessor at retry 0, review with no unresolved findings
and original-attempt hosted Android/browser/renderer artifact audit. Do not
retire the predecessor. This mapping does not authorize merging PR #677.

Local acceptance used three unchanged-input original attempts:
`mu41m232-551a1a7c-8b88-45f9-b0f3-414192dbab09` (201696 ms suite,
169401 ms stage), `mu41rd63-119dc158-6dac-4e5a-9532-bb63b0a17c09`
(200485 ms suite, 166506 ms stage), and
`mu41w8op-101dfa84-a672-4a2f-b7df-baec17a9e2fb` (198536 ms suite,
166338 ms stage). Each recorded one attempt, zero retries, all eight identities
exactly once, 13 passing native-action JUnit files, 68 completed Maestro
commands, and no failures. The final artifact records exact wrong-password
feedback, both retained-field booleans, the exact success toast, new-password
HTTP 200 and old-password HTTP 403; all 14 secret environment values, seven
evaluated inputs and seven input logs are redacted. The retained Playwright
predecessor passed in invocation
`mu4274mt-0f42ed01-dc6f-4b87-bb26-efcd1e52b0d0` in 4910 ms on retry 0 with
clean Synapse teardown. Seven effective negative controls covered direct and
inherited identities, exact error/toast text, retained-field comparison, old
password status, exact logout endpoint and wrong-password redaction.

Owned acceptance completed on original-attempt hosted
[run 35128020025](https://github.com/quwisky/trinity-matrix-client/actions/runs/35128020025)
at exact consolidated source head
`8623769bbf070222cb0cb853f029733b080f38a9` and hosted merge
`806483ea8ed4c0e55b63b939d0584fce1cbd76fa`. Android shard 4
[job 104902253017](https://github.com/quwisky/trinity-matrix-client/actions/runs/35128020025/job/104902253017)
passed on its original attempt after the shard's bounded timeout was extended
to cover its measured Room-widget, password-change and retained-Playwright
workload. Its passing
[password-change artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35128020025/artifacts/10464044648),
ID `10464044648`, digest
`sha256:8f9b4be953da75ffed94c7e7ce3ebbf92312bd418c675c60826b9cd94796df05`,
records invocation `mu4g1fwr-1ad2342c-27f0-456f-b967-081707a29471`: one
211553 ms attempt, zero retries, and the 210771 ms stage. The immutable audit
found all eight identities exactly once, 13 passing native-action JUnits, one
passing suite JUnit and 68 completed Maestro commands with no other command
status. It verified the exact wrong-current-password feedback, both retained
credential booleans, the exact success toast, new-password HTTP 200 and
old-password HTTP 403. All 14 secret environment values, seven evaluated
inputs and seven input logs are redacted. The installed activity and final
Account route were present, and Synapse data was removed after the stage pass.

The same original attempt's
[browser artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35128020025/artifacts/10461327546),
ID `10461327546`, digest
`sha256:3caa9bff1d43505b300c2d2f55725f4ae404d23c05223149f03ad4a04a71f439`,
records 317 retained browser tests passing, one skip and zero retries. The exact
password-change predecessor passed in 9372 ms at retry 0, followed by clean
Synapse teardown. The
[renderer artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35128020025/artifacts/10459698930),
ID `10459698930`, digest
`sha256:5001b160a6f7cc579c0e9072bc34a334e48a521b7b0596b0e42bfd6e2cb68ccf`,
contains 49 verified files / 15,302,528 bytes and manifest digest
`4f6c5f47ec57ecd925de67008563cca3c1844db270e23ea14c036c2b4e6b8ca3`
for the hosted merge. Shards 1 and 4 passed on the original attempt. The two
unrelated original-attempt failures were classified as emulator infrastructure:
shard 2 lost all ADB commands during `android.native-shell`, while shard 3's
Maestro device server closed its TCP connection before a login helper could
run. Targeted attempt-2 reruns were requested for PR-level confirmation; their
outcome does not alter the owned original-attempt acceptance. Together with the
local evidence, required quality gates and review with no unresolved findings,
the owned original-attempt evidence accepts #720. The Playwright predecessor
remains enabled. PR #677 remains draft/open and is not merged.

## Clear-all-data journeys

`android.clear-all-data` preserves issue #721's two functional and four
generated visual definitions from
`e2e/browser/journeys/accounts/clear-all-data.spec.mts`, pinned at SHA-256
`271c63f2e49f27d7c99d4d0d75c7b844d466d70afe69afda71d1335bcc0b1e9c`.
Its storage/confirmation helpers are pinned at lines 37–80, the signed-in
definition at lines 85–151, the signed-out definition at lines 153–176 and the
four Trinity/Amethyst × light/dark definitions at lines 193–253. The app helper
is pinned at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and the contrast helper at
`5c5561a7cd599679a95735fe82cbe14b95faf93c359f3f4ef7e85aa386b2b7f3`.
The executable contract expands the 14 direct sites plus two functional-helper
uses into exactly 11 signed-in, two signed-out and 12 visual stage-local
identities (25 unique identities total).

The signed-in stage creates and signs in a disposable account, proves the
authoritative native `matrix.accounts` preference plus live sync and crypto
IndexedDB databases, then reaches `/login?add` through the native Account menu.
It proves the exact mistype feedback, all observed state surviving that failed
confirmation, lower-case confirmation acceptance, a new document, an empty
native preference namespace, removal of every observed database and the final
signed-out Homeserver surface. The secure access-token assertion is an explicit
Android boundary: native secure storage is authoritative, and this suite makes
no WebView-storage claim.

The signed-out stage writes the exact dead push gateway through Capacitor's
real Preferences bridge, proves its key exists on disk, confirms with uppercase
`RESET TRINITY`, then proves a new signed-out document with an empty native
namespace. Host observation reads only key names from
`shared_prefs/CapacitorStorage.xml` through `run-as`; renderer observation only
enumerates IndexedDB names. Neither invokes product handlers or uses WebView
storage as native-preference evidence.

Each visual stage seeds the exact mode and theme descriptors through the same
bridge, reloads setup state, and measures the installed WebView's untouched
rest state. It proves the root theme/mode, exact rendered equality with
`--trinity-danger`, and WCAG AA normal-text contrast of at least 4.5:1 using
the pinned canvas/compositing algorithm. The real Android media profile proves
`hover: none` and `pointer: coarse`; Android has no supported persistent native
hover path, so hover remains an explicit browser-only exclusion. No DOM pointer
event, tap or long-press is counterfeited as hover.

```bash
pnpm nx run trinity-e2e-android:clear-all-data --skipNxCache
# Equivalent package command:
pnpm e2e:android:clear-all-data
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns `android-avd` plus `synapse`, and has a
20-minute Node timeout. The latest completed hosted timing placed it on shard 4
after `account-password-change` and before retained Playwright under a
25-minute wrapper. Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.clear-all-data/` and must
preserve six stages, all 25 identities exactly once, native action evidence,
authoritative preference/database and document-restart observations, all four
visual measurements, renderer/APK/profile provenance, pass/failure captures,
secret redaction and WebView/device/Synapse teardown.

Local acceptance on 2026-09-16 used unchanged relevant inputs and produced
three consecutive uncached, retry-zero native passes:

- `mu4lrabx-177abff7-6fc1-4c8e-be5c-d18890d1dddb` — 224.392 seconds;
- `mu4lwpd8-9874f0cf-ddf8-4352-8403-4a965f6a905b` — 218.599 seconds;
- `mu4m237u-f06564c9-b2c4-461f-903e-797440b881a7` — 217.738 seconds.

Every invocation recorded six passed stages and all 25 unique identities once,
with zero retries and clean WebView/device/Synapse teardown. Eight reversible
negative controls independently proved the guards reject vacuous pre-state,
lost mistype preservation, missing native-preference or IndexedDB erasure,
missing document replacement, danger-token drift, sub-AA contrast and lost
artifact redaction. Browser invocation
`mu4lhq5x-290298e9-35fa-43d2-b782-8c28d02fdaeb` then ran the exact two
functional and four generated visual predecessors sequentially with one worker
and `--retries=0`; all six passed in 11.204 seconds.

Hosted acceptance on 2026-09-17 used exact consolidated head
`8d9135e67c2ab7654b977683e07bf0556e787022` in merge
`a5b247b3c40977bd714c0e09cb6600e9993adcf9` on run `35175303971`. Renderer
job `105055632322` restored artifact `10478267773` (GitHub digest
`sha256:3729ce93799af0dbc433d01d22ab698b72697f18ff8698b7d8c87f5564274e28`)
and verified the 49-file, 15,302,528-byte production manifest digest
`ead208b6991b7ae5363ab142066c4e9f7978eefdabd886ce38064bfd41aee2bc`.
Browser job `105055936676` produced artifact `10479377785` (GitHub digest
`sha256:5f95e96b85146324fcca5f40a9baf9194dbc2bff89eeb260732d1f7c940d7e24`):
317 attempts passed, one was skipped and none retried; all six retained
clear-all-data predecessors passed at retry zero.

Original-attempt Android shard-4 job `105055936682` passed on an API-36
`pixel_6` x86_64 emulator and produced
`playwright-35175303971-1-a5b247b3c40977bd714c0e09cb6600e9993adcf9-android-e2e-android-clear-all-data-4`,
artifact `10480836793`, 1,213,084 bytes, GitHub digest
`sha256:a243c711af1b6c364c3898cc327f18eb1708c5514fa87182f2e7234f46b4d9f5`.
Invocation `mu4znr1n-05cb7817-e0be-4ebc-aec4-3216ab7dd894` passed once in
217.559 seconds with zero retries. Its six stages and all 25 unique identities
were recorded exactly once. The artifact preserves trusted native taps/fills,
authoritative native preference and IndexedDB pre/post evidence, both required
document replacements, six device and six WebView captures, and all four
rest-state measurements. Trinity light/dark measured 6.760/7.343 and Amethyst
light/dark measured 6.756/7.364 against the 4.5 minimum; each installed profile
reported `hover: none` and `pointer: coarse`. Diagnostic inputs were redacted,
the exact renderer manifest was verified before the suite, Synapse data was
removed, the emulator exited cleanly, and the worktree remained unchanged.
This original-attempt Android/browser/renderer evidence accepts #721 without
retiring its Playwright predecessors. PR #677 remains draft/open and unmerged.

Acceptance requires focused and full contract gates, Android and browser
typecheck/lint, formatting and documentation gates, eight effective negative
controls, three unchanged-input native first attempts, all six exact unchanged
Playwright predecessors sequentially at retry 0, review with no unresolved
findings, and original-attempt hosted Android/browser/renderer artifact audit.
Do not retire or edit the predecessors. This mapping does not authorize merging
PR #677.

## Password registration journey

`android.password-registration` preserves issue #722's canonical Playwright
password-registration definition at
`e2e/browser/journeys/accounts/registration.spec.mts:10-48`, pinned at SHA-256
`a22f58f703c185645987ad471c2f8637d2741344be365d5063c8f0b1c37f2dbd`.
Its Synapse-session and labeled-input helpers are pinned at
`e2e/support/app.mts:124-166`, SHA-256
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
and its independent password-login helper is pinned at
`e2e/support/account.mts:57-79`, SHA-256
`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
The executable contract contains four assertion identities:

| Predecessor obligation | Replacement assertion identity |
| --- | --- |
| The registration action starts absent, then appears only after the exact homeserver's successful availability probe | `password-registration.availability-action-visible` |
| The native registration action reaches concrete `/register` with the exact homeserver query | `password-registration.registration-route` |
| Real Synapse `m.login.dummy` UIA reaches first-device `/encryption/setup` | `password-registration.encryption-setup-route` |
| Independent password login returns the exact newly registered MXID | `password-registration.exact-mxid` |

The installed stage starts from a cleared Pixel 5-profile app and drives the
Homeserver, Continue, Create account, username, password, confirmation and
submit actions through Maestro-native input. A read-only CDP Network observer
matches both the exact entered homeserver origin and
`/_matrix/client/v3/register/available`; it records only the successful status
and path before the gated action may satisfy its assertion. CDP also reads the
concrete routes but never clicks, focuses, fills, submits, navigates or
dispatches a product event.

The product SDK owns registration and the real `m.login.dummy` UIA flow. The
journey does not call Matrix registration or Synapse shared-secret creation.
After `/encryption/setup`, a finite Node REST login must return HTTP 200 and the
exact `@signup-<test-resource-id>:localhost` MXID. Its access token remains in
memory, is registered for artifact redaction immediately and is revoked through
`/_matrix/client/v3/logout` in `finally`; failed revocation fails cleanup.

```bash
pnpm nx run trinity-e2e-android:password-registration --skipNxCache
# Equivalent package command:
pnpm e2e:android:password-registration
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns `android-avd` plus `synapse`, and has a
15-minute Node timeout. The accepted hosted run placed it on shard 4 after
`clear-all-data` and before retained Playwright under a 20-minute wrapper; the
focused target completed in 4 minutes 17 seconds before that shard continued
through its retained Playwright coverage.
Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.password-registration/`
and preserve one stage, all four assertion identities exactly once, trusted
native-action proof, exact availability and route observations, the sanitized
MXID/status result, renderer/APK/profile provenance, pass/failure captures,
credential and session redaction, REST revocation, and WebView/device/Synapse
teardown.

Local acceptance on 2026-09-17 used unchanged relevant inputs and produced
three consecutive uncached, retry-zero native passes:

- `mu54pw9w-f2a95c62-6de1-40ac-ad3e-16642d9b7fd9` — 147.346 seconds;
- `mu54unoy-f13552b6-2bfb-4e7d-ae45-da228f1d27b7` — 145.229 seconds;
- `mu54z8jl-a604f033-6a99-4630-80c0-91795ff31acf` — 145.184 seconds.

Every invocation recorded the one passed stage and all four identities exactly
once, with zero retries, 12 native actions, successful independent password
login and logout, and clean WebView/device/Synapse teardown. Eight reversible
negative controls independently proved the guards reject action-classification
drift, availability-probe weakening, route or homeserver-query drift, UIA and
exact-MXID weakening, missing cleanup and lost secret redaction. Browser
invocation `mu554z2q-6e8dac3d-7e40-43b5-8524-4ef3ce61dbd8` then ran the exact
unchanged predecessor with one worker and `--retries=0`; it passed in 3.842
seconds. The frozen production renderer manifest digest was
`61b98ec83a29cbfd8124aeb3f200734624bfad6350bb702ffb9da8a5a9348610`
and the installed APK digest was
`b3fa6e3d009f33b106ca64fa042a15a291b81ef7e059df3093f7df20440dcf1b`.

Hosted acceptance on 2026-09-17 used exact consolidated head
`742c529a70c86f67e14f5b54ad349568e20ef6f1` in merge
`b3890306a58af8b8aa6615768e19947ce0b80ce0` on run `35189634759`; the merge
tree `7f3444eb0a3fcedbb43db5e6834d5f1f688e88e9` exactly matched both the
feature and consolidated branch trees. Renderer job `105099196797` published
artifact `10483712395` (3,701,106 bytes; GitHub digest
`sha256:c104dadddd22a87a701464aad0b2d694923b550408e821fa45d55e1d448f91d7`)
and verified the 49-file, 15,302,528-byte production manifest digest
`e4b64dc7ef31bc38b7bb57ae7ef82ee44cc26cb3be57aa2f23d13f8f5efef986`.
Browser job `105099461755` produced artifact `10484039999` (GitHub digest
`sha256:909b68ec218e0d12d306d9777054b6119e50b64e1e1af9d0cb0485dd62ef8b57`):
317 attempts passed, one was skipped and none retried; the exact registration
predecessor passed at retry zero in 4.992 seconds.

Original-attempt Android shard-4 job `105099461936` passed on an API-36
`pixel_6` x86_64 emulator and produced
`playwright-35189634759-1-b3890306a58af8b8aa6615768e19947ce0b80ce0-android-e2e-android-password-registration-4`,
artifact `10488372241`, 381,432 bytes, GitHub digest
`sha256:2a58f66d5250d2f668d0cd341924c1a31b21a58e07b3d692f440ace973fcd1c9`.
Invocation `mu58vu05-9e056754-4d8e-4b91-b2a8-6112dcb99630` passed once in
241.321 seconds with zero retries; its stage passed in 240.340 seconds. The
artifact records all four identities exactly once: initially absent then
HTTP-200 availability-gated registration, exact `/register` plus
`https://localhost:8448`, exact `/encryption/setup`, and independent HTTP-200
login for `@signup-android-password-registratio-w0-r0-0a80394f87:localhost`.
It preserves 12 trusted native actions, device and WebView pass captures, and
successful observer/login-token/Synapse cleanup. A full hidden-file scan found
zero raw generated-password, Synapse-token or bearer-token matches and 54
`[REDACTED]` markers. The exact renderer manifest was verified before the
suite, the worktree-integrity check passed and the job completed cleanly.

The original workflow's only failure was the pre-existing shard-3
`room-profile-settings` rename-room native-tap failure after its access-policy
suite had passed; its failure captures were retained and the cross-suite
reliability debt remains owned by #665. The accepted original-attempt
Android/browser/renderer evidence is unaffected and accepts #722 without
retiring its Playwright predecessor. PR #677 remains draft/open and unmerged.

Acceptance requires the focused and full contract gates, Android and browser
typecheck/lint, formatting and documentation gates, eight effective negative
controls, three unchanged-input native first attempts, the exact unchanged
Playwright predecessor at retry 0, review with no unresolved findings, and
original-attempt hosted Android/browser/renderer artifact audit. Do not retire
or edit the predecessor. This mapping does not authorize merging PR #677.

## OIDC-native login journeys

`android.oidc-login` preserves issue #724's four canonical mocked
MSC3861/MSC2965 definitions in
`e2e/browser/journeys/accounts/oidc-login.spec.mts`, pinned at SHA-256
`e9a0dadad15f155a3c69b49e06d8b4539ea7d7f446fd08cfaa565fa3ba6ecb8a`.
The four owned spans are lines 86–100, 102–169, 171–248 and 250–285. Their
4 + 13 + 7 + 2 shape maps to exactly 26 assertion identities. The shared
navigation helper remains unchanged at
`e2e/support/app.mts`, SHA-256
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.

The installed suite resets the app between four ordered stages. The first
classifies delegated authentication and proves Continue plus Create account
are visible while password and legacy-SSO actions are absent. The second
captures exact dynamic native-client registration and authorization parameters,
then returns a matching-state provider-error callback and proves the exact
error surface. The third returns an exact authorization code, captures the
token request and proves the durable verifier's RFC 7636 S256 digest equals the
original challenge before returning token and whoami responses. The final
stage returns password login, answers either optional authentication-metadata
endpoint with exact `M_UNRECOGNIZED` if the SDK probes it, and proves password
fallback without inventing a request the predecessor does not require.

One logical `OidcLoginFixture` controls the exact allowlisted Matrix and
provider endpoints across the Trinity WebView and disposable emulator Chrome
handoff. It serializes paused requests, applies exact CORS and OIDC metadata,
and fails unexpected traffic within the owned scopes. Maestro performs every
reachable Trinity action through the installed Android host. CDP supplies
protocol responses and read-only observations; it does not click, focus, fill,
submit, navigate or invoke product handlers. The suite deliberately ends at
the predecessor's wire-level token/whoami boundary and does not claim Matrix
sync, encryption or Rooms arrival.

Live state, PKCE verifier and challenge, authorization code, mocked tokens,
headers and request bodies remain in memory and are registered for artifact
redaction. Each run records one attempt, zero retries, all 26 identities once,
sanitized protocol observations, trusted native actions, renderer/APK/profile
provenance, stage durations and pass/failure captures. Cleanup releases paused
requests, restores Fetch on both surfaces, closes CDP leases and forwards,
clears disposable Chrome, closes the app client and device, then runs artifact
redaction; cleanup failure remains a suite failure.

```bash
pnpm nx run trinity-e2e-android:oidc-login --skipNxCache
# Equivalent package command:
pnpm e2e:android:oidc-login
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns only the serialized `android-avd`
resource, and has a 20-minute Node timeout. CI places it on shard 4 after
`password-registration` under a 25-minute wrapper. Started-only diagnostics
use the `android-oidc-login` surface under
`dist/.playwright/trinity-e2e-android/<run-id>/android.oidc-login/`.

Local acceptance on 2026-09-17 used exact implementation revision
`1dfe492c8d1fc9e961cce741232689d4e30906f7`, a 49-file, 15,302,529-byte
production renderer manifest with SHA-256
`1ba8e44c94736fadf1453d519c78068cff1fc8f29edcdf325031ac66c276da35`,
and installed debug APK SHA-256
`2db3fbd72ead76976b118211fda166425b23bd798e2b6e69ce0cce411da1442b`.
Three sequential uncached native invocations passed unchanged on their first
attempt with zero retries:

- `mu5s48tb-ceb8553f-6770-49ae-9e97-2ab0a9f6047c` — 242.706 seconds;
- `mu5sa5zt-8d60fb16-30c9-4e9f-9d93-fa1feec1d163` — 244.891 seconds; and
- `mu5sfukg-6d2fd6a6-d3d8-45d5-9963-00d24af672f9` — 246.440 seconds.

Each invocation recorded all four stages and all 26 unique assertion
identities exactly once, with clean device, WebView, Chrome and Fetch teardown.
Each artifact contained 47 explicit `[REDACTED]` markers and zero raw matches
for the fixed authorization code, mocked access/refresh tokens or bearer-token
patterns. Two preserved diagnostic attempts exposed and fixed an incorrect
spinner-container assertion plus non-idempotent cleanup after the callback's
real document replacement. A third diagnostic attempt proved stages 1–3 and
showed that the predecessor's two fallback metadata routes are optional mocks,
not required requests; the fixture still serves their exact 404 responses.
Every repair began with a failing focused regression guard.

Browser invocation `mu5sltpy-25cbb353-c043-48ab-ad33-e62bb32f438e` then ran
the four exact unchanged predecessors sequentially with one worker and
`--retries=0`; all four passed in 7.386 seconds. The source and shared helper
hashes remained
`e9a0dadad15f155a3c69b49e06d8b4539ea7d7f446fd08cfaa565fa3ba6ecb8a`
and `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.

Local validation passed the 11-test focused migration guard, 106 registry and
workflow tests, `pnpm test` (44 tasks), `pnpm nx run-many -t typecheck` (48
tasks), `pnpm lint` (77 tasks), `pnpm stylelint`, `pnpm format:check`,
`pnpm architecture:check` (including all 65 registered suites), production
renderer build, Android host verification, and the documentation check,
assemble and eight-test browser gate.

Original-attempt hosted run
[`35253208614`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35253208614)
then exercised consolidated head `27bdb7028d635a29afab7bddbd3d0513ca6787d0`
through merge commit `ce2b3bcc5b7a43c3250d0d65b146313f72fc87ee`.
Its 49-file, 15,302,528-byte renderer manifest had SHA-256
`2ee8c14f1c8b6ac12c431fb830adbbb23323156c91ccd70ef88aa3052927ecda`;
the merge and feature trees both resolved to
`51799c0dc3524917d4b342a3a366583e56d14df5`, so the hosted APK was built
from the accepted feature tree. The pinned workflow provisioned the API 36,
`google_apis`, x86_64 Pixel 6 profile and verified the same renderer digest in
both `www` and the packaged Android assets.

Android shard 4 completed successfully. Dedicated artifact
`10517526548` recorded invocation
`mu5wwjc9-b6bcefd2-d6de-43a4-b933-8f6e15ccb753`: all four stages and all
26 unique identities passed on attempt 1 with zero retries in 409.730 seconds.
Both browser-owning stages recorded `com.android.chrome`, cleared profiles,
handled native first run and a suite-owned DevTools controller without an
installed ChromeDriver. The suite returned successfully only after fixture,
Chrome and CDP teardown, and the job's unchanged-worktree check passed. An
artifact-wide scan found zero raw fixed authorization-code, mocked
access/refresh-token or bearer-value matches; the hosted diagnostics emitted
no sensitive values requiring a redaction placeholder.

The hosted browser job passed all four exact OIDC predecessors sequentially at
retry zero as part of 317 passed and one intentionally skipped canonical tests.
Renderer, browser, shard 4, unit, lint, documentation, iOS and Electron jobs
all passed. The overall workflow conclusion was failure only because Android
shards 1–3 independently failed in pre-existing suites before or outside this
batch; none changed the successful OIDC artifact or its accepted inputs. Do not
retire or edit the Playwright predecessors. This mapping does not authorize
merging PR #677.

## Security settings journeys

`android.security-settings` preserves issue #725's canonical Security settings
definitions in `e2e/browser/journeys/trust/security-settings.spec.mts`, pinned at
SHA-256
`7da77f2e6b8d2091709ca6565bd54a08ed97115cce71e887ad1c46b6f5767fd9`.
Lines 51–84 define the fresh-account posture and recovery setup journey. Lines
86–136 define the 700×760 narrow verification journey, including the Android
branch at lines 105–121. The browser-only trust-fault test at lines 138–223
remains outside this native batch because its production hook is deliberately
unavailable on Android. The navigation helper remains pinned at
`43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81`,
the application helper at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
and the account helper at
`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.

The contract records five direct plus four direct predecessor assertions and
six inherited, stage-qualified Settings assertions: 15 unique identities in
total. The first stage creates and signs in a disposable account, opens
Settings and Security through native actions, proves the session, backup,
verification and setup posture, opens exact `/encryption/setup` with
`returnTo=/settings/security`, and returns safely. The second stage applies the
exact 700×760 desktop-trait profile, opens `/encryption/verify`, proves the
focused `Verify device` page, closes it natively, and proves exact
`/settings/security` with focused `Security` content. REST is limited to
fixture setup and observation; user journeys use Maestro-native actions. No
DOM action or production debug hook is introduced.

```bash
pnpm nx run trinity-e2e-android:security-settings --skipNxCache
# Equivalent package command:
pnpm e2e:android:security-settings
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns the serialized `android-avd` and
`synapse` resources, and has a 15-minute Node timeout. CI places it on shard 4
after `oidc-login` under a 20-minute wrapper. Started-only diagnostics use the
`android-security-settings` surface under
`dist/.playwright/trinity-e2e-android/<run-id>/android.security-settings/`.
Every stage records one attempt, zero retries, stage-qualified assertions and
sanitized captures; cleanup and artifact redaction remain aggregate failures.

Local acceptance on 2026-09-17 used exact implementation revision
`69fc7bab191a6aba60aa00ec015d5bf18d552e7e`, a 49-file, 15,302,529-byte
production renderer manifest with SHA-256
`dce4a99461f0df2e299f4899c8eaea6ef6bb417613f7f33b29e3793a2099a10a`,
and installed debug APK SHA-256
`bffd42128b7948504036ce8c934273d087fec6744bd11c2a57ef99a6eaf35ae6`.
Three sequential uncached native invocations passed unchanged on their first
attempt with zero retries:

- `mu5z7mq0-8156d4dd-42b3-41b2-a60c-bf0fa370a5ca` — 224.935 seconds;
- `mu5zd5jv-a1b4a650-250b-4694-b978-bf66c107276b` — 226.836 seconds; and
- `mu5zifyi-3baf7cab-6096-416e-8557-2f7abb341228` — 225.719 seconds.

Every invocation recorded both stages and all 15 unique identities exactly
once. The posture stages took 95.049, 96.623 and 96.933 seconds; the narrow
verification stages took 97.125, 95.862 and 95.476 seconds. Each artifact
contained 48 explicit `[REDACTED]` markers and zero raw bearer or Matrix access
token matches. Synapse data, emulator, WebView and client resources were gone
after cleanup, and the tracked worktree remained unchanged. The focused guard
passed all route, focus, fault-exclusion, cleanup and redaction mutation
controls.

Browser invocation `mu5zpx19-8bcccc27-7d2d-47e1-8b03-360449376cfc` then ran
the complete unchanged Security settings predecessor with one worker and
`--retries=0`; all three tests passed in 8.4 seconds. The source and helper
hashes remained exactly those pinned above.

Local validation passed the 8-test focused migration guard, 116 focused
registry/workflow tests, all 963 scripts tests, 48 typecheck tasks, 77 lint
tasks, stylelint, formatting, architecture and the 66-suite registry,
production renderer build, Android host verification, and the documentation
check, assemble and eight-test browser gate.

Hosted Android acceptance on 2026-09-17 used original attempt 1 of run
`35272414146`, job `105375646253`, against PR merge commit
`c9d556e309f70f1ecd08de92d7779a5b7c10c214` for consolidated head
`dc05e4cf40508525b68de852888d11289805022a`. The verified renderer artifact
`renderer-35272414146-1-c9d556e309f70f1ecd08de92d7779a5b7c10c214`
(artifact `10519237792`) contained 49 files and 15,302,528 bytes with manifest
SHA-256 `d65c80809695a4244d925796e1f9d68e445da3f88c0f977f24703f9c5a1270ad`.
The native job used API 36, `google_apis`, x86_64 and the `pixel_6` hardware
profile, and completed successfully with the tracked worktree unchanged.

Hosted invocation `mu6402vu-23ca4196-73e9-4e1f-8a53-633a6c93f086` passed on
its first attempt with zero retries in 306.687 seconds. Its posture and narrow
stages passed in 146.708 and 158.855 seconds, respectively, and recorded all
15 unique identities. The dedicated 510,878-byte artifact
`playwright-35272414146-1-c9d556e309f70f1ecd08de92d7779a5b7c10c214-android-e2e-android-security-settings-4`
(artifact `10524870004`, upload SHA-256
`14fed8163e0e75428d75255a3f24468044776720b2dc8c9bc93acdb493e2f458`)
contained 64 explicit `[REDACTED]` markers and zero raw bearer, Matrix access
token or access-token query matches. Both final screenshots showed the
expected real setup and returned Security settings states. Synapse data was
removed after the invocation, the emulator runner and diagnostic upload
completed successfully, and the job's final worktree guard passed.

Hosted browser acceptance followed on 2026-09-18 in original attempt 1 of run
`35288604411`, job `105426656010`, against PR merge commit
`d2ff834b3c28c68f082222ae1eac853226e5104c` for consolidated head
`106583d16520220c7946e947e21230194e2116d0`. Its verified production renderer
artifact `renderer-35288604411-1-d2ff834b3c28c68f082222ae1eac853226e5104c`
(artifact `10525800615`) contained 49 files and 15,302,528 bytes with manifest
SHA-256 `b0ba5ac0aaa106f016d43baa8229cfbc8825e0a10f8562f36459ecb80f122e52`.
Browser invocation `mu673ggw-44141553-b1ab-485e-996b-32ba525fa105` ran all
three exact Security settings predecessors at retry 0 with zero failures in
13.116 seconds: 3.924 seconds for posture and recovery setup, 4.761 seconds for
narrow verification, and 4.431 seconds for scoped Trust-fault recovery. The
75,757,260-byte browser artifact
`playwright-35288604411-1-d2ff834b3c28c68f082222ae1eac853226e5104c-e2e-browser-all`
(artifact `10525689272`, upload SHA-256
`4017fde3e8c2e046a02fdaff8fbd474dd24886d98aa3e9a1d098c1e2b20e0b64`)
preserves the JUnit and per-test attempt records.

The browser job itself failed outside this migration: the retained-stale-roster
case in `room-administration/kick-member.spec.mts` timed out while locating its
retry button on attempt 0, then passed its one diagnostic retry. The immutable
suite record contains 316 passed tests, one flaky unrelated test and one
skipped test; the Security settings cases did not retry. The earlier run's
Storybook timeout likewise remains unrelated and is not counted as acceptance.
The pinned Security settings predecessor and helpers remain unchanged. This
mapping does not authorize merging PR #677.

## Recovery-reset journeys

`android.recovery-reset` maps issue #726's four password-account recovery-reset
definitions in `e2e/browser/journeys/trust/recovery-reset.spec.mts`. The pinned
source owns 22 + 12 + 15 + 5 direct assertions for successful replacement,
password-cancel atomicity, original-key viability after cancellation, and the
Settings escape hatch on a fresh device. The shared setup and conditional UIA
helpers plus the application and server-observation helpers remain pinned by the
executable migration guard.

The predecessor is pinned at SHA-256
`fad6cee0f80c92770978a672129c66a1ab22c9a7504a1068970673cbca08b848`,
with application helper
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and account helper
`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.

The replacement drives primary and secondary installed packages with native
Maestro actions. It establishes real cross-signing, secret storage and key
backup on the primary package, then uses a clean secondary package for each
needs-recovery path. REST is limited to disposable-account setup and read-only
default-key, backup-version and master-key observations. Renderer access is
read-only and cannot click, focus, fill, submit, navigate or reload product UI.
Password and recovery-key flows remove secret-bearing Maestro image diagnostics;
suite diagnostics are text-redacted and scanned before publication.

Review hardening also blocks failure capture whenever the recovery-key display,
recovery-key input or a password input is populated. Focused fills hide the
native keyboard without sending an application-level Escape, so sidebar filters
and quick switchers retain their state until the journey explicitly dismisses
them. Stage records count only assertions that were actually written, and
two-package cleanup uses independent bounded ADB signals so cancellation or a
failed force-stop cannot prevent either package from being cleared.

```bash
pnpm nx run trinity-e2e-android:recovery-reset --skipNxCache
# Equivalent package command:
pnpm e2e:android:recovery-reset
```

The target is uncached and serial, builds both Android packages, owns the
serialized `android-avd` and `synapse` resources, and gives both the Node test
and invocation runner 45-minute deadlines. Hosted evidence from run
`35331679110` showed the first three
stages passing but consuming 26 minutes 24 seconds under nested virtualization;
the 30-minute Node-test deadline then cancelled the fourth stage. The bounded
test and runner budgets are therefore 45 minutes, inside a 50-minute CI command
budget.
CI runs it on shard 4 immediately after runner smoke and before the
long retained migration chain, so an unrelated later-suite failure cannot
suppress its original-attempt evidence. Started-only diagnostics use the
`android-recovery-reset` surface under
`dist/.playwright/trinity-e2e-android/<run-id>/android.recovery-reset/`.
Every stage records attempt 1, zero retries, exact source ownership and bounded
two-package teardown. Do not retire or edit the four Playwright predecessors
until all required local and original-attempt hosted evidence is accepted. This
mapping does not authorize merging PR #677.

The first hosted run of the original implementation exposed a shared-login
regression before this suite started: `android.identity-presence` lost native
focus between separately measured and executed username/password actions. The
repair removes keyboard traversal from login and resolves the target point
inside the same Maestro flow that taps, erases and enters text, so a package
switch cannot stale the coordinate. Exact identity regression invocation
`mu6gh6do-d1a0783b-b530-40b4-ae5d-5228641b981c` then passed all three stages on
attempt 1 with zero retries: DM avatar in 81.054 seconds, member presence in
91.429 seconds and DM presence in 64.189 seconds.

Final post-review local acceptance on 2026-09-18 ran three unchanged full-suite
invocations: `mu6lu0t6-aa003754-7124-42c8-9e4d-b07f19ab6962`,
`mu6mj1iw-d4c2a360-f27a-4803-9144-3c3927a7c7c7`, and
`mu6n8c5t-7f87e51f-0274-42c1-8c28-2b7e8e8b9534`. Their uncached Nx targets
passed in 19 minutes 19 seconds, 19 minutes 29 seconds, and 19 minutes 28
seconds, respectively. Every invocation recorded attempt 1, zero retries, four
passed stages, 54 distinct assertion artifacts, and exact actual/expected
counts of 22 + 12 + 15 + 5. The final run's stage durations were 347.880 seconds
for replacement, 261.850 seconds for password-cancel atomicity, 294.502 seconds
for original-key viability, and 206.513 seconds for the Settings escape hatch.
Each retained artifact had exactly eight final device/WebView screenshots, at
least 220 explicit `[REDACTED]` markers, and zero bearer-token, Matrix
access-token, authorization-header or access-token query matches;
secret-bearing Maestro raster diagnostics were absent. Visual review confirmed
the ready Security posture for replacement, cancel and original-key stages and
an empty recovery-key input in the escape-hatch proof.

Exact canonical predecessor invocation
`mu6jb2q8-1364090f-5ee8-4b7b-8034-55382c548c77` passed all four Playwright
cases at one worker and retry 0 in 25.6 seconds. The keyboard regression was
covered by sidebar-filter invocation
`mu6k86oo-0dd7af67-0b30-41aa-bbbe-8195c2a64ec8`, which passed both stages and
retained the filter until its explicit Escape, plus exact quick-switcher
diagnostic `mu6lnohf-d99bc2a0-2810-4583-8fd1-b14e9d8dbc65`, which retained both
queries and dismissed only on the journey's explicit Escape or result choice.
The temporary local case selector used for that diagnostic was removed before
commit. Repository validation passed all uncached workspace typecheck and lint
targets, 975/975 script tests, 38/38 focused review tests, stylelint, format,
architecture and assembled documentation checks.

At clean hardening commit
`a733fa89049594fb2b7d39548db6517766fd37be`, the fresh 49-file production
renderer contained 15,302,529 bytes with manifest SHA-256
`96f33fb156b154a96e9347a7a35685a51c58568f39692b9c76dd5ffd39f37f92`.
Primary and secondary APK SHA-256 values were
`9cb2866a5ce8dbbac32a18104188dc823749720d842bab54a2273ba79edff460` and
`9829af971ba624214769b0b76d8b8164889042a6e7066f601023b1fccaf9465c`.
Android runner-smoke invocation
`mu6o1mhp-829ad963-c95d-433f-ab31-669c76ded298` passed against that exact
renderer in 105 seconds with clean Synapse teardown. Final identity regression
invocation `mu6o3zek-82e6b9fb-9e27-4f57-9b6a-aac37b9f9ce1` passed all three
stages at attempt 1 and retry 0: DM avatar in 82.590 seconds, member presence in
90.216 seconds, and DM presence in 64.673 seconds.

Original-attempt hosted acceptance completed on 2026-09-18 in run
`35336779408` against consolidated head
`84b6ad4c3b64970f7899495da4e16427a9e8fa37` and PR merge commit
`27d6d67ec7e350e9d25c92cf91cdbcd5d6b26c53`. The verified production
renderer artifact
`renderer-35336779408-1-27d6d67ec7e350e9d25c92cf91cdbcd5d6b26c53`
(artifact `10543558455`) contained 49 files and 15,302,528 bytes with manifest
SHA-256 `acac65af907328e0a8a2518799aef43af877543a963da993fa02b5ab454bf6eb`;
its downloaded ZIP had SHA-256
`5a10021819b7d1a834bb51b0b0dcc16b768c5f1ec4b6b4102a1bfeec5983c0c0`.

Hosted recovery invocation
`mu6ukogt-220bebf8-6708-40a4-8f76-e4b943e8d7c2` passed in 1,828.144
seconds at attempt 1 and retry 0. Artifact
`playwright-35336779408-1-27d6d67ec7e350e9d25c92cf91cdbcd5d6b26c53-android-e2e-android-recovery-reset-4`
(artifact `10547971079`, downloaded ZIP SHA-256
`42eddbced639cf6d8488175e4358499bb6de06c5ed263f49af5437119e943e75`)
records four passed stages in 568.240, 435.417, 482.695 and 339.862 seconds.
The immutable report has the exact 22 + 12 + 15 + 5 assertion counts, 54
distinct assertion artifacts, zero failures and eight final device/WebView
screenshots. Visual review confirmed the three ready Security postures and the
fresh-device escape hatch with an empty recovery-key field. The artifact has
324 explicit redaction markers and no bearer token, Matrix access token,
authorization header or access-token query match. It also records clean
Synapse data removal and teardown after the recovery invocation.

The same shard continued through Identity, Room Settings, Space Settings,
member-role, Room Widget and password-change suites before failing in the
unrelated `android.clear-all-data` suite. That later case could not focus the
second erase-confirmation input; recovery had already completed and uploaded
its passing artifact. The shard failure is retained as an independent
reliability defect and is not represented as a green recovery result.

The original-attempt browser job passed with 317 tests, one intentional skip,
zero failures and zero retries. Its artifact
`playwright-35336779408-1-27d6d67ec7e350e9d25c92cf91cdbcd5d6b26c53-e2e-browser-all`
(artifact `10544158004`, downloaded ZIP SHA-256
`49f50c0a38d50fd6c9c0a2cb28f36311b536154bc7cde9682899501a5313d20f`)
records all four exact recovery predecessors at retry 0 in 10.680, 9.731,
10.005 and 9.835 seconds. The following SSO-recovery predecessor also passed
at retry 0 in 8.213 seconds, preserving the next batch's baseline. The four
recovery predecessors remain unchanged and enabled. This acceptance does not
authorize merging PR #677.

## Legacy SSO journeys

`android.legacy-sso` preserves issue #723's three canonical legacy Synapse/Dex
definitions in `e2e/browser/journeys/accounts/sso-login.spec.mts`, pinned at
SHA-256
`04bf21437efd4da47398e93df607bf35dbcd8aba00159607a9a95f96ca6e9b12`:
lines 29–76 own real provider sign-in and persisted-session proof, lines 78–107
own rejection of an unverifiable callback without spending its one-use token,
and lines 109–198 own the silent forged callback during a live provider flow.
The token fixture helper remains pinned at
`e669c3b588e788c37fab77a7e427a38286de46cffafb228fcf27ae32c70a99b3`,
the application helper at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
and the real Dex provider configuration at
`b994b7e7c7de5fc103079b82d379a3dd8d022a1468796d6f8f35628c55c585d5`.

The executable contract records exactly 23 assertion identities in the
predecessor's 4 + 4 + 15 shape. The first stage classifies the real Synapse as
legacy password plus SSO rather than delegated authentication, completes the
real provider, reaches Rooms, then force-stops and relaunches the installed host
without clearing state to prove persistence. The second stage mints a real
unspent token in an isolated host-browser fixture, injects a mismatched Android
deep link, proves the exact verification error and non-Rooms route, then redeems
and revokes the same token independently for the exact harness MXID. The third
stage pauses a legitimate flow at Dex, injects a forged callback, proves the
silent completing surface's wordmark, landmark and desktop card geometry,
proves the freshly minted token remains independently redeemable, then uses
native Back and a fresh legitimate provider round trip to reach Rooms.

Trinity actions use measured Maestro input in the installed WebView. Dex opens
through the production Capacitor Browser handoff in a real Chrome Custom Tab;
Maestro completes Chrome's native first-run prompts and localhost certificate
warning when present, then fills and submits the pinned Dex form. A disposable
Chrome profile, bounded command line and native Chrome setup preserve loopback
and certificate handling without installing the Playwright Android driver.
UIAutomator proves package ownership. A bounded DevTools-backed readiness probe
observes the exact form controls, then the credential flow switches to the
native hierarchy so hosted DevTools latency cannot stall input. CDP never
operates Trinity or Dex. Host Playwright is restricted to the isolated
adversarial-token fixture and cannot stand in for native provider completion.

Provider credentials, Matrix login tokens, access tokens and every persisted or
forged state value are registered as secrets for artifact redaction. Each stage
records pass/failure device and WebView proof, one attempt, zero retries, source
ownership and bounded cleanup. Chrome command-line/profile state, observers,
host-browser contexts, Matrix observation sessions, WebViews, the device and
Synapse are all closed through aggregate cleanup.

```bash
pnpm nx run trinity-e2e-android:legacy-sso --skipNxCache
# Equivalent package command:
pnpm e2e:android:legacy-sso
```

The target is uncached and serial, depends on
`trinity-android:build-prebuilt`, owns `android-avd` plus `synapse`, and has a
20-minute Node timeout. The CI registry places it on shard 2, and its wrapper is
bounded at 25 minutes. Started-only diagnostics live under
`dist/.playwright/trinity-e2e-android/<run-id>/android.legacy-sso/` and use the
`android-legacy-sso` surface.

The three frozen installed-Android validations used exact production renderer
commit `227be7dd8956fe46f4d55e4d66c253fb42bb748f`. Its manifest describes a
15,302,529-byte production bundle and has SHA-256
`de003770a4566dbb1c5f60f1094f3b66d830377a1cacfa0971b34ab6363d4b16`.
The installed debug APK has SHA-256
`3783d892327a401939acad7516c6eb8053f8a49c6e491a74a720e6897dc8ca93`.
All three ran on the `Trinity_API_36` Google APIs x86_64 emulator. The first
two stages used `PIXEL_5_ACCOUNT_PROFILE`, the geometry stage used
`DESKTOP_ACCOUNT_PROFILE`, and every run passed on attempt 1 with zero retries,
all three stages and all 23 identities:

- `mu5l59ay-315ede66-ba0b-4008-84b6-80cd85cd2175` passed in
  398,637.858 ms (395,347.261 ms attempt); its stages took 139,973.284,
  4,108.561 and 223,793.805 ms.
- `mu5legsw-200972e9-80fe-4068-bab6-cedf800a6a62` passed in
  398,123.629 ms (394,344.041 ms attempt); its stages took 139,438.789,
  3,449.962 and 224,259.364 ms.
- `mu5lnifz-23855386-e1e5-4306-9c50-94025415021b` passed in
  395,206.840 ms (391,304.655 ms attempt); its stages took 136,934.524,
  3,460.072 and 223,888.540 ms.

Each receipt preserves native Chrome/Dex ownership, shell deep-link injection,
device and WebView pass captures, and clean observer, browser, device and
Synapse teardown. A hidden-file scan across all three artifact roots found zero
files containing the fixed provider password, a `syt_*` Matrix login token, or
either timestamp-shaped forged-state value; it found 370 explicit
`[REDACTED]` markers.

The executable mutation table rejects all eight required weakenings:
legacy/delegated action classification drift, persistence loss, forged-state
acceptance, token-consumption weakening, in-flight stash loss, callback
geometry/accessibility weakening, cleanup loss and redaction loss. The focused
migration, registry, CI and warning guards pass 119/119 tests.

The exact retained predecessor ran with one worker and zero retries as
invocation `mu5lxksp-ac7a52f2-2e95-4240-be35-d2e20a62af93`. All three tests
passed in 13.173 seconds: provider sign-in and persistence took 3.829 seconds,
unverifiable callback refusal took 2.496 seconds, and in-flight forged callback
recovery took 6.260 seconds. Synapse teardown completed cleanly.

Local validation passed `pnpm test` (44 tasks), `pnpm lint` (77 tasks),
`pnpm nx run-many -t typecheck` (48 tasks), `pnpm format:check`,
`pnpm stylelint`, `pnpm architecture:check` (including all 64 registered
suites), the 29 focused CI/warning-policy tests and `git diff --check`.

Independent review resolved two documentation-only findings and found no
unresolved code findings. Hosted attempt 1 run `35218785980` tested exact merge
tree `74098754eaca5ce4c988044de083cf97ec11484f` and produced a verified
15,302,528-byte renderer artifact for merge commit
`8169200731f2850005c17dfa6452b5d5daee5cee`. Its original legacy SSO attempt
`mu5hn5fg-3ef5266c-e083-4743-91a3-1491317e49e4` was diagnostic rather than
accepted: Maestro completed the real certificate-warning and all three Dex
control observations in 155 seconds, after the then-current 90-second signal
had expired. Artifact `10496029272` preserved the attempt-1/zero-retry failure,
and the runtime now keeps the same real-provider proof within a guarded
four-minute readiness bound under the unchanged 20-minute suite budget.

Hosted attempt 2 run `35222999256` tested exact merge tree
`f4000b30624ecdf4862b3b24e6a328047ac9d78f`. Renderer artifact `10497344842`
verified all 49 files and 15,302,528 bytes for merge commit
`146d5ed2aa9bcdcaa8d48e8a305dd101bcc97728` with manifest SHA-256
`dbfd70d6e75c73c788bfad02bb7771bfc09ce4c58a08d239361c9c4590fd28ff`.
Its original legacy SSO invocation
`mu5j7pmv-5e28145d-e98b-41c9-85a0-1b663e3dede3` was also diagnostic:
artifact `10498257395` proves that both exact readiness probes passed, then
DevTools hierarchy augmentation stalled credential input and exhausted the
stage budget. The final flow therefore confines DevTools to readiness, uses the
native hierarchy for credential actions, normalizes a valid product-autofocused
homeserver input through a verified native Tab transition, and gives the exact
Dex-control readiness wait 180 seconds within the four-minute provider bound.

Final acceptance now requires a fresh original-attempt hosted
Android/browser/renderer artifact audit from the exact consolidated tree. Do
not retire or edit the predecessors. This mapping does not authorize merging PR
#677.

## SSO recovery-reset refusal journey

`android.sso-recovery-reset` maps issue #727's single legacy-SSO refusal
definition in `e2e/browser/journeys/trust/sso-recovery-reset.spec.mts`. The
predecessor is pinned at SHA-256
`4d4a15f2518a40a1845dfa965d03757697be9d9613030d757b2c74004441ed0b`.
Its availability guard, refusal case and key-backup helper own nine direct assertion identities:
non-empty preconditions, both visible reset controls, the
exact identity-provider refusal, absence of a new recovery key and password
prompt, and unchanged server-side master key plus backup version.

The replacement uses only `session.synapse.ssoReset`. A disposable host
Chromium context completes the real pinned Dex flow to obtain a short-lived API
observation session, seeds cross-signing, an empty key backup and the recovery
pointer needed by native Security navigation only when missing, and reads the
exact server state before and after the product flow.
The installed Pixel 5-profile app performs its separate real SSO login through
the native Chrome handoff. Every Trinity and Dex action is driven by Maestro;
renderer access is read-only. The refusal therefore proves that Trinity stopped
before destructive reset work, rather than merely showing the expected copy
after deleting the backup.

```bash
pnpm nx run trinity-e2e-android:sso-recovery-reset --skipNxCache
# Equivalent package command:
pnpm e2e:android:sso-recovery-reset
```

The uncached serial target owns Chrome, the API 36 emulator and disposable
Synapse/Dex resources. Its Node and Nx invocation budgets are 20 minutes; CI
runs it on shard 2 immediately after `android.legacy-sso` and before
`android.native-shell`, with a 25-minute command bound. Started-only diagnostics
use the `android-sso-recovery-reset` surface under
`dist/.playwright/trinity-e2e-android/<run-id>/android.sso-recovery-reset/`.
Provider credentials, login/access tokens and master-key material are redacted
and scanned; the compared backup version is never written to artifacts. Maestro
images inside flow artifacts are removed.
Every report records exactly one attempt, zero retries, one stage and nine
assertions with aggregate provider, API session, WebView, app-data and device
cleanup.

Local acceptance used unchanged source and renderer inputs at consolidated base
`8f239378586a8cf0b4b75769faa24d0183c00e85`, renderer manifest
`8fe22f3213994fe5df0b14822425057295bd768c0f5e3dd668c07de1e68f80f4`.
Invocations `mu725vcx-fdafbd2b-72da-48fa-8305-ff28ad24235d`,
`mu72b8ox-94ee8652-33cb-4b5c-9b59-d6f4eae3e265` and
`mu72gmyo-5ffd381f-8879-4d5a-b49d-d718b0487743` each passed the single stage
on attempt 1 with zero retries and all nine identities in 218,198, 222,229 and
212,216 ms. Their native and WebView captures show the required refusal on the
Pixel 5 profile; full invocation scans found no provider credential, Matrix
token, bearer header or master-key material, no Maestro flow image survived,
and every run completed provider, API-session, client, app-data, device and
Synapse teardown. Twelve effective source-mutation controls protect both
non-vacuous preconditions, refusal/absence outcomes, server-state atomicity,
owned cleanup, image removal, redaction and scanning. Exact predecessor
invocation `mu71tohi-8a5aabd7-0c8d-4a16-88c3-6a36983de144` passed its sole
Chromium test in 5.7 seconds with one worker and retry 0, followed by clean
Synapse teardown.

Repository validation and final review passed at this source revision. The
predecessor remains enabled. This mapping does not authorize merging PR #677.

Hosted run `35358912583` at consolidated head `d26dc780` and merge revision
`88fcadf8` supplied accepted original-attempt renderer and browser evidence.
Renderer artifact `10554016155` contains 49 files that match manifest digest
`c1fc90ef14c32f21d2e1e63b04b503dd21039d0d86fa4a1e3e6eb8d85d7fab70`;
browser artifact `10554552383` records the exact predecessor passing in 11.024
seconds with zero retries. Android shard 2 stopped in unchanged
`android.legacy-sso` before this target started: repeated Chrome hierarchy
timeouts were followed by ADB package and reverse-cleanup timeouts. No
`android.sso-recovery-reset` artifact exists for that run, so it does not
satisfy Android acceptance. The retained transport-loss evidence belongs to
the #665 reliability ledger and therefore required a fresh workflow attempt.

Fresh original-attempt run `35369628753` at consolidated head `97c89e37` and
merge revision `181c1501` completed the missing hosted acceptance. Android
artifact `10561477901` (`sha256:82f26f068131a06c07883236c2c99d748fff81c732f2949e8d3ecaa616898549`)
records invocation `mu779x2e-1162928f-5131-421c-b68c-cec1618b37b9` passing its
single stage in 266.107 seconds on attempt 1 with zero retries, all nine
assertions and no failures. It contains only `passed-device.png` and
`passed-webview.png`; structured scans found no credentials, Matrix tokens,
recovery secrets, master-key material or backup values, and Synapse cleanup
completed. Browser artifact `10557934912`
(`sha256:66a4647c949496a1c21bd40521fd5a450d931522b7d56054170fb02b305e726b`)
records the exact predecessor passing in 11.026 seconds at retry 0 within the
317-passed/one-skipped canonical suite. Renderer artifact `10558275536`
(`sha256:1adae98240d61810c6aa4fff12a90bcc6bc7bec84ad9af8d5a416eccdad17569`)
contains 49 independently rehashed files at manifest digest
`2a016dac95e7c6a0afa14445ba1e3c6fc309dd5a5f07405d86338fe2c900d2ef`.
Together with the local acceptance above, this satisfies issue #727 without
retiring its Playwright predecessor.

## Message-authenticity shield journeys

`android.message-authenticity-shield` maps both canonical definitions in
`e2e/browser/journeys/trust/message-shield.spec.mts`, pinned at SHA-256
`2ab9ceaa07b78d77aea844127b26ba16c7d9475322a7430a8f422186bafa9c9c`.
The plaintext definition owns two assertion sites. The real encrypted-room
definition owns 24 more; its nine geometry sites execute in both LTR and RTL,
for 26 unique direct assertion identities and 35 stage-local direct assertion
records. Application and account helper sources are pinned separately by the
executable migration contract. Device B's draft goes through the shared
`sendComposerDraft` helper, which taps Send on a mobile target (d3b27323).

The plaintext stage creates and joins a genuine unencrypted private Room through
Matrix REST, sends one exact event, signs the reader into the installed primary
APK and opens the Room with Maestro. It proves the exact timeline body is visible
and that no authenticity shield exists. The encrypted stage establishes recovery
and cross-signing through native Security UI on device A, signs the same Account
into the independently installed secondary APK as unsigned device B, and composes
the long exact message through native input. After native reactivation, device A
must show that exact event with a real shield.

A separately named Room member places an `m.read` receipt on the observed event
through Matrix REST. Read-only renderer inspection then proves the exact reader
name, accessibility relationship, non-empty reason and detail, copy that does not
overstate interception, and the complete logical-trailing-edge/non-overlap
geometry in both writing directions. Maestro Tab traversal—not DOM focus—opens
the tooltip. Renderer direction setup is restored in `finally`; renderer code
never clicks, focuses, fills, submits or navigates product UI.

```bash
pnpm nx run trinity-e2e-android:message-authenticity-shield --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-authenticity-shield
```

The uncached serial target builds and installs both APKs, owns the emulator and
disposable Synapse resources, and has a 30-minute Node budget. CI runs it on shard
2 immediately after `android.sso-recovery-reset`, with a 35-minute command bound
and started-only `android-message-authenticity-shield` diagnostics. Passwords,
tokens and session secrets are redacted and scanned; flow-owned raster artifacts
are removed before retention. Reports preserve one attempt, zero retries, two
stages, 26 identities, 35 records, source ownership and aggregate two-package,
Matrix and device teardown.

Local acceptance used feature source
`f752550fffc005326c04eba3f1c1e0cccfbaf825`, production-renderer manifest
`sha256:18fd533629d21518f24e23071c7500350ede445e0400b8d64b903b2d3b1c8266`,
primary APK `sha256:30a8574e4986c3048fd410b9b44e4c570e2be249e8c765f8d0007da401ec3139`
and secondary APK
`sha256:677751d082c57732bcbf67c6d8c47b3a69a6edecba431fa74f4f50b3ec1e4bfe`.
Invocations `mu7fqrnm-04698b02-ec24-4e60-a633-d76a9620188b`,
`mu7g0lx7-45ed7614-7b17-42a8-9922-0b00186da05a` and
`mu7g967q-a4b6b844-d9e7-4112-8805-605abbf93bc2` each passed both stages on
attempt 1 with zero retries and all 26 unique/35 stage-local assertion records.
Their plaintext/encrypted stage durations were 91,105/231,278,
88,050/233,306 and 87,806/233,329 ms. Every LTR and RTL geometry record passed;
both logical trailing gaps were exactly zero, all three overlap checks were
false and the receipt remained inside the virtual row. Each invocation retained
the native and WebView success captures for the plaintext reader, unsigned
sender and shield reader, removed flow-owned raster artifacts, passed the exact
secret/token scan, and completed application-data, device and Synapse teardown.

Exact predecessor invocation `mu7fownh-8c6417ba-a872-49c7-84ea-58448449f0d0`
passed both Chromium definitions with one worker and retry 0 in 12.1 seconds,
followed by clean Synapse teardown. The predecessors remain enabled.

Hosted acceptance on 2026-09-18 used exact consolidated head
`ac760a319a0e0cc8e1688edd10393b1f5c31b34c` in merge
`52c95b94a7b80043a1ad39a7f2eb11757bda18b9` on run `35396085035`. Android
shard 2 job `105765823381` passed the target on its original attempt. Invocation
`mu7ho9mz-908edb78-88d2-4cbd-a00a-0912c559af76` completed in 527,521 ms with
zero retries: plaintext passed in 135,465 ms and the unsigned-device stage in
390,585 ms. Artifact `10572053853` is 2,083,658 bytes with GitHub digest
`sha256:44381b6759349a98df126fe513c32d5a15cc31ed2d66ed2f1776c22fa4fbc1b5`.
Independent inspection counted exactly 35 assertion files and 26 unique
identities. Both LTR and RTL observations retained zero-pixel shield and receipt
trailing gaps, no content/shield/receipt overlap, direct body children and the
receipt inside its virtual row. The focused success state names
`msg-shield-red`, contains the exact wrapped message and cautious tooltip copy,
and the assertion records preserve the exact receipt reader label. The artifact
retains only six success rasters across the primary and secondary packages plus
their six JSON/UI/surface companions; flow-owned temporary images were removed,
the post-redaction secret/token scan passed, both application packages were
cleaned, Synapse data was removed and the job's unchanged-worktree check passed.

Browser job `105765823223` published artifact `10569017744` (GitHub digest
`sha256:fb32586b65c0bd48d6e32a6577e1a695e4529e3f7e6c0f6cf870864cdeb620ce`)
after 317 tests passed and one intentionally skipped in 18.8 minutes. The two
exact shield predecessors remained enabled and passed at retry 0; CI's one-retry
configuration has `failOnFlakyTests`, so the green job did not hide a recovered
retry. Renderer job `105765453916` published artifact `10568066430` (GitHub
digest
`sha256:fc3401b651968cc2807cc6a34ab4f4859d671fdea69304e222486825c8f9fda5`)
and independently verified all 49 production files, totaling 15,302,546 bytes,
at manifest digest
`52c52a0fbb924ed2815fed13ed27903e00407a14ba7fbf4585840214cb91c708`
for the same merge SHA. The full workflow is not claimed green: unrelated
Android shard 4 failed and shard 3 remained non-terminal when this audit closed;
those broader-suite reliability results remain owned by issue #665. Together
with the frozen local evidence, the owned Android, browser and renderer jobs
satisfy issue #728 without retiring either Playwright predecessor. This mapping
does not authorize merging PR #677.

## Cross-user verification journeys

`android.cross-user-verification` maps both definitions in
`e2e/browser/journeys/trust/verify-user.spec.mts`, pinned at SHA-256
`4d5ddb20adfc9f661abb05f081057894ec6e4120a35ddb5f067dc4158dab6ebd`.
The shared journey owns five direct assertion identities: the initially hidden
and subsequently visible members panel, the exact counterpart row, member-info
panel and requested/waiting verification page. The delayed counterpart case owns
one additional identity, for six unique direct assertion identities and 11
stage-local direct assertion records across the ordinary and delayed stages.

Each stage registers two disposable Accounts, assigns the counterpart a unique
display name and creates a joined private Room through Matrix REST. The installed
primary and secondary APKs each establish a genuine cross-signing/recovery
identity through native Security UI. Maestro then reactivates the primary app,
opens the Room, chooses the available narrow or wide members control, selects the
exact counterpart and activates Verify. Read-only renderer inspection proves the
verification host is visible in its requested or waiting stage; this suite does
not claim the SAS round trip owned by the protocol suite.

The delayed stage installs a bounded CDP Fetch controller only on the primary
WebView and only for POST `/_matrix/client/v3/keys/query` bodies whose
`device_keys` map contains the exact counterpart MXID. Matching requests remain
paused through the native Verify action, wait 15 seconds and then continue.
Unrelated queries continue immediately. Cleanup releases every pending request
before disabling interception, including when the stage fails.

```bash
pnpm nx run trinity-e2e-android:cross-user-verification --skipNxCache
# Equivalent package command:
pnpm e2e:android:cross-user-verification
```

The uncached serial target builds both APKs from the verified renderer, owns the
emulator and disposable Synapse resources, and has a 30-minute Node budget. CI
runs it as shard 2's first dedicated suite, before unrelated legacy SSO and
message-authenticity coverage can fail the serial shard, with a 35-minute
command bound and started-only
`android-cross-user-verification` diagnostics. Credentials, access tokens and
session secrets are redacted and scanned. Failure capture is suppressed while
a populated recovery-key or password surface is visible, and flow-owned raster
artifacts are removed before retention. Reports preserve one attempt, zero retries, two
stages, six identities, 11 records, source ownership and aggregate controller,
two-package, Matrix and device teardown.

The shard retains its existing fail-fast contract: a cross-user failure remains
red and prevents later shard-2 suites from starting; no suite failure is
converted to success.

Local acceptance is frozen on consolidated source `d6039ebc` (Git tree
`aa5403b0491c62fd8eb1e123418e1defd8dfb28c`, byte-identical to reviewed
feature source `d1cf709f`). Three unchanged installed-Android first attempts
passed both stages with zero retries:

- `mu7nyn0k-8486ef10-1d1c-4e84-88a4-2642c8bd4d6a`: 271.428 and
  276.523 seconds;
- `mu7obws3-4da93067-7048-4e97-8351-b0e93e5f94b6`: 271.947 and
  280.040 seconds;
- `mu7op8aq-981ceca5-9ec7-4295-96fe-643dca48454e`: 273.504 and
  277.254 seconds.

Every run records both installed package IDs, two passed stages, six unique
identities, 11/11 stage-local records, attempt 1 and zero retries. Their
immutable local renderer manifest identifies `d1cf709f` with manifest SHA-256
`7d6dc058944890efee6966209c24f54f550c1b59151659e34bc775ac4af687eb`;
the proven Git-tree identity ties those APKs and renderer bytes to the
consolidated source. The exact two Playwright predecessors passed sequentially
on `d6039ebc` at retry 0 in 10.3 and 23.2 seconds under invocation
`mu7pwgsk-ab9a1d74-b401-4087-9f02-cc4c137d7fc4`. Full repository validation,
the focused mutation/secret-capture guard and independent review passed with no
remaining Critical or Important finding.

Hosted run `35415982945` used consolidated source `4d45c0f7` in merge
`d8a4ca598a03834b6e1f3804740db3d7d043d7a8`. Its immutable renderer artifact
`10575729400` contained 49 verified files with manifest SHA-256
`250e44528ee8f826c2c172214458024e2500bbfe401d90fb293256dd5f2f4d58`.
The reordered shard reached this suite before unrelated coverage and exposed a
hosted-only lifecycle failure in artifact `10576363734`: the ordinary stage
recorded all five assertions and its pass captures, but final cleanup attempted
to restore CDP overrides on the secondary WebView after Android had frozen that
background app. The restore commands timed out, so the stage remained red and
the delayed stage correctly did not start under the shard's fail-fast contract.

The lifecycle fix closes the secondary WebView immediately after its recovery
identity is established, before Maestro reactivates the primary app. The outer
cleanup retains its idempotent close for partial-stage failures. A source-shape
guard first failed on the missing ordering and then passed after the change.
Using a locally built renderer based on source `4d45c0f7`, held unchanged
across all three post-fix runs, with manifest SHA-256
`84f96cb7aebccddc9a1ddc4501d81975f38f944616b46627ee68e8ff2d563c6c`,
three unchanged post-fix installed-Android first attempts passed both stages:

- `mu7tusyw-67836ff4-38df-4a76-b7cc-0b66935bbc5f`: 277.711 and
  278.695 seconds;
- `mu7u8bob-a5288c52-4e8a-48e2-bb76-8885e7a9460d`: 279.966 and
  281.955 seconds;
- `mu7umdn7-a8fb6540-4872-4f0f-9a88-146eb287d5ed`: 280.605 and
  282.727 seconds.

Each post-fix report again records both installed package IDs, two passed
stages, six unique identities, 11/11 records, attempt 1, zero retries and zero
failures; Synapse and emulator teardown completed cleanly. The focused guard,
all 999 script tests, Android E2E typecheck and Android E2E lint also passed.

Hosted acceptance on 2026-09-19 used exact consolidated source
`f630388d70080e1b01d7fc56d064941429d689a2` in merge
`425ca38f2bdc1cbb31bf6d195479c18d9add87c0` on run `35420445338`. Renderer
job `105837028471` produced artifact `10576787771` (GitHub digest
`sha256:52c571b2b03b060e0add563c335f5055eeef6fe1d4cc2ec902d5f33d4aae55e0`):
49 independently verified files / 15,302,546 bytes with manifest SHA-256
`5be2751d604412b91b43aea97700e8f72b7e4f0a6b629596d4d94d9a451d7ffb`.

Browser job `105837200696` passed with artifact `10577584301` (GitHub digest
`sha256:4b012b28f878c2a14a9008e8882953efd95d364d5d54841631e1fa64b7648148`):
317 tests passed, one was skipped and none retried. The two exact retained
predecessors passed at retry zero in 17.989 and 31.188 seconds.

Original-attempt Android shard-2 job `105837200731` passed and produced
artifact `10579461815` (GitHub digest
`sha256:6b46846aec084b26406932445a111b066dd7edc8e78e71e2be5ef68217749415`).
Invocation `mu7vlaee-890d689c-a8ec-407b-a479-352e3d34b2af` records the ordinary
and delayed stages passing in 446.642 and 460.797 seconds, attempt 1, zero
retries, both installed package IDs, six unique identities, 11/11 assertion
records and no failures. The delayed record proves one exact matching request
held for 15,000 ms. All 24 retained `SECRET_TEXT` values are redacted, no
bearer-like credential survives, only the four pass captures remain, and
Synapse, app, WebView, controller, device and worktree cleanup completed. This
evidence satisfies the migration while both Playwright predecessors remain
enabled. It does not authorize merging PR #677.

## Composer-draft persistence journey

`android.composer-drafts` maps the complete canonical definition in
`e2e/browser/journeys/conversations/composer-drafts.spec.mts`, pinned at
SHA-256
`16088cad5e1ecc4a6933c905b3963b6c46fa5cf5ffe9be82439269b22a0730cd`.
Its shared application and Account helpers remain enabled and are pinned at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
The migration records the predecessor's four direct assertions and four
composer-readiness helper calls as eight unique, stage-local assertion
identities.

The single installed-Android stage creates two distinct private Rooms through
Matrix fixtures and signs one disposable Account into the primary APK. Maestro
opens Room A and enters an exact unsent draft, proves Room B remains empty, then
returns to Room A and proves the draft restored. An independent host-side check
reads the exact `trinity.composer.drafts` entry from Capacitor's native
`CapacitorStorage.xml` through the invocation-owned device lease, parses its JSON
map and proves the exact `conversation:[accountId,roomId]` entry for Room A
equals the draft. The stage then force-stops and restarts the installed host,
reopens Room A, and proves the same draft restores after the cold relaunch.
Renderer access is observation-only; it does not read WebView local storage or
perform product actions.

```bash
pnpm nx run trinity-e2e-android:composer-drafts --skipNxCache
# Equivalent package command:
pnpm e2e:android:composer-drafts
```

The uncached serial target owns the emulator and disposable Synapse resources
and has a 20-minute Node budget. CI runs it on shard 2 immediately after
`android.cross-user-verification`, with a 25-minute command bound and
started-only `android-composer-drafts` diagnostics. Reports preserve one
attempt, zero retries, the exact source map and eight assertion records.
Passwords and both possible Android-IME draft variants are redacted before a
recursive text-artifact scan. Secret-bearing raster diagnostics are removed;
structured pass/failure captures remain. Application data, WebView state,
device and Synapse resources are cleaned on every outcome.

The first hosted implementation artifact was rejected even though its suite
passed: run `35431729209`, artifact `10583082884`, exposed incremental draft
prefixes in Capacitor Preferences `methodData` log lines. Exact-value secret
replacement could not redact prefixes. Follow-up `62fb43a6603a5935b3718cff64bb29cf32764e68`
therefore structurally redacts all Preferences and SecureStorage payloads before
publication and makes the composer artifact scan accept only exact
`[REDACTED]` payloads. Regression fixtures cover both a raw draft prefix and the
exact redacted form. The rejected artifact is not acceptance evidence.

Final local acceptance used consolidated source `62fb43a6` and its unchanged
49-file production renderer at manifest SHA-256
`306c23317bd8872ef4d7d937e443accd1213cfc538cac9f36513bd4d9b552d57`.
Three unchanged installed-Android first attempts passed the stage with zero
retries:

- `mu8a9bfd-4539a06f-accd-4480-838c-351d8c4f7dcf`: 166.051 seconds;
- `mu8aeozl-d7214d15-b8a8-402c-abb8-805104bfabf8`: 165.241 seconds;
- `mu8ajmw5-e5dafa35-d25d-4288-86f6-ba64d2f1d0c8`: 166.865 seconds.

Each report contains one passed stage, all eight unique/stage-local assertion
records, exact preference/account/Room metadata, no retry, no raster artifact,
no unredacted Preferences payload and successful teardown. Exact retained
predecessor invocation `mu837ry9-37ceeba0-e586-4d37-8490-ccdc5638992a`
passed its sole Chromium test in 5.6 seconds with one worker and retry 0,
followed by clean Synapse teardown.

Final hosted acceptance is original-attempt run
[`35439789485`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35439789485),
whose merge revision `5906e6c6addb3d97405dfbebba547b4f9ca79904` has
`62fb43a6` as its feature parent. Android shard-2 job `105888661023` produced
immutable composer artifact
[`10584116793`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35439789485/artifacts/10584116793)
(GitHub and downloaded ZIP SHA-256
`2dded415f4b94b8ccbd751b653067d89ea487cb5d9666c61ac0afed747112765`).
Invocation `mu8bf8sp-2c0cfe7b-1c76-4332-ad1e-0592ae373a96` passed its single
stage in 203.930 seconds: one attempt, zero retries, all eight records and exact
native preference metadata. The artifact contains 27 structurally redacted
Preferences payloads, no draft phrase, bearer or Matrix token, no raster file,
and clean Synapse teardown. The shard's later failure belongs to unchanged
`android.legacy-sso`; the composer target and unchanged-worktree gate passed.

Renderer artifact
[`10582888260`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35439789485/artifacts/10582888260)
verifies all 49 production files (15,302,546 bytes) at manifest SHA-256
`02d76d685a9756b2377bd9a134756c5284ade7fac10396e4e1586e9bc3573f4a`.
The redaction follow-up did not change the renderer or retained browser source;
original-attempt browser artifact
[`10581316166`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35431729209/artifacts/10581316166)
records 317 passes, one intentional skip and zero retries, with the exact
composer predecessor passing at retry 0 in 8.011 seconds. The predecessor
remains enabled and unchanged. This evidence accepts issue #730 but does not
authorize merging PR #677.

## Mobile composer-formatting journeys

`android.composer-formatting` maps the three Android-applicable mobile
definitions in
`e2e/browser/journeys/conversations/composer-formatting.spec.mts`, pinned at
SHA-256
`3e346da10d6b38c10928a824333f050916009fddffd3215331d4bcf723672b8c`.
The shared application, Account and navigation helpers are pinned at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`
and `43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81`.
The migration expands 36 direct assertion sites plus the three
composer-readiness helper calls into 39 unique, stage-local records: 12 for
selected Italic, 11 for Cancel/Preview continuity and 16 for compact larger
text. All desktop definitions and the three mobile Playwright predecessors
remain enabled.

The dedicated native-selection helper observes the exact textarea value and
uses renderer font metrics only to measure the requested word's center. A
750 ms Maestro swipe with a two-device-pixel drift performs Android's native
long press. Trusted pointer evidence, at least 450 ms before Android selection
takeover, and exact observed offsets prove the result. The helper never calls
DOM `focus()` or `setSelectionRange()`. The first stage selects only `hello`,
proves the 44×44 Format target and action-sheet viewport bounds, chooses Italic
through Maestro and observes the exact formatted value, dismissed sheet and
restored focus.

The second stage natively selects offsets 2–6 and proves both Cancel and
Preview preserve them. Keyboard dismissal first reads Android IME state: it
runs Maestro `hideKeyboard` only when the IME is shown, avoiding an accidental
Back navigation after mobile Cancel has already focused the Aa trigger. The
third stage enters its draft, navigates through the real Settings and
Appearance UI, selects Larger natively, force-stops the installed host and
relaunches it with a 320×720 viewport. It reopens the same Room and proves the
20px root font, draft restoration, visible in-bounds 44×44 Format/Send controls,
exact Preview content and final focus.

```bash
pnpm nx run trinity-e2e-android:composer-formatting --skipNxCache
# Equivalent package command:
pnpm e2e:android:composer-formatting
```

The uncached serial target owns the emulator and disposable Synapse resources,
runs once with zero retries and publishes started-only
`android-composer-formatting` diagnostics from shard 2. Text diagnostics redact
passwords and all draft variants before a recursive secret/native-storage scan.
The retained visual is captured only while the full-height modal action sheet
occludes the composer; its geometry record proves all four viewport bounds.
Application data, WebView state, device and Synapse resources are cleaned on
every outcome.

Final privacy-correct local acceptance used the unchanged application bundle
and three installed-Android first attempts with zero retries:

- `mu8o57ol-b72fd3d0-0db1-4169-940c-43077ddcd958`;
- `mu8ohfij-9cd99b8c-524a-440f-b975-3e90d8ef473a`;
- `mu8otu9t-9baba3af-ce57-4bfb-8ef8-5e3b910f357c`.

Each report contains three passed stages, exactly 12, 11 and 16 unique
stage-local assertion records, one attempt, zero retries, the exact
renderer/source map, one inspected modal-covered visual and clean Synapse
teardown. The preview record preserves its canonical identity while recording
only `{ "matches": true, "length": 4 }`; exact recursive scans found no raw
draft, selected word, bearer or Matrix token in text artifacts.

Replacement hosted run
[`35468767242`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35468767242)
uses feature head `e361d4d5` and merge head `e065f61e`. Browser artifact
[`10592976490`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35468767242/artifacts/10592976490)
records all three exact mobile predecessors passing on their first attempts in
4.883, 3.894 and 6.409 seconds. Its sole retry was the unrelated retained-roster
case owned by the wider reliability ticket. Renderer-E2E artifact
[`10592671029`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35468767242/artifacts/10592671029)
records 163 Storybook passes, nine production-renderer passes, nine intentional
skips, exact merge/bundle verification at manifest SHA-256
`b74f1818516e45fe5d85a9a653165b8a5711434bdcc4e8d07d19029bfe9583a6`
and clean Synapse teardown. Production renderer artifact
[`10591882231`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35468767242/artifacts/10591882231)
verifies all 49 production files (15,302,546 bytes) at the same manifest.
Hosted Android artifact
[`10593361441`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35468767242/artifacts/10593361441)
(`sha256:a0477e9951a04dd28ef05ef5d61440df62da3b4fbb6a1a20d5b0f77ea5eb16d0`)
records invocation `mu8w9xqa-e2024669-aefd-4ed8-b984-89d36230d76d` passing the
three stages on attempt 1 with zero retries in 227.962, 281.545 and 354.602
seconds. Its JUnit report records one test and zero failures; the report contains
exactly 39 unique canonical assertion records, three stage-local `passed.json`
records and the single inspected action-sheet visual. The privacy scan is clean,
the exact merge/bundle provenance is retained and Synapse teardown completed.
The Android shard failed only later in the unrelated
`android.space-settings-core` exact-contents lifecycle; the composer-formatting
target itself completed successfully. None of this authorizes merging PR #677.

## Composer mention journeys

`android.composer-mentions` maps both definitions in
`e2e/browser/journeys/conversations/composer-mentions.spec.mts`, pinned at
SHA-256
`4fff4a23bbabe797ca87e8ed8b2fdda537e4af1adb4c5396cbb3d0feccd4eb39`.
The shared application and Account helpers remain enabled and are pinned at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
The migration expands the predecessor's ten direct assertions plus two
composer-readiness helper calls into 12 unique, stage-local records: eight for
touch selection and four for keyboard acceptance. Both Playwright predecessors
remain enabled; they now send through the shared `sendComposerDraft` helper,
which taps Send on a mobile target.

Each stage creates a fresh reader/member pair and private Room through Matrix
fixtures, signs the reader into the primary APK and enters an exact partial
display name through the Android IME. The touch stage dismisses the IME so the
keyboard-resized native WebView exposes the suggestion, then uses a measured
Maestro tap to select the exact member. It proves the exact composer value,
sends it with a measured native tap on the composer's Send button, and proves the
sent `matrix.to` link, waits for the local echo to reconcile to a `$` event ID,
and independently reads that event from Synapse to prove the exact member is in
`m.mentions.user_ids`. It also proves the rendered link has the `mention` class,
font weight at least 600 and a nontransparent background. The keyboard stage
proves the exact member is highlighted, accepts it with a native Enter and
sends it with a native Send tap. Since d3b27323, Enter in the composer inserts a
new line on a mobile device, so both stages send through Send; Enter still
accepts a highlighted suggestion.

```bash
pnpm nx run trinity-e2e-android:composer-mentions --skipNxCache
# Equivalent package command:
pnpm e2e:android:composer-mentions
```

The uncached serial target owns the emulator and disposable Synapse resources,
runs once with zero retries and publishes started-only
`android-composer-mentions` diagnostics from shard 2. Text diagnostics redact
passwords, account/Room/member identities, composer values, links and event IDs
before a recursive secret/native-storage scan. Secret-bearing raster diagnostics
are removed. Application data, WebView state, device and Synapse resources are
cleaned on every outcome.

Local acceptance used the unchanged 49-file production renderer at manifest
SHA-256
`7a582752a627aeab5bbab168bc6fa311c0e761399d1cb13f0ab6165e3a6c01c5`.
Three unchanged installed-Android first attempts passed both stages with zero
retries:

- `mu8zya5w-34023670-4b9f-4838-98a5-225bcb1b1875`: 128.590 and
  101.270 seconds;
- `mu904k5g-2d679619-35e6-47cb-b31d-6b25951a6546`: 127.274 and
  102.630 seconds;
- `mu90anwu-06266e39-7d0c-47d8-9602-31fd5528d596`: 126.638 and
  100.567 seconds.

Each report contains two passed stages, all 12 unique/stage-local assertion
records, one attempt, zero retries, two pass records, no raster artifact and
clean teardown. Exact retained predecessor invocation
`mu90gwm8-6664a8c9-a97a-4322-b672-8c2e12ab0dd6` passed both Chromium tests
sequentially in 4.3 and 3.4 seconds with one worker and retry 0, followed by
clean Synapse teardown. Hosted acceptance is still pending; none of this
authorizes merging PR #677.

## Composer reaction-picker journeys

`android.composer-reactions` maps both Android-applicable definitions in
`e2e/browser/journeys/conversations/composer-reactions.spec.mts`, pinned at
SHA-256
`00f7444b5646cc445139b8911fb6c39f59abd3a0a42552a7fd1482ab9f25ed6a`.
The shared application and Account helpers remain enabled and are pinned at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
The migration expands ten Android-owned assertion sites plus two
composer-readiness helper calls into 12 unique, stage-local records: five for
the composer's picker toggle and seven for the exact-message reaction flow.
The predecessor's desktop hover/quick-reaction retry remains enabled and is
explicitly excluded from the Android replacement.

The first installed-Android stage opens a disposable Room through native touch,
activates the exact Insert emoji trigger through Maestro and proves both the
picker and `aria-expanded=true`. It activates the same trigger again and proves
the picker is absent or hidden and `aria-expanded=false`, preserving the state
synchronization that originally regressed.

The second stage joins a positioning Account, seeds three filler messages from
it through Matrix REST, then sends the exact target from the signed-in Account
and retains that final event ID. This preserves a visible sender-avatar/header
gesture target without weakening the exact event binding. Maestro scrolls that
avatar into view, long-presses it, chooses `sheet-react-more`, and proves the
accessible `Pick a reaction` dialog and its full picker, focuses the real search
field, enters `rocket` through the Android IME and selects the exact
rocket-labelled result through native touch. The result must appear as a 🚀 key
inside the exact target row. A separate Matrix relations request then proves an
unredacted `m.reaction` event from the signed-in Account whose `m.annotation`
relation has the exact target event ID and key.

```bash
pnpm nx run trinity-e2e-android:composer-reactions --skipNxCache
# Equivalent package command:
pnpm e2e:android:composer-reactions
```

The uncached serial target owns the emulator and disposable Synapse resources,
runs once with zero retries and publishes started-only
`android-composer-reactions` diagnostics from shard 2. Text diagnostics redact
passwords, account/Room identities, seeded message content and Matrix event IDs
before a recursive secret/native-storage scan; secret-bearing raster artifacts
are removed. Application data, WebView state, device and Synapse resources are
cleaned on every outcome. Three unchanged installed-Android invocations passed
on their first and only attempts with all 12/12 records and no raster artifacts:
`mu9p6b8q-d030cd87-0afa-477b-94f8-e368ed37f04e` in 222.630 seconds,
`mu9pblbq-9846b464-2d31-4cb8-bff2-2b0bcf195301` in 226.881 seconds and
`mu9pgz7f-fb58a35c-086b-4a4a-8a6e-e7ef9414e152` in 225.248 seconds. Exact
retained predecessor invocation
`mu9pnjp7-3efd445e-0e97-4921-97fb-928711eb97a5` passed both Chromium tests
sequentially in 5.3 and 3.9 seconds with one worker and retry 0, followed by
clean Synapse teardown.

Original-attempt hosted acceptance completed in
[run 35507101695](https://github.com/quwisky/trinity-matrix-client/actions/runs/35507101695)
from exact source head `8780e6ec0c04b7c1436d8e56dfdc1c21c3152986` through
hosted merge `70528304007b5ccde8bceb58e3f50827e434efc6`; the merge parents are
`47e6616cfe1ae47bcfe7e8923ce434b48e7e2981` and the exact source head.
Android shard 2 completed successfully on API 36 / `pixel_6` / `x86_64` and
restored the production renderer artifact `10604710990` with manifest digest
`a696f208b065bbb710aaba5dcb34bfb59d823fa066b1c18810850f8e61488908`.
Dedicated artifact `10607060453` (digest
`7d5b392cc7c74dd826ddf444319b3abb7f170e5be7325885e5f80157edf3ecfa`)
contains invocation `mu9rlzr1-95e9fe18-3490-4846-96d2-1b8f728a9007`: its
suite passed once with zero retries in 357.343 seconds, both stages passed in
156.879 and 199.350 seconds, and all 5 + 7 assertion records are present with
zero failures. All 20 Maestro manifests cover 111 completed, non-optional
commands against `eu.qwky.trinity` on `emulator-5554`; native secret input is
redacted. The dedicated artifact has no failure, raster, bearer-token or Matrix-
token marker, and Synapse removed its data and stopped cleanly.

Hosted browser artifact `10604946565` passed 318 attempts with zero retries
(317 passed, one skipped); both exact composer-reaction definitions passed on
retry 0 in 5.047 and 5.469 seconds. Hosted source re-hashing reproduced all
three pinned hashes. Renderer artifact `10604710990` has digest
`0f19354b90e99bc1572d57416766f6f6bdf530a63f0652dd8f02e76a845500c5`;
its production manifest contains 49 files / 15,302,546 bytes and verifies the
hosted merge exactly. The run's unrelated shard-3 and shard-4 failures remain
tracked under #665 and do not weaken the successful owning browser, renderer or
Android shard-2 artifacts. Nothing in this migration authorizes merging PR
#677.

## Composer typing-indicator journeys

`android.composer-typing` maps all six definitions in
`e2e/browser/journeys/conversations/composer-typing.spec.mts`, pinned at
SHA-256
`721a2dd22902ad0683c95b95e819ec3519c22b9d362b3c58a9893e60ec229f8f`.
The shared application and Account helpers remain enabled and are pinned at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
Nineteen direct predecessor assertions plus six composer-readiness helper calls
expand into 25 unique, stage-local records grouped 4 + 4 + 5 + 5 + 3 + 4.

Every stage signs a disposable reader into the installed Android app, opens its
private Room through native touch and drives the counterpart's typing EDU
through the exact Matrix v3 endpoint. Maestro owns local composer input. The
renderer is read-only proof for exact named copy, disappearance after stop,
positive reserved height, a below-one-CSS-pixel occupied-height delta, real
long-name overflow, one live 1000 ms infinite animation, three full-opacity
reduced-motion dots and the sidebar projection while the local user types.

The reduced-motion path was proved on the disposable API 36 emulator before
implementation. With the Android global `animator_duration_scale` initially
absent, the live WebView reported
`matchMedia('(prefers-reduced-motion: reduce)').matches === false`; after
setting only that value to `0` and cold relaunching, it reported `true`.
Deleting the value and relaunching restored `false`. The journey saves the
prior value, records the live media state and always restores or deletes that
exact value before teardown. It does not use CDP media emulation or renderer
mutation.

```bash
pnpm nx run trinity-e2e-android:composer-typing --skipNxCache
# Equivalent package command:
pnpm e2e:android:composer-typing
```

The uncached serial target owns the emulator and disposable Synapse resources,
runs once with zero retries and publishes started-only
`android-composer-typing` diagnostics from shard 2 immediately after composer
reactions. Text diagnostics redact passwords, account/Room/member identities
and the local composer draft before a recursive secret/native-storage scan;
secret-bearing raster artifacts are removed. Counterpart typing is explicitly
stopped, the Android setting is restored, application data and WebView state
are cleared, and device and Synapse resources are cleaned on every outcome.

Local acceptance used the unchanged 49-file / 15,302,553-byte production
renderer with manifest SHA-256
`73743a01b23f41926130899b14140974b95288f458b4c464623396bc068fee35`
and Android APK SHA-256
`0afce163aa263f9c81022aa84ec08ca4ed5930415ba574a56a2d4913c98f73c5`
on `emulator-5554`. Three unchanged installed-Android invocations passed all
six stages on their first and only attempt with all 25 records and zero retries:

- `mu9y2zb3-ef7eb388-54ab-4047-aa77-74a9fb299743` in 528.313 seconds;
- `mu9yeuco-64bf8f1c-ef42-40a9-ab69-22756e173abd` in 528.012 seconds;
- `mu9yqn1b-b0327c5d-7c48-4257-abd3-1766a7350ea2` in 524.874 seconds.

Each retained tree contains exactly 25 assertion files, two Android setting
receipts, 45 Maestro manifests and 258 completed, non-optional commands. None
contains a failed or raster artifact, bearer or Matrix token marker, or the
local draft. The final global animation setting is absent, the app process is
stopped, and Synapse removed its data and stopped cleanly. Exact retained
predecessor invocation `mu9z2go2-2ca9e82b-51c6-4e5d-8ab5-1d8d8d5e8330`
passed all six Chromium definitions sequentially in 21.176 seconds with one
worker and retry 0, followed by clean Synapse teardown. Source re-hashing
reproduced all three pinned hashes. Hosted acceptance is pending. The complete
Playwright predecessor remains enabled, and nothing here authorizes merging PR
#677.

The first hosted attempt on source head `aacd0943` retained useful failure
evidence rather than being retried away. Run `35520352131` artifact
`10608228799` (digest
`sha256:f5bb574e93ba5a6ea2138b9111381f1729bb5f80929acca8dc0893a0435bda9d`)
passed show/clear, reserved-slot and long-name on attempt 1, then observed the
live indicator before Chromium exposed the first CSS animation's effect timing.
The immediate read failed closed with `typing animation timing missing`; it did
not report a false animation pass. The repaired observer now uses the shared
bounded read-only WebView readiness poll until exactly one animation exposes a
timing object, then independently retains the exact 1000 ms and infinite
iteration assertions. It adds no journey retry, renderer mutation or assertion
relaxation. All six exact hosted Playwright predecessors passed at retry 0 in
the same run; an unrelated Room roster definition passed only on retry 1 and is
tracked under #665.

The repaired observer was then held fixed across three complete local reruns on
the same renderer manifest
`91b60ef284152e73f0ecfcf3446c35df2a76ea462e880b618035f250a37aca26`
and APK
`b76cafa8d663f2cdecc10f59fc862b5f24884d9c41393b22655b67c473f3f62b`:

- `mua260io-7c3a1361-97e4-4cbf-916b-e9490107f6e7` in 526.100 seconds;
- `mua2i9rd-025ce53a-7add-4e45-8c3d-86e994fc29be` in 529.345 seconds;
- `mua2v2fv-b2776bb2-e223-4c03-b163-477ac652efb9` in 531.043 seconds.

Every rerun passed all six stages and 25 assertion records on attempt 1 with
zero retries. Each retained tree contains 45 Maestro manifests and 258
completed, non-optional commands, with no failed or raster artifact. The final
animation setting is absent, the application is stopped, and Synapse data and
containers are removed. The failed emulator-start invocation immediately before
these runs executed no stage: it omitted the explicit disposable-emulator
serial while `Trinity_API_36` was already running, so the adapter correctly
failed rather than sharing an unleased device. Repeating the documented command
with `TRINITY_ANDROID_SERIAL=emulator-5554` resolved that invocation error
without changing production code, migration assertions or retry policy.

Post-repair predecessor invocation
`mua3874y-f7c21f99-85ac-4442-afba-bdace4510140` passed all six unchanged
Chromium definitions with one worker and zero retries in 21.515 seconds, then
removed its Synapse data and containers. Production-renderer invocation
`mua3dg9h-97d6e5a1-4644-4db6-b32e-8c1f17cc6c5d` rebuilt the 49-file,
15,302,553-byte shipped bundle and passed all nine applicable checks with nine
explicitly skipped variants. The final pre-publication renderer manifest is
`d64ff4bb575769f01558aa1a625111c1be38aa5683d393360e33f1d6e4877168`;
the APK rebuilt from that exact renderer is
`fb5fc6274a4ae229b9c535000fb89b4ef62b40fce10654a6f9f32914775becbf`.

Independent review then identified one remaining page-read edge: throwing while
the dot element itself was transiently absent would bypass the predicate-based
poll. A mutation-resistant guard first failed against that behavior; the final
observer now returns `null` as an explicit not-ready value until the dot exists,
while preserving the same bounded wait and exact count, duration and iteration
assertions. The final reviewed journey and guard were held fixed across three
more complete invocations on the same final renderer and APK:

- `mua3l1db-e401b8c7-b095-47e6-b8a7-b3ad5f0c64d1` in 533.318 seconds;
- `mua3x7kd-181c21df-7530-4e38-b1a9-8faaa3ec9709` in 533.138 seconds;
- `mua49e7b-ea768527-75e3-4331-ac93-8538e853640c` in 534.836 seconds.

These are the controlling local acceptance runs for the reviewed repair. Each
again passed all six stages and 25 assertion records on attempt 1 with zero
retries, 45 Maestro manifests, 258 completed commands, no failed or raster
artifact, and restored setting/application/Synapse state. Their combined
journey-and-guard diff hash was
`70286f5a777727bd2be87919b6538fd74f9bb1aee90366ae56f31aacf68c8f5a`.

Hosted acceptance completed on source head `547f1b74` through merge
`e23a20e5de2c6345e9499ab741ee196191c232c0` in run
[`35575438169`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35575438169).
Dedicated Android artifact
[`10632911418`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35575438169/artifacts/10632911418)
(digest
`sha256:5561ba423ba4e1fa725cc8f4a29fb6e946cd166990a436dedeb2fafbde57595a`)
passed all six stages and all 25 records on attempt 1 with zero retries in
914.686 seconds. Its 45 Maestro manifests record 258 completed, non-optional
commands; both Android setting receipts are present, all six stage markers
passed, and no failure or raster artifact remains. Browser artifact
[`10629420560`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35575438169/artifacts/10629420560)
passed all six exact predecessors at retry 0, while renderer artifact
[`10627656206`](https://github.com/quwisky/trinity-matrix-client/actions/runs/35575438169/artifacts/10627656206)
preserves the exact hosted production bundle. The shard failed only after the
owned suite, in the independent Space Settings suite; the separate shard-1 ADB
stall and later-suite failure remain tracked under #665. The complete
Playwright predecessor remains enabled. This evidence accepts issue #734 but
does not complete parent #660 or authorize merging PR #677.

## GIF picker journeys

`android.gif-picker` maps all four definitions in
`e2e/browser/journeys/conversations/gif.spec.mts`, pinned at SHA-256
`c2196e638e21cedec16ae04d45823d9893d1586d7597ec41b1665f32062ac3ad`.
The Settings navigation helper is independently pinned at
`43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81`;
the shared application and Account helper pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
Seventeen direct predecessor assertions plus seven owned navigation and
Account proofs expand into 24 unique records grouped 10 + 4 + 3 + 7 across
Settings lifecycle, unconfigured tray, image send and active-Account send.

Maestro owns every local tap, fill, Back action and Account login. Native
package Preferences own configuration setup and exact persistence proof; the
fixture never mutates renderer storage. Disposable Synapse REST fixtures own
Accounts, Rooms and the independent newest-`m.image` observation. Read-only
renderer inspection proves route, control, result and ready-media state. A
single bounded CDP Fetch session intercepts only `https://api.klipy.com/*` and
`https://media.klipy.com/*`, serving one pinned `e2e gif` result and a real
decodable 1×1 GIF. All other requests continue normally, so upload and event
round trips still use the real disposable homeserver.

The active-Account stage signs in A, adds B through the installed UI, opens a
B-only Room and requires the server-observed image sender to equal B exactly.
The global provider configuration is seeded before app initialization and its
diagnostic receipt contains only match booleans and key length. Provider
request receipts retain only pinned host, path and kind; API keys, passwords,
Matrix identifiers and Room data are registered for redaction. Recursive
post-run scans reject secrets, bearer/Matrix tokens, native-storage payloads
and raster diagnostics.

```bash
pnpm nx run trinity-e2e-android:gif-picker --skipNxCache
# Equivalent package command:
pnpm e2e:android:gif-picker
```

The uncached serial target owns both `android-avd` and `synapse`, runs once
with zero retries, and has a 20-minute Node timeout inside a bounded CI wrapper.
Shard 2 runs it immediately after composer typing and uploads
`android-gif-picker` diagnostics only after its started marker is written.
Every stage closes its provider session and WebView, clears application data,
and participates in aggregate device and Synapse cleanup on pass or failure.
Independent review found three fail-closed proof gaps before publication: a
remote secret-bearing preference cleanup failure could be swallowed, arbitrary
errors reading native Preferences could be mistaken for absence, and matching
KLIPY hosts were fulfilled without requiring the exact route and method. The
reviewed repair aggregates seed and cleanup failures, recognizes only an
explicit package-side absence marker, propagates every other ADB error, and
fulfills only GET `/v2/featured` with the exact four-parameter contract plus the
two pinned GET media paths. The ordinary send stage also retains a sanitized
ready-media/`m.image`/sender proof without changing the 24 assertion identities.

The repaired source revision `3872c669` was held fixed across three complete
installed-Android invocations on renderer manifest
`717f54489cc065180752512a18f6ae4b90eb9564b54d884d2966581f5584cbce`
(49 files, 15,302,547 bytes), APK
`cdb83100a7dff5ba1d54bfa8e47071b668184c892476bfeed7f6771ccd53d3be`
and native profile
`43933884ed001211f80f8c95204e0efc6e8ca53615b538a7fda5d3f97020a516`:

- `mub6isby-4c11d7dc-8237-4473-8242-d9dfd30f02b2` in 569.611 seconds;
- `mub6vhs2-c4972ad2-5546-455f-a434-6e3c3b41d5b7` in 568.202 seconds;
- `mub786gi-1bb787b1-f092-4b5d-bc66-331fa1308064` in 567.952 seconds.

Each run passed all four stages and all 24 records in the exact `10 + 4 + 3 +
7` grouping on attempt 1 with zero retries. Each retained two matching native
preference receipts, two exact three-request provider receipts, and the
ordinary-send proof; no failed or raster artifact remained. Recursive scans
found no GIF key, query-secret, bearer, or Matrix-token pattern. Emulator,
application, Fetch, Synapse, Caddy and Dex ownership all tore down cleanly. The
unchanged four-test Playwright predecessor passed with one worker and zero
retries in 18.2 seconds, and all four source pins remained exact.

Hosted acceptance completed on original-attempt
[run 35598984796](https://github.com/quwisky/trinity-matrix-client/actions/runs/35598984796)
at source head `534f94c54148bf56c1cd64344fdb61dd6071530d` through hosted
merge `629164becbea5dcdbe605deeb97eb3afe3aeec04`. Android shard 2
[job 106330754502](https://github.com/quwisky/trinity-matrix-client/actions/runs/35598984796/job/106330754502)
uploaded the passing
[GIF picker artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35598984796/artifacts/10644904825),
ID `10644904825`, digest
`sha256:36270e71bbd31bf2a15aaad07dd0ceba8f3c51bb4627a4c35ba8ba1765475528`.
Invocation `mubanc9r-02f9fcfd-2109-49bf-8912-9c15c0b84fdb` passed all
four stages and all 24 identities in 950757 ms on attempt 1 with zero retries.
The artifact contains the exact `10 + 4 + 3 + 7` records, 50 successful
native-flow JUnits and 272 completed Maestro commands, both matching native
preference receipts, both exact three-request provider receipts, the sanitized
ordinary-send proof and the exact active-Account sender proof. It contains no
failed or raster artifact, and the independent recursive audit found no GIF
key, query-secret, bearer or Matrix-token pattern. The Pixel 5 logical profile,
installed application id, exact renderer merge and manifest digest are present;
Synapse, Caddy and Dex teardown completed and the hosted worktree-diff gate
passed.

The same attempt's
[browser artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35598984796/artifacts/10638678491),
ID `10638678491`, digest
`sha256:e38804de226efb07744d62b6c778677cbaecc9fd2e5323c55e025b43766a3be5`,
records all four exact predecessor tests passing at retry 0. Its
[renderer artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35598984796/artifacts/10638146866),
ID `10638146866`, digest
`sha256:722741179f028fc604b4b0d60d69d6faa96c112b60a9c65e70f1fa0b0f901c06`,
contains 49 verified production files / 15,302,546 bytes and manifest digest
`b24106fc67d24e20cb37044d924e95cbf11e15f54ea5904007939400e0006dc5`
for the hosted merge. Shard 2 later failed in the unchanged Space Settings
suite because `admin.photo-feedback` timed out; shard 1 independently reached
its configured 120-minute job timeout. Those later failures are outside #735
and remain reliability debt under #665. The complete Playwright predecessor
remains enabled, and nothing here authorizes merging PR #677.

## Hide system messages journey

`android.hide-system-messages` maps the single definition in
`e2e/browser/journeys/conversations/hide-system-messages.spec.mts`, pinned at
SHA-256
`f1f88eb542b48cfa461132a730b7fea1120977d771ade96565d0ae5fb64329c0`.
The Settings-navigation helper is independently pinned at
`43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81`;
the shared application and Account helper pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
Seven direct predecessor assertions, three Room-helper readiness checks and
three inherited Settings-navigation checks expand into exactly 13 unique
records in one stage.

Disposable Matrix REST fixtures arrange two fresh Accounts, a distinctive
joiner display name, one private Room, the join event and a later `m.text`
message. Maestro owns login, Room and Settings navigation, the exact
`Show joins and leaves` switch action, both returns to the Room and the
post-force-stop reopening. Renderer inspection is read-only and scopes the
surviving message to an exact `.msg__text` inside `trn-message-row`;
suppression passes only when the exact membership line has count zero after the
exact later message is visible.

The native observer reads only
`trinity.timeline.show-membership` from package-owned
`shared_prefs/CapacitorStorage.xml` through `run-as`. It fails closed on
duplicates, malformed XML and non-boolean values, proves default-enabled
semantics from key absence, proves persisted `false` after the native tap and
re-proves it after a real installed-host force-stop/relaunch. It never returns
raw Preferences XML or mutates application storage.

```bash
pnpm nx run trinity-e2e-android:hide-system-messages --skipNxCache
# Equivalent package command:
pnpm e2e:android:hide-system-messages
```

The uncached serial target owns both `android-avd` and `synapse`, runs one
attempt with zero retries, and has a 20-minute Node timeout inside a bounded CI
wrapper. Shard 2 runs it immediately after GIF picker and uploads
`android-hide-system-messages` diagnostics only after its started marker is
written. Every outcome closes the WebView, clears installed application data,
closes the device and participates in bounded Matrix cleanup. Post-redaction
scans reject credentials, bearer/Matrix tokens, query secrets, raw Preferences
XML and raster diagnostics. The complete Playwright predecessor remains
enabled, and nothing here authorizes merging PR #677.

The unchanged migration implementation based on source revision `37f89b29`
passed three complete installed-Android invocations on renderer manifest
`5d0a885036a86f0f0e0108d69b6c3510c57f07281aca30d6a7c6aee01e737736`
(49 files, 15,302,553 bytes), APK
`a378d5c951faf7ac9248e6a7a443137696b0a5553d8ca3784988566509b90228`
and native profile
`43933884ed001211f80f6c95204e0efc6e8ca53615b538a7fda5d3f97020a516`:

- `mube1fpn-f7f874d9-0a92-4d1a-a965-9b8f533ca272` in 240.633 seconds;
- `mube73ro-31702699-1603-418f-a1e7-dd5eb705c8e3` in 251.527 seconds;
- `mubecyol-1a0d084f-98c9-402c-94bd-9145975e56ad` in 249.296 seconds.

Each run passed its one stage and all 13 assertion records on attempt 1 with
zero retries. Each retained 21 successful native-flow JUnits and 98 completed
Maestro commands. The three native-preference receipts prove absent/effectively
true by default, persisted false after the native switch action and still false
after force-stop/relaunch. The exact later message survived both filtered Room
visits while the exact membership line was absent. No failed or raster artifact
remained, recursive secret scans found no bearer, Matrix-token, query-secret or
raw Preferences pattern, and emulator, application and Synapse ownership tore
down cleanly.

Production-renderer invocation
`mubdpeui-863e1090-fa7e-489a-9495-f31627e3f21c` passed all nine applicable
checks with nine explicitly skipped variants. The unchanged Playwright
predecessor passed its exact test with one worker and zero retries in 7.1
seconds under invocation
`mubeit3y-d8a11b9c-2d3c-418b-a5f5-cfb676061aac`. The focused migration guard,
full 1,044-test scripts target, Android typecheck and Android lint also passed
uncached.

Hosted acceptance completed on original-attempt
[run 35620422646](https://github.com/quwisky/trinity-matrix-client/actions/runs/35620422646)
at exact source head `eab9876c95aeb2b1547a42bb6a3e8e4c468e5912` through
hosted merge `124254f9958dd387b11c036b0c52866b2d3a142d`. Android shard 2
[job 106402526575](https://github.com/quwisky/trinity-matrix-client/actions/runs/35620422646/job/106402526575)
completed successfully on the API 36 x86_64 `trinity_api_36_ci` device and
uploaded the passing
[Hide system messages artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35620422646/artifacts/10658890080),
ID `10658890080`, digest
`sha256:caa25c565463846cbca318bb2f471568eaca02886e23801c1f63d82ca7d2901a`.
Invocation `mubhoqsq-98aa5ff4-4d4f-4494-b063-ea30a1da1667` passed its
single stage in 274711 ms and the complete suite in 275779 ms on attempt 1
with zero retries.

The immutable artifact contains all 13 identities exactly once, 21 successful
native-flow JUnits and 98 completed Maestro commands with no failed, skipped,
cancelled or pending command. Its native receipts prove absent/effectively true
by default, persisted false after the native switch action and still false
after force-stop/relaunch. The exact ordinary message survived both filtered
Room visits while the exact membership line was absent. No failed or raster
artifact remained, and independent recursive scans found no bearer,
Matrix-token, query-secret or raw Preferences pattern. Installed application
`eu.qwky.trinity`, emulator, WebView and Synapse ownership tore down cleanly,
and the hosted worktree-diff gate passed.

The same attempt's
[browser artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35620422646/artifacts/10651066031),
ID `10651066031`, digest
`sha256:0637e0951306426f87361372f66fb3e95922ff9ce01b16687ede3a2590300e49`,
records the exact unchanged predecessor passing at retry 0 in 11491 ms. Its
[renderer artifact](https://github.com/quwisky/trinity-matrix-client/actions/runs/35620422646/artifacts/10648235865),
ID `10648235865`, digest
`sha256:ace4962ce53b5fd2897e315ad07182013029d7dcc8a7a2912e2151e368e0088b`,
contains 49 verified production files / 15,302,546 bytes and manifest digest
`784955c06c5508091c96c57664885f607f0c06989775c961a1a61236183b4f42`
for the hosted merge. The broad browser job later timed out in the unrelated
Room Settings For-you mobile predecessor; the exact #736 predecessor had
already passed and its artifact uploaded. That failure remains reliability
debt under #665. The complete Playwright predecessor remains enabled, and
nothing here authorizes merging PR #677.

## Jump to date journey

`android.jump-to-date` maps the Android-applicable definition at lines 42–119
of `e2e/browser/journeys/conversations/jump-to-date.spec.mts` plus its Room
helper at lines 22–30. The complete predecessor is pinned at SHA-256
`99a1ae1ec8873d2a45795003604d9c83c162d5d33c5415899e41581e97d4fd04`;
the shared application and Account helper pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
Four direct assertions plus the helper's composer-readiness assertion expand
to exactly five stage-local identities.

The definition at lines 121–176 remains explicitly browser-only because it
removes the production date input's maximum, injects a future value and
dispatches an input event to reach a service response that native use cannot
request. The installed journey never reproduces those DOM mutations. Both
Playwright definitions remain enabled.

The REST fixture creates one disposable Account and private Room, awaits an
exact marker event, then sends exactly 120 later filler events. The final
filler is sent last, every response must contain a unique event id and the
journey records an event-id-only ordering receipt. Maestro owns login, Room
selection, overflow and dialog navigation, and the exact `Jump` activation.
Read-only renderer observations prove the exact newest filler event is visible
and the marker event id is absent from the initial timeline window. The date
input must already equal both the emulator-local current day and its production
maximum; the journey neither focuses nor fills it.

A bounded CDP Network observer records only the exact Room's real GET
`/timestamp_to_event` request, requires `dir=f` and a finite timestamp, and is
disabled, unsubscribed and closed before WebView/device teardown. Success then
requires one visible `.scroll .msg` whose `data-mid` equals the arranged marker
event id and whose text contains the exact marker body. That combination ties
the result to the initially absent event and the real history-backfill path.

```bash
pnpm nx run trinity-e2e-android:jump-to-date --skipNxCache
# Equivalent package command:
pnpm e2e:android:jump-to-date
```

The uncached serial target owns both `android-avd` and `synapse`, runs one
attempt with zero retries, and has a 20-minute Node timeout inside a 25-minute
CI wrapper. Shard 2 runs it immediately after hide-system-messages and uploads
`android-jump-to-date` diagnostics only after its started marker is written.
Every outcome closes the observer and WebView, clears installed application
data, closes the device and participates in bounded Matrix cleanup.
Post-redaction scans reject credentials, message secrets, bearer/Matrix tokens,
query secrets, raw native-storage method data and raster diagnostics. Local and
hosted acceptance evidence is still required before issue #737 is complete;
nothing here authorizes merging PR #677.

Local acceptance used implementation base `4091507758e1b87f25c46b1ce7fd02ba3423b3a3`
and the final 49-file / 15,302,553-byte production renderer at manifest
SHA-256
`80ef0fa138569539d3935dd092ecead84fc88d4dcc14312b7e93e87876ff24f6`.
The installed debug APK SHA-256 was
`4b2d89291a59c4587516d2de15df726d214e1504d4c379fd3379642d60050f2c`;
the unchanged Pixel 5 native profile was
`43933884ed001211f80f6c95204e0efc6e8ca53615b538a7fda5d3f97020a516`.
Three sequential uncached invocations passed the single stage and all five
records on attempt 1 with zero retries:

- `mubnp8um-df7726ff-9a74-4ce1-b833-9042ddbaf937` in 152.682 seconds;
- `mubnt7d1-7bde7320-4a97-434b-bb4d-cf6964552b77` in 150.455 seconds;
- `mubnx2vs-3950cb57-0f89-44ee-ae03-1da600b7a4ef` in 148.820 seconds.

Each retained the exact ordered-event and forward timestamp-lookup receipts,
10 successful native-flow manifests and 55 completed, non-optional commands.
No failed or raster artifact remained. Runtime scans used the live generated
credentials and message values; an independent scan found no bearer,
Matrix-token or query-secret pattern. WebView Network, installed application,
emulator and Synapse ownership all tore down cleanly. An earlier diagnostic
run correctly failed its post-run scan because three message values were not
classified for the shared redactor; a focused regression guard was added and
the final keys now use the redactor's `SECRET_` classification before these
three controlling runs.

Exact predecessor invocation
`mubnfl9i-1f394e81-17b2-45d4-80bb-7458638ceabf` passed both unchanged
Chromium definitions with one worker and zero retries in 10.330 seconds, then
removed its Synapse data and containers. Source re-hashing reproduced all
three pins. Production-renderer invocation
`mubnjkhb-264589b4-4cb4-43df-9312-3655ea4c006e` passed all nine applicable
checks with nine explicit skips before the final APK build. The focused guard,
full 1,050-test scripts target, Android typecheck and lint, format check,
architecture contracts and APK build all passed. Hosted acceptance remains
pending; the complete Playwright predecessor remains enabled, and nothing here
authorizes merging PR #677.

Hosted rerun attempt 2 exercised merge commit
`78d1f231221775142d82b72b69d8ab5a59ec4f84`, whose second parent is the exact
branch commit `0158004089947efe53df58989b6310866a6935a4`. The verified 49-file
production bundle used manifest SHA-256
`f3165a655ff77b8a990976ff97b632974e071b91158dfb7e2f2b175e6bb30028`.
Artifact
`playwright-35648301526-2-78d1f231221775142d82b72b69d8ab5a59ec4f84-android-e2e-android-jump-to-date-2`
(artifact id `10669408252`) contains invocation
`mubtkz8n-b05332aa-e806-477a-88e3-2360f25ca036`: the suite passed in 177.618
seconds and its single stage passed in 176.411 seconds with 5/5 records,
attempt 1, zero retries and zero failures.

The immutable receipts prove 120 uniquely ordered filler events, the exact
initial newest event, initial marker absence, the unchanged current/max date,
one forward `/timestamp_to_event` request for the exact Room and the exact
marker event after the native Jump action. All ten native-flow manifests and
the Node result passed, no failed or raster artifact remained, and an
independent bearer/Matrix-token scan found no match across the 85 retained
files. Re-hashing the three sources from the hosted merge reproduced every
pinned digest. Shard 2 failed later in the unrelated Space Settings core suite
at `admin.photo-feedback`; the exact jump-to-date target and its dedicated
artifact had already completed successfully. The complete Playwright
predecessor remains enabled, and nothing here authorizes merging PR #677.

## Jump to latest journey

`android.jump-to-latest` maps the definition at lines 115–167 of
`e2e/browser/journeys/conversations/jump-to-latest.spec.mts`, its Room helper
at lines 104–110 and the exact setup at lines 24–110. The complete predecessor
is pinned at SHA-256
`1ecfdf0aad6c13326b81b0103bc7f9793f4754438a77bc8098060910c01e3209`;
the shared application and Account helper pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
Six direct assertions plus the Room helper's scroll-readiness assertion expand
to exactly seven stage-local identities.

The REST fixture creates one disposable Account and private Room, sends exactly
20 long wrapping messages sequentially, retains every event id and marks the
newest exact event as both `m.fully_read` and `m.read`. Maestro owns login,
Room navigation, the timeline swipe and jump-to-latest activation. The
predecessor's Android-only DOM `scrollBy` workaround is intentionally replaced
by a reusable measured native swipe: read-only renderer geometry supplies two
safe in-container CSS points, the active Pixel 5 profile transforms them to
integer device points and one bounded Maestro flow performs the gesture.

Read-only observations require initial bottom distance below 50 px, a hidden
pill and more than 300 px of real scrollable range. After the downward finger
gesture, `scrollTop` must decrease, bottom distance must increase and the pill
must be visible. After native pill activation, bottom distance must return
below 50 px and the pill must be hidden. Renderer access never assigns a scroll
offset, calls scroll methods, dispatches events, invokes handlers, focuses,
fills, submits or navigates.

```bash
pnpm nx run trinity-e2e-android:jump-to-latest --skipNxCache
# Equivalent package command:
pnpm e2e:android:jump-to-latest
```

The uncached serial target owns both `android-avd` and `synapse`, runs one
attempt with zero retries, and has a 20-minute Node timeout inside a 25-minute
CI wrapper. Shard 2 runs it immediately after jump-to-date and uploads
`android-jump-to-latest` diagnostics only after its started marker is written.
Every outcome closes the WebView, clears installed application data, closes
the device and participates in bounded Matrix cleanup. Post-redaction scans
reject credentials, long message bodies, bearer/Matrix tokens, query secrets,
raw native-storage method data and raster diagnostics. Local and hosted
acceptance evidence is still required before issue #738 is complete; the
complete Playwright predecessor remains enabled, and nothing here authorizes
merging PR #677.

Local acceptance used implementation base
`0158004089947efe53df58989b6310866a6935a4` and the final 49-file /
15,302,553-byte production renderer at manifest SHA-256
`5ee234c2ec543a90eae165616f111e486ba091ef2e17bcab2a5aa4dfe16ad88e`.
The installed debug APK SHA-256 was
`5c5325a0f426edc5a850de54e407a78fd55a958e41c02f685b695f0835362808`;
the unchanged Pixel 5 native profile was
`43933884ed001211f80f6c95204e0efc6e8ca53615b538a7fda5d3f97020a516`.
Three sequential uncached invocations passed the single stage and all seven
records on attempt 1 with zero retries:

- `mubqkuhu-1ff46c91-5d5b-412d-a344-85ac3e7e0bb7` in 107.922 seconds;
- `mubqruvo-a401341c-3cf9-458e-badc-e848912b2740` in 108.849 seconds;
- `mubqvcs6-83c0c207-7d46-4cb3-a180-333d80e0705a` in 109.295 seconds.

Each retained the exact 20-event ordered-send/read-marker receipt, nine
successful native-flow JUnits and 48 completed, non-optional Maestro commands.
The measured timeline had 5,940 px of real range. Every run transformed CSS
points `(197, 300)` and `(197, 549)` to device points `(516, 914)` and
`(516, 1566)` for one 600 ms downward-finger swipe, decreased `scrollTop` by
about 280–282 px, increased bottom distance by the same amount, showed the
pill and then returned to the original bottom bound after the native tap. No
failed or raster artifact remained. Runtime scans used the live generated
credentials, Room name and long body; an independent scan found no bearer,
Matrix-token or query-secret pattern. Installed application, emulator and
Synapse ownership all tore down cleanly.

Exact predecessor invocation
`mubqyuxq-2973b3c3-1752-406a-ae9e-ac893bcc9bbc` passed the unchanged
Chromium definition with one worker and zero retries in 5.605 seconds, then
removed its Synapse data and containers. Source re-hashing reproduced all
three pins. Production-renderer invocation
`mubqizaq-0ff93b0e-7603-474b-a93b-e3f3189f5156` passed all nine applicable
checks with nine explicit skips before the final APK build. The focused guard,
full 1,056-test scripts target, Android typecheck and lint, and format check all
passed. An earlier preflight correctly stopped before the suite because the
renderer still carried the preceding acceptance identity; it produced no test
result and the renderer was rebuilt before the three controlling runs. Hosted
run `35669813769` used exact branch head
`295bedb60cf3afe65d58fdddb022726d229edc6a` at merge revision
`cf23194bac55b2978e23c94c113abc68f9aa1c86`. Immutable browser artifact
`10671700781`, digest
`sha256:93239aeb1f59f22887b4069c848acfba5cfc42fba86efffa706f7acc4f717fd2`,
contains invocation `mubx22ej-35fe3f7c-03d2-433e-9b1e-8d57ae0b6e9d`.
The exact unchanged jump-to-latest predecessor passed once in 4.887 seconds.
The complete browser suite used two workers and recorded 317 passed, one
skipped and zero retries across 318 attempts in 917.653 seconds. Re-hashing
the hosted merge reproduced the pinned predecessor, application and Account
digests.

The corresponding hosted Android suite passed on original attempt 1 with zero
retries in 163.340 seconds. Immutable artifact `10674675604`, digest
`sha256:3774af0a351415a1a32f38bda35ebc5230fa79226add89de9e7e8e2cbd348f92`,
contains invocation `muc0772r-e2aff029-d22b-4b6d-8722-a60e7508de66`: one
passed stage, 7/7 unique assertion records, zero failures, nine passing native
flow JUnit reports and 48/48 completed Maestro commands. Its receipts retain
the exact 20-event setup and read marker, the measured native swipe and the
observed transition from bottom to a visible jump pill and back to the bottom.
The 82 retained files contain no raster diagnostics, and the independent
credential scan found no bearer or Matrix token material. Shard 2 later failed
in the unrelated retained `android.space-settings-core` suite while waiting for
`admin.photo-feedback`; that later failure does not alter this completed suite
or its immutable artifact. The complete Playwright predecessor remains enabled,
and nothing here authorizes merging PR #677.

## Link preview journey

`android.link-preview` maps the complete definition at lines 28–74 and the
hermetic OG URL selection at lines 17–23 of
`e2e/browser/journeys/conversations/link-preview.spec.mts`. The predecessor is
pinned at SHA-256
`08282733e2a496677fda5b9c03738b571714f838d49a93a36fbaf16eb38e7da4`;
the Caddy fixture at lines 52–62 is pinned at
`c23c76234ad98fee4692fecac6af6c7f404ad9c852a251c17a7ebf6da4c006ab`.
The shared application and Account helper pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
The predecessor's three direct assertions map to exactly three stage-local
identities: visible preview card, exact title and exact destination.

The REST fixture creates one disposable Account and private Room with no
`m.room.encryption` state, sends one exact run-scoped text event containing the
selected `http://caddy:8080/og` or netns-loopback URL, and reads the event back
to prove sender, type, body and id. It proves the encryption state is absent
before the send, after the send and after the rendered result. Maestro owns
login and Room navigation. Read-only renderer observation scopes the preview
to the exact message event, requires the title `Trinity E2E Preview` and
requires the card `href` to equal the seeded URL.

A bounded CDP Network observer starts before login and retains only sanitized
facts for the exact GET `/_matrix/client/v1/media/preview_url` request or either
private OG origin. Acceptance requires exactly one authenticated homeserver
request whose decoded `url` query equals the seeded URL and zero direct WebView
requests to the Caddy or loopback fixture. The observer never intercepts,
fulfills or reads responses and is disabled, unsubscribed and closed before
WebView/device teardown.

```bash
pnpm nx run trinity-e2e-android:link-preview --skipNxCache
# Equivalent package command:
pnpm e2e:android:link-preview
```

The uncached serial target owns both `android-avd` and `synapse`, runs one
attempt with zero retries, and has a 20-minute Node timeout inside a 25-minute
CI wrapper. Shard 2 runs it immediately after jump-to-latest and uploads
`android-link-preview` diagnostics only after its started marker is written.
Every outcome closes the Network observer and WebView, clears installed
application data, closes the device and participates in bounded Matrix
cleanup. Post-redaction scans reject credentials, message values,
authorization/cookie data, bearer/Matrix tokens, raw native-storage method
data and raster diagnostics. Local and hosted acceptance evidence is still
required before issue #739 is complete; the complete Playwright predecessor
remains enabled, and nothing here authorizes merging PR #677.

Local acceptance used implementation base
`35bb021c8de0eada447179d4382108449109b38e` and the 49-file /
15,302,553-byte production renderer at manifest SHA-256
`0dc35623a14cb26c3b1d492f4e7af43706c4426c2902c9dfdf3a38ec5ea1c4df`.
The installed debug APK SHA-256 was
`091433417c9b691494a5278219ed56e881540d2de7940ff8ec4eb382530755cf`;
the unchanged Pixel 5 native profile was
`43933884ed001211f80f6c95204e0efc6e8ca53615b538a7fda5d3f97020a516`.
Three sequential uncached invocations passed the single stage and all three
records on attempt 1 with zero retries:

- `mubtc6nx-5b994b0c-c830-47ce-85e1-50ff274661ce` in 92.266 seconds;
- `mubtf7pp-9520b6b6-9081-40c6-a3a1-9f0fe81d3d69` in 91.365 seconds;
- `mubtia76-fc8b4d44-7676-4db9-8877-2fbf319b21e0` in 92.535 seconds.

Each retained plaintext absence before and after the exact message plus after
the rendered result. Each observed exactly one authenticated, script-initiated
GET to `/_matrix/client/v1/media/preview_url` with the exact decoded Caddy URL,
zero direct Caddy/loopback WebView requests, seven successful native-flow
JUnits and 40 completed, non-optional Maestro commands. Each exact event row
showed one visible card, the exact title and exact destination. No failed or
raster artifact remained; runtime scans used the generated credentials, Room
name and message body, and installed application, Network observer, emulator
and Synapse ownership all tore down cleanly.

Exact predecessor invocation
`mubt397z-2274815d-1711-4b3e-83c8-94e9a3f2d522` passed the unchanged Chromium
definition with one worker and zero retries in 3.5 seconds (4.1 seconds for the
suite), then removed its Synapse data and containers. Source re-hashing
reproduced all four pins. Production-renderer invocation
`mubt6rzw-9c4d03dc-92e0-4c9f-9b85-74472712b5f9` passed all nine applicable
checks with nine explicit skips before the final APK build. The focused guard,
full 1,062-test scripts target, Android typecheck and lint, registry/workflow
contracts and format check all passed.

An earlier diagnostic run reached and proved the exact card but correctly
failed before acceptance because its observer expected the older media-v3
preview path while the pinned Matrix SDK emitted the versioned client-v1 media
path. The same run also showed that Android biometric logcat uses a numeric
`cookie` field; the scanner now distinguishes that harmless metadata from raw
HTTP authorization/cookie values. The focused mutation guard pins both fixes,
and that diagnostic result was not counted among the three controlling runs.
Hosted run `35669813769` used exact branch head
`295bedb60cf3afe65d58fdddb022726d229edc6a` at merge revision
`cf23194bac55b2978e23c94c113abc68f9aa1c86`. Immutable browser artifact
`10671700781`, digest
`sha256:93239aeb1f59f22887b4069c848acfba5cfc42fba86efffa706f7acc4f717fd2`,
contains invocation `mubx22ej-35fe3f7c-03d2-433e-9b1e-8d57ae0b6e9d`.
The exact unchanged link-preview predecessor passed once in 4.046 seconds.
The complete browser suite used two workers and recorded 317 passed, one
skipped and zero retries across 318 attempts in 917.653 seconds. Re-hashing
the hosted merge reproduced the pinned predecessor, Caddy fixture, application
and Account digests.

The corresponding hosted Android suite passed on original attempt 1 with zero
retries in 139.504 seconds. Immutable artifact `10674675608`, digest
`sha256:1433dd09ef35b11bf2252abfda390a97516ab41c30049dc89c5e03dc8257ddba`,
contains invocation `muc0b5vd-6496426b-db86-46fa-9a8c-9906f11d8103`: one
passed stage, 3/3 unique assertion records, zero failures, seven passing native
flow JUnit reports and 40/40 completed Maestro commands. Its receipts retain
exactly one authenticated Matrix preview request for the encoded hermetic Caddy
URL, no direct OG/Caddy request, and the exact event, title and destination
match. The 64 retained files contain no raster diagnostics, and the independent
credential scan found no bearer or Matrix token material. Shard 2 later failed
in the unrelated retained `android.space-settings-core` suite while waiting for
`admin.photo-feedback`; that later failure does not alter this completed suite
or its immutable artifact. The complete Playwright predecessor remains enabled,
and nothing here authorizes merging PR #677.

## Location share journey

`android.location-share` maps the deterministic geolocation/Room helper at
lines 19–33 and the complete definition at lines 38–97 of
`e2e/browser/journeys/conversations/location-share.spec.mts`. The predecessor
is pinned at SHA-256
`86e673e5bd86e014a6f5ee4b4eb1da11eb979013b6629a452153367405e76244`;
the native Android geolocation adapter source is pinned at
`30f3489a4cac27685b03812e957a599d9ae4bef90985a55760f463fc702bfe8a`.
The shared application and Account helper pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
The five assertions executed by the predecessor's Android branch plus Room
readiness, exact server echo and action-sheet readiness map to exactly eight
stage-local identities.

The REST fixture creates only one disposable Account and private Room. It
does not send or inject a location event. A bounded native adapter records the
existing Trinity coarse/fine permission grants, GPS provider state and shell
mock-location app-op, grants only missing location permissions, installs a GPS
test provider at exactly `40.7128,-74.006` and pulses it once per second for a
late Capacitor listener. Maestro owns login, Rooms navigation, composer tray,
Location selection and the exact-row long press. Teardown stops and awaits the
pulse, removes the test provider, restores the prior shell app-op, and revokes
only permissions granted by this stage before WebView/application/device
cleanup.

Matrix REST observes a bounded latest-message window until exactly one real
server echo appears. It must be the signed-in user's `m.room.message` with
`msgtype: m.location`, body `Shared location`, exact
`geo:40.7128,-74.006` legacy and MSC3488 URIs, and MSC3488 asset type
`m.self`. Read-only renderer checks then scope every result to that event id,
require one visible location card, exact text `40.71280, -74.00600`, and an
OpenStreetMap destination whose `mlat` is exactly `40.7128`. The native
long-press must open the action sheet, expose Copy link and omit Edit.

```bash
pnpm nx run trinity-e2e-android:location-share --skipNxCache
# Equivalent package command:
pnpm e2e:android:location-share
```

The WebView is detached before permission restoration because Android may
terminate a package when a runtime permission is revoked; the adapter still
restores all device state before application-data and device cleanup.

The uncached serial target owns both `android-avd` and `synapse`, runs one
attempt with zero retries, and has a 20-minute Node timeout inside a 25-minute
CI wrapper. Shard 2 runs it immediately after link-preview and uploads
`android-location-share` diagnostics only after its started marker is written.
Post-redaction scans reject generated credentials, Account/Room/event/location
values, authorization/cookie data, bearer/Matrix tokens, raw native-storage
method data and raster diagnostics.

Local acceptance used the unchanged Pixel 5 API 36 profile with SHA-256
`43933884ed001211f80f6c95204e0efc6e8ca53615b538a7fda5d3f97020a516`,
production renderer manifest SHA-256
`d07e6219fdf5915e5e617c8b77d4aac4b11103663f7a4e7f3000c2757ba78b4c`
and debug APK SHA-256
`a12f8a3ff4f07259cef8b5e54f97607ea7c105152f85d8727ad9cc0bb7458d2f`.
Three unchanged-input uncached invocations passed:

- `mubuvu37-4018eb70-4aef-4762-903d-2b8c50e54740` in 115.834 seconds;
- `mubv08b0-223b43cf-388a-4c14-a329-f842a569a772` in 115.333 seconds;
- `mubv3vxw-796b8cad-b3e4-4570-a9d2-b27ad2b4151c` in 116.318 seconds.

Every invocation recorded one passed stage, 8/8 unique assertion records,
attempt 1, zero retries and zero failures. The receipts prove the exact native
position and two captured permission baselines, the pulsed one-second adapter,
one exact current-user server echo, the exact event-row/card/coordinate/OSM
observations, and the action sheet with Copy link present and Edit count zero.
Each retained location-share tree contains 85 files and no raster
files; the built-in redaction scan and an independent bearer/Matrix-token scan
both passed. All ten native flow JUnit reports passed in every invocation, and
no emulator remained afterward.

The complete browser predecessor also passed with one worker and zero retries
in invocation `mubv8f4w-544b9f46-5c09-41db-90f9-6dcb633bbf98` (one test in
4.0 seconds; 4.6-second suite). All four source pins were rechecked after the
runtime runs. Production-renderer invocation
`mubujzjs-bb53ef70-63fe-4f30-943d-2f00825e841a` passed its nine required
projects while nine host-specific projects were intentionally skipped. Final
production-renderer verification after the browser parity run repeated that
9-passed/9-skipped result in invocation
`mubvhygp-a74b7d83-de62-48f4-9ad8-15f1f50eb3ba`; the verified bundle again
contained 49 files and 15,302,553 bytes, and the prebuilt Android build passed.

Two setup diagnostics exposed that a denied package permission is a normal
non-zero `pm check-permission` result and that the API 36 image omits the
provider-state query used by the older fixture. Baseline capture now reads the
package dump and secure location mode instead. A later diagnostic reached all
8/8 assertions but exposed that revoking a runtime permission can terminate the
package before WebView cleanup; it was not accepted. The final teardown detaches
the WebView first, and only the three subsequent unchanged runs above count as
acceptance evidence.

Hosted run `35669813769` used exact branch head
`295bedb60cf3afe65d58fdddb022726d229edc6a` at merge revision
`cf23194bac55b2978e23c94c113abc68f9aa1c86`. Immutable browser artifact
`10671700781`, digest
`sha256:93239aeb1f59f22887b4069c848acfba5cfc42fba86efffa706f7acc4f717fd2`,
contains invocation `mubx22ej-35fe3f7c-03d2-433e-9b1e-8d57ae0b6e9d`.
The exact unchanged location-share predecessor passed once in 4.474 seconds.
The complete browser suite used two workers and recorded 317 passed, one
skipped and zero retries across 318 attempts in 917.653 seconds. Re-hashing
the hosted merge reproduced the pinned predecessor, Android adapter,
application and Account digests.

The corresponding hosted Android suite passed on original attempt 1 with zero
retries in 182.544 seconds. Immutable artifact `10674500687`, digest
`sha256:d6762e4aeecb5850e3b8100d1bdcba633bbbfa5fb76ea26b6cd4b039ad3326e2`,
contains invocation `muc0em0p-cff6a2dd-2230-4939-bed0-1392334a7d3f`: one
passed stage, 8/8 unique assertion records, zero failures, ten passing native
flow JUnit reports and 53/53 completed Maestro commands. Its receipts retain
the exact native position and permission baselines, pulsed provider, single
current-user server echo, event/card/coordinate/OpenStreetMap matches, and the
action sheet with Copy link present and Edit absent. The 89 retained files
contain no raster diagnostics, and the independent credential scan found no
bearer or Matrix token material. Shard 2 later failed in the unrelated retained
`android.space-settings-core` suite while waiting for `admin.photo-feedback`;
that later failure does not alter this completed suite or its immutable
artifact. The complete Playwright predecessor remains enabled, and nothing here
authorizes merging PR #677.

## Media retention journey

Suite `android.media-retention` migrates the complete Android branch from
`e2e/browser/journeys/conversations/media-retention.spec.mts`, including its
fixture helpers at lines 16–167, interaction helpers at lines 169–221 and
definition at lines 226–257. The predecessor is pinned at SHA-256
`8de218b97b33dbd0513e9b93d21812120d3afa0ecc10e37e530fe265f6f18fc6`;
the shared application and Account helper pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.

The REST fixture creates one disposable Account and two private Rooms. It
uploads the exact pinned PNG as `retained-plain.png` with media type
`image/png`, then uploads separately encrypted AES-CTR-256 ciphertext as
`retained-encrypted.png` with media type `application/octet-stream`. The
encrypted Matrix file descriptor uses version `v2`, an exported JWK, a random
first IV half with a zero lower half, and the ciphertext SHA-256 digest. The
fixture requires distinct content URIs and event ids and proves that the
ciphertext differs from the plaintext before the UI journey begins.

Maestro owns login, Rooms navigation, all five Room openings, six image opens
and six lightbox closes. Read-only renderer observations are scoped to the
exact event row and require each image bubble and lightbox image to be complete
with positive natural width. The journey checks the initial Room A visit, then
two complete A-to-B-to-A rounds. Its exact inventory is 47 unique records: five
Room-readiness assertions, 18 image-readiness assertions and 24 lightbox
assertions.

```bash
pnpm nx run trinity-e2e-android:media-retention --skipNxCache
# Equivalent package command:
pnpm e2e:android:media-retention
```

The uncached serial target owns both `android-avd` and `synapse`, permits one
attempt with zero retries, and has a 20-minute Node timeout inside a 25-minute
CI wrapper. Shard 2 runs it immediately after location-share and uploads
`android-media-retention` diagnostics only after its started marker is written.
Teardown closes any open lightbox before detaching the WebView, closes the
fixture, clears application data and releases the device resource. The fixture
then leaves and forgets both Rooms, logs out, zeros plaintext, ciphertext and IV
buffers, and discards its remaining references.

Artifact redaction and scanning reject generated credentials, authorization
and cookie values, bearer or Matrix tokens, MXC and blob URLs, JWK/IV/hash
material, the raw pinned PNG and every raster diagnostic.

The runtime provenance helper hashes the built APK before installing it and
compares that SHA-256 with the installed package's base APK before the journey
begins. It invalidates any prior receipt before an attempt. It retains both
digests, APK byte length, renderer manifest digest/commit, the exact requested
WebView profile and its digest, and observed Android API/model. Missing,
ambiguous or mismatched installed-binary evidence fails the invocation rather
than producing a success receipt. The receipt omits local and installed file
paths; existing host diagnostics may retain diagnostic filesystem paths.
The requested WebView profile is distinguished from the actual
emulator model; it is not evidence of an unmodified native viewport.

Local acceptance used the unchanged Pixel 5 API 36 profile with SHA-256
`43933884ed001211f80f6c95204e0efc6e8ca53615b538a7fda5d3f97020a516`,
production renderer manifest SHA-256
`71cd40d1e0e23f8e5de591436f89f8a846d6d8c532dd28b5bef8f90bce79f7fc`
and debug APK SHA-256
`d047b42b4f5e40e50eb08a924211d0e39f6f38ae53d9cbbb8d1df8c42d92274b`.
Three unchanged-input uncached invocations passed:

- `muc546xs-44928afb-4730-4447-88aa-a8f7ed746ba9` in 285.401 seconds;
- `muc5bmh1-c6157b2d-2e57-44f9-9291-031102add674` in 283.626 seconds;
- `muc5ivvt-6073790d-c117-4332-9e01-e25796190be8` in 286.209 seconds.

Every invocation recorded one passed stage, 47/47 unique assertion records,
attempt 1, zero retries and zero failures. Each tree contains 288 retained
files, including 33 passing native-flow JUnit reports and 33 completed Maestro
commands. The Room-readiness, event-scoped bubble, decode, named-dialog and
hidden-dialog receipts cover the initial visit and both full navigation rounds. The
built-in scan and an independent bearer/Matrix/media/JWK scan passed for all
three trees, no raster files were retained, and no emulator remained after
teardown.

The unchanged browser predecessor passed with one worker and zero retries in
invocation `muc5r2hk-785517c9-f15a-4b2e-b0ff-3acdfdd3f469` (one test in
5.347 seconds; 5.965-second suite). All three pinned hashes were rechecked.
Final production-renderer invocation
`muc5ugzq-bcfc1b40-a243-4926-97e2-eb6f13b420f8` passed its nine required
projects while nine host-specific projects were intentionally skipped. The
resulting verified 49-file, 15,302,553-byte manifest has SHA-256
`d9bf24966f616f6713ae7bb17b3f99b073a36e9ec73e81d3c46c53913cd9d875`;
the subsequent prebuilt Android build passed with debug APK SHA-256
`b79830be593fbde57dec19e91b9c64e9005e3b9e6f42b3f877cd758f7dfbc38c`.

Three setup diagnostics were not accepted: one exposed that image readiness
does not guarantee its native tap point is in the viewport, and two showed that
the mobile conversation must use its native Back to rooms control before a
Room switch. The final flow now performs a native timeline scroll before each
image tap and follows the established native mobile-back path between Rooms.
The first hosted run, `35686583472`, used merge
`a0201a1384112a0a3850e8080c17783e6d2b58e2` and production renderer manifest
`fe5a4052361a1c0d5d3c6c817141ca4f017454416ffd7fbafa6aca59c02e9fa1`.
Its media-retention invocation
`muc9hm6q-a3214a17-39cd-469a-9681-e904935a3105` passed all 47 records on
attempt 1 with zero retries in 347.759 seconds. Artifact `10679433167`
(`sha256:6c5455ea86a8b6aa1311c4f1aceb6a96c754b0ee0897eca89f7511cb3bcf1f1b`)
contains 33 passing native-flow JUnits, 33 completed command reports and both
complete navigation rounds. Independent record, fixture and credential/media
scans passed. The unchanged browser predecessor passed at retry 0 in 8.491
seconds in artifact `10677971452`.

That hosted artifact predates the installed-APK provenance receipt and does
not retain the exact APK fingerprint, so it is not complete hosted acceptance.
At that point the new receipt still required hosted validation. Shard 2 failed
later in the separate `android.legacy-sso` provider-sign-in stage; that entire
CI run was not green. The complete Playwright predecessor remains enabled,
and nothing here authorizes merging PR #677.

The provenance follow-up passed three unchanged-input local Android first
attempts, each with 47/47 records, zero retries and clean device/Synapse teardown:

- `mucatdhf-997391e4-7505-4e8f-b5a0-c7e81a59b4d4`: 283.838 seconds;
- `mucb0y88-ad64fdba-eed4-4835-b8ef-e3abd824340a`: 281.320 seconds;
- `mucb8gmu-d861384d-926c-4e4d-8aea-337a68bd455d`: 282.876 seconds.

Each independently audited 289-file artifact includes 33 passing native-flow
JUnits, 33 completed command reports, 25 trusted matched point receipts and the
same runtime receipt digest
`aa48dc9bc39839e440c6a0ed21382ba49ab092751afcb2dfcbe6648dc572a8e8`.
The installed and pre-install APK digests both equal
`2a974c372bc86d9091a36796127a8b464a17100c2d9011b7c8942b142c202884`;
renderer manifest digest is
`c54fb215ed407058a36123339c29af3900a13fc71b5a25cf26a8fecf732ced87`,
requested WebView profile digest is
`3bacc567648982dd6b92b0e62b085908ad33cdced196ac6776d397a3a5d65157`,
and the observed device is API 36 `sdk_gphone64_x86_64`. All exact semantic,
fixture and credential/media/raster scans passed. Independent review accepted
the receipt and local evidence after stale-output and install-order regression
tests. The full scripts suite passed 1,088 tests; Android typecheck/lint, format,
documentation checks and production-renderer validation passed.

The exact unchanged browser predecessor passed in its intended development
configuration with one worker and zero retries in
`mucbjtmx-01e2500f-f72a-4e2c-bbf2-5322bc647863` (5.248-second test).
A supplemental attempt to run the canonical browser configuration against the
production PWA failed before login in
`mucbfx6n-b1adb201-a47f-4660-9f4a-514a2b4cf8c3`: its trace records a certificate
error and subsequent 504 during discovery with the PWA worker loaded,
consistent with the documented worker/self-signed-TLS failure. Unlike the
canonical development harness, the production-renderer
suite explicitly blocks service workers for that known local TLS boundary.
That diagnostic remains retained and is not claimed as a passing production
PWA test. The tested production bundle was preserved and restored with its
original manifest verified; no predecessor or application source was changed.

Hosted provenance acceptance was completed on original attempt 1 of
[run 35699645053](https://github.com/quwisky/trinity-matrix-client/actions/runs/35699645053),
feature head `fdda489cc260b4fb3ca72867669e8c429f60bcab` and merge
`ca56bf016fa9ac6a03912279cd79a391fab3edb0`.
[Android artifact 10689057060](https://github.com/quwisky/trinity-matrix-client/actions/runs/35699645053/artifacts/10689057060)
has independently verified archive SHA-256
`b39c8c741f0b367a3865af86daa1f9738373e79f77b6ecc48408b2783959789c`.
Invocation `mucgoi8y-2f7ed12d-6d8f-4474-ac5a-96b106e2e195` passed its
453.825-second stage with all 47 exact semantic records, both complete
navigation rounds, attempt 1, zero retries and zero failures. Its 289 files
include 33 passing native-flow JUnits, 33 completed command reports,
158 completed commands and 25 trusted matched point receipts. The source-verified
fixture and its receipt confirm separate plaintext/encrypted events, the exact
PNG, correct AES-CTR-256 construction and ciphertext integrity; the semantic
records confirm repeated decoding.

The runtime receipt SHA-256 is
`9b026965728380371a7c68e95f6ed293e4820708e14c1a7909121d901eb3bbb3`.
Its pre-install and installed APK fingerprints both equal
`a0ffc3906cff51911bdf1337ddec3c6bd560eca224fe430fa87d7f216085a3e1`
(14,525,891 bytes). The exact hosted helper source was checked against the
locally validated implementation; the full APK is not itself in the artifact.
The receipt identifies production renderer manifest
`8aa794f732f82364ec381a864a18ac5dacca1d00b2acb0f2181afc6feaf11051`,
independently verified against all 49 renderer-bundle files. Its requested
WebView profile digest remains
`3bacc567648982dd6b92b0e62b085908ad33cdced196ac6776d397a3a5d65157`.
The actual hosted AVD is `pixel_6`, API 36, with observed model
`sdk_gphone64_x86_64`; the requested Pixel 5 WebView profile is not a claim
about unmodified emulator geometry.

The unchanged exact predecessor passed at retry 0 in 8.538 seconds in
[browser artifact 10683090625](https://github.com/quwisky/trinity-matrix-client/actions/runs/35699645053/artifacts/10683090625)
(317 passed, one expected Android-only geometry skip). Its canonical harness
uses a development bundle, distinct from the verified production bundle.
[Renderer-test artifact 10682562356](https://github.com/quwisky/trinity-matrix-client/actions/runs/35699645053/artifacts/10682562356)
reports nine applicable passes and nine intentional project skips, with zero
retries. All seven hosted contract/fixture/journey/provenance/predecessor/helper
source pins matched the locally validated bytes. Owned cleanup, Synapse
teardown and the final shard-2 unchanged-worktree check passed.

Independent scans of the full Android artifact, including parent logs, found
none of the required credential, token, attachment-key/IV/hash, media-URL,
raw-media or raster classes. One identifier-hygiene limitation is retained:
each of the two disposable fixture event IDs appears three times in native
selector console logs, duplicated in the shared suite log (12 occurrences
across two files). Semantic and trusted-point receipts redact these IDs.
These identifiers are not credentials or media authorization and are outside
the issue's explicit secret-redaction classes; this is disclosed rather than
claimed as artifact-wide identifier removal.

This completes the scoped #741 hosted acceptance, not full CI reliability.
Shard 1 reached its job time limit; shard 2 later failed the separate
`space-settings-core` `admin.photo-feedback` observation. The earlier
`legacy-sso` and `sso-recovery-reset` suites passed in this follow-up run.
Unrelated failures remain under #665. All predecessors stay enabled and
PR #677 stays draft/open and unmerged.

## Message action sheet journeys

Suite `android.message-action-sheet` implements the five phone definitions in
`e2e/browser/journeys/conversations/message-action-sheet.spec.mts` without
editing or retiring them. The source is pinned at SHA-256
`df1d0bdb6a3ea0e2b16227d26b00b5b8138485cfba27b8ee4782945c22cb91aa`;
its long-press, Room, clearance and restoration helpers occupy lines 29–143.
The five definition spans are 151–214, 216–239, 241–259, 261–306 and 308–334.
The touch-platform pin is
`8bbf71ffc3e83010599c30ed5c2c347972f5a7b559daa6394613e33af2c43ee1`;
application-login and Account pins remain
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.

The inventory is 54 unique stage-local identities: 35 direct assertions plus
five Room-readiness, twelve clearance and two restoration expansions.
Reply, quick reaction, backdrop dismissal, virtualized latest and Thread
target own 18 + 4 + 4 + 18 + 10 records respectively. Each stage creates its
own Account and private Room; the virtual stage sends exactly 80 ordered
fillers and one newest target and reads back every ready event from Synapse.

Maestro owns login, Room opening, 750 ms long presses, timeline and sheet
swipes, Reply, the exact quick 👍 reaction, jump-to-latest, Thread opening and
exposed-backdrop taps. Renderer observations are read-only: they measure the
single named Message actions dialog, absence of hover controls, connected
target bounds inside its own scroller, the eight-pixel sheet gap, viewport and
Cancel reachability. Native swipes must change the measured scroll offset in
the intended direction; DOM actions and scroll assignment are forbidden.
Paginated history explicitly measures position relative to the bottom, so
loading older events cannot disguise a real native swipe by rebasing the top
offset. It requires both physical offset displacement and logical progress
beyond two pixels, with an unchanged viewport; content growth alone does not
pass. Sheet swipes and other callers retain the strict top-offset default.

Grouped latest rows have no avatar, so this stage opts into a measured blank
row-padding long-press fallback. The default non-selectable target strategy
is unchanged. The fallback excludes glyphs, links, media and controls by eight
CSS pixels, hit-tests a rounding envelope against the exact row, and checks
the transformed native start, drift endpoint and observed pointer path.
Pre-existing or resulting text selection fails; application selection styles
are unchanged. A successful press still needs every sheet/target assertion.

Native Thread testing exposed an application gesture conflict with the default
message-swipe setting of `off`: the open drawer captured the initial touch and
cancelled the row's long press. The drawer now waits for more than ten CSS
pixels of rightward closing movement before taking capture; edge opening is
unchanged. An open action sheet cancels the pending drawer gesture. Composed
row/drawer regression tests cover long press, continued movement beneath the
sheet, deliberate closing and vertical scrolling without changing preferences.

Reply checks the exact author banner. Reaction checks both its own visible
chip and a ready server event with the exact sender, target and annotation
key. Backdrop dismissal must leave no reply banner or reaction and preserve
the target content. The virtual stage requires the oldest exact filler,
native return to the single newest target, fewer than 80 rendered rows and
latest-state preservation. Both virtual and Thread targets must restore
their scroller-relative position within two CSS pixels after dismissal.

```bash
pnpm nx run trinity-e2e-android:message-action-sheet --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-action-sheet
```

The uncached serial target owns `android-avd` and `synapse`. It uses one
attempt, zero retries, a 45-minute test budget, a 50-minute Node wrapper and
a 55-minute CI wrapper, leaving bounded time for setup and teardown.
Shard 2 runs it immediately after media retention. The
`android-message-action-sheet` artifact uploads only after its started marker.
Before any stage, `runtime-provenance.json` binds the pre-install and installed
APK hashes, production renderer manifest and requested WebView profile to the
observed Android API/model.

Each started stage records its status, assertion count, duration and
pass/failure captures. Teardown closes open sheets and Threads, detaches the
client, clears application data, leaves and forgets fixture Rooms, logs out
and releases the device. Final redaction and scanning reject generated
credentials, bearer/Matrix tokens, native Preferences data and raster files.
Local installed acceptance completed on 2026-09-22 with three consecutive
frozen-input runs: `mucu0lge-47f72f0c-ee0d-4089-93c4-fad539d2d558`,
`mucueqmy-ac888006-b974-4503-9148-467f1ab94a19` and
`mucut2w3-d7d2913d-29e6-4a68-878b-9780063147db`. Each passed 5/5 stages and
54/54 unique records on attempt 1 with retries 0. Post-cleanup audits accepted
native-input, exact semantics, geometry/restoration, reaction, provenance,
redaction, raster absence and teardown evidence against production renderer
`92adf61a41d30a8fa686ed1d7edd6d9d8dec66ff83fd6c40cb3a262d9f309118`,
built/installed APK
`41b5476044ee265dda142e2af4284682446cf1404dd4ed800019e8a22490f705`,
requested profile
`3bacc567648982dd6b92b0e62b085908ad33cdced196ac6776d397a3a5d65157`
and observed API 36 / `sdk_gphone64_x86_64`. The earlier
`muctgn79-ff2a8067-4cb3-4a01-a5a8-e106c5f89d09` infrastructure attempt remains
a disclosed failure: Maestro stalled before executing the backdrop-stage rail
tap and required supported runner shutdown after its timeout; it is not counted
as acceptance. The implementation plan records the full local verification and
failure history. Original-attempt hosted acceptance remains pending; PR #677
stays draft/open and this local evidence does not authorize closing #742.

## Edit-history journeys

Suite `android.edit-history` migrates the two Android-applicable definitions in
`e2e/browser/journeys/conversations/message-edit-history.spec.mts` without
editing or retiring any Playwright predecessor. The source is pinned at
SHA-256 `66b251c72f0939a9913fb31641107f500d22cf627ff7b566740e15e744c37153`.
The 46 revision-lifecycle records map to lines 123–396. The Pixel 5 stage maps
three shared helper assertions (lines 108, 111 and 116) plus 13 direct
assertions (lines 500–552), for 16 records and 62 unique ordered records in
total. The 25 assertion sites in the desktop-only definition (lines 398–495)
are deliberately excluded from Android parity.

Private Matrix REST fixtures create the edit chains and verify live/redacted
server relations after both removals. For the separately redacted original,
direct event reads prove its edit remains live with the exact wire payload;
Synapse suppresses relation listings on that redacted parent. Maestro owns
every product action:
login, Room and marker navigation, dialog toggles, native scrolling, Remove,
confirmation and Close. WebView inspection reads exact text, diff markup and
geometry only; it never drives input or changes the viewport. The Pixel 5
profile is 393×727 CSS pixels at DPR 2.75. A reversible device lease applies
real Android `font_scale=1.5`, proves the computed WebView root grows to at
least 24px while the viewport and DPR remain fixed, and restores the prior
setting even after cancellation. It does not claim that this crosses the
desktop breakpoint.

```bash
pnpm nx run trinity-e2e-android:edit-history --skipNxCache
# Equivalent package command:
pnpm e2e:android:edit-history
```

The uncached serial target owns `android-avd` and `synapse`: one attempt, zero
retries, a 40-minute Node budget and 45-minute CI wrapper. Shard 2 runs it
immediately after message-action-sheet. `runtime-provenance.json` binds the
production renderer, pre-install and installed APK hashes, requested profile
and observed Android device. Each started stage records its source, status,
duration and exact assertion identities in `journeys.json`. Fixture and device
cleanup can revoke a provisional pass. Diagnostics are scrubbed and scanned
for credentials, bearer tokens, native-storage payloads and rasters; the
`font-scale-applied.json` and `font-scale-restored.json` receipts bind the
computed root to the device setting and its verified prior-value readback. The
`android-edit-history` upload requires both the started marker and the
post-scan `publication-safe` marker. The unchanged local acceptance runs
`mueib9ke-cbc0592f-32e1-4bc4-9838-ca2b7bf602a9`,
`mueildta-e8ee93e2-182a-4c2e-94c6-2a216ec3f272`, and
`mueividb-a250bd45-1631-4819-b3df-712931b7c2b7` each passed on attempt 1
with zero retries, 2/2 stages, 62/62 ordered unique records, exact
built/installed APK SHA-256
`c31635bd7044b7f7af6e93dd3a0f304ca5f2762e5f26400abc7068ade50484ba`,
production renderer manifest
`94065126105ef6fb2d616b5790ea1892a6849bc70f6391a64c07e255b4b4d92e`,
server-chain and font-scale receipts, no retained rasters, and a
`publication-safe` marker. The unchanged browser predecessor passed 3/3 with
`--workers=1 --retries=0`. An earlier Pixel attempt that could not reach a
clipped marker was not counted; the fixture now uses a compact sender for the
post-scale native reopen, and all three accepted attempts use that revision.
Original-attempt hosted acceptance passed in run `35937835285` at head
`24dc07fb`: Android artifact `10788745273` contains both passed stages and
62/62 records on attempt 1 with zero retries; all three retained browser
predecessors and the production renderer passed. The later unrelated
legacy-SSO and Astro-version failures remain with #665. PR #677 remains
draft/open and unmerged.

## Message-forward journey

Suite `android.message-forward` migrates the Android branch of the one
`forwards a message to another room` definition (lines 31–95) and its
`openRoom` helper (lines 18–26) in
`e2e/browser/journeys/conversations/message-forward.spec.mts`. The source is
pinned at SHA-256
`4776cbb08bea3b92eb5d0e2203b50b77261e4e3191acad94595b5db2f190fcd3`;
the helper pins are recorded in #744. The Playwright predecessor remains
enabled; it now sends its draft through the shared `sendComposerDraft` helper,
which taps Send on a mobile target. Its three direct and four helper-expanded
assertions map as follows:

| Canonical assertion | Android parity identity |
| --- | --- |
| Source `openRoom` composer readiness (helper line 23) | `message-forward.source-room-ready` |
| Source row visible (line 72) | `message-forward.source-row-visible` |
| `waitForSent` real event readiness (line 73) | `message-forward.source-server-ready` |
| Android action sheet ready (line 78) | `message-forward.sheet-ready` |
| Room picker search visible (line 86) | `message-forward.picker-visible` |
| Target `openRoom` composer readiness (helper line 23) | `message-forward.target-room-ready` |
| Target row visible (line 92) | `message-forward.target-row-and-event` |

One disposable-Synapse account owns unique source and target Rooms. Native
composer input, sent by a measured native tap on the composer's Send button
(since d3b27323, Enter in the composer inserts a new line on a mobile device),
produces a source row with a server-ready `$` ID; a direct
source-Room event read verifies exact Room, sender and body before native
long-press. Maestro opens the Android action sheet, touches Forward, enters
the target name in the production picker and touches its one exact Room
result. On the mobile Room view, Maestro taps Back to rooms and then opens the
exact target channel natively. Its encoded route must identify that target
Room and the active account. The visible target row's new ID
is read directly from Synapse; the event must have the exact active sender,
Room, body and `m.text` content without a stale relation or edit payload.
WebView observations do not drive product actions. The suite uses one attempt,
zero retries, serialized `android-avd` + `synapse`, exact APK/renderer/profile
provenance, native pass/failure captures, bounded cleanup and scrubbed,
publication-safe diagnostics. CI starts the shard-2 suite after edit-history
and before cross-user; its dedicated artifact requires both a started marker
and the post-scan safety marker.

```bash
pnpm nx run trinity-e2e-android:message-forward --skipNxCache
```

Three unchanged local installed-Android runs (`muf0i79g`, `muf0niuc`,
`muf0t57r`) passed all seven records at attempt 1/retries 0 after final
cleanup/cancellation review fixes. Their installed APK digest
`c31635bd7044b7f7af6e93dd3a0f304ca5f2762e5f26400abc7068ade50484ba`,
renderer manifest digest
`a67e948b8c83c7b44c38a042016a41d4f2fa3628c7d0b2419188643cad1c890a`
and Pixel 5 profile digest
`3bacc567648982dd6b92b0e62b085908ad33cdced196ac6776d397a3a5d65157`
match. The unchanged browser predecessor passed 1/1 at retry 0 (`muf06aic`).
Original-attempt hosted Android/browser/renderer audit remains pending under
#744; PR #677 remains draft/open and unmerged.

## Message-grouping journey

Suite `android.message-grouping` owns the Android stage of the unchanged
`grouped messages line up with the first of their group` predecessor in
`e2e/browser/journeys/conversations/message-grouping.spec.mts`: fixture and
helper lines 25–52, test lines 57–234, and the explicit Android return at
line 234. Its SHA-256 is
`9cdd8dcd5722dabe4783b9f045bcff56ab4c50adfce51f2ce9ba8e33884dd05f`.
The desktop-only tail at lines 237–643 is excluded; the Playwright definition
remains enabled and untouched. The exact 22 source-ordered parity records are:

| Canonical assertion | Android parity identity |
| --- | --- |
| Exact named non-DM Room opened (lines 96–103) | `message-grouping.room-visible` |
| First body visible (lines 106–110) | `message-grouping.body-first` |
| Second body visible (lines 106–110) | `message-grouping.body-second` |
| Third body visible (lines 106–110) | `message-grouping.body-third` |
| One group-header avatar (line 114) | `message-grouping.avatar-count` |
| Two continuations (line 115) | `message-grouping.continuation-count` |
| First used 40 px lead (lines 120–132) | `message-grouping.lead-first` |
| Second used 40 px lead (lines 120–132) | `message-grouping.lead-second` |
| Third used 40 px lead (lines 120–132) | `message-grouping.lead-third` |
| First text left edge (lines 134–146) | `message-grouping.text-left-first` |
| Second text left edge (lines 134–146) | `message-grouping.text-left-second` |
| Third text left edge (lines 134–146) | `message-grouping.text-left-third` |
| Cosy start padding inside border box (line 166) | `message-grouping.cosy-start-padding` |
| Cosy continuation padding (line 167) | `message-grouping.cosy-continuation-padding` |
| Cosy start margin zero (line 178) | `message-grouping.cosy-start-margin` |
| Android has no hover toolbar (line 184) | `message-grouping.phone-no-toolbar` |
| Compact used column gap 8 px (line 198) | `message-grouping.compact-column-gap` |
| Compact total used row height lower (line 228) | `message-grouping.compact-total-height` |
| Compact start padding 12 px (line 229) | `message-grouping.compact-start-padding` |
| Compact start margin zero (line 230) | `message-grouping.compact-start-margin` |
| Compact continuation padding zero (line 231) | `message-grouping.compact-continuation-padding` |
| Compact trailing body gap within 1 px (lines 232–233) | `message-grouping.compact-body-end-gap` |

One fresh Account/private non-DM Room receives three exact consecutive
same-sender Matrix events. Maestro owns login, Room and Settings navigation,
production Compact selection, and the Room return. A read-only WebView
observer scopes the three ordered `data-mid` rows and measures used boxes;
read-only native `run-as` confirms the exact version-1 Compact Preferences
envelope. The suite has one attempt and zero retries, serialized
`android-avd` + `synapse` resources, exact APK/renderer/profile provenance,
pass/failure captures, bounded cleanup and scrubbed diagnostics. Shard 2 runs
it after message-forward and before cross-user; its dedicated upload requires
both a started flag and the post-scan `publication-safe` marker.

```bash
pnpm nx run trinity-e2e-android:message-grouping --skipNxCache
```

Local installed-Android, unchanged browser predecessor, and original-attempt
hosted Android/browser/renderer evidence form the acceptance gate for #745;
wiring alone does not establish parity or authorize issue closure.

Three historical unchanged local installed-Android original attempts on the
scanner and production bundle (`mufkay5v-9c27f3d8-3391-4b84-8eae-668c79ebe34b`,
`mufkfyij-f05a2503-9b69-4bab-bb19-82b625a681c6`, and
`mufkkw1e-1e7c8c6f-8352-411e-8015-d6a824be9732`) passed 1/1 stage,
22/22 unique source-ordered records, attempt 1/retries 0, three distinct
hashed event receipts, exact Compact persistence-version receipt, and the
post-cleanup safety marker. The installed APK digest was
`83afd99c082a5eb77accb7b1af3130659b5135614a965c3726806e3430470291`,
the renderer manifest digest was
`91669b7d2aacfd0b665fa9dbb1615e3e55763b22a6d9462631651576aba7aa7a`,
and the Pixel 5 profile digest was
`3bacc567648982dd6b92b0e62b085908ad33cdced196ac6776d397a3a5d65157`
in each run. The unchanged browser predecessor passed 1/1 at retry 0
(`mufjzxn3-3e598a59-0b01-4d4d-9f33-16420ccef4cb`). The production
renderer passed all nine applicable matrix tests (nine project-filtered
skips) in `mufk59az-51d6316c-ddb1-494c-9a45-b0a578850813`.

Two earlier original attempts remain retained as failures: `mufj1sqx` found
that Settings needed a native Back-to-rooms action, and `mufj7rm8` found a
diagnostic scanner false positive on ordinary JUnit XML. A subsequent
pre-review prototype passed but was not counted in the final unchanged
three-run set after its receipts and scanner were strengthened.

Original-attempt hosted run 36064938227 (merge `bb2c43f8`, head `dc777187`)
passed the shard-2 target in 5m49s: 1/1 stage, 22/22 records, attempt 1 and
zero retries, with matching built and installed APK digests and the audited
hosted production manifest
`76307d547d1e6a2dcec8aa73fdd30d6df696b25e827c9950828a18b8de996399`. An
identifier audit of every raw, URI-decoded and double-decoded token in the
132-file artifact found zero matches for the four protected Room/event
digests. The same run's browser predecessor and production renderer were
reconciled at zero executed retries, so #745 is accepted and closed. The run's
unrelated shard failures remain #665 reliability work.

Independent review of `7cec1c4b` subsequently found two false-pass paths:
the density observer could accept a commented-out entry or malformed XML,
and a visible row could hide its `.msg__text` while retaining geometry.
The corrected observers require structural XML validation and visible,
positive-size message-text boxes. The regression controls execute the
parser and renderer observation, rather than merely matching source text.
The historical three-run set above does not satisfy final acceptance after
these changes; a fresh unchanged native set and hosted audit are required.

The corrected implementation passed three fresh unchanged local attempts:
`mufof9ad-4c5cc4a8-558f-4c1f-b065-05ce0be9a141`,
`mufol54l-3036f9d2-04e5-422d-bf10-8792c2aa0ab4`, and
`mufoq2v5-46c5570f-e871-4162-b51a-3f8c4eade822`. Independent artifact audit
confirmed 1/1 stage, 22 ordered receipts, attempt 1/retries 0, 15 successful
Maestro flow reports, native Compact persistence, clean teardown and the
safety marker in each. Measured total height decreased from 161.875 to
154.875 px, with the exact 8 px Compact gap and zero trailing body gap.
Each run used installed/file APK SHA-256
`ef40006792346ce2b861dc426fe3e104996b967a5229205a3f1dc1a3dbd6522d`,
production renderer manifest
`807340bf23bfb8bd9208018ed7fc5d3678e95912b26231404ab0d0ee2bb3a0ee`
at `7cec1c4b` plus the reviewed observer corrections, and the same Pixel 5
profile digest above. The exact browser predecessor passed at retry zero
in `mufouvmg-6e52a0a0-3d12-4e5a-9166-52d2cd36921a`.
The production renderer then passed all nine applicable tests (nine
project-filtered skips) in `mufow7oj-9f403155-ca50-4a54-9e09-b3a1828a152f`.

The artifact audit found seven incidental nonfixture event identifiers in
each run's SDK diagnostics; none matches its three protected fixture-event
digests. Credentials, tokens, fixture identities/bodies and native storage
payloads remain redacted. Complete removal of every incidental identifier
is not claimed. The 67 focused regression tests and independent correction
review pass. The full scripts suite has 1,272 passes and the same unrelated
untracked-plan command-policy failure; full formatting still flags ignored
execution notes. Corrected original-attempt hosted acceptance remains
pending; #745 stays open and PR #677 stays draft/unmerged.

## Message-linkify journey

Suite `android.message-linkify` owns the
`renders a bare URL in a message as a clickable link` predecessor in
`e2e/browser/journeys/conversations/message-linkify.spec.mts`: test lines
28–73 and the Room-opening helper at lines 15–23. Its SHA-256 is
`dd48aadd26ab1d960077d71ad68cd4ee8bf9b836706b4beb4620a34e7f7551a3`, and the
Playwright definition remains enabled. Its only change since the migration sends
the draft through the shared `sendComposerDraft` helper, which taps Send on a
mobile target. The two source-ordered parity records are:

| Canonical assertion | Android parity identity |
| --- | --- |
| Room helper composer visible (line 20) | `message-linkify.room-ready` |
| One visible exact bare-URL link (lines 66–72) | `message-linkify.link-visible` |

One fresh Account and Room are arranged through Synapse. Maestro owns login,
Room navigation and native composer input of the exact plain text
`look at https://example.com`: the lowercase prefix goes through the
anti-capitalization focused fill, and the URL is appended mid-sentence, so
neither Android auto-capitalization nor a wrapped caret line changes it. A
measured native tap on the composer's Send button sends it, as in the forward
and mention suites: since d3b27323, Enter in the composer inserts a new line on
a mobile device, so only Send sends. The row must reconcile to a
real server event whose content is that exact `m.text` body with no
`format`/`formatted_body`, relation or replacement, so the link comes from
render-time linkification rather than seeded HTML. A read-only WebView
observation of that exact `data-mid` row requires one visible anchor whose
text and `href` are both exactly `https://example.com`, the surrounding
`look at` outside every anchor, and no other link to that destination in the row
or timeline. The server-generated link-preview card (#739) also links there; it is
recorded as a receipt and excluded from the duplicate counts. The link is never activated and no public URL is contacted.

The suite has one attempt and zero retries, serialized `android-avd` +
`synapse` resources, exact APK/renderer/profile provenance, pass/failure
captures, bounded cleanup, and raw plus URL-encoded identifier scrubbing.
Shard 1 runs it after Room HTTP error recovery; its dedicated upload requires
both the started flag and the post-scan `publication-safe` marker.

```bash
pnpm nx run trinity-e2e-android:message-linkify --skipNxCache
```

Three unchanged installed-Android first attempts, the unchanged browser
predecessor at retry 0, and audited original-attempt hosted
Android/browser/renderer artifacts form the acceptance gate for #746.

Accepted at `a8412fdd`. Three unchanged local first attempts
(`mugrkj7d-09440da8-6e2c-447f-8f33-f51b5c95e892`,
`mugrrhqz-939f05e2-9cf9-42e2-bda4-de914b5dd08e`,
`mugryzlp-fc6e4d3a-5443-4f7e-bc55-6647aca62d39`) and the original-attempt hosted
shard-1 artifact of run 36123072543 (`mugwklxg-989ebce0-7c60-4507-9466-d6ade4962d0b`)
each passed 2/2 records at attempt 1 and zero retries, with matching built and
installed APK digests, the publication-safe marker and no protected Room or event
identifier. The unchanged predecessor passed at retry 0 locally and in the same
hosted browser run, and the production renderer had nine applicable passes.

## Matrix-link journeys

Suite `android.message-links` migrates the six Android-applicable definitions
of the unchanged Matrix Room/user-link predecessor
`e2e/browser/journeys/conversations/message-links.spec.mts` (605 lines,
SHA-256 `513b7f01b026991d316479edf06caef9754e70cc0df157a37436a67982aeb400`)
into one serial six-stage installed-Android Node/Maestro suite. The Playwright
predecessor remains enabled and untouched. The helpers occupy lines 22–147 and
the six stages map to definitions 156–230, 232–321, 323–362, 364–424, 433–504
(the portrait sheet, whose `test.use` at 427–431 is 390×844 mobile with touch)
and the Android branch 507–587 of the mention definition. The issue's span
507–604 would count the web-only popover tail at 588–604; the suite pins the
Android `return;` at line 587 instead and excludes that tail's six assertion
sites. The guard also pins `e2e/support/app.mts`, `e2e/support/account.mts`,
`e2e/browser/support/contrast.mts`, `e2e/fixtures.mts` and
`e2e/support/navigation.mts`.

The suite records 63 ordered, globally unique identities: 38 direct + 25
inherited, with stage totals 6/16/9/12/14/6. Helper assertions are keyed by
call site, so two `createRoom` expansions in one stage keep distinct
identities. `37@118←237` reads as helper line 37 reached through line 118
inside `localScenario`, called at line 237.

| Stage | Source line (helper@call) | Kind | Canonical assertion | Android parity identity |
| --- | --- | --- | --- | --- |
| `joined-preview` | 129@206 | inherited | `openRoom` source composer visible | `message-links.joined-preview.room-open` |
| `joined-preview` | 214 | direct | Room-link preview visible | `message-links.joined-preview.preview-visible` |
| `joined-preview` | 215 | direct | Preview name is the joined target name | `message-links.joined-preview.target-name` |
| `joined-preview` | 217 | direct | Primary action reads `Open room` | `message-links.joined-preview.open-action` |
| `joined-preview` | 218 | direct | Source composer placeholder still names the source Room | `message-links.joined-preview.source-still-active` |
| `joined-preview` | 225 | direct | After Open, the composer placeholder names the target Room | `message-links.joined-preview.target-opened` |
| `federated-join` | 37@118←237 | inherited | `localScenario` → `loginApi` response OK | `message-links.federated-join.api-login` |
| `federated-join` | 76@120←237 | inherited | `localScenario` → `createRoom` source Room OK | `message-links.federated-join.source-room-created` |
| `federated-join` | 58@239 | inherited | `registerRemote` on the secondary server OK | `message-links.federated-join.remote-registered` |
| `federated-join` | 76@248 | inherited | `createRoom` public aliased remote Room OK | `message-links.federated-join.remote-room-created` |
| `federated-join` | 100@255 | inherited | `sendRoomLink` encoded-alias link OK | `message-links.federated-join.link-sent` |
| `federated-join` | 129@270 | inherited | `openRoom` source composer visible | `message-links.federated-join.room-open` |
| `federated-join` | 274 | direct | Preview name is the remote Room name | `message-links.federated-join.remote-name` |
| `federated-join` | 277 | direct | Preview topic is the remote Room topic | `message-links.federated-join.remote-topic` |
| `federated-join` | 280 | direct | Primary action reads `Join room` | `message-links.federated-join.join-action` |
| `federated-join` | 283 | direct | Source composer placeholder still names the source Room | `message-links.federated-join.source-still-active` |
| `federated-join` | 291 | direct | After Join, success notice contains `Room joined` | `message-links.federated-join.joined-notice` |
| `federated-join` | 295 | direct | Primary action reads `Open room` | `message-links.federated-join.open-action` |
| `federated-join` | 296 | direct | Primary action is focused | `message-links.federated-join.open-focused` |
| `federated-join` | 304 | direct | Light success-notice contrast ≥ 4.5 | `message-links.federated-join.light-contrast` |
| `federated-join` | 308 | direct | Dark success-notice contrast ≥ 4.5 | `message-links.federated-join.dark-contrast` |
| `federated-join` | 316 | direct | After Open, the composer placeholder names the remote Room | `message-links.federated-join.remote-opened` |
| `remote-unavailable` | 37@118←328 | inherited | `localScenario` → `loginApi` response OK | `message-links.remote-unavailable.api-login` |
| `remote-unavailable` | 76@120←328 | inherited | `localScenario` → `createRoom` source Room OK | `message-links.remote-unavailable.source-room-created` |
| `remote-unavailable` | 58@329 | inherited | `registerRemote` on the secondary server OK | `message-links.remote-unavailable.remote-registered` |
| `remote-unavailable` | 76@334 | inherited | `createRoom` private remote Room OK | `message-links.remote-unavailable.remote-room-created` |
| `remote-unavailable` | 100@338 | inherited | `sendRoomLink` Room-id link with `via` OK | `message-links.remote-unavailable.link-sent` |
| `remote-unavailable` | 129@353 | inherited | `openRoom` source composer visible | `message-links.remote-unavailable.room-open` |
| `remote-unavailable` | 359 | direct | Load error visible | `message-links.remote-unavailable.load-error-visible` |
| `remote-unavailable` | 360 | direct | Load error reads `Room not found` or `Room unavailable` | `message-links.remote-unavailable.load-error-guidance` |
| `remote-unavailable` | 361 | direct | No primary action | `message-links.remote-unavailable.no-primary-action` |
| `rejected-join` | 37@118←369 | inherited | `localScenario` → `loginApi` response OK | `message-links.rejected-join.api-login` |
| `rejected-join` | 76@120←369 | inherited | `localScenario` → `createRoom` source Room OK | `message-links.rejected-join.source-room-created` |
| `rejected-join` | 58@370 | inherited | `registerRemote` on the secondary server OK | `message-links.rejected-join.remote-registered` |
| `rejected-join` | 76@375 | inherited | `createRoom` public remote Room OK | `message-links.rejected-join.remote-room-created` |
| `rejected-join` | 100@379 | inherited | `sendRoomLink` `matrix:roomid` link with `via` OK | `message-links.rejected-join.link-sent` |
| `rejected-join` | 129@394 | inherited | `openRoom` source composer visible | `message-links.rejected-join.room-open` |
| `rejected-join` | 399 | direct | Primary action reads `Join room` | `message-links.rejected-join.join-action` |
| `rejected-join` | 413 | direct | Remote join rule changed to `invite` after preview | `message-links.rejected-join.join-rule-invite` |
| `rejected-join` | 418 | direct | After Join, action error visible | `message-links.rejected-join.action-error` |
| `rejected-join` | 421 | direct | Primary action still reads `Join room` | `message-links.rejected-join.join-retained` |
| `rejected-join` | 422 | direct | Primary action is focused | `message-links.rejected-join.join-focused` |
| `rejected-join` | 423 | direct | Preview still visible | `message-links.rejected-join.preview-retained` |
| `portrait-sheet` | 37@118←439 | inherited | `localScenario` → `loginApi` response OK | `message-links.portrait-sheet.api-login` |
| `portrait-sheet` | 76@120←439 | inherited | `localScenario` → `createRoom` source Room OK | `message-links.portrait-sheet.source-room-created` |
| `portrait-sheet` | 76@441 | inherited | `createRoom` portrait target Room OK | `message-links.portrait-sheet.target-room-created` |
| `portrait-sheet` | 100@444 | inherited | `sendRoomLink` Room-id link OK | `message-links.portrait-sheet.link-sent` |
| `portrait-sheet` | 129@459 | inherited | `openRoom` source composer visible | `message-links.portrait-sheet.room-open` |
| `portrait-sheet` | 465 | direct | Room-link preview visible | `message-links.portrait-sheet.preview-visible` |
| `portrait-sheet` | 466 | direct | Host has class `room-link-preview--sheet` | `message-links.portrait-sheet.sheet-class` |
| `portrait-sheet` | 469 | direct | Primary action reads `Open room` | `message-links.portrait-sheet.open-action` |
| `portrait-sheet` | 492 | direct | Viewport is portrait | `message-links.portrait-sheet.portrait` |
| `portrait-sheet` | 493 | direct | Sheet left edge within 1 px of 0 | `message-links.portrait-sheet.left-edge` |
| `portrait-sheet` | 494 | direct | Sheet right edge within 1 px of the viewport width | `message-links.portrait-sheet.right-edge` |
| `portrait-sheet` | 497 | direct | Sheet bottom within 1 px of the visual-viewport bottom | `message-links.portrait-sheet.bottom-edge` |
| `portrait-sheet` | 500 | direct | Action footer top ≥ 0 | `message-links.portrait-sheet.footer-top` |
| `portrait-sheet` | 501 | direct | Action footer bottom ≤ visual-viewport bottom + 1 | `message-links.portrait-sheet.footer-bottom` |
| `mention-user-card` | 129@566 | inherited | `openRoom` mention Room composer visible | `message-links.mention-user-card.room-open` |
| `mention-user-card` | 573 | direct | User card visible | `message-links.mention-user-card.card-visible` |
| `mention-user-card` | 574 | direct | User card name is the display name | `message-links.mention-user-card.card-name` |
| `mention-user-card` | 579 | direct | No connected-position popover bounding box | `message-links.mention-user-card.no-anchored-popover` |
| `mention-user-card` | 582 | direct | Dialog contains the display name | `message-links.mention-user-card.dialog-name` |
| `mention-user-card` | 583 | direct | Composer placeholder still names the mention Room | `message-links.mention-user-card.room-retained` |

Separate two-server REST fixtures arrange, alter and observe state on the real
primary and federated secondary Synapse servers: API logins, remote
registrations and Rooms with read-backs, exact formatted link sends, bounded
federation probes before any UI step, the S4 join-rule change and membership on
both servers. Tokens stay closure-private and errors carry only method, path
template and status. Maestro owns every product action through current-point
taps: login, Room navigation, message-link and mention taps, preview Join,
Open and Close, and Appearance selection. Read-only WebView observers measure
preview state, placeholders, anchors, the applied mode, success contrast,
portrait geometry, the dialog model and a navigation marker; they never click,
focus, press keys, scroll or write classes, styles, attributes or the location.

Documented reinterpretations of the predecessor:

- **Native taps.** The predecessor's Android `focus()` + Enter workaround
  (`activateRoomLinkPrimary`, lines 141–142, and the inline copies at 289–290
  and 416–417) becomes a native Maestro tap. Focus parity at 296 and 422 is
  observed read-only after the tap and never produced.
- **Appearance path and S2 rejoin.** The predecessor toggles the `dark` class
  directly (298–313). The suite selects Light, and later Dark, through the
  production Settings → Appearance mode radios, proving a mode-only change
  against theme, density, text-scale and code carriers. Because the success
  notice is component-local and a reopened joined Room previews without it,
  S2 joins the same federated Room twice. After the Light join and contrast
  record, the preview is closed, the local user leaves through REST, and the
  leave is proved on both servers and in the sidebar. The Dark join repeats
  the Join; its observations before 308 are receipts, not parity identities.
  Line 308 and the Open at 316 use the same alias, Room id and link as 274–304.
- **Header Back.** Each Appearance round trip returns through the in-app
  `trn-page-header` Back button, which calls `location.back()` once at desktop
  width, and must restore the exact prior route. It uses no hardware Back and
  no viewport re-apply.
- **Physical footer receipt.** S5 keeps the nine CSS geometry assertions
  (±1 CSS px against the visual viewport) and adds a viewport-fit receipt
  (390×844, DPR 1, portrait, wholly inside the WebView), a hidden IME, two
  identical geometry samples, and a physical-reach receipt: the mapped Open
  and Close button bottoms must sit at or above the device's single
  navigation-bar frame from `dumpsys window`, and `elementFromPoint` must hit
  both buttons. The primary action is never tapped in S5.
- **S6 coarse-pointer receipt.** S6 runs at the desktop profile and records
  `(pointer: coarse)`, the `android` platform and a navigation marker before
  the mention tap. Line 582 also requires one modal `User` dialog containing
  the user card inside a global overlay wrapper with a dark backdrop; 583
  requires an unchanged marker and route. A profile read-back of the display
  name precedes any UI step.
- **Raised polling bounds.** Every wait is finite and at least the
  predecessor's bound. These are polling bounds, not parity semantics.

| Observation | Predecessor | Android |
| --- | --- | --- |
| composer after Room open | 15 s | 30 s |
| preview name / load error / `Join room` | 20 s | 30 s |
| success / action error | 30 s | 45 s |
| navigation placeholder | 20/30 s | 30 s |
| user card | 15 s | 30 s |
| federation probes | — | 60 s |
| leave sync / membership proof | — | 30 s |
| other visible / focused / text | 5 s default | 15 s |

S1–S4 and S6 run at the 1280×720 non-mobile desktop profile used by the
retained android-webview configuration; S5 runs at the 390×844 portrait
profile. The suite writes `profiles.json` with each stage's requested profile
digest and a per-stage `profile-applied.json`.

```bash
pnpm nx run trinity-e2e-android:message-links --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-links
```

The uncached serial target owns `android-avd` and `synapse` (which includes
the secondary server): one attempt, zero retries, and the suite stops at the
first failed stage. Its provisional budgets are a 45-minute Node test, a
50-minute Nx timeout and a 55-minute CI wrapper, to be re-derived from the
local acceptance runs. Shard 4 runs it after Security settings and before
retained Playwright. Two-server cleanup runs every bounded step even after a
failure; a cleanup, scrub or scan failure blocks publication. Diagnostics are
scrubbed of raw and encoded identifiers, tokens, authorization headers,
rasters and Preferences XML. The `android-message-links` upload requires both
the started flag and the post-scan `publication-safe` marker.

Three unchanged installed-Android first attempts, the unchanged android-webview
and browser predecessors at retry 0, and audited original-attempt hosted
Android/browser/renderer artifacts form the acceptance gate for #747; wiring
alone does not establish parity or authorize issue closure.

Accepted at `e8a7cd9b`. Three unchanged local first attempts
(`muh04lgt-8017375c-a0f7-4ffc-8ed5-16ba66d17b46`,
`muh0w3e9-19bef8b7-b377-49a5-a7e2-a2715ef149ed`,
`muh1mpgf-5dbf167e-0ad8-4693-91d9-256cd416eef1`) and the original-attempt hosted
shard-4 artifact of run 36148661883 (`muh6ugrk-ff8e3210-3dc8-43fd-85d2-e3857c76a1b8`)
each passed 63/63 records (6/16/9/12/14/6) at attempt 1 and zero retries, with
matching built and installed APK digests, the publication-safe marker and no
protected Room, event or link identifier. The unchanged android-webview
predecessor passed 5/5 at retry 0 locally, the browser predecessor passed its five
applicable definitions at retry 0 in the same hosted run, and the production
renderer had nine applicable passes.

## Message-Markdown journeys

Suite `android.message-markdown` migrates the three Android-applicable
definitions of the unchanged Markdown predecessor
`e2e/browser/journeys/conversations/message-markdown.spec.mts` (279 lines,
SHA-256 `128f6ae2660c02a9f6e0d64726999ead4960454b66cb369306f9f27b3bb0baa8`)
into one serial three-stage installed-Android Node/Maestro suite. The
Playwright predecessor remains enabled and untouched. The stages map to
definitions 52–125 (`formatting`), 127–168 (`task-list`) and the Android
branch 170–224 of the language-caption definition (`code-caption`), which
ends at the explicit `return;` on line 224 after `if (isAndroidE2E) {` on line 214. The desktop hover-toolbar tail at
225–278 and its two assertion sites (276, 277) are excluded. Lines 29–47 hold
the exact authoritative Room-event reader. The guard also pins
`e2e/support/message-composer.mts`
(`4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d`),
`e2e/support/app.mts`
(`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`) and
`e2e/support/account.mts`
(`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`).

The suite records 37 ordered, globally unique identities: 20 direct + 17
inherited, with stage totals 18/7/12. The inherited sites are three Room
readiness (`openNamedRoom`, helper line 13), five composer-send readiness
pairs (`sendComposerLines`: the send control on line 75, then
`sendComposerDraft`'s mobile Send button on line 53), three real-server echoes (`waitForSent`,
app line 178) and one action-sheet readiness (`openMessageActionSheet`, app
line 220). `178@102#2` reads as helper line 178 reached from the call on line
102 in the second run of its literal two-item loop; a helper call runs before
a matcher on the same line, so `220@223` precedes `223`, and one call's helper
lines run in execution order, so `75@85` precedes `53@85`.

| Stage | Source line (helper@call) | Kind | Canonical assertion | Android parity identity |
| --- | --- | --- | --- | --- |
| `formatting` | 13@82 | inherited | `openNamedRoom` composer visible | `message-markdown.formatting.room-ready` |
| `formatting` | 75@85 | inherited | `sendComposerLines` send enabled for the plain draft | `message-markdown.formatting.plain-send-ready` |
| `formatting` | 53@85 | inherited | `sendComposerDraft` Send button enabled for the plain draft | `message-markdown.formatting.plain-send-enabled` |
| `formatting` | 86 | direct | Plain `plain one` text visible | `message-markdown.formatting.plain-visible` |
| `formatting` | 75@92 | inherited | `sendComposerLines` send enabled for the bold draft | `message-markdown.formatting.rich-send-ready` |
| `formatting` | 53@92 | inherited | `sendComposerDraft` Send button enabled for the bold draft | `message-markdown.formatting.rich-send-enabled` |
| `formatting` | 94 | direct | Rendered-Markdown `rich two` text visible | `message-markdown.formatting.rich-visible` |
| `formatting` | 95 | direct | Bold run reads `bold one` | `message-markdown.formatting.bold-run` |
| `formatting` | 96 | direct | Exactly one `<br>` | `message-markdown.formatting.one-break` |
| `formatting` | 178@102#1 | inherited | `waitForSent` plain row has a `$` event id | `message-markdown.formatting.plain-server-echo` |
| `formatting` | 178@102#2 | inherited | `waitForSent` bold row has a `$` event id | `message-markdown.formatting.rich-server-echo` |
| `formatting` | 114 | direct | Plain `body` is `plain one\nplain two` | `message-markdown.formatting.plain-body` |
| `formatting` | 115 | direct | Plain event has no `format` | `message-markdown.formatting.plain-no-format` |
| `formatting` | 116 | direct | Plain event has no `formatted_body` | `message-markdown.formatting.plain-no-formatted-body` |
| `formatting` | 118 | direct | Formatted event declares `org.matrix.custom.html` | `message-markdown.formatting.formatted-format` |
| `formatting` | 119 | direct | `formatted_body` contains `<br>` | `message-markdown.formatting.formatted-break` |
| `formatting` | 120 | direct | `formatted_body` contains `<strong>bold one</strong>` | `message-markdown.formatting.formatted-bold` |
| `formatting` | 124 | direct | Formatted `body` keeps the Markdown source | `message-markdown.formatting.formatted-source` |
| `task-list` | 13@154 | inherited | `openNamedRoom` composer visible | `message-markdown.task-list.room-ready` |
| `task-list` | 75@160 | inherited | `sendComposerLines` send enabled for the task draft | `message-markdown.task-list.send-ready` |
| `task-list` | 53@160 | inherited | `sendComposerDraft` Send button enabled for the task draft | `message-markdown.task-list.send-enabled` |
| `task-list` | 163 | direct | Rendered task list visible | `message-markdown.task-list.list-visible` |
| `task-list` | 164 | direct | List contains `☑ shipped` | `message-markdown.task-list.checked-glyph` |
| `task-list` | 165 | direct | List contains `☐ pending` | `message-markdown.task-list.unchecked-glyph` |
| `task-list` | 167 | direct | No `input` in the list | `message-markdown.task-list.no-checkbox-input` |
| `code-caption` | 13@197 | inherited | `openNamedRoom` composer visible | `message-markdown.code-caption.room-ready` |
| `code-caption` | 75@202 | inherited | `sendComposerLines` send enabled for the lead | `message-markdown.code-caption.lead-send-ready` |
| `code-caption` | 53@202 | inherited | `sendComposerDraft` Send button enabled for the lead | `message-markdown.code-caption.lead-send-enabled` |
| `code-caption` | 75@204 | inherited | `sendComposerLines` send enabled for the fenced block | `message-markdown.code-caption.code-send-ready` |
| `code-caption` | 53@204 | inherited | `sendComposerDraft` Send button enabled for the fenced block | `message-markdown.code-caption.code-send-enabled` |
| `code-caption` | 207 | direct | Rendered code block visible | `message-markdown.code-caption.code-visible` |
| `code-caption` | 178@208 | inherited | `waitForSent` code row has a `$` event id | `message-markdown.code-caption.server-echo` |
| `code-caption` | 212 | direct | Code row has `msg--cont` | `message-markdown.code-caption.continuation-row` |
| `code-caption` | 217 | direct | Code row has no `.msg__toolbar` | `message-markdown.code-caption.no-hover-toolbar` |
| `code-caption` | 218 | direct | `pre::after` content contains `python` | `message-markdown.code-caption.language-caption` |
| `code-caption` | 220@223 | inherited | `openMessageActionSheet` sheet visible | `message-markdown.code-caption.sheet-ready` |
| `code-caption` | 223 | direct | Returned Message actions sheet visible | `message-markdown.code-caption.sheet-visible` |

Each stage arranges one fresh Account and private Room through real Synapse
with the predecessor's `Markdown`/`Tasks`/`Overlap` name templates. No
message under test is seeded through REST: Maestro and Android key input own
login, Room opening, every Markdown line, every line break, every send and the
code-row long press. The first line of each draft goes through the
anti-capitalization focused fill behind the digit sentinel `1` (Ctrl+Home,
Forward Delete, Ctrl+End). Every further line starts with a native Enter key event:
Enter inserts a line break on a mobile device, and the composer turns it into a
line break or, for `- [x] shipped`, a `- [ ] ` continuation, as the
predecessor's Shift+Enter does. A Shift+Enter chord is not used because Gboard
re-dispatches it without Shift. The line is then appended at the caret by a flow that never
erases or dismisses the keyboard. A line that starts with a letter is typed
behind the same sentinel, because Android capitalizes a new paragraph.
A digit replaces the shared fill's default `x` because Gboard autocorrected
the `x`-joined first word: `xplain one` became `Explain one`, and removing the
first character then left `xplain one`, the value of an unremoved sentinel.
Gboard leaves a digit-led word unchanged. The caret walks left over the line, Backspace removes the sentinel and Ctrl+End
restores the caret. The exact composer value is read back after every step.
The keyboard is then dismissed through the IME-aware helper, the composer's
Send button is proved enabled for the exact draft, and a native tap on it
sends, as `sendComposerDraft` does on a mobile device and as the forward,
mention and linkify suites send.

Documented reinterpretations of the predecessor:

- **Server truth.** The formatting stage reads the Room with the predecessor's
  exact `/messages?dir=b&limit=50` reader (filtered to `m.room.message`,
  oldest first). It requires exactly the two native sends, in order, with the
  reconciled row ids, the active sender and original `m.text` content.
  `formatted_body` must hold exactly one `<br>`. The plain row must render as
  pre-wrap plain text with its literal newline, never as a `<br>`.
- **Task glyphs.** Lines 164–165 also require exactly two list items reading
  `☑ shipped` and `☐ pending`. Line 167 also rejects any checkbox role or type.
  A receipt proves the ready server event carries the continued source and
  the same glyphs on the reconciled row.
- **Ready continuation.** The 500 ms pause before the fenced block becomes a
  proved ready lead event. Line 212 requires the ready code row to continue
  that lead directly. Line 218 requires `pre[language="python"]` and
  `::after` content of exactly `"python"`. The action sheet is opened by a
  measured native 750 ms long press and proved as the message-forward suite
  proves it: one visible `Message actions` dialog with one visible Forward
  action. No sheet action is taken.

All three stages run at the Pixel 5 profile (393×727 CSS pixels, DPR 2.75,
mobile and touch), as the message-linkify suite does, and each writes
`profile-applied.json`. This is a deviation from the retained android-webview
configuration's 1280×720 non-mobile desktop profile. It was adopted when a
stray `x` (`xplain one`) was attributed to that profile. The same value later
appeared at the Pixel 5 profile, and its cause is the Gboard autocorrection
described above, which the digit sentinel removes at either profile. The installed app is a
mobile device in either profile, so Enter behaves the same, and the
desktop-only hover-toolbar tail is already excluded.

```bash
pnpm nx run trinity-e2e-android:message-markdown --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-markdown
```

The uncached serial target owns `android-avd` and `synapse`: one attempt,
zero retries, and the suite stops at the first failed stage. Its provisional
budgets are a 25-minute Node test, a 30-minute Nx timeout and a 35-minute CI
wrapper, to be re-derived from the local acceptance runs. Shard 5 runs it
last, after SSO recovery reset, because shard 1 has no room left in its budget. Cleanup runs every bounded step even after a
failure; a cleanup, scrub or scan failure blocks publication. Failure text
rethrown to the job log keeps only error names and messages with every
registered identifier redacted. Diagnostics are scrubbed of raw and encoded
identifiers, tokens, authorization headers, rasters and Preferences XML. The
`android-message-markdown` upload requires both the started flag and the
post-scan `publication-safe` marker.

Three unchanged installed-Android first attempts, the three exact Playwright
predecessors passing sequentially at retry 0, and audited original-attempt
hosted Android/browser/renderer artifacts form the acceptance gate for #748;
wiring alone does not establish parity or authorize issue closure.

Accepted at `117cf07a`. Three unchanged local first attempts
(`muham6xf-207c805d-e223-4269-9bcb-4588509b952a`,
`muhb7nam-4ec6374b-40a9-4ed7-a518-1108dadbaf9b`,
`muhbrzv6-b035bc98-9550-4cda-b3e9-c941689a2276`) and the original-attempt hosted
shard-5 artifact of run 36186649967 (`muhig4qa-cdb0c06c-076d-4cc1-b264-2abb56e15e39`)
each passed 37/37 records (18/7/12) at attempt 1 and zero retries, with matching
built and installed APK digests, the publication-safe marker and no protected
Room or event identifier in any file, including `process.log`. The hosted run
tested `1ff6adf0`, which differs from `117cf07a` only by a CI budget comment. The
unchanged predecessor passed its three definitions sequentially at retry 0 locally
and in the same hosted browser run, and the production renderer had nine
applicable passes.

## Message-poll journey

Suite `android.message-poll` migrates the single definition of the unchanged
poll predecessor `e2e/browser/journeys/conversations/message-poll.spec.mts`
(93 lines, SHA-256
`e23c045d237ba9fde15eb5a39d24479dfc2019e07579142c9193a8dc05ea1674`) into one
serial one-stage installed-Android Node/Maestro suite. The Playwright
predecessor remains enabled and untouched. The stage `create-vote-end` maps to
definition 27–92 (`creates a poll, votes, and ends it`) and expands the
predecessor's module-local Room-opening helper at 14–22. The guard also pins
`e2e/support/app.mts`
(`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`) and
`e2e/support/account.mts`
(`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`), the
question template `Best fruit ${runId}?`, the options `Apple` and `Pear`, the
Room name template `Poll E2E ${runId}` and the run suffix `p`.

The suite records 10 ordered, unique identities: 8 direct + 2 inherited. The
inherited sites are one Room readiness (the local `openRoom`, line 19) and one
real-server echo (`waitForSent`, app line 178). Helper expansion is resolved by
binding, so a shadowing local of the same name never counts. `19@54` reads as
helper line 19 reached from the call on line 54.

| Stage | Source line (helper@call) | Kind | Canonical assertion | Android parity identity |
| --- | --- | --- | --- | --- |
| `create-vote-end` | 19@54 | inherited | `openRoom` composer visible | `message-poll.create-vote-end.room-ready` |
| `create-vote-end` | 59 | direct | `composer-insert` visible | `message-poll.create-vote-end.insert-tray` |
| `create-vote-end` | 60 | direct | `composer-poll` count 0 | `message-poll.create-vote-end.no-inline-poll` |
| `create-vote-end` | 73 | direct | First `poll` visible | `message-poll.create-vote-end.poll-visible` |
| `create-vote-end` | 74 | direct | Poll contains the exact question | `message-poll.create-vote-end.poll-question` |
| `create-vote-end` | 75 | direct | Poll contains `0 votes` | `message-poll.create-vote-end.zero-votes` |
| `create-vote-end` | 178@80 | inherited | `waitForSent` poll row has a `$` event id | `message-poll.create-vote-end.server-echo` |
| `create-vote-end` | 86 | direct | Poll contains `1 vote` | `message-poll.create-vote-end.one-vote` |
| `create-vote-end` | 87 | direct | Poll contains `1 (100%)` | `message-poll.create-vote-end.one-hundred-percent` |
| `create-vote-end` | 91 | direct | Poll contains `Final results` | `message-poll.create-vote-end.final-results` |

The stage arranges one fresh Account and private Room through real Synapse.
No poll, vote or end is seeded through REST: Maestro owns login, Room
opening, the `+` tray, the Poll action, every field, Create, the Apple vote
and End. The Create poll dialog autofocuses its question, which the journey
proves read-only before the focused fill; each option is focused by a native
tap. Every value goes through the shared focused fill behind an opening
parenthesis. The digit sentinel of the Markdown suite cannot be used here:
Gboard joins a letter or digit to the first word and recases it on the next
space, so `1Best fruit` became `1best fruit` and `xBest fruit` became
`Xbest fruit` on the emulator, while `(` keeps `Best` a word of its own. The
exact dialog values are read back before the native Create tap. The shared
focused fill now waits, read-only and within 5 seconds, for the caret after
Ctrl+Home before Forward Delete, and after Ctrl+End before its final space.
Each key is a separate injection that the WebView applies later: on the
autofocused question, instrumentation showed the Forward Delete landing while
the caret was still at the end, so it deleted nothing and kept the sentinel,
and the fill passed only on its own second attempt. With the waits every
field settles on its first attempt.

Documented reinterpretations of the predecessor:

- **Phone tray.** Line 59 also requires the one `composer-insert` control to
  be the enabled mobile tray trigger (`aria-haspopup="dialog"`, closed). Line
  60 also requires no `insert-poll` action while the tray is closed.
- **Exact poll.** Line 73 requires exactly one visible poll in the Room. Line
  74 requires the exact question and exactly the options Apple then Pear.
  Line 75 also requires both options at `0 (0%)` and none chosen.
- **Server readiness before the vote.** After line 178, the Room is read with
  the raw `/messages?dir=b&limit=50` page. It must hold exactly one poll event:
  the `m.poll.start` with the reconciled row id, the active sender, the exact
  question, `m.poll.disclosed`, `max_selections: 1` and exactly `a0 Apple` and
  `a1 Pear`. Only then, with every option enabled, is Apple tapped.
- **Vote on the wire first.** Before lines 86–87 the Room must hold exactly
  the start and one `m.poll.response` from the active sender selecting `a0`,
  with an `m.reference` relation to the start event. The same poll row must
  then read `1 vote`, and Apple `1 (100%)`, chosen, with Pear `0 (0%)`.
- **End on the wire first.** Before line 91 the Room must hold exactly the
  start, the response and one `m.poll.end` from the active sender, related to
  the same start event. The same row must then read `1 vote · Final results`,
  keep Apple at `1 (100%)`, disable both options and render no End control.

The stage runs at the Pixel 5 profile (393×727 CSS pixels, DPR 2.75, mobile
and touch), as the Markdown suite does, and writes `profile-applied.json`.
Native actions log their selectors to the public job log, so rows are targeted
by test ids and text filters only; the poll's identity is proved by read-only
observation. Every Room, Account and poll event identifier is registered as a
secret before it can reach a diagnostic, and records hold only digests.

```bash
pnpm nx run trinity-e2e-android:message-poll --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-poll
```

The uncached serial target owns `android-avd` and `synapse`: one attempt and
zero retries. Its provisional budgets are a 15-minute Node test, a 20-minute
Nx timeout and a 25-minute CI wrapper, to be re-derived from the local
acceptance runs. Shard 1 runs it last, after message-linkify, and its budget
comment adds a provisional 6–8 minutes (about 113 native minutes). Cleanup
runs every bounded step even after a failure; a cleanup, scrub or scan failure
blocks publication. Failure text rethrown to the job log keeps only error
names and messages with every registered identifier redacted. Diagnostics are
scrubbed of raw and encoded identifiers, tokens, authorization headers,
rasters and Preferences XML. The `android-message-poll` upload requires both
the started flag and the post-scan `publication-safe` marker.

Three unchanged installed-Android first attempts, the exact Playwright
predecessor passing sequentially at retry 0, and audited original-attempt
hosted Android/browser/renderer artifacts form the acceptance gate for #749;
wiring alone does not establish parity or authorize issue closure.

Accepted at `e7d4187e`. Three unchanged local first attempts
(`muhjzz4s-9f471432-973d-4e00-b107-68b9d965adfb`,
`muhk8jd9-f6328ba1-20a5-41a0-bff9-cef1352f01a5`,
`muhkh7ny-7820bd74-a4b6-45e1-b894-3c59b42be34a`) and the original-attempt hosted
shard-1 artifact of run 36203167573 (`muhq7iup-d6f5df1b-db96-472c-a04e-1ccc4f79779c`)
each passed 10/10 records at attempt 1 and zero retries, with matching built and
installed APK digests, the publication-safe marker and no protected Room or event
identifier in any file, including `process.log`. No native focused fill needed its
internal retry. The unchanged predecessor passed at retry 0 locally and in the same
hosted browser run, and the production renderer had nine applicable passes.

## Message-quote journeys

Suite `android.message-quote` migrates both definitions of the unchanged quote
predecessor `e2e/browser/journeys/conversations/message-quote.spec.mts` (218
lines, SHA-256
`50b0e8a42aa1d61ee59b1c5dce97664365977aef7bc8b36aa3502e23e731064f`) into one
serial two-stage installed-Android Node/Maestro suite. The Playwright
predecessor remains enabled and untouched. The stages map to definition
42–115 (`quote-block`) and to the Android branches 183–187 and 201–205 of
definition 117–217 (`quote-capability`); the desktop hover-toolbar and
overflow-menu branches 88–90, 188–197 and 206–216, and their sites 193, 212
and 215, are excluded. Both stages expand the predecessor's module-local
Room-opening helper at 29–37. The guard also pins `e2e/support/app.mts`
(`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`),
`e2e/support/account.mts`
(`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`) and
`e2e/support/message-composer.mts`
(`4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d`), the
paragraphs `alpha ${runId}` and `omega ${runId}`, the inserted block
`> ${first}\n>\n> ${second}\n\n`, the answer `my point ${runId}`, the control
`plain ${runId}`, the Room names `Quote ${runId}` and `Quote none ${runId}`,
the run suffixes `q` and `qn`, and the image fixture: the 1×1 PNG bytes,
`image/png`, `filename=shot.png`, transaction `${runId}img` and
`{ msgtype: 'm.image', body: 'shot.png', url: mxc }`.

The issue pins the predecessor at
`fdd2a9dc98324aaea47a4d6fd3bf768bd35756119eafd4751faee849da5baf66`, its
`develop` version. This branch carries the Send-button change, which imported
`sendComposerDraft` and replaced three `composer.press('Enter')` calls with it;
the guard reconstructs the `develop` file from the pinned one and proves it
hashes to the issue pin. Every span therefore sits one line below the issue's.
`sendComposerDraft` waits for the composer's Send button (helper line 53)
before its mobile tap, an `expect` the Android path reaches, so each of the
three sends expands one composer-send readiness record, as in the Markdown
suite. The issue's 20 records are the 23 below without those three.

The suite records 23 ordered, globally unique identities: 13 direct + 10
inherited, with stage totals 12/11. The inherited sites are two Room
readiness (the local `openRoom`, line 34), three composer-send readiness
(`sendComposerDraft`, line 53), two real-server echoes (`waitForSent`, app
line 178) and three action-sheet readiness (`openMessageActionSheet`, app
line 220). Helper expansion is resolved by binding and the desktop branches
are read from the AST as the `else` of `if (isAndroidE2E)`. `34@71` reads as
helper line 34 reached from the call on line 71.

| Stage | Source line (helper@call) | Kind | Canonical assertion | Android parity identity |
| --- | --- | --- | --- | --- |
| `quote-block` | 34@71 | inherited | `openRoom` composer visible | `message-quote.quote-block.room-ready` |
| `quote-block` | 53@79 | inherited | `sendComposerDraft` Send enabled for the source | `message-quote.quote-block.source-send-enabled` |
| `quote-block` | 82 | direct | Source row visible | `message-quote.quote-block.source-visible` |
| `quote-block` | 178@83 | inherited | `waitForSent` source row has a `$` event id | `message-quote.quote-block.source-server-echo` |
| `quote-block` | 220@86 | inherited | `openMessageActionSheet` sheet visible | `message-quote.quote-block.sheet-ready` |
| `quote-block` | 94 | direct | Composer is exactly the inserted `>` block | `message-quote.quote-block.composer-quote` |
| `quote-block` | 53@101 | inherited | `sendComposerDraft` Send enabled for the quote | `message-quote.quote-block.answer-send-enabled` |
| `quote-block` | 104 | direct | Answer row visible | `message-quote.quote-block.answer-visible` |
| `quote-block` | 110 | direct | Exactly one blockquote | `message-quote.quote-block.one-blockquote` |
| `quote-block` | 111 | direct | Blockquote contains the first paragraph | `message-quote.quote-block.quotes-first` |
| `quote-block` | 112 | direct | Blockquote contains the second paragraph | `message-quote.quote-block.quotes-second` |
| `quote-block` | 114 | direct | Blockquote excludes the answer | `message-quote.quote-block.answer-outside` |
| `quote-capability` | 34@172 | inherited | `openRoom` composer visible | `message-quote.quote-capability.room-ready` |
| `quote-capability` | 53@178 | inherited | `sendComposerDraft` Send enabled for the control | `message-quote.quote-capability.control-send-enabled` |
| `quote-capability` | 181 | direct | Text control row visible | `message-quote.quote-capability.control-visible` |
| `quote-capability` | 178@182 | inherited | `waitForSent` control row has a `$` event id | `message-quote.quote-capability.control-server-echo` |
| `quote-capability` | 220@184 | inherited | `openMessageActionSheet` text sheet visible | `message-quote.quote-capability.text-sheet-ready` |
| `quote-capability` | 185 | direct | Text sheet shows Quote | `message-quote.quote-capability.text-quote-visible` |
| `quote-capability` | 187 | direct | Sheet gone after Cancel | `message-quote.quote-capability.text-sheet-closed` |
| `quote-capability` | 200 | direct | Image row visible | `message-quote.quote-capability.image-visible` |
| `quote-capability` | 220@202 | inherited | `openMessageActionSheet` image sheet visible | `message-quote.quote-capability.image-sheet-ready` |
| `quote-capability` | 204 | direct | Image sheet shows Copy | `message-quote.quote-capability.image-copy-visible` |
| `quote-capability` | 205 | direct | Image sheet has no Quote | `message-quote.quote-capability.image-no-quote` |

Each stage arranges one fresh Account and private Room through real Synapse.
The quoted source, the answer and the text control are never seeded: Maestro
owns login, Room opening, every keystroke, every Send, each long press, Quote
and Cancel. REST sends only the pinned image fixture, through the one additive
`sendImageMessage` fixture in `account-workspace-fixtures.mts`, and reads the
Room. The source is typed as the predecessor types it: the first paragraph
through the shared focused fill, two native Enter presses (a line break each
on a mobile device) and the second paragraph appended at the caret. Each
paragraph starts with a lowercase letter that Android capitalises at a new
paragraph, so it is typed behind the digit sentinel `1` of the Markdown suite;
the caret walks back, Backspace removes the sentinel and Ctrl+End restores the
caret. Every injected key waits, read-only, for the exact composer value and
caret the previous key produced. The answer is appended the same way after
Quote, which leaves the composer focused with its caret at the end. Every
send dismisses the keyboard, proves the Send button enabled for the exact
draft and taps it.

Documented reinterpretations of the predecessor:

- **Server truth.** After line 178 the Room is read with the raw
  `/messages?dir=b&limit=50` page. It must hold exactly the native sends so
  far, oldest first, with the reconciled row ids, the active sender, original
  `m.text` content and the exact bodies, including the source's real blank
  line.
- **Quote, not reply.** Before any rendered record the quote event must carry
  body exactly `> alpha …\n>\n> omega …\n\nmy point …`, `format`
  `org.matrix.custom.html`, and a `formatted_body` with exactly one
  `<blockquote>` holding both paragraphs and not the answer, followed by the
  answer. No `m.relates_to` of any kind, so no `m.in_reply_to`, and no reply
  fallback.
- **Rendered blockquote.** Lines 104–114 read the reconciled quote row by its
  event id: one visible real `blockquote` inside the rendered Markdown text,
  holding both paragraphs, with the answer rendered outside it.
- **Exact rows without identifiers.** Each long press targets
  `.scroll .msg[data-mid^="$"]` with a text filter (the first paragraph, the
  control, or `shot.png` as the predecessor finds the image row); a read-only
  observation first proves that exactly one row matches and that it is the
  proved event.
- **Android sheets.** Each sheet is proved as the message-forward suite proves
  it: one visible `Message actions` dialog with one visible Forward action.
  Cancel, the sheet's last button, is reached with bounded native in-sheet
  swipes. Quote absence on the image is read from the same open sheet that
  shows exactly one visible Copy.
- **Image row.** The pinned fixture carries no `info.mimetype`, so the
  renderer classifies it as `application/octet-stream` and draws a download
  tile named `shot.png`, the text the predecessor's `hasText` matches. Line
  200 requires exactly one such row, the fixture's event id, one media
  attachment and no message text.

Both stages run at the Pixel 5 profile (393×727 CSS pixels, DPR 2.75, mobile
and touch) and write `profile-applied.json`. Every Room, Account, event and
media identifier is registered as a secret before it can reach a diagnostic;
records hold only digests, and the scan also rejects `access_token` values.

```bash
pnpm nx run trinity-e2e-android:message-quote --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-quote
```

The uncached serial target owns `android-avd` and `synapse`: one attempt,
zero retries, and the suite stops at the first failed stage. Its provisional
budgets are a 20-minute Node test, a 25-minute Nx timeout and a 30-minute CI
wrapper, to be re-derived from the local acceptance runs. Shard 6 runs it
last, after Room widget settings, and its budget comment adds a provisional
12 minutes (about 118 native minutes). Cleanup runs every bounded step even
after a failure; a cleanup, scrub or scan failure blocks publication. Failure
text rethrown to the job log keeps only error names and messages with every
registered identifier redacted. Diagnostics are scrubbed of raw and encoded
identifiers, tokens, authorization headers, rasters and Preferences XML. The
`android-message-quote` upload requires both the started flag and the
post-scan `publication-safe` marker.

Three unchanged installed-Android first attempts, both exact Playwright
predecessor definitions passing sequentially at retry 0, and audited
original-attempt hosted Android/browser/renderer artifacts form the
acceptance gate for #750; wiring alone does not establish parity or
authorize issue closure.

## Message-receipts journey

Suite `android.message-receipts` migrates the single "seen by" definition of
the unchanged read-receipt predecessor
`e2e/browser/journeys/conversations/message-receipts.spec.mts` (166 lines,
SHA-256
`5d4d757364c6b5b1a5a0e148c8c17adf173296bb2f435730d2803ed7854baa42`, the
issue's pin, which this branch carries unchanged) into one serial one-stage
installed-Android Node/Maestro suite. The Playwright predecessor
remains enabled and untouched. The stage maps to definition 53–165 (`seen-by`) and
expands the predecessor's module-local Room-opening helper at 40–48; its
module-local API-token helper at 19–38 reaches no `expect` site. The guard
also pins `e2e/support/app.mts`
(`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`) and
`e2e/support/account.mts`
(`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`), the run
suffix `s`, the roles `rcpt-reader-`, `rcpt-author-` and `rcpt-seer-`, the
seer name `Cara${runId}` set before `createRoom`, the Room name
`Receipts E2E ${runId}` inviting author and seer, the body
`read receipt target ${runId}`, the transaction `rcpt-${runId}`, the `m.read`
receipt for the exact `eventId`, the locator
`.scroll [data-testid="read-receipts"]`, the `aria-label` matcher
`new RegExp(seerName)` and the four-edge intersection.

The suite records 4 ordered, unique identities: 3 direct + 1 inherited. The
inherited site is the Room readiness of the local `openRoom` (line 45).
Helper expansion is resolved by binding; `registerUser`, `apiToken` and
`login` add no site. `45@118` reads as helper line 45 reached from the call on
line 118. The mobile Send-button change does not touch this predecessor (it
sends through REST), so the issue's four records are the suite's four.

| Stage | Source line (helper@call) | Kind | Canonical assertion | Android parity identity |
| --- | --- | --- | --- | --- |
| `seen-by` | 45@118 | inherited | `openRoom` composer visible | `message-receipts.seen-by.room-ready` |
| `seen-by` | 122 | direct | First read-receipt cluster visible | `message-receipts.seen-by.cluster-visible` |
| `seen-by` | 123 | direct | Cluster `aria-label` names the seer | `message-receipts.seen-by.seer-named` |
| `seen-by` | 164 | direct | Cluster does not intersect its message text | `message-receipts.seen-by.text-clear` |

Three fresh Accounts (reader, author, seer) are arranged through real
Synapse exactly as the predecessor arranges them: the seer's display name
`Cara<run>` is set before the Room exists, the reader creates the Room
inviting author and seer, both join, the author sends the one text message
and the seer posts its real `m.read` receipt for that event id. REST only
arranges and observes; Maestro owns login as the reader and Room opening. No
text is typed beyond login. The Room is proved read-only through one
additive fixture in `account-workspace-fixtures.mts`, `roomReceipts`, which
reads the Room's `m.receipt` ephemeral events from one filtered,
non-blocking `/sync` as the reader's fixture session.

Documented reinterpretations of the predecessor:

- **Authoritative relation before launch.** Before any UI step, bounded
  independent reads must show: exactly one Room message, the author's
  original `m.text` with the exact body and event id; a seer invite from the
  reader and exactly one seer join, every seer member event carrying only
  `Cara<run>` (a name set after the join would add a second join); current
  `join` membership for all three; and exactly one unthreaded `m.read`
  receipt of the seer, on exactly that event. The relation is read again
  after the rendered records.
- **Event-scoped cluster.** The predecessor's `receipts.first()` must be
  owned by the exact message row (found read-only by its body and proved by
  its event id), be that row's first cluster and the document's first, and
  be a visible button with at least one avatar. An avatar elsewhere in the
  Room never satisfies line 122.
- **Exact accessible name.** Beyond `RegExp(seerName)`, the `Seen by …` name
  list must hold the seer exactly once, never the reader, only joined
  non-reader members, and one name per avatar. The installed app lists the
  author too: the SDK's implicit receipt for a sender's own message sits on
  the same event, so the device shows two names and two avatars.
- **Measured geometry.** The cluster and the exact row's first `.msg__text`
  are measured with `getBoundingClientRect` in one read-only expression; both
  boxes must be finite and non-zero and the four edge conditions are
  recomputed from the numbers. On the device the cluster sits below the text.

The stage runs at the predecessor's wide desktop profile (1280×720 CSS
pixels, DPR 1, no touch), the viewport of both Playwright projects that run
the predecessor, and writes `profile-applied.json`. Every Account, Room,
event and run-scoped text identifier is registered as a secret before it can
reach a diagnostic; records hold only digests, counts, booleans and measured
boxes, and the scan also rejects `access_token` values. The two native
selectors (`[data-testid="rail-rooms"]` and `.channel` with a text filter)
carry no identifier; the message row is never an action target.

```bash
pnpm nx run trinity-e2e-android:message-receipts --skipNxCache
# Equivalent package command:
pnpm e2e:android:message-receipts
```

The uncached serial target owns `android-avd` and `synapse`: one attempt and
zero retries. Its provisional budgets are a 10-minute Node test, a 15-minute
Nx timeout and a 20-minute CI wrapper, to be re-derived from the local
acceptance runs. Shard 3 runs it last, after member moderation, and its
budget comment adds a provisional 5 minutes (about 163 native minutes of the
240-minute job). Cleanup runs every bounded step even after a failure,
including the three Accounts' Room leave, forget and logout; a cleanup,
scrub or scan failure blocks publication. Failure text rethrown to the job
log keeps only error names and messages with every registered identifier
redacted. Diagnostics are scrubbed of raw and encoded identifiers, tokens,
authorization headers, rasters and Preferences XML. The
`android-message-receipts` upload requires both the started flag and the
post-scan `publication-safe` marker.

Three unchanged installed-Android first attempts, the exact Playwright
predecessor definition passing sequentially at retry 0, and audited
original-attempt hosted Android/browser/renderer artifacts form the
acceptance gate for #751; wiring alone does not establish parity or
authorize issue closure.
