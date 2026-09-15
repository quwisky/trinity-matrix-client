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
shard allows 180 minutes for smoke, this batch, its retained predecessor shard and
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
