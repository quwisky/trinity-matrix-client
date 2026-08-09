# Trinity — Code Quality, Architecture, Tests & Practices Audit

**Date:** 2026-08-09 · **Commit:** `d1f06273` (branch `develop`) · **Method:** read-only, five parallel
domain auditors, each finding re-verified against the cited line by an independent adversarial pass.
32 findings survived; every one below has been anchored to code that was actually read.

---

## 0. Scope corrections

Three premises in the audit brief do not match this repository. They were corrected before the audit
ran, so no finding below is an artefact of them:

| Brief says                                                    | Reality                                                                                                                                                                                                           | Consequence                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Ionic                                                         | No Ionic anywhere. UI is spartan-ng/Helm on Tailwind v4                                                                                                                                                           | Ionic sections dropped                                                                                        |
| Cloudflare Worker push gateway (APNs/FCM/UnifiedPush routing) | No Worker, no `wrangler` config. Push is FCM/APNs via `@capacitor/push-notifications` → a **configurable external gateway URL** (`PushGatewayService`), plus a separate web/desktop path in `NotificationService` | "Worker tests (vitest + miniflare/workerd)" is not applicable; the push findings target the real architecture |
| Forgejo CI                                                    | GitHub Actions (`.github/workflows/{ci,release,renovate}.yml`)                                                                                                                                                    | CI findings target the real pipeline                                                                          |

Two further notes on Phase 2: the app is **zoneless** (no zone.js), so "zone pollution from Matrix SDK
event listeners" cannot occur — that section was audited as signals/OnPush instead, and the zoneless
model turns out to _cause_ one real defect (M1). Forms are Signal Forms by design; their absence of
`ReactiveFormsModule` is not a finding. The brief skips Phase 4; Phase 1 is folded into §5 and §6.

---

## 1. Executive summary

**Health grade: B+ — a well-architected codebase with a small number of real, user-visible defects
concentrated at the platform edges.**

This is a strong codebase. The things that are usually wrong in a Matrix client are right here: the
"components never import matrix-js-sdk" rule is _machine-enforced_ and has zero violations; the project
graph is acyclic with no feature→feature edges; there is **zero use of the `any` type** in 316 non-spec
source files; every component is `OnPush`; TypeScript strictness is set once at the root and weakened
nowhere across 45 tsconfigs. The crypto layer is the most carefully reasoned part of the repo — the
recovery reset deliberately avoids `CryptoApi.resetEncryption` because it destroys key material before
the UIA that guards it, and the reasoning is written down at the site.

No **Critical** findings. The defects cluster in three places: the **platform edges** that no automated
gate in this repo can reach (iOS plist, Android manifest, Electron fuses), the **notification/push
delivery path**, and a handful of **lifecycle races** in otherwise-correct multi-account code. The
recurring theme is that the mechanism is right and one call site missed the guard its siblings all have.

### Top 5 risks

1. **iOS voice recording terminates the app** (H4) — `ios/App/App/Info.plist` declares camera and
   photo-library usage strings but not `NSMicrophoneUsageDescription`, while the composer offers a mic
   button on iOS. This is a TCC kill, not a catchable permission denial. It ships to real devices and
   cannot be caught by vitest, the Simulator flows, or CI.
2. **Notification tap never opens the notified room** (H3) — both tap paths navigate to
   `/rooms?room=<id>` and _nothing in the app reads that parameter_. The entire point of a notification
   is broken on every platform, and the specs are green because they assert against a mocked Router.
3. **A cancelled auth navigation can orphan a half-started client with its Rust crypto store open**
   (H1) — `authGuard` hands the Router a cold `restoreAll()` with no in-flight guard or `finalize`;
   a superseding navigation (the SSO/OIDC deep-link path this plumbing exists for) can leave a live
   client that the re-entrancy check cannot see, so a second `initRustCrypto` opens the same store.
4. **The Rust crypto store is exposed to Android device backup** (M9) — `allowBackup="true"` with no
   `dataExtractionRules`, and `initRustCrypto` is called with no store passphrase. The access token is
   correctly in the Keystore; the key material that actually decrypts messages is not.
5. **Nothing routes unhandled promise rejections to the app** (M1) — the zoneless bootstrap never calls
   `provideBrowserGlobalErrorListeners()`, so `TrinityErrorHandler` never receives the SDK rejections its
   own doc comment says it exists to filter. This is a risk _multiplier_: it is why H2's permanent
   voice-recorder wedge is silent.

---

## 2. Findings by severity

Ordering within a severity follows the stated priority: crypto/session > security > sync/push >
architecture > style.

### HIGH (4)

---

#### H1 · Cancelled navigation orphans a half-started MatrixClient with its crypto store open

**`libs/data-access/auth/src/lib/auth.guard.ts:19`**
(refs: `matrix-client.service.ts:356`, `:445`; `app.component.ts:110`; `electron/src/deep-link.ts:50`)

**What's wrong.** The guard returns the cold `matrix.restoreAll()` straight to the Router, which
unsubscribes guards when a navigation is superseded. `restoreAll() → add() → start()` is a long chain
(open per-account IndexedDB → `preloadCryptoWasm()` → `initRustCrypto({ cryptoDatabasePrefix })` →
`startClient()`) whose only cleanup is a `catchError` at `matrix-client.service.ts:445-452`. There is no
`finalize`, no `takeUntil`, and no in-flight map keyed by user id. The client is registered in
`this.clients` only at line 438 — _after_ all of that — so the re-entrancy guard
`if (this.clients.has(session.userId))` at line 356 cannot see an in-progress start.

**Why it matters.** On unsubscribe the created client is never `stopClient()`-ed, its `ClientEvent.Sync`
and `HttpApiEvent.SessionLoggedOut` listeners are never detached, and its IndexedDBStore is never
destroyed. The reachable path is the one the deep-link plumbing exists for: `AppComponent` navigates to
`/sso-callback` (app.component.ts:110) while the initial `''`→`/rooms` guard is still inside
`initRustCrypto`. When the callback then completes login for the same account, `start()` runs again and
a **second `initRustCrypto` opens the same crypto store**, alongside a second IndexedDBStore on the same
`dbName`. Two live crypto stores for one device is the shape that produces device-key divergence. The
orphan keeps syncing, unreachable. `auth.guard.spec.ts` has four tests, none covering cancellation.

**Fix.** Make `start()` idempotent per user id rather than relying on the caller's subscription
surviving. Add `private readonly starting = new Map<string, Observable<AccountClient>>()`, populate it
in the `defer` at `matrix-client.service.ts:352` with the chain wrapped in
`shareReplay({ bufferSize: 1, refCount: false })` so a second `start()` joins the first, and clear it in
a `finalize`. Add that `finalize` (not just `catchError`) so an unsubscribed start that never reached
line 427 runs the same teardown the error path does. Pin it with a spec that unsubscribes mid-
`initRustCrypto` and asserts `stopClient()` ran and no second `createClient` happens on the next login.

---

#### H2 · `VoiceRecorderService.stop()` rejects on an inactive recorder, permanently wedging voice messages

**`libs/platform-native/src/lib/voice-recorder.service.ts:113`**

**What's wrong.** `stop()` guards only on `!recorder` (null), never on state, then calls
`recorder.stop()` unguarded inside a Promise executor. Per the MediaStream Recording spec that throws
`InvalidStateError` when the recorder is already `inactive` — which happens on its own when the tracks
end (permission revoked mid-record, device grabbed by another app, a `MediaRecorder` error). Nothing
clears `this.recorder` on those transitions: there is no `onerror`, no `onstop`, no track-`ended`
listener. The throw becomes a rejection, so `stop()` rejects. **`cancel()` immediately below (lines
121-131) guards the identical call** with `if (recorder && recorder.state !== 'inactive')` plus a
try/catch — so this is an inconsistency inside one file, not an accepted design.

**Why it matters.** Three consequences chain. (1) The sole caller,
`message-composer.component.ts:978`, invokes it as `void …stop().then(…)` with no `.catch()` — and per
M1 nothing in this zoneless app routes unhandled rejections anywhere, so it is invisible. (2) The
rejection escapes before line 115, so `teardown()` never runs and **the microphone stream is never
released**. (3) `start()` opens with `if (this.recorder) { return; }` — a silent no-op — so every later
recording attempt succeeds without recording: the user watches the elapsed timer count up over a dead
recorder. **Voice messaging is dead for the rest of the session, with no error shown.** The spec only
covers `start()` failures.

**Fix.** Bail cleanly before awaiting: `if (recorder.state === 'inactive') { this.teardown(); return null; }`.
Wrap the `recorder.stop()` at line 113 in try/catch and resolve from the chunks already collected
instead of rejecting. Move `this.teardown()` into a `finally` so the mic is released on every exit path
— that alone removes the permanent wedge. Attach `recorder.onerror` in `start()` to null the handle, and
add a `.catch()` at message-composer.component.ts:978 that toasts the failure.

---

#### H3 · Notification tap never opens the notified room — nothing consumes the `room` query param

**`libs/data-access/notifications/src/lib/notification.service.ts:441`**
(and `push.service.ts:385`)

**What's wrong.** Both tap paths navigate to `/rooms` with `queryParams: { room: roomId }` — the
web/desktop path at notification.service.ts:440-442 and the mobile push path at push.service.ts:384-386.
**Nothing anywhere reads that parameter.** `app.routes.ts:23` declares `path: 'rooms'` with no param
handling; `RoomsPage` injects `Router` only to `navigateByUrl('/login')` and never injects
`ActivatedRoute`; room selection lives in `store.activeRoomId()`, written only by
`RoomShellNavigationService.onSelectRoom`/`closeOpenRoom`. A repo-wide search for `queryParamMap` /
`get('room')` finds consumers only in settings, crypto (`returnTo`, `reset`) and auth (`add`, `reauth`).

**Why it matters.** Clicking an OS notification — Electron toast, web Notification, or an FCM/APNs tap —
focuses the window and switches accounts correctly, then lands the user on whatever room was already
open. Never the room that notified. This is broken on **every platform**, and
`docs/reference/push-notifications.md:95` documents it as working. The unit tests
(notification.service.spec.ts:357,511,745; push.service.spec.ts:596,620,623) assert only that
`router.navigate` was _called_ with the param against a mocked Router — green and vacuous.

**Fix.** Consume it in the shell: inject `ActivatedRoute` in `RoomsPage` (or
`RoomShellNavigationService`) and react to `queryParamMap` — on a `room` value differing from
`store.activeRoomId()`, call `nav.onSelectRoom(roomId)`, then strip the param with a `replaceUrl`
navigation so Back does not re-open it. Because `/rooms` is usually already active, the component is not
re-created — a `snapshot` read is **not** enough; subscribe to the stream. Then replace the mocked-Router
assertions with a test that drives the real param through to `activeRoomId`.

---

#### H4 · iOS `Info.plist` has no `NSMicrophoneUsageDescription` — voice recording terminates the app

**`ios/App/App/Info.plist:61`**

**What's wrong.** The plist declares `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription` and
`NSPhotoLibraryAddUsageDescription` — and stops there (the dict ends at line 67). Voice messaging calls
`navigator.mediaDevices.getUserMedia({ audio: true })` (voice-recorder.service.ts:71) inside the
Capacitor WKWebView, gated only on `MediaRecorder` + `getUserMedia` being present — both true on
iOS 14.3+ — and rendered with no platform branch (`message-composer.component.html:258`).

**Why it matters.** iOS **terminates** an app that touches the microphone without the matching usage
string. This is not a denied-permission path the app can catch; it is a TCC kill. On a real device the
mic button is offered and tapping it crashes the app. `docs/platforms/mobile.md:120-123` enumerates
exactly the three keys that are present, so this is an omission rather than a decision — and it is
invisible to vitest, to CI, and to the Simulator flows the repo runs.

**Fix.** Add `<key>NSMicrophoneUsageDescription</key><string>Trinity needs microphone access to record
voice messages.</string>` and update the key list in `docs/platforms/mobile.md`. **While there:**
`GeolocationService.current()` drives WKWebView geolocation with no `NSLocationWhenInUseUsageDescription`
either, and the same composer tray offers `shareLocation()` — add that key too, or gate the affordance
off iOS.

---

### MEDIUM (13)

---

#### M1 · Zoneless bootstrap never installs global error listeners, so `TrinityErrorHandler` is inert

**`apps/trinity/src/main.ts:71`** · _(auditor said High; verification lowered it — this is an
observability regression, not a correctness one)_

**What's wrong.** `main.ts` provides `provideZonelessChangeDetection()` (line 67) and
`{ provide: ErrorHandler, useClass: TrinityErrorHandler }` (line 71), but never
`provideBrowserGlobalErrorListeners()` — the provider that installs the `window` `'unhandledrejection'`
and `'error'` listeners forwarding to `ErrorHandler`. Verified in the installed Angular 22.1.0:
`provideBrowserGlobalErrorListeners()` is the only thing that injects `globalErrorListeners`, and
`bootstrapApplication` does not pull it in. With zone.js absent there is no `NgZone.onUnhandledError`
doing it instead, and no `unhandledrejection` listener exists anywhere in the repo.

**Why it matters.** The handler's premise is dead. Its doc comment says "The SDK's internal rejections
bubble up to Angular's global handler" — that was zone.js behaviour, so the 503/dropped-connection noise
it was written to quiet still spams the console unfiltered. The converse is worse: **genuine unhandled
rejections now reach no application-level handler at all** — including H2's voice-recorder rejection —
so there is no single place that could log, report, or surface them. The unit spec passes vacuously
because it calls `handleError(...)` directly; its second case even hard-codes the dead assumption,
asserting on an `{ rejection }` envelope (trinity-error-handler.spec.ts:34-39). Errors thrown _inside_
Angular (effects, CD, template handlers) do still reach the handler — that is why this is Medium.

**Fix.** Add `provideBrowserGlobalErrorListeners()` to the providers array. Then re-check
`handleError`: the raw-`reason` path already works, so drop the `{ rejection }` unwrap at
trinity-error-handler.ts:22 and its spec case unless something else still delivers envelopes. Pin the
wiring with a test that dispatches a real `PromiseRejectionEvent` — the current direct-call specs cannot
detect this class of regression.

---

#### M2 · Encryption setup resolves the UIA user id from the live client after two awaits

**`libs/data-access/crypto/src/lib/crypto.service.ts:399`**

**What's wrong.** `setUp()` captures `crypto` up front (line 131) but builds the UIA callback lazily at
line 135 — _after_ `await assertNoRecoveryOnAccount(...)` (a homeserver round-trip, 10s-bounded) and
`await crypto.createRecoveryKeyFromPassphrase()`. `passwordUia` then re-reads `this.matrix.instance` for
the user id. On a multi-account device the active client can change during those awaits, so the
`m.id.user` identifier in the `m.login.password` auth dict names a **different account**; if the last
account signed out, the getter throws `MatrixClient not initialized` instead. **Both sibling flows do
the opposite deliberately:** `resetRecovery` captures the client once under the comment "an account
switch mid-flight must not retarget the rollback (or the UIA user id) onto a different account" (line
163), and `recover()` captures holder and client up front (254-256). Both captures are pinned by tests
(crypto.service.spec.ts:571, :1194). `setUp` has neither.

**Why it matters.** The homeserver rejects a UIA identifier that is not the requester, so setup fails
_after_ the olm machine has been touched — the stranded-cross-signing state that
`cross-signing-repair.ts` exists to clean up, reached from ordinary first-device setup rather than from
a reset. The user sees a raw auth error on the one flow that provisions their recovery key. (The
device-signing upload itself still goes through the captured `crypto`, so no key material is signed as
the wrong account — the damage is an aborted setup, not cross-account leakage.)

**Fix.** Capture the client once at the head of the async body, exactly as `resetRecovery` does, and
derive both the crypto handle and the UIA user id from it — or change `passwordUia(promptPassword)` to
`passwordUia(promptPassword, userId)` with the id captured before the first await. Add a spec mirroring
crypto.service.spec.ts:571.

---

#### M3 · Logout tears down no client projection

**`libs/feature/rooms/src/lib/rooms/rooms.page.ts:259`**

**What's wrong.** `ngOnInit` (235-247) connects seven projections — rooms, spaces, invites, crypto,
presence, spaceChildren, notifications — and `ngOnDestroy` disconnects **one**. Nothing else calls
`disconnect()` on the rest, and `AuthService.logout()` (auth.service.ts:348) goes straight to
`matrix.reset()` without notifying any projection. `teardownAll()` nulls `_activeUserId`, which fires
the reproject effect — but that calls `projection.connect()`, whose first statement is
`if (!matrix.isInitialized) { return; }` (project-from-client.ts:133-135). So it returns without
disconnecting, and `connectedClient` keeps pointing at the stopped client.

**Why it matters.** Every one of those projections has a `reset()` that exists precisely to drop the
outgoing account's data — `rooms.service.ts:372-382` says so — and on logout none of them run. After
sign-out the root-scoped services still hold the previous account's room summaries, member lists and
presence in live signals, each pinning the whole stopped `MatrixClient` (with its room/timeline/state
graph) through a closure, for as long as the app sits on `/login`. It self-heals on the next login,
which is why it has not been noticed — but the invariant "a signed-out account's data is gone" is held
nowhere. `NotificationService` additionally keeps `enabled = true`, so its effect re-attaches OS-
notification listeners to whatever account warms up next, before the user reaches the shell.

**Fix.** Do the teardown at the source. In `reproject-on-switch.ts:20-25`, handle the null case:
`matrix.activeUserId(); if (!isConnected()) return; if (!matrix.isInitialized) { disconnect(); return; } connect();`
and pass `disconnect` in from `projectFromClient`. That makes every projection reset itself on the last
logout with no per-call-site work. Then either extend `ngOnDestroy` to all seven for symmetry, or drop
the lone `invites.disconnect()` so the lifecycle is owned in one place; also reset
`NotificationService.enabled`.

---

#### M4 · Desktop CORS allowlist is published only after the client has started syncing

**`libs/data-access/matrix-client/src/lib/matrix-client.service.ts:440`**

**What's wrong.** `publishCorsOrigins()` runs in the `map()` that lands _after_ `startClient()` resolves
(line 424 → 440). `MatrixClient.startClient` awaits `getVersions()` and `doesServerSupportThread()` and
fires `syncApi.sync()` before resolving (verified in `matrix-js-sdk/lib/client.js:609-630`), so
`/_matrix/client/versions`, the thread probe and the first `/sync` are all issued while the main
process's allowlist is still empty. On a restored session there is no earlier priming: `allowCorsOrigin`
is only called from the login-time discovery path (auth.service.ts:161), which `restoreAll()` never
takes.

**Why it matters.** The entire point of `electron/src/cors.ts` is that some homeserver reverse proxies
strip `Access-Control-Allow-Origin`. Against those servers every request in that window is blocked by
Chromium as a cross-origin failure from `trinity://app`. A failed `getVersions()` is swallowed by the
SDK and **permanently disables server-side thread support for that session**; the failed initial `/sync`
costs a 5-10s keepalive backoff. Cold-start-only and server-dependent — exactly the kind that gets
misdiagnosed as a flaky homeserver.

**Fix.** Publish before the client is built: call `publishCorsOrigins()` (or a single-origin
`bridge.cors.allowOrigin(session.baseUrl)`) inside the `switchMap` at line 369, after
`createSyncStore`/before `createClient`, keeping the existing post-registration call so removals still
apply. The spec at matrix-client.service.spec.ts:843 asserts only _that_ the set is published — add an
ordering assertion.

---

#### M5 · Push registration failure is invisible and permanently un-retryable

**`libs/data-access/notifications/src/lib/push.service.ts:232`**

**What's wrong.** `attachListeners()` subscribes to `registration` and
`pushNotificationActionPerformed` only. `@capacitor/push-notifications` also emits **`registrationError`**
when FCM/APNs refuses a token; a repo-wide grep for it returns nothing. By the time it would fire,
`this.registered = true` (line 122) has already been set, so every later `register()` hits the
`if (this.registered) return;` early-exit at line 115 and never retries for the process lifetime.
`registered` is reset only in the full-teardown branch of `unregister()`. The denied-permission branch
(118-121) likewise returns without touching `_registration`, which stays `{ status: 'idle' }`.

**Why it matters.** Mobile push is the **only** delivery path on iOS/Android (`NotificationService`
returns early there). No token means no pusher and no notifications, while the settings screen built to
surface exactly this (`push-gateway-block.component.ts:58-67`) shows neither `applied` nor `error` — it
shows nothing. "Push denied" is indistinguishable from "push never attempted", and re-opening the shell
cannot recover it.

**Fix.** Add a `registrationError` listener that sets `_registration` to `{ status: 'error', message }`
and resets `this.registered = false` so the next `register()` re-attempts; do the same for the denied-
permission branch. Consider clearing `registered` in a `finally` if `PushNotifications.register()`
itself rejects.

---

#### M6 · The applied-app-id ledger is never written when the gateway comes from build config

**`libs/data-access/notifications/src/lib/push-gateway.service.ts:145`**

**What's wrong.** `markApplied()` returns without recording anything when `_override()` is null — i.e.
whenever the effective gateway comes from the build-time `PUSH_CONFIG` fallback rather than a user
override. `appliedAppId()` therefore stays null forever on that path, so `setPushers` computes
`stale = null` and `liveAppIds()` returns only the current id.

**Why it matters.** The ledger exists because a pusher's identity is `(user_id, app_id, pushkey)`, so
changing the app id creates a _second_ pusher and leaves the first delivering indefinitely — documented
at `docs/reference/push-notifications.md:205-218` and verified there against Synapse. The reachable
failure: a build ships `appId: 'a'`, pushers register under `a.ios`; the user then sets their own
gateway with app id `b`; no stale removal happens, and the `a.ios` pusher **keeps forwarding
`room_id`/`event_id`/unread-count metadata to the previous gateway operator forever**. `unregister()`
cannot clean it up either, since it reads the same empty ledger.

**Fix.** Make the ledger independent of whether an override exists: when `_override()` is null, have
`markApplied` materialise a `StoredGateway` from `effective()` (leaving `appId` undefined so
`effective()` still resolves to the fallback), or hold `appliedAppId` in its own Preferences key. Update
push-gateway.service.spec.ts:182, which currently pins the behaviour as "does nothing".

---

#### M7 · No CI gate type-checks any unit spec — 33 real type errors already sit undetected

**`eslint.config.mjs:217`**

**What's wrong.** Test code is excluded from every static-analysis path: each project's `tsconfig.json`
excludes `src/**/*.spec.ts` (all 20 libs plus `apps/trinity`), `tsconfig.app.json` does the same, the
only type-aware ESLint block explicitly ignores `**/*.spec.ts`, and `electron/tsconfig.json:20` excludes
its specs. A `tsconfig.spec.json` exists per project but nothing runs `tsc` against it — no `typecheck`
target anywhere, and Vitest goes through `@analogjs/vite-plugin-angular`, which transpiles without type
checking. **Running the compiler against the spec projects during this audit produced 33 errors across
five of ~20 projects** (`data-access/rooms` 4, `notifications` 9, `timeline` 2, `util/matrix` 18).

**Why it matters.** The errors are exactly the over-mocked-SDK smell: `rooms.service.spec.ts(157,42)`
reports the hand-rolled fake client is "missing 358 more properties from type `MatrixClient`" — so the
compiler cannot warn when `RoomsService` starts calling an SDK method the fake never grew, and the spec
silently exercises a fiction. `keyword-rules.service.spec.ts(228,47)` reports
`Tuple type '[]' of length '0' has no element at index '3'` — the mock's declared contract and the code
under test have already drifted with nothing to say so. Unbounded, and growing with every new test.

**Fix.** Add a `typecheck` target per project (`nx:run-commands` running
`tsc -p tsconfig.spec.json --noEmit`, cached) and a `pnpm exec nx run-many -t typecheck` step in CI's
`test` job. Fix the 33 first — for the `MatrixClient` cases give the fake an explicit
`Partial<MatrixClient>` and cast at the `ngMocks.stubMember` call site so the cast is visible.

---

#### M8 · Renovate ignores `android/**` and `ios/**`

**`.github/renovate.json:24`**

**What's wrong.** `ignorePaths` excludes both native trees. That removes the whole Android native build
from automation: `android/build.gradle:10` pins `com.android.tools.build:gradle:8.13.0` and
`com.google.gms:google-services:4.4.4`, and `android/variables.gradle` pins eleven androidx/Cordova
versions. The Gradle wrapper and the iOS SPM graph are in the same position (both trees are tracked —
53 and 19 files). `ignorePaths` is evaluated _before_ package rules, so the `vulnerabilityAlerts` block
— the one category deliberately exempted from the dashboard gate — cannot reach these files either.
Unlike almost every other key in this heavily-annotated config, these two entries carry no `description`
justifying them, and they are the only source entries in a list that is otherwise pure build output.

**Why it matters.** Two of four shipped platforms have a dependency surface nothing watches.
`androidx.webkit` backs the WebView rendering an E2EE client; an advisory against it, or against AGP,
produces no branch, no PR, no dashboard row. Everywhere else the supply-chain posture is meticulous
(SHA-pinned actions, App-token minting, a rationale per rule) — this is the one hole, and it is silent
by construction.

**Fix.** Narrow the ignore to the generated payload only (`android/app/src/main/assets/**`,
`ios/App/App/public/**`) and let the `gradle`, `gradle-wrapper` and `swift`/`cocoapods` managers see the
rest. Group them (`matchManagers: ["gradle", "gradle-wrapper"]`) so the Capacitor-pinned androidx
versions move as one branch, keeping `dependencyDashboardApproval: true` since these need a device build.

---

#### M9 · Android `allowBackup="true"` exposes the Rust crypto store to device backup

**`android/app/src/main/AndroidManifest.xml:5`**

**What's wrong.** The manifest keeps Capacitor's generated `android:allowBackup="true"` and declares
neither `android:fullBackupContent` nor `android:dataExtractionRules` (verified across the whole 71-line
file). Android Auto Backup therefore uploads the app data directory — including the WebView's
`app_webview/` IndexedDB — to Google Drive. That is where both the per-account sync store and the Rust
crypto store live, and `initRustCrypto({ cryptoDatabasePrefix })` (matrix-client.service.ts:413) is
called **with no store passphrase**, so the crypto database is not encrypted at rest.

**Why it matters.** This is an E2EE client: the crypto store holds the device's Olm identity and every
inbound megolm session. Anyone who can read a backup can decrypt the user's entire cached history
offline — _without_ the access token, which the app correctly keeps in the Keystore. The Keystore
protection is undermined by leaving the key material that actually decrypts messages in the freely
backed-up data dir. Element Android sets `allowBackup="false"` for this reason. Nothing in `docs/`
mentions backup, so this is an unreviewed generator default. (Two mitigations temper it: `adb backup`
excludes app data on Android 12+ for non-debuggable apps, and cloud Auto Backup is E2E-encrypted with
the screen-lock secret since Android 9. The residual risk — restore onto a new device from a compromised
Google account — still justifies the change.)

**Fix.** Set `android:allowBackup="false"` on `<application>`; if backup is wanted later, add
`dataExtractionRules` + `fullBackupContent` excluding `app_webview/` and the Preferences file. Record it
in `docs/platforms/mobile.md` so a `cap sync` manifest regeneration does not silently reintroduce it.

---

#### M10 · A running tab never picks up a deployed update

**`libs/feature/shell/src/lib/app.component.ts:33`**

**What's wrong.** `ngOnInit` subscribes to exactly one `SwUpdate` stream — `unrecoverable`. Nothing
subscribes to `versionUpdates` or handles `VersionReadyEvent`; the only two `SwUpdate` references in the
entire repo are the import and the inject in this file. The Angular service worker is version-locked per
client: once a tab is running, `ngsw-worker.js` keeps serving the version it booted with. With no
`versionReady` handler there is no prompt, no `activateUpdate()`, no reload.

**Why it matters.** Trinity is a chat client — tabs stay open for days or weeks. A shipped fix to the
crypto or session code can sit undelivered for that entire window, on precisely the clients that use the
app most. This is live for every production web/PWA user (`main.ts:171-175`).
`docs/platforms/web.md:130` restates the current behaviour without declaring it a decision.

**Fix.** In the same `if (this.swUpdate.isEnabled)` block, subscribe to
`versionUpdates.pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))` and surface a
toast (`HlmToaster` is already mounted here) offering reload via
`activateUpdate().then(() => location.reload())`. Add a periodic `checkForUpdate()` on an interval or on
`visibilitychange` so a long-lived tab notices a deploy without a navigation.

---

#### M11 · Bundle budgets cover only the initial bundle; a 3.48 MB lazy chunk ships unguarded

**`apps/trinity/project.json:54`**

**What's wrong.** The production config declares two budgets, `initial` and `anyComponentStyle`. There
is no `bundle`, `allScript` or `any` budget, so **every lazy chunk is unmeasured**. In the local `www/`
build the initial payload is ~1.07 MB (well inside the 2 MB warning) while `chunk-BPViOcHh.js` is
**3,480,471 bytes** — it carries `@ctrl/ngx-emoji-mart` and Shiki, pulled in statically by
`message-composer.component.ts:41` and `rooms.page.ts:6`. Separately, `main.ts:83` uses
`withPreloading(PreloadAllModules)`, which fetches every lazy chunk once the first navigation settles —
so that 3.48 MB downloads on the `/login` screen too — and the SW's `app` asset group globs `/*.js`,
prefetching all 27 chunks (~5.9 MB) on install and on every deploy.

**Why it matters.** The `initial` budget is the only thing between a dependency bump and a regression,
and it is blind to ~75% of the shipped JavaScript. Combined with `PreloadAllModules` the lazy split buys
nothing on first load for a mobile PWA — the user pays ~5.9 MB before signing in — and nothing would
flag it if the emoji dataset or Shiki language set doubled.

**Fix.** ~~Add `{ "type": "bundle", "name": "*", … }`~~ — **corrected during implementation: that budget
shape is inert.** `@angular/build`'s `BundleCalculator` matches a `bundle` budget by literal chunk name
(`bundle-calculator.js:146` — `chunks.filter(c => c?.names?.includes(budgetName))`), with no glob
support, so `"*"` matches nothing and the budget never evaluates. Use `anyScript` (per-file gate) and
`allScript` (total gate) instead — those are the calculators that actually cover lazy chunks.

~~Then either drop `PreloadAllModules`, or move the emoji picker and Shiki behind `@defer`/dynamic
`import()`.~~ **Also corrected during implementation — the `@defer` half was measured and refuted.**
An esbuild metafile of the real production build attributes the 3.48 MB chunk as **78.6 %
`@shikijs/langs` (2,741,259 B)** and only 13.7 % emoji-mart, so the picker was never the bulk. A probe
build wrapping `<emoji-mart>` in `@defer (on immediate)` moved the route chunk **+437 B** and the
_initial_ bundle **+6,634 B** (the app's first `@defer` pulls in the deferred-block runtime) — a net
regression, reverted. The emoji weight is anchored by the eager `inject(EmojiSearch)` /
`inject(EmojiService)` feeding the composer's shortcode matching, not by the template, and making
those lazy would turn `:shortcode:` conversion async: a behaviour change, not a move. Shiki resists a
dynamic import for the reason `code-highlight.ts` already documents — a late install leaves
already-projected messages unhighlighted, because `TimelineService.viewCache` keys on
`eventRevision()` (Matrix inputs only) and is cleared solely by `close()`, while
`setCodeHighlighter`'s own clear reaches one layer below it; fixing that needs a generation counter in
**both** caches. **The lever that would actually work is dropping `PreloadAllModules`** — which is a
behaviour change (every first room/settings navigation pays the fetch), so it wants deciding on its
merits rather than smuggling in under a bundle-size finding.

Related, found while measuring and left alone: the "Cost, stated plainly" comment in
`libs/util/matrix/src/lib/code-highlight.ts` puts the grammars at "roughly 813 KB raw / 134 kB
gzipped". The measured contribution is 2,741,259 B of _minified output_ — 3.4× the stated figure. That
comment is what a reader consults when deciding whether the static import is affordable, so the
understatement is worth correcting.

---

#### M12 · `TimelineService` is two services in one 1365-line file

**`libs/data-access/timeline/src/lib/timeline.service.ts:712`**

**What's wrong.** 1365 lines against this repo's own threshold for services —
`.claude/rules/code-quality.md:19` puts services at "Aim 200-400, Refactor at 500+". More importantly it
fails the single-responsibility test in the same file (line 10): it owns (a) the live timeline
projection — `open`/`close`, ten listeners, the per-event view cache, shields, read markers and
receipts, typing, scrollback, `jumpToDate` — and (b) an unrelated write surface: `send`, `sendLocation`,
`sendVoiceMessage`, `forwardMessage`, `createPoll`, `votePoll`, `endPoll`, `sendMedia`, `edit`, `retry`,
`reply`, `redact`, `toggleReaction` (712-997).

**Why it matters.** These are the two seams the repo's own rule names. The cost is already visible: each
of the ~13 action methods re-derives the same `this.context()` tuple the projection half owns; the
mutable state (`roomId`, `room`, `connectedClient`, `viewCache`, `shields`, `lastReadEventId`) is shared
across both halves with no boundary; and the spec must construct the full projection to test a send. It
is the largest data-access file, which makes the listener-lifecycle logic — the part that must not
regress — hard to review in isolation.

**Fix.** Split along the seam that already exists: keep `TimelineService` as the projection, extract a
`TimelineActionsService` in the same lib for the 13 action methods. Give the projection a small public
accessor for the open-room context (roomId + the client `open()` bound to) so the actions service never
reads `matrix.instance` itself — which also closes the account-switch window the `close()` comment warns
about. Mechanical; the existing specs split along the same line.

---

#### M13 · `MessageComposerComponent` is 1267 lines — ~4× the repo's own threshold

**`libs/feature/rooms/src/lib/message-composer/message-composer.component.ts:176`**

**What's wrong.** `.claude/rules/code-quality.md:17` sets a component `.ts` at "Aim 150-250, Refactor at
300-400". This is 1267 lines with 45 methods, having absorbed: emoji shortcode autocomplete, @-mention
autocomplete, markdown formatting + keyboard-shortcut dispatch, draft persistence, voice recording, GIF
picking, media picking, poll creation and location sharing. It _does_ delegate to services for several
of those, but still carries two complete in-file autocomplete engines (`syncMentionAutocomplete`,
`acceptMention`, `moveMentionSelection`, `syncEmojiAutocomplete`, `acceptEmoji`, `moveEmojiSelection`).

**Why it matters.** Its template is 372 lines, also past the 250-300 threshold, so the smell the rule
calls out first ("large Angular templates are usually the bigger smell") applies too. This is the
highest-traffic interactive surface in the app and the one the Playwright harnesses drive hardest; every
unrelated change touches the same file, and the two autocomplete state machines share one caret model
with no boundary.

**Fix.** Extract the two autocomplete state machines first — they are self-contained and regex-driven.
Then move the attachment workflows (voice, GIF, media, poll, location) behind one
`ComposerAttachmentsService` that already has those collaborators injected, leaving the component with
the textarea, drafts and submit. Extract the suggestion menus and the attachment/preview strip into
child components.

---

### LOW (15)

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Location                                                              | Fix                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Composer drafts — plaintext destined for E2EE rooms — are never cleared on sign-out**, only by the factory reset. The last-account branch deliberately drops the crypto store, blob caches and token registry, but `trinity.composer.drafts` is not among them, and `DraftStoreService` has no bulk clear at all. On web/Electron that is `localStorage`.                                                                                                                                                                                                                    | `libs/data-access/auth/src/lib/auth.service.ts:349`                   | Add `DraftStoreService.clearAll()` (cancel timer, empty map, `Preferences.remove`) and call it from **both** logout branches.                                                                                                                                                                                  |
| L2  | **`removeInternal` skips the documented store wipe when no live client exists.** `remove()` is documented as "stop it + wipe its stores" but returns early at the `if (!account)` guard — the normal state for a soft-logged-out account or a failed background warm-up. `AuthService.logout` then deletes the registry record that carries the `cryptoPrefix`, so the crypto store outlives the only thing naming it.                                                                                                                                                         | `libs/data-access/matrix-client/src/lib/matrix-client.service.ts:479` | When `wipe` is true but no client exists, delete the databases by name from the record's `cryptoPrefix` (reuse `LocalDataWipeService.wipeIndexedDb`), or narrow the JSDoc and make `logout` refuse a non-live target. Reachability from today's UI is narrow; the contract violation is what makes it fragile. |
| L3  | **`SecureStorageService` memoizes a _rejected_ backend promise forever.** `resolve()` caches `this.select()` with `??=`; a rejection is a value, so every later `get`/`set`/`remove` rejects for the page lifetime. `select()` awaits an `ipcRenderer.invoke`, and `createWindow()` (which calls `loadURL`) runs at `electron/src/main.ts:104` while `registerSecureStoreIpc()` runs three statements later at 107. The repo's two other memoized promises both reset on error.                                                                                                | `libs/platform-native/src/lib/secure-storage.service.ts:160`          | `this.backend ??= this.select().catch(err => { this.backend = undefined; throw err; })`. Better: make `select()` non-throwing so it falls through to the documented web fallback.                                                                                                                              |
| L4  | **`UnreadAggregatorService.reconcile()` keys listeners by user id only**, never comparing the held client to `matrix.clientFor(userId)`. Its four sibling per-account services all guard this and say why in a comment. This one drives the app-icon/dock badge, so the failure is a badge frozen at the pre-re-auth count. (Trigger window is narrow — `removeInternal` writes `_accountIds` synchronously and re-registration lands many macrotasks later.)                                                                                                                  | `libs/data-access/rooms/src/lib/unread-aggregator.service.ts:70`      | Copy the guard shape verbatim from `mixed-spaces.service.ts:83-99`.                                                                                                                                                                                                                                            |
| L5  | **`NotificationService.reconcile()` has the same missing identity check** — a re-authenticated account silently stops producing OS notifications, and its `forgetAccount()` cleanup never runs.                                                                                                                                                                                                                                                                                                                                                                                | `libs/data-access/notifications/src/lib/notification.service.ts:172`  | Same guard; compare `held.client === client` before the skip, else detach and rebuild.                                                                                                                                                                                                                         |
| L6  | **No wildcard route.** The table ends with the empty-path redirect and defines no `{ path: '**' }`. `ngsw-config.json` sets no `navigationUrls` override, so the SW serves `index.html` for every same-origin navigation — a stale bookmark or old share link boots the shell and shows a permanently blank page. No `withNavigationErrorHandler` either.                                                                                                                                                                                                                      | `apps/trinity/src/app/app.routes.ts:79`                               | `{ path: '**', redirectTo: 'rooms' }` — `authGuard` already redirects a signed-out user to `/login`, so one line covers both states.                                                                                                                                                                           |
| L7  | **`AppComponent` subscribes to `swUpdate.unrecoverable` without `takeUntilDestroyed`** — the only one of 124 subscribe sites in the app not tied to a lifetime. Production impact is nil (it is the bootstrap root), but it is the pattern a contributor copies into a component that _is_ destroyed repeatedly.                                                                                                                                                                                                                                                               | `libs/feature/shell/src/lib/app.component.ts:34`                      | Pipe `takeUntilDestroyed(this.destroyRef)` — the call is in `ngOnInit`, so the explicit `destroyRef` argument is required.                                                                                                                                                                                     |
| L8  | **`requestAnimationFrame` scheduled from an effect on the timeline hot path is never cancelled.** The effect depends on `messages()`, so a burst of sync ticks between two frames queues one `updateJumpToUnread()` per tick — each doing forced layout reads (`scrollTop`/`clientHeight`/`offsetTop`) on the hottest surface in the app to compute an identical result.                                                                                                                                                                                                       | `libs/feature/rooms/src/lib/message-list/message-list-base.ts:288`    | Take the `onCleanup` argument and `cancelAnimationFrame(handle)` — matching `avatar.component.ts:253` and `link-preview.component.ts:84`, which already do this.                                                                                                                                               |
| L9  | **The `e2e/` tree is exempt from ESLint and covered by no tsconfig.** `globalIgnores` lists `'e2e'`, and `find e2e -name 'tsconfig*'` returns nothing, so 87 Playwright specs plus the Synapse harness get zero compile- or lint-time protection. The classic vacuous-Playwright failure — a dropped `await` on a locator assertion — is caught by `no-floating-promises`, which is off here. The suite is disciplined _today_ (a compile found it clean apart from three `TS7016` at the `start.mjs` seam), but nothing keeps it that way.                                    | `eslint.config.mjs:33`                                                | Add `e2e/tsconfig.json` + a `typecheck` target, declare `start.mjs`'s return shape, remove `'e2e'` from `globalIgnores`, and add a scoped block enabling `no-floating-promises` and `playwright/no-focused-test`.                                                                                              |
| L10 | **`apps/trinity` has zero unit specs and `passWithNoTests: true`**, so `nx test trinity` is a green run over an empty file set. The composition root — 15 `provideAppInitializer` calls, `PUSH_CONFIG`, the encryption-dialog loaders, and the service-worker enable predicate — is covered only by Playwright.                                                                                                                                                                                                                                                                | `apps/trinity/vite.config.ts:6`                                       | Extract the `isElectron` expression into a testable helper in `@trinity/platform-native`, add `app.routes.spec.ts` pinning the guard wiring, and assert `navigator.serviceWorker.getRegistrations()` is empty in `e2e/electron/app.electron.spec.mts`.                                                         |
| L11 | **README advertises a PWA the build cannot install.** No web app manifest exists anywhere; `index.html` has a favicon and `mobile-web-app-capable` but no `<link rel="manifest">` and no apple-touch-icon — while the install icon set (192/512/apple-touch) ships and is prefetched by the SW. `docs/users/install.md:36` states the gap plainly, contradicting `README.md:6` and CLAUDE.md.                                                                                                                                                                                  | `README.md:6`                                                         | Either add `manifest.webmanifest` (+ link it, + add to the `app` asset group), or drop "(PWA)" from the README and CLAUDE.md.                                                                                                                                                                                  |
| L12 | **The Renovate job has no health signal.** Its only success criterion is the action's exit code, and Renovate exits 0 on per-repository aborts (`repository-changed`, config-resolution failures) — so a run that processed nothing is indistinguishable from one that found nothing to do. No log inspection, no dashboard-issue assertion, even though `dependencyDashboardApproval: true` makes that issue the gate every non-patch update passes through.                                                                                                                  | `.github/workflows/renovate.yml:78`                                   | Tee output and fail on abort markers, or add a step asserting the dashboard issue exists and was updated within the last two scheduled runs.                                                                                                                                                                   |
| L13 | **CI pins Node to a hardcoded major**, ignoring `.nvmrc` (`24.18.1`) while `package.json:53` declares `^24.15.0 \|\| >=26.0.0`. `setup-node` resolves whatever latest 24.x the runner image has — which can drift below the `^24.15.0` floor unnoticed — and the `>=26` half of the supported range is never built or tested.                                                                                                                                                                                                                                                  | `.github/actions/setup/action.yml:24`                                 | `node-version-file: .nvmrc`, and either drop `\|\| >=26.0.0` from `engines` or add a Node 26 matrix leg.                                                                                                                                                                                                       |
| L14 | **Packaged binary skips the asar-integrity fuses.** `afterPack` flips `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` off but not `OnlyLoadAppFromAsar` or `EnableEmbeddedAsarIntegrityValidation`, though `electron-builder.yml:19` sets `asar: true`. Without the former, a local process that can write to the install dir can drop an unpacked `app/` next to `app.asar` and reach exactly the keychain capability the other three fuses deny — and Windows/Linux ship unsigned (`electron-builder.yml:111` is a `TODO(signing)`). | `electron/afterPack.cjs:38`                                           | Add both fuses (integrity validation is macOS/Windows-only and needs electron-builder to emit the header). Extend `afterPack.spec.ts` to assert the option set.                                                                                                                                                |
| L15 | **`cors.ts`'s header comment describes the opposite of what the code does.** It calls the shim "scoped to _remote_ origins, NOT to the homeserver", asserts the renderer "can read cross-origin response bodies from any https origin", and closes with "deliberately not attempted as a drive-by" — but that work has since landed in the same file (`allowedOrigins`, `setAllowedCorsOrigins`, `allowCorsOrigin`, and the `isAllowed` gate at line 153).                                                                                                                     | `electron/src/cors.ts:21`                                             | Rewrite the block: state the shim is scoped to the renderer-declared allowlist, keep the accurate residual note, delete the "not attempted" sentence. A stale threat model is worse than none.                                                                                                                 |

---

## 3. Quick wins (under 30 minutes each)

Ordered by value. The first four are five-minute edits with disproportionate payoff.

| #   | Change                                                                                               | File                                              | Why now                                             |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| 1   | Add `NSMicrophoneUsageDescription` (and `NSLocationWhenInUseUsageDescription`)                       | `ios/App/App/Info.plist`                          | Stops an App Store build from crash-on-tap (H4)     |
| 2   | Add `provideBrowserGlobalErrorListeners()`                                                           | `apps/trinity/src/main.ts`                        | Makes every other async failure visible (M1)        |
| 3   | Set `android:allowBackup="false"`                                                                    | `android/app/src/main/AndroidManifest.xml`        | Keeps the crypto store out of cloud backup (M9)     |
| 4   | Add `{ path: '**', redirectTo: 'rooms' }`                                                            | `apps/trinity/src/app/app.routes.ts`              | Removes the blank-page dead end (L6)                |
| 5   | `if (recorder.state === 'inactive') { this.teardown(); return null; }` + `teardown()` in a `finally` | `voice-recorder.service.ts:113`                   | Removes the permanent voice wedge (H2)              |
| 6   | Clear the memo on rejection in `resolve()`                                                           | `secure-storage.service.ts:160`                   | Removes a latched, unrecoverable session layer (L3) |
| 7   | Add a `bundle` budget                                                                                | `apps/trinity/project.json:54`                    | Puts 75% of shipped JS under a gate (M11)           |
| 8   | `node-version-file: .nvmrc`                                                                          | `.github/actions/setup/action.yml:24`             | One authoritative Node version (L13)                |
| 9   | `takeUntilDestroyed` + `onCleanup`/`cancelAnimationFrame`                                            | `app.component.ts:34`, `message-list-base.ts:288` | Restores convention consistency (L7, L8)            |
| 10  | Add the two asar fuses                                                                               | `electron/afterPack.cjs:38`                       | Completes an already-stated threat model (L14)      |
| 11  | Rewrite the stale `cors.ts` header                                                                   | `electron/src/cors.ts:21`                         | The most misleading comment in the repo (L15)       |
| 12  | Capture the client at the head of `setUp()`                                                          | `crypto.service.ts:131`                           | Matches both siblings; ~20 min with the spec (M2)   |
| 13  | Narrow Renovate's `ignorePaths` to build output                                                      | `.github/renovate.json:24`                        | Restores security advisories for two platforms (M8) |

---

## 4. Refactoring roadmap

**Stage 1 — Correctness at the edges (days).** The quick wins above, plus the two defects that need a
consumer written rather than a line changed: **H3** (wire `queryParamMap` into the rooms shell so a
notification tap actually opens its room — replace the mocked-Router assertions with a test that drives
the real param) and **M5** (a `registrationError` listener plus a resettable `registered` flag). Both
are small; both restore a feature users believe already works.

**Stage 2 — Lifecycle correctness (1-2 weeks).** These share a root cause and should be done together
so the pattern lands once. **H1** — make `start()` idempotent per user id with a `finalize`, which is
the highest-value structural fix in this audit because it protects crypto-store integrity. **M3** — move
projection teardown into `reproject-on-switch.ts` so logout resets every projection at the source
instead of in one page's `ngOnDestroy`. **L4/L5** — apply the sibling identity guard to the two
services that lack it. **M4** — publish the CORS allowlist before `createClient`. **M2** if not already
taken as a quick win.

**Stage 3 — Close the verification gaps (1-2 weeks).** **M7** — add per-project `typecheck` targets and
fix the 33 existing spec type errors; this is the change that stops the over-mocked-SDK drift from
growing, and it makes every later refactor safer. **L9** — bring `e2e/` under a tsconfig and ESLint.
**L10** — make the composition root testable. Do this stage _before_ Stage 4, so the large moves land
against a suite that can actually detect breakage.

**Stage 4 — Structural splits (2-4 weeks, low risk, high churn).** **M12** — split `TimelineService`
into projection + actions along the seam already visible in the file. **M13** — extract the composer's
two autocomplete engines, then its attachment workflows. Both are mechanical, both are large diffs, and
both are much safer once Stage 3 exists.

**Ongoing.** **M8** (native dependency automation), **M10** (SW update prompt), **M11**
(`PreloadAllModules` + lazy Shiki/emoji), **L12** (Renovate health signal), **L11** (manifest or README).

---

## 5. What's done well

This section is not filler — several of these are things most Matrix clients get wrong.

**Crypto and session.** The recovery reset deliberately does **not** call `CryptoApi.resetEncryption`,
because that method destroys the key backup and secret storage _before_ the UIA the password prompt
lives inside; it authenticates first against a harmless request (`deleteMultipleDevices([])`) so a
cancelled prompt costs nothing — measured against a specific Synapse version rather than asserted
(`recovery-reset.ts:88-115`). The 4S pointer rollback avoids a trap most clients miss: `getDefaultKeyId`
answers from the _local_ store after initial sync, so reading it back would "confirm" a server state
that is wrong on exactly the failure the rollback exists for — hence `setAccountDataRaw` as the
unconditional writer (`recovery-reset.ts:318-370`). Crypto stores are scoped by user **and device** id,
so a fresh login cannot reopen a store an earlier device left behind. Each account gets its own
`SecretStorageKeyHolder` wired only into that client's callbacks, zeroing buffers on replace. The megolm
key-file importer caps the attacker-controlled PBKDF2 iteration count _before_ HMAC verification,
closing a main-thread DoS an uncapped uint32 would open.

**Architecture.** The "components never import matrix-js-sdk" rule is genuinely enforced — including the
dynamic-import form via an `ImportExpression` selector, which matters because every route here is lazy —
and a repo-wide grep confirms **zero violations**. The project graph is acyclic across 41 projects with
no feature→feature edge and no `scope:shared`→`scope:matrix` edge: the layering in CLAUDE.md is the
layering the graph actually has. `projectFromClient` keys listeners to the client _instance_ rather than
a boolean, so a logout→login onto a fresh client rewires instead of freezing — and `disconnect()`
cancels the coalescer before resetting so a queued rebuild cannot repopulate from the outgoing client a
microtask late. Eighteen services share it. A listener audit across 26 files found attach/detach
symmetric everywhere, always against the client they attached to, and **no listener bound to a
`RoomState`** anywhere — the documented rule holds in practice.

**Code quality.** Zero `any` in 316 non-spec files — for a codebase wrapping matrix-js-sdk, that is
rare. Strictness is set once at the root and not weakened by a single one of 45 per-project tsconfigs.
SDK data is narrowed to `Record<string, unknown>` and validated rather than asserted. Every component
outside generated `libs/spartan` is `OnPush`, no exceptions. `saveFields` anticipates two traps at once
(per-write `catchError` so one rejection cannot cancel siblings; an empty-list special case because
`forkJoin([])` completes without emitting and would strand the `saving` flag) and writes both down at
the site. Deliberate swallows are labelled with their reason, so they read as decisions.

**Platform.** The Electron boundary is hardened in substance: contextIsolation + sandbox +
`nodeIntegration:false`, an explicit permission policy denying camera, `will-navigate` /
`setWindowOpenHandler` / `will-attach-webview` all locked to the app origin and re-applied to future
web-contents. **Every** IPC channel verifies `event.sender === getMainWindow().webContents` — with a
comment recording that the invariant is only valuable if it holds everywhere. `secureStorageUsable`
refuses Linux's `basic_text` safeStorage backend rather than storing a token under a false promise of
encryption — a subtlety `isEncryptionAvailable()` hides.

**Tests and CI.** A scan of all 221 unit specs plus 97 e2e specs found **zero assertion-free tests**,
zero non-awaited Playwright matchers, and no snapshot assertions. The documented vacuous-negative trap
(coalesced runs make `not.toHaveBeenCalled` pass trivially) is documented _at the primitive itself_
(`coalesce.ts:26-29`), and no instance of it survives in any of the 18 consumers' specs. All four
priority areas have real coverage — `matrix-client.service.spec.ts` (885 lines), `push.service.spec.ts`
(660, with a stateful pusher store rather than fixed returns), `auth.service.spec.ts` (867),
`crypto.service.spec.ts` (1000+, mocking only PBKDF2). `global-setup.mts:32-38` disables the
"Docker missing, skip" fallback whenever `CI` is set, so a runner that cannot reach Docker fails loudly
instead of reporting a green E2E job that tested nothing. `release.yml` refuses to package a tag whose
commit is not an ancestor of `develop`/`master`, or whose version disagrees with either manifest. CI has
no `continue-on-error` and no `|| true` on a gate; the one downgraded failure is an explicit
`::warning::` with a stated reason. Every third-party action is SHA-pinned with the rationale
(CVE-2025-30066) written down.

---

## 6. Method, limits, and what was _not_ checked

**Method.** Five domain auditors read the code in parallel; each finding was then re-verified by an
independent agent that opened the cited file, confirmed the quoted evidence appears at that line, and
searched for the disproof (a guard elsewhere, a `takeUntilDestroyed`, an existing test, a documented
divergence). 32 raw findings, 0 refuted, 6 adjusted for line or severity. The four High findings and
both severity adjustments were then independently re-checked before this report was written.

**Limits — read these before acting.**

- **Nothing was executed against a running app.** No build, no Playwright run, no device. H4 and M9 rest
  on platform contracts plus the cited code paths; M4 is derived from reading matrix-js-sdk's
  `startClient` ordering, not from observing a stripped-CORS homeserver; H1 is argued from the Router's
  documented cancel-and-unsubscribe semantics plus the absence of `finalize`/in-flight state.
- **The one thing that _was_ executed** (read-only, no repo writes): `tsc --noEmit` against six
  `tsconfig.spec.json` files and an out-of-tree tsconfig over `e2e/` — this produced M7's 33-error count
  and L9's clean-but-ungated result — plus `nx test scripts` (green, 70 tests) and `nx show projects`.
- **No "majors behind" finding is reported**, deliberately. There was no network access to compare
  `matrix-js-sdk@^42.1.0`, `electron@43.2.0`, Capacitor 8.5.0 or Angular 22.1.x against registry latest,
  and guessing would be worse than silence. Alignment that _could_ be checked locally is correct:
  TypeScript is textually identical (6.0.3) in both manifests as the Renovate rule intends, `@types/node`
  matches, and the Angular framework/CLI split (22.1.0 vs 22.1.2) is the legitimate one. **Note that
  M8 and L12 mean the dependency-freshness picture cannot be taken on trust** — two platforms are
  unwatched and the bot's liveness is unverifiable from the repo.
- **Bundle figures** come from the local `www/` output (gitignored build artefact), which may lag the
  tree by a commit or two. M11 rests on the ratio, not the exact byte count.
- **Not audited:** the 87 Playwright specs' individual logic (only their shape and discipline), the
  Android/iOS native projects beyond manifest and plist, and `libs/spartan/*` (generated, exempt by
  repo convention).
