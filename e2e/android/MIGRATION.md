# Android runner migration ledger

This ledger tracks the critical milestone owned by
[Deliver critical Android Maestro journeys](https://github.com/quwisky/trinity-matrix-client/issues/659).
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
