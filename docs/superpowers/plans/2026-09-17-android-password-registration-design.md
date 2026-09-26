# Android Password Registration Migration Design

- **Issue:** #722
- **Status:** Approved
- **Target branch:** `test/722-android-password-registration`
- **Integration branch:** `test/676-android-sidebar-filter`

## Purpose

Replace the Android-applicable coverage of the canonical password-registration
journey with a deterministic installed-Android Maestro/Node suite. Preserve the
real Synapse `m.login.dummy` UIA registration flow, prove the resulting account
independently through Matrix REST, retain the Playwright predecessor unchanged,
and publish enough evidence to audit native action ownership and secret safety.

This migration does not change product behavior. It adds a native parity suite,
source-shape guards, Nx/registry/CI wiring, and an evidence ledger.

## Canonical ownership

The contract pins these complete files and owned spans:

- `e2e/browser/journeys/accounts/registration.spec.mts`, SHA-256
  `a22f58f703c185645987ad471c2f8637d2741344be365d5063c8f0b1c37f2dbd`:
  lines 10–48 own the password-registration journey.
- `e2e/support/app.mts`, SHA-256
  `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`:
  lines 124–166 own the Synapse-session and labeled-input helpers consumed by
  the predecessor.
- `e2e/support/account.mts`, SHA-256
  `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`:
  lines 57–79 own the independent password-login observation helper.

The predecessor has two direct assertion sites and two required route
transitions. The Android contract records all four as unique stage-local
identities:

1. `password-registration.availability-action-visible`
2. `password-registration.registration-route`
3. `password-registration.encryption-setup-route`
4. `password-registration.exact-mxid`

The availability observation includes the initially absent action, the exact
side-effect-free `/_matrix/client/v3/register/available` request and successful
response, and the subsequently visible action. This prevents a vacuous pass in
which the login page exposes registration without the homeserver probe.

## Architecture

### Source contract and guard

`e2e/android/password-registration-contract.mts` exports the pinned sources,
four assertion identities, and their type. A focused source-shape test verifies
the hashes and owned spans, exactly two direct assertion sites, both route
obligations, predecessor retention, and the boundaries below before the
journey exists.

The guard rejects DOM click, focus, fill, submit, navigation, synthetic pointer
events, REST/shared-secret creation of the tested account, an unobserved or
weakened availability gate, and diagnostics that omit secret redaction or
bounded cleanup.

### Native journey

`e2e/android/password-registration-journeys.mts` contains one Node test and one
stage. It reuses `AccountWorkspaceClient` only for its established installed
WebView lifecycle, read observations, trusted Maestro taps/fills, capture, and
cleanup. Registration-specific behavior remains local to the journey rather
than widening the shared client.

The stage runs with the mobile account profile and performs this sequence:

1. Clear and launch the installed app on `/login`.
2. Arm a read-only CDP network observer, prove the registration action absent,
   enter the exact disposable Synapse homeserver through native input, and tap
   `Continue` natively.
3. Observe one successful availability request before proving
   `[data-testid="password-register"]` visible. Record the request path and
   status only; never capture its body or credentials.
4. Tap the registration action natively and prove the concrete `/register`
   pathname plus the exact homeserver query.
5. Generate `signup-<test-resource-id>` and a unique password, then fill
   `#registration-username`, `#registration-password`, and
   `#registration-confirm-password` through Maestro-native input.
6. Tap `[data-testid="register-submit"]` natively. The product SDK completes
   Synapse `m.login.dummy`, establishes the returned session, and transitions
   the first device to `/encryption/setup`.
7. Observe the exact final pathname. Recovery unlock, Rooms, a local-only
   session, and any alternate route fail the stage.

Renderer/CDP inspection may read URLs, action visibility, element values,
focus, network metadata, and captures. It never performs or substitutes a
product action.

### Independent server proof

After the final route is established, a finite Node `fetch` logs in through
`/_matrix/client/v3/login` with the chosen credential. It requires HTTP 200 and
the exact `@<username>:localhost` MXID. The observer keeps the returned access
token only in memory and calls `/_matrix/client/v3/logout` in a `finally`
cleanup. A failed logout is a cleanup failure, not a warning.

REST does not call registration, the Synapse shared-secret API, or any fixture
that creates the tested account. It may only observe registration availability,
password login, and session revocation.

### Artifacts, redaction, and teardown

The suite writes a stage ledger, four assertion records, pass/failure device
and WebView captures, `suite-summary.json`, and attempt progress. It records
renderer manifest, APK, emulator profile, source spans, duration, and assertion
accounting without storing credentials or response bodies.

The generated password, REST access token, Matrix session values, and any known
UIA/session material are registered with `redactMaestroArtifacts`. Native log
payload redaction remains active. Effective negative controls must prove the
artifact scan detects an injected credential and session token.

Cleanup is aggregate and bounded: unsubscribe and disable the CDP network
observer, revoke the REST observation session, close the WebView/viewport,
close Maestro, stop Synapse, and preserve every cleanup error. A passing run
records four unique identities exactly once, one attempt, zero retries, and no
leaked resources.

### Nx, registry, and hosted execution

Register suite id `android.password-registration`, Nx target
`password-registration`, package script `e2e:android:password-registration`,
and a started-only `android-password-registration` diagnostic upload. The target
is uncached and non-parallel, depends on the prebuilt Android app, and owns
serialized `android-avd` plus `synapse` resources with bounded Node and CI
timeouts.

Place the suite on the shortest suitable Android shard using the latest
completed hosted timing evidence. Do not reorder unrelated suites. Preserve
exact renderer/APK/profile provenance and run the retained browser predecessor
unchanged.

## Failure handling

- If the availability request never succeeds, retain the latest request/status
  observation and fail before registration is tapped.
- If the WebView document changes during UIA, read observations reattach through
  the existing bounded lifecycle seam; native actions are never replayed.
- If registration reaches an unexpected route, capture both installed-device
  and WebView proof before teardown.
- If REST login returns non-200 or the wrong MXID, record status and the expected
  identity without publishing the password, token, or response body.
- If any cleanup fails, aggregate it with the stage failure so teardown cannot
  be mistaken for success.

## Validation and acceptance

Implementation proceeds test-first. The focused migration guard must start RED
and end GREEN. Effective negative controls must independently reject:

1. an availability action exposed before the exact probe;
2. UIA bypass or REST/shared-secret creation of the tested account;
3. a missing or weakened `/register` route assertion;
4. a final route other than `/encryption/setup`;
5. a local-only/vacuous registration without successful REST login;
6. a weakened exact-MXID assertion;
7. missing observation-session revocation; and
8. cleanup or credential/session redaction loss.

After restoration, run focused and full script tests, registry/workflow guards,
Android and browser typecheck/lint, formatting and documentation gates, and the
source-selected Nx validation. Run three unchanged installed-Android first
attempts sequentially with zero retries, then the exact Playwright predecessor
once at retry zero. Independent review must have no unresolved findings.

Push the verified feature branch, cherry-pick only its commits into
`test/676-android-sidebar-filter`, prove identical trees, and obtain
original-attempt hosted Android/browser/renderer artifact evidence before
closing #722 and updating #660, #653, and PR #677. Keep the predecessor enabled
and PR #677 draft/open and unmerged. Do not merge PR #677.

## Rejected alternatives

- **Add registration methods to `AccountWorkspaceClient`:** this would put a
  single-journey UIA protocol into a shared client and increase regression
  surface without a second consumer.
- **Build a separate native driver:** this would duplicate trusted input,
  viewport, capture, and document-lifecycle machinery already proven by the
  account migrations.
- **Create the account through REST and inspect the UI afterward:** this bypasses
  the behavior #722 owns and cannot prove registration or UIA parity.
