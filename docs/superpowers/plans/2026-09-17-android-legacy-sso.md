# Android Legacy SSO Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Keep the three
> native stages sequential because they share Android and Synapse resources.

**Goal:** Add deterministic installed-Android parity for all three canonical
legacy Synapse/Dex SSO journeys while preserving the real provider, callback
security, session persistence, and unchanged Playwright predecessors.

**Architecture:** A focused source-shape guard pins the canonical journey,
helpers, and provider configuration and rejects native/fixture boundary
shortcuts. One Node suite runs three installed-app stages through the existing
Maestro account client, a real Chrome Custom Tab operated by Maestro, and a
separate host-browser fixture used only to mint adversarial single-use tokens.
Existing Nx, suite-registry, CI-shard, and migration-ledger patterns expose the
suite without changing product behavior.

**Tech Stack:** TypeScript/Node test runner, Vitest source-shape guards,
Maestro, ADB/UIAutomator, Chrome Custom Tabs, read-only Chrome DevTools Protocol,
Playwright host Chromium for the isolated fixture, Matrix Client-Server REST,
Nx, GitHub Actions, pnpm.

**Spec:**
`docs/superpowers/plans/2026-09-17-android-legacy-sso-design.md`

## Global constraints

- Preserve `e2e/browser/journeys/accounts/sso-login.spec.mts` unchanged at
  SHA-256 `04bf21437efd4da47398e93df607bf35dbcd8aba00159607a9a95f96ca6e9b12`.
  Its owned spans are lines 29–76, 78–107, and 109–198 and contain exactly
  4 + 4 + 15 direct assertion sites.
- Preserve `e2e/browser/support/sso.mts` at
  `e669c3b588e788c37fab77a7e427a38286de46cffafb228fcf27ae32c70a99b3`,
  `e2e/support/app.mts` at
  `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`,
  and `e2e/support/synapse/dex.yaml` at
  `b994b7e7c7de5fc103079b82d379a3dd8d022a1468796d6f8f35628c55c585d5`.
- Every reachable Trinity and Dex interaction must be Maestro/native host input.
  CDP and UIAutomator may observe but must not click, focus, fill, submit,
  navigate, or dispatch synthetic events.
- Do not install or use the Playwright Android driver. Host Playwright may only
  operate the isolated provider fixture that mints an unspent token.
- Use the real disposable Synapse and pinned Dex. Do not mock provider, Matrix
  login, callback, or session-persistence behavior.
- Record all 23 contract identities exactly once. Helper-owned Rooms readiness
  remains mandatory without inventing additional direct identities.
- Use one attempt and zero retries; serialize `android-avd` and `synapse`; retain
  every cleanup failure.
- Redact provider credentials, login tokens, Matrix access tokens, bearer
  values, and state nonces from every retained artifact.
- Keep PR #677 draft/open and unmerged. Do not merge PR #677.

---

### Task 1: Add the focused migration guard in RED

**Files:**

- Create: `scripts/legacy-sso-migration.spec.mjs`
- Read: `e2e/browser/journeys/accounts/sso-login.spec.mts`
- Read: `e2e/browser/support/sso.mts`
- Read: `e2e/support/app.mts`
- Read: `e2e/support/synapse/dex.yaml`

**Interfaces:**

- Consumes the four pinned canonical sources and existing configuration files.
- Produces a Vitest suite requiring the immutable contract, three native
  stages, 23 identities, safe provider/deep-link/fixture seams, bounded
  cleanup/redaction, Nx/registry/CI wiring, documentation, and predecessor
  retention.

- [ ] **Step 1: Pin exact source shape**

  Add `sourceLines(path, hash)` and exact-span checks. Require the three test
  titles at lines 29, 78, and 109, the closing lines 76, 107, and 198, direct
  assertion counts 4/4/15, the real Dex ids, the isolated callback path, token
  login protocol, exact static provider identity, and unchanged predecessor
  registration.

- [ ] **Step 2: Require immutable source and identity exports**

  Require `LEGACY_SSO_SOURCES`, `legacySsoAssertions`, and exactly three groups
  whose values equal the 23 stable ids from the design. Require count and
  uniqueness assertions in the contract module.

- [ ] **Step 3: Guard the native, fixture, and security boundaries**

  Require measured/native Trinity input, a Chrome Custom Tab package/surface,
  a Maestro Dex flow, ADB deep-link delivery targeted at Trinity, a host-only
  isolated token fixture, exact token redemption and logout, host relaunch,
  desktop geometry, pass/failure captures, three stages, and aggregate cleanup.
  Reject Android Playwright APIs/drivers, DOM actions/navigation, mocked
  provider responses, direct successful callback injection, and secret-bearing
  retained observations.

- [ ] **Step 4: Require target, registry, CI, and ledger wiring**

  Require target `legacy-sso`, suite `android.legacy-sso`, package script
  `e2e:android:legacy-sso`, a bounded CI command, marker
  `legacy-sso-started=true`, surface `android-legacy-sso`, matching report path,
  and migration-ledger references to source spans, local evidence, hosted
  evidence, and predecessor retention.

- [ ] **Step 5: Run the focused guard and confirm RED**

  ```bash
  pnpm exec vitest run scripts/legacy-sso-migration.spec.mjs
  ```

  Expected: failure because contract/journey/flow and wiring entries do not
  exist. Preserve the failure as RED evidence.

- [ ] **Step 6: Commit the RED guard**

  ```bash
  git add scripts/legacy-sso-migration.spec.mjs
  git commit -m "test(e2e): guard Android legacy SSO migration"
  ```

### Task 2: Implement the immutable contract and native provider seam

**Files:**

- Create: `e2e/android/legacy-sso-contract.mts`
- Create: `e2e/android/legacy-sso-provider.mts`
- Create: `e2e/android/flows/legacy-sso-dex.yaml`
- Test: `scripts/legacy-sso-migration.spec.mjs`
- Reuse unchanged: `e2e/android/maestro-session.mts`
- Reuse unchanged: `e2e/android/account-workspace-client.mts`

**Interfaces:**

- Contract exports exact sources, assertion groups, union types, and invariants.
- Provider helper owns disposable Chrome preparation, surface observation,
  native Dex form completion, command-line removal, and Chrome cleanup.

- [ ] **Step 1: Add the immutable source and assertion contract**

  Export exact source strings for the three predecessor spans plus the complete
  helper/provider files. Export grouped assertion ids in source order, type the
  23-value union, and assert total count and uniqueness at module load.

- [ ] **Step 2: Configure a fresh real Chrome process without a driver**

  Add a helper that force-stops and clears `com.android.chrome`, writes a base64
  encoded command line under `/data/local/tmp/chrome-command-line`, starts
  `about:blank` with requested first-run suppression, IPv4 loopback mapping and
  disposable certificate acceptance, uses Maestro to finish native Chrome
  first-run prompts when the stable build ignores those flags, removes the
  file, and reactivates Trinity. Bound every ADB wait and verify package state.

- [ ] **Step 3: Observe and operate the pinned Dex form**

  Use UIAutomator to prove the external Chrome package and a read-only Maestro
  DevTools hierarchy to prove the exact `login`, `password`, and `submit-login`
  controls. Conditionally cross Chrome's native localhost certificate warning,
  then use a separate Maestro flow for focus/fill/submit with secret variables.
  The helper must return sanitized action/surface proof and never a URL, field
  value, cookie, state, or token.

- [ ] **Step 4: Add bounded provider cleanup and negative controls**

  Remove the command-line file in `finally`, force-stop Chrome, close any
  observer, and aggregate errors. Unit-test source guards by temporarily
  weakening Chrome package proof and adding a DOM provider action; confirm each
  mutation fails before restoring the implementation.

- [ ] **Step 5: Run focused guard and typecheck incrementally**

  ```bash
  pnpm exec vitest run scripts/legacy-sso-migration.spec.mjs
  pnpm exec nx run trinity-e2e-android:typecheck --skipNxCache
  ```

  The guard may remain RED only for the not-yet-created journey/wiring. Provider
  and contract checks must pass.

### Task 3: Implement isolated token fixture and three native stages

**Files:**

- Create: `e2e/android/legacy-sso-journeys.mts`
- Modify only if a generic read seam is missing:
  `e2e/android/account-workspace-client.mts`
- Test: `scripts/legacy-sso-migration.spec.mjs`

**Interfaces:**

- Consumes `AccountWorkspaceClient`, mobile/desktop profiles,
  `openMaestroDevice`, `redactMaestroArtifacts`, the provider helper,
  `readSession`, `withNodeTestResources`, host `chromium`, and finite fetch.
- Produces one Node test, three ordered stages, 23 assertion records, a stage
  ledger, pass/failure captures, and a suite summary.

- [ ] **Step 1: Add finite host-browser token minting**

  Launch host Chromium with the exact runner binary when supplied, an isolated
  context, loopback mapping, and ignored disposable TLS errors. Navigate the
  real Synapse SSO redirect to `/sso-harness-callback`, fill the pinned Dex form
  only in that fixture browser, capture the request token, and close browser and
  context in bounded cleanup. Return only the in-memory token.

- [ ] **Step 2: Add independent token redemption and revocation**

  POST `m.login.token` with finite fetch, require status 200 and
  `@sso-e2e:localhost`, register the returned access token for redaction, and
  POST logout in `finally`. Never retain response bodies, tokens, or headers.

- [ ] **Step 3: Implement stage 1 — real SSO and persistence**

  Reset with the mobile profile, enter homeserver and Continue natively, record
  the password/SSO/delegated-action identities, prepare Chrome, tap SSO
  natively, complete Dex through the provider helper, and wait for Rooms.
  Force-stop/relaunch Trinity without clearing data, require Rooms and Login
  absence, and record persisted Rooms visibility.

- [ ] **Step 4: Implement stage 2 — forged callback and unspent token**

  Reset the app, mint/register a token secret, arm a read-only Matrix-login
  request observer, inject the exact forged-state deep link through ADB, record
  error/button/non-Rooms identities, require zero app token-login requests,
  redeem the same token independently, record exact MXID, and revoke the
  resulting session.

- [ ] **Step 5: Implement stage 3 — in-flight forged callback recovery**

  Reset with the desktop profile, start a real SSO flow and pause on fresh Dex,
  then mint/register another token and inject the forged callback. Read and
  record all 15 copy/wordmark/heading/card/main/body/error/route identities,
  prove zero app token-login requests, and immediately redeem/revoke the fresh
  token. Send native Back to return to Login, prepare fresh Chrome, complete a
  new real Dex round trip through Maestro, and require Rooms.

- [ ] **Step 6: Add attempt ledger, captures, provenance, and cleanup**

  Create three `running|passed|failed` stage entries before launch. Record each
  identity once via a typed Set, renderer manifest and APK hashes, emulator and
  profile facts, one attempt/zero retries, stage durations, native action proof,
  and sanitized failures. Capture pass/failure device and WebView images. Close
  observers, provider, host browsers, client, device, and resources with
  aggregate cleanup; run artifact redaction last.

- [ ] **Step 7: Prove focused GREEN and effective negative controls**

  ```bash
  pnpm exec vitest run scripts/legacy-sso-migration.spec.mjs
  pnpm exec nx run trinity-e2e-android:typecheck --skipNxCache
  ```

  Mutate one obligation at a time for action classification, host relaunch,
  token consumption, state/stash preservation, every geometry/accessibility
  group, cleanup, and redaction. Confirm RED, restore, and confirm GREEN.

- [ ] **Step 8: Commit the implementation**

  ```bash
  git add e2e/android/legacy-sso-contract.mts \
    e2e/android/legacy-sso-provider.mts \
    e2e/android/legacy-sso-journeys.mts \
    e2e/android/flows/legacy-sso-dex.yaml
  git commit -m "test(e2e): migrate Android legacy SSO"
  ```

### Task 4: Register Nx, suite metadata, CI execution, and diagnostics

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Test: `scripts/legacy-sso-migration.spec.mjs`

- [ ] **Step 1: Add the uncached serialized Nx target**

  Mirror the current Node/Maestro target shape with suite id
  `android.legacy-sso`, entrypoint
  `e2e/android/legacy-sso-journeys.mts`, non-parallel execution, prebuilt app
  dependency, `android-avd` + `synapse` resource ownership, and bounded timeout.

- [ ] **Step 2: Add package and registry entries**

  Register `e2e:android:legacy-sso`, required Chrome/Maestro/Android/Synapse
  prerequisites, security/host/journey contract types, source entrypoint,
  artifact root, no cache, pull-request tier, and the matching command.

- [ ] **Step 3: Place the suite and add started-only diagnostics**

  Use the latest completed shard timing to choose the shortest suitable shard.
  Add a bounded `ci-run-command` invocation, set
  `legacy-sso-started=true` immediately before it runs, and upload only when
  started under surface `android-legacy-sso` with its exact report path.

- [ ] **Step 4: Update and run registry guards**

  ```bash
  pnpm exec vitest run scripts/legacy-sso-migration.spec.mjs scripts/e2e-suite-registry.spec.mjs
  pnpm exec nx run trinity-e2e-android:typecheck --skipNxCache
  ```

- [ ] **Step 5: Commit wiring**

  ```bash
  git add e2e/android/project.json package.json \
    e2e/registry/suites/runners.mts e2e/registry/commands.mts \
    .github/workflows/ci.yml scripts/e2e-suite-registry.spec.mjs
  git commit -m "ci(e2e): register Android legacy SSO"
  ```

### Task 5: Validate local native and retained browser coverage

**Files:**

- Modify only for verified defects: implementation/guard files above.
- Write ignored evidence under the suite artifact root.

- [ ] **Step 1: Run static validation**

  Run focused/full script tests, Android/browser typecheck and lint, registry
  validation, format checks, documentation checks, `git diff --check`, and the
  source-selected Nx checks required by repository policy. Record every command
  and exit status.

- [ ] **Step 2: Run the installed-Android suite three times sequentially**

  ```bash
  pnpm exec nx run trinity-e2e-android:legacy-sso --skipNxCache
  pnpm exec nx run trinity-e2e-android:legacy-sso --skipNxCache
  pnpm exec nx run trinity-e2e-android:legacy-sso --skipNxCache
  ```

  Require three unchanged first-attempt passes, all three stages each time, all
  23 direct identities, helper-owned Rooms readiness, one attempt, zero retries,
  clean teardown, and artifact scans free of every secret class.

- [ ] **Step 3: Run exact predecessors sequentially at retry zero**

  Run only the three tests in
  `e2e/browser/journeys/accounts/sso-login.spec.mts` against the disposable
  harness with one worker and zero retries. Require all three unchanged spans to
  pass and preserve their exact source hash.

- [ ] **Step 4: Repair only evidence-backed defects**

  For any failure, use systematic debugging: preserve the failing capture,
  identify the first violated invariant, add or strengthen the focused guard,
  implement the smallest fix, and repeat all affected checks. Do not weaken a
  source, security, native-action, or cleanup obligation.

### Task 6: Document evidence, review, publish, and audit hosted acceptance

**Files:**

- Modify: `e2e/android/MIGRATION.md`
- Optionally modify design/plan only when implementation truth changed.

- [ ] **Step 1: Record local evidence**

  Add source hashes/spans, 23 identity map, three native first-attempt receipts,
  predecessor retry-zero receipts, renderer/APK/emulator/profile provenance,
  native action/deep-link/provider proof, negative controls, artifact redaction
  scan, teardown, and validation commands.

- [ ] **Step 2: Run independent review and resolve findings**

  Review the feature range against #723 for source parity, native ownership,
  callback-state security, provider reality, fixture isolation, token handling,
  geometry/accessibility, redaction, cleanup, registry/CI, and predecessor
  retention. Re-run affected evidence after every fix. Finish with zero
  unresolved findings.

- [ ] **Step 3: Commit and push the verified feature branch**

  ```bash
  git add e2e/android/MIGRATION.md
  git commit -m "docs(e2e): record Android legacy SSO evidence"
  git push -u origin test/723-android-legacy-sso
  ```

- [ ] **Step 4: Consolidate without merging PR #677**

  Cherry-pick only the verified feature commits onto
  `test/676-android-sidebar-filter`, re-run publication checks, prove the
  feature and consolidated trees are identical, and push the consolidated
  branch. Verify PR #677 remains draft, open, based on `develop`, and unmerged.

- [ ] **Step 5: Audit original-attempt hosted artifacts**

  Require the hosted run to test the exact consolidated implementation tree.
  Audit successful renderer provenance, the original Android attempt and all
  three stages, 23 identities, zero retries, native provider/deep-link evidence,
  artifact redaction, teardown, and all three exact browser predecessors at
  retry zero. Classify unrelated failures only with retained evidence and an
  existing owner.

- [ ] **Step 6: Close #723 and update ledgers**

  After hosted acceptance, post the complete receipt to #723, close it, and
  update #660, #653, and PR #677. Keep PR #677 draft/open and unmerged. Continue
  the active goal with #724.
