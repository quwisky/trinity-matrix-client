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
serialized `android-avd` and `synapse` resources, and has a 30-minute Node
timeout. CI runs it on shard 4 immediately after runner smoke and before the
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
