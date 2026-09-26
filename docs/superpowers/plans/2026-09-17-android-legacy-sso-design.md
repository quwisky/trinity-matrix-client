# Android Legacy SSO Migration Design

**Issue:** #723
**Integration branch:** `test/676-android-sidebar-filter`

## Purpose

Replace the Android-applicable coverage of all three canonical legacy
Synapse/Dex SSO journeys with deterministic installed-Android Maestro/Node
stages. Preserve the real provider and single-use Matrix login-token protocol,
retain all Playwright predecessors unchanged, and publish auditable proof of
native action ownership, callback-state security, session persistence, layout,
and secret safety.

This migration does not change product behavior. It adds an immutable parity
contract, a native journey suite, Nx/registry/CI wiring, and an evidence ledger.

## Canonical ownership

The contract pins these complete sources and owned spans:

- `e2e/browser/journeys/accounts/sso-login.spec.mts`, SHA-256
  `04bf21437efd4da47398e93df607bf35dbcd8aba00159607a9a95f96ca6e9b12`:
  lines 29–76, 78–107, and 109–198 own the three journeys.
- `e2e/browser/support/sso.mts`, SHA-256
  `e669c3b588e788c37fab77a7e427a38286de46cffafb228fcf27ae32c70a99b3`:
  its Dex form, isolated token-capture, and token-redemption helpers own the
  adversarial fixture protocol.
- `e2e/support/app.mts`, SHA-256
  `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`:
  its Synapse session and login/readiness helpers own the application-side
  setup inherited by the predecessor.
- `e2e/support/synapse/dex.yaml`, SHA-256
  `b994b7e7c7de5fc103079b82d379a3dd8d022a1468796d6f8f35628c55c585d5`:
  the pinned local provider, client, and two static identities remain real and
  unchanged.

The predecessor contains exactly 4 + 4 + 15 direct assertion sites. The
Android contract records them as 23 unique stage-local identities.

### Provider sign-in and persistence

1. `legacy-sso.password-action-visible`
2. `legacy-sso.sso-action-visible`
3. `legacy-sso.delegated-action-absent`
4. `legacy-sso.persisted-rooms-visible`

### Unverifiable callback and unspent token

1. `legacy-sso.verification-error-visible`
2. `legacy-sso.back-to-sign-in-visible`
3. `legacy-sso.unverified-rooms-route-absent`
4. `legacy-sso.unspent-token-exact-mxid`

### Forged callback during an in-flight sign-in

1. `legacy-sso.completing-copy-visible`
2. `legacy-sso.wordmark-visible`
3. `legacy-sso.wordmark-text`
4. `legacy-sso.heading-count`
5. `legacy-sso.completing-heading-count`
6. `legacy-sso.card-bounds-present`
7. `legacy-sso.card-min-width`
8. `legacy-sso.card-max-width`
9. `legacy-sso.card-nonnegative-x`
10. `legacy-sso.card-within-viewport`
11. `legacy-sso.main-count`
12. `legacy-sso.body-bounds-present`
13. `legacy-sso.body-inset`
14. `legacy-sso.inflight-verification-error-absent`
15. `legacy-sso.inflight-rooms-route-absent`

The helper-owned Rooms readiness before and after relaunch and after the final
in-flight recovery remains a required stage outcome. It is recorded in stage
proof without inventing extra direct-assertion identities.

## Architecture

### Source contract and guard

`e2e/android/legacy-sso-contract.mts` exports the pinned sources, three owned
spans, and the 23 identities. A focused source-shape test verifies every hash,
span boundary, assertion count, provider identity, route/layout/security
obligation, and predecessor retention before the journey exists.

The guard rejects DOM click, focus, fill, submit, synthetic pointer events, and
location/history navigation for Trinity or Dex. It also rejects Android
Playwright-driver reuse, mocked Synapse/provider responses, injected-callback
substitution for a legitimate provider round trip, token redemption by the app
in the adversarial stage, missing host relaunch/deep-link proof, literal secret
publication, and unbounded cleanup.

### Installed-app client and native inputs

`e2e/android/legacy-sso-journeys.mts` contains one Node test with three ordered
stages. It reuses `AccountWorkspaceClient` only for its established installed
WebView lifecycle, read-only CDP observations, measured Maestro taps/fills,
viewport projection, captures, and cleanup. SSO-specific behavior remains
local to this suite.

All reachable Trinity actions are trusted Maestro inputs. CDP may read URL,
text, counts, geometry, focus, and captures, but may never invoke a product
handler or navigate the application. The native Android Back intent is the
only transition from the silent callback surface back to Login before the
fresh legitimate attempt.

### Real Chrome Custom Tab and Dex

The suite uses the production Capacitor Browser handoff. Before a provider
round trip it resets the disposable Chrome profile, writes a bounded Chrome
command line under `/data/local/tmp`, and requests first-run suppression,
loopback IPv4 resolution, and disposable-certificate acceptance. Stable Chrome
may ignore those test flags: a bounded Maestro setup flow therefore dismisses
the native first-run prompts when present, and the provider-readiness flow
accepts only Chrome's localhost certificate interstitial through its native
Advanced/Proceed controls. It then reactivates Trinity; the product's
`Browser.open` launches the actual Chrome Custom Tab in that configured
process.

Dex remains the pinned container configured by `dex.yaml`. A dedicated Maestro
flow attaches to `com.android.chrome`, crosses the disposable localhost
certificate warning when present, waits for the fixed Dex form through
Maestro's DevTools-backed WebView hierarchy, focuses and fills the exact harness
email and password through native input, and taps the provider submit control.
UIAutomator proves the native Chrome package; neither UIAutomator nor CDP fills,
clicks, submits, or redirects the provider. Clearing the disposable Chrome
profile between legitimate stages prevents a prior Dex cookie from turning the
next required provider interaction into a silent login.

No Playwright Android driver is installed. The Chrome command-line file is
removed immediately after startup, Chrome is force-stopped during cleanup, and
the stage ledger records the package, activity/surface observation, and native
action evidence without URLs containing state or tokens.

### Isolated adversarial-token fixture

A separate headless host Chromium context performs the predecessor's isolated
fixture round trip. It visits the real Synapse SSO redirect, fills the pinned
Dex form inside that fixture context, captures the `loginToken` from the
non-product `/sso-harness-callback` request, and closes the context with the
token unspent. This browser may operate only the provider fixture; it may not
attach to Android, invoke Trinity code, or serve as proof of the legitimate
installed-app flow.

Token redemption uses finite Node `fetch` against
`/_matrix/client/v3/login` with `m.login.token`, requires HTTP 200 and the exact
`@sso-e2e:localhost` MXID, retains the resulting access token only in memory,
and revokes it through `/_matrix/client/v3/logout` in guaranteed cleanup.

### Stage 1: provider sign-in and persistence

1. Reset and launch the installed app with the mobile account profile.
2. Enter the exact disposable Synapse homeserver through native input and tap
   Continue natively.
3. Prove password Sign in and Continue with SSO visible and delegated-auth
   `oidc-continue` absent, recording the first three identities.
4. Configure fresh Chrome, tap Continue with SSO through Maestro, prove the
   external package/surface, and complete the pinned Dex form through Maestro.
5. Wait for installed-app Rooms readiness.
6. Force-stop and relaunch Trinity through the host without clearing app data.
   Require Rooms again, require Login absent, and record the fourth identity.

### Stage 2: unverifiable callback and unspent token

1. Reset the installed app so no SSO stash exists.
2. Mint a real unspent one-use token through the isolated host-browser fixture
   and register the token as a secret before any retained output.
3. Deliver
   `eu.qwky.trinity://sso-callback?loginToken=<token>&sso_state=forged`
   through `adb shell am start` targeted at the Trinity package.
4. Prove the exact verification message and Back-to-sign-in action visible and
   prove the installed route is not Rooms.
5. Redeem the same token independently, require the exact harness MXID, and
   revoke the resulting Matrix access token in `finally`.

The app must not make a Matrix token-login request in this stage. A read-only
CDP network observer records only the count and endpoint metadata needed to
prove that negative boundary; it never records request bodies or tokens.

### Stage 3: forged callback during a live sign-in

1. Reset the installed app with the desktop account profile.
2. Enter the homeserver natively, configure fresh Chrome, start SSO natively,
   and pause on the real Dex form without submitting it. This establishes a
   durable live state stash in the installed app.
3. Mint another unspent token through the isolated fixture, then inject its
   forged-state callback through the Android deep-link
   boundary. Require Chrome to close and Trinity's callback surface to resume.
4. Record all 15 direct identities: completing copy, Trinity wordmark,
   single heading and main landmark, present/in-range card bounds, inset body,
   absent verification error, and absent Rooms route.
5. Require zero app token-login requests, redeem and revoke the still-fresh
   forged token independently, then send native Back and require Login.
6. Configure a fresh provider surface, start a new legitimate SSO attempt,
   fill Dex through Maestro, and wait for Rooms.

The forged token remains secret and unredeemed by Trinity. The final legitimate
provider callback, not the injected callback, is the only completion proof.

### Artifacts, redaction, and teardown

The suite writes an initial three-stage ledger, 23 assertion records, provider
surface observations, pass/failure device and WebView captures, stage progress,
and `suite-summary.json`. It records exact source spans, renderer manifest,
APK, emulator/profile, attempt/retry counts, durations, assertion accounting,
deep-link mechanism, and native action ownership without storing callback
URLs, credentials, tokens, access tokens, or state values.

The Dex email/password, every Matrix login token, access token, bearer value,
and discovered/generated state nonce are registered with
`redactMaestroArtifacts`. Chrome and host-browser diagnostics receive the same
secret set. Effective negative controls inject representative values and prove
the retained-artifact scan replaces each with `[REDACTED]`.

Cleanup is aggregate and bounded: unsubscribe CDP observers, close host-browser
contexts/processes, revoke fixture observation sessions, remove the Chrome
command-line file, force-stop Chrome, close the WebView/viewport, close
Maestro, and release Synapse through invocation cleanup. A cleanup failure is a
suite failure and remains attached to any stage failure.

### Nx, registry, and hosted execution

Register suite id `android.legacy-sso`, Nx target `legacy-sso`, package script
`e2e:android:legacy-sso`, and a started-only `android-legacy-sso` diagnostic
upload. The target is uncached and non-parallel, depends on the prebuilt
Android app, requires Chrome plus Maestro, and owns serialized `android-avd`
and `synapse` resources with bounded Node and CI timeouts.

Place the suite on the shortest suitable Android shard using the latest
completed hosted timing evidence without reordering unrelated suites. Preserve
exact renderer/APK/profile provenance and run the three retained browser
predecessors unchanged and sequentially at retry zero.

## Failure handling

- If the expected login actions do not classify the real Synapse correctly,
  capture the installed surface and fail before launching the provider.
- If Chrome does not expose the pinned Dex surface, retain only sanitized
  package/activity/UI metadata and fail without substituting fixture-browser
  completion.
- If a callback opens Rooms unexpectedly, stop before independent redemption
  and mark the security boundary failed; never publish the token.
- If the forged in-flight callback reports an error, consumes the stash, loses
  the callback layout, or reaches Rooms, capture both native and WebView proof.
- If the host relaunch returns to Login, fail session-persistence proof even if
  the first Rooms transition succeeded.
- If token redemption returns non-200 or a different MXID, record status and
  expected identity only; never retain response bodies or bearer values.
- If any cleanup fails, aggregate it with the stage failure so teardown cannot
  be mistaken for success.

## Validation and acceptance

Implementation proceeds test-first. The focused migration guard must start RED
and end GREEN. Effective negative controls must independently reject:

1. password/SSO/delegated-action classification drift;
2. a mocked or fixture-substituted legitimate provider flow;
3. DOM-driven Trinity or Dex actions;
4. session persistence loss after host relaunch;
5. forged-state acceptance or Rooms navigation;
6. token consumption or weakened exact-MXID redemption proof;
7. live-stash loss after an in-flight forged callback;
8. completing-copy, wordmark, landmark, card-bound, or body-inset weakening;
9. missing Chrome/deep-link/native-action provenance; and
10. cleanup or credential/token/state/access-token redaction loss.

After restoration, run focused and full script tests, registry/workflow guards,
Android and browser typecheck/lint, formatting and documentation gates, and the
source-selected Nx validation. Run three unchanged installed-Android first
attempts sequentially with all three stages and zero retries, then the exact
three Playwright predecessors sequentially at retry zero. Independent review
must have no unresolved findings.

Push the verified feature branch, cherry-pick only its commits into
`test/676-android-sidebar-filter`, prove identical trees, and obtain
original-attempt hosted Android/browser/renderer artifact evidence before
closing #723 and updating #660, #653, and PR #677. Keep every predecessor
enabled and PR #677 draft/open and unmerged. Do not merge PR #677.

## Rejected alternatives

- **Reuse the Android Playwright fixture:** that would retain the driver and
  browser automation boundary this migration exists to remove.
- **Use host Chromium for legitimate sign-in:** it cannot prove the installed
  app's Capacitor Browser handoff, Chrome Custom Tab, or native callback.
- **Inject a successful callback:** it bypasses the real provider and cannot
  prove the state stash or legitimate round trip.
- **Drive Dex through CDP:** the provider is reachable through Maestro native
  input; DOM operations would violate the same action boundary as Trinity.
- **Expose SSO methods on `AccountWorkspaceClient`:** provider and adversarial
  token protocols belong to this one migration and would widen shared surface
  without a second consumer.
