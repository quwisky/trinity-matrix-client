# Android OIDC-native Login Migration Design

## Goal

Migrate all four canonical mocked MSC3861/MSC2965 OIDC-native login
definitions to faithful installed-Android Maestro/Node journeys without editing
or retiring their Playwright predecessors. The migrated suite must prove native
OIDC classification, exact dynamic registration and authorization parameters,
durable PKCE redemption, and the non-OIDC password fallback.

## Immutable source contract

The migration pins
`e2e/browser/journeys/accounts/oidc-login.spec.mts` at SHA-256
`e9a0dadad15f155a3c69b49e06d8b4539ea7d7f446fd08cfaa565fa3ba6ecb8a`
and owns these exact spans:

- lines 86-100: delegated Continue/Create-account classification, 4 direct
  assertions;
- lines 102-169: dynamic registration, PKCE authorization and provider-error
  callback, 13 direct assertions;
- lines 171-248: code redemption with the durable verifier, 7 direct
  assertions; and
- lines 250-285: non-OIDC password fallback, 2 direct assertions.

The shared navigation source `e2e/support/app.mts` remains unchanged at
SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.
The migration contract exports exactly 26 stable assertion identities in the
same four groups and asserts both count and uniqueness at module load.

## Architecture

One Node test owns four ordered stages, one installed Android app, and one
logical `OidcLoginFixture`. The fixture is the only network controller in a
stage. It uses CDP Fetch on the attached Trinity WebView and, only for the
authorization handoff, the prepared disposable Chrome surface. Both
connections are part of the same fixture lease, serialize paused-request
handling, accept only an allowlist of exact methods and endpoints, and restore
Fetch in `finally`. Any unrecognised request in an owned provider/Matrix scope
fails rather than receiving a permissive response.

The app is reset between stages. `AccountWorkspaceClient` supplies measured
native focus, fill and taps. Renderer reads may observe visibility, counts,
text and current route; they never dispatch events, focus controls, write
fields, submit forms, invoke application handlers, or navigate. The fixture
may return deterministic protocol responses and record request facts, but it
does not perform product actions.

The Chrome handoff uses a disposable profile prepared before the native OIDC
tap. The fixture attaches to that exact Chrome target and proves the package
and target transition. The authorization response is an exact 302 to the
registered private-use callback, preserving the captured state. For the error
stage it carries `access_denied` and `E2E declined`; for the redemption stage
it carries an in-memory authorization code. No provider UI interaction is
needed or substituted.

## Exact protocol fixture

The fixture owns only these endpoints:

- `https://oidc.example/.well-known/matrix/client`;
- `https://hs.oidc.example/_matrix/client/versions`;
- `https://hs.oidc.example/_matrix/client/v3/login`;
- `https://hs.oidc.example/_matrix/client/v1/auth_metadata`;
- `https://hs.oidc.example/_matrix/client/unstable/org.matrix.msc2965`;
- `https://hs.oidc.example/_matrix/client/v3/account/whoami`;
- `https://provider.oidc.example/register`;
- `https://provider.oidc.example/authorize`; and
- `https://provider.oidc.example/token`.

Every `OPTIONS` request receives status 204 with the exact permissive CORS
headers. JSON responses preserve status, content type, cache exclusion and
CORS. OIDC metadata matches the predecessor exactly: issuer, authorization,
token, revocation, registration and account-management endpoints; query and
fragment response modes; code response type; authorization-code and refresh
grants; S256; and create prompt support. The fallback stage returns exact 404
`M_UNRECOGNIZED` responses from both auth-metadata endpoints.

The fixture stores only sanitized observations. Dynamic registration exposes
the application type but not arbitrary request bodies. Authorization exposes
the client id, response type, challenge method, callback URL, Matrix scope
membership, response mode, and boolean non-empty state/challenge facts. The
live values for state and challenge remain in memory for callback construction
and PKCE comparison. Token exchange exposes the grant type, client id, boolean
non-empty verifier, and in-memory verifier/code values long enough to verify
the code and RFC 7636 S256 equality. It never writes those values to evidence.

## Four native stages

### 1. Delegated classification

Reset the app with the mobile profile, install the OIDC discovery fixture,
focus and fill `oidc.example` natively, and tap Continue natively. Record that
delegated Continue and Create account are visible and that password Sign in
and legacy SSO are absent. Close the fixture and prove its expected request
ledger is complete.

### 2. Provider error callback

Reset the app, install the OIDC fixture in provider-error mode, and repeat
native discovery. Prepare the exact Chrome handoff, then tap delegated
Continue natively. Capture and validate dynamic registration and the complete
authorization request. Fulfil authorization with a matching-state error
callback, wait for Trinity to regain focus, and record exact provider error and
Back-to-sign-in visibility. Record the 11 protocol identities in source order
so this stage owns exactly 13 identities total.

### 3. Durable PKCE redemption

Reset the app and install the fixture in code-redemption mode. Start delegated
login natively and redirect the exact authorization code with matching state.
Capture the token POST, verify authorization-code grant, exact code and client
id, a non-empty durable verifier, and RFC 7636 S256 equality with the captured
challenge. Fulfil token and whoami with the exact mocked responses, then prove
the callback does not show verification or missing-detail errors. Do not claim
Matrix sync, crypto, or Rooms arrival.

### 4. Non-OIDC fallback

Reset the app and install fallback mode: Matrix password login is available
and both auth metadata endpoints return exact 404 `M_UNRECOGNIZED`. Enter the
same domain and continue natively. Record password Sign in visible and
delegated Continue absent.

## Evidence, redaction, and cleanup

Create the four stage-ledger entries before app launch and run exactly one
attempt with zero retries. Each assertion identity is recorded once. Retain
renderer manifest, APK, installed package and viewport-profile provenance;
stage durations; sanitized request ledgers; native-action facts; and pass or
failure captures.

Register every live PKCE verifier, challenge, state, authorization code,
mocked access token, mocked refresh token, captured header and raw body for
redaction before it can reach output. Artifact scanning must reject those
values and token/header patterns. Failure descriptions use endpoint classes
and assertion names, never raw URLs with query strings or request bodies.

Cleanup is ordered and aggregate: release any paused request, unsubscribe
events, drain serialized work, disable Fetch on Chrome and WebView, close CDP
connections and forwards, force-stop/clear disposable Chrome, close the
account viewport/WebView, close Maestro, and release invocation resources.
Cleanup failure remains a suite failure and artifact redaction runs last.

## Registration and hosted execution

Register suite id `android.oidc-login`, Nx target `oidc-login`, package script
`e2e:android:oidc-login`, and a started-only `android-oidc-login` diagnostic
upload. The uncached non-parallel target depends on the prebuilt Android app,
requires Maestro, owns serialized `android-avd`, and uses bounded Node and CI
timeouts. Chrome is the installed emulator browser, not a Playwright runner
prerequisite.

Place the suite on the shortest suitable Android shard using current retained
timings. Preserve exact renderer/APK/profile provenance and run the four
unchanged Playwright predecessors sequentially with one worker and zero
retries.

## Validation and acceptance

Implementation is test-first. A focused migration guard begins RED and ends
GREEN. Effective negative controls must independently reject source or identity
drift, weakened endpoint/CORS/metadata contracts, non-native product actions,
incorrect native application type or callback, missing/empty state or
challenge, non-S256 PKCE, verifier mismatch, token exchange bypass, fallback
weakening, competing Fetch controllers, incomplete cleanup, and redaction
loss.

After static validation, run three unchanged installed-Android first attempts
sequentially. Every run must pass all four stages, all 26 identities, one
attempt and zero retries. Run the four exact browser predecessors sequentially
at retry zero. Complete independent review, push the feature branch,
cherry-pick only its verified commits into `test/676-android-sidebar-filter`,
prove identical trees, and audit original-attempt hosted Android, browser and
renderer artifacts before closing #724 and updating #660, #653 and PR #677.
Keep PR #677 draft/open and unmerged.

## Rejected alternatives

- Retiring or modifying the Playwright predecessors would destroy the pinned
  source contract.
- A real identity provider would make metadata, callbacks and token evidence
  nondeterministic and exceed the predecessor scope.
- DOM click/focus/fill/submit/navigation would bypass installed-app product
  actions.
- Seeding OIDC state or the provider client id would bypass dynamic
  registration and durable state proof.
- Treating a non-empty verifier as sufficient would not prove PKCE continuity;
  the S256 digest must equal the captured challenge.
- Claiming successful Matrix startup after whoami would exceed the predecessor,
  which ends at wire-level exchange.
