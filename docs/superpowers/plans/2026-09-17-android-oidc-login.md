# Android OIDC-native Login Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Keep all four
> native stages sequential because they share the installed Android host and
> Chrome handoff.

**Goal:** Add deterministic installed-Android parity for all four canonical
OIDC-native login definitions while preserving exact discovery, registration,
authorization, durable PKCE redemption, fallback behavior, and unchanged
Playwright predecessors.

**Architecture:** A focused source-shape guard pins the four canonical tests
and their 26 assertion identities. One logical CDP Fetch fixture owns exact
Matrix/provider responses across the Trinity WebView and prepared Chrome
handoff, while the existing account client and Maestro own every product
action. One Node suite runs four reset-isolated stages and records only
sanitized protocol facts plus native/renderer evidence.

**Tech Stack:** TypeScript/Node test runner, Vitest source-shape guards,
Maestro, ADB/UIAutomator, Chrome Custom Tabs, raw Chrome DevTools Protocol,
Capacitor Preferences/deep links, Nx, GitHub Actions, pnpm.

**Spec:**
`docs/superpowers/plans/2026-09-17-android-oidc-login-design.md`

## Global constraints

- Preserve `e2e/browser/journeys/accounts/oidc-login.spec.mts` unchanged at
  SHA-256 `e9a0dadad15f155a3c69b49e06d8b4539ea7d7f446fd08cfaa565fa3ba6ecb8a`.
  Its owned spans are lines 86-100, 102-169, 171-248 and 250-285 and contain
  exactly 4 + 13 + 7 + 2 direct assertion sites.
- Preserve `e2e/support/app.mts` unchanged at SHA-256
  `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.
- Maestro/native Android input owns every reachable Trinity action. CDP and
  renderer inspection may provide protocol responses or observations but must
  not click, focus, fill, submit, navigate or invoke handlers.
- One logical OIDC fixture is the only active network controller. It owns exact
  allowlisted endpoints, serializes events, restores Fetch in `finally`, and
  treats unexpected owned-scope traffic as a failure.
- Record all 26 contract identities exactly once. Use one attempt, zero retries
  and serialized `android-avd` ownership.
- Redact PKCE verifier/challenge/state, authorization codes, mocked access and
  refresh tokens, captured headers and raw request bodies from all artifacts.
- Do not claim post-exchange Matrix sync, crypto or Rooms coverage.
- Keep PR #677 draft/open and unmerged. Do not merge PR #677.

---

### Task 1: Add the focused migration guard in RED

**Files:**

- Create: `scripts/oidc-login-migration.spec.mjs`
- Read unchanged: `e2e/browser/journeys/accounts/oidc-login.spec.mts`
- Read unchanged: `e2e/support/app.mts`

**Interfaces:**

- Consumes the two pinned sources and existing Android target, suite registry,
  command registry, workflow and migration ledger.
- Produces a Vitest suite requiring the immutable contract, exact fixture,
  four native stages, 26 identities, boundary enforcement, redaction/cleanup,
  Nx/registry/CI wiring and predecessor retention.

- [x] **Step 1: Pin exact source shape and assertion counts**

  Add `sourceLines(path, expectedHash)` and exact-span extraction. Require the
  four titles at their pinned starts, the expected closing lines, direct
  assertion counts 4/13/7/2, exact constants `HS_DOMAIN`, `HS_BASE`,
  `REGISTRATION_ENDPOINT`, `AUTH_METADATA`, `CORS`, the helper functions
  `json`, `mockOidcHomeserver`, `discover`, and unchanged predecessor
  registration.

- [x] **Step 2: Require the exact 26-identity contract**

  Require `OIDC_LOGIN_SOURCES`, `oidcLoginAssertions`, four groups named
  `classification`, `providerError`, `redemption`, and `fallback`, plus the
  exact stable values below:

  ```text
  oidc-login.delegated-continue-visible
  oidc-login.create-account-visible
  oidc-login.password-action-absent
  oidc-login.legacy-sso-action-absent
  oidc-login.provider-error-visible
  oidc-login.back-to-sign-in-visible
  oidc-login.authorize-request-present
  oidc-login.client-id-exact
  oidc-login.response-type-code
  oidc-login.challenge-method-s256
  oidc-login.challenge-nonempty
  oidc-login.state-nonempty
  oidc-login.callback-uri-exact
  oidc-login.registration-application-type-native
  oidc-login.scope-client-api
  oidc-login.scope-device
  oidc-login.response-mode-query
  oidc-login.token-request-present
  oidc-login.grant-type-authorization-code
  oidc-login.authorization-code-exact
  oidc-login.token-client-id-exact
  oidc-login.verifier-nonempty
  oidc-login.pkce-s256-match
  oidc-login.callback-errors-absent
  oidc-login.password-action-visible
  oidc-login.delegated-continue-absent
  ```

  Require module-load assertions for count 26 and uniqueness 26.

- [x] **Step 3: Guard native/CDP/renderer and protocol boundaries**

  Require `AccountWorkspaceClient.focusCurrent`, `fillFocused` and
  `tapCurrent` for product actions; exact Chrome package proof; one logical
  fixture; `Fetch.enable`, `Fetch.fulfillRequest`, `Fetch.continueRequest` and
  `Fetch.disable`; exact endpoint/method matching; 204 CORS preflights; exact
  metadata; native registration application type; private-use callback;
  matching state; exact token exchange; S256 digest equality; pass/failure
  captures; four stages; aggregate cleanup and redaction.

  Reject Playwright Android APIs, `Runtime.evaluate`, renderer-side
  click/focus/fill/submit/navigation, synthetic events, application handler
  invocation, seeded client/state/verifier values, permissive wildcard URL
  handling, raw query/body/header evidence and multiple fixture/controller
  installation in one stage.

- [x] **Step 4: Guard wiring and retained coverage**

  Require target `oidc-login`, suite `android.oidc-login`, package script
  `e2e:android:oidc-login`, a bounded `ci-run-command`, started marker
  `oidc-login-started=true`, diagnostic surface `android-oidc-login`, exact
  report path, migration-ledger source/evidence entries, and the unchanged
  browser suite remaining registered.

- [x] **Step 5: Run the guard and preserve the expected RED**

  ```bash
  pnpm exec vitest run scripts/oidc-login-migration.spec.mjs
  ```

  Expected: FAIL because `oidc-login-contract.mts`, fixture, journey and wiring
  do not exist. Confirm the failure names those missing migration outputs, not a
  syntax or source-pin error.

- [x] **Step 6: Commit the RED guard**

  ```bash
  git add scripts/oidc-login-migration.spec.mjs \
    docs/superpowers/plans/2026-09-17-android-oidc-login-design.md \
    docs/superpowers/plans/2026-09-17-android-oidc-login.md
  git commit -m "test(e2e): guard Android OIDC login migration"
  ```

### Task 2: Implement the immutable contract and exact OIDC fixture

**Files:**

- Create: `e2e/android/oidc-login-contract.mts`
- Create: `e2e/android/oidc-login-fixture.mts`
- Create: `e2e/android/flows/oidc-login-chrome-setup.yaml`
- Test: `scripts/oidc-login-migration.spec.mjs`
- Reuse unchanged: `e2e/support/devtools-connection.mts`
- Reuse unchanged: `e2e/android/maestro-webview.mts`
- Reuse unchanged: `e2e/android/maestro-session.mts`

**Interfaces:**

- Contract exports `OIDC_LOGIN_SOURCES`, `oidcLoginAssertions`,
  `OidcLoginAssertion` and module-load invariants.
- Fixture exports:

  ```ts
  export type OidcLoginFixtureMode = 'classification' | 'provider-error' | 'redemption' | 'fallback';

  export interface OidcLoginFixture {
    readonly observations: OidcLoginObservations;
    prepareChrome(): Promise<void>;
    waitForAuthorization(signal: AbortSignal): Promise<OidcAuthorizeObservation>;
    waitForToken(signal: AbortSignal): Promise<OidcTokenObservation>;
    assertComplete(): void;
    close(): Promise<void>;
  }

  export function installOidcLoginFixture(options: { readonly mode: OidcLoginFixtureMode; readonly app: DevtoolsEventConnection; readonly device: MaestroDevice; readonly workspaceRoot: string; readonly artifactDirectory: string; readonly signal: AbortSignal; readonly registerSecret: (name: string, value: string) => void }): Promise<OidcLoginFixture>;
  ```

- [x] **Step 1: Add the immutable source and identity contract**

  Export the two pinned source strings and four source spans. Export the 26 ids
  above in source order, infer their literal union, and assert exact count and
  uniqueness with `node:assert/strict`.

- [x] **Step 2: Parse only exact paused requests**

  Implement a strict `pausedRequest(value)` parser returning request id,
  method, URL, headers and optional post data. Add endpoint classification by
  exact origin/path and accepted method. Refuse fragments, unexpected query
  keys on non-authorization endpoints, and any owned provider/Matrix request
  not represented in the mode ledger. Continue only traffic outside the owned
  origins.

- [x] **Step 3: Fulfil exact discovery, Matrix and provider responses**

  Add helpers for base64 JSON and redirects. `OPTIONS` returns 204 plus the
  three exact CORS headers. Classification/error/redemption modes return exact
  OIDC discovery, versions, empty login flows and auth metadata. Fallback mode
  returns password flow and exact 404 `M_UNRECOGNIZED` from both metadata
  endpoints. Registration accepts POST, parses JSON, records only
  `application_type`, and returns status 201 with `e2e-client-id`.

- [x] **Step 4: Prepare and attach the disposable Chrome handoff**

  Force-stop and clear `com.android.chrome`, write the bounded disposable
  command line, open `about:blank`, cross first-run UI through the dedicated
  Maestro flow, attach CDP to the exact Chrome target, arm the provider
  authorize interception, remove the command-line file, and return to Trinity.
  Fail if the OIDC handoff uses any other package or target. Record only package,
  profile-cleared, driver-absent and controller-owned facts.

- [x] **Step 5: Implement provider-error and redemption responses**

  On exact authorize GET, capture in-memory state/challenge/callback and the
  sanitized parameter facts. Provider-error mode fulfils 302 to the exact
  callback with matching state, `access_denied` and `E2E declined`.
  Redemption mode fulfils 302 with matching state and `E2E_CODE`, then accepts
  exact token POST in the app WebView, registers the verifier/code/tokens for
  redaction, validates the code and computes:

  ```ts
  createHash('sha256').update(verifier).digest('base64url');
  ```

  Require equality with the captured challenge before returning the mocked
  bearer/refresh response and exact whoami response.

- [x] **Step 6: Add finite observation and aggregate cleanup**

  Serialize each connection's events through a promise chain, retain the first
  event failure, provide abort-bounded waits, and expose cloned sanitized
  observations. On close, release any paused request, unsubscribe, drain work,
  disable Fetch, close Chrome/app CDP leases and forwards, remove staged files,
  force-stop/clear Chrome and aggregate every failure.

- [x] **Step 7: Run focused tests incrementally**

  ```bash
  pnpm exec vitest run scripts/oidc-login-migration.spec.mjs
  pnpm nx run trinity-e2e-android:typecheck --skipNxCache
  ```

  The guard may remain RED only for the not-yet-created journey and wiring.
  Contract, endpoint, CORS, metadata, PKCE, Chrome, cleanup and redaction checks
  must pass.

### Task 3: Implement the four installed-Android stages

**Files:**

- Create: `e2e/android/oidc-login-journeys.mts`
- Test: `scripts/oidc-login-migration.spec.mjs`
- Reuse unchanged: `e2e/android/account-workspace-client.mts`
- Reuse unchanged: `e2e/android/maestro-session.mts`
- Reuse unchanged: `e2e/support/node-fixtures.mts`

**Interfaces:**

- Consumes `AccountWorkspaceClient`, `PIXEL_5_ACCOUNT_PROFILE`,
  `openMaestroDevice`, `redactMaestroArtifacts`, `readSession`,
  `withNodeTestResources`, the immutable contract and `installOidcLoginFixture`.
- Produces one Node test, four ordered stage ledgers, 26 one-shot assertion
  records, pass/failure captures and a suite summary.

- [x] **Step 1: Add native discovery and typed assertion recording**

  Implement `recordAssertion(client, recorded, identity, observation)` with a
  duplicate assertion guard. Implement `discover(client)` exclusively as:

  ```ts
  await client.focusCurrent('#homeserver');
  await client.fillFocused('#homeserver', 'oidc.example');
  await client.tapCurrent('button', { exactText: 'Continue' });
  ```

  Use renderer reads only after the native actions complete.

- [x] **Step 2: Implement classification stage (4 identities)**

  Reset mobile, attach app CDP, install classification fixture, discover
  natively, observe `oidc-continue` and `oidc-register`, and prove password Sign
  in plus legacy SSO actions have zero matches. Record exactly the four
  classification ids, assert fixture completeness, capture pass/failure and
  close in aggregate `finally`.

- [x] **Step 3: Implement provider-error stage (13 identities)**

  Reset mobile, install provider-error fixture, discover, prepare Chrome, and
  tap `oidc-continue` natively. Wait for the matching-state return, exact
  `E2E declined` text and Back-to-sign-in action. Record the two UI identities
  and all 11 sanitized authorization/registration identities, including
  authorize presence, native application type, exact private-use callback,
  both Matrix scopes and query response mode.

- [x] **Step 4: Implement redemption stage (7 identities)**

  Reset mobile, install redemption fixture, discover, prepare Chrome and tap
  delegated Continue natively. Wait for the token POST and record presence,
  exact grant/code/client id, non-empty verifier and fixture-computed S256
  equality. After token/whoami fulfilment, prove both callback error messages
  have zero matches and record the final identity. Do not wait for or assert
  Rooms.

- [x] **Step 5: Implement fallback stage (2 identities)**

  Reset mobile, install fallback fixture, discover natively, require password
  Sign in visible and delegated Continue absent, then record exactly those two
  identities and the fixture's exact 404 metadata ledger.

- [x] **Step 6: Add attempt/provenance/captures/redaction**

  Create all four `running|passed|failed` stage entries before launch. Record
  renderer manifest, APK digest, installed package and viewport profile, one
  attempt/zero retries, stage durations and sanitized fixture ledgers. Capture
  each pass and the first failure. Close fixture, app CDP, client, device and
  resources with aggregate errors; run artifact redaction last and scan for
  every registered secret plus generic bearer/header/body patterns.

- [x] **Step 7: Prove focused GREEN and negative controls**

  ```bash
  pnpm exec vitest run scripts/oidc-login-migration.spec.mjs
  pnpm nx run trinity-e2e-android:typecheck --skipNxCache
  ```

  Mutate one obligation at a time: source count, CORS, metadata, endpoint,
  native action, callback, state, challenge method, verifier equality, token
  exchange, fallback 404, controller cleanup and redaction. Confirm each
  mutation turns the focused guard RED, restore, and confirm GREEN.

- [x] **Step 8: Commit contract, fixture and journey**

  ```bash
  git add e2e/android/oidc-login-contract.mts \
    e2e/android/oidc-login-fixture.mts \
    e2e/android/oidc-login-journeys.mts \
    e2e/android/flows/oidc-login-chrome-setup.yaml
  git commit -m "test(e2e): migrate Android OIDC login"
  ```

### Task 4: Register Nx, suite metadata, CI and diagnostics

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Test: `scripts/oidc-login-migration.spec.mjs`

**Interfaces:**

- Produces target `trinity-e2e-android:oidc-login`, suite
  `android.oidc-login`, command `e2e:android:oidc-login`, one shard command and
  one started-only diagnostics upload.

- [x] **Step 1: Add the uncached serialized Nx target**

  Mirror the retained Android Node/Maestro target shape with prebuilt Android
  dependency, bundle-manifest verification, suite id `android.oidc-login`,
  entrypoint `e2e/android/oidc-login-journeys.mts`, `android-avd` resource and a
  1,200,000 ms Node timeout.

- [x] **Step 2: Add package and registry entries**

  Register `e2e:android:oidc-login`, required Maestro/Android prerequisites,
  protocol/security/host/journey contract types, source entrypoint, artifact
  root, no cache and pull-request tier. Add the matching command and ensure
  prerequisite ordering remains canonical.

- [x] **Step 3: Place the suite on shard 4 and add started-only diagnostics**

  Place the suite on Android shard 4 after `password-registration`, preserving
  every existing suite's relative order. Invoke it through
  `scripts/ci-run-command.mjs --timeout-ms 1500000`, and set
  `oidc-login-started=true` immediately before execution. Upload only when
  started under surface `android-oidc-login` and report path
  `dist/.playwright/trinity-e2e-android/*/android.oidc-login/**`.

- [x] **Step 4: Run wiring guards and typecheck**

  ```bash
  pnpm exec vitest run scripts/oidc-login-migration.spec.mjs \
    scripts/e2e-suite-registry.spec.mjs scripts/ci-workflow.spec.mjs
  pnpm nx run trinity-e2e-android:typecheck --skipNxCache
  ```

- [x] **Step 5: Commit wiring**

  ```bash
  git add e2e/android/project.json package.json \
    e2e/registry/suites/runners.mts e2e/registry/commands.mts \
    .github/workflows/ci.yml scripts/e2e-suite-registry.spec.mjs \
    scripts/ci-workflow.spec.mjs
  git commit -m "ci(e2e): register Android OIDC login"
  ```

### Task 5: Document and validate local acceptance

**Files:**

- Modify: `e2e/android/MIGRATION.md`
- Modify only for evidence-backed defects: implementation and guard files
  above.
- Write runtime evidence only under ignored `dist/` artifact roots.

- [x] **Step 1: Document ownership and exact execution**

  Add the pinned source hashes/spans, 26 identities, native/CDP boundary,
  endpoint allowlist, redaction/cleanup contract, target/script commands,
  artifact root and explicit local/hosted evidence fields to the migration ledger.

- [x] **Step 2: Run focused and full static validation**

  Run the migration guard, full scripts tests, registry/workflow guards,
  Android/browser typecheck and lint, format check, architecture/style/docs
  gates, `git diff --check`, and the source-selected Nx validation required by
  repository policy. Record every command, checked revision, exit status and
  log/artifact path.

- [x] **Step 3: Run the installed-Android suite three times sequentially**

  ```bash
  pnpm nx run trinity-e2e-android:oidc-login --skipNxCache
  pnpm nx run trinity-e2e-android:oidc-login --skipNxCache
  pnpm nx run trinity-e2e-android:oidc-login --skipNxCache
  ```

  Require three unchanged first-attempt passes, all four stages, all 26 direct
  identities, one attempt, zero retries, clean teardown and secret-free
  artifact scans.

- [x] **Step 4: Run exact Playwright predecessors sequentially**

  ```bash
  pnpm nx run trinity-e2e-browser:e2e -- \
    e2e/browser/journeys/accounts/oidc-login.spec.mts \
    --workers=1 --retries=0
  ```

  Require all four exact predecessors to pass and re-check both pinned hashes.

- [x] **Step 5: Repair only evidence-backed defects**

  For every unexpected failure, use systematic debugging: preserve the first
  failing capture, identify the earliest violated invariant, add or strengthen
  a failing focused test, implement the smallest fix, and repeat affected
  checks. Never weaken source, protocol, native-action, PKCE, cleanup or
  redaction obligations.

- [x] **Step 6: Commit documentation/evidence truth**

  ```bash
  git add e2e/android/MIGRATION.md
  git commit -m "docs(e2e): record Android OIDC login evidence"
  ```

### Task 6: Review, publish and audit hosted acceptance

**Files:**

- No new tracked files unless review or hosted evidence exposes a defect.
- Update authorized GitHub issue/PR evidence after publication.

- [x] **Step 1: Complete independent review**

  Review the full feature diff from `bf5dfcd8` through the working tree for
  correctness, security boundaries, source preservation, regression risk,
  test quality and recoverability. Resolve every actionable finding using RED
  first and re-run affected validation.

- [x] **Step 2: Verify completion before publication**

  Re-run the focused migration guard, typecheck, format check, `git diff
--check`, source hashes and clean status. Confirm the branch contains only
  #724-owned commits and PR #677 is still draft/open against `develop`.

- [x] **Step 3: Push and consolidate**

  Push `test/724-android-oidc-login`, cherry-pick only its verified commits into
  `test/676-android-sidebar-filter`, prove feature and consolidated trees are
  identical, and push the consolidated branch. Do not merge PR #677.

- [x] **Step 4: Audit original-attempt hosted artifacts**

  For the first hosted run at the consolidated commit, verify exact merge SHA
  and renderer manifest, browser predecessor results at retry zero, the
  dedicated Android artifact's four stages/26 identities/attempt 1/retries 0,
  APK/profile provenance, secret redaction, clean teardown and clean-worktree
  step. Diagnose and repair any failure without accepting a rerun of unchanged
  broken code as evidence.

- [x] **Step 5: Close #724 and continue the goal**

  Post local/hosted evidence to #724, #660, #653 and PR #677, close #724 only
  after every acceptance item is satisfied, verify PR #677 remains draft/open
  and unmerged, then claim the next ordered open migration issue.
