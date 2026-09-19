# Android Password Registration Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic installed-Android parity for the canonical password-registration journey while retaining the Playwright predecessor and independently proving the newly registered Matrix identity.

**Architecture:** A focused source-shape guard pins the predecessor and rejects forbidden shortcuts. A dedicated Node journey uses the existing `AccountWorkspaceClient` only for installed-WebView lifecycle, read observations, native Maestro input, capture, and cleanup; registration-specific network observation and REST verification stay local to the journey. Existing Nx, suite-registry, CI-shard, and migration-ledger patterns expose the suite without changing product behavior.

**Tech Stack:** TypeScript/Node test runner, Vitest source-shape guards, Maestro, Chrome DevTools Protocol, Matrix Client-Server REST, Nx, GitHub Actions, pnpm.

**Spec:** `docs/superpowers/plans/2026-09-17-android-password-registration-design.md`

## Global Constraints

- Preserve `e2e/browser/journeys/accounts/registration.spec.mts` unchanged at SHA-256 `a22f58f703c185645987ad471c2f8637d2741344be365d5063c8f0b1c37f2dbd`; owned lines are 10–48.
- Preserve `e2e/support/app.mts` at SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`; owned helper lines are 124–166.
- Preserve `e2e/support/account.mts` at SHA-256 `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`; owned helper lines are 57–79.
- Every product interaction must be a Maestro-native tap or text input. CDP may observe but must not click, focus, fill, submit, navigate, dispatch synthetic events, or create the account.
- The product SDK must complete the real Synapse `m.login.dummy` UIA flow; REST may verify availability/login/logout but must not register or create the tested account.
- Record these identities exactly once: `password-registration.availability-action-visible`, `password-registration.registration-route`, `password-registration.encryption-setup-route`, and `password-registration.exact-mxid`.
- Require concrete `/register` with the exact homeserver query and final `/encryption/setup`; alternate routes fail.
- Require one attempt and zero retries; serialize `android-avd` and `synapse`; preserve every cleanup failure.
- Redact the generated password, access token, Matrix session values, UIA/session material, and native input payloads from every retained artifact.
- Keep PR #677 draft/open and unmerged. Do not merge PR #677.

---

### Task 1: Add the focused migration guard in RED

**Files:**

- Create: `scripts/password-registration-migration.spec.mjs`
- Read: `e2e/browser/journeys/accounts/registration.spec.mts`
- Read: `e2e/support/app.mts`
- Read: `e2e/support/account.mts`

**Interfaces:**

- Consumes: the three pinned canonical files and existing JSON/text configuration files.
- Produces: a Vitest suite that requires `PASSWORD_REGISTRATION_SOURCES`, `passwordRegistrationAssertions`, a dedicated journey, safe network/login/logout seams, bounded cleanup/redaction, Nx/registry/CI wiring, documentation, and predecessor retention.

- [ ] **Step 1: Write source and assertion-shape checks**

  Create a Vitest file using `createHash`, `existsSync`, `readFileSync`, `resolve`, and `describe/expect/it`. Define the four exact assertion IDs and a `sourceLines(path, expectedHash)` helper. Assert the three SHA-256 values, the predecessor boundaries at lines 10 and 48, exactly two `expect` sites in lines 10–48, the `/register` and `/encryption/setup` route obligations, the availability-probe selector, and the independent password-login helper boundaries.

- [ ] **Step 2: Write implementation-boundary checks**

  Require these exact exports and calls:

  ```js
  expect(contract.PASSWORD_REGISTRATION_SOURCES).toEqual({
    journey: 'e2e/browser/journeys/accounts/registration.spec.mts:10-48',
    app: 'e2e/support/app.mts:124-166',
    account: 'e2e/support/account.mts:57-79',
  });
  expect(Object.values(contract.passwordRegistrationAssertions)).toEqual(assertionIds);
  expect(journey).toContain("client.fillFocused('#homeserver'");
  expect(journey).toContain('client.tapCurrent(\'[data-testid="password-register"]\'');
  expect(journey).toContain("client.fillFocused('#registration-username'");
  expect(journey).toContain("client.fillFocused('#registration-password'");
  expect(journey).toContain("client.fillFocused('#registration-confirm-password'");
  expect(journey).toContain('client.tapCurrent(\'[data-testid="register-submit"]\'');
  ```

  Reject `.click(`, `.focus(`, `.dispatchEvent(`, `.requestSubmit(`, `.submit(`, location/history/navigation writes, shared-secret registration, `/_matrix/client/v3/register` account creation, unbounded fetches, and literal assertion-ID duplication in the journey.

- [ ] **Step 3: Write non-vacuity, secrecy, cleanup, and wiring checks**

  Require the exact `/_matrix/client/v3/register/available` observation, an initially absent action, successful status before visibility, exact `/register` homeserver query, exact `/encryption/setup`, `/_matrix/client/v3/login`, exact `@${username}:localhost`, logout in `finally`, `AbortSignal.timeout(15_000)`, `redactMaestroArtifacts(output, secrets)`, four unique records, pass/failure captures, and aggregate cleanup. Require target `password-registration`, suite `android.password-registration`, package script `e2e:android:password-registration`, started marker `password-registration-started=true`, surface `android-password-registration`, and matching report path.

- [ ] **Step 4: Run the focused guard and confirm RED**

  Run:

  ```bash
  pnpm exec vitest run scripts/password-registration-migration.spec.mjs
  ```

  Expected: failure because `e2e/android/password-registration-contract.mts` and `e2e/android/password-registration-journeys.mts` do not exist and the target/registry/CI/docs entries are absent. Preserve this output as the RED evidence.

- [ ] **Step 5: Commit the RED guard**

  ```bash
  git add scripts/password-registration-migration.spec.mjs
  git commit -m "test(e2e): guard Android password registration migration"
  ```

### Task 2: Implement the contract and installed-Android journey

**Files:**

- Create: `e2e/android/password-registration-contract.mts`
- Create: `e2e/android/password-registration-journeys.mts`
- Test: `scripts/password-registration-migration.spec.mjs`
- Reuse unchanged: `e2e/android/account-workspace-client.mts`
- Reuse unchanged: `e2e/android/maestro-session.mts`

**Interfaces:**

- Consumes: `AccountWorkspaceClient`, `PIXEL_5_ACCOUNT_PROFILE`, `openMaestroDevice`, `redactMaestroArtifacts`, `waitForNativeShellState`, `readSession`, and `withNodeTestResources`.
- Produces: `PASSWORD_REGISTRATION_SOURCES`, `passwordRegistrationAssertions`, `PasswordRegistrationAssertion`, and one Node test named `Android password registration journey`.

- [ ] **Step 1: Implement the immutable contract**

  Export this source map and stable identity map, then assert the exact count and uniqueness:

  ```ts
  export const PASSWORD_REGISTRATION_SOURCES = {
    journey: 'e2e/browser/journeys/accounts/registration.spec.mts:10-48',
    app: 'e2e/support/app.mts:124-166',
    account: 'e2e/support/account.mts:57-79',
  } as const;

  export const passwordRegistrationAssertions = {
    availabilityActionVisible: 'password-registration.availability-action-visible',
    registrationRoute: 'password-registration.registration-route',
    encryptionSetupRoute: 'password-registration.encryption-setup-route',
    exactMxid: 'password-registration.exact-mxid',
  } as const;
  ```

- [ ] **Step 2: Add local observation and REST helpers**

  In the journey file, add focused helpers with these responsibilities and return types:

  ```ts
  interface AvailabilityObservation {
    readonly requestPath: '/_matrix/client/v3/register/available';
    readonly status: number;
    readonly success: true;
  }

  interface PasswordLoginObservation {
    readonly status: 200;
    readonly userId: string;
    readonly accessToken: string;
  }

  function armAvailabilityObserver(client: AccountWorkspaceClient): Promise<{ wait(): Promise<AvailabilityObservation>; close(): Promise<void> }>;

  function verifyPasswordLogin(username: string, password: string, signal: AbortSignal): Promise<PasswordLoginObservation>;

  function revokeObservationSession(accessToken: string, signal: AbortSignal): Promise<void>;
  ```

  Attach CDP `Network.requestWillBeSent` and `Network.responseReceived` listeners before homeserver submission; accept only the exact pathname and a 2xx response. Record path and status only. All fetches use `AbortSignal.any([signal, AbortSignal.timeout(15_000)])`; login sends `m.login.password`, `identifier.type = m.id.user`, and the generated username; logout authenticates with the in-memory bearer token.

- [ ] **Step 3: Implement the one native stage**

  Reset with `PIXEL_5_ACCOUNT_PROFILE`, prove `[data-testid="password-register"]` absent, focus/fill `#homeserver` through native input, tap Continue natively, await the successful availability observation, and then prove the registration action visible. Record `availabilityActionVisible` with `{ initiallyAbsent: true, requestPath, status, visible: true }`.

  Tap the action natively and parse `client.surface().url`. Assert pathname `/register` and exact `homeserver` query, then record `registrationRoute`. Generate `signup-${matrixResources.testResourceId}` (normalized to the server's username grammar) and a unique password; register the password immediately in `secrets`. Fill all three registration fields through native input and tap submit. Wait for pathname `/encryption/setup`, then record `encryptionSetupRoute`.

- [ ] **Step 4: Implement independent exact-MXID proof and guaranteed revocation**

  Call `verifyPasswordLogin`, require status 200 and exact `@${username}:localhost`, and register the returned token in `secrets` before any later operation. Record `exactMxid` without password/token/body. Put logout in `finally`; treat a non-200 logout or thrown cleanup error as a stage failure.

- [ ] **Step 5: Implement artifact ledger and aggregate teardown**

  Follow the account-password-change runner shape: create `journeys.json` before launch, install the prebuilt APK, maintain one stage with `running|passed|failed`, source, duration, artifact path, failure count, and sanitized error. Write four assertion JSON records exactly once through a `Set<PasswordRegistrationAssertion>`. Capture `passed` or `failed`, close the availability observer, close the client, close Maestro, stop Synapse through resource cleanup, and run `redactMaestroArtifacts(output, secrets)`. Aggregate all stage and cleanup errors.

- [ ] **Step 6: Run the focused guard to the next expected RED boundary**

  Run:

  ```bash
  pnpm exec vitest run scripts/password-registration-migration.spec.mjs
  ```

  Expected: contract/journey checks pass; remaining failures identify only missing Nx/registry/CI/docs wiring.

- [ ] **Step 7: Typecheck the Android E2E project**

  Run:

  ```bash
  pnpm nx run trinity-e2e-android:typecheck --skipNxCache
  ```

  Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 8: Commit the native journey**

  ```bash
  git add e2e/android/password-registration-contract.mts e2e/android/password-registration-journeys.mts
  git commit -m "test(e2e): migrate Android password registration"
  ```

### Task 3: Register the Nx target, suite, CI shard, and migration ledger

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `e2e/android/MIGRATION.md`
- Test: `scripts/password-registration-migration.spec.mjs`

**Interfaces:**

- Consumes: `e2e/android/password-registration-journeys.mts` and existing suite/command resource schemas.
- Produces: Nx target `trinity-e2e-android:password-registration`, registry ID `android.password-registration`, package script `e2e:android:password-registration`, shard invocation, and started-only diagnostic upload.

- [ ] **Step 1: Add the bounded uncached Nx target and package command**

  Add `password-registration` adjacent to `account-password-change` and `clear-all-data` with `cache: false`, `parallelism: false`, dependency `{ "projects": ["trinity-android"], "target": "build-prebuilt" }`, the common Android output, and this command shape:

  ```text
  ... run-node.mts --suite=android.password-registration --timeout-ms=900000 --entrypoint=e2e/android/password-registration-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse
  ```

  Add package script `node scripts/nx.mjs run trinity-e2e-android:password-registration`.

- [ ] **Step 2: Add runner and command registry entries**

  Register `android.password-registration` as hosted Android, current/required, 900000 ms, with `android-avd` and `synapse`, canonical script `e2e:android:password-registration`, and source entrypoint `e2e/android/password-registration-journeys.mts`. Add the corresponding command descriptor and update registry assertions to expect the exact object and parsed argv.

- [ ] **Step 3: Place the suite on the shortest current Android shard**

  Use the latest completed hosted timing evidence recorded for the integration branch to choose the shortest suitable shard without reordering unrelated suites. Add a one-line invocation that writes `password-registration-started=true` before running the Nx target. Preserve serial execution and the shard's existing overall timeout.

- [ ] **Step 4: Add started-only diagnostic upload and workflow guards**

  Add an upload step guarded by:

  ```yaml
  if: ${{ !cancelled() && steps.android.outputs.password-registration-started == 'true' }}
  ```

  Use surface `android-password-registration` and report path `dist/.playwright/trinity-e2e-android/*/android.password-registration/**`. Extend `scripts/ci-workflow.spec.mjs` to assert the surface/path/started marker, exactly one suite invocation, correct ordering, and a CI timeout greater than the target timeout.

- [ ] **Step 5: Document parity and coexistence**

  Add `## Password registration journey` to `e2e/android/MIGRATION.md`. Record the three source hashes/ranges, four identities, native-action boundary, exact availability gate, real `m.login.dummy` UIA, exact routes, independent exact-MXID login/logout, artifact/redaction/cleanup contract, Nx command, hosted shard, and explicit predecessor retention.

- [ ] **Step 6: Run focused and wiring tests GREEN**

  Run:

  ```bash
  pnpm exec vitest run scripts/password-registration-migration.spec.mjs scripts/e2e-suite-registry.spec.mjs scripts/ci-workflow.spec.mjs
  pnpm nx run scripts:test --skipNxCache
  ```

  Expected: all focused tests and the complete scripts test target pass.

- [ ] **Step 7: Commit the wiring and documentation**

  ```bash
  git add e2e/android/project.json package.json e2e/registry/suites/runners.mts e2e/registry/commands.mts .github/workflows/ci.yml scripts/e2e-suite-registry.spec.mjs scripts/ci-workflow.spec.mjs e2e/android/MIGRATION.md
  git commit -m "ci(e2e): register Android password registration"
  ```

### Task 4: Prove negative controls, quality gates, and local parity

**Files:**

- Modify if required by an effective negative control: `scripts/password-registration-migration.spec.mjs`
- Modify if required by an effective negative control: `e2e/android/password-registration-journeys.mts`
- Create ignored evidence only: `.superpowers/sdd/2026-09-17-android-password-registration/progress.md`

**Interfaces:**

- Consumes: the completed migration and its source-shape guard.
- Produces: recorded RED/GREEN mutation evidence, three first-attempt installed runs, one retry-zero predecessor run, and a clean reviewable feature branch.

- [ ] **Step 1: Prove all eight negative controls are effective**

  One at a time, temporarily mutate the implementation to expose the action before the probe, create the account through REST, weaken `/register`, change `/encryption/setup`, accept failed/local-only login, weaken exact MXID, omit logout, and omit redaction/cleanup. Run the focused guard after each mutation, record the specific failing assertion in the ignored progress ledger, and restore the implementation with `git diff --exit-code` against the intended files after all eight.

- [ ] **Step 2: Run static quality gates**

  Run sequentially:

  ```bash
  pnpm nx run trinity-e2e-android:typecheck --skipNxCache
  pnpm nx run trinity-e2e-android:lint --skipNxCache
  pnpm nx run trinity-e2e-browser:typecheck --skipNxCache
  pnpm nx run trinity-e2e-browser:lint --skipNxCache
  pnpm nx run scripts:test --skipNxCache
  pnpm nx run scripts:lint --skipNxCache
  pnpm exec prettier --check scripts/password-registration-migration.spec.mjs e2e/android/password-registration-contract.mts e2e/android/password-registration-journeys.mts e2e/android/project.json package.json e2e/registry/suites/runners.mts e2e/registry/commands.mts .github/workflows/ci.yml scripts/e2e-suite-registry.spec.mjs scripts/ci-workflow.spec.mjs e2e/android/MIGRATION.md docs/superpowers/plans/2026-09-17-android-password-registration-design.md docs/superpowers/plans/2026-09-17-android-password-registration.md
  ```

  Expected: every command exits 0. If repository documentation/source-shape targets select additional checks, run those exact Nx targets too.

- [ ] **Step 3: Build the production renderer and Android APK once**

  Run the source-selected build targets through Nx, record the renderer manifest and APK digest in the ignored progress ledger, and do not rebuild between acceptance attempts.

- [ ] **Step 4: Run three installed-Android first attempts sequentially**

  Run `pnpm nx run trinity-e2e-android:password-registration --skipNxCache` three times against unchanged relevant inputs and the same disposable emulator/Synapse policy. Require all four identities exactly once, one stage passed, no retry/failure marker, exact routes, exact MXID, successful logout, clean teardown, and secret scan success on each attempt.

- [ ] **Step 5: Run the exact retained Playwright predecessor once**

  Run the browser target filtered to `e2e/browser/journeys/accounts/registration.spec.mts` with retries disabled. Require the owned lines 10–48 to pass on attempt 0 and record the report identity in the ignored ledger.

- [ ] **Step 6: Review the complete diff and commit any validation fixes**

  Inspect `git diff 281e2565...HEAD`, `git status --short`, and `git show --check` for every task commit. Apply only task-scoped fixes, rerun affected checks, and commit with a specific message.

### Task 5: Publish, integrate, and obtain hosted acceptance

**Files:**

- Modify after hosted success: `e2e/android/MIGRATION.md`
- Modify after hosted success: `docs/superpowers/plans/2026-09-17-android-password-registration.md` only to check completed steps if useful

**Interfaces:**

- Consumes: the fully verified feature branch.
- Produces: identical feature/integration trees, hosted Android/browser/renderer evidence, issue/PR updates, and closed issue #722 while PR #677 remains unmerged.

- [ ] **Step 1: Push the feature branch**

  Push `test/722-android-password-registration` and verify the remote head equals local `HEAD`.

- [ ] **Step 2: Cherry-pick task-owned commits into the integration branch**

  In the clean `test/676-android-sidebar-filter` worktree, cherry-pick only this batch's commits. Prove `git rev-parse test/722-android-password-registration^{tree}` equals `git rev-parse test/676-android-sidebar-filter^{tree}`, then push the integration branch.

- [ ] **Step 3: Audit the original hosted attempt**

  Require renderer success with matching manifest, browser success with the retained predecessor at retry zero, and the password-registration Android shard succeeding on its original attempt. Download and inspect artifacts for four unique identities exactly once, one passed stage, zero retries, native input, exact availability path/status, exact routes, exact MXID, session revocation, captures, provenance, clean teardown, and no unredacted password/token/session material.

- [ ] **Step 4: Record hosted acceptance and close #722**

  Add exact run/job/artifact IDs, digests, counts, timings, device profile, and redaction results to `e2e/android/MIGRATION.md`; commit and push the same docs change to both branches while preserving identical trees. Comment on #722, #660, #653, and PR #677 with links and evidence, then close #722 as completed.

- [ ] **Step 5: Verify publication invariants**

  Confirm both remote branch heads, clean worktrees, identical trees, #722 closed, and PR #677 still draft/open with `mergedAt: null`. Do not merge PR #677.
