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

| Stage | Predecessor definition at `877925dd` | Required parity |
| --- | --- | --- |
| `unauthenticated-shell` | [App shell](app-shell.spec.mts), lines 8–14, and `expectLoginScreen` / `expectProtectedRouteRedirect` | Visible Homeserver and Continue; unauthenticated Settings navigation redirects to login. |
| `settings-touch-back` | [Navigation](navigation.spec.mts), lines 78–88 | Account-qualified Rooms, native touch opens Settings and its sections, hardware Back restores the rendered Rooms surface. |
| `authenticated-process-restart` | [Navigation](navigation.spec.mts), lines 90–101 | Native process restart restores the authenticated Rooms route and visible surface at this batch's revision. |
| `settings-section-back` | [Navigation](navigation.spec.mts), lines 103–140 | Retained 390×844 mobile/touch viewport; target ≥44px; Appearance heading focus; Back restores directory focus, overflow ≤1px, then Rooms. |
| `composer-keyboard-insert-back` | [Navigation](navigation.spec.mts), lines 166–244 | Actual IME resize and native text input; insert tray dismisses IME, stays within the restored viewport, and Back restores focus and collapsed ARIA state. |
| `members-back-order` | [Navigation](navigation.spec.mts), lines 246–299 | Focused Members filter and IME; ordered Back dismisses keyboard, Members, then Conversation. |
| `composer-formatting` | [Native formatting](composer-format-native.spec.mts), lines 48–98 | Native Aa/italic activation produces `say *hello*`, selection [5,10], editor focus and shown IME; sheet geometry and Back cancellation preserve content. |
| `native-appearance` | [Appearance](appearance.spec.mts), lines 75–219 | Android/coarse pointer, light Amethyst/Cosy and dark Onyx/Compact/Larger projections, native StatusBar state, 20px font, target/overflow/inset geometry and paired device/WebView proof. |

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

| Predecessor | Lines | Required parity |
| --- | --- | --- |
| [Account lifecycle](../browser/journeys/accounts/account-lifecycle.spec.mts) | 25–83 | Add second Account; encryption banner; menu labels and exact count; Escape focus; switch back. |
| Account lifecycle | 85–130 | Three Accounts, repeated switches, active-row no-op and absence of switch errors. |
| Account lifecycle | 132–191 | Two unread messages contribute to the recorded Badge total before and after an active Account switch. |
| Account lifecycle | 193–220 | Removing the active Account preserves the surviving Account and exact menu count. |
| Account lifecycle | 222–260 | Remove and re-add the same Account through the real persistent crypto-store lifecycle. |
| Account lifecycle | 262–283 | Remove the only Account, reach login and reconnect. |
| Account lifecycle | 285–300 | Cancel adding an Account and preserve the current Account and menu count. |
| Account lifecycle | 302–330 | Reconnect guidance, prefilled locked username, password entry and restored Account. |
| [Mixed workspace](../browser/journeys/accounts/mixed-account-workspace.spec.mts) | 16–71 | Mixed room visibility, owning-Account badge, active-row constraints and correct acting identity. |
| Mixed workspace | 73–128 | Mixed Space pills, owning-Account badge and correct acting identity. |
| Mixed workspace | 132–322 | Persist selection across reload; desktop keyboard navigation, focus restoration and geometry in both themes at 125% font size. |
| Mixed workspace | 339–478 | Pixel 5 profile; long Account names; both themes; actual short-list overflow, visible Done action, retained selection and focus. |
| Mixed workspace | 481–529 | Quick switcher excludes another Account's room until mixed in, then shows its badge and opens it as its owner. |
| Mixed workspace | 534–636 | Mixed invite visibility, distinct hydrated display names and the acting-identity header without an MXID fallback. |

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

The existing third Android CI shard runs the batch. Started-suite diagnostics live
under `dist/.playwright/trinity-e2e-android/<run-id>/android.accounts-workspace/`;
`accounts-workspace/journeys.json` records all started cases, original source
ranges and first-attempt outcomes. Acceptance remains pending until the issue
records complete installed-host parity, effective negative controls, repeated
first-attempt runs and current-revision CI evidence. Other Account journeys,
physical Android acceptance and the full migration reliability gate retain their
separate owners.
